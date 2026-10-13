/**
 * The catalog's part of the import (PLAN 0.8.10 K10, Migration steps 3 and 5): categories, brands, attributes, size
 * charts, landing pages, products with their variants and photos, serials, deals and bundles, each checked with the
 * product's own check in import mode (`core/imports-catalog.js`). Each call reads once what its checks need
 * (`prepare`), and refuses slugs, SKUs, variant ids, serial numbers and landing combinations another record already
 * holds, in the database or earlier in the same call, so a dry run shows them too (the unique indexes stay the last
 * guard). Its finish runs before the orders' part: it derives every category's path from the parents (categories come
 * in any order) and the products' price, price range, stock state and grades again, in batches, writing only what
 * changed, so a second run changes nothing. Everything is written straight to the database: no event, message, alert,
 * IndexNow call or activity copy. Its sums are what `ss-import verify` compares.
 * @module
 */
import { summarize } from '../core/catalog.js';
import { gradesByKey } from '../core/grades.js';
import {
	categoryPaths,
	checkImportedAttribute,
	checkImportedBrand,
	checkImportedBundle,
	checkImportedCategory,
	checkImportedDeal,
	checkImportedLanding,
	checkImportedProduct,
	checkImportedSerial,
	checkImportedSizeChart,
	offerProductIds,
} from '../core/imports-catalog.js';
import { COLLECTIONS } from '../core/model.js';
import { loadRules } from './catalog-store.js';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('@ss/app-kit').ImportCollection} ImportCollection */
/** @typedef {Parameters<ImportCollection['check']>[1]} CheckContext */
/** @typedef {Parameters<NonNullable<ImportCollection['prepare']>>[0]} PrepareContext */
/** @typedef {import('../core/imports-catalog.js').ImportContext} ImportContext */
/** @typedef {import('../core/imports-catalog.js').ImportChecked} ImportChecked */
/** @typedef {import('../core/catalog.js').FieldError} FieldError */

/**
 * What one import call shares between its checks.
 * @typedef {object} Prepared
 * @property {ImportContext} context
 * @property {Map<string, string>} taken unique values this call's records hold → the record holding each
 * @property {Map<string, Set<string> | null>} variants a product's variant ids (null: no such product), read once
 */

/** The most categories a website has (the product reads at most this many anywhere). */
const MAX_CATEGORIES = 5000;
/** Products read per batch by finish. */
const BATCH = 500;
/** Ids named in finish's summary. */
const LISTED = 20;

/**
 * @param {import('./imports.js').ImportDeps} deps
 * @returns {import('./imports.js').ImportPart}
 */
export const catalogImports = (deps) => {
	/**
	 * The ids of a collection's records.
	 * @param {WebsiteData} data @param {string} collection
	 */
	const idsIn = async (data, collection) =>
		new Set((await data.collection(collection).distinct('id', { websiteId: data.websiteId })).map(String));

	/**
	 * What a call's checks read once: the switched-on features, the grades list, the ids records may name, the stored
	 * categories' paths (`categories`), and the catalog rules (`rules`, products).
	 * @param {{ categories?: boolean, rules?: boolean }} [needs]
	 * @returns {(ctx: PrepareContext) => Promise<Prepared>}
	 */
	const prepareWith =
		(needs = {}) =>
		async (ctx) => {
			const { data, websiteId } = ctx;
			const features = new Set(await deps.featuresOn(websiteId));
			const gradeKeys = features.has('grades_serials') ? [...gradesByKey(await deps.list(websiteId, 'grades')).keys()] : [];
			const [categoryIds, brandIds, sizeChartIds, locationIds] = await Promise.all([
				idsIn(data, COLLECTIONS.categories),
				idsIn(data, COLLECTIONS.brands),
				idsIn(data, COLLECTIONS.sizeCharts),
				features.has('multi_location') ? idsIn(data, COLLECTIONS.locations) : new Set(),
			]);
			const categories = needs.categories
				? new Map(
						(
							await data
								.collection(COLLECTIONS.categories)
								.find({ websiteId }, { projection: { _id: 0, id: 1, path: 1 } })
								.limit(MAX_CATEGORIES)
								.toArray()
						).map((row) => [String(row.id), { path: /** @type {string[]} */ (row.path) }]),
					)
				: undefined;
			const rules = needs.rules
				? {
						...(await loadRules(data, {
							variants: features.has('variants'),
							locations: features.has('multi_location'),
							grades: features.has('grades_serials'),
							digital: features.has('digital_goods'),
							bookings: features.has('bookings'),
							gradeKeys,
						})),
						sizeCharts: features.has('size_charts'),
						sizeChartIds,
						importing: true,
					}
				: undefined;
			return {
				context: {
					now: ctx.now(),
					features,
					categoryIds,
					brandIds,
					sizeChartIds,
					gradeKeys: new Set(gradeKeys),
					locationIds: /** @type {Set<string>} */ (locationIds),
					...(categories ? { categories } : {}),
					...(rules ? { rules } : {}),
				},
				taken: new Map(),
				variants: new Map(),
			};
		};

	/**
	 * Note a unique value this call's record holds; the record of this call that held it first, if another.
	 * @param {Prepared} prepared @param {string} key @param {string} id
	 * @returns {string | null}
	 */
	const heldInCall = (prepared, key, id) => {
		const other = prepared.taken.get(key);
		if (other !== undefined && other !== id) return other;
		prepared.taken.set(key, id);
		return null;
	};

	/**
	 * Another record of a collection holding a value (its id), or null.
	 * @param {WebsiteData} data @param {string} collection @param {Record<string, unknown>} match @param {string} id
	 * @returns {Promise<string | null>}
	 */
	const heldInDatabase = async (data, collection, match, id) => {
		const found = await data
			.collection(collection)
			.findOne({ websiteId: data.websiteId, ...match, id: { $ne: id } }, { projection: { _id: 0, id: 1 } });
		return found ? String(found.id) : null;
	};

	/**
	 * Refuse a slug another record of the collection holds (E13: slugs are unique per website).
	 * @param {string} collection @param {string} what
	 * @returns {(value: Record<string, any>, data: WebsiteData, prepared: Prepared) => Promise<FieldError[]>}
	 */
	const uniqueSlug = (collection, what) => async (value, data, prepared) => {
		if (!value.slug) return [];
		const other =
			heldInCall(prepared, `${collection}.slug:${value.slug}`, value.id) ??
			(await heldInDatabase(data, collection, { slug: value.slug }, value.id));
		return other ? [{ path: '/slug', message: `Another ${what} (${other}) already uses this slug.` }] : [];
	};

	/**
	 * Refuse products an offer names that are not imported.
	 * @param {Record<string, any>} value @param {WebsiteData} data
	 * @returns {Promise<FieldError[]>}
	 */
	const offerProducts = async (value, data) => {
		const ids = offerProductIds(value);
		if (ids.length === 0) return [];
		const found = new Set(
			(
				await data
					.collection(COLLECTIONS.products)
					.find({ websiteId: data.websiteId, id: { $in: ids } }, { projection: { _id: 0, id: 1 } })
					.toArray()
			).map((row) => String(row.id)),
		);
		const missing = ids.filter((id) => !found.has(id));
		return missing.length > 0
			? [
					{
						path: value.items?.length ? '/items' : '/scope/productIds',
						message: `There is no product ${missing.slice(0, 5).join(', ')}.`,
					},
				]
			: [];
	};

	/**
	 * Refuse a product's slug, SKUs and variant ids that another product holds.
	 * @param {Record<string, any>} value @param {WebsiteData} data @param {Prepared} prepared
	 * @returns {Promise<FieldError[]>}
	 */
	const productClashes = async (value, data, prepared) => {
		/** @type {Array<{ id: string, sku: string }>} */
		const variants = value.variants;
		const skus = variants.map((variant) => variant.sku).filter(Boolean);
		const variantIds = variants.map((variant) => variant.id);
		const others = /** @type {Array<{ id: string, slug: string, variants: Array<{ id: string, sku: string }> }>} */ (
			await data
				.collection(COLLECTIONS.products)
				.find(
					{
						websiteId: data.websiteId,
						id: { $ne: value.id },
						$or: [
							{ slug: value.slug },
							...(skus.length > 0 ? [{ 'variants.sku': { $in: skus } }] : []),
							{ 'variants.id': { $in: variantIds } },
						],
					},
					{ projection: { _id: 0, id: 1, slug: 1, 'variants.id': 1, 'variants.sku': 1 } },
				)
				// at most one other product per slug, SKU and variant id the record has
				.limit(1 + 2 * variants.length)
				.toArray()
		);
		/** @param {(other: (typeof others)[number]) => boolean} test */
		const holder = (test) => others.find(test)?.id ?? null;
		/** @type {FieldError[]} */
		const errors = [];
		const slugHolder =
			heldInCall(prepared, `products.slug:${value.slug}`, value.id) ?? holder((other) => other.slug === value.slug);
		if (slugHolder) errors.push({ path: '/slug', message: `Another product (${slugHolder}) already uses this slug.` });
		variants.forEach((variant, index) => {
			const idHolder =
				heldInCall(prepared, `products.variant:${variant.id}`, value.id) ??
				holder((other) => other.variants.some((v) => v.id === variant.id));
			if (idHolder)
				errors.push({ path: `/variants/${index}/id`, message: `Another product (${idHolder}) already has this variant id.` });
			if (!variant.sku) return;
			const skuHolder =
				heldInCall(prepared, `products.sku:${variant.sku}`, value.id) ??
				holder((other) => other.variants.some((v) => v.sku === variant.sku));
			if (skuHolder)
				errors.push({
					path: `/variants/${index}/sku`,
					message: `Another product (${skuHolder}) already uses the SKU ${variant.sku}.`,
				});
		});
		return errors;
	};

	/**
	 * Refuse a serial number another unit holds, and a variant that is not imported.
	 * @param {Record<string, any>} value @param {WebsiteData} data @param {Prepared} prepared
	 * @returns {Promise<FieldError[]>}
	 */
	const serialClashes = async (value, data, prepared) => {
		/** @type {FieldError[]} */
		const errors = [];
		if (!prepared.variants.has(value.productId)) {
			const found = await data
				.collection(COLLECTIONS.products)
				.findOne({ websiteId: data.websiteId, id: value.productId }, { projection: { _id: 0, 'variants.id': 1 } });
			prepared.variants.set(
				value.productId,
				found ? new Set(found.variants.map((/** @type {{ id: string }} */ v) => v.id)) : null,
			);
		}
		const variantIds = prepared.variants.get(value.productId);
		if (!variantIds) errors.push({ path: '/productId', message: `There is no product ${value.productId}.` });
		else if (!variantIds.has(value.variantId))
			errors.push({ path: '/variantId', message: `The product has no variant ${value.variantId}.` });
		const other =
			heldInCall(prepared, `serials.serial:${value.serial}`, value.id) ??
			(await heldInDatabase(data, COLLECTIONS.serials, { serial: value.serial }, value.id));
		if (other) errors.push({ path: '/serial', message: `Another unit (${other}) already has this serial number.` });
		return errors;
	};

	/**
	 * Refuse a landing page for a combination another one has (E15).
	 * @param {Record<string, any>} value @param {WebsiteData} data @param {Prepared} prepared
	 * @returns {Promise<FieldError[]>}
	 */
	const landingClashes = async (value, data, prepared) => {
		const match = { categoryId: value.categoryId, brandId: value.brandId, grade: value.grade };
		const other =
			heldInCall(prepared, `landings:${JSON.stringify(match)}`, value.id) ??
			(await heldInDatabase(data, COLLECTIONS.landings, match, value.id));
		return other
			? [{ path: '/categoryId', message: `Another landing page (${other}) has this category, brand and grade.` }]
			: [];
	};

	/**
	 * A collection the import writes: its pure check, then what needs the database.
	 * @param {{ collection: string, prepare: (ctx: PrepareContext) => Promise<Prepared>,
	 *   check: (record: Record<string, unknown>, context: ImportContext) => ImportChecked,
	 *   unique?: (value: Record<string, any>, data: WebsiteData, prepared: Prepared) => Promise<FieldError[]> }} definition
	 * @returns {ImportCollection}
	 */
	const imported = ({ collection, prepare, check, unique }) => ({
		collection,
		prepare,
		check: async (record, ctx) => {
			const prepared = /** @type {Prepared} */ (ctx.prepared);
			const checked = check(record, prepared.context);
			if (!checked.ok || !unique) return checked;
			const errors = await unique(checked.value, ctx.data, prepared);
			return errors.length > 0 ? { ok: false, errors } : checked;
		},
	});

	const plain = prepareWith();

	/** @type {Record<string, ImportCollection>} */
	const collections = {
		size_charts: imported({ collection: COLLECTIONS.sizeCharts, prepare: plain, check: checkImportedSizeChart }),
		categories: imported({
			collection: COLLECTIONS.categories,
			prepare: prepareWith({ categories: true }),
			check: checkImportedCategory,
			unique: uniqueSlug(COLLECTIONS.categories, 'category'),
		}),
		brands: imported({
			collection: COLLECTIONS.brands,
			prepare: plain,
			check: checkImportedBrand,
			unique: uniqueSlug(COLLECTIONS.brands, 'brand'),
		}),
		attributes: imported({
			collection: COLLECTIONS.attributes,
			prepare: plain,
			check: checkImportedAttribute,
			unique: uniqueSlug(COLLECTIONS.attributes, 'attribute'),
		}),
		landings: imported({
			collection: COLLECTIONS.landings,
			prepare: plain,
			check: checkImportedLanding,
			unique: landingClashes,
		}),
		products: imported({
			collection: COLLECTIONS.products,
			prepare: prepareWith({ rules: true }),
			check: checkImportedProduct,
			unique: productClashes,
		}),
		serials: imported({
			collection: COLLECTIONS.serials,
			prepare: plain,
			check: checkImportedSerial,
			unique: serialClashes,
		}),
		deals: imported({
			collection: COLLECTIONS.deals,
			prepare: plain,
			check: checkImportedDeal,
			unique: async (value, data, prepared) => [
				...(await uniqueSlug(COLLECTIONS.deals, 'deal')(value, data, prepared)),
				...(await offerProducts(value, data)),
			],
		}),
		bundles: imported({
			collection: COLLECTIONS.bundles,
			prepare: plain,
			check: checkImportedBundle,
			unique: offerProducts,
		}),
	};

	// ---------------------------------------------------------------------------------------------------- finish

	/**
	 * Every category's path from its parents, written where it changed; the tree's problems are named.
	 * @param {WebsiteData} data
	 */
	const finishCategories = async (data) => {
		const collection = data.collection(COLLECTIONS.categories);
		const rows = /** @type {Array<{ id: string, parentId?: string | null, path?: string[] }>} */ (
			await collection
				.find({ websiteId: data.websiteId }, { projection: { _id: 0, id: 1, parentId: 1, path: 1 } })
				.sort({ id: 1 })
				.limit(MAX_CATEGORIES + 1)
				.toArray()
		);
		if (rows.length > MAX_CATEGORIES) return { checked: 0, changed: 0, tooMany: true };
		const { paths, orphans, cycles, tooDeep } = categoryPaths(rows);
		let changed = 0;
		for (const row of rows) {
			const path = /** @type {string[]} */ (paths.get(row.id));
			if (JSON.stringify(path) === JSON.stringify(row.path)) continue;
			await collection.updateOne({ websiteId: data.websiteId, id: row.id }, { $set: { path } });
			changed += 1;
		}
		return {
			checked: rows.length,
			changed,
			orphans: orphans.slice(0, LISTED),
			cycles: cycles.slice(0, LISTED),
			tooDeep: tooDeep.slice(0, LISTED),
		};
	};

	/**
	 * Every product's price, highest price, in stock, stock state and grades from its variants (as a save derives
	 * them), read in batches by id, written where they changed.
	 * @param {WebsiteData} data
	 */
	const finishProducts = async (data) => {
		const products = data.collection(COLLECTIONS.products);
		let checked = 0;
		let changed = 0;
		let after = '';
		for (;;) {
			const batch = /** @type {Array<Record<string, any>>} */ (
				await products
					.find(
						{ websiteId: data.websiteId, id: { $gt: after } },
						{
							projection: {
								_id: 0,
								id: 1,
								trackStock: 1,
								price: 1,
								priceMax: 1,
								inStock: 1,
								stockState: 1,
								grades: 1,
								'variants.active': 1,
								'variants.price': 1,
								'variants.stock': 1,
								'variants.soldOut': 1,
								'variants.grade': 1,
							},
						},
					)
					.sort({ id: 1 })
					.limit(BATCH)
					.toArray()
			);
			for (const row of batch) {
				const next = summarize(row.variants, row.trackStock === true);
				const same =
					next.price === row.price &&
					next.priceMax === row.priceMax &&
					next.inStock === row.inStock &&
					next.stockState === row.stockState &&
					JSON.stringify(next.grades) === JSON.stringify(row.grades);
				if (same) continue;
				await products.updateOne({ websiteId: data.websiteId, id: row.id }, { $set: next });
				changed += 1;
			}
			checked += batch.length;
			if (batch.length < BATCH) break;
			after = String(batch[batch.length - 1]?.id);
		}
		return { checked, changed };
	};

	/** @param {any} ctx */
	const finish = async (ctx) => {
		const data = /** @type {WebsiteData} */ (await ctx.data());
		return { catalog: { categories: await finishCategories(data), products: await finishProducts(data) } };
	};

	// ---------------------------------------------------------------------------------------------------- totals

	/** @param {any} ctx */
	const totals = async (ctx) => {
		const data = /** @type {WebsiteData} */ (await ctx.data());
		const match = { $match: { websiteId: data.websiteId } };
		const [catalog] = await data
			.collection(COLLECTIONS.products)
			.aggregate([
				match,
				{
					$group: {
						_id: null,
						products: { $sum: 1 },
						active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
						draft: { $sum: { $cond: [{ $eq: ['$status', 'draft'] }, 1, 0] } },
						variants: { $sum: { $size: { $ifNull: ['$variants', []] } } },
						activeVariants: {
							$sum: {
								$size: { $filter: { input: { $ifNull: ['$variants', []] }, cond: { $eq: ['$$this.active', true] } } },
							},
						},
						units: { $sum: { $sum: '$variants.stock' } },
					},
				},
			])
			.toArray();
		const serials = await data
			.collection(COLLECTIONS.serials)
			.aggregate([match, { $group: { _id: '$status', count: { $sum: 1 } } }])
			.toArray();
		/** @param {string} collection */
		const used = async (collection) =>
			Number(
				(
					await data
						.collection(collection)
						.aggregate([match, { $group: { _id: null, used: { $sum: '$used' } } }])
						.toArray()
				)[0]?.used ?? 0,
			);
		/** @param {string} status */
		const units = (status) => Number(serials.find((row) => row._id === status)?.count ?? 0);
		return {
			products: Number(catalog?.products ?? 0),
			'products.active': Number(catalog?.active ?? 0),
			'products.draft': Number(catalog?.draft ?? 0),
			variants: Number(catalog?.variants ?? 0),
			'variants.active': Number(catalog?.activeVariants ?? 0),
			'stock.units': Number(catalog?.units ?? 0),
			'serials.in_stock': units('in_stock'),
			'serials.sold': units('sold'),
			'serials.faulty': units('faulty'),
			'deals.used': await used(COLLECTIONS.deals),
			'bundles.used': await used(COLLECTIONS.bundles),
		};
	};

	return { collections, finish, totals };
};
