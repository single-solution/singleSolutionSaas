// @vitest-environment jsdom
/* global window, document, MouseEvent, PopStateEvent */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { defineElement } from '../src/element.js';
import { boot } from '../src/loader.js';
import { evaluateAudience } from '../src/audience.js';
import { ENDPOINT, KEY, WEBSITE_ID, memoryStorage, scriptedFetch } from './helpers.js';

/** @type {Array<{ destroy: () => void }>} */
const cleanup = [];
/** @type {any} */
const win = window;

/** A small counter element: state, actions, events. */
const counter = defineElement({
	key: 'counter',
	strings: { label: 'Count' },
	initialState: ({ config }) => ({ count: config.start ?? 0 }),
	create: ({ store, emit }) => ({
		actions: {
			inc: () => {
				store.setState((s) => ({ count: s.count + 1 }));
				emit('incremented', { count: store.getState().count });
			},
			dismiss: () => {
				emit('dismissed');
			},
		},
	}),
});

/** Default renderer for the counter (Mode A). */
const counterRenderer = {
	/** @param {import('../src/loader.js').RenderProps} props */
	render: ({ state, strings, h }) => h('p', { className: 'count' }, `${strings.label}: ${state.count}`),
};

/** @param {string} key @param {Partial<import('../src/loader.js').BundleElement>} [extra] @returns {import('../src/loader.js').BundleElement} */
const element = (key, extra = {}) => ({
	key,
	headless: defineElement({ key, initialState: { count: 0 }, create: () => ({}) }),
	renderer: counterRenderer,
	strings: { label: key },
	...extra,
});

/** @param {Record<string, any>} [options] */
const makeClient = (options = {}) => {
	const fetch = scriptedFetch({ status: 202 });
	const client = createClient({
		key: KEY,
		endpoint: ENDPOINT,
		websiteId: WEBSITE_ID,
		storage: memoryStorage(),
		fetch,
		defaultConsent: { analytics: true },
		...options,
	});
	cleanup.push(client);
	return { client, fetch };
};

/** @param {Omit<import('../src/loader.js').BootOptions, 'websiteId' | 'env'> & { websiteId?: string }} options */
const start = (options) => {
	const instance = boot({ websiteId: WEBSITE_ID, env: 'test', storage: memoryStorage(), ...options });
	cleanup.push(instance);
	return instance;
};

/** @param {string} path */
const navigate = (path) => win.history.pushState({}, '', path);

beforeEach(() => {
	vi.useFakeTimers();
	navigate('/products/phone-1');
	document.body.innerHTML = '<main><div id="pdp"><button id="buy">Buy</button></div><footer id="foot"></footer></main>';
});
afterEach(() => {
	for (const item of cleanup.splice(0)) item.destroy();
	vi.useRealTimers();
	delete win.SS;
});

describe('mounting', () => {
	it('mounts headless + renderer on load, themed, and re-renders on state change', async () => {
		const { client } = makeClient();
		const loader = start({
			client,
			bundle: {
				elements: [
					{
						key: 'counter',
						headless: counter,
						renderer: counterRenderer,
						config: { start: 2 },
						theme: { color: { primary: '#0a5' } },
					},
				],
				theme: { radius: { md: '8px' } },
			},
		});
		expect(document.querySelector('[data-ss-element="counter"]')).toBeNull();
		await vi.advanceTimersByTimeAsync(0);
		await loader.ready();
		const container = /** @type {HTMLElement} */ (document.querySelector('[data-ss-element="counter"]'));
		expect(container.textContent).toBe('Count: 2');
		expect(container.style.getPropertyValue('--ss-color-primary')).toBe('#0a5');
		expect(container.style.getPropertyValue('--ss-radius-md')).toBe('8px');
		const instance = loader.get('counter');
		await instance?.actions.inc?.();
		expect(container.textContent).toBe('Count: 3');
		expect(win.SS.elements.get('counter')).toBe(instance);
		expect(loader.list()).toEqual([{ key: 'counter', status: 'mounted' }]);
	});

	it('uses renderer.update when provided (in-place, keeps the node)', async () => {
		const update = vi.fn((/** @type {any} */ node, /** @type {any} */ props) => {
			node.textContent = String(props.state.count);
		});
		const loader = start({
			bundle: {
				elements: [
					{
						key: 'counter',
						headless: counter,
						renderer: { render: ({ h, state }) => h('span', null, String(state.count)), update },
					},
				],
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		await loader.ready();
		const node = document.querySelector('[data-ss-element="counter"] span');
		await loader.get('counter')?.actions.inc?.();
		expect(update).toHaveBeenCalledTimes(1);
		expect(document.querySelector('[data-ss-element="counter"] span')).toBe(node);
		expect(node?.textContent).toBe('1');
	});

	it('lazy-loads code only when the placement matches (module default exports supported)', async () => {
		const headless = vi.fn(async () => ({ default: counter }));
		const renderer = vi.fn(async () => ({ default: counterRenderer }));
		const skipped = vi.fn(async () => ({ default: counter }));
		const loader = start({
			bundle: {
				elements: [
					{ key: 'counter', headless, renderer, placement: { paths: { include: ['/products/*'] } } },
					{ key: 'blog_only', headless: skipped, placement: { paths: { include: ['/blog/**'] } } },
				],
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		await loader.ready();
		expect(headless).toHaveBeenCalledTimes(1);
		expect(renderer).toHaveBeenCalledTimes(1);
		expect(skipped).not.toHaveBeenCalled();
		expect(loader.list()).toEqual([
			{ key: 'counter', status: 'mounted' },
			{ key: 'blog_only', status: 'blocked', reason: 'path' },
		]);
	});

	it.each([
		['append', '#pdp', (/** @type {Element} */ c) => c.parentElement?.id === 'pdp' && c.previousElementSibling?.id === 'buy'],
		['prepend', '#pdp', (/** @type {Element} */ c) => c.parentElement?.id === 'pdp' && c.nextElementSibling?.id === 'buy'],
		['before', '#foot', (/** @type {Element} */ c) => c.nextElementSibling?.id === 'foot'],
		['after', '#pdp', (/** @type {Element} */ c) => c.previousElementSibling?.id === 'pdp'],
		['replace', '#foot', (/** @type {Element} */ c) => !document.getElementById('foot') && c.parentElement?.tagName === 'MAIN'],
	])('mounts at a selector with position %s', async (position, selector, check) => {
		const loader = start({
			bundle: {
				elements: [element('slot_el', { placement: { selectors: [{ selector: '#nope' }, { selector, position }] } })],
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		await loader.ready();
		const container = /** @type {Element} */ (document.querySelector('[data-ss-element="slot_el"]'));
		expect(check(container)).toBe(true);
		loader.destroy();
		expect(document.querySelector('[data-ss-element="slot_el"]')).toBeNull();
		if (position === 'replace') expect(document.getElementById('foot')).not.toBeNull();
	});

	it('reserves space until the first render', async () => {
		/** @type {(value: any) => void} */
		let resolve = () => {};
		const renderer = () => new Promise((r) => (resolve = r));
		const loader = start({
			bundle: { elements: [{ key: 'counter', headless: counter, renderer, reserve: { minHeight: 64 } }] },
		});
		await vi.advanceTimersByTimeAsync(0);
		const container = /** @type {HTMLElement} */ (document.querySelector('[data-ss-element="counter"]'));
		expect(container.style.getPropertyValue('min-height')).toBe('64px');
		resolve(counterRenderer);
		await loader.ready();
		expect(container.style.getPropertyValue('min-height')).toBe('');
		expect(container.textContent).toBe('Count: 0');
	});

	it('mounts headless-only elements without DOM and gives them an API client', async () => {
		const { client } = makeClient();
		/** @type {any} */
		let seenClient;
		const headless = defineElement({
			key: 'apply_box',
			create: (ctx) => {
				seenClient = ctx.client;
				return {};
			},
		});
		const loader = start({
			client,
			bundle: { elements: [{ key: 'apply_box', headless, api: { baseUrl: 'https://api.coupons.example.test' } }] },
		});
		await vi.advanceTimersByTimeAsync(0);
		await loader.ready();
		expect(document.querySelector('[data-ss-element]')).toBeNull();
		expect(typeof seenClient.post).toBe('function');
		expect(loader.get('apply_box')).toBeDefined();
	});

	it('skips elements an entitlement document marks disabled or inactive', async () => {
		const loader = start({
			bundle: {
				elements: [element('on_el'), element('off_el'), element('paused_el')],
				doc: [
					{ elements: { off_el: { enabled: false }, on_el: { enabled: true } }, runtime: { state: 'active' } },
					{ elements: { paused_el: { enabled: true } }, runtime: { state: 'paused', reason: 'merchant' } },
					null,
				],
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		await loader.ready();
		expect(loader.list().map((entry) => entry.key)).toEqual(['on_el']);
	});

	it('waits for DOMContentLoaded while the document is loading', async () => {
		const state = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
		const loader = start({ bundle: { elements: [element('late_el')] } });
		expect(loader.list()[0]?.status).toBe('idle');
		state.mockRestore();
		document.dispatchEvent(new Event('DOMContentLoaded'));
		await vi.advanceTimersByTimeAsync(0);
		await loader.ready();
		expect(loader.list()[0]?.status).toBe('mounted');
	});
});

describe('triggers', () => {
	/** @param {Record<string, any>} trigger */
	const armed = (trigger) => start({ bundle: { elements: [element('trig', { placement: { triggers: [trigger] } })] } });
	/** @param {import('../src/loader.js').LoaderInstance} loader */
	const status = (loader) => loader.list()[0]?.status;

	it('load with delay', async () => {
		const loader = armed({ type: 'load', delayMs: 500 });
		await vi.advanceTimersByTimeAsync(499);
		expect(status(loader)).toBe('armed');
		await vi.advanceTimersByTimeAsync(1);
		await loader.ready();
		expect(status(loader)).toBe('mounted');
	});

	it('idle resets on activity', async () => {
		const loader = armed({ type: 'idle', afterMs: 1000 });
		await vi.advanceTimersByTimeAsync(900);
		win.dispatchEvent(new Event('pointermove'));
		await vi.advanceTimersByTimeAsync(900);
		expect(status(loader)).toBe('armed');
		await vi.advanceTimersByTimeAsync(100);
		await loader.ready();
		expect(status(loader)).toBe('mounted');
	});

	it('scroll depth', async () => {
		Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 4000 });
		win.innerHeight = 800;
		win.scrollY = 0;
		const loader = armed({ type: 'scroll', percent: 50 });
		await vi.advanceTimersByTimeAsync(0);
		expect(status(loader)).toBe('armed');
		win.scrollY = 1200;
		win.dispatchEvent(new Event('scroll'));
		await loader.ready();
		expect(status(loader)).toBe('mounted');
		// @ts-expect-error cleanup of the test override
		delete document.documentElement.scrollHeight;
	});

	it('exit intent', async () => {
		const loader = armed({ type: 'exit' });
		document.dispatchEvent(new MouseEvent('mouseout', { clientY: 200 }));
		expect(status(loader)).toBe('armed');
		document.dispatchEvent(new MouseEvent('mouseout', { clientY: 0 }));
		await loader.ready();
		expect(status(loader)).toBe('mounted');
	});

	it('selector click (delegated)', async () => {
		const loader = armed({ type: 'selector-click', selector: '#pdp button' });
		document.getElementById('foot')?.click();
		expect(status(loader)).toBe('armed');
		document.getElementById('buy')?.click();
		await loader.ready();
		expect(status(loader)).toBe('mounted');
	});

	it('events: tracked standard events and element events, with or without version', async () => {
		const { client } = makeClient();
		const loader = start({
			client,
			bundle: {
				elements: [
					element('on_cart', { placement: { triggers: [{ type: 'event', event: 'cart.updated@1' }] } }),
					element('on_counter', { placement: { triggers: [{ type: 'event', event: 'counter.incremented' }] } }),
					{ key: 'counter', headless: counter, placement: { triggers: [{ type: 'selector-click', selector: '#buy' }] } },
				],
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		win.SS.track('cart.updated', { cartId: 'c1', currency: 'PKR', lines: [], subtotalAmount: 0 });
		await loader.ready();
		expect(loader.list().find((entry) => entry.key === 'on_cart')?.status).toBe('mounted');
		document.getElementById('buy')?.click();
		await loader.ready();
		await loader.get('counter')?.actions.inc?.();
		await loader.ready();
		expect(loader.list().find((entry) => entry.key === 'on_counter')?.status).toBe('mounted');
	});

	it('any of several triggers fires once', async () => {
		const loader = start({
			bundle: {
				elements: [element('multi', { placement: { triggers: [{ type: 'exit' }, { type: 'load', delayMs: 100 }] } })],
			},
		});
		await vi.advanceTimersByTimeAsync(100);
		await loader.ready();
		document.dispatchEvent(new MouseEvent('mouseout', { clientY: 0 }));
		await loader.ready();
		expect(document.querySelectorAll('[data-ss-element="multi"]').length).toBe(1);
	});
});

describe('frequency caps in the loader', () => {
	it('enforces maxPerSession across page loads and remembers dismissals', async () => {
		const storage = memoryStorage();
		const { client } = makeClient({ storage });
		const bundle = {
			elements: [
				{
					key: 'counter',
					headless: counter,
					renderer: counterRenderer,
					placement: { frequency: { maxPerSession: 2, dismissMemory: 'P1D' } },
				},
			],
		};
		for (let page = 0; page < 2; page += 1) {
			const loader = start({ client, storage, bundle });
			await vi.advanceTimersByTimeAsync(0);
			await loader.ready();
			expect(loader.list()[0]?.status).toBe('mounted');
			loader.destroy();
		}
		const third = start({ client, storage, bundle });
		expect(third.list()[0]).toEqual({ key: 'counter', status: 'blocked', reason: 'frequency' });
		third.destroy();

		const other = memoryStorage();
		const loader = start({ client, storage: other, bundle });
		await vi.advanceTimersByTimeAsync(0);
		await loader.ready();
		await loader.get('counter')?.actions.dismiss?.();
		loader.destroy();
		expect(start({ client, storage: other, bundle }).list()[0]?.reason).toBe('frequency');
	});

	it('re-checks caps when a delayed trigger fires', async () => {
		const storage = memoryStorage();
		const bundle = {
			elements: [
				element('capped', { placement: { frequency: { maxPerVisitor: 1 }, triggers: [{ type: 'load', delayMs: 1000 }] } }),
			],
		};
		const first = start({ storage, bundle, websiteId: WEBSITE_ID });
		const key = `ss:${WEBSITE_ID}:fq:capped`;
		storage.setItem(key, JSON.stringify({ shows: [Date.now()], total: 1 }));
		await vi.advanceTimersByTimeAsync(1000);
		expect(first.list()[0]).toEqual({ key: 'capped', status: 'blocked', reason: 'frequency' });
	});
});

describe('error isolation', () => {
	it('one failing element never breaks the others or the page', async () => {
		const onError = vi.fn();
		const pageEvents = vi.fn();
		win.addEventListener('ss:error', pageEvents);
		const crashingCreate = defineElement({
			key: 'crash_create',
			create: () => {
				throw new Error('create failed');
			},
		});
		const loader = start({
			onError,
			bundle: {
				elements: [
					{ key: 'crash_create', headless: crashingCreate, renderer: counterRenderer },
					{
						key: 'crash_render',
						headless: defineElement({ key: 'crash_render', create: () => ({}) }),
						renderer: {
							render: () => {
								throw new Error('render failed');
							},
						},
					},
					{
						key: 'crash_import',
						headless: async () => {
							throw new Error('chunk failed');
						},
					},
					{ key: 'wrong_key', headless: counter },
					{
						key: 'bad_renderer',
						headless: defineElement({ key: 'bad_renderer', create: () => ({}) }),
						renderer: /** @type {any} */ (async () => ({ nothing: true })),
					},
					element('healthy'),
					/** @type {any} */ ({ key: 'Bad Key' }),
					/** @type {any} */ ('junk'),
					element('healthy'),
				],
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		await loader.ready();
		const statuses = Object.fromEntries(loader.list().map((entry) => [entry.key, entry.status]));
		expect(statuses).toEqual({
			crash_create: 'failed',
			crash_render: 'failed',
			crash_import: 'failed',
			wrong_key: 'failed',
			bad_renderer: 'failed',
			healthy: 'mounted',
		});
		expect(document.querySelectorAll('[data-ss-element]').length).toBe(1);
		expect(onError.mock.calls.filter(([report]) => report.phase === 'mount').length).toBe(5);
		expect(onError.mock.calls.filter(([report]) => report.phase === 'bundle').length).toBe(3);
		expect(pageEvents).toHaveBeenCalled();
		win.removeEventListener('ss:error', pageEvents);
	});

	it('contains re-render failures, hook failures and a failing onError', async () => {
		let explode = false;
		const loader = start({
			onError: () => {
				throw new Error('reporter down');
			},
			bundle: {
				elements: [
					{
						key: 'counter',
						headless: counter,
						renderer: {
							render: ({ h, state }) => {
								if (explode) throw new Error('boom');
								return h('span', null, String(state.count));
							},
						},
					},
				],
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		await loader.ready();
		loader.on('counter.incremented', () => {
			throw new Error('merchant hook');
		});
		const ok = vi.fn();
		loader.on('*', ok);
		await loader.get('counter')?.actions.inc?.();
		expect(ok).toHaveBeenCalledTimes(1); // the throwing hook did not stop the next one
		explode = true;
		const instance = loader.get('counter');
		await instance?.actions.inc?.();
		expect(loader.list()[0]?.status).toBe('failed');
		expect(document.querySelector('[data-ss-element="counter"]')).toBeNull();
		expect(instance?.isDestroyed()).toBe(true);
		expect(document.getElementById('buy')).not.toBeNull();
	});

	it('reports placement evaluation errors and trigger errors', async () => {
		const onError = vi.fn();
		const loader = start({
			onError,
			bundle: {
				elements: [
					element('weird', {
						placement: /** @type {any} */ ({
							get paths() {
								throw new Error('getter');
							},
						}),
					}),
				],
			},
		});
		expect(loader.list()[0]).toEqual({ key: 'weird', status: 'blocked', reason: 'placement' });
		expect(onError.mock.calls[0]?.[0].phase).toBe('placement');
	});
});

describe('consent, identity, navigation', () => {
	it('mounts after consent is granted and unmounts on revocation', async () => {
		const { client } = makeClient({ defaultConsent: {} });
		const loader = start({
			client,
			bundle: { elements: [element('marketing_el', { placement: { consent: ['marketing'] } })] },
		});
		expect(loader.list()[0]?.reason).toBe('consent');
		win.SS.consent.set({ marketing: true });
		await vi.advanceTimersByTimeAsync(0);
		await loader.ready();
		expect(loader.list()[0]?.status).toBe('mounted');
		expect(win.SS.consent.get()).toMatchObject({ marketing: true });
		client.consent.set({ marketing: false });
		expect(loader.list()[0]).toEqual({ key: 'marketing_el', status: 'blocked', reason: 'consent' });
		expect(document.querySelector('[data-ss-element]')).toBeNull();
	});

	it('re-evaluates on SPA navigation and identity changes', async () => {
		const { client } = makeClient();
		const loader = start({
			client,
			audience: evaluateAudience,
			bundle: {
				elements: [
					element('pdp_only', { placement: { paths: { include: ['/products/*'] } } }),
					element('members', { placement: { audience: 'visitor.identified' } }),
				],
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		await loader.ready();
		expect(loader.list().map((entry) => entry.status)).toEqual(['mounted', 'blocked']);
		navigate('/cart');
		win.dispatchEvent(new PopStateEvent('popstate'));
		expect(loader.list()[0]).toEqual({ key: 'pdp_only', status: 'blocked', reason: 'path' });
		win.SS.identify({ token: 'site.jwt.token' });
		await vi.advanceTimersByTimeAsync(0);
		await loader.ready();
		expect(loader.list()[1]?.status).toBe('mounted');
		navigate('/products/2');
		loader.refresh();
		await vi.advanceTimersByTimeAsync(0);
		await loader.ready();
		expect(loader.list()[0]?.status).toBe('mounted');
	});

	it('evaluates audience rules against the boot context, page type and device', async () => {
		document.documentElement.setAttribute('data-ss-page-type', 'product');
		win.innerWidth = 375;
		const loader = start({
			audience: evaluateAudience,
			context: { segments: ['vip'] },
			bundle: {
				elements: [
					element('vip', {
						placement: {
							audience: "inSegment('vip') and page.pageType == 'product' and device == 'mobile'",
							pageTypes: ['product'],
						},
					}),
					element('no_evaluator_needed'),
				],
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		await loader.ready();
		expect(loader.list().map((entry) => entry.status)).toEqual(['mounted', 'mounted']);
		document.documentElement.removeAttribute('data-ss-page-type');
		win.innerWidth = 1280;
	});
});

describe('events and window.SS', () => {
	it('forwards element events as <element>.<verb> envelopes and runs merchant hooks', async () => {
		const { client, fetch } = makeClient();
		const loader = start({ client, bundle: { elements: [{ key: 'counter', headless: counter, renderer: counterRenderer }] } });
		const hook = vi.fn();
		const off = win.SS.on('counter.incremented', hook);
		await vi.advanceTimersByTimeAsync(0);
		await loader.ready();
		await loader.get('counter')?.actions.inc?.();
		off();
		await loader.get('counter')?.actions.inc?.();
		expect(hook).toHaveBeenCalledTimes(1);
		expect(hook.mock.calls[0]?.[0]).toEqual({ type: 'counter.incremented@1', data: { count: 1 } });
		await client.flush();
		const types = fetch.calls.flatMap((/** @type {any} */ call) =>
			call.body.events.map((/** @type {any} */ e) => [e.type, e.context.element]),
		);
		expect(types).toEqual([
			['counter.shown@1', 'counter'],
			['counter.incremented@1', 'counter'],
			['counter.incremented@1', 'counter'],
		]);
	});

	it('is idempotent: double boot returns the same instance and mounts once', async () => {
		const bundle = { elements: [element('once')] };
		const first = start({ bundle });
		const second = boot({ websiteId: WEBSITE_ID, env: 'test', bundle });
		expect(second).toBe(first);
		await vi.advanceTimersByTimeAsync(0);
		await first.ready();
		expect(document.querySelectorAll('[data-ss-element="once"]').length).toBe(1);
		const otherSite = start({ websiteId: 'web_other0000000000000000000', bundle: { elements: [] } });
		expect(otherSite).not.toBe(first);
		expect(win.SS.elements.get('once')).toBeDefined();
	});

	it('replays calls queued on a pre-boot stub and keeps a merchant namespace object', async () => {
		const { client, fetch } = makeClient({ defaultConsent: {} });
		win.SS = {
			q: [
				['consent', { analytics: true }],
				['track', 'custom.pre_boot', { a: 1 }],
				['nope'],
				'junk',
				['identify', { token: 'a.b.c' }],
			],
			merchant: 'kept',
		};
		start({ client, bundle: { elements: [] } });
		expect(win.SS.merchant).toBe('kept');
		expect(win.SS.q).toEqual([]);
		expect(client.identity()).toBe('a.b.c');
		await client.flush();
		expect(fetch.calls[0]?.body.events[0].type).toBe('custom.pre_boot@1');
	});

	it('works without a client', async () => {
		const loader = start({ bundle: { elements: [element('solo', { placement: { consent: ['necessary'] } })] } });
		expect(win.SS.track('custom.x')).toEqual({ ok: false, reason: 'no_client' });
		expect(win.SS.identify({ token: 'x' })).toEqual({ ok: false });
		expect(win.SS.consent.get()).toEqual({ necessary: true });
		expect(win.SS.consent.set({ analytics: true })).toEqual({ necessary: true });
		await vi.advanceTimersByTimeAsync(0);
		await loader.ready();
		expect(loader.get('solo')).toBeDefined();
		expect(loader.get('missing')).toBeUndefined();
	});

	it('destroy removes the window API it installed and allows a clean re-boot', () => {
		const loader = start({ bundle: { elements: [] } });
		expect(typeof win.SS.track).toBe('function');
		loader.destroy();
		loader.destroy();
		expect(win.SS.track).toBeUndefined();
		const again = start({ bundle: { elements: [] } });
		expect(again).not.toBe(loader);
		expect(typeof win.SS.track).toBe('function');
	});

	it('boots without a window (SSR)', () => {
		const loader = start({ window: null, bundle: { elements: [element('ssr', { renderer: undefined })] } });
		expect(loader.list()[0]?.status).toBe('armed');
	});
});

describe('RUM', () => {
	it('samples Core Web Vitals and element mount times, reported once on pagehide', async () => {
		/** @type {Record<string, (list: { getEntries: () => any[] }) => void>} */
		const callbacks = {};
		const disconnect = vi.fn();
		const FakeObserver = vi.fn(function (/** @type {any} */ callback) {
			return {
				observe: (/** @type {any} */ options) => {
					if (options.type === 'event') expect(options.durationThreshold).toBe(40);
					callbacks[options.type] = callback;
				},
				disconnect,
			};
		});
		win.PerformanceObserver = FakeObserver;
		const { client } = makeClient();
		const track = vi.fn(client.track);
		const spied = { ...client, track };
		const loader = start({
			client: spied,
			random: () => 0,
			bundle: { version: '42', rum: { sampleRate: 0.5 }, elements: [element('timed')] },
		});
		await vi.advanceTimersByTimeAsync(0);
		await loader.ready();
		callbacks['largest-contentful-paint']?.({ getEntries: () => [{ startTime: 900.4 }, { startTime: 1200.6 }] });
		callbacks['layout-shift']?.({
			getEntries: () => [
				{ startTime: 100, value: 0.05, hadRecentInput: false },
				{ startTime: 300, value: 0.05, hadRecentInput: false },
				{ startTime: 400, value: 0.5, hadRecentInput: true },
				{ startTime: 3000, value: 0.02, hadRecentInput: false },
			],
		});
		callbacks.event?.({
			getEntries: () => [
				{ interactionId: 1, duration: 80 },
				{ interactionId: 1, duration: 120 },
				{ interactionId: 2, duration: 200 },
				{ interactionId: 0, duration: 999 },
			],
		});
		callbacks['layout-shift']?.({
			getEntries: () => {
				throw new Error('observer bug');
			},
		});
		win.dispatchEvent(new Event('pagehide'));
		win.dispatchEvent(new Event('pagehide'));
		const vitals = track.mock.calls.filter(([type]) => type === 'loader.vitals@1');
		expect(vitals).toHaveLength(1);
		expect(vitals[0]?.[1]).toMatchObject({
			lcp: 1201,
			cls: 0.1,
			inp: 200,
			bundleVersion: '42',
			elements: { timed: { mountMs: expect.any(Number) } },
		});
		loader.destroy();
		expect(disconnect).toHaveBeenCalledTimes(3);
		delete win.PerformanceObserver;
	});

	it('does not observe when not sampled or unsupported', () => {
		const FakeObserver = vi.fn();
		win.PerformanceObserver = FakeObserver;
		start({ random: () => 0.9, bundle: { rum: { sampleRate: 0.5 }, elements: [] } });
		expect(FakeObserver).not.toHaveBeenCalled();
		delete win.PerformanceObserver;
		start({ websiteId: 'web_second000000000000000000', random: () => 0, bundle: { rum: { sampleRate: 1 }, elements: [] } });
	});

	it('reports on visibilitychange to hidden without LCP/INP when absent', async () => {
		win.PerformanceObserver = vi.fn(function () {
			return { observe: () => {}, disconnect: () => {} };
		});
		const { client } = makeClient();
		const track = vi.fn(client.track);
		const spied = { ...client, track };
		start({ client: spied, random: () => 0, bundle: { rum: { sampleRate: 1 }, elements: [] } });
		const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
		document.dispatchEvent(new Event('visibilitychange'));
		visibility.mockRestore();
		const vitals = track.mock.calls.find(([type]) => type === 'loader.vitals@1');
		expect(vitals?.[1]).toEqual({ cls: 0, elements: {} });
		delete win.PerformanceObserver;
	});
});
