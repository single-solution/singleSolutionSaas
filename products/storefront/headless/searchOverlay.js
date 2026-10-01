/**
 * Mode B core of `search_overlay`: an accessible search dialog with instant results. Results come from the Site
 * Search product (`GET /v1/search?q=`) or the Catalog (`GET /v1/items?q=`) with the website's `pk_` key, or from a
 * local source (JSON file, page data). Submitting goes to the website's own results page (`/search?q=…`).
 */
import { applyQuery, parseQuery } from '../core/query.js';
import { sourceConfig } from '../core/source.js';
import { bool, int, oneOf, safeUrl, str } from '../core/util.js';
import { createCore, emitter, fail, ok } from './kit.js';
import { createSource } from './source.js';

export const API_PATHS = Object.freeze(/** @type {const} */ (['/v1/search', '/v1/items']));

/** @param {import('./kit.js').Options} [options] */
export const createSearchOverlay = (options = {}) => {
	const config = options.config ?? {};
	const source = createSource(sourceConfig(config), options);
	const path = oneOf(config.api_path, API_PATHS, '/v1/search');
	const results = safeUrl(config.results_path) ?? '/search';
	const param = /^[a-z][a-z0-9_]{0,15}$/.test(str(config.param)) ? str(config.param) : 'q';
	const minChars = int(config.min_chars, 2, 1, 10);
	const max = int(config.max_results, 8, 1, 20);
	const emit = emitter(options.emit);
	/** @param {string} q */
	const href = (q) => `${results}${results.includes('?') ? '&' : '?'}${new URLSearchParams({ [param]: q })}`;
	const core = createCore(
		{
			open: false,
			q: '',
			status: /** @type {'idle' | 'loading' | 'ready' | 'error'} */ ('idle'),
			results: /** @type {import('../core/items.js').Item[]} */ ([]),
			active: -1,
			href: results,
			minChars,
			hotkey: bool(config.hotkey, true),
			locale: source.source.locale,
			pageId: source.source.pageId,
		},
		options,
	);
	let run = 0;

	return core.expose(
		{
			/** @param {{ data?: unknown }} [input] */
			start: async ({ data } = {}) => {
				if (data !== undefined) source.provide(data);
				return ok(true);
			},
			open: async () => {
				core.set({ open: true });
				return ok(true);
			},
			close: async () => {
				core.set({ open: false, active: -1 });
				return ok(false);
			},
			/** @param {string} text */
			setQuery: async (text) => {
				const q = String(text ?? '').slice(0, 100);
				const id = (run += 1);
				core.set({ q, href: q.trim() ? href(q.trim()) : results, active: -1 });
				if (q.trim().length < minChars) {
					core.set({ status: 'idle', results: [] });
					return ok([]);
				}
				core.set({ status: 'loading' });
				const found =
					source.source.kind === 'api'
						? await source.api(path, { q: q.trim(), limit: max }).then((r) => (r.ok ? ok(source.itemsOf(r.value)) : r))
						: await source
								.all()
								.then((r) =>
									r.ok ? ok(applyQuery(r.value, { ...parseQuery(''), q: q.trim() }, { size: max }).items) : r,
								);
				if (id !== run) return fail('superseded');
				if (!found.ok) {
					core.set({ status: 'error', results: [] });
					return found;
				}
				core.set({ status: 'ready', results: found.value.slice(0, max) });
				return ok(core.get().results);
			},
			/** Arrow keys: move the active result (wraps; -1 = the input). @param {number} delta */
			move: async (delta) => {
				const size = core.get().results.length + 1;
				if (size === 1) return ok(-1);
				const next = ((core.get().active + 1 + Math.sign(delta) + size) % size) - 1;
				core.set({ active: next });
				return ok(next);
			},
			/** Where Enter goes: the active result, else the results page. */
			submit: async () => {
				const state = core.get();
				const chosen = state.results[state.active]?.href ?? null;
				if (!chosen && state.q.trim() === '') return fail('empty_query');
				emit('action', { action: chosen ? 'result' : 'search' });
				return ok({ href: chosen ?? state.href });
			},
		},
		(input) =>
			typeof input === 'string' && input.length > 100
				? [{ path: '/q', code: 'too_long', message: core.t('search_overlay.too_long') }]
				: [],
	);
};
