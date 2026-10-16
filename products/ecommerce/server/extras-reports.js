/**
 * Reports (feature `reports`, PLAN 0.8.8): sales by any grouping (E12: `GET …/reports/groupings` lists them; the
 * products' tags, item types and fields are read from the products, by product or variant), stock age, return rate and
 * margin, (E36) the summary by day (E12: week or month), sell-through and oldest stock, and (E41) shop
 * health, for the merchant's server and the admin widget (permission `reports.read`). Every report answers JSON, or
 * with `format=csv` its rows as a CSV file (the `csv` setting's separator); shop health answers JSON only. Each report reads the merchant database with aggregation
 * pipelines that start with a `$match` on the website (`core/reports.js`); names of categories, brands, statuses and
 * payment methods (the names shoppers see) are read separately (no `$lookup`). Money is minor units of the shop's currency; a day in `from` and `to`, and a day of the
 * summary's series, is a day in the business time zone (PLAN 0.8.10 K8).
 * @module
 */
import { defineRoute } from '@ss/app-kit';
import { toCsv } from '@ss/contracts/csv';
import { measuredScope } from '../adapters/catalog-store.js';
import { attributesOf, productTypes } from '../adapters/catalog-store.js';
import { valueLabel } from '../core/catalog.js';
import { COLLECTIONS } from '../core/model.js';
import { statusLabel } from '../core/orders.js';
import {
	GROUPING_LABELS,
	MAX_ROWS,
	PRODUCT_GROUPINGS,
	REPORT_COLUMNS,
	SALES_GROUPINGS,
	isSeries,
	regroup,
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
import { badTagIds, healthOf, healthPipeline, paymentMethodsOn, taxonomyHealth } from '../core/health.js';
import { paidByHand } from '../core/payment-methods.js';
import { daysRange } from '../core/seo.js';
import { homeRate } from '../core/delivery.js';
import { hiddenFor } from './catalog-visibility.js';
import { csvFile } from './catalog-tools.js';
import { SERVER_LIMITS } from './service.js';

/** Rate limits (mutable copies of the shared constants, as route definitions take them). */
const SERVER = [...SERVER_LIMITS];
/** At most this many categories and brands are read for shop health. */
const MAX_TAXONOMY = 5000;
/** At most this many products (or variants) a sales report regroups by their tags, item types or fields (E12). */
const MAX_REGROUPED = 20_000;
/** The kinds of fields a sales report groups by (E12). */
const GROUPED_FIELDS = Object.freeze(['product', 'variant', 'order']);

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

	/**
	 * The groupings a site's sales report offers (E12): the built-in ones of its switched-on features, then each product,
	 * variant and order field (`field:<id>`, named by the field).
	 * @param {Site} s @param {WebsiteData} data
	 */
	const groupingsOf = async (s, data) => {
		const fields = /** @type {import('../core/model.js').AttributeRecord[]} */ (await attributesOf(data))
			.filter((field) => GROUPED_FIELDS.includes(field.on))
			.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
		/** @type {Readonly<Record<string, string>>} the feature each built-in grouping needs */
		const needs = { grade: 'grades_serials', zone: 'delivery_zones' };
		return [
			...SALES_GROUPINGS.filter((key) => !needs[key] || s.has(needs[key])).map((key) => ({
				key,
				label: GROUPING_LABELS[key],
				kind: 'built_in',
			})),
			...fields.map((field) => ({ key: `field:${field.id}`, label: field.name, kind: 'field' })),
		];
	};

	/** GET …/reports/groupings: what the sales report groups by (E12). @param {any} ctx */
	const groupings = async (ctx) => {
		const s = await service.site(ctx);
		return { items: await groupingsOf(s, await s.data()) };
	};

	/**
	 * GET …/reports/sales?by=: sales split by a grouping (E12; the product when none is given).
	 * @param {any} ctx @returns {Promise<Built>}
	 */
	const sales = async (ctx) => {
		const by = ctx.query.by === undefined || ctx.query.by === '' ? 'product' : String(ctx.query.by);
		const { s, data, range, timeZone } = await begin(ctx);
		/** @type {import('../core/model.js').AttributeRecord | null} */
		let field = null;
		if (by.startsWith('field:')) {
			const all = /** @type {import('../core/model.js').AttributeRecord[]} */ (await attributesOf(data));
			field = all.find((one) => one.id === by.slice('field:'.length) && GROUPED_FIELDS.includes(one.on)) ?? null;
			if (!field) throw service.invalid('by', 'There is no such product, variant or order field.');
		} else if (!(/** @type {readonly string[]} */ (SALES_GROUPINGS).includes(by)))
			throw service.invalid('by', `by is ${SALES_GROUPINGS.join(', ')} or field:<id> (GET …/reports/groupings).`);
		const orders = data.collection(COLLECTIONS.orders);
		/** @param {unknown} value */
		const keyOf = (value) => (value === null || value === undefined ? '' : String(value));
		/** @type {Array<{ key: string, name: string, units: number, revenue: number, discount: number }>} */
		let list;
		if (/** @type {readonly string[]} */ (PRODUCT_GROUPINGS).includes(by) || (field && field.on !== 'order')) {
			// read from the lines' products: their tags, item types and fields
			const perVariant = field?.on === 'variant';
			const rows = await orders
				.aggregate(
					salesPipeline(data.websiteId, range, s.currency, perVariant ? 'variant' : 'product', {
						timeZone,
						limit: MAX_REGROUPED,
					}),
				)
				.toArray();
			const ids = rows.map((row) => String(row._id ?? '')).filter(Boolean);
			const products = /** @type {Array<import('../core/model.js').ProductRecord>} */ (
				ids.length === 0
					? []
					: await data
							.collection(COLLECTIONS.products)
							.find(
								{ websiteId: data.websiteId, ...(perVariant ? { 'variants.id': { $in: ids } } : { id: { $in: ids } }) },
								{
									projection: { _id: 0, id: 1, kind: 1, typeKey: 1, categoryIds: 1, tags: 1, specs: 1, variants: 1 },
								},
							)
							.toArray()
			);
			/** @type {Map<string, Array<{ key: string, name: string }>>} values by product id (or variant id) */
			const values = new Map();
			/** @param {unknown} value */
			const fieldValues = (value) =>
				(Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value]).map((one) => ({
					key: keyOf(one),
					name: valueLabel(/** @type {any} */ (field), one),
				}));
			if (by === 'item_type') {
				const types = await productTypes(data, products, await s.list('item_types'));
				for (const product of products) {
					const type = types.get(product.id);
					values.set(product.id, type ? [{ key: type.key, name: type.name || type.key }] : []);
				}
			} else
				for (const product of products) {
					if (by === 'tag')
						values.set(
							product.id,
							product.tags.map((tag) => ({ key: tag, name: tag })),
						);
					else if (perVariant)
						for (const variant of product.variants)
							values.set(variant.id, fieldValues(variant.attributes?.[/** @type {any} */ (field).id]));
					else values.set(product.id, fieldValues(product.specs?.[/** @type {any} */ (field).id]));
				}
			list = regroup(/** @type {any[]} */ (rows), (id) => values.get(id) ?? []);
		} else {
			const rows = await orders.aggregate(salesPipeline(data.websiteId, range, s.currency, by, { timeZone })).toArray();
			const keys = rows.map((row) => keyOf(row._id)).filter(Boolean);
			// names read where the key is an id: categories, brands, payment methods (by the names shoppers see), statuses
			/** @type {(key: string, row: any) => string} */
			let nameOf = (key, row) => (row.name === undefined || row.name === null ? key : String(row.name));
			if (by === 'category' || by === 'brand') {
				const names = await namesOf(data, by === 'category' ? COLLECTIONS.categories : COLLECTIONS.brands, keys);
				nameOf = (key) => names.get(key) ?? '';
			} else if (by === 'payment_method') {
				// the payment methods by the names of the website's list (a key it no longer has reads as itself)
				const names = new Map((await service.methods.methodsOf(s)).map((method) => [method.key, method.name]));
				nameOf = (key) => names.get(key) ?? key;
			} else if (by === 'status') {
				const flow = /** @type {import('../core/model.js').OrderFlow} */ (
					/** @type {unknown} */ (await s.list('order_flow'))
				);
				nameOf = (key) => statusLabel(flow, key);
			} else if (field) nameOf = (key, row) => (key === '' ? '' : valueLabel(field, row._id));
			list = rows.map((row) => {
				const key = keyOf(row._id);
				return {
					key,
					name: nameOf(key, row),
					units: Number(row.units),
					revenue: Number(row.revenue),
					discount: Number(row.discount),
				};
			});
		}
		const [totals] = await orders.aggregate(totalsPipeline(data.websiteId, range, s.currency)).toArray();
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
		const orders = /** @type {Array<{ lines: Array<{ id: string, productId: string, name: string, measure?: unknown }> }>} */ (
			orderIds.length === 0
				? []
				: await data
						.collection(COLLECTIONS.orders)
						.find(
							{ websiteId: data.websiteId, id: { $in: orderIds } },
							{ projection: { _id: 0, 'lines.id': 1, 'lines.productId': 1, 'lines.name': 1, 'lines.measure': 1 } },
						)
						.toArray()
		);
		const lineProducts = new Map(
			orders.flatMap((order) =>
				order.lines.map((line) => [line.id, { productId: line.productId, name: line.name, measure: line.measure }]),
			),
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

	/**
	 * GET …/reports/summary?from=&to=&statuses=&series=day|week|month (E36; E12 weeks and months).
	 * @param {any} ctx @returns {Promise<Built>}
	 */
	const summary = async (ctx) => {
		const series = ctx.query.series === undefined || ctx.query.series === '' ? 'day' : ctx.query.series;
		if (!isSeries(series)) throw service.invalid('series', 'The series is day, week or month.');
		const { s, data, range, timeZone } = await begin(ctx);
		const flow = /** @type {import('../core/model.js').OrderFlow} */ (/** @type {unknown} */ (await s.list('order_flow')));
		const parsed = parseStatuses(ctx.query.statuses, new Set(flow.statuses.map((status) => status.key)));
		if (!parsed.ok) throw service.invalid(parsed.field, parsed.message);
		const rows = await data
			.collection(COLLECTIONS.orders)
			.aggregate(summaryPipeline(data.websiteId, range, s.currency, parsed.statuses, timeZone, series))
			.toArray();
		const { totals, periods } = summaryOf(rows, range, timeZone, series);
		const body = {
			...period(range),
			currency: s.currency,
			statuses: parsed.statuses,
			...totals,
			series,
			periods: periods.map((entry) => ({ period: entry.period, orders: entry.orders, total: entry.total })),
		};
		return { s, body, rows: periods };
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
	 * The payment methods shoppers can use now (E41, E2): the list's active methods the shop can take.
	 * @param {Site} s @param {WebsiteData} data
	 */
	const paymentMethods = async (s, data) => {
		const zones = s.has('delivery_zones') ? await s.values('delivery_zones') : null;
		// pickup is a kind of delivery rate (E5): possible while a zone has one and there is a pickup place
		const pickupRates = /** @type {import('../core/delivery.js').Zone[]} */ (zones ? await s.list('delivery_zones') : []).some(
			(zone) => zone.rates.some((rate) => rate.kind === 'pickup'),
		);
		const pickup =
			zones !== null &&
			pickupRates &&
			(s.has('multi_location')
				? (await data
						.collection(COLLECTIONS.locations)
						.countDocuments({ websiteId: data.websiteId, pickup: true }, { limit: 1 })) > 0
				: zones.pickupEnabled === true);
		return paymentMethodsOn({
			methods: await service.methods.methodsOf(s),
			paymentsConnected: (await product.connections.value(s.websiteId, 'payments')) !== null,
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

	/**
	 * How many active methods paid first (or with an advance paid by hand) do not tell shoppers where to pay (P5-18, E8),
	 * as the cart reads them: no account or instructions of their own, or Payments' method of their key not ready; null
	 * while there is none or Payments does not answer.
	 * @param {Site} s
	 */
	const payUnready = async (s) => {
		if (!s.has('checkout')) return null;
		const methods = await service.methods.methodsOf(s);
		const paymentsConnected = (await product.connections.value(s.websiteId, 'payments')) !== null;
		const details = await service.methods.payDetails(s, methods, paymentsConnected);
		const asked = methods.filter(
			(method) =>
				method.active && (method.kind === 'pay_first' || paidByHand(method)) && (paymentsConnected || paidByHand(method)),
		);
		if (asked.length === 0 || asked.some((method) => !details.has(method.key))) return null;
		return asked.filter((method) => details.get(method.key)?.ready !== true).length;
	};

	/**
	 * Whether staff alerts reach someone (P5-18): recipients, or Accounts staff by permission with the Accounts token,
	 * through Notifications; and the admin page they link to. Null while Staff alerts is off.
	 * @param {Site} s
	 */
	const staffAlertSetup = async (s) => {
		if (!s.has('staff_alerts')) return { staffAlerted: null, adminUrl: null };
		const own = await s.values('staff_alerts');
		const connected = async (/** @type {string} */ name) => (await product.connections.value(s.websiteId, name)) !== null;
		const listed = Array.isArray(own.recipients) && own.recipients.length > 0;
		const staff = typeof own.staffPermission === 'string' && own.staffPermission !== '' && (await connected('accounts'));
		return {
			staffAlerted: (listed || staff) && (await connected('notifications')),
			adminUrl: String(own.adminUrl ?? '').trim() !== '',
		};
	};

	/**
	 * Active product and variant fields without their glossary text, while their glossary pages have an address (G7.2);
	 * null otherwise.
	 * @param {Site} s @param {WebsiteData} data
	 */
	const glossaryGaps = async (s, data) => {
		if (!s.has('landing_pages') || !String((await s.values('landing_pages')).attributeUrl ?? '')) return null;
		return data.collection(COLLECTIONS.attributes).countDocuments({
			websiteId: data.websiteId,
			on: { $in: ['product', 'variant'] },
			active: true,
			'seo.body': { $in: ['', null] },
		});
	};

	/**
	 * The categories shoppers see and the brands, for their SEO checks and empty categories.
	 * @param {Site} s @param {WebsiteData} data
	 */
	const taxonomyOf = async (s, data) => {
		const hidden = await hiddenFor(s);
		const [categories, brands] = await Promise.all([
			data
				.collection(COLLECTIONS.categories)
				.find({ websiteId: data.websiteId }, { projection: { _id: 0, id: 1, path: 1, seo: 1 } })
				.limit(MAX_TAXONOMY)
				.toArray(),
			data
				.collection(COLLECTIONS.brands)
				.find({ websiteId: data.websiteId }, { projection: { _id: 0, seo: 1 } })
				.limit(MAX_TAXONOMY)
				.toArray(),
		]);
		return {
			categories: /** @type {any[]} */ (categories).filter((category) => !hidden.categoryIds.includes(category.id)),
			brands: /** @type {any[]} */ (brands),
		};
	};

	/** GET …/reports/health (E41, P5-18, SEO audit §3.2 A): what needs fixing, with counts and links. @param {any} ctx */
	const health = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const { lowStock, mediaBaseUrl } = await s.values('catalog');
		const zones = s.has('delivery_zones') ? await s.values('delivery_zones') : null;
		const feeds = s.has('feeds') ? await s.values('feeds') : null;
		const skuAs = feeds?.skuAs === 'gtin' || feeds?.skuAs === 'mpn' ? feeds.skuAs : 'none';
		const { brandIds: hiddenBrandIds } = await hiddenFor(s);
		const [[facets], business, methods, tags, storage, unready, alerts, glossary, taxonomy] = await Promise.all([
			data
				.collection(COLLECTIONS.products)
				.aggregate(
					healthPipeline(data.websiteId, Number(lowStock), {
						domain: s.domain,
						skuAs,
						hiddenBrandIds,
						measured: await measuredScope(data, await s.list('item_types')),
					}),
				)
				.toArray(),
			s.business(),
			paymentMethods(s, data),
			badTags(s),
			product.connections.storage(s.websiteId),
			payUnready(s),
			staffAlertSetup(s),
			glossaryGaps(s, data),
			taxonomyOf(s, data),
		]);
		// images go out on signed links that last an hour while the public address of the images is empty (G1)
		const shortLived = storage ? !/^https:\/\//.test(String(mediaBaseUrl ?? '')) : null;
		return healthOf({
			facets,
			taxonomy: taxonomyHealth({
				...taxonomy,
				stocked: (Array.isArray(facets?.categories) ? facets.categories : []).map((/** @type {any} */ row) =>
					String(row._id),
				),
				domain: s.domain,
			}),
			business,
			domain: s.domain,
			paymentMethods: methods,
			badTags: tags,
			shortLived,
			// the delivery days structured data needs (G5.4), while Delivery zones is on: the handling days and the days of the
			// business country's first plain delivery rate (E5)
			deliveryDays: zones
				? daysRange(zones.handlingDays) !== null &&
					(homeRate(await s.list('delivery_zones'), String(business.country ?? ''))?.minDays ?? null) !== null
				: null,
			setup: {
				storage: storage !== null,
				payUnready: unready,
				...alerts,
				feeds: feeds === null ? null : true,
				missingIdentifiers: feeds?.identifierExists !== 'no',
				glossaryWithoutText: glossary,
			},
		});
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
			path: '/v1/reports/groupings',
			auth: 'server',
			feature: 'reports',
			rateLimit: SERVER,
			handler: groupings,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/reports/groupings',
			auth: 'ticket',
			feature: 'reports',
			permission: 'reports.read',
			rateLimit: SERVER,
			handler: groupings,
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
