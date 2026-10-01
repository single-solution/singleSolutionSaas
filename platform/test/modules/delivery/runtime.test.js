import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { JSDOM } from './dom.js';
import { compile } from '@ss/rules';
import { buildRuntimeSource, OUTPUT } from '../../../scripts/build-delivery-runtime.js';
import { bundleData, versionedLoader } from '../../../src/modules/delivery/core/compile.js';
import {
	STUB_PROTOCOL,
	adaptHeadless,
	adaptRenderer,
	adoptStyles,
	pageContext,
	start,
	stubDefinition,
	unavailableClient,
	viewFields,
} from '../../../src/modules/delivery/runtime/entry.js';
import { RUNTIME_AUDIENCE, RUNTIME_CORE } from '../../../src/modules/delivery/runtime/generated.js';
import { PACK, PACK_FILES } from './fixtures.js';

vi.setConfig({ testTimeout: 30_000 });

const WEBSITE = 'web_0123456789abcdefghjkmnpq';
const ASSETS = 'https://portal.test/w/';
const PACK_BASE = `${ASSETS}packs/`;

/** Let the default `load` trigger (a 0 ms timer) fire, then wait for every mount. @param {any} instance */
const settled = async (instance) => {
	await vi.waitFor(
		() => {
			const pending = instance.list().filter((/** @type {any} */ e) => ['idle', 'armed', 'loading'].includes(e.status));
			if (pending.length > 0) throw new Error('mounting');
		},
		{ timeout: 10_000, interval: 5 },
	);
	await instance.ready();
};

const page = () =>
	new JSDOM('<!doctype html><html><head></head><body><main id="main"></main></body></html>', {
		url: 'https://shop.example.com/collections/sale',
		runScripts: 'outside-only',
		pretendToBeVisual: true,
	});

/** Pack modules from their source text (data: URLs; the fixtures have no relative imports). */
const importPack = async (/** @type {string} */ url) => {
	const path = url.slice(`${PACK_BASE}${PACK}/1/`.length);
	const source = /** @type {Record<string, string>} */ (PACK_FILES)[path];
	if (!source) throw new Error(`unknown module ${url}`);
	return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
};

/** @param {Record<string, unknown>} [extra] */
const data = (extra = {}) => ({
	websiteId: WEBSITE,
	env: /** @type {const} */ ('live'),
	version: '0123456789abcdef',
	key: 'pk_live_test',
	events: 'https://portal.test/v1/events',
	assets: ASSETS,
	elements: [
		{
			key: 'bar',
			config: { message: 'Free shipping' },
			strings: { 'bar.label': 'Notice' },
			placement: { selectors: [{ selector: '#main', position: 'prepend' }] },
			headless: { path: `packs/${PACK}/1/headless/bar.js`, name: 'createBar' },
			renderer: { path: `packs/${PACK}/1/ui/bar.js`, name: 'render' },
		},
	],
	...extra,
});

/** Fake element API (service stub) and events endpoint. */
const fakeFetch = () => {
	/** @type {Array<{ url: string, init: any }>} */
	const calls = [];
	let n = 0;
	/** @type {any} */
	const fetch = async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
		calls.push({ url, init });
		n += 1;
		const view =
			n === 1
				? {
						title: 'Need help?',
						body: 'We reply in minutes',
						items: [{ text: 'FAQ', href: 'https://chat.example.net/faq' }],
						actions: [
							{ action: 'open', label: 'Chat now' },
							{ action: 'Bad!', label: 'x' },
						],
					}
				: { title: 'Connected' };
		return new Response(JSON.stringify(view), { status: 200, headers: { 'content-type': 'application/json' } });
	};
	return { fetch, calls };
};

describe('generated runtime', () => {
	it('is up to date with entry.js and @ss/web (rebuild: node platform/scripts/build-delivery-runtime.js)', async () => {
		expect(await buildRuntimeSource()).toBe(await readFile(OUTPUT, 'utf8'));
	});
});

describe('runtime adapters', () => {
	it('adapts element definitions and Part E factories', () => {
		const definition = { key: 'bar', create: () => ({}) };
		expect(adaptHeadless(definition, 'bar')).toBe(definition);
		expect(() => adaptHeadless(definition, 'other')).toThrow(/is not other/);
		expect(() => adaptHeadless(42, 'bar')).toThrow(/not a factory/);
		const adapted = adaptHeadless(() => ({}), 'bar');
		expect(adapted.key).toBe('bar');
		/** @type {any} */
		let state = {};
		const created = adapted.create({
			config: {},
			strings: {},
			client: undefined,
			identity: {},
			emit: () => true,
			store: { setState: (/** @type {any} */ s) => (state = s) },
		});
		expect(state).toEqual({});
		expect(created.actions).toEqual({});
		created.destroy();
		expect(() => adaptRenderer({}, 'render', null, undefined)).toThrow(/not a function/);
	});

	it('the placeholder Graph client answers graph_unavailable', async () => {
		const client = unavailableClient();
		expect(await client.list?.()).toMatchObject({ ok: false, error: { code: 'graph_unavailable' } });
		expect(/** @type {any} */ (client).then).toBeUndefined();
	});

	it('adopts renderer styles once (constructable sheet or nonce-bearing <style>)', () => {
		const { window } = page();
		adoptStyles(window, '.a{}', 'n1');
		adoptStyles(window, '.a{}', 'n1');
		adoptStyles(window, '', 'n1');
		const sheets = /** @type {any} */ (window.document).adoptedStyleSheets;
		const styles = window.document.querySelectorAll('style');
		expect((Array.isArray(sheets) ? sheets.length : 0) + styles.length).toBe(1);
		if (styles.length) expect(styles[0]?.getAttribute('nonce')).toBe('n1');
		adoptStyles(null, '.b{}', undefined);
	});
});

describe('start(): mounting compiled elements', () => {
	it('lazy-loads pack modules, mounts at the placement and renders with dom + strings', async () => {
		const { window } = page();
		const { fetch } = fakeFetch();
		const instance = start(/** @type {any} */ (data()), { window, importModule: importPack, fetch, storage: null });
		await settled(instance);
		const bar = window.document.querySelector('#main > [data-ss-element="bar"] .ss-bar, #main .ss-bar');
		expect(bar?.textContent).toBe('Free shipping');
		expect(bar?.getAttribute('aria-label')).toBe('Notice');
		expect(instance.list()).toEqual([expect.objectContaining({ key: 'bar', status: 'mounted' })]);
		expect(window.SS.elements.get('bar').state()).toMatchObject({ message: 'Free shipping', dismissed: false });
		await window.SS.elements.get('bar').actions.dismiss();
		expect(window.SS.elements.get('bar').state().dismissed).toBe(true);
		instance.destroy();
	});

	it('isolates a failing module', async () => {
		const { window } = page();
		/** @type {unknown[]} */
		const errors = [];
		window.addEventListener('ss:error', (/** @type {any} */ e) => errors.push(e.detail));
		const instance = start(/** @type {any} */ (data()), {
			window,
			importModule: async () => ({}),
			fetch: fakeFetch().fetch,
			storage: null,
		});
		await settled(instance);
		expect(instance.list()[0]?.status).toBe('failed');
		expect(errors).toHaveLength(1);
	});

	it('the element stub renders the product view model and invokes actions over the element API', async () => {
		const { window } = page();
		// the Loader's safe `h` builds nodes in the global document (the page's own document in a browser)
		vi.stubGlobal('document', window.document);
		const { fetch, calls } = fakeFetch();
		const instance = start(
			/** @type {any} */ (
				data({
					elements: [{ key: 'launcher', stub: STUB_PROTOCOL, api: 'https://chat.example.net', config: {}, strings: {} }],
				})
			),
			{ window, fetch, storage: null },
		);
		await settled(instance);
		await vi.waitFor(() => expect(window.document.querySelector('.ss-el__title')?.textContent).toBe('Need help?'));
		// v2: the page context travels as ?ctx= (path; item id / page type from data-ss-* attributes)
		const first = new URL(String(calls[0]?.url));
		expect(`${first.origin}${first.pathname}`).toBe('https://chat.example.net/v1/elements/launcher/view');
		expect(JSON.parse(String(first.searchParams.get('ctx')))).toEqual({ path: '/collections/sale' });
		expect(calls[0]?.init.headers.authorization ?? calls[0]?.init.headers.Authorization).toBe('Bearer pk_live_test');
		expect(window.document.querySelector('.ss-el__body')?.textContent).toBe('We reply in minutes');
		expect(window.document.querySelector('.ss-el__items a')?.getAttribute('href')).toBe('https://chat.example.net/faq');
		const buttons = window.document.querySelectorAll('.ss-el__action');
		expect(buttons).toHaveLength(1); // invalid action names are dropped
		/** @type {any} */ (buttons[0]).click();
		await vi.waitFor(() => expect(window.document.querySelector('.ss-el__title')?.textContent).toBe('Connected'));
		expect(String(calls[1]?.url).split('?')[0]).toBe('https://chat.example.net/v1/elements/launcher/actions/open');
		expect(calls[1]?.init.method).toBe('POST');
		expect(await window.SS.elements.get('launcher').actions.invoke('Bad!')).toMatchObject({ ok: false });
		instance.destroy();
		vi.unstubAllGlobals();
	});

	it('stub v2: page context from data-ss-* attributes, input fields posted with actions; v1 data stays compatible', async () => {
		const { window } = new JSDOM(
			'<!doctype html><html data-ss-page-type="product"><head></head><body><article data-ss-item-id="sku-9"><main id="main"></main></article></body></html>',
			{ url: 'https://shop.example.com/p/sku-9', runScripts: 'outside-only', pretendToBeVisual: true },
		);
		vi.stubGlobal('document', window.document);
		/** @type {Array<{ url: string, init: any }>} */
		const calls = [];
		/** @type {any} */
		const fetch = async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
			calls.push({ url, init });
			const view =
				calls.length === 1
					? {
							title: 'Notify me',
							fields: [
								{ name: 'email', type: 'email', label: 'E-mail', required: true },
								{
									name: 'size',
									type: 'select',
									label: 'Size',
									options: [{ value: 's', label: 'Small' }, { value: 'm' }],
								},
								{ name: 'agree', type: 'checkbox', label: 'Agree' },
								{ name: 'qty', type: 'number', label: 'Qty' },
								{ name: 'Bad Name', type: 'text', label: 'x' },
								{ name: 'html', type: 'html', label: 'x' },
							],
							actions: [{ action: 'subscribe', label: 'Notify me' }],
						}
					: { title: 'Done' };
			return new Response(JSON.stringify(view), { status: 200, headers: { 'content-type': 'application/json' } });
		};
		const spec = { key: 'notify', stub: STUB_PROTOCOL, api: 'https://alerts.example.net', config: {}, strings: {} };
		const instance = start(
			/** @type {any} */ (data({ elements: [{ ...spec, placement: { selectors: [{ selector: '#main' }] } }] })),
			{ window, fetch, storage: null },
		);
		await settled(instance);
		await vi.waitFor(() => expect(window.document.querySelector('.ss-el__title')?.textContent).toBe('Notify me'));
		const ctx = JSON.parse(String(new URL(String(calls[0]?.url)).searchParams.get('ctx')));
		expect(ctx).toEqual({ path: '/p/sku-9', itemId: 'sku-9', pageType: 'product' });
		const inputs = window.document.querySelectorAll('.ss-el__input');
		expect([...inputs].map((/** @type {any} */ el) => el.getAttribute('name'))).toEqual(['email', 'size', 'agree', 'qty']);
		expect(window.document.querySelectorAll('.ss-el__input option')).toHaveLength(2);
		const email = /** @type {any} */ (window.document.querySelector('input[name="email"]'));
		// a required field left empty blocks the action
		/** @type {any} */ (window.document.querySelector('.ss-el__action')).click();
		await new Promise((r) => setTimeout(r, 20));
		expect(calls).toHaveLength(1);
		email.value = 'a@b.test';
		/** @type {any} */ (window.document.querySelector('input[name="agree"]')).checked = true;
		/** @type {any} */ (window.document.querySelector('input[name="qty"]')).value = '2';
		/** @type {any} */ (window.document.querySelector('.ss-el__action')).click();
		await vi.waitFor(() => expect(window.document.querySelector('.ss-el__title')?.textContent).toBe('Done'));
		expect(String(calls[1]?.url).split('?')[0]).toBe('https://alerts.example.net/v1/elements/notify/actions/subscribe');
		expect(JSON.parse(calls[1]?.init.body)).toEqual({ fields: { email: 'a@b.test', size: 's', agree: true, qty: 2 } });
		instance.destroy();

		// v1 bundles: no ctx, same view model
		calls.length = 0;
		const v1 = start(/** @type {any} */ (data({ elements: [{ ...spec, stub: 'ss-element-stub@1' }] })), {
			window,
			fetch,
			storage: null,
		});
		await settled(v1);
		await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
		expect(calls[0]?.url).toBe('https://alerts.example.net/v1/elements/notify/view');
		v1.destroy();
		vi.unstubAllGlobals();
	});

	it('the page context falls back to <meta> and the placement target; view fields are sanitised', () => {
		const { window } = new JSDOM(
			'<!doctype html><html><head><meta name="ss:item-id" content="it-1"></head><body><div id="t" data-ss-page-type="cart"></div></body></html>',
			{ url: 'https://shop.example.com/cart' },
		);
		expect(pageContext(window, 'x', { selectors: [{ selector: '#t' }, { selector: '##bad' }] })).toEqual({
			path: '/cart',
			itemId: 'it-1',
			pageType: 'cart',
		});
		expect(pageContext(null, 'x', undefined)).toEqual({ path: '/' });
		expect(viewFields('nope')).toEqual([]);
		expect(viewFields(Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, type: 'text', label: 'L' })))).toHaveLength(20);
		expect(viewFields([{ name: 'a', type: 'select', options: [{ value: 1 }, { label: 'no value' }] }])).toEqual([
			{ name: 'a', type: 'select', label: 'a', required: false, options: [{ value: '1', label: '1' }] },
		]);
	});

	it('the stub reports a missing element API', async () => {
		const definition = stubDefinition('launcher');
		/** @type {any} */
		let state = {};
		const created = definition.create({
			store: { setState: (/** @type {any} */ s) => (state = { ...state, ...s }) },
			client: null,
			emit: () => true,
		});
		await vi.waitFor(() => expect(state.status).toBe('error'));
		expect(await created.actions.invoke('open')).toMatchObject({ ok: false });
	});
});

describe('the compiled loader in a page', () => {
	it('boots from the bundled runtime string and evaluates precompiled audience programs', async () => {
		const { window } = page();
		const program = /** @type {any} */ (compile("device == 'desktop'")).program;
		const elements = [
			{
				...data().elements[0],
				compiledPlacement: { audience: program },
				kind: 'pack',
				delivery: 'pack',
				moduleVersion: 1,
				appId: PACK,
				manifestVersion: 1,
				headless: { path: 'headless/bar.js', name: 'createBar' },
				renderer: { path: 'ui/bar.js', name: 'render' },
			},
		];
		const compiled = bundleData({
			websiteId: WEBSITE,
			env: 'live',
			version: '',
			publicKey: 'pk_live_test',
			eventsUrl: 'https://portal.test/v1/events',
			assetBase: ASSETS,
			elements: /** @type {any} */ (elements),
		});
		const { text } = versionedLoader({ data: compiled, core: RUNTIME_CORE, audience: RUNTIME_AUDIENCE });
		window.eval(text);
		expect(typeof window.SS.track).toBe('function');
		expect(window.SS.elements.list().map((/** @type {any} */ e) => e.key)).toEqual(['bar']);
		expect(window.__ssr).toBeUndefined(); // nothing leaks but window.SS

		// the bundled runtime + evaluator mount the element when the audience matches (desktop width)
		const second = page().window;
		const ssr = second.eval(`${RUNTIME_CORE};__ssr`);
		const ssa = second.eval(`${RUNTIME_AUDIENCE};__ssa`);
		expect(ssa.evaluateAudienceProgram(program, { device: 'desktop' }, { now: Date.now(), timeZone: 'UTC' })).toBe(true);
		expect(ssa.evaluateAudienceProgram(program, { device: 'mobile' }, { now: Date.now(), timeZone: 'UTC' })).toBe(false);
		Object.defineProperty(second, 'innerWidth', { value: 1280 });
		/** Pack modules evaluated inside the page's realm (as a browser would). @param {string} url */
		const importInPage = async (url) => {
			const source = /** @type {Record<string, string>} */ (PACK_FILES)[url.slice(`${PACK_BASE}${PACK}/1/`.length)] ?? '';
			const exports = second.eval('({})');
			second.eval(`(function (exports) {${source.replace(/export const (\w+)/g, 'exports.$1')}})`)(exports);
			return exports;
		};
		// the data literal lives in the page's realm, exactly as in a compiled loader.js
		const pageData = second.eval(
			`(${JSON.stringify({ ...compiled, version: 'x', elements: [{ ...compiled.elements[0], placement: { audience: program, selectors: [{ selector: '#main' }] } }] })})`,
		);
		const instance = ssr.start(pageData, {
			window: second,
			importModule: importInPage,
			audience: ssa.evaluateAudienceProgram,
			storage: null,
			fetch: fakeFetch().fetch,
		});
		await settled(instance);
		expect(second.document.querySelector('#main .ss-bar')?.textContent).toBe('Free shipping');
	});
});
