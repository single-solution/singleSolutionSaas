/**
 * Products for the merchant's staff (PLAN 0.8.8 Catalog): list with search and filters, create, read, change, delete,
 * and stock (set or adjust per variant, per location with multi-location stock). Each route exists for the merchant's
 * server (`/v1/products…`, server token) and for the catalog admin widget (`/v1/admin/products…`, ticket with
 * `catalog.edit`), sharing one handler. Every write is in the activity log and tells the other parts (alerts) what
 * changed.
 * @module
 */
import { createId } from '@ss/contracts';
import { created, defineRoute, ok, paginate, problem } from '@ss/app-kit';
import {
	NO_ID,
	brandsOf,
	categoriesOf,
	findProduct,
	freeSlugIn,
	isDuplicate,
	rewriteProduct,
	skusTaken,
	slugTaken,
} from '../adapters/catalog-store.js';
import { checkProduct, checkStockChanges, changedStock, summarize } from '../core/catalog.js';
import { afterFilter, cursorKey, staffFilter } from '../core/catalog-query.js';
import { withDescendants } from '../core/catalog-taxonomy.js';
import { staffProductOf, staffRowOf } from '../core/catalog-views.js';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import { bodyOf, refuse, STAFF_LIMITS } from './catalog-common.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./catalog-common.js').CatalogCommon} CatalogCommon */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').VariantRecord} VariantRecord */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */

/** The staff list's order. */
const STAFF_SORT = /** @type {const} */ ({ field: 'createdAt', dir: -1 });

/**
 * @param {Product} product
 * @param {Service} service
 * @param {CatalogCommon} common
 */
export const createCatalogProducts = (product, service, common) => {
	const { now } = product;

	/** @param {Site} s @param {ProductRecord} item */
	const staffView = async (s, item) => staffProductOf(item, { media: await common.mediaUrls(s, item) });

	/**
	 * The product of a route's `:id` (an id or a slug), or 404.
	 * @param {WebsiteData} data @param {any} ctx
	 */
	const productOf = async (data, ctx) => {
		const found = await findProduct(data, String(ctx.params.id));
		if (!found) throw problem('not_found', 'There is no such product.');
		return found;
	};

	/**
	 * Refuse SKUs used by another product.
	 * @param {WebsiteData} data @param {VariantRecord[]} variants @param {string | null} exceptId @param {any} [session]
	 */
	const checkSkus = async (data, variants, exceptId, session) => {
		const taken = await skusTaken(
			data,
			variants.map((variant) => variant.sku),
			exceptId,
			session,
		);
		if (taken.length > 0) throw problem('conflict', `Another product already uses the SKU ${taken.join(', ')}.`);
	};

	/** @param {any} ctx */
	const list = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const { s, data } = await common.open(ctx);
		/** @type {string[] | null} */
		let categoryIds = null;
		if (ctx.query.category) {
			const categories = await categoriesOf(data);
			const found = categories.find((c) => c.id === ctx.query.category || c.slug === ctx.query.category);
			categoryIds = found ? withDescendants(found.id, categories) : [];
		}
		/** @type {string | null} */
		let brandId = null;
		if (ctx.query.brand)
			brandId = (await brandsOf(data)).find((b) => b.id === ctx.query.brand || b.slug === ctx.query.brand)?.id ?? '';
		const { lowStock } = await s.values('catalog');
		const inner = staffFilter(ctx.query, { categoryIds, brandId, lowStock: Number(lowStock) });
		const after = page.after === null ? null : afterFilter(STAFF_SORT, page.after);
		if (page.after !== null && !after) throw problem('bad_request', 'cursor is invalid');
		const found = /** @type {ProductRecord[]} */ (
			await data
				.collection(COLLECTIONS.products)
				.find({ websiteId: data.websiteId, $and: [inner, ...(after ? [after] : [])] }, NO_ID)
				.sort({ createdAt: -1, id: -1 })
				.limit(page.fetchLimit)
				.toArray()
		);
		const body = page.page(found, (item) => cursorKey(item, STAFF_SORT));
		const items = await Promise.all(
			body.items.map(async (item) => staffRowOf(item, { image: await common.media.mediaUrl(s, item.media?.[0]?.key) })),
		);
		const link = page.link(body.nextCursor);
		return ok({ items, nextCursor: body.nextCursor, hasMore: body.hasMore }, { headers: link ? { link } : {} });
	};

	/** @param {any} ctx */
	const create = async (ctx) => {
		const { s, data } = await common.open(ctx);
		const checked = checkProduct(ctx.body, await common.rulesOf(s, data), null);
		if (!checked.ok) throw refuse(checked.errors);
		const fields = checked.value;
		await checkSkus(data, fields.variants, null);
		if (fields.slug && (await slugTaken(data, COLLECTIONS.products, fields.slug, null)))
			throw problem('conflict', 'Another product already uses this slug.');
		const id = createId(ID_PREFIX.product);
		const slug =
			fields.slug ||
			(await freeSlugIn(data, COLLECTIONS.products, { slug: '', name: fields.name, fallback: id.slice(4).toLowerCase() }));
		/** @type {Omit<ProductRecord, 'createdAt' | 'updatedAt'>} */
		const record = {
			id,
			...fields,
			slug,
			media: [],
			sold: 0,
			rating: { average: 0, count: 0 },
			...summarize(fields.variants, fields.trackStock),
			publishedAt: fields.status === 'active' ? new Date(now()) : null,
		};
		try {
			await data.collection(COLLECTIONS.products).insertOne({ ...record });
		} catch (error) {
			if (isDuplicate(error)) throw problem('conflict', 'Another product already uses this slug.');
			throw error;
		}
		await service.log(ctx, 'product.created', id);
		await common.changed(s, [], [id]);
		return created(await staffView(s, /** @type {ProductRecord} */ (await findProduct(data, id))));
	};

	/** @param {any} ctx */
	const read = async (ctx) => {
		const { s, data } = await common.open(ctx);
		return staffView(s, await productOf(data, ctx));
	};

	/** @param {any} ctx */
	const update = async (ctx) => {
		const { s, data } = await common.open(ctx);
		const existing = await productOf(data, ctx);
		const rules = await common.rulesOf(s, data);
		const body = bodyOf(ctx);
		const done = await rewriteProduct(
			data,
			existing.id,
			async (before, session) => {
				const checked = checkProduct(body, rules, before);
				if (!checked.ok) throw refuse(checked.errors);
				const fields = checked.value;
				await checkSkus(data, fields.variants, before.id, session);
				let slug = fields.slug;
				if (!slug)
					slug = await freeSlugIn(data, COLLECTIONS.products, {
						slug: '',
						name: fields.name,
						exceptId: before.id,
						fallback: before.id.slice(4).toLowerCase(),
					});
				else if (slug !== before.slug && (await slugTaken(data, COLLECTIONS.products, slug, before.id, session)))
					throw problem('conflict', 'Another product already uses this slug.');
				return { set: { ...fields, slug }, result: null };
			},
			{ now: now() },
		);
		if (!done.found || !done.product) throw problem('not_found', 'There is no such product.');
		await service.log(ctx, 'product.updated', existing.id);
		await common.changed(s, [done.before]);
		return staffView(s, done.product);
	};

	/** @param {any} ctx */
	const remove = async (ctx) => {
		const { s, data } = await common.open(ctx);
		const existing = await productOf(data, ctx);
		const ordered = await data
			.collection(COLLECTIONS.orders)
			.countDocuments({ websiteId: data.websiteId, 'lines.productId': existing.id }, { limit: 1 });
		if (ordered > 0) throw problem('conflict', 'This product is in orders: archive it instead.');
		await data.collection(COLLECTIONS.products).deleteOne({ websiteId: data.websiteId, id: existing.id });
		await data.collection(COLLECTIONS.serials).deleteMany({ websiteId: data.websiteId, productId: existing.id });
		const storage = existing.media.length > 0 ? await product.connections.storage(s.websiteId) : null;
		for (const file of storage ? existing.media : [])
			await /** @type {any} */ (storage).deleteObject({ key: file.key }).catch(() => null);
		await service.log(ctx, 'product.deleted', existing.id);
		return undefined;
	};

	/** @param {any} ctx */
	const stock = async (ctx) => {
		const { s, data } = await common.open(ctx);
		const locations = s.has('multi_location');
		const checked = checkStockChanges(ctx.body, { locations });
		if (!checked.ok) throw refuse(checked.errors);
		const existing = await productOf(data, ctx);
		const known = locations
			? new Set((await data.collection(COLLECTIONS.locations).distinct('id', { websiteId: data.websiteId })).map(String))
			: new Set();
		const done = await rewriteProduct(
			data,
			existing.id,
			async (before) => {
				const variants = before.variants.map((variant) => ({ ...variant, locations: { ...variant.locations } }));
				checked.value.forEach((change, index) => {
					const variant = variants.find((v) => v.id === change.variantId);
					if (!variant)
						throw refuse([{ path: `/changes/${index}/variantId`, message: 'This variant is not part of the product.' }]);
					if (change.locationId && !known.has(change.locationId))
						throw refuse([{ path: `/changes/${index}/locationId`, message: 'There is no such location.' }]);
					const next = changedStock(variant, change);
					if (!next) throw problem('conflict', 'Stock cannot go below 0.');
					Object.assign(variant, next);
				});
				return { set: { variants }, result: null };
			},
			{ now: now() },
		);
		if (!done.found || !done.product) throw problem('not_found', 'There is no such product.');
		await service.log(ctx, 'product.stock_changed', existing.id);
		await common.changed(s, [done.before]);
		return staffView(s, done.product);
	};

	return [
		defineRoute({
			method: 'GET',
			path: '/v1/products',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: list,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/products',
			auth: 'server',
			feature: 'catalog',
			idempotent: true,
			rateLimit: STAFF_LIMITS,
			handler: create,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/products/:id',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: read,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/products/:id',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: update,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/products/:id',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: remove,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/products/:id/stock',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: stock,
		}),

		defineRoute({
			method: 'GET',
			path: '/v1/admin/products',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: list,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/products',
			auth: 'ticket',
			permission: 'catalog.edit',
			idempotent: true,
			rateLimit: STAFF_LIMITS,
			handler: create,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/products/:id',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: read,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/admin/products/:id',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: update,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/products/:id',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: remove,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/products/:id/stock',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: stock,
		}),
	];
};
