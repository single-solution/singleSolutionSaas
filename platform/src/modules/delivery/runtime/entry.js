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
 * - **Service-product elements** either ship the modules of the product's signed UI bundle (loaded like pack modules,
 *   with the element API client bound to the product's API base) or, without one, the **element stub**
 *   (`ss-element-stub@2`; `@1` data is still accepted): a generic headless core + renderer that talks to the
 *   product's REST API with the website's `pk_` key:
 *   `GET  <api>/v1/elements/<key>/view?ctx=<JSON>` → a view model, `POST <api>/v1/elements/<key>/actions/<action>?ctx=`
 *   → the next view model (`Idempotency-Key` added by the element API client). `ctx` is the page context
 *   `{ path, itemId?, pageType? }` (item id / page type from `data-ss-item-id` / `data-ss-page-type` on the element's
 *   nearest ancestor, else the placement target, else `<html>` / `<meta name="ss:item-id|ss:page-type">`). View model
 *   (all optional, text only, never HTML): `{ title, body, items: [{ text, href? }] (≤ 50), fields: [{ name, type,
 *   label, required?, options? }] (≤ 20), actions: [{ action, label }] (≤ 10) }`; an action posts `{ ...input,
 *   fields: { <name>: value } }` when the view has fields (v1 products never send fields, so their bodies are
 *   unchanged).
 * - Pack elements receive a placeholder Graph client (every call resolves to a `graph_unavailable` result) until the
 *   Website Graph API exists.
 * @module
 */
import { err, problem } from '../../../../../packages/web/src/element.js';
import { createClient } from '../../../../../packages/web/src/client.js';
import { boot } from '../../../../../packages/web/src/loader.js';

export const STUB_PROTOCOL = 'ss-element-stub@2';
/** Stub protocols this runtime runs (v2 is a superset of v1). */
export const STUB_PROTOCOLS = Object.freeze(['ss-element-stub@1', STUB_PROTOCOL]);
const ACTION = /^[a-z][a-z0-9_]{0,39}$/;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const FIELD_TYPES = Object.freeze(['text', 'email', 'tel', 'number', 'textarea', 'select', 'checkbox']);
const MAX_ITEMS = 50;
const MAX_ACTIONS = 10;
const MAX_FIELDS = 20;
const MAX_OPTIONS = 50;

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
 * Page context of a stub element: the path, and the item id / page type of the element's surroundings.
 * @param {any} win
 * @param {string} key
 * @param {Record<string, any> | undefined} placement
 * @returns {{ path: string, itemId?: string, pageType?: string }}
 */
export const pageContext = (win, key, placement) => {
	const doc = win?.document;
	const path = text(win?.location?.pathname ?? '/', 512) || '/';
	/** @param {string} name @returns {string | undefined} */
	const lookup = (name) => {
		/** @type {any[]} */
		const nodes = [];
		try {
			const container = doc?.querySelector?.(`[data-ss-element="${key}"]`);
			const near = container?.closest?.(`[${name}]`);
			if (near) nodes.push(near);
			for (const entry of Array.isArray(placement?.selectors) ? placement.selectors : []) {
				const target = typeof entry?.selector === 'string' ? doc?.querySelector?.(entry.selector) : null;
				if (target) nodes.push(target.closest?.(`[${name}]`) ?? target);
			}
		} catch {
			/* an invalid selector never breaks the element */
		}
		nodes.push(doc?.documentElement);
		for (const node of nodes) {
			const value = node?.getAttribute?.(name);
			if (typeof value === 'string' && value !== '') return value;
		}
		const meta = doc?.querySelector?.(`meta[name="ss:${name.slice('data-ss-'.length)}"]`)?.getAttribute?.('content');
		return typeof meta === 'string' && meta !== '' ? meta : undefined;
	};
	const itemId = lookup('data-ss-item-id');
	const pageType = lookup('data-ss-page-type');
	return {
		path,
		...(itemId ? { itemId: text(itemId, 128) } : {}),
		...(pageType ? { pageType: text(pageType, 40) } : {}),
	};
};

/**
 * The input fields of a view model (`fields`, ≤ 20; unknown types and names are dropped).
 * @param {unknown} value
 * @returns {Array<{ name: string, type: string, label: string, required: boolean, options: Array<{ value: string, label: string }> }>}
 */
export const viewFields = (value) =>
	(Array.isArray(value) ? value : [])
		.filter((f) => isObject(f) && typeof f.name === 'string' && FIELD_NAME.test(f.name) && FIELD_TYPES.includes(f.type))
		.slice(0, MAX_FIELDS)
		.map((/** @type {any} */ f) => ({
			name: f.name,
			type: f.type,
			label: text(f.label, 200) || f.name,
			required: f.required === true,
			options:
				f.type === 'select' && Array.isArray(f.options)
					? f.options
							.filter(
								(/** @type {unknown} */ o) => isObject(o) && (typeof o.value === 'string' || typeof o.value === 'number'),
							)
							.slice(0, MAX_OPTIONS)
							.map((/** @type {any} */ o) => ({
								value: text(o.value, 200),
								label: text(o.label, 200) || text(o.value, 200),
							}))
					: [],
		}));

/**
 * Headless core of the element stub (service products).
 * @param {string} key
 * @param {{ context?: () => Record<string, unknown> }} [options] page context sent as `?ctx=` (v2)
 */
export const stubDefinition = (key, options = {}) => ({
	key,
	initialState: { status: 'idle', view: null, error: null },
	create: (/** @type {any} */ { store, client, emit }) => {
		const base = `/v1/elements/${key}`;
		/** @returns {{ query?: Record<string, string> }} */
		const query = () => {
			if (!options.context) return {};
			try {
				return { query: { ctx: JSON.stringify(options.context()) } };
			} catch {
				return {};
			}
		};
		/** @param {any} result */
		const apply = (result) => {
			if (result.ok) store.setState({ status: 'ready', view: isObject(result.value) ? result.value : null, error: null });
			else store.setState({ status: 'error', error: result.error.code });
			return result;
		};
		const load = async () => {
			if (!client) return apply(err(problem('invalid_request', { detail: 'no element API' })));
			store.setState({ status: 'loading' });
			return apply(await client.get(`${base}/view`, query()));
		};
		void load();
		return {
			actions: {
				refresh: load,
				invoke: async (/** @type {unknown} */ action, /** @type {unknown} */ input = {}) => {
					if (typeof action !== 'string' || !ACTION.test(action) || !client)
						return err(problem('invalid_request', { detail: 'unknown action' }));
					const result = apply(await client.post(`${base}/actions/${action}`, isObject(input) ? input : {}, query()));
					if (result.ok) emit('action', { action });
					return result;
				},
			},
		};
	},
});

/** @type {WeakMap<object, { view: unknown, inputs: Map<string, any> }>} rendered node → its view and inputs */
const rendered = new WeakMap();

/**
 * One input of a view model's `fields`.
 * @param {any} h
 * @param {string} id
 * @param {ReturnType<typeof viewFields>[number]} field
 * @param {Map<string, any>} inputs
 */
const fieldNode = (h, id, field, inputs) => {
	const ref = (/** @type {any} */ el) => inputs.set(field.name, el);
	const common = { id, name: field.name, required: field.required, ref, className: 'ss-el__input' };
	const control =
		field.type === 'textarea'
			? h('textarea', { ...common, rows: 3 })
			: field.type === 'select'
				? h(
						'select',
						common,
						...field.options.map((/** @type {{ value: string, label: string }} */ o) =>
							h('option', { value: o.value }, o.label),
						),
					)
				: h('input', { ...common, type: field.type });
	return field.type === 'checkbox'
		? h('label', { className: 'ss-el__field ss-el__field--checkbox', htmlFor: id }, control, field.label)
		: h('div', { className: 'ss-el__field' }, h('label', { htmlFor: id }, field.label), control);
};

/**
 * Values of the rendered inputs (`checkbox` → boolean, `number` → number or null, else text).
 * @param {Map<string, any>} inputs
 * @param {ReturnType<typeof viewFields>} fields
 */
const fieldValues = (inputs, fields) => {
	/** @type {Record<string, unknown>} */
	const out = {};
	for (const field of fields) {
		const el = inputs.get(field.name);
		if (!el) continue;
		if (field.type === 'checkbox') out[field.name] = el.checked === true;
		else if (field.type === 'number') out[field.name] = el.value === '' ? null : Number(el.value);
		else out[field.name] = text(el.value, 5000);
	}
	return out;
};

/** Default renderer of the element stub: the view model as text, links, inputs and buttons (the Loader's safe `h`). */
export const stubRenderer = Object.freeze({
	render: (/** @type {any} */ { state, actions, h, element }) => {
		const view = isObject(state.view) ? state.view : {};
		const items = Array.isArray(view.items) ? view.items.filter(isObject).slice(0, MAX_ITEMS) : [];
		const fields = viewFields(view.fields);
		/** @type {Map<string, any>} */
		const inputs = new Map();
		/** @type {any[]} */
		const buttons = Array.isArray(view.actions)
			? view.actions
					.filter((/** @type {unknown} */ a) => isObject(a) && typeof a.action === 'string' && ACTION.test(a.action))
					.slice(0, MAX_ACTIONS)
			: [];
		/** @param {string} action */
		const invoke = (action) => {
			if (fields.length === 0) return actions.invoke(action);
			const missing = fields.find((f) => f.required && inputs.get(f.name)?.checkValidity?.() === false);
			if (missing) {
				inputs.get(missing.name)?.reportValidity?.();
				return undefined;
			}
			return actions.invoke(action, { fields: fieldValues(inputs, fields) });
		};
		const node = h(
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
			fields.length > 0
				? h(
						'div',
						{ className: 'ss-el__fields', role: 'group' },
						...fields.map((field) => fieldNode(h, `ss-${element.key}-${field.name}`, field, inputs)),
					)
				: null,
			...buttons.map((/** @type {any} */ b) =>
				h('button', { type: 'button', className: 'ss-el__action', onClick: () => invoke(b.action) }, text(b.label, 80)),
			),
		);
		rendered.set(node, { view: state.view, inputs });
		return node;
	},
	/**
	 * Keep the node (and what the visitor typed) while only the status changes; render anew for a new view model.
	 * @param {any} node
	 * @param {any} props
	 */
	update: (node, props) => {
		const previous = rendered.get(node);
		if (!previous || previous.view !== props.state.view) return stubRenderer.render(props);
		node.setAttribute('aria-busy', props.state.status === 'loading' ? 'true' : 'false');
		node.setAttribute('data-ss-status', props.state.status);
		return node;
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
 * @property {string} [stub] `ss-element-stub@2` (or `@1`) for service-product elements without a UI bundle
 * @property {string} [api] the service product's API base (stub and service UI-bundle modules)
 * @property {Record<string, unknown>} [reserve]
 */

/**
 * @typedef {object} CompiledData
 * @property {string} websiteId
 * @property {'live' | 'test'} env
 * @property {string} version
 * @property {string} key the website's public `pk_` key (events, element APIs)
 * @property {string} events events ingest URL
 * @property {string} assets base URL of element modules (ends with `/`; paths start with `packs/` or `ui/`)
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
		if (typeof spec.stub === 'string' && STUB_PROTOCOLS.includes(spec.stub))
			return {
				...common,
				headless: stubDefinition(
					spec.key,
					spec.stub === STUB_PROTOCOL ? { context: () => pageContext(win, spec.key, spec.placement) } : {},
				),
				renderer: stubRenderer,
				api: { baseUrl: String(spec.api) },
			};
		const headless = /** @type {{ path: string, name: string }} */ (spec.headless);
		const renderer = spec.renderer;
		return {
			...common,
			...(typeof spec.api === 'string' ? { api: { baseUrl: spec.api } } : {}),
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
