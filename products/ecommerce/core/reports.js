/**
 * Reports (PLAN 0.8.8: sales by product/category/brand/city, stock age, return rate, margin; E36: the summary with its
 * daily series, sales by grade and payment method, sell-through, oldest stock and every report as CSV): the date range,
 * the aggregation pipelines over orders (each starts with a `$match` on the website; no `$lookup`) and the rows built
 * from their results. Money is minor units of the shop's currency; only orders in that currency and not canceled
 * count (the summary's `statuses` can name the status keys that count instead). Days are business days: a
 * `YYYY-MM-DD` day is that day in the business.json time zone (PLAN 0.8.10 K8). No I/O.
 * @module
 */
import { zonedDay } from '@ss/contracts/format';
import { dayBounds } from './calendar.js';
import { toDecimal } from './money.js';
import { DAY_MS } from './returns.js';

/** The longest range, in days. */
const MAX_RANGE_DAYS = 366;
/** The range when none is given, in days (up to now). */
const DEFAULT_RANGE_DAYS = 30;
/** Rows of a report, at most. */
export const MAX_ROWS = 500;
export const SALES_BY = Object.freeze(/** @type {const} */ (['product', 'category', 'brand', 'city', 'grade', 'payment_method']));
/** Most status keys of the summary's `statuses`. */
const MAX_STATUSES = 50;

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
 * The orders that count: placed in the range, not canceled, in the shop's currency.
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
	grade: { $ifNull: ['$lines.grade', ''] },
	payment_method: '$payment.method',
});

/** The name shown for each group. @type {Readonly<Record<SalesBy, unknown>>} */
const SALES_NAME = Object.freeze({
	product: '$lines.name',
	category: '$lines.name',
	brand: '$lines.name',
	city: { $trim: { input: { $ifNull: ['$address.city', ''] } } },
	grade: { $ifNull: ['$lines.gradeLabel', ''] },
	payment_method: '$payment.method',
});

/**
 * Sales split by product, category (a line counts in each of its categories), brand, city, grade or payment method:
 * units, revenue (line totals) and discount, the largest revenue first.
 * @param {string} websiteId @param {Range} range @param {string} currency @param {SalesBy} by
 */
export const salesPipeline = (websiteId, range, currency, by) => [
	ordersMatch(websiteId, range, currency),
	{ $unwind: '$lines' },
	...(by === 'category' ? [{ $unwind: { path: '$lines.categoryIds', preserveNullAndEmptyArrays: true } }] : []),
	{
		$group: {
			_id: SALES_KEY[by],
			name: { $first: SALES_NAME[by] },
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
 * The last sale of each of these products (orders not canceled).
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

// ------------------------------------------------------------------------------------------------- summary (E36)

/**
 * The summary's `statuses`: comma-separated status keys of the website's order flow (null = none given: orders count
 * as the other reports count them, not canceled).
 * @param {unknown} value
 * @param {ReadonlySet<string>} keys the status keys of the order flow
 * @returns {{ ok: true, statuses: string[] | null } | { ok: false, field: string, message: string }}
 */
export const parseStatuses = (value, keys) => {
	if (value === undefined || value === '') return { ok: true, statuses: null };
	const statuses = [
		...new Set(
			String(value)
				.split(',')
				.map((key) => key.trim())
				.filter(Boolean),
		),
	];
	if (statuses.length === 0 || statuses.length > MAX_STATUSES)
		return { ok: false, field: 'statuses', message: `Name 1 to ${MAX_STATUSES} status keys.` };
	const unknown = statuses.find((key) => !keys.has(key));
	if (unknown !== undefined) return { ok: false, field: 'statuses', message: `There is no status ${unknown.slice(0, 40)}.` };
	return { ok: true, statuses };
};

/**
 * The summary per business day: orders, total, goods (subtotals), delivery, fees, discount, refunded and units of the
 * orders that count (with `statuses`, the orders in those status keys; else the orders not canceled).
 * @param {string} websiteId @param {Range} range @param {string} currency @param {string[] | null} statuses
 * @param {string} timeZone
 */
export const summaryPipeline = (websiteId, range, currency, statuses, timeZone) => [
	{
		$match: {
			websiteId,
			placedAt: { $gte: range.from, $lt: range.to },
			'totals.currency': currency,
			...(statuses ? { status: { $in: statuses } } : { role: { $ne: 'cancelled' } }),
		},
	},
	{
		$group: {
			_id: { $dateToString: { format: '%Y-%m-%d', date: '$placedAt', timezone: timeZone } },
			orders: { $sum: 1 },
			total: { $sum: { $ifNull: ['$totals.total', 0] } },
			goods: { $sum: { $ifNull: ['$totals.subtotal', 0] } },
			delivery: { $sum: { $ifNull: ['$totals.delivery', 0] } },
			fees: { $sum: { $ifNull: ['$totals.fee', 0] } },
			discount: { $sum: { $ifNull: ['$totals.discount', 0] } },
			refunded: { $sum: { $ifNull: ['$payment.refunded', 0] } },
			units: { $sum: { $sum: '$lines.quantity' } },
		},
	},
];

/** The summed fields of the summary. */
const SUMMARY_FIELDS = Object.freeze(
	/** @type {const} */ (['orders', 'total', 'goods', 'delivery', 'fees', 'discount', 'refunded', 'units']),
);

/** @typedef {Record<(typeof SUMMARY_FIELDS)[number], number>} SummaryTotals */

/**
 * The summary of the range and every business day of it (days without orders are zero), oldest first.
 * @param {Array<Record<string, unknown>>} rows the summary pipeline's result
 * @param {Range} range
 * @param {string} timeZone
 * @returns {{ totals: SummaryTotals, days: Array<SummaryTotals & { day: string }> }}
 */
export const summaryOf = (rows, range, timeZone) => {
	const zero = () => /** @type {SummaryTotals} */ (Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, 0])));
	const byDay = new Map(rows.map((row) => [String(row._id), row]));
	const totals = zero();
	/** @type {Array<SummaryTotals & { day: string }>} */
	const days = [];
	const last = zonedDay(range.to.getTime() - 1, timeZone);
	for (let day = zonedDay(range.from, timeZone); day <= last;) {
		const row = byDay.get(day);
		const sums = zero();
		for (const field of SUMMARY_FIELDS) {
			sums[field] = Number(row?.[field] ?? 0);
			totals[field] += sums[field];
		}
		days.push({ day, ...sums });
		day = new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
	}
	return { totals, days };
};

// ----------------------------------------------------------------------------------- sell-through, oldest stock

/**
 * Sell-through per product that tracks stock: units sold in the range over those units plus the stock left now (null
 * when both are 0), the highest first.
 * @param {Array<{ _id: string, name: string, units: number }>} sold sales by product in the range
 * @param {Array<{ id: string, name: string, variants: Array<{ stock: number, active: boolean }> }>} products the
 *   products that track stock, sold in the range or with stock now
 */
export const sellThroughRows = (sold, products) => {
	const units = new Map(sold.map((row) => [String(row._id), Number(row.units)]));
	return products
		.map((product) => {
			const stock = product.variants.filter((v) => v.active).reduce((sum, v) => sum + Math.max(0, v.stock), 0);
			const count = units.get(product.id) ?? 0;
			return {
				productId: product.id,
				name: product.name,
				sold: count,
				stock,
				rate: count + stock > 0 ? Math.round((count / (count + stock)) * 10_000) / 10_000 : null,
			};
		})
		.filter((row) => row.sold > 0 || row.stock > 0)
		.sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0) || b.sold - a.sold || a.productId.localeCompare(b.productId))
		.slice(0, MAX_ROWS);
};

/**
 * The last sale of each of these variants (orders not canceled).
 * @param {string} websiteId @param {string[]} productIds
 */
export const lastVariantSalePipeline = (websiteId, productIds) => [
	{ $match: { websiteId, role: { $ne: 'cancelled' }, 'lines.productId': { $in: productIds } } },
	{ $unwind: '$lines' },
	{ $match: { 'lines.productId': { $in: productIds } } },
	{ $group: { _id: '$lines.variantId', last: { $max: '$placedAt' } } },
];

/**
 * Oldest stock: each active variant with stock, how long it has waited since its last sale (or since its product was
 * published), the oldest first.
 * @param {Array<{ id: string, name: string, variants: Array<{ id: string, sku: string, options: Record<string, string>,
 *   stock: number, active: boolean, grade: string | null }>, publishedAt: Date | null, createdAt: Date }>} products
 * @param {Map<string, Date>} lastSales variant id → its last sale
 * @param {number} now
 */
export const oldestStockRows = (products, lastSales, now) =>
	products
		.flatMap((product) =>
			product.variants
				.filter((variant) => variant.active && variant.stock > 0)
				.map((variant) => {
					const since = lastSales.get(variant.id) ?? product.publishedAt ?? product.createdAt;
					return {
						productId: product.id,
						variantId: variant.id,
						name: product.name,
						variantName: Object.values(variant.options ?? {}).join(' / '),
						sku: variant.sku,
						grade: variant.grade ?? null,
						stock: variant.stock,
						since: since.toISOString(),
						days: Math.max(0, Math.floor((now - since.getTime()) / DAY_MS)),
					};
				}),
		)
		.sort((a, b) => b.days - a.days || a.productId.localeCompare(b.productId) || a.variantId.localeCompare(b.variantId))
		.slice(0, MAX_ROWS);

// ---------------------------------------------------------------------------------------------------------- CSV

/**
 * The columns of each report's CSV file: `[column, field, 'money']` (money as decimals of the shop's currency).
 * @type {Readonly<Record<string, ReadonlyArray<readonly [string, string, ('money' | undefined)?]>>>}
 */
export const REPORT_COLUMNS = Object.freeze({
	summary: [
		['day', 'day'],
		['orders', 'orders'],
		['total', 'total', 'money'],
		['goods', 'goods', 'money'],
		['delivery', 'delivery', 'money'],
		['fees', 'fees', 'money'],
		['discount', 'discount', 'money'],
		['refunded', 'refunded', 'money'],
		['units', 'units'],
	],
	sales: [
		['key', 'key'],
		['name', 'name'],
		['units', 'units'],
		['revenue', 'revenue', 'money'],
		['discount', 'discount', 'money'],
	],
	'stock-age': [
		['product_id', 'productId'],
		['name', 'name'],
		['stock', 'stock'],
		['published_at', 'publishedAt'],
		['last_sold_at', 'lastSoldAt'],
		['days_listed', 'daysListed'],
		['days_since_sale', 'daysSinceSale'],
	],
	returns: [
		['product_id', 'productId'],
		['name', 'name'],
		['sold', 'sold'],
		['claimed', 'claimed'],
		['rate', 'rate'],
	],
	margin: [
		['product_id', 'productId'],
		['name', 'name'],
		['units', 'units'],
		['revenue', 'revenue', 'money'],
		['cost', 'cost', 'money'],
		['margin', 'margin', 'money'],
	],
	'sell-through': [
		['product_id', 'productId'],
		['name', 'name'],
		['sold', 'sold'],
		['stock', 'stock'],
		['rate', 'rate'],
	],
	'oldest-stock': [
		['product_id', 'productId'],
		['variant_id', 'variantId'],
		['name', 'name'],
		['variant', 'variantName'],
		['sku', 'sku'],
		['grade', 'grade'],
		['stock', 'stock'],
		['since', 'since'],
		['days', 'days'],
	],
});

/**
 * Minor units as a decimal. An amount below 0 (a margin) is written as a number, so the CSV writer's formula guard
 * leaves its minus sign alone.
 * @param {number} amount @param {string} currency
 */
const decimal = (amount, currency) => (amount < 0 ? -Number(toDecimal(-amount, currency)) : toDecimal(amount, currency));

/**
 * The header and rows of a report's CSV file.
 * @param {ReadonlyArray<readonly [string, string, ('money' | undefined)?]>} columns
 * @param {Array<Record<string, unknown>>} rows
 * @param {string} currency
 * @returns {{ header: string[], rows: import('./csv.js').Cell[][] }}
 */
export const reportCsv = (columns, rows, currency) => ({
	header: columns.map(([column]) => column),
	rows: rows.map((row) =>
		columns.map(([, field, kind]) => {
			const value = row[field];
			if (kind === 'money') return decimal(Number(value ?? 0), currency);
			return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null;
		}),
	),
});
