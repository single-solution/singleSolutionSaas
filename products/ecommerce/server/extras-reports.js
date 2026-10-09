/**
 * Reports (feature `reports`, PLAN 0.8.8): sales by product, category, brand and city, stock age, return rate and
 * margin, for the merchant's server and the admin widget (permission `reports.read`). Each report reads the merchant
 * database with aggregation pipelines that start with a `$match` on the website (`core/reports.js`); names of
 * categories and brands are read separately (no `$lookup`). Money is minor units of the shop's currency.
 * @module
 */
import { defineRoute } from '@ss/app-kit';
import { COLLECTIONS } from '../core/model.js';
import {
	MAX_ROWS,
	SALES_BY,
	lastSalePipeline,
	marginPipeline,
	parseRange,
	returnRateRows,
	salesPipeline,
	stockAgeRows,
	totalsPipeline,
} from '../core/reports.js';
import { SERVER_LIMITS } from './service.js';

/** Rate limits (mutable copies of the shared constants, as route definitions take them). */
const SERVER = [...SERVER_LIMITS];

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/reports.js').Range} Range */

/**
 * @param {Product} _product
 * @param {Service} service
 */
export const createReports = (_product, service) => {
	/**
	 * The website, its database and the range of the request.
	 * @param {any} ctx
	 */
	const begin = async (ctx) => {
		const parsed = parseRange(ctx.query, service.now());
		if (!parsed.ok) throw service.invalid(parsed.field, parsed.message);
		const s = await service.site(ctx);
		return { s, data: await s.data(), range: parsed.range };
	};

	/** @param {Range} range */
	const period = (range) => ({ from: range.from.toISOString(), to: range.to.toISOString() });

	/**
	 * Names of categories or brands by id.
	 * @param {WebsiteData} data
	 * @param {string} collection
	 * @param {string[]} ids
	 */
	const namesOf = async (data, collection, ids) => {
		const found = /** @type {Array<{ id: string, name: string }>} */ (
			ids.length === 0
				? []
				: await data
						.collection(collection)
						.find({ websiteId: data.websiteId, id: { $in: ids } }, { projection: { _id: 0, id: 1, name: 1 } })
						.toArray()
		);
		return new Map(found.map((row) => [row.id, row.name]));
	};

	/** @param {any} ctx */
	const sales = async (ctx) => {
		const by = SALES_BY.includes(ctx.query.by) ? /** @type {import('../core/reports.js').SalesBy} */ (ctx.query.by) : 'product';
		const { s, data, range } = await begin(ctx);
		const orders = data.collection(COLLECTIONS.orders);
		const rows = await orders.aggregate(salesPipeline(data.websiteId, range, s.currency, by)).toArray();
		const [totals] = await orders.aggregate(totalsPipeline(data.websiteId, range, s.currency)).toArray();
		const keys = rows.map((row) => String(row._id ?? '')).filter(Boolean);
		const names =
			by === 'category'
				? await namesOf(data, COLLECTIONS.categories, keys)
				: by === 'brand'
					? await namesOf(data, COLLECTIONS.brands, keys)
					: null;
		return {
			...period(range),
			currency: s.currency,
			by,
			totals: {
				orders: Number(totals?.orders ?? 0),
				units: Number(totals?.units ?? 0),
				revenue: Number(totals?.revenue ?? 0),
				discount: Number(totals?.discount ?? 0),
			},
			rows: rows.map((row) => {
				const key = String(row._id ?? '');
				return {
					key,
					name: names ? (names.get(key) ?? '') : String(row.name ?? ''),
					units: Number(row.units),
					revenue: Number(row.revenue),
					discount: Number(row.discount),
				};
			}),
		};
	};

	/** @param {any} ctx */
	const stockAge = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const products = /** @type {any[]} */ (
			await data
				.collection(COLLECTIONS.products)
				.find(
					{ websiteId: data.websiteId, status: 'active', trackStock: true, 'variants.stock': { $gt: 0 } },
					{ projection: { _id: 0, id: 1, name: 1, variants: 1, publishedAt: 1, createdAt: 1 }, limit: 5000 },
				)
				.toArray()
		);
		const ids = products.map((p) => String(p.id));
		const sales =
			ids.length === 0
				? []
				: await data.collection(COLLECTIONS.orders).aggregate(lastSalePipeline(data.websiteId, ids)).toArray();
		const last = new Map(sales.map((row) => [String(row._id), /** @type {Date} */ (row.last)]));
		return { rows: stockAgeRows(products, last, service.now()) };
	};

	/** @param {any} ctx */
	const returnRate = async (ctx) => {
		const { s, data, range } = await begin(ctx);
		const sold = /** @type {Array<{ _id: string, name: string, units: number }>} */ (
			await data
				.collection(COLLECTIONS.orders)
				.aggregate(salesPipeline(data.websiteId, range, s.currency, 'product'))
				.toArray()
		);
		const claims = /** @type {Array<{ orderId: string, lines: Array<{ lineId: string, quantity: number }> }>} */ (
			await data
				.collection(COLLECTIONS.returns)
				.find(
					{ websiteId: data.websiteId, createdAt: { $gte: range.from, $lt: range.to }, status: { $ne: 'rejected' } },
					{ projection: { _id: 0, orderId: 1, lines: 1 }, limit: 20 * MAX_ROWS },
				)
				.toArray()
		);
		const orderIds = [...new Set(claims.map((claim) => claim.orderId))];
		const orders = /** @type {Array<{ lines: Array<{ id: string, productId: string, name: string }> }>} */ (
			orderIds.length === 0
				? []
				: await data
						.collection(COLLECTIONS.orders)
						.find(
							{ websiteId: data.websiteId, id: { $in: orderIds } },
							{ projection: { _id: 0, 'lines.id': 1, 'lines.productId': 1, 'lines.name': 1 } },
						)
						.toArray()
		);
		const lineProducts = new Map(
			orders.flatMap((order) => order.lines.map((line) => [line.id, { productId: line.productId, name: line.name }])),
		);
		return { ...period(range), rows: returnRateRows(sold, claims, lineProducts) };
	};

	/** @param {any} ctx */
	const margin = async (ctx) => {
		const { s, data, range } = await begin(ctx);
		const rows = (
			await data
				.collection(COLLECTIONS.orders)
				.aggregate(marginPipeline(data.websiteId, range, s.currency))
				.toArray()
		).map((row) => ({
			productId: String(row._id),
			name: String(row.name ?? ''),
			units: Number(row.units),
			revenue: Number(row.revenue),
			cost: Number(row.cost),
			margin: Number(row.revenue) - Number(row.cost),
		}));
		const totals = rows.reduce(
			(sum, row) => ({
				units: sum.units + row.units,
				revenue: sum.revenue + row.revenue,
				cost: sum.cost + row.cost,
				margin: sum.margin + row.margin,
			}),
			{ units: 0, revenue: 0, cost: 0, margin: 0 },
		);
		return { ...period(range), currency: s.currency, totals, rows };
	};

	const routes = [
		defineRoute({
			method: 'GET',
			path: '/v1/reports/sales',
			auth: 'server',
			feature: 'reports',
			rateLimit: SERVER,
			handler: sales,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/reports/stock-age',
			auth: 'server',
			feature: 'reports',
			rateLimit: SERVER,
			handler: stockAge,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/reports/returns',
			auth: 'server',
			feature: 'reports',
			rateLimit: SERVER,
			handler: returnRate,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/reports/margin',
			auth: 'server',
			feature: 'reports',
			rateLimit: SERVER,
			handler: margin,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/reports/sales',
			auth: 'ticket',
			feature: 'reports',
			permission: 'reports.read',
			rateLimit: SERVER,
			handler: sales,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/reports/stock-age',
			auth: 'ticket',
			feature: 'reports',
			permission: 'reports.read',
			rateLimit: SERVER,
			handler: stockAge,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/reports/returns',
			auth: 'ticket',
			feature: 'reports',
			permission: 'reports.read',
			rateLimit: SERVER,
			handler: returnRate,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/reports/margin',
			auth: 'ticket',
			feature: 'reports',
			permission: 'reports.read',
			rateLimit: SERVER,
			handler: margin,
		}),
	];

	return { routes };
};
