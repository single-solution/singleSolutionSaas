/**
 * Reports (feature `reports`, PLAN 0.8.8): sales by product, category, brand, city, grade and payment method, stock
 * age, return rate and margin, (E36) the summary with its daily series, sell-through and oldest stock, and (E41) shop
 * health, for the merchant's server and the admin widget (permission `reports.read`). Every report answers JSON, or
 * with `format=csv` its rows as a CSV file (the `csv` setting's separator); shop health answers JSON only. Each report reads the merchant database with aggregation
 * pipelines that start with a `$match` on the website (`core/reports.js`); names of categories and brands are read
 * separately (no `$lookup`). Money is minor units of the shop's currency; a day in `from` and `to`, and a day of the
 * summary's series, is a day in the business time zone (PLAN 0.8.10 K8).
 * @module
 */
import { defineRoute } from '@ss/app-kit';
import { toCsv } from '../core/csv.js';
import { COLLECTIONS } from '../core/model.js';
import {
	MAX_ROWS,
	REPORT_COLUMNS,
	SALES_BY,
	lastSalePipeline,
	lastVariantSalePipeline,
	marginPipeline,
	oldestStockRows,
	parseRange,
	parseStatuses,
	reportCsv,
	returnRateRows,
	salesPipeline,
	sellThroughRows,
	stockAgeRows,
	summaryOf,
	summaryPipeline,
	totalsPipeline,
} from '../core/reports.js';
import { badTagIds, healthOf, healthPipeline, paymentMethodsOn } from '../core/health.js';
import { csvFile } from './catalog-tools.js';
import { SERVER_LIMITS } from './service.js';

/** Rate limits (mutable copies of the shared constants, as route definitions take them). */
const SERVER = [...SERVER_LIMITS];

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/reports.js').Range} Range */

/**
 * What a report built: the site, the JSON answer and the rows its CSV file lists.
 * @typedef {{ s: Site, body: Record<string, unknown>, rows: Array<Record<string, any>> }} Built
 */

/**
 * @param {Product} product
 * @param {Service} service
 */
export const createReports = (product, service) => {
	/**
	 * The website, its database and the range of the request.
	 * @param {any} ctx
	 */
	const begin = async (ctx) => {
		const s = await service.site(ctx);
		const timeZone = (await s.business()).timeZone ?? 'UTC';
		const parsed = parseRange(ctx.query, service.now(), timeZone);
		if (!parsed.ok) throw service.invalid(parsed.field, parsed.message);
		return { s, data: await s.data(), range: parsed.range, timeZone };
	};

	/**
	 * A report's handler: its JSON answer, or with `format=csv` its rows as a CSV file named after the report.
	 * @param {keyof typeof REPORT_COLUMNS} name
	 * @param {(ctx: any) => Promise<Built>} build
	 */
	const report = (name, build) => async (/** @type {any} */ ctx) => {
		const format = ctx.query.format ?? '';
		if (!['', 'json', 'csv'].includes(format)) throw service.invalid('format', 'The format is json or csv.');
		const { s, body, rows } = await build(ctx);
		if (format !== 'csv') return body;
		const columns = /** @type {(typeof REPORT_COLUMNS)[string]} */ (REPORT_COLUMNS[name]);
		const file = reportCsv(columns, rows, s.currency);
		const delimiter = (await s.values('csv')).delimiter === ';' ? ';' : ',';
		return csvFile(`${name}.csv`, toCsv(file.header, file.rows, { delimiter }));
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

	/** @param {any} ctx @returns {Promise<Built>} */
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
		const list = rows.map((row) => {
			const key = String(row._id ?? '');
			return {
				key,
				name: names ? (names.get(key) ?? '') : String(row.name ?? ''),
				units: Number(row.units),
				revenue: Number(row.revenue),
				discount: Number(row.discount),
			};
		});
		const body = {
			...period(range),
			currency: s.currency,
			by,
			totals: {
				orders: Number(totals?.orders ?? 0),
				units: Number(totals?.units ?? 0),
				revenue: Number(totals?.revenue ?? 0),
				discount: Number(totals?.discount ?? 0),
			},
			rows: list,
		};
		return { s, body, rows: list };
	};

	/** @param {any} ctx @returns {Promise<Built>} */
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
		const rows = stockAgeRows(products, last, service.now());
		return { s, body: { rows }, rows };
	};

	/** @param {any} ctx @returns {Promise<Built>} */
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
		const rows = returnRateRows(sold, claims, lineProducts);
		return { s, body: { ...period(range), rows }, rows };
	};

	/** @param {any} ctx @returns {Promise<Built>} */
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
		return { s, body: { ...period(range), currency: s.currency, totals, rows }, rows };
	};

	/** GET …/reports/summary?from=&to=&statuses=&series=day (E36). @param {any} ctx @returns {Promise<Built>} */
	const summary = async (ctx) => {
		if (ctx.query.series !== undefined && ctx.query.series !== '' && ctx.query.series !== 'day')
			throw service.invalid('series', 'The series is day.');
		const { s, data, range, timeZone } = await begin(ctx);
		const flow = /** @type {import('../core/model.js').OrderFlow} */ (/** @type {unknown} */ (await s.list('order_flow')));
		const parsed = parseStatuses(ctx.query.statuses, new Set(flow.statuses.map((status) => status.key)));
		if (!parsed.ok) throw service.invalid(parsed.field, parsed.message);
		const rows = await data
			.collection(COLLECTIONS.orders)
			.aggregate(summaryPipeline(data.websiteId, range, s.currency, parsed.statuses, timeZone))
			.toArray();
		const { totals, days } = summaryOf(rows, range, timeZone);
		const body = {
			...period(range),
			currency: s.currency,
			statuses: parsed.statuses,
			...totals,
			days: days.map((day) => ({ day: day.day, orders: day.orders, total: day.total })),
		};
		return { s, body, rows: days };
	};

	/** GET …/reports/sell-through?from=&to= (E36). @param {any} ctx @returns {Promise<Built>} */
	const sellThrough = async (ctx) => {
		const { s, data, range } = await begin(ctx);
		const sold = /** @type {Array<{ _id: string, name: string, units: number }>} */ (
			await data
				.collection(COLLECTIONS.orders)
				.aggregate(salesPipeline(data.websiteId, range, s.currency, 'product'))
				.toArray()
		);
		const products = /** @type {any[]} */ (
			await data
				.collection(COLLECTIONS.products)
				.find(
					{
						websiteId: data.websiteId,
						trackStock: true,
						$or: [{ id: { $in: sold.map((row) => String(row._id)) } }, { status: 'active', 'variants.stock': { $gt: 0 } }],
					},
					{ projection: { _id: 0, id: 1, name: 1, 'variants.stock': 1, 'variants.active': 1 }, limit: 5000 },
				)
				.toArray()
		);
		const rows = sellThroughRows(sold, products);
		return { s, body: { ...period(range), rows }, rows };
	};

	/** GET …/reports/oldest-stock (E36). @param {any} ctx @returns {Promise<Built>} */
	const oldestStock = async (ctx) => {
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
				: await data.collection(COLLECTIONS.orders).aggregate(lastVariantSalePipeline(data.websiteId, ids)).toArray();
		const last = new Map(sales.map((row) => [String(row._id), /** @type {Date} */ (row.last)]));
		const rows = oldestStockRows(products, last, service.now());
		return { s, body: { rows }, rows };
	};

	/**
	 * The payment methods shoppers can use now (E41): cash on delivery, online and bank transfer, pay at pickup.
	 * @param {Site} s @param {WebsiteData} data
	 */
	const paymentMethods = async (s, data) => {
		const checkout = await s.values('checkout');
		/** @type {string[]} */
		const offered = Array.isArray(checkout.paymentMethods) ? checkout.paymentMethods : [];
		const cod = s.has('cod') && (await s.values('cod')).enabled !== false;
		const pickup =
			offered.includes('pickup') &&
			s.has('delivery_zones') &&
			(await data
				.collection(COLLECTIONS.locations)
				.countDocuments({ websiteId: data.websiteId, pickup: true }, { limit: 1 })) > 0;
		return paymentMethodsOn({
			cod,
			offered,
			paymentsConnected: (await product.connections.value(s.websiteId, 'payments')) !== null,
			bankManual: checkout.bankTransferVia === 'manual',
			pickup,
		});
	};

	/**
	 * Growth's badly formed tag ids, or null while its token is not pasted or it does not answer (E41).
	 * @param {Site} s
	 */
	const badTags = async (s) => {
		const answer = await product.callProduct(s.websiteId, 'growth', '/v1/settings');
		return answer.ok ? badTagIds(answer.body) : null;
	};

	/** GET …/reports/health (E41): what needs fixing, with counts and links. @param {any} ctx */
	const health = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const { lowStock } = await s.values('catalog');
		const [[facets], business, methods, tags] = await Promise.all([
			data
				.collection(COLLECTIONS.products)
				.aggregate(healthPipeline(data.websiteId, Number(lowStock)))
				.toArray(),
			s.business(),
			paymentMethods(s, data),
			badTags(s),
		]);
		return healthOf({ facets, business, domain: s.domain, paymentMethods: methods, badTags: tags });
	};

	const routes = [
		defineRoute({
			method: 'GET',
			path: '/v1/reports/health',
			auth: 'server',
			feature: 'reports',
			rateLimit: SERVER,
			handler: health,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/reports/health',
			auth: 'ticket',
			feature: 'reports',
			permission: 'reports.read',
			rateLimit: SERVER,
			handler: health,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/reports/sales',
			auth: 'server',
			feature: 'reports',
			rateLimit: SERVER,
			handler: report('sales', sales),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/reports/stock-age',
			auth: 'server',
			feature: 'reports',
			rateLimit: SERVER,
			handler: report('stock-age', stockAge),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/reports/returns',
			auth: 'server',
			feature: 'reports',
			rateLimit: SERVER,
			handler: report('returns', returnRate),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/reports/margin',
			auth: 'server',
			feature: 'reports',
			rateLimit: SERVER,
			handler: report('margin', margin),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/reports/summary',
			auth: 'server',
			feature: 'reports',
			rateLimit: SERVER,
			handler: report('summary', summary),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/reports/sell-through',
			auth: 'server',
			feature: 'reports',
			rateLimit: SERVER,
			handler: report('sell-through', sellThrough),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/reports/oldest-stock',
			auth: 'server',
			feature: 'reports',
			rateLimit: SERVER,
			handler: report('oldest-stock', oldestStock),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/reports/sales',
			auth: 'ticket',
			feature: 'reports',
			permission: 'reports.read',
			rateLimit: SERVER,
			handler: report('sales', sales),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/reports/stock-age',
			auth: 'ticket',
			feature: 'reports',
			permission: 'reports.read',
			rateLimit: SERVER,
			handler: report('stock-age', stockAge),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/reports/returns',
			auth: 'ticket',
			feature: 'reports',
			permission: 'reports.read',
			rateLimit: SERVER,
			handler: report('returns', returnRate),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/reports/margin',
			auth: 'ticket',
			feature: 'reports',
			permission: 'reports.read',
			rateLimit: SERVER,
			handler: report('margin', margin),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/reports/summary',
			auth: 'ticket',
			feature: 'reports',
			permission: 'reports.read',
			rateLimit: SERVER,
			handler: report('summary', summary),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/reports/sell-through',
			auth: 'ticket',
			feature: 'reports',
			permission: 'reports.read',
			rateLimit: SERVER,
			handler: report('sell-through', sellThrough),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/reports/oldest-stock',
			auth: 'ticket',
			feature: 'reports',
			permission: 'reports.read',
			rateLimit: SERVER,
			handler: report('oldest-stock', oldestStock),
		}),
	];

	return { routes };
};
