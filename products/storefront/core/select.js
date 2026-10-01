/**
 * Picking a few items for a section (`cards`, `trending_band`): by collection, by a source rule (featured flag,
 * trending rank, newest, a manual list) and a count.
 */
import { comparator, valuesOf } from './query.js';

/** Source rules of the trending band. */
export const STRATEGIES = Object.freeze(/** @type {const} */ (['featured', 'rank', 'newest', 'manual', 'source']));

/**
 * @param {readonly import('./items.js').Item[]} items
 * @param {{ strategy?: typeof STRATEGIES[number], collection?: string, ids?: readonly string[], attribute?: string,
 *   count: number, sort?: import('./query.js').Sort, locale?: string }} rule
 * @returns {import('./items.js').Item[]}
 */
export const pickItems = (
	items,
	{ strategy = 'source', collection = '', ids = [], attribute = 'featured', count, sort = 'relevance', locale },
) => {
	let pool = collection ? items.filter((item) => item.collections.includes(collection)) : [...items];
	if (strategy === 'manual') {
		const byId = new Map(pool.map((item) => [item.id, item]));
		return ids.flatMap((id) => byId.get(id) ?? []).slice(0, count);
	}
	if (strategy === 'featured')
		pool = pool.filter(
			(item) => item.badges.includes(attribute) || ['true', '1', 'yes'].includes(valuesOf(item, attribute)[0] ?? ''),
		);
	if (strategy === 'rank')
		pool = pool.filter((item) => item.rank !== null).sort((a, b) => Number(b.rank) - Number(a.rank) || a.order - b.order);
	else pool.sort(comparator(strategy === 'newest' ? 'newest' : sort, locale));
	return pool.slice(0, count);
};
