/**
 * The catalog's part of the import (PLAN 0.8.10 K10, Migration steps 3 and 5): categories, brands, attributes, size
 * charts, landing pages, products with their variants and photos, serials, deals and bundles, each checked with the
 * product's own check in import mode (`core/imports-catalog.js`). Each call reads once what its checks need
 * (`prepare`), and refuses slugs, SKUs, variant ids, serial numbers and landing combinations another record already
 * holds, in the database or earlier in the same call, so a dry run shows them too (the unique indexes stay the last
 * guard). Its finish steps run before the orders' part: they derive every category's path from the parents
 * (categories come in any order) and the products' price, price range, stock state and grades again, a page at a time,
 * writing only what changed, so a second run changes nothing. Everything is written straight to the database: no event, message, alert,
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
import { checkUnit } from '../core/fields.js';
import { loadRules, unitRulesOf } from './catalog-store.js';

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
 * @property {ReadonlyArray<import('../core/item-types.js').ItemType>} types the merchant's item types
 * @property {Map<string, import('../core/item-types.js').UnitRules | null>} units how a product's units are numbered
 *   (null: its item type numbers none), read once
 */

/** The most categories a website has (the product reads at most this many anywhere). */
const MAX_CATEGORIES = 5000;
/** Ids named in finish's summary. */
const LISTED = 20;
/** A key in finish's `next`: a record's id. */
// eslint-disable-next-line no-control-regex
const ID_KEY = /^[^\u0000-\u001f]{1,200}$/;

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
			const types = /** @type {import('../core/item-types.js').ItemType[]} */ (await deps.list(websiteId, 'item_types'));
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
							parcels: features.has('delivery_zones'),
							gradeKeys,
							types,
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
					types,
					...(categories ? { categories } : {}),
					...(rules ? { rules } : {}),
				},
				taken: new Map(),
				variants: new Map(),
				types,
				units: new Map(),
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
	 * Refuse a slug another record of the collection holds (E13: slugs are unique per website; with `perCategory`, an
	 * attribute's slug is unique among the attributes for the same category, E45).
	 * @param {string} collection @param {string} what @param {boolean} [perCategory]
	 * @returns {(value: Record<string, any>, data: WebsiteData, prepared: Prepared) => Promise<FieldError[]>}
	 */
	const uniqueSlug =
		(collection, what, perCategory = false) =>
		async (value, data, prepared) => {
			if (!value.slug) return [];
			const scope = perCategory ? { categoryId: value.categoryId ?? null } : {};
			const other =
				heldInCall(
					prepared,
					`${collection}.slug:${perCategory ? `${scope.categoryId ?? ''}:` : ''}${value.slug}`,
					value.id,
				) ?? (await heldInDatabase(data, collection, { slug: value.slug, ...scope }, value.id));
			return other
				? [
						{
							path: '/slug',
							message: perCategory
								? `Another ${what} (${other}) for the same category already uses this slug.`
								: `Another ${what} (${other}) already uses this slug.`,
						},
					]
				: [];
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
	 * Check a unit against its product: the variant must be imported and the product's item type must number its units;
	 * the unit's values against the type's unit fields (formats, required fields; without unit fields a plain serial
	 * number), as when units are added to stock; a serial given beside the values must be the one they name; and none of its numbers may be another
	 * unit's (in this import or in the shop). The unit is then kept as the shop keeps it (its serial, values and keys).
	 * @param {Record<string, any>} value @param {WebsiteData} data @param {Prepared} prepared
	 * @returns {Promise<FieldError[]>}
	 */
	const unitClashes = async (value, data, prepared) => {
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
		if (errors.length > 0) return errors;
		if (!prepared.units.has(value.productId)) {
			const has = (/** @type {string} */ feature) => prepared.context.features.has(feature);
			const units = await unitRulesOf(data, [value.productId], { types: prepared.types, has });
			prepared.units.set(value.productId, units.get(value.productId) ?? null);
		}
		const rules = prepared.units.get(value.productId);
		if (!rules) return [{ path: '/productId', message: 'The item type of this product numbers no units.' }];
		const unit = checkUnit(value.values === undefined ? value.serial : { values: value.values }, rules.fields);
		if (!unit.ok) return [{ path: unit.path || '/serial', message: unit.message }];
		if (value.serial !== undefined && value.serial !== unit.value.serial)
			return [{ path: '/serial', message: `The unit's serial is ${unit.value.serial}, the first value of its unit fields.` }];
		for (const key of unit.value.keys) {
			const other =
				heldInCall(prepared, `serials.key:${key}`, value.id) ??
				(await heldInDatabase(data, COLLECTIONS.serials, { keys: key }, value.id));
			if (other)
				return [
					{ path: '/serial', message: `Another unit (${other}) already has the number ${key.replace(/^[^:]+:/, '')}.` },
				];
		}
		// kept as the shop keeps a unit
		Object.assign(value, unit.value);
		return [];
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
			unique: uniqueSlug(COLLECTIONS.attributes, 'attribute', true),
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
			unique: unitClashes,
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
	 * Categories' paths from their parents, a page of them by id (the tree is read whole, at most 5,000), written where
	 * they changed; every page that reaches them names the tree's problems.
	 * @param {any} ctx @param {{ after: string | null, limit: number }} page
	 * @returns {Promise<import('./imports.js').FinishPage>}
	 */
	const finishCategories = async (ctx, { after, limit }) => {
		const data = /** @type {WebsiteData} */ (await ctx.data());
		const collection = data.collection(COLLECTIONS.categories);
		const rows = /** @type {Array<{ id: string, parentId?: string | null, path?: string[] }>} */ (
			await collection
				.find({ websiteId: data.websiteId }, { projection: { _id: 0, id: 1, parentId: 1, path: 1 } })
				.sort({ id: 1 })
				.limit(MAX_CATEGORIES + 1)
				.toArray()
		);
		if (rows.length > MAX_CATEGORIES) return { read: 0, last: null, counts: { categoryProblems: { tooMany: true } } };
		const { paths, orphans, cycles, tooDeep } = categoryPaths(rows);
		const page = rows.filter((row) => after === null || row.id > after).slice(0, limit);
		let changed = 0;
		for (const row of page) {
			const path = /** @type {string[]} */ (paths.get(row.id));
			if (JSON.stringify(path) === JSON.stringify(row.path)) continue;
			await collection.updateOne({ websiteId: data.websiteId, id: row.id }, { $set: { path } });
			changed += 1;
		}
		return {
			read: page.length,
			last: page.at(-1)?.id ?? null,
			counts: {
				categoriesChecked: page.length,
				categoriesChanged: changed,
				categoryProblems: {
					orphans: orphans.slice(0, LISTED),
					cycles: cycles.slice(0, LISTED),
					tooDeep: tooDeep.slice(0, LISTED),
				},
			},
		};
	};

	/**
	 * Products' price, highest price, in stock, stock state and grades from their variants (as a save derives them), a
	 * page of products by id, written where they changed.
	 * @param {any} ctx @param {{ after: string | null, limit: number }} page
	 * @returns {Promise<import('./imports.js').FinishPage>}
	 */
	const finishProducts = async (ctx, { after, limit }) => {
		const data = /** @type {WebsiteData} */ (await ctx.data());
		const products = data.collection(COLLECTIONS.products);
		const batch = /** @type {Array<Record<string, any>>} */ (
			await products
				.find(
					{ websiteId: data.websiteId, ...(after === null ? {} : { id: { $gt: after } }) },
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
				.limit(limit)
				.toArray()
		);
		let changed = 0;
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
		return {
			read: batch.length,
			last: batch.length === 0 ? null : String(batch[batch.length - 1]?.id),
			counts: { productsChecked: batch.length, productsChanged: changed },
		};
	};

	/** @type {import('./imports.js').FinishStep[]} */
	const steps = [
		{
			name: 'categories',
			key: ID_KEY,
			zero: { categoriesChecked: 0, categoriesChanged: 0 },
			run: finishCategories,
		},
		{ name: 'products', key: ID_KEY, zero: { productsChecked: 0, productsChanged: 0 }, run: finishProducts },
	];

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

	return { collections, steps, totals };
};
