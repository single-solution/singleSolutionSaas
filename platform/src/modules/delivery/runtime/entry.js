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
 * - **Service-product elements** ship the modules of the product's widget bundle, loaded exactly like pack modules
 *   (`data.assets` + `packs/<appId>/<version>/<path>`), with the element API client (`client`) bound to the product's
 *   base URL and the website's `pk_` key (`SS-Identity` added when a federated identity token is present).
 * - Pack elements receive a placeholder Graph client (every call resolves to a `graph_unavailable` result) until the
 *   Website Graph API exists, plus `clients`: an element API client per service product the pack reads
 *   (`manifest.reads`, F.18) that is active on the website, bound to its API base and the website's `pk_` key.
 * - Every element carries its product slug: the Loader addresses it as `<product>:<key>` (F.18).
 * @module
 */
import { createClient } from '@ss/web/client';
import { boot } from '@ss/web/loader';

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

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
		create: (/** @type {any} */ { config, strings, client, clients, identity, emit, store }) => {
			const inner = factory({
				config,
				strings,
				client: client ?? unavailableClient(),
				clients: clients ?? {},
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
 * @typedef {object} CompiledElement
 * @property {string} key
 * @property {string} [product] the delivering product's slug (the Loader id is `<product>:<key>`)
 * @property {Record<string, string>} [reads] API base of each read service product active on the website
 * @property {Record<string, unknown>} [placement] placement v1 with `audience` precompiled to a rules@1 program
 * @property {Record<string, unknown>} [config]
 * @property {Record<string, unknown>} [strings]
 * @property {{ path: string, name: string }} headless module (relative to `data.assets`) and export
 * @property {{ path: string, name: string }} renderer
 * @property {string} [api] the service product's base URL (service widgets)
 * @property {Record<string, unknown>} [reserve]
 */

/**
 * @typedef {object} CompiledData
 * @property {string} websiteId
 * @property {'live' | 'test'} env
 * @property {string} version
 * @property {string} key the website's public `pk_` key (events, element APIs)
 * @property {string} events events ingest URL
 * @property {string} assets base URL of element modules (ends with `/`; paths start with `packs/`)
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
		const reads = Object.fromEntries(
			Object.entries(isObject(spec.reads) ? spec.reads : {})
				.filter(([, base]) => typeof base === 'string')
				.map(([slug, base]) => [slug, { baseUrl: String(base) }]),
		);
		const common = {
			key: spec.key,
			...(typeof spec.product === 'string' ? { product: spec.product } : {}),
			...(Object.keys(reads).length > 0 ? { reads } : {}),
			...(spec.placement ? { placement: spec.placement } : {}),
			config: spec.config ?? {},
			strings: spec.strings ?? {},
			...(spec.reserve ? { reserve: spec.reserve } : {}),
		};
		const { headless, renderer } = spec;
		return {
			...common,
			...(typeof spec.api === 'string' ? { api: { baseUrl: spec.api } } : {}),
			headless: () => importModule(url(headless)).then((mod) => adaptHeadless(mod?.[headless.name], spec.key)),
			renderer: () => importModule(url(renderer)).then((mod) => adaptRenderer(mod, renderer.name, win, nonce)),
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
