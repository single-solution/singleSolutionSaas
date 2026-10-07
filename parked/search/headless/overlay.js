/**
 * Mode B headless core of the `overlay` element: a search box with instant results, built for an ARIA combobox.
 * Typing is debounced (`debounce_ms`, timers injected), queries shorter than `min_chars` show suggestions instead
 * (the `suggestions` core: popular, completions, recent documents and the visitor's own history), arrow keys move
 * the active option across results or suggestions (wrapping; -1 = the input), Enter opens the active option or the
 * website's results page. A superseded response never overwrites a newer one. `client` is the Mode C client with
 * the website's `pk_` key. The default renderer (ui/overlay.js) and any merchant-built UI use exactly this core.
 */
import { createTranslator } from './strings.js';
import { createStore, done, refused } from './store.js';
import { createSuggestions } from './suggestions.js';

/**
 * @typedef {object} Option one entry of the listbox
 * @property {string} key stable id (`r:<id>`, `c:<text>`, `h:<text>`, `p:<text>`, `d:<id>`)
 * @property {'result' | 'completion' | 'history' | 'popular' | 'recent'} kind
 * @property {string} label
 * @property {string | null} detail description or price
 * @property {string | null} image
 * @property {string | null} href a link (results, recent documents)
 * @property {string | null} query a query to run (completions, history, popular)
 */
/**
 * @typedef {object} OverlayState
 * @property {boolean} open
 * @property {string} q
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {ReadonlyArray<Option>} options
 * @property {number} active
 * @property {number} total
 * @property {string} href the results page for the current query
 * @property {string | null} message announced politely (count, empty, error)
 * @property {string} hotkey
 * @property {boolean} showImages
 */

/**
 * Money text of integer minor units with `Intl` (nothing without a currency: guessing digits would print a wrong price).
 * @param {unknown} amount
 * @param {unknown} currency
 * @param {string} locale
 */
export const priceText = (amount, currency, locale) => {
	if (!Number.isSafeInteger(amount) || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null;
	try {
		const format = new Intl.NumberFormat(locale || 'en', { style: 'currency', currency });
		const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
		return format.format(/** @type {number} */ (amount) / 10 ** digits);
	} catch {
		return null;
	}
};

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').SearchClient,
 *   storage?: import('./store.js').KeyValueStorage | null, emit?: (name: string, data: Record<string, unknown>) => void,
 *   schedule?: (fn: () => void, ms: number) => () => void, locale?: string }} options
 */
export const createOverlay = ({
	config = {},
	strings = {},
	client,
	storage = null,
	emit = () => {},
	schedule = (fn, ms) => {
		const timer = setTimeout(fn, ms);
		return () => clearTimeout(timer);
	},
	locale = '',
}) => {
	const t = createTranslator(strings);
	const int = (/** @type {unknown} */ v, /** @type {number} */ d, /** @type {number} */ min, /** @type {number} */ max) =>
		Number.isInteger(v) ? Math.max(min, Math.min(max, Number(v))) : d;
	const debounce = int(config.debounce_ms, 250, 0, 1500);
	const minChars = int(config.min_chars, 2, 1, 10);
	const maxResults = int(config.max_results, 8, 1, 20);
	const types = Array.isArray(config.types) ? config.types.filter((x) => typeof x === 'string').slice(0, 20) : [];
	const resultsPath =
		typeof config.results_path === 'string' && /^\/[^\s]*$/.test(config.results_path) ? config.results_path : '/search';
	const param =
		typeof config.query_param === 'string' && /^[a-z][a-z0-9_]{0,15}$/.test(config.query_param) ? config.query_param : 'q';
	const withSuggestions = config.show_suggestions !== false;
	const suggestions = createSuggestions({ config, strings, client, storage, emit });
	/** @param {string} q */
	const hrefOf = (q) =>
		q.trim() === ''
			? resultsPath
			: `${resultsPath}${resultsPath.includes('?') ? '&' : '?'}${new URLSearchParams({ [param]: q.trim() })}`;
	/** @type {ReadonlyArray<Option>} */
	let results = [];
	const store = createStore(
		/** @type {OverlayState} */ ({
			open: false,
			q: '',
			status: 'idle',
			options: [],
			active: -1,
			total: 0,
			href: resultsPath,
			message: null,
			hotkey: ['/', 'mod+k', 'none'].includes(config.hotkey) ? config.hotkey : '/',
			showImages: config.show_images !== false,
		}),
	);
	let run = 0;
	/** @type {(() => void) | null} */
	let pending = null;

	/** Suggestion options for the current (short) query. */
	const suggestionOptions = () => {
		if (!withSuggestions) return [];
		const s = suggestions.state();
		const q = store.get().q.trim().toLowerCase();
		/** @type {Option[]} */
		const out = [];
		/** @param {Option['kind']} kind @param {string} text */
		const query = (kind, text) => ({
			key: `${kind[0]}:${text}`,
			kind,
			label: text,
			detail: null,
			image: null,
			href: null,
			query: text,
		});
		for (const c of s.completions) out.push(query('completion', c.text));
		for (const h of s.history) if (q === '' || h.toLowerCase().startsWith(q)) out.push(query('history', h));
		for (const p of s.popular) out.push(query('popular', p.text));
		if (q === '')
			for (const d of s.recent)
				out.push({
					key: `d:${d.id}`,
					kind: 'recent',
					label: d.title || d.id,
					detail: null,
					image: null,
					href: d.url,
					query: null,
				});
		const seen = new Set();
		return out.filter((option) => (seen.has(option.key) ? false : (seen.add(option.key), true))).slice(0, 20);
	};

	const refresh = () => {
		const state = store.get();
		const options = state.q.trim().length >= minChars ? results : suggestionOptions();
		store.set({ options, active: Math.min(state.active, options.length - 1) });
	};
	suggestions.subscribe(() => refresh());

	/** @param {Record<string, any>} hit @returns {Option} */
	const resultOption = (hit) => ({
		key: `r:${hit.id}`,
		kind: 'result',
		label: String(hit.title || hit.id).slice(0, 300),
		detail: priceText(hit.price, hit.currency, locale) ?? (String(hit.description ?? '').slice(0, 160) || null),
		image: typeof hit.image === 'string' ? hit.image : null,
		href: typeof hit.url === 'string' ? hit.url : null,
		query: null,
	});

	/** Search now (cancels a pending debounced search). */
	const searchNow = async () => {
		pending?.();
		pending = null;
		const q = store.get().q.trim();
		if (q.length < minChars) return done([]);
		const id = (run += 1);
		store.set({ status: 'loading', message: t('overlay.loading') });
		const result = await client.get('/v1/search', {
			query: { q, limit: maxResults, types: types.length > 0 ? types.join(',') : undefined },
		});
		if (id !== run || store.isDestroyed()) return refused('superseded');
		if (!result.ok) {
			results = [];
			store.set({ status: 'error', options: [], active: -1, total: 0, message: t('overlay.error') });
			return result;
		}
		const items = Array.isArray(result.value?.items) ? result.value.items : [];
		results = items.slice(0, maxResults).map(resultOption);
		const total = Number.isInteger(result.value?.total) ? result.value.total : results.length;
		store.set({
			status: 'ready',
			options: results,
			active: -1,
			total,
			message: results.length === 0 ? t('overlay.empty') : t('overlay.count', { count: total }),
		});
		emit('searched', { results: total });
		return done(results);
	};

	/**
	 * The query changed (typing): debounced search, or suggestions for short queries.
	 * @param {string} text
	 */
	const setQuery = async (text) => {
		const q = String(text ?? '').slice(0, 100);
		pending?.();
		pending = null;
		const id = (run += 1);
		results = [];
		store.set({ q, href: hrefOf(q), active: -1 });
		if (q.trim().length < minChars) {
			store.set({ status: 'idle', total: 0, message: null });
			refresh();
			if (withSuggestions && q.trim() !== '') void suggestions.actions.load(q, { types });
			return done([]);
		}
		store.set({ status: 'loading', options: [] });
		const fired = await new Promise((resolve) => {
			const cancel = schedule(() => resolve(true), debounce);
			pending = () => {
				cancel();
				resolve(false);
			};
		});
		if (!fired || id !== run) return refused('superseded');
		pending = null;
		return searchNow();
	};

	/**
	 * Choose an option: a link to follow, or a query to run.
	 * @param {number} index
	 * @returns {Promise<import('./store.js').Result<{ href: string | null, query: string | null }>>}
	 */
	const choose = async (index) => {
		const option = store.get().options[index];
		if (!option) return refused('no_option');
		emit('selected', { kind: option.kind });
		if (option.kind === 'result') {
			void suggestions.actions.remember(store.get().q);
			if (client.post)
				void client.post('/v1/search-clicks', { q: store.get().q.trim(), id: option.key.slice(2) }).catch(() => undefined);
		}
		if (option.query !== null) {
			store.set({ q: option.query, href: hrefOf(option.query), active: -1 });
			await searchNow();
			return done({ href: null, query: option.query });
		}
		return done({ href: option.href, query: null });
	};

	const actions = {
		/** Load suggestions for the empty box. */
		start: async () => {
			if (withSuggestions) await suggestions.actions.load('', { types });
			refresh();
			return done(true);
		},
		open: async () => {
			store.set({ open: true });
			if (withSuggestions && suggestions.state().status === 'idle') void suggestions.actions.load('', { types });
			return done(true);
		},
		close: async () => {
			pending?.();
			pending = null;
			store.set({ open: false, active: -1 });
			emit('dismissed', {});
			return done(false);
		},
		setQuery,
		searchNow,
		/** Arrow keys: move the active option (wraps; -1 = the input). @param {number} delta */
		move: async (delta) => {
			const size = store.get().options.length + 1;
			if (size === 1) return done(-1);
			const next = ((store.get().active + 1 + Math.sign(delta) + size) % size) - 1;
			store.set({ active: next });
			return done(next);
		},
		/** Back to the input (Escape on an active option). */
		clearActive: async () => {
			store.set({ active: -1 });
			return done(-1);
		},
		/** Home / End inside the list. @param {'first' | 'last'} where */
		jump: async (where) => {
			const count = store.get().options.length;
			const next = count === 0 ? -1 : where === 'first' ? 0 : count - 1;
			store.set({ active: next });
			return done(next);
		},
		choose,
		/** Enter: the active option, else the results page with the query. */
		submit: async () => {
			const state = store.get();
			if (state.active >= 0) return choose(state.active);
			if (state.q.trim() === '') return refused('empty_query');
			void suggestions.actions.remember(state.q);
			emit('submitted', {});
			return done({ href: state.href, query: null });
		},
		/** @param {import('./store.js').KeyValueStorage | null} next */
		attachStorage: async (next) => {
			await suggestions.actions.attachStorage(next);
			refresh();
			return done(true);
		},
		forgetHistory: async () => {
			await suggestions.actions.forget();
			refresh();
			return done(true);
		},
	};

	return Object.freeze({
		state: () => store.get(),
		actions: Object.freeze(actions),
		subscribe: store.subscribe,
		/** @param {unknown} input */
		validate: (input) =>
			typeof input === 'string' && input.length > 100
				? [{ path: '/q', code: 'too_long', message: t('overlay.too_long') }]
				: [],
		strings,
		destroy: () => {
			pending?.();
			suggestions.destroy();
			store.destroy();
		},
	});
};
