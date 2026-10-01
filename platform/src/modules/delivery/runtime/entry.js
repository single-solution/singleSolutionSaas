/**
 * Browser runtime of a compiled website bundle (PLAN §4.1, F.7). This file runs **in the visitor's browser**, never in
 * the Portal: `scripts/build-delivery-runtime.js` bundles it with the `@ss/web` Loader and events client into
 * `runtime/generated.js` (an IIFE string), and the compiler prepends that string to every website's `loader.js`, which
 * then calls `start(data, { audience })` with the website's compiled data.
 *
 * What it adds on top of `@ss/web`:
 *
 * - **Pack modules** are imported lazily from their immutable, hash-verified asset URLs (`data.assets` + path). A
 *   headless export may be an `@ss/web/element` definition (`{ key, create }`) or a Part E §4 factory
 *   (`createX({ config, strings, client, identity, emit })` → `{ state, actions, subscribe, destroy }`), which is
 *   adapted to a definition. A renderer export receives the Loader's props plus `dom` (the document); a module-level
 *   `styles` string is adopted once per page (constructable stylesheet, else a `<style nonce>`).
 * - **Service-product elements** have no code of their own in the bundle: the **element stub** (`ss-element-stub@1`)
 *   is a generic headless core + renderer that talks to the product's REST API with the website's `pk_` key:
 *   `GET  <api>/v1/elements/<key>/view` → a view model, `POST <api>/v1/elements/<key>/actions/<action>` → the next view
 *   model (`Idempotency-Key` added by the element API client). View model (all optional, text only, never HTML):
 *   `{ title, body, items: [{ text, href? }] (≤ 50), actions: [{ action, label }] (≤ 10) }`.
 * - Pack elements receive a placeholder Graph client (every call resolves to a `graph_unavailable` result) until the
 *   Website Graph API exists.
 * @module
 */
import { err, problem } from '../../../../../packages/web/src/element.js';
import { createClient } from '../../../../../packages/web/src/client.js';
import { boot } from '../../../../../packages/web/src/loader.js';

export const STUB_PROTOCOL = 'ss-element-stub@1';
const ACTION = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_ITEMS = 50;
const MAX_ACTIONS = 10;

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} value @param {number} [max] */
const text = (value, max = 500) => (typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, max) : '');

/**
 * Placeholder Mode-C client for pack elements: any method resolves to a `graph_unavailable` result.
 * @returns {Record<string, (...args: unknown[]) => Promise<unknown>>}
 */
export const unavailableClient = () => {
	const result = Object.freeze({
		ok: false,
		error: Object.freeze({ code: 'graph_unavailable', status: 0 }),
		problem: Object.freeze({ code: 'graph_unavailable', status: 0 }),
	});
	return new Proxy(
		{},
		{ get: (_target, name) => (name === 'then' || typeof name === 'symbol' ? undefined : async () => result) },
	);
};

/**
 * Turn a pack's headless export into an `@ss/web/element` definition.
 * @param {unknown} exported
 * @param {string} key
 * @returns {any}
 */
export const adaptHeadless = (exported, key) => {
	if (isObject(exported) && typeof exported.create === 'function') {
		if (exported.key !== key) throw new TypeError(`headless definition key ${exported.key} is not ${key}`);
		return exported;
	}
	if (typeof exported !== 'function') throw new TypeError(`headless export of ${key} is not a factory`);
	const factory = /** @type {(input: Record<string, unknown>) => any} */ (exported);
	return {
		key,
		create: (/** @type {any} */ { config, strings, client, identity, emit, store }) => {
			const inner = factory({
				config,
				strings,
				client: client ?? unavailableClient(),
				identity,
				emit: (/** @type {unknown} */ name, /** @type {unknown} */ data) => emit(String(name), isObject(data) ? data : {}),
			});
			const sync = () => store.setState(typeof inner?.state === 'function' ? inner.state() : {});
			sync();
			const off = typeof inner?.subscribe === 'function' ? inner.subscribe(sync) : null;
			return {
				actions: isObject(inner?.actions) ? inner.actions : {},
				destroy: () => {
					if (typeof off === 'function') off();
					if (typeof inner?.destroy === 'function') inner.destroy();
				},
			};
		},
	};
};

/** @type {WeakMap<object, Set<string>>} */
const adopted = new WeakMap();

/**
 * Adopt a renderer stylesheet once per document.
 * @param {any} win
 * @param {string} css
 * @param {string | undefined} nonce
 */
export const adoptStyles = (win, css, nonce) => {
	const doc = win?.document;
	if (!doc || css === '') return;
	const seen = adopted.get(doc) ?? new Set();
	adopted.set(doc, seen);
	if (seen.has(css)) return;
	seen.add(css);
	if (typeof win.CSSStyleSheet === 'function' && Array.isArray(doc.adoptedStyleSheets)) {
		try {
			const sheet = new win.CSSStyleSheet();
			sheet.replaceSync(css);
			doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
			return;
		} catch {
			/* fall back to a <style> element */
		}
	}
	const style = doc.createElement('style');
	if (nonce) style.setAttribute('nonce', nonce);
	style.textContent = css;
	doc.head?.append(style);
};

/**
 * Turn a pack's renderer module into the Loader's renderer shape (`dom` added to the props).
 * @param {any} mod
 * @param {string} name export name
 * @param {any} win
 * @param {string | undefined} nonce
 */
export const adaptRenderer = (mod, name, win, nonce) => {
	const render = mod?.[name];
	if (typeof render !== 'function') throw new TypeError(`renderer export ${name} is not a function`);
	if (typeof mod.styles === 'string') adoptStyles(win, mod.styles, nonce);
	const update = mod.update;
	return {
		render: (/** @type {Record<string, unknown>} */ props) => render({ ...props, dom: win?.document }),
		...(typeof update === 'function'
			? {
					update: (/** @type {unknown} */ node, /** @type {Record<string, unknown>} */ props) =>
						update(node, { ...props, dom: win?.document }),
				}
			: {}),
	};
};

/**
 * Headless core of the element stub (service products).
 * @param {string} key
 */
export const stubDefinition = (key) => ({
	key,
	initialState: { status: 'idle', view: null, error: null },
	create: (/** @type {any} */ { store, client, emit }) => {
		const base = `/v1/elements/${key}`;
		/** @param {any} result */
		const apply = (result) => {
			if (result.ok) store.setState({ status: 'ready', view: isObject(result.value) ? result.value : null, error: null });
			else store.setState({ status: 'error', error: result.error.code });
			return result;
		};
		const load = async () => {
			if (!client) return apply(err(problem('invalid_request', { detail: 'no element API' })));
			store.setState({ status: 'loading' });
			return apply(await client.get(`${base}/view`));
		};
		void load();
		return {
			actions: {
				refresh: load,
				invoke: async (/** @type {unknown} */ action, /** @type {unknown} */ input = {}) => {
					if (typeof action !== 'string' || !ACTION.test(action) || !client)
						return err(problem('invalid_request', { detail: 'unknown action' }));
					const result = apply(await client.post(`${base}/actions/${action}`, isObject(input) ? input : {}));
					if (result.ok) emit('action', { action });
					return result;
				},
			},
		};
	},
});

/** Default renderer of the element stub: the view model as text, links and buttons (the Loader's safe `h`). */
export const stubRenderer = Object.freeze({
	render: (/** @type {any} */ { state, actions, h, element }) => {
		const view = isObject(state.view) ? state.view : {};
		const items = Array.isArray(view.items) ? view.items.filter(isObject).slice(0, MAX_ITEMS) : [];
		/** @type {any[]} */
		const buttons = Array.isArray(view.actions)
			? view.actions
					.filter((/** @type {unknown} */ a) => isObject(a) && typeof a.action === 'string' && ACTION.test(a.action))
					.slice(0, MAX_ACTIONS)
			: [];
		return h(
			'div',
			{
				className: `ss-el ss-el--${element.key}`,
				role: 'region',
				'aria-busy': state.status === 'loading' ? 'true' : 'false',
				'data-ss-status': state.status,
			},
			view.title ? h('h3', { className: 'ss-el__title' }, text(view.title, 200)) : null,
			view.body ? h('p', { className: 'ss-el__body' }, text(view.body, 2000)) : null,
			items.length > 0
				? h(
						'ul',
						{ className: 'ss-el__items' },
						...items.map((/** @type {any} */ item) =>
							h('li', null, item.href ? h('a', { href: text(item.href, 2000) }, text(item.text)) : text(item.text)),
						),
					)
				: null,
			...buttons.map((/** @type {any} */ b) =>
				h(
					'button',
					{ type: 'button', className: 'ss-el__action', onClick: () => actions.invoke(b.action) },
					text(b.label, 80),
				),
			),
		);
	},
});

/**
 * @typedef {object} CompiledElement
 * @property {string} key
 * @property {Record<string, unknown>} [placement] placement v1 with `audience` precompiled to a rules@1 program
 * @property {Record<string, unknown>} [config]
 * @property {Record<string, unknown>} [strings]
 * @property {{ path: string, name: string }} [headless] pack module (relative to `data.assets`) and export
 * @property {{ path: string, name: string }} [renderer]
 * @property {string} [stub] `ss-element-stub@1` for service-product elements
 * @property {string} [api] the service product's API base (stub only)
 * @property {Record<string, unknown>} [reserve]
 */

/**
 * @typedef {object} CompiledData
 * @property {string} websiteId
 * @property {'live' | 'test'} env
 * @property {string} version
 * @property {string} key the website's public `pk_` key (events, element APIs)
 * @property {string} events events ingest URL
 * @property {string} assets base URL of pack modules (ends with `/`)
 * @property {{ sampleRate?: number }} [rum]
 * @property {CompiledElement[]} elements
 */

/**
 * Boot the Loader with compiled data.
 * @param {CompiledData} data
 * @param {{ audience?: (program: unknown, context: Record<string, unknown>, options: { now: number, timeZone: string }) => boolean,
 *   window?: any, importModule?: (url: string) => Promise<any>, storage?: any, fetch?: typeof fetch }} [options]
 */
export const start = (data, options = {}) => {
	const win = options.window ?? globalThis.window;
	const importModule = options.importModule ?? ((/** @type {string} */ url) => import(/* @vite-ignore */ url));
	const script = win?.document?.currentScript;
	const nonce = typeof script?.nonce === 'string' && script.nonce !== '' ? script.nonce : undefined;
	const client = createClient({
		key: data.key,
		endpoint: data.events,
		websiteId: data.websiteId,
		env: data.env,
		defaultConsent: {},
		window: win,
		...(options.storage === undefined ? {} : { storage: options.storage }),
		...(options.fetch ? { fetch: options.fetch } : {}),
	});
	/** @param {{ path: string }} ref */
	const url = (ref) => `${data.assets}${ref.path}`;
	const elements = data.elements.map((spec) => {
		const common = {
			key: spec.key,
			...(spec.placement ? { placement: spec.placement } : {}),
			config: spec.config ?? {},
			strings: spec.strings ?? {},
			...(spec.reserve ? { reserve: spec.reserve } : {}),
		};
		if (spec.stub === STUB_PROTOCOL)
			return { ...common, headless: stubDefinition(spec.key), renderer: stubRenderer, api: { baseUrl: String(spec.api) } };
		const headless = /** @type {{ path: string, name: string }} */ (spec.headless);
		const renderer = spec.renderer;
		return {
			...common,
			headless: () => importModule(url(headless)).then((mod) => adaptHeadless(mod?.[headless.name], spec.key)),
			...(renderer
				? { renderer: () => importModule(url(renderer)).then((mod) => adaptRenderer(mod, renderer.name, win, nonce)) }
				: {}),
		};
	});
	return boot({
		websiteId: data.websiteId,
		env: data.env,
		client,
		window: win,
		...(options.audience ? { audience: options.audience } : {}),
		...(options.storage === undefined ? {} : { storage: options.storage }),
		...(options.fetch ? { fetch: options.fetch } : {}),
		bundle: { version: data.version, elements, ...(nonce ? { csp: { nonce } } : {}), ...(data.rum ? { rum: data.rum } : {}) },
	});
};
