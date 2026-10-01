/**
 * Mode B headless core of the `url_sync` element: reads a selection from the page's query string and writes it back
 * (other parameters kept), with the merchant's parameter names, prefix, separator, default handling, history mode and
 * canonical rule — the same pure code as `POST /v1/url-params:*`. The page is reached only through the injected `url`
 * port, never `location` or `history` directly. DOM-free; the element shape of Part E §4.
 */
import { canonicalSearch, decodeSelection, mergeSearch, urlOptionsFrom } from '../core/urlSync.js';
import { createTranslator } from './strings.js';

/** @typedef {import('../core/urlSync.js').UrlGroup} UrlGroup */
/** @typedef {{ read: () => string, write: (search: string, mode: 'replace' | 'push') => void }} UrlPort */
/** @typedef {{ status: 'ready', selection: Record<string, unknown>, search: string, canonical: string }} UrlState */

/**
 * @param {{ config?: Record<string, unknown>, strings?: Record<string, string>, groups: ReadonlyArray<UrlGroup>, url: UrlPort,
 *   emit?: (name: string, data: Record<string, unknown>) => void }} options
 *   `config` = the url_sync feature values; `groups` = the configurator's groups (public view)
 */
export const createUrlSync = ({ config = {}, strings = {}, groups, url, emit = () => {} }) => {
	const t = createTranslator(strings);
	const options = urlOptionsFrom(config);
	/** @type {Set<(state: UrlState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	const initial = url.read();
	/** @type {UrlState} */
	let state = Object.freeze({
		status: 'ready',
		selection: decodeSelection(groups, initial, options),
		search: initial,
		canonical: '',
	});
	/** @param {Partial<UrlState>} patch */
	const set = (patch) => {
		if (destroyed) return;
		state = Object.freeze({ ...state, ...patch });
		for (const listener of listeners) listener(state);
	};

	const actions = Object.freeze({
		/** Re-read the page's query string (e.g. after back / forward). */
		read: async () => {
			const search = url.read();
			const selection = decodeSelection(groups, search, options);
			set({ search, selection });
			return { ok: /** @type {const} */ (true), value: selection };
		},
		/**
		 * Write a selection into the query string.
		 * @param {Record<string, unknown>} selection
		 */
		write: async (selection) => {
			const search = mergeSearch(url.read(), groups, selection, options);
			url.write(search, options.history);
			set({ search, selection, canonical: canonicalSearch(groups, selection, options) });
			emit('url_sync.written', { params: search.length > 0 });
			return { ok: /** @type {const} */ (true), value: search };
		},
	});

	return Object.freeze({
		/** @returns {UrlState} */
		state: () => state,
		actions,
		/** @param {(state: UrlState) => void} listener */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		/**
		 * @param {unknown} input a selection object
		 * @returns {Array<{ path: string, code: string, message: string }>}
		 */
		validate: (input) =>
			input !== null && typeof input === 'object' && !Array.isArray(input)
				? Object.keys(input)
						.filter((key) => !groups.some((group) => group.key === key))
						.map((key) => ({ path: `/${key}`, code: 'unknown_group', message: t('widget.error.invalid') }))
				: [{ path: '', code: 'type', message: t('widget.error.invalid') }],
		strings,
		destroy: () => {
			destroyed = true;
			listeners.clear();
		},
	});
};
