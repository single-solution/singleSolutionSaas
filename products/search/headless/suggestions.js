/**
 * Mode B headless core of the `suggestions` element: popular searches, completions of the word being typed and
 * recently updated documents from `GET /v1/suggestions`, plus the visitor's own recent searches, which are kept only
 * in the visitor's browser (an injected key-value storage) and never sent anywhere. Framework-agnostic and DOM-free;
 * the overlay builds on it, and a merchant's own UI can too.
 */
import { createTranslator } from './strings.js';
import { createStore, done, refused, safeStorage } from './store.js';

/** Storage key of the visitor's recent searches. */
export const HISTORY_KEY = 'ss-search-history';

/**
 * @typedef {object} SuggestionsState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {string} query
 * @property {ReadonlyArray<{ text: string }>} popular
 * @property {ReadonlyArray<{ text: string }>} completions
 * @property {ReadonlyArray<{ id: string, type: string, title: string, url: string | null }>} recent
 * @property {ReadonlyArray<string>} history the visitor's own recent searches (newest first)
 */

/**
 * @param {unknown} value
 * @returns {Array<{ text: string }>}
 */
const texts = (value) =>
	(Array.isArray(value) ? value : [])
		.filter((entry) => typeof entry?.text === 'string')
		.slice(0, 20)
		.map((entry) => ({ text: String(entry.text).slice(0, 100) }));

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').SearchClient,
 *   storage?: import('./store.js').KeyValueStorage | null, emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createSuggestions = ({ config = {}, strings = {}, client, storage = null, emit = () => {} }) => {
	const t = createTranslator(strings);
	const keep = Number.isInteger(config.history_size) ? Math.max(0, Math.min(20, config.history_size)) : 5;
	let store$ = safeStorage(storage);
	/** @returns {string[]} */
	const readHistory = () => {
		if (keep === 0) return [];
		try {
			const parsed = JSON.parse(store$.get(HISTORY_KEY) ?? '[]');
			return Array.isArray(parsed) ? parsed.filter((q) => typeof q === 'string' && q.length <= 100).slice(0, keep) : [];
		} catch {
			return [];
		}
	};
	const store = createStore(
		/** @type {SuggestionsState} */ ({
			status: 'idle',
			query: '',
			popular: [],
			completions: [],
			recent: [],
			history: readHistory(),
		}),
	);
	let run = 0;

	const actions = {
		/**
		 * Load suggestions for an empty or partial query.
		 * @param {string} [query]
		 * @param {{ types?: readonly string[] }} [options]
		 */
		load: async (query = '', { types = [] } = {}) => {
			if (store.isDestroyed()) return refused('destroyed');
			const q = String(query).slice(0, 100);
			const id = (run += 1);
			store.set({ status: 'loading', query: q });
			const result = await client.get('/v1/suggestions', {
				query: { q: q === '' ? undefined : q, types: types.length > 0 ? types.join(',') : undefined },
			});
			if (id !== run) return refused('superseded');
			if (!result.ok) {
				store.set({ status: 'error' });
				return result;
			}
			const value = result.value ?? {};
			store.set({
				status: 'ready',
				popular: texts(value.popular),
				completions: texts(value.completions),
				recent: (Array.isArray(value.recent) ? value.recent : [])
					.filter((/** @type {any} */ entry) => typeof entry?.id === 'string')
					.slice(0, 20)
					.map((/** @type {any} */ entry) => ({
						id: entry.id,
						type: String(entry.type ?? ''),
						title: String(entry.title ?? '').slice(0, 300),
						url: typeof entry.url === 'string' ? entry.url : null,
					})),
			});
			return done(store.get());
		},
		/** Remember a search in the visitor's browser (newest first, no duplicates). @param {string} query */
		remember: async (query) => {
			const q = String(query).trim().slice(0, 100);
			if (keep === 0 || q === '') return done(store.get().history);
			const history = [q, ...store.get().history.filter((entry) => entry !== q)].slice(0, keep);
			store$.set(HISTORY_KEY, JSON.stringify(history));
			store.set({ history });
			return done(history);
		},
		/**
		 * Use the visitor's browser storage for recent searches (the renderer passes a `localStorage` wrapper).
		 * @param {import('./store.js').KeyValueStorage | null} next
		 */
		attachStorage: async (next) => {
			store$ = safeStorage(next);
			store.set({ history: readHistory() });
			return done(store.get().history);
		},
		/** Forget the visitor's recent searches. */
		forget: async () => {
			store$.set(HISTORY_KEY, '[]');
			store.set({ history: [] });
			emit('history_cleared', {});
			return done([]);
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
		destroy: store.destroy,
	});
};
