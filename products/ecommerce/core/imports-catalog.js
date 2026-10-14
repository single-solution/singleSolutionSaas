/**
 * The catalog's records moved in by an import (PLAN 0.8.10 K10, Migration steps 3 and 5): categories, brands,
 * attributes, size charts, landing pages, products with their variants and photos, serials, deals and bundles, each
 * checked with the product's own check in import mode. What migration needs is relaxed: ids, past times
 * (`createdAt`, `publishedAt`), use counts (`used`), sold counts and ratings, earlier slugs (`previousSlugs`) and stock
 * are taken as given (no stock is held), storage keys of any folder are kept (with the type and size given; Migration
 * "Storage", CA-5), and a product without a variant becomes a draft (CA-2: an active one is stored as a draft). The rest
 * is strict: fields the record type does not have are refused by name (so a mapping mistake shows in a dry run), as are
 * values the product derives (`path`, `price`, `stockState` …), text over the product's limits is refused, never cut
 * (IMP-31), references must name records of an earlier step, and the website is the token's, never the record's. Each
 * check also derives what a save derives from the record alone (a product's price, price range, stock state and
 * grades; a category's path under the parents already stored). Category paths across the tree are derived again by
 * `categoryPaths` in the import's finish. No I/O.
 * @module
 */
import { isId } from '@ss/contracts';
import { LIMITS, checkProduct, cleanText, givenFacts, isObject, isSlug, summarize } from './catalog.js';
import { keyAllowed, mediaExtras } from './catalog-content.js';
import { checkAttribute, checkBrand, checkCategory } from './catalog-taxonomy.js';
import { checkBundleInput } from './bundles.js';
import { checkDealInput } from './deals.js';
import { checkLanding } from './landings.js';
import { MAX_PREVIOUS_SLUGS } from './links.js';
import { ID_PREFIX } from './model.js';
import { checkSizeChart } from './size-charts.js';

/** @typedef {import('./catalog.js').FieldError} FieldError */
/** @typedef {import('./catalog.js').CatalogRules} CatalogRules */
/** @typedef {import('./model.js').MediaRecord} MediaRecord */
/** @typedef {{ ok: true, value: Record<string, any> } | { ok: false, errors: FieldError[] }} ImportChecked */

/**
 * What the checks know of the website, read once per import call.
 * @typedef {object} ImportContext
 * @property {number} now
 * @property {ReadonlySet<string>} features the switched-on features
 * @property {ReadonlySet<string>} categoryIds
 * @property {ReadonlySet<string>} brandIds
 * @property {ReadonlySet<string>} sizeChartIds
 * @property {ReadonlySet<string>} gradeKeys the `grades` list (empty while Grades and serials is off)
 * @property {ReadonlySet<string>} locationIds
 * @property {ReadonlyMap<string, { path: string[] }>} [categories] stored categories (a category's path)
 * @property {CatalogRules} [rules] products: what a product check needs
 */

/**
 * SEO fields moved in: their copy is marked as the import's (G6: the earlier shop's own titles and descriptions, kept
 * as written).
 * @param {import('./catalog-content.js').SeoFields} seo
 * @returns {import('./catalog-content.js').SeoFields}
 */
const importedSeo = (seo) => ({ ...seo, source: seo.title || seo.description ? 'import' : null });

/** The audit times every record may carry (`updatedAt` is the import's own time). */
const STAMPS = Object.freeze(['createdAt', 'updatedAt']);

/** The fields of a photo or file. */
const MEDIA_FIELDS = Object.freeze(['key', 'type', 'size', 'alt', 'sizes', 'width', 'height', 'blur']);

/** The fields of a variant. */
const VARIANT_FIELDS = Object.freeze([
	'id',
	'sku',
	'gtin',
	'mpn',
	'options',
	'price',
	'compareAtPrice',
	'cost',
	'stock',
	'locations',
	'grade',
	'active',
	'attributes',
	'media',
	'soldOut',
	'warrantyDays',
	'feedId',
]);

/** The fields each collection's records may have (the stored shapes of `model.js`). */
const IMPORT_FIELDS = Object.freeze({
	categories: Object.freeze([
		'id',
		'slug',
		'name',
		'parentId',
		'description',
		'seo',
		'image',
		'sort',
		'status',
		'icon',
		'content',
		'faqs',
		'sizeChartId',
		'requiresSerial',
		'previousSlugs',
		...STAMPS,
	]),
	brands: Object.freeze(['id', 'slug', 'name', 'description', 'logo', 'status', 'categoryIds', 'seo', 'sizeChartId', ...STAMPS]),
	attributes: Object.freeze([
		'id',
		'name',
		'type',
		'choices',
		'unit',
		'filterable',
		'comparable',
		'sort',
		'slug',
		'categoryId',
		'categoryIds',
		'on',
		'multiple',
		'visibility',
		'card',
		'active',
		'seo',
		...STAMPS,
	]),
	size_charts: Object.freeze(['id', 'name', 'unit', 'columns', 'rows', 'fitAdvice', 'notes', 'active', ...STAMPS]),
	landings: Object.freeze([
		'id',
		'categoryId',
		'brandId',
		'grade',
		'h1',
		'title',
		'description',
		'intro',
		'faqs',
		'indexable',
		...STAMPS,
	]),
	products: Object.freeze([
		'id',
		'slug',
		'name',
		'kind',
		'status',
		'summary',
		'description',
		'categoryIds',
		'brandId',
		'tags',
		'media',
		'specs',
		'options',
		'variants',
		'trackStock',
		'serialized',
		'digital',
		'booking',
		'seo',
		'featured',
		'descriptionHtml',
		'video',
		'sizeChartId',
		'hideSizeGuide',
		'attributeSetup',
		'faqs',
		'previousSlugs',
		'returnDays',
		'warrantyDays',
		'feedGroupId',
		'sold',
		'rating',
		'publishedAt',
		...STAMPS,
	]),
	serials: Object.freeze([
		'id',
		'productId',
		'variantId',
		'serial',
		'status',
		'orderId',
		'lineId',
		'locationId',
		'typed',
		...STAMPS,
	]),
	deals: Object.freeze([
		'id',
		'name',
		'description',
		'type',
		'value',
		'scope',
		'startsAt',
		'endsAt',
		'limit',
		'used',
		'priority',
		'active',
		'slug',
		'badgeLabel',
		'discountLabel',
		'color',
		'banner',
		'content',
		'seo',
		'sort',
		'conditions',
		'target',
		'days',
		'timeFrom',
		'timeTo',
		'allowPoints',
		...STAMPS,
	]),
	bundles: Object.freeze([
		'id',
		'name',
		'type',
		'items',
		'price',
		'buy',
		'get',
		'scope',
		'getScope',
		'value',
		'startsAt',
		'endsAt',
		'limit',
		'used',
		'active',
		...STAMPS,
	]),
});

/** Values the product derives itself: an import leaves them out. */
const DERIVED = Object.freeze(
	/** @type {Record<string, readonly string[]>} */ ({
		categories: ['path'],
		products: ['price', 'priceMax', 'inStock', 'stockState', 'grades'],
	}),
);

/** A clock may be a little ahead of the store's: times up to this far ahead are still the past. */
const SKEW_MS = 5 * 60_000;
/** Most files of a digital product. */
const MAX_FILES = 20;
/** Serial numbers: printable, 1 to 64 characters (as the serial routes take them). */
const SERIAL = /^[\p{L}\p{N}][\p{L}\p{N} ._/:#-]{0,63}$/u;
/** Serial statuses. */
const SERIAL_STATUSES = Object.freeze(['in_stock', 'sold', 'faulty']);
/** A date as JSON gives it: ISO-8601, the date first. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T|$)/;

/**
 * The fields a record has that its type does not: each one named (the website is the token's, derived values are
 * the product's).
 * @param {Record<string, unknown>} record
 * @param {readonly string[]} allowed
 * @param {string} what the record type, for the message
 * @param {readonly string[]} [derived]
 * @param {string} [path] where the record is
 * @returns {FieldError[]}
 */
export const unknownFields = (record, allowed, what, derived = [], path = '') =>
	Object.keys(record)
		.filter((name) => !allowed.includes(name))
		.map((name) => ({
			path: `${path}/${name}`,
			message:
				name === 'websiteId' || name === 'merchantId'
					? `${name} is the token's website: leave it out.`
					: derived.includes(name)
						? `${name} is derived by the shop: leave it out.`
						: `${name} is not a field of ${what}.`,
		}));

/**
 * A time as JSON gives it (ISO-8601) as a Date; not after now unless `future`.
 * @param {unknown} value
 * @param {string} path
 * @param {FieldError[]} errors
 * @param {{ now: number, nullable?: boolean, future?: boolean }} rules
 * @returns {Date | null | undefined} undefined: not given (or invalid, with an error)
 */
export const importedDate = (value, path, errors, { now, nullable = false, future = false }) => {
	if (value === undefined) return undefined;
	if (value === null && nullable) return null;
	const time = typeof value === 'string' && ISO_DATE.test(value) ? Date.parse(value) : Number.NaN;
	if (!Number.isFinite(time)) {
		errors.push({ path, message: `Give an ISO-8601 time${nullable ? ', or null' : ''}.` });
		return undefined;
	}
	if (!future && time > now + SKEW_MS) {
		errors.push({ path, message: 'This time is in the future.' });
		return undefined;
	}
	return new Date(time);
};

/**
 * The record's `createdAt` and `updatedAt` when given.
 * @param {Record<string, unknown>} record
 * @param {number} now
 * @param {FieldError[]} errors
 * @returns {{ createdAt?: Date, updatedAt?: Date }}
 */
const stampsOf = (record, now, errors) => {
	/** @type {{ createdAt?: Date, updatedAt?: Date }} */
	const out = {};
	for (const name of /** @type {const} */ (['createdAt', 'updatedAt'])) {
		const date = importedDate(record[name], `/${name}`, errors, { now });
		if (date) out[name] = date;
	}
	return out;
};

/**
 * A photo or file as an import gives it: its key (any folder, Migration "Storage"), type, size, alternative text and
 * extra sizes; null when invalid (the errors say why).
 * @param {unknown} entry
 * @param {string} path
 * @param {FieldError[]} errors
 * @returns {MediaRecord | null}
 */
export const importedMedia = (entry, path, errors) => {
	if (!isObject(entry)) {
		errors.push({ path, message: 'A file is { key, type, size, alt }.' });
		return null;
	}
	const found = [...unknownFields(entry, MEDIA_FIELDS, 'a file', [], path)];
	if (!keyAllowed(entry.key, '')) found.push({ path: `${path}/key`, message: 'Give the storage key (no ..).' });
	const facts = givenFacts(entry, path, found);
	const alt = entry.alt === undefined ? '' : cleanText(entry.alt, LIMITS.alt);
	if (alt === null) found.push({ path: `${path}/alt`, message: `Alternative text has at most ${LIMITS.alt} characters.` });
	const extras = mediaExtras(entry, '', path, found);
	errors.push(...found);
	return found.length > 0 ? null : { key: String(entry.key), ...facts, alt: /** @type {string} */ (alt), ...extras };
};

/**
 * A list of photos or files.
 * @param {unknown} value
 * @param {number} max
 * @param {string} path
 * @param {FieldError[]} errors
 * @returns {MediaRecord[]}
 */
const mediaList = (value, max, path, errors) => {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > max) {
		errors.push({ path, message: `Give at most ${max} files.` });
		return [];
	}
	/** @type {MediaRecord[]} */
	const out = [];
	value.forEach((entry, index) => {
		const file = importedMedia(entry, `${path}/${index}`, errors);
		if (file && out.some((other) => other.key === file.key))
			errors.push({ path: `${path}/${index}/key`, message: 'Each file is listed once.' });
		else if (file) out.push(file);
	});
	return out;
};

/**
 * A single photo, or null.
 * @param {unknown} value
 * @param {string} path
 * @param {FieldError[]} errors
 */
const mediaOrNull = (value, path, errors) => (value === undefined || value === null ? null : importedMedia(value, path, errors));

/**
 * Earlier slugs (E13): at most 20 different slugs, none the record's own.
 * @param {unknown} value
 * @param {string} slug
 * @param {FieldError[]} errors
 * @returns {string[]}
 */
const previousSlugsOf = (value, slug, errors) => {
	if (value === undefined) return [];
	if (
		!Array.isArray(value) ||
		value.length > MAX_PREVIOUS_SLUGS ||
		!value.every((item) => isSlug(item) && item !== slug) ||
		new Set(value).size !== value.length
	) {
		errors.push({
			path: '/previousSlugs',
			message: `Give at most ${MAX_PREVIOUS_SLUGS} different earlier slugs, none the current one.`,
		});
		return [];
	}
	return /** @type {string[]} */ (value);
};

/**
 * The record's id with its collection's prefix.
 * @param {Record<string, unknown>} record
 * @param {string} prefix
 * @param {FieldError[]} errors
 * @returns {string}
 */
const idOf = (record, prefix, errors) => {
	if (!isId(record.id, prefix)) errors.push({ path: '/id', message: `Give the record's id (${prefix}_…).` });
	return String(record.id);
};

/**
 * The record's slug: given and valid (the import maps slugs, it does not make them).
 * @param {Record<string, unknown>} record
 * @param {FieldError[]} errors
 */
const slugOf = (record, errors) => {
	if (!isSlug(record.slug)) errors.push({ path: '/slug', message: 'Give the slug (lowercase letters, digits and dashes).' });
	return String(record.slug);
};

/**
 * An id of another record (with its prefix), or null.
 * @param {unknown} value
 * @param {string} prefix
 * @param {string} path
 * @param {FieldError[]} errors
 * @param {string} message
 * @returns {string | null}
 */
const refOf = (value, prefix, path, errors, message) => {
	if (value === undefined || value === null) return null;
	if (!isId(value, prefix)) {
		errors.push({ path, message });
		return null;
	}
	return value;
};

/**
 * Refuse ids that name no record of an earlier step.
 * @param {readonly string[]} ids
 * @param {ReadonlySet<string>} known
 * @param {string} path
 * @param {string} what
 * @param {FieldError[]} errors
 */
const mustExist = (ids, known, path, what, errors) => {
	const missing = ids.filter((id) => !known.has(id));
	if (missing.length > 0) errors.push({ path, message: `There is no ${what} ${missing.slice(0, 5).join(', ')}.` });
};

/**
 * A size chart a category or brand names: Size charts on and the chart imported (E5).
 * @param {string | null} id
 * @param {ImportContext} context
 * @param {FieldError[]} errors
 */
const chartExists = (id, context, errors) => {
	if (id === null) return;
	if (!context.features.has('size_charts')) errors.push({ path: '/sizeChartId', message: 'Switch on Size charts first.' });
	else mustExist([id], context.sizeChartIds, '/sizeChartId', 'size chart', errors);
};

/**
 * The outcome: the value, or every error found.
 * @param {FieldError[]} errors
 * @param {() => Record<string, any>} value
 * @returns {ImportChecked}
 */
const outcome = (errors, value) => (errors.length > 0 ? { ok: false, errors } : { ok: true, value: value() });

/**
 * The errors of a check that answers its first failure (`{ ok, value } | { ok: false, field, message }`).
 * @param {import('./promotions-rules.js').Checked} checked
 * @returns {FieldError[]}
 */
const firstFailure = (checked) => (checked.ok ? [] : [{ path: `/${checked.field}`, message: checked.message }]);

/**
 * A record's own fields only (unknown ones are refused separately).
 * @param {Record<string, unknown>} record
 * @param {readonly string[]} fields
 * @returns {Record<string, any>}
 */
const own = (record, fields) => Object.fromEntries(Object.entries(record).filter(([name]) => fields.includes(name)));

/**
 * A record's own fields as the product's check takes them: the slug is checked here (an import gives it; the check
 * would make one from the name), so the check is given none.
 * @param {Record<string, unknown>} record
 * @param {readonly string[]} fields
 * @returns {Record<string, any>}
 */
const ownChecked = (record, fields) => ({ ...own(record, fields), slug: '' });

/**
 * The checked fields of a check with field errors, merged into `errors`.
 * @template T
 * @param {{ ok: true, value: T } | { ok: false, errors: FieldError[] }} checked
 * @param {FieldError[]} errors
 * @returns {T | null}
 */
const valueOf = (checked, errors) => {
	if (checked.ok) return checked.value;
	errors.push(...checked.errors);
	return null;
};

// -------------------------------------------------------------------------------------------------- taxonomy

/**
 * A category (E1, E5, E11, E13): its path under the parents already stored (finish derives the whole tree, as
 * categories may come in any order).
 * @param {Record<string, unknown>} record
 * @param {ImportContext} context
 * @returns {ImportChecked}
 */
export const checkImportedCategory = (record, context) => {
	const fields = IMPORT_FIELDS.categories;
	const errors = unknownFields(record, fields, 'a category', DERIVED.categories);
	const id = idOf(record, ID_PREFIX.category, errors);
	const slug = slugOf(record, errors);
	const checked = valueOf(checkCategory(ownChecked(record, fields), null), errors);
	const parentId = refOf(record.parentId, ID_PREFIX.category, '/parentId', errors, 'The parent is a category id, or null.');
	if (parentId !== null && parentId === id) errors.push({ path: '/parentId', message: 'A category is not its own parent.' });
	if (checked) chartExists(checked.sizeChartId, context, errors);
	const image = mediaOrNull(record.image, '/image', errors);
	const previousSlugs = previousSlugsOf(record.previousSlugs, slug, errors);
	const stamps = stampsOf(record, context.now, errors);
	const parent = parentId === null ? undefined : context.categories?.get(parentId);
	return outcome(errors, () => ({
		id,
		...checked,
		...(checked ? { seo: importedSeo(checked.seo) } : {}),
		slug,
		parentId,
		path: parent ? [...parent.path, parentId] : [],
		image,
		previousSlugs,
		...stamps,
	}));
};

/**
 * A brand (E1, E5, E16).
 * @param {Record<string, unknown>} record
 * @param {ImportContext} context
 * @returns {ImportChecked}
 */
export const checkImportedBrand = (record, context) => {
	const fields = IMPORT_FIELDS.brands;
	const errors = unknownFields(record, fields, 'a brand');
	const id = idOf(record, ID_PREFIX.brand, errors);
	const slug = slugOf(record, errors);
	const checked = valueOf(checkBrand(ownChecked(record, fields), null), errors);
	if (checked) {
		mustExist(checked.categoryIds, context.categoryIds, '/categoryIds', 'category', errors);
		chartExists(checked.sizeChartId, context, errors);
	}
	const logo = mediaOrNull(record.logo, '/logo', errors);
	const stamps = stampsOf(record, context.now, errors);
	return outcome(errors, () => ({
		id,
		...checked,
		...(checked ? { seo: importedSeo(checked.seo) } : {}),
		slug,
		logo,
		...stamps,
	}));
};

/**
 * An attribute (E7): its categories (the one it is the definition for, E45, and those it applies to), and the brands or
 * grades its visibility names, must exist; an attribute it depends on is an attribute id (attributes may come in any
 * order). Attributes keep one record per category they are for: they are not merged by slug (CA-23).
 * @param {Record<string, unknown>} record
 * @param {ImportContext} context
 * @returns {ImportChecked}
 */
export const checkImportedAttribute = (record, context) => {
	const fields = IMPORT_FIELDS.attributes;
	const errors = unknownFields(record, fields, 'an attribute');
	const id = idOf(record, ID_PREFIX.attribute, errors);
	const slug = slugOf(record, errors);
	const checked = valueOf(checkAttribute(ownChecked(record, fields), null), errors);
	if (checked) {
		mustExist(checked.categoryIds, context.categoryIds, '/categoryIds', 'category', errors);
		if (checked.categoryId) mustExist([checked.categoryId], context.categoryIds, '/categoryId', 'category', errors);
		const { visibility } = checked;
		if (visibility.when === 'brands') mustExist(visibility.ids, context.brandIds, '/visibility/ids', 'brand', errors);
		if (visibility.when === 'grades') mustExist(visibility.ids, context.gradeKeys, '/visibility/ids', 'grade', errors);
		if (
			visibility.when === 'attribute' &&
			(!isId(visibility.attributeId, ID_PREFIX.attribute) || visibility.attributeId === id)
		)
			errors.push({ path: '/visibility/attributeId', message: 'Name another attribute by its id.' });
	}
	const stamps = stampsOf(record, context.now, errors);
	return outcome(errors, () => ({ id, ...checked, slug, ...stamps }));
};

/**
 * A size chart (E5).
 * @param {Record<string, unknown>} record
 * @param {ImportContext} context
 * @returns {ImportChecked}
 */
export const checkImportedSizeChart = (record, context) => {
	const fields = IMPORT_FIELDS.size_charts;
	const errors = unknownFields(record, fields, 'a size chart');
	const id = idOf(record, ID_PREFIX.sizeChart, errors);
	const checked = valueOf(checkSizeChart(own(record, fields), null), errors);
	const stamps = stampsOf(record, context.now, errors);
	return outcome(errors, () => ({ id, ...checked, ...stamps }));
};

/**
 * A landing page (E15): its category, brand and grade must exist.
 * @param {Record<string, unknown>} record
 * @param {ImportContext} context
 * @returns {ImportChecked}
 */
export const checkImportedLanding = (record, context) => {
	const fields = IMPORT_FIELDS.landings;
	const errors = unknownFields(record, fields, 'a landing page');
	const id = idOf(record, ID_PREFIX.landing, errors);
	const checked = valueOf(checkLanding(own(record, fields), null), errors);
	if (checked) {
		if (checked.categoryId) mustExist([checked.categoryId], context.categoryIds, '/categoryId', 'category', errors);
		if (checked.brandId) mustExist([checked.brandId], context.brandIds, '/brandId', 'brand', errors);
		if (checked.grade) mustExist([checked.grade], context.gradeKeys, '/grade', 'grade', errors);
	}
	const stamps = stampsOf(record, context.now, errors);
	return outcome(errors, () => ({ id, ...checked, ...stamps }));
};

// -------------------------------------------------------------------------------------------------- products

/**
 * A variant as the product check takes it in import mode: its own fields only, with its stock as the website keeps
 * it (overall, or per location with Multi-location stock, where `stock` must be their sum).
 * @param {unknown} entry
 * @param {string} path
 * @param {ImportContext} context
 * @param {FieldError[]} errors
 * @returns {unknown}
 */
const variantInput = (entry, path, context, errors) => {
	if (!isObject(entry)) return entry;
	errors.push(...unknownFields(entry, VARIANT_FIELDS, 'a variant', [], path));
	if (Array.isArray(entry.media))
		entry.media.forEach((file, index) => {
			if (isObject(file)) errors.push(...unknownFields(file, MEDIA_FIELDS, 'a file', [], `${path}/media/${index}`));
		});
	const input = own(entry, VARIANT_FIELDS);
	const locations = isObject(entry.locations) ? Object.values(entry.locations) : [];
	if (!context.features.has('multi_location')) {
		if (locations.length > 0)
			errors.push({ path: `${path}/locations`, message: 'Switch on Multi-location stock to give stock per location.' });
		delete input.locations;
		return input;
	}
	// per location: the check sums them (without them it asks for them)
	if (entry.locations === undefined) return input;
	if (
		entry.stock !== undefined &&
		locations.every((units) => Number.isSafeInteger(units)) &&
		locations.reduce((sum, units) => sum + Number(units), 0) !== entry.stock
	)
		errors.push({ path: `${path}/stock`, message: 'The stock is the sum of the units at each location.' });
	delete input.stock;
	return input;
};

/**
 * A product with its variants, photos and files (E1–E16): the product check in import mode, then what only an import
 * gives (its id, photos, files, earlier slugs, sold count, rating and times) and what a save derives (price, highest
 * price, in stock, stock state and grades). A product without a variant is stored as a draft (CA-2). Slugs, SKUs and
 * variant ids already used by another product are refused by the caller (they need the database).
 * @param {Record<string, unknown>} record
 * @param {ImportContext} context `rules` required
 * @returns {ImportChecked}
 */
export const checkImportedProduct = (record, context) => {
	const fields = IMPORT_FIELDS.products;
	const errors = unknownFields(record, fields, 'a product', DERIVED.products);
	const id = idOf(record, ID_PREFIX.product, errors);
	const slug = slugOf(record, errors);
	if (record.status === undefined) errors.push({ path: '/status', message: 'Give the status: draft, active or archived.' });
	/** @type {unknown[]} */
	let variants = [];
	if (!Array.isArray(record.variants))
		errors.push({ path: '/variants', message: 'Give the variants (an empty list for a draft without variants).' });
	else variants = record.variants.map((entry, index) => variantInput(entry, `/variants/${index}`, context, errors));
	// a product without a variant is a draft until it has one (CA-2)
	const status = variants.length === 0 && record.status === 'active' ? 'draft' : record.status;
	const rules = { .../** @type {CatalogRules} */ (context.rules), importing: true };
	const checked = valueOf(checkProduct({ ...ownChecked(record, fields), status, variants }, rules, null), errors);
	for (const [name, kind] of /** @type {const} */ ([
		['digital', 'digital'],
		['booking', 'booking'],
	]))
		if (checked && checked.kind !== kind && record[name] !== undefined && record[name] !== null)
			errors.push({ path: `/${name}`, message: `Only a ${kind} product has ${name} settings: give null.` });
	const media = mediaList(record.media, LIMITS.media, '/media', errors);
	const files =
		checked?.kind === 'digital' && isObject(record.digital)
			? mediaList(record.digital.files, MAX_FILES, '/digital/files', errors)
			: [];
	const previousSlugs = previousSlugsOf(record.previousSlugs, slug, errors);
	const sold = record.sold ?? 0;
	if (!Number.isSafeInteger(sold) || Number(sold) < 0) errors.push({ path: '/sold', message: 'Sold is a whole number from 0.' });
	const rating = /** @type {Record<string, any>} */ (record.rating ?? { average: 0, count: 0 });
	if (
		!isObject(rating) ||
		Object.keys(rating).some((name) => name !== 'average' && name !== 'count') ||
		typeof rating.average !== 'number' ||
		!(rating.average >= 0 && rating.average <= 5) ||
		!Number.isSafeInteger(rating.count) ||
		rating.count < 0
	)
		errors.push({ path: '/rating', message: 'The rating is { average: 0 to 5, count: a whole number from 0 }.' });
	const stamps = stampsOf(record, context.now, errors);
	const published = importedDate(record.publishedAt, '/publishedAt', errors, { now: context.now, nullable: true });
	return outcome(errors, () => {
		const value = /** @type {import('./catalog.js').ProductFields} */ (checked);
		return {
			id,
			...value,
			seo: importedSeo(value.seo),
			slug,
			...(value.digital ? { digital: { ...value.digital, files } } : {}),
			media,
			previousSlugs,
			sold,
			rating: { average: rating.average, count: rating.count },
			...summarize(value.variants, value.trackStock),
			// first time on sale: as given, else when it was made (Migration: publishedAt = createdAt)
			publishedAt: published ?? (value.status === 'active' ? (stamps.createdAt ?? new Date(context.now)) : null),
			...stamps,
		};
	});
};

/**
 * A serial number of a variant (E11). A unit in stock or faulty belongs to no order (as a return leaves it); a sold one
 * names its order. Whether the variant exists is checked by the caller.
 * @param {Record<string, unknown>} record
 * @param {ImportContext} context
 * @returns {ImportChecked}
 */
export const checkImportedSerial = (record, context) => {
	const errors = unknownFields(record, IMPORT_FIELDS.serials, 'a serial');
	const id = idOf(record, ID_PREFIX.serial, errors);
	if (!isId(record.productId, ID_PREFIX.product)) errors.push({ path: '/productId', message: 'Give the product id.' });
	if (!isId(record.variantId, ID_PREFIX.variant)) errors.push({ path: '/variantId', message: 'Give the variant id.' });
	if (typeof record.serial !== 'string' || !SERIAL.test(record.serial))
		errors.push({ path: '/serial', message: 'A serial number is 1 to 64 letters, digits and . _ / : # -' });
	const status = String(record.status);
	if (!SERIAL_STATUSES.includes(status))
		errors.push({ path: '/status', message: `The status is one of ${SERIAL_STATUSES.join(', ')}.` });
	const sold = status === 'sold';
	const orderId = refOf(record.orderId, ID_PREFIX.order, '/orderId', errors, 'Give the order id, or null.');
	const lineId = refOf(record.lineId, ID_PREFIX.line, '/lineId', errors, 'Give the order line id, or null.');
	if (sold && orderId === null) errors.push({ path: '/orderId', message: 'A sold unit names its order.' });
	const locationId = refOf(record.locationId, ID_PREFIX.location, '/locationId', errors, 'Give the location id, or null.');
	if (locationId !== null) {
		if (!context.features.has('multi_location'))
			errors.push({ path: '/locationId', message: 'Switch on Multi-location stock first.' });
		else mustExist([locationId], context.locationIds, '/locationId', 'location', errors);
	}
	if (record.typed !== undefined && typeof record.typed !== 'boolean')
		errors.push({ path: '/typed', message: 'Typed is true or false.' });
	const stamps = stampsOf(record, context.now, errors);
	return outcome(errors, () => ({
		id,
		productId: record.productId,
		variantId: record.variantId,
		serial: record.serial,
		status,
		orderId: sold ? orderId : null,
		lineId: sold ? lineId : null,
		locationId,
		...(record.typed === true ? { typed: true } : {}),
		...stamps,
	}));
};

// ------------------------------------------------------------------------------------------------ promotions

/**
 * The use count an import gives (`used`, the uses so far).
 * @param {Record<string, unknown>} record
 * @param {FieldError[]} errors
 */
const usedOf = (record, errors) => {
	const used = record.used ?? 0;
	if (!Number.isSafeInteger(used) || Number(used) < 0) errors.push({ path: '/used', message: 'Used is a whole number from 0.' });
	return Number(used);
};

/**
 * The categories and brands an offer's scopes name must exist (the products are checked by the caller).
 * @param {Array<import('./model.js').OfferScope>} scopes
 * @param {ImportContext} context
 * @param {FieldError[]} errors
 */
const scopesExist = (scopes, context, errors) => {
	mustExist(
		scopes.flatMap((scope) => scope.categoryIds),
		context.categoryIds,
		'/scope/categoryIds',
		'category',
		errors,
	);
	mustExist(
		scopes.flatMap((scope) => scope.brandIds),
		context.brandIds,
		'/scope/brandIds',
		'brand',
		errors,
	);
};

/**
 * A deal (E18) with its use count; its banner keeps its key whatever the folder.
 * @param {Record<string, unknown>} record
 * @param {ImportContext} context
 * @returns {ImportChecked}
 */
export const checkImportedDeal = (record, context) => {
	const fields = IMPORT_FIELDS.deals;
	const errors = unknownFields(record, fields, 'a deal');
	const id = idOf(record, ID_PREFIX.deal, errors);
	const checked = checkDealInput(own(record, fields), { importing: true });
	errors.push(...firstFailure(checked));
	if (checked.ok) scopesExist([checked.value.scope], context, errors);
	const used = usedOf(record, errors);
	const stamps = stampsOf(record, context.now, errors);
	return outcome(errors, () => ({ id, .../** @type {{ value: Record<string, any> }} */ (checked).value, used, ...stamps }));
};

/**
 * A bundle or buy X get Y with its use count.
 * @param {Record<string, unknown>} record
 * @param {ImportContext} context
 * @returns {ImportChecked}
 */
export const checkImportedBundle = (record, context) => {
	const fields = IMPORT_FIELDS.bundles;
	const errors = unknownFields(record, fields, 'a bundle');
	const id = idOf(record, ID_PREFIX.bundle, errors);
	const checked = checkBundleInput(own(record, fields));
	errors.push(...firstFailure(checked));
	if (checked.ok) scopesExist([checked.value.scope, checked.value.getScope], context, errors);
	const used = usedOf(record, errors);
	const stamps = stampsOf(record, context.now, errors);
	return outcome(errors, () => ({ id, .../** @type {{ value: Record<string, any> }} */ (checked).value, used, ...stamps }));
};

/**
 * The product ids an offer names (its scopes and a bundle's items), for the caller's lookup.
 * @param {Record<string, any>} offer a checked deal or bundle
 * @returns {string[]}
 */
export const offerProductIds = (offer) => [
	...new Set([
		...[offer.scope, offer.getScope].filter(Boolean).flatMap((scope) => scope.productIds),
		...(offer.items ?? []).map((/** @type {{ productId: string }} */ item) => item.productId),
	]),
];

// ---------------------------------------------------------------------------------------------------- finish

/**
 * The paths of every category from its parents (finish: categories come in any order), and what is wrong with the
 * tree: a parent that is not there (`orphans`: kept at the top), a loop of parents (`cycles`: kept at the top) and
 * categories deeper than the product allows (`tooDeep`, as placing them by hand would refuse).
 * @param {ReadonlyArray<{ id: string, parentId?: string | null }>} categories every category of the website
 * @param {number} [depth] the deepest path (10 levels)
 * @returns {{ paths: Map<string, string[]>, orphans: string[], cycles: string[], tooDeep: string[] }}
 */
export const categoryPaths = (categories, depth = 10) => {
	const byId = new Map(categories.map((category) => [category.id, category]));
	/** @type {Map<string, string[]>} */
	const paths = new Map();
	/** @type {string[]} */
	const orphans = [];
	/** @type {string[]} */
	const cycles = [];
	/** @type {string[]} */
	const tooDeep = [];
	for (const category of categories) {
		const parentId = category.parentId ?? null;
		if (parentId !== null && !byId.has(parentId)) orphans.push(category.id);
		/** @type {string[]} */
		const path = [];
		const seen = new Set([category.id]);
		let current = parentId;
		let loop = false;
		while (current !== null && byId.has(current)) {
			if (seen.has(current)) {
				loop = true;
				break;
			}
			seen.add(current);
			path.unshift(current);
			current = byId.get(current)?.parentId ?? null;
		}
		if (loop) cycles.push(category.id);
		else if (path.length >= depth) tooDeep.push(category.id);
		paths.set(category.id, loop ? [] : path);
	}
	return { paths, orphans, cycles, tooDeep };
};
