/**
 * Tier filters on listings (pure): which tier options to show (counts, hide-empty, a rules@1 visibility condition,
 * an option cap), parsing the selection from a query value, and ordering items by tier.
 * @module
 */
import { matches } from './rules.js';
import { tierView } from './tiers.js';

/**
 * Filter options.
 * @param {{ tiers: ReadonlyArray<import('./tiers.js').Tier>, counts: ReadonlyMap<string, number>, config: Record<string, any>,
 *   collection: string | null, badgeStyle: string, now: number, timeZone: string }} input
 */
export const filterOptions = ({ tiers, counts, config, collection, badgeStyle, now, timeZone }) =>
	tiers
		.filter((tier) => tier.active)
		.map((tier) => ({ tier, count: counts.get(tier.key) ?? 0 }))
		.filter(({ count }) => !(config.hide_empty === true && count === 0))
		.filter(({ tier, count }) =>
			matches(
				config.visible_when,
				{ tier: { key: tier.key, label: tier.label, order: tier.order, count }, collection },
				{ now, timeZone },
			),
		)
		.slice(0, Number.isInteger(config.max_options) ? config.max_options : 20)
		.map(({ tier, count }) => ({ ...tierView(tier, badgeStyle), count: config.show_counts === false ? null : count }));

/**
 * The selected tier keys of a query value (`a,b`): known active tiers only, best first; a single tier when
 * multi-select is off. Null when the value is malformed.
 * @param {unknown} value
 * @param {ReadonlyMap<string, import('./tiers.js').Tier>} index
 * @param {{ multi: boolean }} options
 * @returns {string[] | null}
 */
export const parseSelection = (value, index, { multi }) => {
	if (value === undefined || value === '') return [];
	if (typeof value !== 'string' || value.length > 1000) return null;
	const keys = [...new Set(value.split(',').map((part) => part.trim()))];
	if (keys.length > 20 || keys.some((key) => !index.get(key)?.active)) return null;
	const sorted = keys.sort(
		(a, b) => /** @type {import('./tiers.js').Tier} */ (index.get(a)).rank - /** @type {any} */ (index.get(b)).rank,
	);
	return multi ? sorted : sorted.slice(0, 1);
};

/**
 * Items ordered by their best tier (`tier_order`), worst tier (`tier_order_desc`) or as given (`none`); items
 * without a tier go last, ties keep the given order.
 * @param {string[]} itemIds
 * @param {ReadonlyMap<string, string[]>} tiersByItem best first
 * @param {ReadonlyMap<string, import('./tiers.js').Tier>} index
 * @param {'tier_order' | 'tier_order_desc' | 'none'} direction
 */
export const sortByTier = (itemIds, tiersByItem, index, direction) => {
	if (direction === 'none') return [...itemIds];
	const rankOf = (/** @type {string} */ itemId) => {
		const keys = tiersByItem.get(itemId) ?? [];
		const key = direction === 'tier_order' ? keys[0] : keys.at(-1);
		const tier = key === undefined ? undefined : index.get(key);
		return tier === undefined ? Number.POSITIVE_INFINITY : direction === 'tier_order' ? tier.rank : -tier.rank;
	};
	return itemIds
		.map((itemId, position) => ({ itemId, position, rank: rankOf(itemId) }))
		.sort((a, b) => (a.rank === b.rank ? a.position - b.position : a.rank < b.rank ? -1 : 1))
		.map((entry) => entry.itemId);
};
