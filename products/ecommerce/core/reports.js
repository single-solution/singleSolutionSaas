/**
 * Reports (PLAN 0.8.8: sales by product/category/brand/city, stock age, return rate, margin; E36: the summary with its
 * daily series, sales by grade and payment method, sell-through, oldest stock and every report as CSV): the date range,
 * the aggregation pipelines over orders (each starts with a `$match` on the website; no `$lookup`) and the rows built
 * from their results. Money is minor units of the shop's currency; only orders in that currency and not canceled
 * count (the summary's `statuses` can name the status keys that count instead). Days are business days: a
 * `YYYY-MM-DD` day is that day in the business time zone (PLAN 0.8.10 K8). No I/O.
 * @module
 */
import { zonedDay } from '@ss/contracts/format';
import { dayBounds } from './durations.js';
import { toDecimal } from '@ss/contracts/format';
import { DAY_MS } from './durations.js';

/** The longest range, in days. */
const MAX_RANGE_DAYS = 366;
/** The range when none is given, in days (up to now). */
const DEFAULT_RANGE_DAYS = 30;
/** Rows of a report, at most. */
export const MAX_ROWS = 500;
/**
 * The built-in groupings of the sales report (E12), in the order the widget offers them: the line's product, category,
 * brand, item type, product tag and grade; the order's tag, status, payment method, city, region, country, delivery
 * zone and courier; and its business day, ISO week or month. `field:<id>` groups by any product, variant or order field.
 */
export const SALES_GROUPINGS = Object.freeze(
	/** @type {const} */ ([
		'product',
		'category',
		'brand',
		'item_type',
		'tag',
		'grade',
		'order_tag',
		'status',
		'payment_method',
		'city',
		'region',
		'country',
		'zone',
		'courier',
		'day',
		'week',
		'month',
	]),
);
/** The name of each built-in grouping (the widget shows its own words for them). */
export const GROUPING_LABELS = Object.freeze(
	/** @type {Readonly<Record<SalesBy, string>>} */ ({
		product: 'Product',
		category: 'Category',
		brand: 'Brand',
		item_type: 'Item type',
		tag: 'Product tag',
		grade: 'Grade',
		order_tag: 'Order tag',
		status: 'Status',
		payment_method: 'Payment method',
		city: 'City',
		region: 'Region',
		country: 'Country',
		zone: 'Delivery zone',
		courier: 'Courier',
		day: 'Day',
		week: 'Week',
		month: 'Month',
	}),
);
/** The groupings by time, and the summary's series: their `$dateToString` formats (ISO weeks). */
const PERIOD_FORMATS = Object.freeze({ day: '%Y-%m-%d', week: '%G-W%V', month: '%Y-%m' });
/** Groupings read from the products of the lines (their tags and item type), not from the orders. */
export const PRODUCT_GROUPINGS = Object.freeze(/** @type {const} */ (['tag', 'item_type']));
/** Most status keys of the summary's `statuses`. */
const MAX_STATUSES = 50;

/** @typedef {(typeof SALES_GROUPINGS)[number]} SalesBy */
/** @typedef {keyof typeof PERIOD_FORMATS} Series */
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
 * @param {string} [timeZone] the business time zone (UTC when missing)
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
		role: { $ne: 'canceled' },
		'totals.currency': currency,
	},
});

/**
 * A line's pieces in a pipeline over unwound `$lines` (`core/measure.js` `piecesOf`: a measured line is one).
 */
const LINE_PIECES = Object.freeze({ $cond: [{ $eq: [{ $type: '$lines.measure' }, 'object'] }, 1, '$lines.quantity'] });
/** The pieces of an order's lines, summed (the lines not unwound). */
const ORDER_PIECES = Object.freeze({
	$sum: {
		$map: {
			input: '$lines',
			as: 'line',
			in: { $cond: [{ $eq: [{ $type: '$$line.measure' }, 'object'] }, 1, '$$line.quantity'] },
		},
	},
});
/** What a line's units cost (unit cost × pieces; a measured line's cost is per unit of its thousandths). */
const LINE_COST = Object.freeze({
	$cond: [
		{ $eq: [{ $type: '$lines.measure' }, 'object'] },
		{ $round: [{ $divide: [{ $multiply: ['$lines.cost', '$lines.quantity'] }, 1000] }, 0] },
		{ $multiply: ['$lines.cost', '$lines.quantity'] },
	],
});

/** @param {string} path */
const trimmed = (path) => ({ $trim: { input: { $ifNull: [path, ''] } } });

/**
 * The group key (and the name shown, when it is not the key) of each grouping read from the orders: `unwind` the
 * line's categories first; a key that is a list (tags, a field with several values) counts in each of its values.
 * @param {string} by @param {string} timeZone
 * @returns {{ key: unknown, name?: unknown, unwind?: string, sort?: 'key' } | null}
 */
const orderKeyOf = (by, timeZone) => {
	if (by.startsWith('field:')) return { key: { $ifNull: [`$fields.${by.slice('field:'.length)}`, ''] } };
	if (Object.hasOwn(PERIOD_FORMATS, by))
		return {
			key: { $dateToString: { format: PERIOD_FORMATS[/** @type {Series} */ (by)], date: '$placedAt', timezone: timeZone } },
			sort: 'key',
		};
	switch (by) {
		case 'product':
			return { key: '$lines.productId', name: '$lines.name' };
		// a regrouping by variant fields reads the sales of each variant
		case 'variant':
			return { key: '$lines.variantId', name: '$lines.name' };
		case 'category':
			return { key: { $ifNull: ['$lines.categoryIds', ''] }, unwind: '$lines.categoryIds' };
		case 'brand':
			return { key: { $ifNull: ['$lines.brandId', ''] } };
		case 'grade':
			return { key: { $ifNull: ['$lines.grade', ''] }, name: { $ifNull: ['$lines.gradeLabel', ''] } };
		case 'order_tag':
			return { key: { $ifNull: ['$tags', ''] } };
		case 'status':
			return { key: '$status' };
		case 'payment_method':
			return { key: '$payment.method' };
		case 'city':
		case 'region':
			return { key: { $toLower: trimmed(`$address.${by}`) }, name: trimmed(`$address.${by}`) };
		case 'country':
			return { key: { $toUpper: trimmed('$address.country') } };
		case 'zone':
			return { key: { $ifNull: ['$delivery.zone', ''] } };
		case 'courier':
			return { key: { $ifNull: ['$shipment.courier', ''] } };
		default:
			return null;
	}
};

/**
 * Sales split by a grouping read from the orders (`field:<id>` an order field, or a product field by product with
 * `productField`): units, revenue (line totals) and discount, the largest revenue first (periods: the oldest first). A
 * line counts in each of its categories, and in each value of a key that is a list. The name of each group is read
 * separately where the key is an id (categories, brands, payment methods, statuses).
 * @param {string} websiteId @param {Range} range @param {string} currency @param {string} by
 * @param {{ timeZone?: string, limit?: number }} [options] `limit`: most groups (products for a regrouping)
 */
export const salesPipeline = (websiteId, range, currency, by, { timeZone = 'UTC', limit = MAX_ROWS } = {}) => {
	const grouping = orderKeyOf(by, timeZone);
	if (!grouping) throw new Error(`unknown grouping ${by}`);
	return [
		ordersMatch(websiteId, range, currency),
		{ $unwind: '$lines' },
		...(grouping.unwind ? [{ $unwind: { path: grouping.unwind, preserveNullAndEmptyArrays: true } }] : []),
		{ $addFields: { _k: grouping.key, ...(grouping.name ? { _n: grouping.name } : {}) } },
		// a key that is a list counts in each value (none: '')
		{ $unwind: { path: '$_k', preserveNullAndEmptyArrays: true } },
		{
			$group: {
				_id: { $ifNull: ['$_k', ''] },
				name: { $first: grouping.name ? '$_n' : '$_k' },
				units: { $sum: LINE_PIECES },
				revenue: { $sum: '$lines.total' },
				discount: { $sum: '$lines.discount' },
			},
		},
		{ $sort: grouping.sort === 'key' ? { _id: 1 } : { revenue: -1, _id: 1 } },
		{ $limit: limit },
	];
};

/**
 * Sales rows regrouped by values read elsewhere (E12: the products' tags, item types and fields): each row's values
 * (none: one group with the key ''), the largest revenue first.
 * @param {ReadonlyArray<{ _id: unknown, units: unknown, revenue: unknown, discount: unknown }>} rows
 * @param {(id: string) => Array<{ key: string, name: string }>} valuesOf
 * @returns {Array<{ key: string, name: string, units: number, revenue: number, discount: number }>}
 */
export const regroup = (rows, valuesOf) => {
	/** @type {Map<string, { key: string, name: string, units: number, revenue: number, discount: number }>} */
	const groups = new Map();
	for (const row of rows) {
		const values = valuesOf(String(row._id ?? ''));
		for (const { key, name } of values.length > 0 ? values : [{ key: '', name: '' }]) {
			const group = groups.get(key) ?? { key, name, units: 0, revenue: 0, discount: 0 };
			group.units += Number(row.units);
			group.revenue += Number(row.revenue);
			group.discount += Number(row.discount);
			groups.set(key, group);
		}
	}
	return [...groups.values()].sort((a, b) => b.revenue - a.revenue || a.key.localeCompare(b.key)).slice(0, MAX_ROWS);
};

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
			units: { $sum: ORDER_PIECES },
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
			units: { $sum: LINE_PIECES },
			revenue: { $sum: '$lines.total' },
			cost: { $sum: LINE_COST },
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
	{ $match: { websiteId, role: { $ne: 'canceled' }, 'lines.productId': { $in: productIds } } },
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
 * @param {Map<string, { productId: string, name: string, measure?: unknown }>} lineProducts order line id → its
 *   product (a measured line's claim counts one piece, as its sale does)
 */
export const returnRateRows = (sold, claims, lineProducts) => {
	/** @type {Map<string, { productId: string, name: string, sold: number, claimed: number }>} */
	const rows = new Map(sold.map((row) => [row._id, { productId: row._id, name: row.name, sold: row.units, claimed: 0 }]));
	for (const claim of claims)
		for (const line of claim.lines) {
			const product = lineProducts.get(line.lineId);
			if (!product) continue;
			const row = rows.get(product.productId) ?? { productId: product.productId, name: product.name, sold: 0, claimed: 0 };
			row.claimed += product.measure ? 1 : line.quantity;
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
 * The summary per business day, ISO week or month (E12 `series`): orders, total, goods (subtotals), delivery, fees,
 * discount, refunded and units of the orders that count (with `statuses`, the orders in those status keys; else the
 * orders not canceled).
 * @param {string} websiteId @param {Range} range @param {string} currency @param {string[] | null} statuses
 * @param {string} timeZone @param {Series} [series]
 */
export const summaryPipeline = (websiteId, range, currency, statuses, timeZone, series = 'day') => [
	{
		$match: {
			websiteId,
			placedAt: { $gte: range.from, $lt: range.to },
			'totals.currency': currency,
			...(statuses ? { status: { $in: statuses } } : { role: { $ne: 'canceled' } }),
		},
	},
	{
		$group: {
			_id: {
				$dateToString: { format: PERIOD_FORMATS[/** @type {Series} */ (series)], date: '$placedAt', timezone: timeZone },
			},
			orders: { $sum: 1 },
			total: { $sum: { $ifNull: ['$totals.total', 0] } },
			goods: { $sum: { $ifNull: ['$totals.subtotal', 0] } },
			delivery: { $sum: { $ifNull: ['$totals.delivery', 0] } },
			fees: { $sum: { $ifNull: ['$totals.fee', 0] } },
			discount: { $sum: { $ifNull: ['$totals.discount', 0] } },
			refunded: { $sum: { $ifNull: ['$payment.refunded', 0] } },
			units: { $sum: ORDER_PIECES },
		},
	},
];

/** The summed fields of the summary. */
const SUMMARY_FIELDS = Object.freeze(
	/** @type {const} */ (['orders', 'total', 'goods', 'delivery', 'fees', 'discount', 'refunded', 'units']),
);

/** @typedef {Record<(typeof SUMMARY_FIELDS)[number], number>} SummaryTotals */

/**
 * The ISO week (`2026-W41`) of a day (`YYYY-MM-DD`), as MongoDB's `%G-W%V` writes it.
 * @param {string} day
 */
const isoWeekOf = (day) => {
	const date = new Date(`${day}T00:00:00Z`);
	// the Thursday of its week decides the year
	const thursday = new Date(date.getTime() + (3 - ((date.getUTCDay() + 6) % 7)) * DAY_MS);
	const year = thursday.getUTCFullYear();
	const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1;
	return `${year}-W${String(week).padStart(2, '0')}`;
};

/**
 * The summary of the range and every business day, ISO week or month of it (periods without orders are zero), oldest
 * first (E12: `series`).
 * @param {Array<Record<string, unknown>>} rows the summary pipeline's result
 * @param {Range} range
 * @param {string} timeZone
 * @param {Series} [series]
 * @returns {{ totals: SummaryTotals, periods: Array<SummaryTotals & { period: string }> }}
 */
export const summaryOf = (rows, range, timeZone, series = 'day') => {
	const zero = () => /** @type {SummaryTotals} */ (Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, 0])));
	const byPeriod = new Map(rows.map((row) => [String(row._id), row]));
	/** @param {string} day */
	const periodOf = (day) => (series === 'month' ? day.slice(0, 7) : series === 'week' ? isoWeekOf(day) : day);
	const totals = zero();
	/** @type {Array<SummaryTotals & { period: string }>} */
	const periods = [];
	const last = zonedDay(range.to.getTime() - 1, timeZone);
	for (let day = zonedDay(range.from, timeZone); day <= last;) {
		const period = periodOf(day);
		if (periods.at(-1)?.period !== period) {
			const row = byPeriod.get(period);
			const sums = zero();
			for (const field of SUMMARY_FIELDS) {
				sums[field] = Number(row?.[field] ?? 0);
				totals[field] += sums[field];
			}
			periods.push({ period, ...sums });
		}
		day = new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
	}
	return { totals, periods };
};

/** @param {unknown} value @returns {value is Series} */
export const isSeries = (value) => typeof value === 'string' && Object.hasOwn(PERIOD_FORMATS, value);

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
	{ $match: { websiteId, role: { $ne: 'canceled' }, 'lines.productId': { $in: productIds } } },
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
		['period', 'period'],
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
 * @returns {{ header: string[], rows: import('@ss/contracts/csv').CsvCell[][] }}
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
