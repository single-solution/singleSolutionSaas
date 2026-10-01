/**
 * Review list orders and keyset pagination (pure). Every order ends with `submittedAt` and `id` so pages are stable
 * and disjoint; a cursor is the sort values of the last item of the previous page.
 * @module
 */

/** Orders offered by the list (`display.sorts`). */
export const SORTS = Object.freeze(/** @type {const} */ (['newest', 'oldest', 'rating_high', 'rating_low']));

/** @typedef {(typeof SORTS)[number]} Sort */
/** @typedef {Array<[field: 'rating' | 'submittedAt' | 'id', direction: 1 | -1]>} SortSpec */

/**
 * Sort fields of an order.
 * @param {Sort} sort
 * @returns {SortSpec}
 */
export const sortSpec = (sort) => {
	switch (sort) {
		case 'oldest':
			return [
				['submittedAt', 1],
				['id', 1],
			];
		case 'rating_high':
			return [
				['rating', -1],
				['submittedAt', -1],
				['id', -1],
			];
		case 'rating_low':
			return [
				['rating', 1],
				['submittedAt', -1],
				['id', -1],
			];
		default:
			return [
				['submittedAt', -1],
				['id', -1],
			];
	}
};

/**
 * The cursor of an item for an order: its sort values joined with `|` (ISO times and ids never contain one).
 * @param {Record<string, unknown>} item
 * @param {SortSpec} spec
 * @returns {string}
 */
export const cursorOf = (item, spec) => spec.map(([field]) => String(item[field])).join('|');

/**
 * A filter selecting the items strictly after the cursor in the order (`$or` of prefixes), or null when the cursor
 * does not fit the order.
 * @param {SortSpec} spec
 * @param {unknown} cursor
 * @returns {Record<string, unknown> | null}
 */
export const afterFilter = (spec, cursor) => {
	if (typeof cursor !== 'string') return null;
	const parts = cursor.split('|');
	if (parts.length !== spec.length) return null;
	/** @type {unknown[]} */
	const values = [];
	for (const [index, [field]] of spec.entries()) {
		const part = /** @type {string} */ (parts[index]);
		if (field === 'rating') {
			if (!/^\d{1,2}$/.test(part)) return null;
			values.push(Number(part));
		} else if (part.length > 0 && part.length <= 64) values.push(part);
		else return null;
	}
	/** @type {Array<Record<string, unknown>>} */
	const branches = spec.map(([field, direction], index) => ({
		...Object.fromEntries(spec.slice(0, index).map(([prior], at) => [prior, values[at]])),
		[field]: { [direction === 1 ? '$gt' : '$lt']: values[index] },
	}));
	return { $or: branches };
};

/**
 * Pick a valid order (the default when the requested one is not offered).
 * @param {unknown} requested
 * @param {{ sorts: readonly string[], fallback: string }} options
 * @returns {Sort}
 */
export const pickSort = (requested, { sorts, fallback }) => {
	const offered = sorts.filter((sort) => /** @type {readonly string[]} */ (SORTS).includes(sort));
	if (typeof requested === 'string' && offered.includes(requested)) return /** @type {Sort} */ (requested);
	return /** @type {Sort} */ (offered.includes(fallback) ? fallback : (offered[0] ?? 'newest'));
};
