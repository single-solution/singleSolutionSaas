/**
 * Reports (PLAN 0.8.8: sales by product/category/brand/city, stock age, return rate, margin): the date range, the
 * aggregation pipelines over orders (each starts with a `$match` on the website; no `$lookup`) and the rows built from
 * their results. Money is minor units of the shop's currency; only orders in that currency and not cancelled count.
 * Days are business days: a `YYYY-MM-DD` day is that day in the business.json time zone (PLAN 0.8.10 K8). No I/O.
 * @module
 */
import { dayBounds } from './calendar.js';
import { DAY_MS } from './returns.js';

/** The longest range, in days. */
const MAX_RANGE_DAYS = 366;
/** The range when none is given, in days (up to now). */
const DEFAULT_RANGE_DAYS = 30;
/** Rows of a report, at most. */
export const MAX_ROWS = 500;
export const SALES_BY = Object.freeze(/** @type {const} */ (['product', 'category', 'brand', 'city']));

/** @typedef {(typeof SALES_BY)[number]} SalesBy */
/** @typedef {{ from: Date, to: Date }} Range `to` is exclusive */

/**
 * A date (`2026-10-01`, the start of that day in the business time zone; for `to`, the end of it) or an ISO-8601 time.
 * @param {unknown} value
 * @param {boolean} end
 * @param {string} timeZone
 * @returns {number | null}
 */
const timeOf = (value, end, timeZone) => {
	if (typeof value !== 'string') return null;
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		const day = dayBounds(value, timeZone);
		return day ? (end ? day.end : day.start) : null;
	}
	if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
	const time = Date.parse(value);
	return Number.isNaN(time) ? null : time;
};

/**
 * The range of `?from=&to=` (default: the last 30 days up to now).
 * @param {Record<string, unknown>} query
 * @param {number} now
 * @param {string} [timeZone] the business.json time zone (UTC when missing)
 * @returns {{ ok: true, range: Range } | { ok: false, field: string, message: string }}
 */
export const parseRange = (query, now, timeZone = 'UTC') => {
	const to = query.to === undefined || query.to === '' ? now : timeOf(query.to, true, timeZone);
	if (to === null) return { ok: false, field: 'to', message: 'to is a date (YYYY-MM-DD) or an ISO-8601 time.' };
	const from =
		query.from === undefined || query.from === '' ? to - DEFAULT_RANGE_DAYS * DAY_MS : timeOf(query.from, false, timeZone);
	if (from === null) return { ok: false, field: 'from', message: 'from is a date (YYYY-MM-DD) or an ISO-8601 time.' };
	if (from >= to) return { ok: false, field: 'from', message: 'from is before to.' };
	if (to - from > MAX_RANGE_DAYS * DAY_MS)
		return { ok: false, field: 'from', message: `A report covers at most ${MAX_RANGE_DAYS} days.` };
	return { ok: true, range: { from: new Date(from), to: new Date(to) } };
};

/**
 * The orders that count: placed in the range, not cancelled, in the shop's currency.
 * @param {string} websiteId
 * @param {Range} range
 * @param {string} currency
 */
const ordersMatch = (websiteId, range, currency) => ({
	$match: {
		websiteId,
		placedAt: { $gte: range.from, $lt: range.to },
		role: { $ne: 'cancelled' },
		'totals.currency': currency,
	},
});

/** The group key of each way of splitting sales. @type {Readonly<Record<SalesBy, unknown>>} */
const SALES_KEY = Object.freeze({
	product: '$lines.productId',
	category: { $ifNull: ['$lines.categoryIds', ''] },
	brand: { $ifNull: ['$lines.brandId', ''] },
	city: { $toLower: { $trim: { input: { $ifNull: ['$address.city', ''] } } } },
});

/**
 * Sales split by product, category (a line counts in each of its categories), brand or city: units, revenue (line
 * totals) and discount, the largest revenue first.
 * @param {string} websiteId @param {Range} range @param {string} currency @param {SalesBy} by
 */
export const salesPipeline = (websiteId, range, currency, by) => [
	ordersMatch(websiteId, range, currency),
	{ $unwind: '$lines' },
	...(by === 'category' ? [{ $unwind: { path: '$lines.categoryIds', preserveNullAndEmptyArrays: true } }] : []),
	{
		$group: {
			_id: SALES_KEY[by],
			name: { $first: by === 'city' ? { $trim: { input: { $ifNull: ['$address.city', ''] } } } : '$lines.name' },
			units: { $sum: '$lines.quantity' },
			revenue: { $sum: '$lines.total' },
			discount: { $sum: '$lines.discount' },
		},
	},
	{ $sort: { revenue: -1, _id: 1 } },
	{ $limit: MAX_ROWS },
];

/**
 * The totals of the range: orders, units, revenue, discount.
 * @param {string} websiteId @param {Range} range @param {string} currency
 */
export const totalsPipeline = (websiteId, range, currency) => [
	ordersMatch(websiteId, range, currency),
	{
		$group: {
			_id: null,
			orders: { $sum: 1 },
			units: { $sum: { $sum: '$lines.quantity' } },
			revenue: { $sum: { $sum: '$lines.total' } },
			discount: { $sum: { $sum: '$lines.discount' } },
		},
	},
];

/**
 * Revenue and cost per product of the lines whose unit cost is known.
 * @param {string} websiteId @param {Range} range @param {string} currency
 */
export const marginPipeline = (websiteId, range, currency) => [
	ordersMatch(websiteId, range, currency),
	{ $unwind: '$lines' },
	{ $match: { 'lines.cost': { $type: 'number' } } },
	{
		$group: {
			_id: '$lines.productId',
			name: { $first: '$lines.name' },
			units: { $sum: '$lines.quantity' },
			revenue: { $sum: '$lines.total' },
			cost: { $sum: { $multiply: ['$lines.cost', '$lines.quantity'] } },
		},
	},
	{ $sort: { revenue: -1, _id: 1 } },
	{ $limit: MAX_ROWS },
];

/**
 * The last sale of each of these products (orders not cancelled).
 * @param {string} websiteId @param {string[]} productIds
 */
export const lastSalePipeline = (websiteId, productIds) => [
	{ $match: { websiteId, role: { $ne: 'cancelled' }, 'lines.productId': { $in: productIds } } },
	{ $unwind: '$lines' },
	{ $match: { 'lines.productId': { $in: productIds } } },
	{ $group: { _id: '$lines.productId', last: { $max: '$placedAt' } } },
];

/**
 * Stock age rows: how long each product with stock has waited since its last sale (or since it was published), the
 * oldest first.
 * @param {Array<{ id: string, name: string, variants: Array<{ stock: number, active: boolean }>, publishedAt: Date | null,
 *   createdAt: Date }>} products
 * @param {Map<string, Date>} lastSales
 * @param {number} now
 */
export const stockAgeRows = (products, lastSales, now) =>
	products
		.map((product) => {
			const listed = product.publishedAt ?? product.createdAt;
			const lastSoldAt = lastSales.get(product.id) ?? null;
			const days = (/** @type {Date} */ since) => Math.max(0, Math.floor((now - since.getTime()) / DAY_MS));
			return {
				productId: product.id,
				name: product.name,
				stock: product.variants.filter((v) => v.active).reduce((sum, v) => sum + Math.max(0, v.stock), 0),
				publishedAt: listed.toISOString(),
				lastSoldAt: lastSoldAt ? lastSoldAt.toISOString() : null,
				daysListed: days(listed),
				daysSinceSale: days(lastSoldAt ?? listed),
			};
		})
		.filter((row) => row.stock > 0)
		.sort((a, b) => b.daysSinceSale - a.daysSinceSale || a.productId.localeCompare(b.productId))
		.slice(0, MAX_ROWS);

/**
 * Return rate per product: units claimed (claims made in the range, not rejected) over units sold in the range.
 * @param {Array<{ _id: string, name: string, units: number }>} sold sales by product
 * @param {Array<{ orderId: string, lines: Array<{ lineId: string, quantity: number }> }>} claims
 * @param {Map<string, { productId: string, name: string }>} lineProducts order line id → its product
 */
export const returnRateRows = (sold, claims, lineProducts) => {
	/** @type {Map<string, { productId: string, name: string, sold: number, claimed: number }>} */
	const rows = new Map(sold.map((row) => [row._id, { productId: row._id, name: row.name, sold: row.units, claimed: 0 }]));
	for (const claim of claims)
		for (const line of claim.lines) {
			const product = lineProducts.get(line.lineId);
			if (!product) continue;
			const row = rows.get(product.productId) ?? { productId: product.productId, name: product.name, sold: 0, claimed: 0 };
			row.claimed += line.quantity;
			rows.set(product.productId, row);
		}
	return [...rows.values()]
		.map((row) => ({ ...row, rate: row.sold > 0 ? Math.round((row.claimed / row.sold) * 10_000) / 10_000 : null }))
		.sort((a, b) => b.claimed - a.claimed || b.sold - a.sold || a.productId.localeCompare(b.productId))
		.slice(0, MAX_ROWS);
};
