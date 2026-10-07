/**
 * Shared Mode B machinery of the PDP elements: an immutable state store with subscribers, and the item source — the
 * page data the renderer (or the merchant's own code) reads, optionally overlaid with the merchant's public JSON
 * source. DOM-free: page reading and HTTP are injected as the `ItemSource` ports, so the same core runs in the Loader,
 * in a merchant's framework and in tests.
 * @module
 */
import { mapFields, mergeRaw, normaliseItem, validateItem } from '../core/item.js';
import { itemFromSnapshot } from '../core/snapshot.js';
import { fillUrl, isHttpsUrl, isObject, text } from '../core/util.js';
import { createTranslator } from './strings.js';

/** @typedef {import('../core/item.js').Item} Item */
/** @typedef {{ code: string, status?: number, detail?: string }} Problem */
/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, problem: Problem, error: Problem }} Result
 */
/**
 * Page context of an element (all optional).
 * @typedef {object} PageContext
 * @property {string} [path] location path
 * @property {string} [url] canonical page URL (absolute)
 * @property {string} [locale] page language (BCP 47)
 * @property {Record<string, string>} [params] route parameters
 * @property {boolean} [hasProductJsonLd] the page already carries Product structured data
 */
/**
 * Where an element's item comes from (all optional).
 * @typedef {object} ItemSource
 * @property {() => import('../core/snapshot.js').PageSnapshot} [page] snapshot of the page's item data (Mode A)
 * @property {() => unknown} [read] raw item data (Mode B: the merchant's code already has it)
 * @property {(url: string) => Promise<unknown>} [fetchJson] GET a public JSON document
 * @property {PageContext} [context] page context
 */
/**
 * Options every element factory receives (Part E §4).
 * @typedef {object} ElementOptions
 * @property {Record<string, unknown>} [config] feature values from the entitlement document
 * @property {Record<string, string>} [strings] resolved string catalog
 * @property {unknown} [client] Mode C client (unused: packs have no API)
 * @property {unknown} [identity]
 * @property {(name: string, data: Record<string, unknown>) => void} [emit] element UI events (`<key>.<verb>`)
 * @property {() => number} [now] clock (structured data validity)
 */

/**
 * @template T
 * @param {T} value
 * @returns {Result<T>}
 */
export const ok = (value) => ({ ok: true, value });

/**
 * A failed result, readable both as `problem` (Part E §4) and as `error` (the `@ss/web/element` Result the Loader
 * passes through unchanged).
 * @param {string} code
 * @returns {{ ok: false, problem: Problem, error: Problem }}
 */
export const fail = (code) => {
	const problem = Object.freeze({ code });
	return { ok: false, problem, error: problem };
};

/**
 * Immutable state store.
 * @template {Record<string, unknown>} S
 * @param {S} initial
 */
export const createStore = (initial) => {
	/** @type {Set<(state: S) => void>} */
	const listeners = new Set();
	let destroyed = false;
	let state = /** @type {S} */ (Object.freeze({ ...initial }));
	return {
		/** @returns {S} */
		get: () => state,
		/** @param {Partial<S>} patch */
		set: (patch) => {
			if (destroyed) return;
			state = /** @type {S} */ (Object.freeze({ ...state, ...patch }));
			for (const listener of [...listeners]) listener(state);
		},
		/**
		 * @param {(state: S) => void} listener
		 * @returns {() => void}
		 */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		destroyed: () => destroyed,
		destroy: () => {
			destroyed = true;
			listeners.clear();
		},
	};
};

/**
 * The JSON source settings of an element (`source_url` template, `source_fields` mapping).
 * @param {Record<string, unknown>} config
 * @returns {{ url: string, fields: Record<string, string> }}
 */
export const sourceSettings = (config) => {
	const url = text(config.source_url, 1000);
	/** @type {Record<string, string>} */
	const fields = {};
	if (isObject(config.source_fields))
		for (const [name, path] of Object.entries(config.source_fields)) {
			const value = text(path, 200);
			if (/^[A-Za-z0-9_$.-]*$/.test(value)) fields[name] = value;
		}
	return { url, fields };
};

/**
 * Read the item: page data, overlaid with the JSON source when one is configured (an https URL template with
 * `{id}`, `{path}` and route parameters). A failing source keeps the page data.
 * @param {ItemSource} source
 * @param {{ url: string, fields: Record<string, string> }} settings
 * @returns {Promise<{ item: Item, sourceFailed: boolean }>}
 */
export const readItem = async (source, settings) => {
	/** @type {Record<string, unknown>} */
	let raw = {};
	try {
		const page = source.page ? itemFromSnapshot(source.page()) : source.read?.();
		if (isObject(page)) raw = page;
	} catch {
		/* unreadable page data counts as none */
	}
	let sourceFailed = false;
	if (settings.url !== '' && source.fetchJson) {
		const url = fillUrl(settings.url, {
			...source.context?.params,
			id: raw.id,
			path: source.context?.path ?? '',
		});
		try {
			if (!isHttpsUrl(url)) throw new TypeError('source_url must be https');
			raw = mergeRaw(raw, mapFields(await source.fetchJson(url), settings.fields));
		} catch {
			sourceFailed = true;
		}
	}
	return { item: normaliseItem(raw), sourceFailed };
};

/**
 * @typedef {object} ItemState
 * @property {'idle' | 'loading' | 'ready' | 'empty'} status `empty`: no usable item on this page
 * @property {Item | null} item
 * @property {string} locale
 */

/**
 * The common item element: state with `status`/`item`/`locale` plus element fields, `load(source)` and
 * `setItem(raw)` actions, item validation with resolved messages, and the standard instance shape.
 * @template {Record<string, unknown>} X
 * @param {ElementOptions & { prefix: string, extra: X, usable?: (item: Item) => boolean,
 *   derive?: (item: Item | null, locale: string) => Partial<X> }} options
 */
export const createItemElement = ({ config = {}, strings = {}, emit = () => {}, prefix, extra, usable, derive }) => {
	const t = createTranslator(strings);
	const settings = sourceSettings(config);
	const store = createStore(/** @type {ItemState & X} */ ({ status: 'idle', item: null, locale: '', ...extra }));
	const fits = usable ?? ((/** @type {Item} */ item) => item.title !== '');

	/** @param {Item} item @param {string} [locale] */
	const apply = (item, locale = store.get().locale) => {
		const good = fits(item);
		store.set(
			/** @type {any} */ ({
				status: good ? 'ready' : 'empty',
				item: good ? item : null,
				locale,
				...(derive ? derive(good ? item : null, locale) : {}),
			}),
		);
	};

	/**
	 * @param {unknown} raw
	 * @returns {Array<{ path: string, code: string, message: string }>}
	 */
	const validate = (raw) =>
		validateItem(raw).map((problem) => ({
			...problem,
			message: t(`${prefix}.invalid`, { field: problem.path.slice(1) || 'item' }),
		}));

	const actions = {
		/**
		 * Read the item from the page and the JSON source.
		 * @param {ItemSource} [source]
		 * @returns {Promise<Result<Item | null>>}
		 */
		load: async (source = {}) => {
			store.set(/** @type {any} */ ({ status: 'loading' }));
			const { item, sourceFailed } = await readItem(source, settings);
			apply(item, text(source.context?.locale, 35));
			if (sourceFailed) emit('source_failed', {});
			return store.get().item ? ok(store.get().item) : fail(sourceFailed ? 'source_failed' : 'item_missing');
		},
		/**
		 * Use an item the merchant's code already has (Mode B).
		 * @param {unknown} raw
		 * @returns {Promise<Result<Item | null>>}
		 */
		setItem: async (raw) => {
			apply(normaliseItem(raw));
			return store.get().item ? ok(store.get().item) : fail('item_missing');
		},
	};

	return { store, t, settings, actions, validate, emit };
};

/**
 * The public instance shape (Part E §4) over a store.
 * @template S
 * @template {Record<string, (...args: any[]) => Promise<unknown>>} A
 * @param {{ store: { get: () => S, subscribe: (listener: (state: S) => void) => () => void, destroy: () => void },
 *   actions: A, validate: (input: unknown) => unknown[],
 *   strings: Record<string, string>, t: (key: string, params?: Record<string, string | number>) => string,
 *   onDestroy?: () => void }} parts
 */
export const instance = ({ store, actions, validate, strings, t, onDestroy }) =>
	Object.freeze({
		state: store.get,
		actions: Object.freeze(actions),
		subscribe: store.subscribe,
		validate,
		strings,
		t,
		destroy: () => {
			onDestroy?.();
			store.destroy();
		},
	});
