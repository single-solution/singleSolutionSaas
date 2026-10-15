/**
 * Categories (nested, with SEO text, status, icon, content and FAQs), brands (status, categories, SEO), attributes
 * (slugs, unique per the category an attribute is for, E45; categories, product or variant values, several values,
 * visibility, card display, glossary), stock locations
 * and serial numbers for the merchant's staff (PLAN 0.8.8 Catalog, Items; PLAN 0.8.10 E1, E5, E7, E11, E13, E16). Each
 * route exists for the merchant's server (`/v1/<things>`, server token) and the catalog admin widget
 * (`/v1/admin/<things>`, ticket with `catalog.edit`), sharing one handler. Deleting what products still use (a category
 * with products or subcategories, a brand or attribute in use, a location holding stock, a sold serial) is refused with
 * 409 `conflict`. A category's changed slug keeps the old one (E13). A category's item type (dynamic model §1) is one of
 * the list (offered, or the one it has) or a built-in one; a change of its type or place that would give products with
 * units in stock another type is refused (409), and units are added only to products whose type numbers them.
 * @module
 */
import { createId } from '@ss/contracts';
import { created, defineRoute, ok, paginate, problem } from '@ss/app-kit';
import {
	NO_ID,
	attributesOf,
	brandsOf,
	categoriesOf,
	freeSlugIn,
	isDuplicate,
	locationsOf,
	slugTaken,
	stockedUnits,
	unitRulesOf,
} from '../adapters/catalog-store.js';
import { cleanText, isObject } from '../core/catalog.js';
import { FIELD_LIMITS, checkUnit, sharedKeys } from '../core/fields.js';
import { typeByKey, typeOf, typeTree } from '../core/item-types.js';
import {
	checkAttribute,
	checkBrand,
	checkCategory,
	checkLocation,
	movedPaths,
	placeCategory,
	withDescendants,
	withoutStamps,
} from '../core/catalog-taxonomy.js';
import { nextPreviousSlugs } from '../core/links.js';
import { sameMeaning } from '../core/measure.js';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import { brandScore, categoryScore } from '../core/seo-score.js';
import { bodyOf, refuse, STAFF_LIMITS } from './catalog-common.js';
import { pageTitlesOf } from './seo-reads.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./catalog-common.js').CatalogCommon} CatalogCommon */
/** @typedef {import('../core/model.js').CategoryRecord} CategoryRecord */
/** @typedef {import('../core/model.js').BrandRecord} BrandRecord */
/** @typedef {import('../core/model.js').AttributeRecord} AttributeRecord */
/** @typedef {import('../core/model.js').LocationRecord} LocationRecord */
/** @typedef {import('../core/model.js').SerialRecord} SerialRecord */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */

/** Most serials added at once. */
const MAX_SERIALS = 500;

/**
 * @param {Product} product
 * @param {Service} service
 * @param {CatalogCommon} common
 */
export const createCatalogTaxonomy = (product, service, common) => {
	/**
	 * A record of a collection by id, or 404.
	 * @template T
	 * @param {WebsiteData} data @param {string} collection @param {string} id @param {string} what
	 * @returns {Promise<T>}
	 */
	const one = async (data, collection, id, what) => {
		const found = await data.collection(collection).findOne({ websiteId: data.websiteId, id }, NO_ID);
		if (!found) throw problem('not_found', `There is no such ${what}.`);
		return /** @type {T} */ (found);
	};

	/** How many products use something. @param {WebsiteData} data @param {Record<string, unknown>} filter */
	const productsWith = (data, filter) =>
		data.collection(COLLECTIONS.products).countDocuments({ websiteId: data.websiteId, ...filter }, { limit: 1 });

	/**
	 * A category or brand as answered: its image or logo with its address (no write stamps), and its SEO score while
	 * SEO is on (E42).
	 * @param {Site} s @param {any} record @param {'image' | 'logo'} field
	 */
	const withImage = async (s, record, field) => ({
		...withoutStamps(record),
		[field]: record[field] ? { ...record[field], url: await common.media.mediaUrl(s, record[field].key) } : null,
		...(s.has('seo') ? { seo: { ...record.seo, ...(await scoreOf(s, record, field)) } } : {}),
	});

	/**
	 * A category's or brand's SEO score, its page's title judged as the SEO answers write it (E42).
	 * @param {Site} s @param {any} record @param {'image' | 'logo'} field
	 */
	const scoreOf = async (s, record, field) => {
		const titles = await pageTitlesOf(s);
		return field === 'image' ? categoryScore(record, titles.category(record)) : brandScore(record, titles.brand(record));
	};

	/**
	 * A slug for a record: the one given (refused when taken) or a free one from the name; within `scope` (an
	 * attribute's category, E45), checked again when the scope moved.
	 * @param {WebsiteData} data @param {string} collection @param {{ slug: string, name: string }} fields
	 * @param {string} id @param {string | null} exceptId @param {string} [current]
	 * @param {{ scope?: Record<string, unknown>, moved?: boolean }} [where]
	 */
	const slugFor = async (data, collection, fields, id, exceptId, current, { scope = {}, moved = false } = {}) => {
		if (!fields.slug)
			return freeSlugIn(data, collection, {
				slug: '',
				name: fields.name,
				exceptId,
				fallback: id.slice(id.indexOf('_') + 1).toLowerCase(),
				scope,
			});
		if ((fields.slug !== current || moved) && (await slugTaken(data, collection, fields.slug, exceptId, undefined, scope)))
			throw problem('conflict', 'This slug is already used.');
		return fields.slug;
	};

	/** @param {unknown} error */
	const slugClash = (error) => {
		if (isDuplicate(error)) return problem('conflict', 'This slug is already used.');
		return error;
	};

	/**
	 * Refuse ids of categories that do not exist.
	 * @param {WebsiteData} data @param {string[]} ids @param {string} path
	 */
	const checkCategoryIds = async (data, ids, path) => {
		if (ids.length === 0) return;
		const found = new Set(
			(await data.collection(COLLECTIONS.categories).distinct('id', { websiteId: data.websiteId, id: { $in: ids } })).map(
				String,
			),
		);
		const missing = ids.find((id) => !found.has(id));
		if (missing) throw refuse([{ path, message: `There is no category ${missing}.` }]);
	};

	/**
	 * Refuse a size chart that does not exist, or one named while Size charts is off (E5).
	 * @param {Site} s @param {WebsiteData} data @param {string | null} id @param {string | null | undefined} current
	 */
	const checkChart = async (s, data, id, current) => {
		if (id === null || id === current) return;
		if (!s.has('size_charts')) throw refuse([{ path: '/sizeChartId', message: 'Switch on Size charts first.' }]);
		const found = await data.collection(COLLECTIONS.sizeCharts).countDocuments({ websiteId: data.websiteId, id }, { limit: 1 });
		if (found === 0) throw refuse([{ path: '/sizeChartId', message: 'There is no such size chart.' }]);
	};

	/**
	 * Refuse an item type a category names that is not one of the list (or no longer offered, unless it has it already).
	 * @param {Site} s @param {string | null} key @param {string | null | undefined} current
	 */
	const checkTypeKey = async (s, key, current) => {
		if (key === null || key === current) return;
		const found = typeByKey(key, await s.list('item_types'));
		if (!found || !found.active) throw refuse([{ path: '/typeKey', message: 'Pick an item type of your list, or null.' }]);
	};

	/**
	 * Refuse a category change that would give products with units in stock another item type (a product without its
	 * own type has its first category's, or the nearest one above it): their units are numbered by their type; and one
	 * that would measure products with stock in another unit (their stock is counted in their type's unit).
	 * @param {Site} s @param {WebsiteData} data @param {CategoryRecord[]} all every category as it is
	 * @param {CategoryRecord[]} next every category as the change leaves them
	 * @param {string} id the category changed
	 */
	const keepStockedTypes = async (s, data, all, next, id) => {
		/** @type {import('../core/item-types.js').ItemType[]} */
		const types = await s.list('item_types');
		const units = types.some((type) => type.elements.units);
		const measures = types.some((type) => type.elements.measure);
		if (!units && !measures) return;
		const products = await data
			.collection(COLLECTIONS.products)
			.find(
				{ websiteId: data.websiteId, typeKey: null, 'categoryIds.0': { $in: withDescendants(id, all) } },
				{ projection: { _id: 0, id: 1, kind: 1, categoryIds: 1, 'variants.stock': 1 } },
			)
			.toArray();
		const stocked = units
			? await stockedUnits(
					data,
					products.map((row) => String(row.id)),
				)
			: new Set();
		const [before, after] = [typeTree(all), typeTree(next)];
		/**
		 * A product's type before and after the change.
		 * @param {Record<string, any>} row
		 * @returns {[import('../core/item-types.js').ItemType, import('../core/item-types.js').ItemType]}
		 */
		const typesOf = (row) => {
			const product = { kind: String(row.kind), typeKey: null, categoryIds: (row.categoryIds ?? []).map(String) };
			return [typeOf(product, types, before), typeOf(product, types, after)];
		};
		const moved = products.some((row) => {
			if (!stocked.has(String(row.id))) return false;
			const [was, will] = typesOf(row);
			return was.key !== will.key;
		});
		if (moved)
			throw problem(
				'conflict',
				'Products of this category have units in stock: this change would give them another item type.',
			);
		const remeasured = products.some((row) => {
			if (!(row.variants ?? []).some((/** @type {any} */ variant) => Number(variant.stock) > 0)) return false;
			const [was, will] = typesOf(row);
			return !sameMeaning(was.elements.measure, will.elements.measure);
		});
		if (remeasured)
			throw problem(
				'conflict',
				'Products of this category have stock counted in their unit of measure: this change would measure them in another unit.',
			);
	};

	/**
	 * Send a category's page to IndexNow while it is or was active (E16), with its earlier address after a change of
	 * address (SG-32).
	 * @param {Site} s @param {CategoryRecord} category @param {CategoryRecord | null} [before]
	 */
	const announce = async (s, category, before = null) => {
		const urls = [
			...(category.status === 'active' || before?.status === 'active' ? [await common.media.categoryUrl(s, category)] : []),
			...(before?.status === 'active' ? [await common.media.categoryUrl(s, before)] : []),
		];
		await common.indexNow(s, urls);
	};

	// ------------------------------------------------------------------------------------------------ categories

	const categories = {
		/** @param {any} ctx */
		list: async (ctx) => {
			const { s, data } = await common.open(ctx);
			return { items: await Promise.all((await categoriesOf(data)).map((c) => withImage(s, c, 'image'))) };
		},
		/** @param {any} ctx */
		read: async (ctx) => {
			const { s, data } = await common.open(ctx);
			return withImage(s, await one(data, COLLECTIONS.categories, String(ctx.params.id), 'category'), 'image');
		},
		/** @param {any} ctx */
		create: async (ctx) => {
			const { s, data } = await common.open(ctx);
			const checked = checkCategory(ctx.body, null);
			if (!checked.ok) throw refuse(checked.errors);
			await checkChart(s, data, checked.value.sizeChartId, null);
			await checkTypeKey(s, checked.value.typeKey, null);
			const all = await categoriesOf(data);
			const placed = placeCategory(null, checked.value.parentId, new Map(all.map((c) => [c.id, c])));
			if (!placed.ok) throw refuse([{ path: '/parentId', message: placed.message }]);
			const id = createId(ID_PREFIX.category);
			/** @type {CategoryRecord} */
			const record = {
				id,
				...checked.value,
				slug: await slugFor(data, COLLECTIONS.categories, checked.value, id, null),
				path: placed.path,
				image: null,
				previousSlugs: [],
			};
			await data
				.collection(COLLECTIONS.categories)
				.insertOne({ ...record })
				.catch((error) => {
					throw slugClash(error);
				});
			await service.log(ctx, 'category.created', id, { label: record.name });
			await service.emit('page.changed', s, { kind: 'category', id, slug: record.slug });
			await announce(s, record);
			return created(await withImage(s, record, 'image'));
		},
		/** @param {any} ctx */
		update: async (ctx) => {
			const { s, data } = await common.open(ctx);
			/** @type {CategoryRecord} */
			const existing = await one(data, COLLECTIONS.categories, String(ctx.params.id), 'category');
			const checked = checkCategory(ctx.body, existing);
			if (!checked.ok) throw refuse(checked.errors);
			await checkChart(s, data, checked.value.sizeChartId, existing.sizeChartId);
			await checkTypeKey(s, checked.value.typeKey, existing.typeKey);
			const all = await categoriesOf(data);
			const moved = checked.value.parentId !== existing.parentId;
			const placed = moved ? placeCategory(existing.id, checked.value.parentId, new Map(all.map((c) => [c.id, c]))) : null;
			if (placed && !placed.ok) throw refuse([{ path: '/parentId', message: placed.message }]);
			const path = placed?.ok ? placed.path : existing.path;
			if (moved || checked.value.typeKey !== (existing.typeKey ?? null)) {
				const paths = new Map(moved ? movedPaths(existing.id, path, all).map((next) => [next.id, next.path]) : []);
				const next = all.map((category) =>
					category.id === existing.id
						? { ...category, path, typeKey: checked.value.typeKey }
						: { ...category, path: paths.get(category.id) ?? category.path },
				);
				await keepStockedTypes(s, data, all, next, existing.id);
			}
			const slug = await slugFor(data, COLLECTIONS.categories, checked.value, existing.id, existing.id, existing.slug);
			const collection = data.collection(COLLECTIONS.categories);
			const previousSlugs = nextPreviousSlugs(existing.previousSlugs, existing.slug, slug);
			await collection
				.updateOne({ websiteId: data.websiteId, id: existing.id }, { $set: { ...checked.value, slug, path, previousSlugs } })
				.catch((error) => {
					throw slugClash(error);
				});
			if (moved)
				for (const next of movedPaths(existing.id, path, all))
					await collection.updateOne({ websiteId: data.websiteId, id: next.id }, { $set: { path: next.path } });
			await service.log(ctx, 'category.updated', existing.id, {
				label: checked.value.name,
				...(moved ? { detail: 'Moved in the category tree' } : {}),
			});
			/** @type {CategoryRecord} */
			const saved = await one(data, COLLECTIONS.categories, existing.id, 'category');
			await service.emit('page.changed', s, { kind: 'category', id: saved.id, slug: saved.slug });
			await announce(s, saved, existing);
			return withImage(s, saved, 'image');
		},
		/** @param {any} ctx */
		remove: async (ctx) => {
			const { s, data } = await common.open(ctx);
			/** @type {CategoryRecord} */
			const existing = await one(data, COLLECTIONS.categories, String(ctx.params.id), 'category');
			const children = await data
				.collection(COLLECTIONS.categories)
				.countDocuments({ websiteId: data.websiteId, parentId: existing.id }, { limit: 1 });
			if (children > 0) throw problem('conflict', 'Move or delete its subcategories first.');
			if ((await productsWith(data, { categoryIds: existing.id })) > 0)
				throw problem('conflict', 'Products are in this category: move them first.');
			if (
				(await data.collection(COLLECTIONS.landings).countDocuments({ websiteId: data.websiteId, categoryId: existing.id })) >
				0
			)
				throw problem('conflict', 'Landing pages use this category: change or delete them first.');
			if (
				(await data
					.collection(COLLECTIONS.attributes)
					.countDocuments({ websiteId: data.websiteId, categoryId: existing.id }, { limit: 1 })) > 0
			)
				throw problem('conflict', 'Attributes are defined for this category: change or delete them first.');
			await data.collection(COLLECTIONS.categories).deleteOne({ websiteId: data.websiteId, id: existing.id });
			// only a file under its folder: an imported key elsewhere may be shared (CA-5)
			if (existing.image?.key.startsWith(`ecommerce/categories/${existing.id}/`)) {
				const storage = await product.connections.storage(s.websiteId);
				await storage?.deleteObject({ key: existing.image.key }).catch(() => null);
			}
			await service.log(ctx, 'category.deleted', existing.id, { label: existing.name });
			await service.emit('page.changed', s, { kind: 'category', id: existing.id, slug: existing.slug });
			return undefined;
		},
	};

	// ---------------------------------------------------------------------------------------------------- brands

	const brands = {
		/** @param {any} ctx */
		list: async (ctx) => {
			const { s, data } = await common.open(ctx);
			return { items: await Promise.all((await brandsOf(data)).map((b) => withImage(s, b, 'logo'))) };
		},
		/** @param {any} ctx */
		read: async (ctx) => {
			const { s, data } = await common.open(ctx);
			return withImage(s, await one(data, COLLECTIONS.brands, String(ctx.params.id), 'brand'), 'logo');
		},
		/** @param {any} ctx */
		create: async (ctx) => {
			const { s, data } = await common.open(ctx);
			const checked = checkBrand(ctx.body, null);
			if (!checked.ok) throw refuse(checked.errors);
			await checkCategoryIds(data, checked.value.categoryIds, '/categoryIds');
			await checkCategoryIds(data, checked.value.hiddenIn, '/hiddenIn');
			await checkChart(s, data, checked.value.sizeChartId, null);
			const id = createId(ID_PREFIX.brand);
			/** @type {BrandRecord} */
			const record = {
				id,
				...checked.value,
				slug: await slugFor(data, COLLECTIONS.brands, checked.value, id, null),
				logo: null,
			};
			await data
				.collection(COLLECTIONS.brands)
				.insertOne({ ...record })
				.catch((error) => {
					throw slugClash(error);
				});
			await service.log(ctx, 'brand.created', id, { label: record.name });
			await service.emit('page.changed', s, { kind: 'brand', id, slug: record.slug });
			return created(await withImage(s, record, 'logo'));
		},
		/** @param {any} ctx */
		update: async (ctx) => {
			const { s, data } = await common.open(ctx);
			/** @type {BrandRecord} */
			const existing = await one(data, COLLECTIONS.brands, String(ctx.params.id), 'brand');
			const checked = checkBrand(ctx.body, existing);
			if (!checked.ok) throw refuse(checked.errors);
			await checkCategoryIds(data, checked.value.categoryIds, '/categoryIds');
			await checkCategoryIds(data, checked.value.hiddenIn, '/hiddenIn');
			await checkChart(s, data, checked.value.sizeChartId, existing.sizeChartId);
			const slug = await slugFor(data, COLLECTIONS.brands, checked.value, existing.id, existing.id, existing.slug);
			await data
				.collection(COLLECTIONS.brands)
				.updateOne({ websiteId: data.websiteId, id: existing.id }, { $set: { ...checked.value, slug } })
				.catch((error) => {
					throw slugClash(error);
				});
			await service.log(ctx, 'brand.updated', existing.id, { label: checked.value.name });
			await service.emit('page.changed', s, { kind: 'brand', id: existing.id, slug });
			return withImage(s, await one(data, COLLECTIONS.brands, existing.id, 'brand'), 'logo');
		},
		/** @param {any} ctx */
		remove: async (ctx) => {
			const { s, data } = await common.open(ctx);
			/** @type {BrandRecord} */
			const existing = await one(data, COLLECTIONS.brands, String(ctx.params.id), 'brand');
			if ((await productsWith(data, { brandId: existing.id })) > 0)
				throw problem('conflict', 'Products have this brand: change them first.');
			if (
				(await data.collection(COLLECTIONS.landings).countDocuments({ websiteId: data.websiteId, brandId: existing.id })) > 0
			)
				throw problem('conflict', 'Landing pages use this brand: change or delete them first.');
			await data.collection(COLLECTIONS.brands).deleteOne({ websiteId: data.websiteId, id: existing.id });
			// only a file under its folder: an imported key elsewhere may be shared (CA-5)
			if (existing.logo?.key.startsWith(`ecommerce/brands/${existing.id}/`)) {
				const storage = await product.connections.storage(s.websiteId);
				await storage?.deleteObject({ key: existing.logo.key }).catch(() => null);
			}
			await service.log(ctx, 'brand.deleted', existing.id, { label: existing.name });
			await service.emit('page.changed', s, { kind: 'brand', id: existing.id, slug: existing.slug });
			return undefined;
		},
	};

	// ------------------------------------------------------------------------------------------------ attributes

	/**
	 * Check what an attribute names: its categories, and the brands, grades or attribute its visibility depends on.
	 * @param {Site} s @param {WebsiteData} data @param {import('../core/catalog-taxonomy.js').AttributeFields} value
	 * @param {string | null} id the attribute itself
	 */
	const checkAttributeRefs = async (s, data, value, id) => {
		await checkCategoryIds(data, value.categoryIds, '/categoryIds');
		if (value.categoryId) await checkCategoryIds(data, [value.categoryId], '/categoryId');
		const { visibility } = value;
		if (visibility.when === 'brands') {
			const found = new Set(
				(
					await data
						.collection(COLLECTIONS.brands)
						.distinct('id', { websiteId: data.websiteId, id: { $in: visibility.ids } })
				).map(String),
			);
			if (!visibility.ids.every((brand) => found.has(brand)))
				throw refuse([{ path: '/visibility/ids', message: 'Pick existing brands.' }]);
		}
		if (visibility.when === 'grades') {
			const grades = new Set((await common.gradesOf(s)).keys());
			if (!visibility.ids.every((grade) => grades.has(grade)))
				throw refuse([{ path: '/visibility/ids', message: 'Pick grades of your grades list.' }]);
		}
		if (visibility.when === 'attribute') {
			const other = visibility.attributeId;
			if (
				other === id ||
				(await data.collection(COLLECTIONS.attributes).countDocuments({ websiteId: data.websiteId, id: other })) === 0
			)
				throw refuse([{ path: '/visibility/attributeId', message: 'Pick another existing attribute.' }]);
		}
	};

	/**
	 * Whether records hold values of a field: products (their own or their variants'), units, orders or customers, as
	 * the field's values live.
	 * @param {WebsiteData} data @param {AttributeRecord} field
	 */
	const fieldUses = async (data, field) => {
		const one = (/** @type {string} */ collection, /** @type {string} */ path) =>
			data.collection(collection).countDocuments({ websiteId: data.websiteId, [path]: { $exists: true } }, { limit: 1 });
		if (field.on === 'product' || field.on === 'variant')
			return productsWith(data, {
				$or: [{ [`specs.${field.id}`]: { $exists: true } }, { [`variants.attributes.${field.id}`]: { $exists: true } }],
			});
		if (field.on === 'unit') return one(COLLECTIONS.serials, `values.${field.id}`);
		return one(field.on === 'order' ? COLLECTIONS.orders : COLLECTIONS.customers, `fields.${field.id}`);
	};

	/**
	 * Refuse a field more than a shop takes ({@link FIELD_LIMITS.fields}; an item type names at most 3 unit fields, one
	 * of them with two values: `core/item-types.js`).
	 * @param {WebsiteData} data @param {AttributeRecord} next the field as it would be saved
	 */
	const checkFieldLimits = async (data, next) => {
		const fields = (await attributesOf(data)).filter((field) => field.id !== next.id);
		if (fields.length >= FIELD_LIMITS.fields) throw problem('conflict', `A shop has at most ${FIELD_LIMITS.fields} fields.`);
	};

	const attributes = {
		/** @param {any} ctx */
		list: async (ctx) => {
			const { data } = await common.open(ctx);
			return { items: (await attributesOf(data)).map((row) => withoutStamps(row)) };
		},
		/** @param {any} ctx */
		create: async (ctx) => {
			const { s, data } = await common.open(ctx);
			const checked = checkAttribute(ctx.body, null);
			if (!checked.ok) throw refuse(checked.errors);
			await checkAttributeRefs(s, data, checked.value, null);
			const id = createId(ID_PREFIX.attribute);
			await checkFieldLimits(data, { id, ...checked.value });
			// a slug is unique among the attributes for the same category (E45)
			const scope = { categoryId: checked.value.categoryId };
			/** @type {AttributeRecord} */
			const record = {
				id,
				...checked.value,
				slug: await slugFor(data, COLLECTIONS.attributes, checked.value, id, null, undefined, { scope }),
			};
			await data
				.collection(COLLECTIONS.attributes)
				.insertOne({ ...record })
				.catch((error) => {
					throw slugClash(error);
				});
			await service.log(ctx, 'attribute.created', record.id, { label: record.name });
			// SEO copy written on save (E43) is answered too
			let saved = record;
			await service.emit('attribute.saved', s, {
				attribute: saved,
				replace: (/** @type {AttributeRecord} */ next) => (saved = next),
			});
			return created(saved);
		},
		/** @param {any} ctx */
		update: async (ctx) => {
			const { s, data } = await common.open(ctx);
			/** @type {AttributeRecord} */
			const existing = await one(data, COLLECTIONS.attributes, String(ctx.params.id), 'attribute');
			const checked = checkAttribute(ctx.body, existing);
			if (!checked.ok) throw refuse(checked.errors);
			await checkAttributeRefs(s, data, checked.value, existing.id);
			await checkFieldLimits(data, { id: existing.id, ...checked.value });
			const changesShape =
				checked.value.type !== existing.type ||
				checked.value.on !== existing.on ||
				checked.value.maxValues < existing.maxValues;
			if (changesShape && (await fieldUses(data, existing)) > 0)
				throw problem(
					'conflict',
					'Records have values of this field: its type, where its values live and how many it takes cannot change.',
				);
			const slug = await slugFor(data, COLLECTIONS.attributes, checked.value, existing.id, existing.id, existing.slug, {
				scope: { categoryId: checked.value.categoryId },
				moved: checked.value.categoryId !== existing.categoryId,
			});
			await data
				.collection(COLLECTIONS.attributes)
				.updateOne({ websiteId: data.websiteId, id: existing.id }, { $set: { ...checked.value, slug } })
				.catch((error) => {
					throw slugClash(error);
				});
			await service.log(ctx, 'attribute.updated', existing.id, { label: checked.value.name });
			let saved = /** @type {AttributeRecord} */ ({ id: existing.id, ...checked.value, slug });
			await service.emit('attribute.saved', s, {
				attribute: saved,
				replace: (/** @type {AttributeRecord} */ next) => (saved = next),
			});
			return saved;
		},
		/** @param {any} ctx */
		remove: async (ctx) => {
			const { data } = await common.open(ctx);
			/** @type {AttributeRecord} */
			const existing = await one(data, COLLECTIONS.attributes, String(ctx.params.id), 'attribute');
			if ((await fieldUses(data, existing)) > 0)
				throw problem('conflict', 'Records have values of this field: remove them first.');
			await data.collection(COLLECTIONS.attributes).deleteOne({ websiteId: data.websiteId, id: existing.id });
			await service.log(ctx, 'attribute.deleted', existing.id, { label: existing.name });
			return undefined;
		},
	};

	// ------------------------------------------------------------------------------------------------- locations

	const locations = {
		/** @param {any} ctx */
		list: async (ctx) => {
			const { data } = await common.open(ctx);
			return { items: (await locationsOf(data)).map(withoutStamps) };
		},
		/** @param {any} ctx */
		create: async (ctx) => {
			const { data } = await common.open(ctx);
			const checked = checkLocation(ctx.body, null);
			if (!checked.ok) throw refuse(checked.errors);
			/** @type {LocationRecord} */
			const record = { id: createId(ID_PREFIX.location), ...checked.value };
			await data.collection(COLLECTIONS.locations).insertOne({ ...record });
			await service.log(ctx, 'location.created', record.id, { label: record.name });
			return created(record);
		},
		/** @param {any} ctx */
		update: async (ctx) => {
			const { data } = await common.open(ctx);
			/** @type {LocationRecord} */
			const existing = await one(data, COLLECTIONS.locations, String(ctx.params.id), 'location');
			const checked = checkLocation(ctx.body, existing);
			if (!checked.ok) throw refuse(checked.errors);
			await data
				.collection(COLLECTIONS.locations)
				.updateOne({ websiteId: data.websiteId, id: existing.id }, { $set: checked.value });
			await service.log(ctx, 'location.updated', existing.id, { label: checked.value.name });
			return { id: existing.id, ...checked.value };
		},
		/** @param {any} ctx */
		remove: async (ctx) => {
			const { data } = await common.open(ctx);
			/** @type {LocationRecord} */
			const existing = await one(data, COLLECTIONS.locations, String(ctx.params.id), 'location');
			if ((await productsWith(data, { variants: { $elemMatch: { [`locations.${existing.id}`]: { $gt: 0 } } } })) > 0)
				throw problem('conflict', 'This location still holds stock: move it first.');
			await data.collection(COLLECTIONS.locations).deleteOne({ websiteId: data.websiteId, id: existing.id });
			await data
				.collection(COLLECTIONS.products)
				.updateMany(
					{ websiteId: data.websiteId, [`variants.locations.${existing.id}`]: { $exists: true } },
					{ $unset: { [`variants.$[].locations.${existing.id}`]: '' } },
				);
			await service.log(ctx, 'location.deleted', existing.id, { label: existing.name });
			return undefined;
		},
	};

	// --------------------------------------------------------------------------------------------------- serials

	const serials = {
		/** GET ?q=&productId=&variantId=&status=. @param {any} ctx */
		list: async (ctx) => {
			const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 50 });
			const { data } = await common.open(ctx);
			/** @type {Record<string, unknown>} */
			const filter = { websiteId: data.websiteId };
			if (ctx.query.productId) filter.productId = ctx.query.productId;
			if (ctx.query.variantId) filter.variantId = ctx.query.variantId;
			if (['in_stock', 'sold', 'faulty'].includes(ctx.query.status)) filter.status = ctx.query.status;
			const q = cleanText(ctx.query.q ?? '', 64);
			if (q) filter.serial = { $regex: `^${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, $options: 'i' };
			if (page.after !== null) {
				if (typeof page.after !== 'string') throw problem('bad_request', 'cursor is invalid');
				filter.serial = { ...(isObject(filter.serial) ? filter.serial : {}), $gt: page.after };
			}
			const rows = await data
				.collection(COLLECTIONS.serials)
				.find(filter, NO_ID)
				.sort({ serial: 1 })
				.limit(page.fetchLimit)
				.toArray();
			const body = page.page(rows.map(withoutStamps), (row) => row.serial);
			const link = page.link(body.nextCursor);
			return ok(body, { headers: link ? { link } : {} });
		},
		/**
		 * POST `{ productId, variantId, serials: [unit, …], locationId? }` for a product whose item type numbers its units:
		 * each unit its serial number, or, with unit fields, `{ values: { <fieldId>: value or [values] } }` (a text alone
		 * is the first unit field's value), checked against the type's unit fields (formats, required fields); no number
		 * may name two units.
		 * @param {any} ctx
		 */
		add: async (ctx) => {
			const body = bodyOf(ctx);
			/** @type {unknown[]} */
			const list = Array.isArray(body.serials) ? body.serials : [];
			if (list.length === 0 || list.length > MAX_SERIALS)
				throw refuse([{ path: '/serials', message: `Give 1 to ${MAX_SERIALS} units.` }]);
			const { s, data } = await common.open(ctx);
			const found = await data
				.collection(COLLECTIONS.products)
				.findOne(
					{ websiteId: data.websiteId, id: String(body.productId), 'variants.id': String(body.variantId) },
					{ projection: { _id: 0, id: 1, name: 1 } },
				);
			if (!found) throw refuse([{ path: '/variantId', message: 'There is no such product variant.' }]);
			const locationId = typeof body.locationId === 'string' && body.locationId ? body.locationId : null;
			if (
				locationId &&
				(!s.has('multi_location') ||
					!(await data.collection(COLLECTIONS.locations).findOne({ websiteId: data.websiteId, id: locationId })))
			)
				throw refuse([{ path: '/locationId', message: 'There is no such location.' }]);
			const rules = (await unitRulesOf(data, [String(found.id)], { types: await s.list('item_types'), has: s.has })).get(
				String(found.id),
			);
			if (!rules) throw refuse([{ path: '/productId', message: 'The item type of this product numbers no units.' }]);
			const fields = rules.fields;
			/** @type {import('../core/catalog.js').FieldError[]} */
			const errors = [];
			const units = list.flatMap((entry, index) => {
				const unit = checkUnit(typeof entry === 'string' ? entry.trim() : entry, fields);
				if (unit.ok) return [unit.value];
				errors.push({ path: `/serials/${index}${unit.path}`, message: unit.message });
				return [];
			});
			if (errors.length > 0) throw refuse(errors);
			const twice = sharedKeys(units);
			if (twice.length > 0)
				throw refuse([{ path: '/serials', message: `${String(twice[0]).replace(/^[^:]+:/, '')} is given for two units.` }]);
			const taken = await data
				.collection(COLLECTIONS.serials)
				.distinct('serial', { websiteId: data.websiteId, keys: { $in: units.flatMap((unit) => unit.keys) } });
			if (taken.length > 0) throw problem('conflict', `These units are already recorded: ${taken.join(', ')}.`);
			/** @type {SerialRecord[]} */
			const records = units.map((unit) => ({
				id: createId(ID_PREFIX.serial),
				productId: String(body.productId),
				variantId: String(body.variantId),
				serial: unit.serial,
				values: unit.values,
				keys: unit.keys,
				status: 'in_stock',
				orderId: null,
				lineId: null,
				locationId,
			}));
			await data
				.collection(COLLECTIONS.serials)
				.insertMany(records.map((record) => ({ ...record })))
				.catch((error) => {
					throw isDuplicate(error) ? problem('conflict', 'A number of these units is already recorded.') : error;
				});
			await service.log(ctx, 'serials.added', String(body.variantId), {
				label: String(found.name),
				detail: `${records.length} serial number(s) added`,
			});
			return created({ items: records });
		},
		/** PATCH `{ status: 'in_stock' | 'faulty' }`. @param {any} ctx */
		update: async (ctx) => {
			const status = bodyOf(ctx).status;
			if (status !== 'in_stock' && status !== 'faulty')
				throw refuse([{ path: '/status', message: 'Status is in_stock or faulty.' }]);
			const { data } = await common.open(ctx);
			/** @type {SerialRecord} */
			const existing = await one(data, COLLECTIONS.serials, String(ctx.params.id), 'serial number');
			if (existing.status === 'sold') throw problem('conflict', 'This unit was sold: it changes through its order or return.');
			await data
				.collection(COLLECTIONS.serials)
				.updateOne({ websiteId: data.websiteId, id: existing.id, status: { $ne: 'sold' } }, { $set: { status } });
			await service.log(ctx, `serial.${status}`, existing.id, {
				label: existing.serial,
				detail: `${existing.status} → ${status}`,
			});
			return withoutStamps(/** @type {SerialRecord} */ (await one(data, COLLECTIONS.serials, existing.id, 'serial number')));
		},
		/** @param {any} ctx */
		remove: async (ctx) => {
			const { data } = await common.open(ctx);
			/** @type {SerialRecord} */
			const existing = await one(data, COLLECTIONS.serials, String(ctx.params.id), 'serial number');
			if (existing.status === 'sold') throw problem('conflict', 'This unit was sold: it cannot be deleted.');
			await data
				.collection(COLLECTIONS.serials)
				.deleteOne({ websiteId: data.websiteId, id: existing.id, status: { $ne: 'sold' } });
			await service.log(ctx, 'serial.deleted', existing.id, { label: existing.serial });
			return undefined;
		},
	};

	return [
		// categories
		defineRoute({
			method: 'GET',
			path: '/v1/categories',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: categories.list,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/categories',
			auth: 'server',
			feature: 'catalog',
			idempotent: true,
			rateLimit: STAFF_LIMITS,
			handler: categories.create,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/categories/:id',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: categories.read,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/categories/:id',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: categories.update,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/categories/:id',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: categories.remove,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/categories',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: categories.list,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/categories',
			auth: 'ticket',
			permission: 'catalog.edit',
			idempotent: true,
			rateLimit: STAFF_LIMITS,
			handler: categories.create,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/categories/:id',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: categories.read,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/admin/categories/:id',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: categories.update,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/categories/:id',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: categories.remove,
		}),

		// brands
		defineRoute({
			method: 'GET',
			path: '/v1/brands',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: brands.list,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/brands',
			auth: 'server',
			feature: 'catalog',
			idempotent: true,
			rateLimit: STAFF_LIMITS,
			handler: brands.create,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/brands/:id',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: brands.read,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/brands/:id',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: brands.update,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/brands/:id',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: brands.remove,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/brands',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: brands.list,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/brands',
			auth: 'ticket',
			permission: 'catalog.edit',
			idempotent: true,
			rateLimit: STAFF_LIMITS,
			handler: brands.create,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/brands/:id',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: brands.read,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/admin/brands/:id',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: brands.update,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/brands/:id',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: brands.remove,
		}),

		// attributes
		defineRoute({
			method: 'GET',
			path: '/v1/attributes',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: attributes.list,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/attributes',
			auth: 'server',
			feature: 'catalog',
			idempotent: true,
			rateLimit: STAFF_LIMITS,
			handler: attributes.create,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/attributes/:id',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: attributes.update,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/attributes/:id',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: attributes.remove,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/attributes',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: attributes.list,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/attributes',
			auth: 'ticket',
			permission: 'catalog.edit',
			idempotent: true,
			rateLimit: STAFF_LIMITS,
			handler: attributes.create,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/admin/attributes/:id',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: attributes.update,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/attributes/:id',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: attributes.remove,
		}),

		// locations (multi_location)
		defineRoute({
			method: 'GET',
			path: '/v1/locations',
			auth: 'server',
			feature: 'multi_location',
			rateLimit: STAFF_LIMITS,
			handler: locations.list,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/locations',
			auth: 'server',
			feature: 'multi_location',
			idempotent: true,
			rateLimit: STAFF_LIMITS,
			handler: locations.create,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/locations/:id',
			auth: 'server',
			feature: 'multi_location',
			rateLimit: STAFF_LIMITS,
			handler: locations.update,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/locations/:id',
			auth: 'server',
			feature: 'multi_location',
			rateLimit: STAFF_LIMITS,
			handler: locations.remove,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/locations',
			auth: 'ticket',
			feature: 'multi_location',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: locations.list,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/locations',
			auth: 'ticket',
			feature: 'multi_location',
			permission: 'catalog.edit',
			idempotent: true,
			rateLimit: STAFF_LIMITS,
			handler: locations.create,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/admin/locations/:id',
			auth: 'ticket',
			feature: 'multi_location',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: locations.update,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/locations/:id',
			auth: 'ticket',
			feature: 'multi_location',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: locations.remove,
		}),

		// serials (grades_serials)
		defineRoute({
			method: 'GET',
			path: '/v1/serials',
			auth: 'server',
			feature: 'grades_serials',
			rateLimit: STAFF_LIMITS,
			handler: serials.list,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/serials',
			auth: 'server',
			feature: 'grades_serials',
			idempotent: true,
			rateLimit: STAFF_LIMITS,
			handler: serials.add,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/serials/:id',
			auth: 'server',
			feature: 'grades_serials',
			rateLimit: STAFF_LIMITS,
			handler: serials.update,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/serials/:id',
			auth: 'server',
			feature: 'grades_serials',
			rateLimit: STAFF_LIMITS,
			handler: serials.remove,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/serials',
			auth: 'ticket',
			feature: 'grades_serials',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: serials.list,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/serials',
			auth: 'ticket',
			feature: 'grades_serials',
			permission: 'catalog.edit',
			idempotent: true,
			rateLimit: STAFF_LIMITS,
			handler: serials.add,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/admin/serials/:id',
			auth: 'ticket',
			feature: 'grades_serials',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: serials.update,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/serials/:id',
			auth: 'ticket',
			feature: 'grades_serials',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: serials.remove,
		}),
	];
};
