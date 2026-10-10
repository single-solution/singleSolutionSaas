/**
 * Size charts for the merchant's staff (PLAN 0.8.10 E5): create, read, change and delete, for the merchant's server
 * (`/v1/size-charts…`, server token) and the catalog admin widget (`/v1/admin/size-charts…`, ticket with
 * `catalog.edit`), sharing one handler. Products, brands and categories name a chart by `sizeChartId`; a chart they
 * name cannot be deleted (409 `conflict`). Shoppers get the resolved chart on the product page.
 * @module
 */
import { createId } from '@ss/contracts';
import { created, defineRoute, problem } from '@ss/app-kit';
import { NO_ID } from '../adapters/catalog-store.js';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import { checkSizeChart } from '../core/size-charts.js';
import { refuse, STAFF_LIMITS } from './catalog-common.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./catalog-common.js').CatalogCommon} CatalogCommon */
/** @typedef {import('../core/model.js').SizeChartRecord} SizeChartRecord */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */

/** At most this many charts per website. */
const MAX_CHARTS = 1000;

/**
 * @param {Product} product
 * @param {Service} service
 * @param {CatalogCommon} common
 */
export const createCatalogCharts = (product, service, common) => {
	/**
	 * A chart by id, or 404.
	 * @param {WebsiteData} data @param {string} id
	 * @returns {Promise<SizeChartRecord>}
	 */
	const chartOf = async (data, id) => {
		const found = await data.collection(COLLECTIONS.sizeCharts).findOne({ websiteId: data.websiteId, id }, NO_ID);
		if (!found) throw problem('not_found', 'There is no such size chart.');
		return /** @type {SizeChartRecord} */ (/** @type {unknown} */ (found));
	};

	/**
	 * How many products, brands and categories name a chart.
	 * @param {WebsiteData} data @param {string} id
	 */
	const usesOf = async (data, id) => {
		const filter = { websiteId: data.websiteId, sizeChartId: id };
		const [products, brands, categories] = await Promise.all([
			data.collection(COLLECTIONS.products).countDocuments(filter),
			data.collection(COLLECTIONS.brands).countDocuments(filter),
			data.collection(COLLECTIONS.categories).countDocuments(filter),
		]);
		return { products, brands, categories };
	};

	/** GET: every chart with how many records use it. @param {any} ctx */
	const list = async (ctx) => {
		const { data } = await common.open(ctx);
		const charts = /** @type {SizeChartRecord[]} */ (
			await data
				.collection(COLLECTIONS.sizeCharts)
				.find({ websiteId: data.websiteId }, NO_ID)
				.sort({ name: 1, id: 1 })
				.limit(MAX_CHARTS)
				.toArray()
		);
		return { items: await Promise.all(charts.map(async (chart) => ({ ...chart, uses: await usesOf(data, chart.id) }))) };
	};

	/** @param {any} ctx */
	const read = async (ctx) => {
		const { data } = await common.open(ctx);
		const chart = await chartOf(data, String(ctx.params.id));
		return { ...chart, uses: await usesOf(data, chart.id) };
	};

	/** @param {any} ctx */
	const create = async (ctx) => {
		const { data } = await common.open(ctx);
		const checked = checkSizeChart(ctx.body, null);
		if (!checked.ok) throw refuse(checked.errors);
		if ((await data.collection(COLLECTIONS.sizeCharts).countDocuments({ websiteId: data.websiteId })) >= MAX_CHARTS)
			throw problem('conflict', `A website has at most ${MAX_CHARTS} size charts.`);
		/** @type {SizeChartRecord} */
		const record = { id: createId(ID_PREFIX.sizeChart), ...checked.value };
		await data.collection(COLLECTIONS.sizeCharts).insertOne({ ...record });
		await service.log(ctx, 'size_chart.created', record.id, { label: record.name });
		return created({ ...record, uses: { products: 0, brands: 0, categories: 0 } });
	};

	/** @param {any} ctx */
	const update = async (ctx) => {
		const { data } = await common.open(ctx);
		const existing = await chartOf(data, String(ctx.params.id));
		const checked = checkSizeChart(ctx.body, existing);
		if (!checked.ok) throw refuse(checked.errors);
		await data
			.collection(COLLECTIONS.sizeCharts)
			.updateOne({ websiteId: data.websiteId, id: existing.id }, { $set: checked.value });
		await service.log(ctx, 'size_chart.updated', existing.id, { label: checked.value.name });
		return { id: existing.id, ...checked.value, uses: await usesOf(data, existing.id) };
	};

	/** @param {any} ctx */
	const remove = async (ctx) => {
		const { data } = await common.open(ctx);
		const existing = await chartOf(data, String(ctx.params.id));
		const uses = await usesOf(data, existing.id);
		if (uses.products + uses.brands + uses.categories > 0)
			throw problem('conflict', 'Products, brands or categories use this size chart: change them first.');
		await data.collection(COLLECTIONS.sizeCharts).deleteOne({ websiteId: data.websiteId, id: existing.id });
		await service.log(ctx, 'size_chart.deleted', existing.id, { label: existing.name });
		return undefined;
	};

	return [
		defineRoute({
			method: 'GET',
			path: '/v1/size-charts',
			auth: 'server',
			feature: 'size_charts',
			rateLimit: STAFF_LIMITS,
			handler: list,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/size-charts',
			auth: 'server',
			feature: 'size_charts',
			idempotent: true,
			rateLimit: STAFF_LIMITS,
			handler: create,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/size-charts/:id',
			auth: 'server',
			feature: 'size_charts',
			rateLimit: STAFF_LIMITS,
			handler: read,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/size-charts/:id',
			auth: 'server',
			feature: 'size_charts',
			rateLimit: STAFF_LIMITS,
			handler: update,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/size-charts/:id',
			auth: 'server',
			feature: 'size_charts',
			rateLimit: STAFF_LIMITS,
			handler: remove,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/size-charts',
			auth: 'ticket',
			permission: 'catalog.edit',
			feature: 'size_charts',
			rateLimit: STAFF_LIMITS,
			handler: list,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/size-charts',
			auth: 'ticket',
			permission: 'catalog.edit',
			feature: 'size_charts',
			idempotent: true,
			rateLimit: STAFF_LIMITS,
			handler: create,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/size-charts/:id',
			auth: 'ticket',
			permission: 'catalog.edit',
			feature: 'size_charts',
			rateLimit: STAFF_LIMITS,
			handler: read,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/admin/size-charts/:id',
			auth: 'ticket',
			permission: 'catalog.edit',
			feature: 'size_charts',
			rateLimit: STAFF_LIMITS,
			handler: update,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/size-charts/:id',
			auth: 'ticket',
			permission: 'catalog.edit',
			feature: 'size_charts',
			rateLimit: STAFF_LIMITS,
			handler: remove,
		}),
	];
};
