import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { JSDOM } from './dom.js';
import { compile } from '@ss/rules';
import { buildRuntimeSource, OUTPUT } from '../../../scripts/build-delivery-runtime.js';
import { bundleData, versionedLoader } from '../../../src/modules/delivery/core/compile.js';
import {
	adaptHeadless,
	adaptRenderer,
	adoptStyles,
	start,
	unavailableClient,
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

/** Fake product API (service widgets) and events endpoint. */
const fakeFetch = () => {
	/** @type {Array<{ url: string, init: any }>} */
	const calls = [];
	/** @type {any} */
	const fetch = async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
		calls.push({ url, init });
		return new Response(JSON.stringify({ greeting: 'Need help?' }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	};
	return { fetch, calls };
};

/** A service widget: its headless core loads a greeting through the element API client bound to the product. */
const WIDGET_FILES = /** @type {Record<string, string>} */ ({
	'headless/launcher.js': [
		'export const createLauncher = ({ client }) => {',
		"\tlet state = { greeting: '' };",
		'\tconst listeners = new Set();',
		"\tclient.get('/v1/launcher').then((r) => { state = { greeting: r.ok ? r.value.greeting : r.error.code }; for (const fn of listeners) fn(state); });",
		'\treturn { state: () => state, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, actions: {} };',
		'};',
	].join('\n'),
	'ui/launcher.js': [
		'export const render = ({ state, dom }) => {',
		"\tconst el = dom.createElement('p');",
		"\tel.className = 'ss-launcher';",
		'\tel.textContent = state.greeting;',
		'\treturn el;',
		'};',
	].join('\n'),
});

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

	it('service widgets: real modules with an element API client bound to the product and the website key', async () => {
		const { window } = page();
		const { fetch, calls } = fakeFetch();
		const base = `${PACK_BASE}app_1123456789abcdefghjkmnpq/2/`;
		const spec = {
			key: 'launcher',
			product: 'chat-box',
			config: {},
			strings: {},
			placement: { selectors: [{ selector: '#main', position: 'append' }] },
			headless: { path: 'packs/app_1123456789abcdefghjkmnpq/2/headless/launcher.js', name: 'createLauncher' },
			renderer: { path: 'packs/app_1123456789abcdefghjkmnpq/2/ui/launcher.js', name: 'render' },
			api: 'https://chat.example.net',
		};
		const importWidget = async (/** @type {string} */ url) =>
			import(`data:text/javascript;base64,${Buffer.from(WIDGET_FILES[url.slice(base.length)] ?? '').toString('base64')}`);
		const instance = start(/** @type {any} */ (data({ elements: [spec] })), {
			window,
			importModule: importWidget,
			fetch,
			storage: null,
		});
		await settled(instance);
		await vi.waitFor(() => expect(window.document.querySelector('#main .ss-launcher')?.textContent).toBe('Need help?'));
		const call = calls.find((c) => String(c.url).startsWith('https://chat.example.net/'));
		expect(String(call?.url)).toBe('https://chat.example.net/v1/launcher');
		expect(new Headers(call?.init.headers).get('authorization')).toBe('Bearer pk_live_test');
		instance.destroy();
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
				moduleVersion: 1,
				reads: {},
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
