/**
 * Counts (PLAN 0.8.10 K4). Every list route `GET /v1/<list>` gains `GET /v1/<list>/count` with the same filters →
 * `{ count, capped }` (exact up to 100,000), and `GET /v1/<list>/counts?by=<field>` → `{ total, groups: { <value>: <n> } }`
 * for the fields the product names (the 50 largest groups). Ticket twins sit under `/v1/admin/`. Each count has the same
 * feature and permission as its list and at most 3 seconds, else 503 `count_timeout`.
 *
 * The product writes the two routes as literal `defineRoute` calls (so `openapi.json` documents them) with the
 * handlers `countHandlers` makes from the list's own filter:
 *
 *   const orderCounts = countHandlers({
 *     source: async (ctx) => ({ collection: (await ctx.data()).collection('orders'), filter: orderFilter(ctx) }),
 *     by: { status: 'status', paymentMethod: 'payment.method' },
 *   });
 *   defineRoute({ method: 'GET', path: '/v1/orders/count', auth: 'server', feature: 'checkout', handler: orderCounts.count })
 * @module
 */
import { problem } from './http/results.js';
import { isObject } from './util.js';

/** Counts are exact up to this many records. */
export const COUNT_CAP = 100_000;
/** At most this many groups are answered (the largest first). */
export const MAX_GROUPS = 50;
/** Longest time one count may take, in ms. */
export const COUNT_TIMEOUT_MS = 3_000;

/**
 * A field a list may be counted by: the record's path, or a path and a mapping of its stored value to the answered
 * group (for example a status key to its role, or a number to `true` / `false`).
 * @typedef {string | { path: string, map: (value: unknown, ctx: any) => string | null }} CountField
 */

/**
 * @typedef {object} CountSource
 * @property {{ countDocuments: Function, aggregate: Function }} collection the guarded merchant database collection
 * @property {Record<string, unknown>} filter the list's filter (it pins `websiteId`)
 */

/** @param {unknown} error */
const timedOut = (error) =>
	isObject(error) && (error.code === 50 || error.codeName === 'MaxTimeMSExpired' || error.name === 'MongoOperationTimeoutError');

/** A group key as JSON text: missing values are `none`. @param {unknown} value */
const keyOf = (value) => (value === null || value === undefined || value === '' ? 'none' : String(value));

/**
 * Run a count and turn a timeout into 503 `count_timeout`.
 * @template T
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
const bounded = async (run) => {
	try {
		return await run();
	} catch (error) {
		if (timedOut(error)) throw problem('count_timeout', `Counting took longer than ${COUNT_TIMEOUT_MS / 1000} seconds.`);
		throw error;
	}
};

/**
 * The `count` and `counts` handlers of one list.
 * @param {{ source: (ctx: any) => Promise<CountSource>, by?: Record<string, CountField> }} options `source` builds the
 *   list's filter from the request (throw a problem for invalid filters, as the list does); `by` names the fields
 * @returns {{ count: (ctx: any) => Promise<{ count: number, capped: boolean }>,
 *   counts: (ctx: any) => Promise<{ total: number, groups: Record<string, number> }> }}
 */
export const countHandlers = ({ source, by = {} }) => {
	const fields = Object.keys(by);
	return Object.freeze({
		count: async (ctx) => {
			const { collection, filter } = await source(ctx);
			const n = await bounded(() => collection.countDocuments(filter, { limit: COUNT_CAP + 1, maxTimeMS: COUNT_TIMEOUT_MS }));
			return { count: Math.min(n, COUNT_CAP), capped: n > COUNT_CAP };
		},
		counts: async (ctx) => {
			const name = String(ctx.query.by ?? '');
			const field = Object.hasOwn(by, name) ? by[name] : undefined;
			if (field === undefined)
				throw problem(
					'validation_failed',
					fields.length > 0 ? `by is one of: ${fields.join(', ')}.` : 'This list has no fields to count by.',
					{ errors: [{ path: '/by', message: `by is one of: ${fields.join(', ')}` }] },
				);
			const path = typeof field === 'string' ? field : field.path;
			const map = typeof field === 'string' ? (/** @type {unknown} */ value) => keyOf(value) : field.map;
			const { collection, filter } = await source(ctx);
			const rows = await bounded(() =>
				collection
					.aggregate([{ $match: filter }, { $group: { _id: `$${path}`, n: { $sum: 1 } } }, { $sort: { n: -1, _id: 1 } }], {
						maxTimeMS: COUNT_TIMEOUT_MS,
					})
					.toArray(),
			);
			/** @type {Map<string, number>} */
			const merged = new Map();
			let total = 0;
			for (const row of /** @type {Array<{ _id: unknown, n: number }>} */ (rows)) {
				total += row.n;
				const key = keyOf(map(row._id, ctx));
				merged.set(key, (merged.get(key) ?? 0) + row.n);
			}
			const groups = Object.fromEntries(
				[...merged.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_GROUPS),
			);
			return { total, groups };
		},
	});
};
