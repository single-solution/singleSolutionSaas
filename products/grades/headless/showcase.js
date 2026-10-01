/**
 * Mode B headless core of the `showcase` element: the explainer of every tier (or of one item's tiers) with copy,
 * bullets, media and the warranty period, plus the selected tier for single and tabbed layouts.
 */
import { isId, isKey } from '../core/text.js';
import { ID_PROBLEM, badgeOf, createStore, errorMessage } from './store.js';
import { createTranslator } from './strings.js';

/**
 * @typedef {object} ShowcaseEntry
 * @property {import('./store.js').Badge} tier
 * @property {string} headline
 * @property {string} body
 * @property {string[]} bullets
 * @property {string | null} video
 * @property {Array<{ url: string, alt: string }>} images
 * @property {string | null} warrantyText
 */

/**
 * @typedef {object} ShowcaseState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {'cards' | 'compare' | 'single'} layout
 * @property {ReadonlyArray<ShowcaseEntry>} entries
 * @property {string | null} selected tier key
 * @property {ShowcaseEntry | null} current the selected entry (first when none is selected)
 * @property {string | null} error
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').ElementClient,
 *   emit?: import('./store.js').Emit }} options
 */
export const createShowcase = ({ config = {}, strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	const layoutOf = (/** @type {unknown} */ value) =>
		value === 'compare' || value === 'single' ? value : /** @type {'cards'} */ ('cards');
	const store = createStore(
		/** @type {ShowcaseState} */ ({
			status: 'idle',
			layout: layoutOf(config.layout),
			entries: [],
			selected: null,
			current: null,
			error: null,
		}),
	);
	/** @param {ReadonlyArray<ShowcaseEntry>} entries @param {string | null} key */
	const pick = (entries, key) => entries.find((entry) => entry.tier.key === key) ?? entries[0] ?? null;

	/** @param {{ itemId?: unknown, tier?: unknown }} input */
	const validate = ({ itemId, tier }) => [
		...(itemId === undefined || itemId === null || isId(itemId)
			? []
			: [{ path: '/itemId', code: ID_PROBLEM, message: t('grades.error.id_invalid') }]),
		...(tier === undefined || tier === null || isKey(tier)
			? []
			: [{ path: '/tier', code: 'tier_invalid', message: t('grades.error.tier_invalid') }]),
	];

	/**
	 * @param {{ itemId?: string | null, tier?: string | null }} [input]
	 */
	const load = async ({ itemId = null, tier = null } = {}) => {
		const problems = validate({ itemId, tier });
		if (problems.length > 0) {
			store.set({ status: 'error', error: problems[0]?.message ?? null });
			return { ok: false, error: { code: 'validation_failed' } };
		}
		store.set({ status: 'loading', error: null });
		const result = await client.get('/v1/showcase', {
			query: { ...(itemId ? { itemId } : {}), ...(tier ? { tier } : {}) },
		});
		if (!result.ok) {
			store.set({ status: 'error', error: errorMessage(t, strings, 'showcase', result.error) });
			return result;
		}
		/** @type {ShowcaseEntry[]} */
		const entries = result.value.entries.map((/** @type {any} */ entry) => ({
			tier: badgeOf(entry.tier, t),
			headline: entry.headline,
			body: entry.body,
			bullets: entry.bullets ?? [],
			video: entry.video ?? null,
			images: entry.images ?? [],
			warrantyText: entry.warranty ? t('showcase.warranty', { period: entry.warranty.periodText }) : null,
		}));
		store.set({
			status: 'ready',
			layout: layoutOf(result.value.layout ?? config.layout),
			entries,
			selected: tier,
			current: pick(entries, tier),
		});
		return { ok: true, value: store.get() };
	};

	/** @param {string} key */
	const select = async (key) => {
		const entry = store.get().entries.find((row) => row.tier.key === key);
		if (!entry) return { ok: false, error: { code: 'not_found' } };
		store.set({ selected: key, current: entry });
		emit('showcase.tier_selected', { tier: key });
		return { ok: true, value: store.get() };
	};

	return {
		state: store.get,
		actions: { load, select },
		subscribe: store.subscribe,
		validate,
		strings,
		destroy: store.destroy,
	};
};
