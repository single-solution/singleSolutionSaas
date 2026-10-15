/**
 * Products for the merchant's staff (PLAN 0.8.8 Catalog; PLAN 0.8.10 E2–E13): list with search and filters (status,
 * kind, category, several brands and grades, featured, stock state, photos, low stock), create, read, change, delete,
 * stock (set or adjust per variant, per location with multi-location stock, and sold out), and the variant generator
 * (every missing combination of a product's set-up attribute values, for one product or many). Each route exists for
 * the merchant's server (`/v1/products…`, server token) and for the catalog admin widget (`/v1/admin/products…`,
 * ticket with `catalog.edit`), sharing one handler. The list has counts with the same filters (`count`, and `counts`
 * by `status`, `brand`, `stockState`, `featured`, `grade` and `category`; PLAN 0.8.10 K4; and by `variantStock`, the
 * variants out of stock, low on stock by the `catalog` setting `lowStock` and in stock, E44). Low stock (`lowStock=1`)
 * is a sellable variant with 1 to `lowStock` units on a product that tracks stock and is not archived (E44). A changed
 * slug keeps the old one (E13). A product with units in stock keeps its item type (409).
 * Every write is in the activity log (with the product's name), tells the other parts (alerts) what changed, and sends
 * the page to IndexNow when the website asks (E16).
 * @module
 */
import { createId } from '@ss/contracts';
import { countHandlers, created, defineRoute, ok, paginate, problem } from '@ss/app-kit';
import {
	NO_ID,
	brandsOf,
	categoriesOf,
	findProduct,
	freeSlugIn,
	isDuplicate,
	productTypes,
	rewriteProduct,
	skusTaken,
	slugTaken,
	stockedUnits,
} from '../adapters/catalog-store.js';
import {
	LIMITS,
	checkProduct,
	checkStockChanges,
	changedStock,
	heldKeys,
	missingVariants,
	productType,
	summarize,
} from '../core/catalog.js';
import { VIDEO_TYPES } from '../core/catalog-content.js';
import { afterFilter, cursorKey, listOf, staffFilter, variantStockCounts, variantStockPipeline } from '../core/catalog-query.js';
import { nextPreviousSlugs } from '../core/links.js';
import { withDescendants } from '../core/catalog-taxonomy.js';
import { staffProductOf, staffRowOf } from '../core/catalog-views.js';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import { IMAGE_TYPES, bodyOf, refuse, STAFF_LIMITS } from './catalog-common.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./catalog-common.js').CatalogCommon} CatalogCommon */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').VariantRecord} VariantRecord */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */

/** The staff list's order. */
const STAFF_SORT = /** @type {const} */ ({ field: 'createdAt', dir: -1 });
/** Most products of one bulk generation (E7). */
const MAX_GENERATE = 100;

/**
 * What a stock change did, for the activity log: `<SKU or option values>: <before> → <after>` per changed variant.
 * @param {VariantRecord[]} before
 * @param {VariantRecord[]} after
 */
const stockDetail = (before, after) =>
	after
		.flatMap((variant) => {
			const was = before.find((v) => v.id === variant.id)?.stock;
			if (was === undefined || was === variant.stock) return [];
			const name = variant.sku || Object.values(variant.options).join(' / ') || variant.id;
			return [`${name}: ${was} → ${variant.stock}`];
		})
		.join(', ');

/**
 * Which variants were marked sold out or for sale again, for the activity log.
 * @param {VariantRecord[]} before
 * @param {VariantRecord[]} after
 */
const soldOutDetail = (before, after) =>
	after
		.flatMap((variant) => {
			const was = before.find((v) => v.id === variant.id)?.soldOut === true;
			const now = variant.soldOut;
			if (was === now) return [];
			const name = variant.sku || Object.values(variant.options).join(' / ') || variant.id;
			return [`${name}: ${now ? 'sold out' : 'for sale'}`];
		})
		.join(', ');

/**
 * @param {Product} product
 * @param {Service} service
 * @param {CatalogCommon} common
 */
export const createCatalogProducts = (product, service, common) => {
	const { now } = product;

	/** @param {Site} s @param {ProductRecord} item */
	const staffView = async (s, item) =>
		staffProductOf(item, {
			media: await common.mediaUrls(s, item),
			variantMedia: await common.variantMediaUrls(s, item),
			video: item.video?.kind === 'file' ? await common.media.mediaUrl(s, item.video.key) : null,
			type: /** @type {import('../core/item-types.js').ItemType} */ (
				(await productTypes(await s.data(), [item], await s.list('item_types'))).get(item.id)
			),
		});

	/**
	 * Fill in the type and size of files the change names that the product did not have yet (its video, variant
	 * photos), checked in the bucket first (E4, E6).
	 * @param {Site} s @param {ProductRecord | null} before @param {import('../core/catalog.js').ProductFields} fields
	 */
	const checkFiles = async (s, before, fields) => {
		const known = new Set([
			...(before?.media ?? []).map((file) => file.key),
			...(before?.variants ?? []).flatMap((variant) => variant.media.map((file) => file.key)),
		]);
		const photos = [...new Set(fields.variants.flatMap((v) => v.media.map((file) => file.key)))].filter(
			(key) => !known.has(key),
		);
		const { imageMaxBytes, videoMaxBytes } = await s.values('catalog');
		const facts = await common.fileFacts(s, photos, {
			types: Object.keys(IMAGE_TYPES),
			maxBytes: Number(imageMaxBytes),
			path: '/variants',
			what: 'A variant photo',
		});
		const productFacts = new Map((before?.media ?? []).map((file) => [file.key, { type: file.type, size: file.size }]));
		const variants = fields.variants.map((variant) => ({
			...variant,
			media: variant.media.map((file) => ({ ...file, ...(facts.get(file.key) ?? productFacts.get(file.key) ?? {}) })),
		}));
		let video = fields.video;
		if (video?.kind === 'file' && !video.type) {
			const found = await common.fileFacts(s, [video.key], {
				types: Object.keys(VIDEO_TYPES),
				maxBytes: Number(videoMaxBytes),
				path: '/video/key',
				what: 'The video',
			});
			video = { ...video, .../** @type {{ type: string, size: number }} */ (found.get(video.key)) };
		}
		return { ...fields, variants, video };
	};

	/**
	 * Send an active product's page to IndexNow (E16).
	 * @param {Site} s @param {ProductRecord} item
	 */
	const announce = async (s, item) => {
		if (item.status === 'active') await common.indexNow(s, [await common.media.productUrl(s, item)]);
	};

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

	/**
	 * The staff list's filter (`q`, `status`, `kind`, `category` with its subcategories, `brand`, `lowStock`), without
	 * `websiteId` and the page; the list and its counts share it.
	 * @param {any} ctx
	 */
	const staffSource = async (ctx) => {
		const { s, data } = await common.open(ctx);
		/** @type {string[] | null} */
		let categoryIds = null;
		if (ctx.query.category) {
			const categories = await categoriesOf(data);
			const found = categories.find((c) => c.id === ctx.query.category || c.slug === ctx.query.category);
			categoryIds = found ? withDescendants(found.id, categories) : [];
		}
		/** @type {string[] | null} several brands: any of them (E2) */
		let brandIds = null;
		const wanted = listOf(ctx.query.brand);
		if (wanted.length > 0)
			brandIds = (await brandsOf(data)).filter((b) => wanted.includes(b.id) || wanted.includes(b.slug)).map((b) => b.id);
		const { lowStock } = await s.values('catalog');
		return { s, data, inner: staffFilter(ctx.query, { categoryIds, brandIds, lowStock: Number(lowStock) }) };
	};

	const kitCounts = countHandlers({
		source: async (ctx) => {
			const { data, inner } = await staffSource(ctx);
			return { collection: data.collection(COLLECTIONS.products), filter: { websiteId: data.websiteId, $and: [inner] } };
		},
		by: { status: 'status', brand: 'brandId', stockState: 'stockState', featured: 'featured' },
	});

	/** Counts by a list field: a product counts under each value it holds (`none` without), its total once. */
	const LIST_COUNTS = Object.freeze(/** @type {Record<string, string>} */ ({ grade: 'grades', category: 'categoryIds' }));

	/**
	 * Counts by `grade` and `category` group each product under every grade its active variants have and every category
	 * it is in (`none` without one); `variantStock` counts offered variants as `out`, `low` and `in` (E44); the other
	 * fields are the kit's (K4).
	 */
	const counts = {
		count: kitCounts.count,
		/** @param {any} ctx */
		counts: async (ctx) => {
			if (ctx.query.by === 'variantStock') {
				// the offered variants of tracked products not archived, by the catalog's low-stock level (E44)
				const { s, data, inner } = await staffSource(ctx);
				const { lowStock } = await s.values('catalog');
				const rows = await data
					.collection(COLLECTIONS.products)
					.aggregate(variantStockPipeline(data.websiteId, inner, Number(lowStock)), {
						maxTimeMS: 3000,
					})
					.toArray();
				const counted = variantStockCounts(/** @type {Array<{ _id: unknown, n: unknown }>} */ (rows));
				// as every count answers: groups with none are left out
				const groups = Object.fromEntries(Object.entries(counted).filter(([, n]) => n > 0));
				return { total: counted.out + counted.low + counted.in, groups };
			}
			const field = LIST_COUNTS[String(ctx.query.by)];
			if (!field) return kitCounts.counts(ctx);
			const { data, inner } = await staffSource(ctx);
			const products = data.collection(COLLECTIONS.products);
			const filter = { websiteId: data.websiteId, $and: [inner] };
			const [total, rows] = await Promise.all([
				products.countDocuments(filter, { maxTimeMS: 3000 }),
				products
					.aggregate(
						[
							{ $match: filter },
							{
								$project: {
									g: { $cond: [{ $gt: [{ $size: { $ifNull: [`$${field}`, []] } }, 0] }, `$${field}`, ['none']] },
								},
							},
							{ $unwind: '$g' },
							{ $group: { _id: '$g', n: { $sum: 1 } } },
							{ $sort: { n: -1, _id: 1 } },
							{ $limit: 50 },
						],
						{ maxTimeMS: 3000 },
					)
					.toArray(),
			]);
			return { total, groups: Object.fromEntries(rows.map((row) => [String(row._id), Number(row.n)])) };
		},
	};

	/** @param {any} ctx */
	const list = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const { s, data, inner } = await staffSource(ctx);
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
			previousSlugs: [],
			publishedAt: fields.status === 'active' ? new Date(now()) : null,
			contentUpdatedAt: new Date(now()),
		};
		try {
			await data.collection(COLLECTIONS.products).insertOne({ ...record });
		} catch (error) {
			if (isDuplicate(error)) throw problem('conflict', 'Another product already uses this slug.');
			throw error;
		}
		await service.log(ctx, 'product.created', id, { label: record.name, detail: `Status: ${record.status}` });
		await common.changed(s, [], [id]);
		// SEO copy written on save (E43) is answered too
		let saved = /** @type {ProductRecord} */ (await findProduct(data, id));
		await service.emit('product.saved', s, { product: saved, replace: (/** @type {ProductRecord} */ next) => (saved = next) });
		await announce(s, saved);
		return created(await staffView(s, saved));
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
		// new files are checked in the bucket before the transaction (E4, E6)
		const first = checkProduct(body, rules, existing);
		if (!first.ok) throw refuse(first.errors);
		// units in stock were numbered by the product's item type: it keeps its type while it has some
		if (
			productType(existing, rules).key !== productType(first.value, rules).key &&
			(await stockedUnits(data, [existing.id])).size > 0
		)
			throw problem(
				'conflict',
				'This product has units in stock: its item type cannot change until they are sold or removed.',
			);
		const files = await checkFiles(s, existing, first.value);
		const done = await rewriteProduct(
			data,
			existing.id,
			async (before, session) => {
				const checked = checkProduct(body, rules, before);
				if (!checked.ok) throw refuse(checked.errors);
				const facts = new Map([...files.variants.flatMap((v) => v.media), ...before.media].map((file) => [file.key, file]));
				const fields = {
					...checked.value,
					variants: checked.value.variants.map((variant) => ({
						...variant,
						media: variant.media.map((file) => ({
							...file,
							type: facts.get(file.key)?.type ?? file.type,
							size: facts.get(file.key)?.size ?? file.size,
							// a product photo used by a variant keeps its text unless the variant gives one
							alt: file.alt || facts.get(file.key)?.alt || '',
						})),
					})),
					video:
						checked.value.video?.kind === 'file' && !checked.value.video.type && files.video?.kind === 'file'
							? files.video
							: checked.value.video,
				};
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
				// the old slug keeps finding the product (E13)
				return {
					set: { ...fields, slug, previousSlugs: nextPreviousSlugs(before.previousSlugs, before.slug, slug) },
					result: null,
				};
			},
			{ now: now() },
		);
		if (!done.found || !done.product) throw problem('not_found', 'There is no such product.');
		await service.log(ctx, 'product.updated', existing.id, {
			label: done.product.name,
			...(done.before.status === done.product.status ? {} : { detail: `${done.before.status} → ${done.product.status}` }),
		});
		await common.changed(s, [done.before]);
		// SEO copy written on save (E43) is answered too
		let saved = done.product;
		await service.emit('product.saved', s, { product: saved, replace: (/** @type {ProductRecord} */ next) => (saved = next) });
		await announce(s, saved);
		return staffView(s, saved);
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
		// every file of the product under its folder: photos with their sizes, variant photos and the video (E4, E6);
		// keys an import kept in other folders may be shared with other records, so they stay (CA-5)
		const folder = `ecommerce/products/${existing.id}/`;
		const keys = [...heldKeys(existing)].filter((key) => key.startsWith(folder));
		const storage = keys.length > 0 ? await product.connections.storage(s.websiteId) : null;
		for (const key of storage ? keys : []) await /** @type {any} */ (storage).deleteObject({ key }).catch(() => null);
		await service.log(ctx, 'product.deleted', existing.id, { label: existing.name });
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
					if (change.soldOut !== undefined) variant.soldOut = change.soldOut;
					if (change.set === undefined && change.adjust === undefined) return;
					const next = changedStock(variant, change);
					if (!next) throw problem('conflict', 'Stock cannot go below 0.');
					Object.assign(variant, next);
				});
				return { set: { variants }, result: null };
			},
			{ now: now() },
		);
		if (!done.found || !done.product) throw problem('not_found', 'There is no such product.');
		await service.log(ctx, 'product.stock_changed', existing.id, {
			label: done.product.name,
			detail: [
				stockDetail(done.before.variants, done.product.variants),
				soldOutDetail(done.before.variants, done.product.variants),
			]
				.filter(Boolean)
				.join(', '),
		});
		await common.changed(s, [done.before]);
		return staffView(s, done.product);
	};

	/**
	 * Add every missing combination of a product's set-up variant attribute values (E7).
	 * @param {Site} s @param {WebsiteData} data @param {any} ctx @param {string} id
	 * @param {{ price: number | null, stock: number }} start null price: the product's lowest price
	 */
	const generateFor = async (s, data, ctx, id, start) => {
		const rules = await common.rulesOf(s, data);
		const done = await rewriteProduct(
			data,
			id,
			async (before) => {
				const missing = missingVariants(before, rules.attributes, {
					price: start.price ?? before.price,
					stock: rules.locations ? null : start.stock,
				});
				if (missing === null) throw problem('conflict', `A product has at most ${LIMITS.generated} variants.`);
				if (missing.length === 0) return { refuse: 0 };
				const checked = checkProduct(
					{ variants: [...before.variants.map((variant) => ({ id: variant.id })), ...missing] },
					rules,
					before,
				);
				if (!checked.ok) throw refuse(checked.errors);
				return { set: { variants: checked.value.variants, options: checked.value.options }, result: missing.length };
			},
			{ now: now() },
		);
		if (!done.found) throw problem('not_found', 'There is no such product.');
		if (done.changed && done.product) {
			await service.log(ctx, 'product.variants_generated', id, {
				label: done.product.name,
				detail: `${done.result} variant(s) added`,
			});
			await common.changed(s, [done.before]);
		}
		return { added: Number(done.result ?? 0), product: done.product ?? done.before };
	};

	/**
	 * The generator's starting price and stock from the body.
	 * @param {Record<string, any>} body
	 */
	const startOf = (body) => {
		const price = body.price ?? null;
		const stock = body.stock ?? 0;
		if (price !== null && (!Number.isSafeInteger(price) || price < 0))
			throw refuse([{ path: '/price', message: 'The price is a whole number of minor units from 0.' }]);
		if (!Number.isSafeInteger(stock) || stock < 0)
			throw refuse([{ path: '/stock', message: 'Stock is a whole number from 0.' }]);
		return { price: /** @type {number | null} */ (price), stock: /** @type {number} */ (stock) };
	};

	/** POST /v1/products/:id/variants/generate `{ price, stock }`. @param {any} ctx */
	const generate = async (ctx) => {
		const { s, data } = await common.open(ctx);
		const existing = await productOf(data, ctx);
		const body = bodyOf(ctx);
		if (body.price === undefined) throw refuse([{ path: '/price', message: 'Give the price of the new variants.' }]);
		const done = await generateFor(s, data, ctx, existing.id, startOf(body));
		return { added: done.added, product: await staffView(s, done.product) };
	};

	/**
	 * POST /v1/products/variants/generate `{ ids, price?, stock? }`: up to 100 products. A product that gets none says
	 * why: the English `error`, the problem `code` and, for a refused check, the `path` of the field (the widgets show
	 * their words for the field or the code, PLAN 0.4.10).
	 * @param {any} ctx
	 */
	const generateMany = async (ctx) => {
		const body = bodyOf(ctx);
		const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((id) => typeof id === 'string'))] : [];
		if (ids.length === 0 || ids.length > MAX_GENERATE)
			throw refuse([{ path: '/ids', message: `Give 1 to ${MAX_GENERATE} product ids.` }]);
		const start = startOf(body);
		const { s, data } = await common.open(ctx);
		/** @type {Array<{ id: string, added: number } | { id: string, error: string, code: string, path?: string }>} */
		const results = [];
		for (const id of ids) {
			try {
				results.push({ id, added: (await generateFor(s, data, ctx, id, start)).added });
			} catch (error) {
				const failed = /** @type {any} */ (error);
				const path = failed?.errors?.[0]?.path;
				results.push({
					id,
					error: String(failed?.body?.detail ?? failed?.detail ?? 'failed'),
					code: typeof failed?.code === 'string' ? failed.code : 'failed',
					...(typeof path === 'string' ? { path } : {}),
				});
			}
		}
		return { results, added: results.reduce((sum, row) => sum + ('added' in row ? row.added : 0), 0) };
	};

	return [
		defineRoute({
			method: 'POST',
			path: '/v1/products/variants/generate',
			auth: 'server',
			feature: 'variants',
			rateLimit: STAFF_LIMITS,
			handler: generateMany,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/products/:id/variants/generate',
			auth: 'server',
			feature: 'variants',
			rateLimit: STAFF_LIMITS,
			handler: generate,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/products/variants/generate',
			auth: 'ticket',
			permission: 'catalog.edit',
			feature: 'variants',
			rateLimit: STAFF_LIMITS,
			handler: generateMany,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/products/:id/variants/generate',
			auth: 'ticket',
			permission: 'catalog.edit',
			feature: 'variants',
			rateLimit: STAFF_LIMITS,
			handler: generate,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/products',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: list,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/products/count',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: counts.count,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/products/counts',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: counts.counts,
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
			method: 'GET',
			path: '/v1/admin/products/count',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: counts.count,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/products/counts',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: counts.counts,
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
