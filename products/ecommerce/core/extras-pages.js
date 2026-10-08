/**
 * Keyset pages for the shopper extras' lists (return claims, reviews): the filter that continues a list sorted by
 * several fields after the cursor key the kit's `paginate` decoded. No I/O.
 * @module
 */

/**
 * One sort field: its name, direction and whether its cursor value is a date (ISO text in the cursor).
 * @typedef {{ field: string, direction: 1 | -1, date?: boolean }} SortField
 */

/**
 * The MongoDB sort of a list of fields.
 * @param {SortField[]} fields
 * @returns {Record<string, 1 | -1>}
 */
export const sortOf = (fields) => Object.fromEntries(fields.map(({ field, direction }) => [field, direction]));

/**
 * The cursor key of a row: its values of the sort fields (dates as ISO text).
 * @param {SortField[]} fields
 * @param {Record<string, any>} row
 * @returns {Array<string | number>}
 */
export const keyOf = (fields, row) =>
	fields.map(({ field }) => {
		const value = row[field];
		return value instanceof Date ? value.toISOString() : value;
	});

/**
 * The filter of the rows after `after` (`{}` for the first page or a cursor of another shape).
 * @param {SortField[]} fields
 * @param {unknown} after
 * @returns {Record<string, unknown>}
 */
export const afterFilter = (fields, after) => {
	if (!Array.isArray(after) || after.length !== fields.length) return {};
	/** @type {unknown[]} */
	const values = [];
	for (const [index, { date }] of fields.entries()) {
		const raw = after[index];
		if (date) {
			const time = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
			if (Number.isNaN(time)) return {};
			values.push(new Date(time));
		} else {
			if (typeof raw !== 'string' && typeof raw !== 'number') return {};
			values.push(raw);
		}
	}
	const or = fields.map(({ field, direction }, index) => ({
		...Object.fromEntries(fields.slice(0, index).map((before, at) => [before.field, values[at]])),
		[field]: { [direction === 1 ? '$gt' : '$lt']: values[index] },
	}));
	return { $or: or };
};
