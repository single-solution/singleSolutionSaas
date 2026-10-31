/**
 * The catalog's product rules (PLAN 0.8.8 Catalog, Items): what a product and its variants may hold, checked against
 * what is switched on (variants, multi-location stock, grades and serials, digital goods, bookings), the product's item
 * type (`core/item-types.js`: values of an element its type does not have are refused, with their path; a type that
 * names fields takes only those) and the website's categories, brands, attributes, locations and grades. A check
 * returns the product's next editable fields (a new product, or an existing one with the changes applied); the adapter
 * writes them. Stock of an existing variant is never changed here (that is the stock routes' job, so a product edit
 * cannot undo an order's stock hold). Storage keys a product already holds stay valid whatever their folder; only new
 * ones must be under its folder (CA-5). A draft may have no variant yet (an imported shell, CA-2); it goes on sale once
 * it has one. With `importing` (the `import` feature, PLAN 0.8.10 Migration) the record's own variant ids, stock, photo
 * keys and file facts are taken as given. Also the text helpers (slugs, bounded text) and price changes of bulk
 * actions. No I/O.
 * @module
 */
import { isId } from '@ss/contracts';
import { isAmount } from '@ss/contracts/format';
import { isObject } from '@ss/contracts/util';
import { checkValue, fieldApplies, gtinOf, valueProblem } from './fields.js';
import { DURATION_RULE, durationOf } from './durations.js';
import { gradeForType } from './grades.js';
import { PRODUCT_STATUSES } from './model.js';
import { categoryTypeKey, typeByKey, typeOf, typeTakes } from './item-types.js';
import {
	CONTENT_LIMITS,
	VIDEO_TYPES,
	checkFaqs,
	checkHtml,
	checkSeo,
	checkVideo,
	htmlToText,
	keyAllowed,
	mediaExtras,
	publicPhoto,
} from './catalog-content.js';

/** @typedef {import('./model.js').ProductRecord} ProductRecord */
/** @typedef {import('./model.js').VariantRecord} VariantRecord */
/** @typedef {import('./model.js').AttributeRecord} AttributeRecord */
/** @typedef {import('./model.js').MediaRecord} MediaRecord */
/** @typedef {{ path: string, message: string }} FieldError */
/** @typedef {{ ok: true, value: any } | { ok: false, errors: FieldError[] }} Checked */

/** Limits of one product. */
export const LIMITS = Object.freeze({
	name: 200,
	summary: 500,
	description: 20_000,
	tags: 30,
	tag: 40,
	categories: 20,
	axes: 6,
	axisName: 40,
	axisValues: 50,
	axisValue: 60,
	variants: 250,
	sku: 64,
	specs: 100,
	specText: 200,
	seoTitle: 200,
	seoDescription: 500,
	stock: 1_000_000_000,
	downloadLimit: 1000,
	parcel: 10_000_000,
	media: 20,
	alt: 200,
	variantMedia: 24,
	mpn: 70,
	allVariantMedia: 200,
	setup: 20,
	setupValues: 100,
	attributeValues: 20,
	generated: 250,
});

/** Product kinds and statuses. */
const KINDS = Object.freeze(/** @type {const} */ (['physical', 'digital', 'service']));

/** Slugs: lowercase letters of any script, digits, single dashes. */
const SLUG_PATTERN = /^[\p{Ll}\p{Lo}\p{N}]+(?:-[\p{Ll}\p{Lo}\p{N}]+)*$/u;
/** Longest slug. */
const MAX_SLUG = 120;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** @param {unknown} value @returns {value is string} */
export const isSlug = (value) => typeof value === 'string' && value.length <= MAX_SLUG && SLUG_PATTERN.test(value);

/**
 * Trimmed text without control characters (line breaks kept when `multiline`), or null when not text or too long.
 * Empty text is '' (allowed unless the caller says otherwise).
 * @param {unknown} value
 * @param {number} max
 * @param {{ multiline?: boolean }} [options]
 * @returns {string | null}
 */
export const cleanText = (value, max, { multiline = false } = {}) => {
	if (typeof value !== 'string') return null;
	const flat = multiline ? value.replace(/\r\n?/g, '\n') : value.replace(/[\r\n\t]+/g, ' ');
	const text = flat.replace(CONTROL, '').trim();
	return text.length > max ? null : text;
};

/**
 * A slug from any text: lowercase, accents folded, every run of other characters becomes one dash.
 * @param {unknown} text
 * @param {number} [max]
 */
export const slugify = (text, max = MAX_SLUG) =>
	String(text ?? '')
		.normalize('NFKD')
		.replace(/\p{M}+/gu, '')
		.toLowerCase()
		.replace(/[^\p{Ll}\p{Lo}\p{N}]+/gu, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, max)
		.replace(/-+$/g, '');

/**
 * The first free slug among `base`, `base-2`, `base-3` … given the slugs already taken.
 * @param {string} base
 * @param {Iterable<string>} taken
 */
export const freeSlug = (base, taken) => {
	const used = new Set(taken);
	if (!used.has(base)) return base;
	for (let n = 2; ; n += 1) {
		const suffix = `-${n}`;
		const candidate = `${base.slice(0, MAX_SLUG - suffix.length).replace(/-+$/g, '')}${suffix}`;
		if (!used.has(candidate)) return candidate;
	}
};

/** @param {unknown} value @param {number} max @returns {value is number} */
const isCount = (value, max) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;

/**
 * The variant's display name: its option values in the product's axis order (`Blue / Large`), '' without options.
 * @param {Array<{ name: string }>} options
 * @param {Record<string, string>} values
 */
export const variantName = (options, values) =>
	options
		.map((axis) => values[axis.name])
		.filter((value) => typeof value === 'string' && value !== '')
		.join(' / ');

/**
 * A variant can be sold now: active, not marked sold out (E9) and with stock (when stock is tracked).
 * @param {Pick<VariantRecord, 'active' | 'stock' | 'soldOut'>} variant
 * @param {boolean} trackStock
 */
export const variantInStock = (variant, trackStock) => variant.active && !variant.soldOut && (!trackStock || variant.stock > 0);

/**
 * How much of a product can be sold (E2): `none` when stock is not tracked or nothing is active, `out` when no active
 * variant can be sold, `full` when every one can, else `partial`.
 * @param {Array<Pick<VariantRecord, 'active' | 'stock' | 'soldOut'>>} variants
 * @param {boolean} trackStock
 * @returns {'none' | 'out' | 'partial' | 'full'}
 */
const stockStateOf = (variants, trackStock) => {
	const active = variants.filter((variant) => variant.active);
	if (!trackStock || active.length === 0) return 'none';
	const selling = active.filter((variant) => variantInStock(variant, true)).length;
	return selling === 0 ? 'out' : selling === active.length ? 'full' : 'partial';
};

/**
 * Product fields that are not what its page shows: counts, the stamps of writes and the stock state (only whether it
 * can be bought is shown, `inStock`).
 */
const NOT_CONTENT = Object.freeze(
	new Set(['sold', 'rating', 'publishedAt', 'contentUpdatedAt', 'createdAt', 'updatedAt', 'stockState']),
);

/**
 * A product's variants without their stock (units and per location), for {@link contentChanged}.
 * @param {unknown} variants
 */
const withoutStock = (variants) =>
	JSON.stringify(
		(Array.isArray(variants) ? variants : []).map((variant) => {
			const rest = { ...variant };
			delete rest.stock;
			delete rest.locations;
			return rest;
		}),
	);

/**
 * Whether a product write changes what its page shows (SEO audit G8.4: the sitemap's `lastmod`): any field it sets
 * that differs, but not the stock of its variants nor its counts; whether it can still be bought is judged by the
 * ledger's `refreshProducts`.
 * @param {Record<string, unknown>} before the product as it was
 * @param {Record<string, unknown>} set the fields the write sets
 */
export const contentChanged = (before, set) =>
	Object.entries(set).some(([key, value]) =>
		NOT_CONTENT.has(key)
			? false
			: key === 'variants'
				? withoutStock(before.variants) !== withoutStock(value)
				: JSON.stringify(before[key]) !== JSON.stringify(value),
	);

/**
 * What a product's listings use, from its variants (as the ledger's `refreshProducts` computes them): the lowest and
 * highest active price, whether something can be sold, the stock state and the grades on sale.
 * @param {Array<Pick<VariantRecord, 'active' | 'price' | 'stock' | 'soldOut' | 'grade'>>} variants
 * @param {boolean} trackStock
 */
export const summarize = (variants, trackStock) => {
	const active = variants.filter((variant) => variant.active);
	const prices = active.map((variant) => variant.price);
	return {
		price: prices.length > 0 ? Math.min(...prices) : 0,
		priceMax: prices.length > 0 ? Math.max(...prices) : 0,
		inStock: active.some((variant) => variantInStock(variant, trackStock)),
		stockState: stockStateOf(variants, trackStock),
		grades: [...new Set(active.map((variant) => variant.grade).filter((grade) => typeof grade === 'string'))],
	};
};

/**
 * What a check needs to know about the website.
 * @typedef {object} CatalogRules
 * @property {boolean} variants the `variants` feature is on
 * @property {boolean} locations `multi_location` is on
 * @property {boolean} grades `grades_serials` is on
 * @property {boolean} digital `digital_goods` is on
 * @property {boolean} bookings `bookings` is on
 * @property {boolean} parcels `delivery_zones` is on (variants keep their package)
 * @property {ReadonlySet<string>} gradeKeys keys of the `grades` list
 * @property {ReadonlyMap<string, ReadonlyArray<string>>} gradeTypes the item types each grade key is for ([] = every
 *   type; `core/grades.js` `gradeTypes`)
 * @property {ReadonlySet<string>} locationIds
 * @property {ReadonlySet<string>} categoryIds
 * @property {ReadonlyMap<string, ReadonlyArray<string>>} categoryPaths each category's ancestors (required fields apply by
 *   the categories a product is in and those above them)
 * @property {ReadonlyMap<string, string | null>} categoryTypes each category's own item type key (null: its parent's)
 * @property {ReadonlyArray<import('./item-types.js').ItemType>} types the merchant's item types
 * @property {ReadonlySet<string>} brandIds
 * @property {ReadonlyMap<string, AttributeRecord>} attributes
 * @property {(prefix: string) => string} newId
 * @property {boolean} [sizeCharts] the `size_charts` feature is on (E5)
 * @property {ReadonlySet<string>} [sizeChartIds]
 * @property {boolean} [importing] a record moved in by an import (PLAN 0.8.10 Migration): variants keep their given
 *   ids and stock, photo and video keys of any folder keep their given type and size, and no variant is allowed (a
 *   draft, CA-2)
 */

/**
 * Where a product's variant photos may come from: new keys under `folder` (null: none yet, the product is new; '' any
 * folder, an import), and keys the product already holds (CA-5).
 * @typedef {{ folder: string | null, held: ReadonlySet<string>, importing: boolean }} Place
 */

/** No storage keys. @type {ReadonlySet<string>} */
const NO_KEYS = Object.freeze(new Set());

/** A new product's place: no folder yet. @type {Place} */
const NEW_PLACE = Object.freeze({ folder: null, held: NO_KEYS, importing: false });

/**
 * Every storage key a product holds: its photos and their sizes, its variants' photos and their sizes, and its video
 * file (CA-5: these stay valid whatever their folder).
 * @param {Pick<ProductRecord, 'media' | 'variants' | 'video'>} product
 * @returns {Set<string>}
 */
export const heldKeys = (product) =>
	new Set([
		...[...product.media, ...product.variants.flatMap((variant) => variant.media)].flatMap((file) => [
			file.key,
			...Object.values(file.sizes ?? {}),
		]),
		...(product.video?.kind === 'file' ? [product.video.key] : []),
	]);

/**
 * The editable fields of a product (everything the adapter writes; `price`, `inStock`, `sold`, `rating`, `publishedAt`
 * and the timestamps are kept by the adapter and the ledger).
 * @typedef {Pick<ProductRecord, 'slug' | 'name' | 'kind' | 'status' | 'summary' | 'description' | 'categoryIds' | 'brandId'
 *   | 'typeKey' | 'tags' | 'specs' | 'options' | 'variants' | 'trackStock' | 'digital' | 'booking' | 'seo' | 'returnTime'
 *   | 'warrantyTime' | 'feedGroupId' | 'replacedBy'> & Required<Pick<ProductRecord, 'featured' | 'descriptionHtml' | 'video' | 'sizeChartId'
 *   | 'hideSizeGuide' | 'attributeSetup' | 'faqs'>>} ProductFields `slug` '' = make one from the name
 */

/**
 * Check a spec or variant attribute value against its field (`core/fields.js` `checkValue`): one value, or several
 * different ones when the field takes several (E7); a choice may also be one of `extra`, the product's own values.
 * @param {AttributeRecord} attribute
 * @param {unknown} value
 * @param {ReadonlyArray<string>} [extra]
 * @returns {{ ok: true, value: import('./fields.js').FieldValue } | { ok: false, message: string }}
 */
export const specValue = (attribute, value, extra = []) => {
	const checked = checkValue(attribute, value, { extra });
	return checked.ok ? checked : { ok: false, message: valueProblem(attribute, checked) };
};

/**
 * A value as shoppers read it: a choice's label, a number with its unit, several values joined with commas.
 * @param {AttributeRecord} attribute
 * @param {unknown} value
 * @returns {string}
 */
export const valueLabel = (attribute, value) => {
	if (Array.isArray(value)) return value.map((entry) => valueLabel(attribute, entry)).join(', ');
	if (attribute.type === 'choice') return attribute.choices.find((choice) => choice.value === value)?.label ?? String(value);
	if (attribute.type === 'number') return attribute.unit ? `${String(value)} ${attribute.unit}` : String(value);
	return String(value ?? '');
};

/**
 * @param {unknown} value
 * @param {FieldError[]} errors
 * @returns {Array<{ name: string, values: string[] }>}
 */
const optionsOf = (value, errors) => {
	if (!Array.isArray(value) || value.length > LIMITS.axes) {
		errors.push({ path: '/options', message: `Give at most ${LIMITS.axes} options, each with a name and values.` });
		return [];
	}
	/** @type {Array<{ name: string, values: string[] }>} */
	const out = [];
	value.forEach((axis, index) => {
		const name = isObject(axis) ? cleanText(axis.name, LIMITS.axisName) : null;
		if (!name || out.some((other) => other.name === name)) {
			errors.push({ path: `/options/${index}/name`, message: 'Each option needs its own name.' });
			return;
		}
		const raw = isObject(axis) && Array.isArray(axis.values) ? axis.values : null;
		/** @type {string[]} */
		const values = [];
		for (const entry of raw ?? []) {
			const text = cleanText(entry, LIMITS.axisValue);
			if (text && !values.includes(text)) values.push(text);
		}
		if (!raw || values.length === 0 || values.length !== raw.length || values.length > LIMITS.axisValues) {
			errors.push({
				path: `/options/${index}/values`,
				message: `Give 1 to ${LIMITS.axisValues} different values for ${name}.`,
			});
			return;
		}
		out.push({ name, values });
	});
	return out;
};

/**
 * Stock of a new variant: `stock`, or per location with multi-location stock (`stock` is then their sum).
 * @param {Record<string, any>} input
 * @param {CatalogRules} rules
 * @param {string} path
 * @param {FieldError[]} errors
 * @returns {{ stock: number, locations: Record<string, number> }}
 */
const stockOf = (input, rules, path, errors) => {
	if (rules.locations && input.locations !== undefined) {
		if (!isObject(input.locations)) {
			errors.push({ path: `${path}/locations`, message: 'Give the units at each location.' });
			return { stock: 0, locations: {} };
		}
		/** @type {Record<string, number>} */
		const locations = {};
		for (const [id, units] of Object.entries(input.locations)) {
			if (!rules.locationIds.has(id)) errors.push({ path: `${path}/locations/${id}`, message: 'There is no such location.' });
			else if (!isCount(units, LIMITS.stock))
				errors.push({ path: `${path}/locations/${id}`, message: 'Units are a whole number from 0.' });
			else locations[id] = units;
		}
		return { stock: Object.values(locations).reduce((a, b) => a + b, 0), locations };
	}
	if (input.stock === undefined) return { stock: 0, locations: {} };
	if (rules.locations) {
		errors.push({ path: `${path}/stock`, message: 'Give the stock per location.' });
		return { stock: 0, locations: {} };
	}
	if (!isCount(input.stock, LIMITS.stock)) {
		errors.push({ path: `${path}/stock`, message: 'Stock is a whole number from 0.' });
		return { stock: 0, locations: {} };
	}
	return { stock: input.stock, locations: {} };
};

/**
 * A variant's attribute values (E7): only attributes kept on variants, each value checked (a choice may also be one of
 * the product's own values for it).
 * @param {Record<string, any>} input
 * @param {VariantRecord | null} existing
 * @param {CatalogRules & { custom?: ReadonlyMap<string, string[]> }} rules
 * @param {string} path
 * @param {FieldError[]} errors
 * @returns {NonNullable<VariantRecord['attributes']>}
 */
const variantAttributesOf = (input, existing, rules, path, errors) => {
	if (input.attributes === undefined) return existing?.attributes ?? {};
	if (!isObject(input.attributes)) {
		errors.push({ path: `${path}/attributes`, message: 'Give the attribute values by attribute id.' });
		return existing?.attributes ?? {};
	}
	/** @type {NonNullable<VariantRecord['attributes']>} */
	const out = {};
	for (const [id, value] of Object.entries(input.attributes)) {
		if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
		const attribute = rules.attributes.get(id);
		if (!attribute || attribute.on !== 'variant') {
			errors.push({ path: `${path}/attributes/${id}`, message: 'There is no such variant field.' });
			continue;
		}
		const checked = specValue(attribute, value, rules.custom?.get(id) ?? []);
		if (!checked.ok) errors.push({ path: `${path}/attributes/${id}`, message: checked.message });
		else out[id] = checked.value;
	}
	return out;
};

/**
 * The type and size of a file moved in by an import, as given ('' and 0 when not known; no bucket check: the file is
 * already in the merchant's storage).
 * @param {Record<string, any>} entry
 * @param {string} path
 * @param {FieldError[]} errors
 * @returns {{ type: string, size: number }}
 */
export const givenFacts = (entry, path, errors) => {
	const type = entry.type ?? '';
	const size = entry.size ?? 0;
	const typeOk = typeof type === 'string' && type.length <= 100;
	const sizeOk = isCount(size, Number.MAX_SAFE_INTEGER);
	if (!typeOk) errors.push({ path: `${path}/type`, message: 'The type is a media type of at most 100 characters.' });
	if (!sizeOk) errors.push({ path: `${path}/size`, message: 'The size is a whole number of bytes from 0.' });
	return { type: typeOk ? type : '', size: sizeOk ? size : 0 };
};

/**
 * A variant's photos (E6): files uploaded for the product (the route checks new ones in the bucket), or keys the
 * product already holds whatever their folder (CA-5).
 * @param {Record<string, any>} input
 * @param {VariantRecord | null} existing
 * @param {Place} place
 * @param {string} path
 * @param {FieldError[]} errors
 * @returns {MediaRecord[]}
 */
const variantMediaOf = (input, existing, place, path, errors) => {
	if (input.media === undefined) return existing?.media ?? [];
	if (!Array.isArray(input.media) || input.media.length > LIMITS.variantMedia) {
		errors.push({ path: `${path}/media`, message: `A variant has at most ${LIMITS.variantMedia} photos.` });
		return existing?.media ?? [];
	}
	const { folder, held, importing } = place;
	if (input.media.length > 0 && folder === null) {
		errors.push({ path: `${path}/media`, message: 'Add variant photos once the product is saved.' });
		return [];
	}
	const known = new Map((existing?.media ?? []).map((file) => [file.key, file]));
	/** @type {MediaRecord[]} */
	const out = [];
	input.media.forEach((entry, index) => {
		const at = `${path}/media/${index}`;
		const key = isObject(entry) ? entry.key : undefined;
		if (
			folder === null ||
			!keyAllowed(key, folder, held) ||
			(importing && !publicPhoto(key, entry.type)) ||
			out.some((file) => file.key === key)
		) {
			errors.push({ path: `${at}/key`, message: 'Give the key of a photo uploaded for this product, once.' });
			return;
		}
		const alt = entry.alt === undefined ? (known.get(key)?.alt ?? '') : cleanText(entry.alt, LIMITS.alt);
		if (alt === null) errors.push({ path: `${at}/alt`, message: `Alternative text has at most ${LIMITS.alt} characters.` });
		const before = known.get(key);
		out.push({
			key,
			...(importing ? givenFacts(entry, at, errors) : { type: before?.type ?? '', size: before?.size ?? 0 }),
			alt: alt ?? '',
			...(before ? { ...before, alt: alt ?? before.alt } : {}),
			...mediaExtras(entry, folder, at, errors, held),
		});
	});
	return out;
};

/** An item or item group id of a product feed (Google takes at most 50 characters). */
const FEED_ID = /^[A-Za-z0-9._-]{1,50}$/;

/**
 * The feed id an import gives (E17: the id the shop's earlier product feed used, so shopping catalogs keep their
 * items), '' for none; only an import sets it, and later edits keep it.
 * @param {unknown} value @param {string} path @param {FieldError[]} errors
 * @returns {string}
 */
const importedFeedId = (value, path, errors) => {
	if (value === undefined || value === '') return '';
	if (typeof value === 'string' && FEED_ID.test(value)) return value;
	errors.push({ path, message: 'A feed id has 1 to 50 letters, digits, dots, dashes or underscores.' });
	return '';
};

/** The parts of a package: its weight in grams, its size in millimeters. */
const PARCEL_PARTS = Object.freeze(/** @type {const} */ (['weightG', 'lengthMm', 'widthMm', 'heightMm']));

/**
 * A variant's package (an item type with the `parcel` element): its weight in grams and its length, width and height in
 * millimeters, each a whole number from 1 or null, the size given whole or not at all; null when nothing is known.
 * @param {unknown} value @param {string} path @param {FieldError[]} errors
 * @returns {import('./model.js').Parcel | null}
 */
const parcelOf = (value, path, errors) => {
	if (value === null) return null;
	if (!isObject(value) || Object.keys(value).some((part) => !PARCEL_PARTS.includes(/** @type {any} */ (part)))) {
		errors.push({ path, message: 'Give the package as { weightG, lengthMm, widthMm, heightMm }, or null.' });
		return null;
	}
	/** @type {Record<string, number | null>} */
	const out = {};
	for (const part of PARCEL_PARTS) {
		const given = value[part] ?? null;
		const ok = given === null || (Number.isSafeInteger(given) && given >= 1 && given <= LIMITS.parcel);
		if (!ok)
			errors.push({
				path: `${path}/${part}`,
				message: `Give whole grams or millimeters from 1 to ${LIMITS.parcel}, or null.`,
			});
		out[part] = ok ? given : null;
	}
	const sizes = [out.lengthMm, out.widthMm, out.heightMm].filter((size) => size !== null).length;
	if (sizes !== 0 && sizes !== 3)
		errors.push({ path: `${path}/lengthMm`, message: 'Give the length, the width and the height together.' });
	return Object.values(out).every((part) => part === null) ? null : /** @type {import('./model.js').Parcel} */ (out);
};

/**
 * A variant from input, merged over the existing one (whose stock is kept).
 * @param {Record<string, any>} input
 * @param {VariantRecord | null} existing
 * @param {CatalogRules & { typeKey?: string }} rules `typeKey`: the product's item type (its grades)
 * @param {string} path
 * @param {FieldError[]} errors
 * @param {Place} [place] where its photos may come from
 * @param {string} [id] its id as an import gives it
 * @returns {VariantRecord}
 */
const variantOf = (input, existing, rules, path, errors, place = NEW_PLACE, id = undefined) => {
	/** @param {string} field @param {string} message */
	const fail = (field, message) => errors.push({ path: `${path}/${field}`, message });
	const sku = input.sku === undefined ? (existing?.sku ?? '') : cleanText(input.sku, LIMITS.sku);
	if (sku === null) fail('sku', `A SKU has at most ${LIMITS.sku} characters.`);
	// the barcode number and the manufacturer part number shopping catalogs match items by (SEO audit G5.6)
	const gtin =
		input.gtin === undefined ? (existing?.gtin ?? '') : input.gtin === null || input.gtin === '' ? '' : gtinOf(input.gtin);
	if (gtin === null) fail('gtin', 'A GTIN is 8, 12, 13 or 14 digits ending in its GS1 check digit.');
	const mpn = input.mpn === undefined ? (existing?.mpn ?? '') : input.mpn === null ? '' : cleanText(input.mpn, LIMITS.mpn);
	if (mpn === null) fail('mpn', `An MPN has at most ${LIMITS.mpn} characters.`);
	const price = input.price === undefined ? existing?.price : input.price;
	if (!isAmount(price)) fail('price', 'The price is a whole number of minor units from 0.');
	/** @param {string} field */
	const optionalPrice = (field) => {
		const value = input[field] === undefined ? (existing ? /** @type {any} */ (existing)[field] : null) : input[field];
		if (value !== null && !isAmount(value)) fail(field, 'Give a whole number of minor units from 0, or null.');
		return value === null || isAmount(value) ? value : null;
	};
	const compareAtPrice = optionalPrice('compareAtPrice');
	const cost = optionalPrice('cost');
	let grade = existing?.grade ?? null;
	if (input.grade !== undefined) {
		if (input.grade === null || input.grade === '') grade = null;
		else if (!rules.grades || typeof input.grade !== 'string' || !rules.gradeKeys.has(input.grade))
			fail('grade', 'Pick a grade of your grades list.');
		else if (rules.typeKey !== undefined && !gradeForType(rules.gradeTypes.get(input.grade) ?? [], rules.typeKey))
			fail('grade', 'This grade is not for this item type: pick one of its grades.');
		else grade = input.grade;
	}
	if (input.active !== undefined && typeof input.active !== 'boolean') fail('active', 'Active is true or false.');
	if (input.soldOut !== undefined && typeof input.soldOut !== 'boolean') fail('soldOut', 'Sold out is true or false.');
	// its own warranty time (E14): a number and its unit, null: the product's
	const warrantyTime = input.warrantyTime === undefined ? (existing?.warrantyTime ?? null) : durationOf(input.warrantyTime);
	if (warrantyTime === undefined) fail('warrantyTime', DURATION_RULE);
	const parcel = input.parcel === undefined ? (existing?.parcel ?? null) : parcelOf(input.parcel, `${path}/parcel`, errors);
	if (input.parcel !== undefined && input.parcel !== null && !rules.parcels) fail('parcel', 'Switch on Delivery zones first.');
	const attributes = variantAttributesOf(input, existing, rules, path, errors);
	const media = variantMediaOf(input, existing, place, path, errors);
	const stock = existing ? { stock: existing.stock, locations: existing.locations } : stockOf(input, rules, path, errors);
	const feedId = rules.importing ? importedFeedId(input.feedId, `${path}/feedId`, errors) : (existing?.feedId ?? '');
	/** @type {Record<string, string>} */
	const options = {};
	if (input.options !== undefined && !isObject(input.options)) fail('options', 'Give the option values.');
	for (const [name, value] of Object.entries(isObject(input.options) ? input.options : (existing?.options ?? {}))) {
		const text = cleanText(value, LIMITS.axisValue);
		if (text) options[name] = text;
	}
	return {
		id: existing?.id ?? id ?? rules.newId('var'),
		sku: sku ?? '',
		options,
		price: isAmount(price) ? price : 0,
		compareAtPrice,
		cost,
		stock: stock.stock,
		locations: stock.locations,
		grade,
		active: typeof input.active === 'boolean' ? input.active : (existing?.active ?? true),
		attributes,
		media,
		soldOut: typeof input.soldOut === 'boolean' ? input.soldOut : (existing?.soldOut ?? false),
		warrantyTime: warrantyTime ?? null,
		...(gtin ? { gtin } : {}),
		...(mpn ? { mpn } : {}),
		...(parcel ? { parcel } : {}),
		...(feedId ? { feedId } : {}),
	};
};

/** The fields of a single-variant product that may be given at the top level. */
const SHORTCUT = Object.freeze([
	'sku',
	'gtin',
	'mpn',
	'price',
	'compareAtPrice',
	'cost',
	'stock',
	'locations',
	'grade',
	'parcel',
]);

/**
 * The option axes and each variant's option values derived from variant attributes (E7): one axis per attribute used
 * that shoppers see on the product page (a staff-only variant field names no option), in the attributes' order, its
 * values as shoppers read them (several values joined with commas).
 * @param {VariantRecord[]} variants
 * @param {ReadonlyMap<string, AttributeRecord>} attributes
 */
export const optionsFromAttributes = (variants, attributes) => {
	const used = [...attributes.values()]
		.filter((attribute) => attribute.show.page && variants.some((variant) => variant.attributes?.[attribute.id] !== undefined))
		.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
	/** @type {Array<{ name: string, values: string[] }>} */
	const axes = used.map((attribute) => ({ name: attribute.name, values: [] }));
	const next = variants.map((variant) => {
		/** @type {Record<string, string>} */
		const options = {};
		used.forEach((attribute, index) => {
			const value = variant.attributes?.[attribute.id];
			if (value === undefined) return;
			const label = valueLabel(attribute, value).slice(0, LIMITS.axisValue);
			options[attribute.name] = label;
			const axis = /** @type {{ name: string, values: string[] }} */ (axes[index]);
			if (!axis.values.includes(label)) axis.values.push(label);
		});
		return { ...variant, options };
	});
	return { axes, variants: next };
};

/**
 * The variants of the next product, with the option axes (given, or derived from variant attributes).
 * @param {Record<string, any>} input
 * @param {ProductRecord | null} existing
 * @param {Array<{ name: string, values: string[] }>} given the option axes as given or kept
 * @param {CatalogRules & { custom?: ReadonlyMap<string, string[]>, typeKey?: string }} rules
 * @param {FieldError[]} errors
 * @returns {{ variants: VariantRecord[], options: Array<{ name: string, values: string[] }> }}
 */
const variantsOf = (input, existing, given, rules, errors) => {
	const importing = rules.importing === true;
	/** @type {Place} */
	const place = importing
		? { folder: '', held: NO_KEYS, importing }
		: existing
			? { folder: `ecommerce/products/${existing.id}/`, held: heldKeys(existing), importing }
			: NEW_PLACE;
	const shortcut = SHORTCUT.some((field) => input[field] !== undefined);
	/** @type {Record<string, any>} the single variant's fields given at the top level */
	const single = Object.fromEntries(
		SHORTCUT.filter((field) => input[field] !== undefined).map((field) => [field, input[field]]),
	);
	/** @type {VariantRecord[]} */
	let variants;
	if (input.variants !== undefined) {
		if (shortcut) errors.push({ path: '/variants', message: 'Give either variants or the single price and SKU.' });
		// an imported shell may have no variant yet (CA-2)
		const least = importing ? 0 : 1;
		if (!Array.isArray(input.variants) || input.variants.length < least || input.variants.length > LIMITS.variants) {
			errors.push({ path: '/variants', message: `Give ${least} to ${LIMITS.variants} variants.` });
			return { variants: existing?.variants ?? [], options: given };
		}
		const known = new Map((existing?.variants ?? []).map((variant) => [variant.id, variant]));
		const seen = new Set();
		variants = input.variants.map((entry, index) => {
			const path = `/variants/${index}`;
			if (!isObject(entry)) {
				errors.push({ path, message: 'Each variant is an object.' });
				return variantOf({}, null, rules, path, []);
			}
			if (importing) {
				// an import gives every variant its own id (`var_…`)
				if (!isId(entry.id, 'var') || seen.has(entry.id))
					errors.push({ path: `${path}/id`, message: 'Give each variant its own id (var_…).' });
				seen.add(entry.id);
				return variantOf(entry, null, rules, path, errors, place, isId(entry.id, 'var') ? entry.id : undefined);
			}
			let before = null;
			if (entry.id !== undefined) {
				before = known.get(entry.id) ?? null;
				if (!before || seen.has(entry.id))
					errors.push({ path: `${path}/id`, message: 'This variant is not part of the product.' });
				seen.add(entry.id);
			}
			return variantOf(entry, before, rules, path, errors, place);
		});
	} else if (existing) {
		if (shortcut && existing.variants.length > 1)
			errors.push({ path: '/variants', message: 'This product has several variants: change them in variants.' });
		// the single variant's fields change it, or make the first one of a draft without variants (CA-2)
		variants = !shortcut
			? existing.variants
			: existing.variants.length === 1
				? [variantOf(single, /** @type {VariantRecord} */ (existing.variants[0]), rules, '', errors, place)]
				: existing.variants.length === 0
					? [variantOf(single, null, rules, '', errors, place)]
					: existing.variants;
	} else variants = [variantOf(single, null, rules, '', errors, place)];

	if (!rules.variants && variants.length > 1)
		errors.push({ path: '/variants', message: 'Switch on Variants to sell more than one variant.' });
	const total = variants.reduce((sum, variant) => sum + variant.media.length, 0);
	if (total > LIMITS.allVariantMedia)
		errors.push({ path: '/variants', message: `A product's variants have at most ${LIMITS.allVariantMedia} photos together.` });

	// variant attributes shoppers see decide the options (E7); two variants may share options when their grades differ
	const byAttributes = variants.some((variant) =>
		Object.keys(variant.attributes).some((id) => rules.attributes.get(id)?.show.page === true),
	);
	/** @type {Array<{ name: string, values: string[] }>} */
	let options = given;
	if (byAttributes) {
		const derived = optionsFromAttributes(variants, rules.attributes);
		if (derived.axes.length > LIMITS.axes)
			errors.push({ path: '/variants', message: `Variants use at most ${LIMITS.axes} attributes.` });
		options = derived.axes;
		variants = derived.variants;
	} else if (given.length === 0) {
		if (variants.length > 1) errors.push({ path: '/variants', message: 'Several variants need options (such as Size).' });
		return { variants: variants.map((variant) => ({ ...variant, options: {} })), options };
	}
	const combinations = new Set();
	variants.forEach((variant, index) => {
		if (!byAttributes) {
			const names = Object.keys(variant.options);
			const fits =
				names.length === options.length &&
				options.every((axis) => axis.values.includes(/** @type {string} */ (variant.options[axis.name])));
			if (!fits) {
				errors.push({ path: `/variants/${index}/options`, message: 'Give one value of each option.' });
				return;
			}
		}
		const key = JSON.stringify([...options.map((axis) => variant.options[axis.name] ?? null), variant.grade]);
		if (combinations.has(key))
			errors.push({ path: `/variants/${index}/options`, message: 'Two variants have the same options and grade.' });
		combinations.add(key);
	});
	return { variants, options };
};

/**
 * A product's attribute setup (E7): per attribute, the values it uses (the generator makes variants of them), its own
 * extra values and the value picked first.
 * @param {Record<string, any>} input
 * @param {ProductRecord | null} existing
 * @param {CatalogRules} rules
 * @param {FieldError[]} errors
 * @returns {NonNullable<ProductRecord['attributeSetup']>}
 */
const setupOf = (input, existing, rules, errors) => {
	const before = existing?.attributeSetup ?? [];
	if (input.attributeSetup === undefined) return before;
	if (!Array.isArray(input.attributeSetup) || input.attributeSetup.length > LIMITS.setup) {
		errors.push({ path: '/attributeSetup', message: `Set up at most ${LIMITS.setup} attributes.` });
		return before;
	}
	/** @type {NonNullable<ProductRecord['attributeSetup']>} */
	const out = [];
	input.attributeSetup.forEach((entry, index) => {
		const path = `/attributeSetup/${index}`;
		const attribute = isObject(entry) ? rules.attributes.get(String(entry.attributeId)) : undefined;
		if (!isObject(entry) || !attribute || out.some((other) => other.attributeId === attribute.id))
			return void errors.push({ path: `${path}/attributeId`, message: 'Pick an attribute once.' });
		/** @type {string[]} */
		const customValues = [];
		for (const value of Array.isArray(entry.customValues) ? entry.customValues : []) {
			const text = cleanText(value, LIMITS.specText);
			if (text && !customValues.includes(text)) customValues.push(text);
		}
		if (
			entry.customValues !== undefined &&
			(!Array.isArray(entry.customValues) || customValues.length !== entry.customValues.length)
		)
			errors.push({ path: `${path}/customValues`, message: 'Give different values of up to 200 characters.' });
		const raw = entry.values === undefined ? [] : entry.values;
		/** @type {Array<string | number>} */
		const values = [];
		if (!Array.isArray(raw) || raw.length > LIMITS.setupValues)
			errors.push({ path: `${path}/values`, message: `Give at most ${LIMITS.setupValues} values.` });
		else
			for (const value of raw) {
				const checked = specValue({ ...attribute, multiple: false }, value, customValues);
				if (
					!checked.ok ||
					typeof checked.value === 'boolean' ||
					Array.isArray(checked.value) ||
					values.includes(checked.value)
				)
					errors.push({ path: `${path}/values`, message: `Give different values of ${attribute.name}.` });
				else values.push(checked.value);
			}
		const defaultValue = entry.defaultValue ?? null;
		if (defaultValue !== null && !values.includes(defaultValue) && !customValues.includes(String(defaultValue)))
			errors.push({ path: `${path}/defaultValue`, message: 'The default is one of its values.' });
		out.push({ attributeId: attribute.id, values, customValues, defaultValue });
	});
	return out;
};

/**
 * Every missing combination of a product's set-up variant attribute values (E7), as new variants with a price and
 * stock; null when the product would have more than {@link LIMITS.variants} variants.
 * @param {Pick<ProductRecord, 'attributeSetup' | 'variants'>} product
 * @param {ReadonlyMap<string, AttributeRecord>} attributes
 * @param {{ price: number, stock: number | null }} start `stock` null: none given (multi-location stock)
 * @returns {Array<Record<string, any>> | null} the variants to add, as product input (attributes, price, stock)
 */
export const missingVariants = (product, attributes, { price, stock }) => {
	const axes = product.attributeSetup
		.map((entry) => ({ attribute: attributes.get(entry.attributeId), values: [...entry.values, ...entry.customValues] }))
		.filter((axis) => axis.attribute?.on === 'variant' && axis.values.length > 0);
	if (axes.length === 0) return [];
	/** @type {Array<Record<string, string | number>>} */
	let combos = [{}];
	for (const axis of axes)
		combos = combos.flatMap((combo) =>
			axis.values.map((value) => ({ ...combo, [/** @type {AttributeRecord} */ (axis.attribute).id]: value })),
		);
	/** @param {Record<string, unknown>} values */
	const keyOf = (values) =>
		JSON.stringify(
			axes.map((axis) => {
				const value = values[/** @type {AttributeRecord} */ (axis.attribute).id];
				return Array.isArray(value) && value.length === 1 ? value[0] : (value ?? null);
			}),
		);
	const have = new Set(product.variants.map((variant) => keyOf(variant.attributes)));
	const missing = combos.filter((combo) => !have.has(keyOf(combo)));
	if (product.variants.length + missing.length > LIMITS.generated) return null;
	return missing.map((values) => ({ attributes: values, price, ...(stock === null ? {} : { stock }) }));
};

/**
 * The website's categories as item types read them (each one's path and own type key).
 * @param {Pick<CatalogRules, 'categoryPaths' | 'categoryTypes'>} rules
 */
const treeOf = (rules) =>
	new Map([...rules.categoryPaths].map(([id, path]) => [id, { path: [...path], typeKey: rules.categoryTypes.get(id) ?? null }]));

/**
 * The item type of a product (its own, its first category's, else the built-in one of its kind), as a check sees it.
 * @param {{ kind: string, typeKey?: string | null, categoryIds: string[] }} product
 * @param {Pick<CatalogRules, 'categoryPaths' | 'categoryTypes' | 'types'>} rules
 */
export const productType = (product, rules) => typeOf(product, rules.types, treeOf(rules));

/** @param {unknown} value whether a value is given (not missing, null, empty or an empty list or object) */
const isGiven = (value) =>
	value !== undefined &&
	value !== null &&
	value !== '' &&
	!(Array.isArray(value) && value.length === 0) &&
	!(isObject(value) && Object.keys(value).length === 0);

/**
 * Refuse values given for elements the product's item type does not have (dynamic model §1; a built-in type has every
 * one), each at its path: several variants, options, variant fields and their setup (`variants`), grades, a size chart
 * (`chart`), packages (`parcel`), per-item return and warranty days (`warranty`), a download limit (`downloads`), license
 * keys (`licenseKeys`) and a booking duration (`slots`); and values of fields a merchant's type does not name.
 * @param {Record<string, any>} input
 * @param {import('./item-types.js').ItemType} type
 * @param {FieldError[]} errors
 */
const typeGuards = (input, type, errors) => {
	const name = type.name || type.key;
	const on = type.elements;
	/** @param {string} path @param {string} what */
	const refuse = (path, what) => errors.push({ path, message: `${name} items have no ${what}: their item type leaves it out.` });
	/** @param {string} path */
	const notTaken = (path) => errors.push({ path, message: `This field is not one of the fields of ${name} items.` });
	/** @type {Array<[number, Record<string, any>]>} */
	const variants = Array.isArray(input.variants)
		? input.variants.flatMap((entry, index) =>
				isObject(entry) ? [/** @type {[number, Record<string, any>]} */ ([index, entry])] : [],
			)
		: [];
	if (!on.variants) {
		if (Array.isArray(input.variants) && input.variants.length > 1) refuse('/variants', 'variants');
		if (isGiven(input.options)) refuse('/options', 'options');
		if (isGiven(input.attributeSetup)) refuse('/attributeSetup', 'variant fields');
		for (const [index, variant] of variants)
			if (isObject(variant.attributes) && Object.values(variant.attributes).some(isGiven))
				refuse(`/variants/${index}/attributes`, 'variant fields');
	}
	if (!on.grades) {
		if (isGiven(input.grade)) refuse('/grade', 'grades');
		for (const [index, variant] of variants) if (isGiven(variant.grade)) refuse(`/variants/${index}/grade`, 'grades');
	}
	if (!on.chart) {
		if (isGiven(input.sizeChartId)) refuse('/sizeChartId', 'size chart');
		if (input.hideSizeGuide === true) refuse('/hideSizeGuide', 'size chart');
	}
	if (!on.parcel) {
		if (isGiven(input.parcel)) refuse('/parcel', 'package');
		for (const [index, variant] of variants) if (isGiven(variant.parcel)) refuse(`/variants/${index}/parcel`, 'package');
	}
	if (!on.warranty) {
		for (const time of ['returnTime', 'warrantyTime'])
			if (isGiven(input[time])) refuse(`/${time}`, 'own return and warranty times');
		for (const [index, variant] of variants)
			if (isGiven(variant.warrantyTime)) refuse(`/variants/${index}/warrantyTime`, 'own return and warranty times');
	}
	if (type.kind === 'digital' && isObject(input.digital)) {
		if (!on.downloads && isGiven(input.digital.downloadLimit) && input.digital.downloadLimit !== 0)
			refuse('/digital/downloadLimit', 'downloads');
		if (!on.licenseKeys && input.digital.licenseKeys === true) refuse('/digital/licenseKeys', 'license keys');
	}
	if (type.kind === 'service' && !on.slots && isGiven(input.booking)) refuse('/booking', 'booked time slots');
	if (type.fieldIds === null) return;
	if (isObject(input.specs))
		for (const [id, value] of Object.entries(input.specs)) if (isGiven(value) && !typeTakes(type, id)) notTaken(`/specs/${id}`);
	for (const [index, variant] of variants)
		if (isObject(variant.attributes))
			for (const [id, value] of Object.entries(variant.attributes))
				if (isGiven(value) && !typeTakes(type, id)) notTaken(`/variants/${index}/attributes/${id}`);
};

/**
 * Check a new product or changes to an existing one, and give the next editable fields.
 * @param {unknown} body
 * @param {CatalogRules} rules
 * @param {ProductRecord | null} existing null = a new product
 * @returns {{ ok: true, value: ProductFields } | { ok: false, errors: FieldError[] }}
 */
export const checkProduct = (body, rules, existing) => {
	if (!isObject(body)) return { ok: false, errors: [{ path: '', message: 'Send the product as an object.' }] };
	const input = body;
	/** @type {FieldError[]} */
	const errors = [];
	/** @param {string} path @param {string} message */
	const fail = (path, message) => errors.push({ path, message });
	/**
	 * @template T
	 * @param {string} field
	 * @param {(value: unknown) => T | null | undefined} read null/undefined = invalid
	 * @param {T} fallback for a new product
	 * @param {string} message
	 * @returns {T}
	 */
	const field = (field, read, fallback, message) => {
		/** @type {Record<string, any> | null} */
		const before = existing;
		const kept = before ? before[field] : fallback;
		if (input[field] === undefined) return kept;
		const value = read(input[field]);
		if (value === null || value === undefined) {
			fail(`/${field}`, message);
			return kept;
		}
		return value;
	};

	const name = field('name', (v) => cleanText(v, LIMITS.name) || null, '', `Give a name of 1 to ${LIMITS.name} characters.`);
	if (!existing && input.name === undefined) fail('/name', 'Give the product a name.');
	const slug = field('slug', (v) => (v === '' ? '' : isSlug(v) ? v : null), '', 'Use lowercase letters, digits and dashes.');
	// the item type (dynamic model §1): one of the list (offered, or the one it has) or a built-in one; null = its first
	// category's, else the built-in type of its kind
	let typeKey = existing?.typeKey ?? null;
	/** @type {import('./item-types.js').ItemType | null} the type the input names */
	let named = null;
	if (input.typeKey !== undefined) {
		const found = typeof input.typeKey === 'string' ? typeByKey(input.typeKey, rules.types) : null;
		if (input.typeKey === null || input.typeKey === '') typeKey = null;
		else if (found && (found.active || found.key === existing?.typeKey)) {
			typeKey = found.key;
			named = found;
		} else fail('/typeKey', 'Pick an item type of your list, or null for its category’s.');
	}
	const status = field(
		'status',
		(v) => (PRODUCT_STATUSES.includes(/** @type {any} */ (v)) ? /** @type {any} */ (v) : null),
		'draft',
		'Status is draft, active or archived.',
	);
	const summary = field(
		'summary',
		(v) => cleanText(v, LIMITS.summary),
		'',
		`A summary has at most ${LIMITS.summary} characters.`,
	);
	const description = field(
		'description',
		(v) => cleanText(v, LIMITS.description, { multiline: true }),
		'',
		`A description has at most ${LIMITS.description} characters.`,
	);
	const categoryIds = field(
		'categoryIds',
		(v) =>
			Array.isArray(v) && v.length <= LIMITS.categories && v.every((id) => typeof id === 'string' && rules.categoryIds.has(id))
				? [...new Set(/** @type {string[]} */ (v))]
				: null,
		/** @type {string[]} */ ([]),
		'Pick existing categories.',
	);
	// the kind: as given, else the kind of the type the input names, else (a new product) its category's type's, else
	// physical; a product's own type is of its kind
	const tree = treeOf(rules);
	const givenKind = input.kind === undefined || KINDS.includes(input.kind) ? input.kind : null;
	if (givenKind === null) fail('/kind', 'Kind is physical, digital or service.');
	const categoryKind = () => {
		const first = categoryIds[0];
		return first ? typeByKey(categoryTypeKey(first, rules.types, tree), rules.types)?.kind : undefined;
	};
	/** @type {import('./model.js').ProductKind} */
	const kind = givenKind ?? named?.kind ?? existing?.kind ?? categoryKind() ?? 'physical';
	const own = typeByKey(typeKey, rules.types);
	if (own && own.kind !== kind)
		fail('/typeKey', `${own.name || own.key} is an item type of ${own.kind} items: pick one of ${kind} items, or null.`);
	if (kind === 'digital' && !rules.digital && (!existing || input.kind !== undefined))
		fail('/kind', 'Switch on Digital goods to sell digital products.');
	if (kind === 'service' && !rules.bookings && (!existing || input.kind !== undefined))
		fail('/kind', 'Switch on Services and bookings to sell services.');
	const type = typeOf({ kind, typeKey, categoryIds }, rules.types, tree);
	typeGuards(input, type, errors);

	let brandId = existing?.brandId ?? null;
	if (input.brandId !== undefined) {
		if (input.brandId === null || input.brandId === '') brandId = null;
		else if (typeof input.brandId === 'string' && rules.brandIds.has(input.brandId)) brandId = input.brandId;
		else fail('/brandId', 'Pick an existing brand.');
	}
	const tags = field(
		'tags',
		(v) => {
			if (!Array.isArray(v) || v.length > LIMITS.tags) return null;
			const out = v.map((tag) => cleanText(tag, LIMITS.tag));
			return out.every((tag) => tag) ? [.../** @type {Set<string>} */ (new Set(out))] : null;
		},
		/** @type {string[]} */ ([]),
		`Give at most ${LIMITS.tags} tags of up to ${LIMITS.tag} characters.`,
	);

	const attributeSetup = setupOf(input, existing, rules, errors);
	/** @type {Map<string, string[]>} the product's own values per attribute (E7) */
	const custom = new Map(attributeSetup.map((entry) => [entry.attributeId, entry.customValues]));

	/** @type {ProductRecord['specs']} */
	let specs = existing?.specs ?? {};
	if (input.specs !== undefined) {
		if (!isObject(input.specs) || Object.keys(input.specs).length > LIMITS.specs)
			fail('/specs', 'Give the specs by attribute.');
		else {
			specs = {};
			for (const [id, value] of Object.entries(input.specs)) {
				if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
				const attribute = rules.attributes.get(id);
				const checked = attribute ? specValue(attribute, value, custom.get(id) ?? []) : null;
				if (!attribute || !checked || attribute.on !== 'product') fail(`/specs/${id}`, 'There is no such product field.');
				else if (!checked.ok) fail(`/specs/${id}`, checked.message);
				else specs[id] = checked.value;
			}
		}
	}

	const given = input.options === undefined ? (existing?.options ?? []) : optionsOf(input.options, errors);
	if (given.length > 0 && !rules.variants) fail('/options', 'Switch on Variants to give options.');
	const { variants, options } = variantsOf(input, existing, given, { ...rules, custom, typeKey: type.key }, errors);
	const skus = variants.map((variant) => variant.sku).filter(Boolean);
	if (new Set(skus).size !== skus.length) fail('/variants', 'Each variant needs its own SKU.');
	// a draft without variants (an imported shell, CA-2) goes on sale once it has one
	if (variants.length === 0 && status === 'active') fail('/status', 'Add a variant before the product goes on sale.');
	// a product on sale has the required fields of its categories: its own, and those of each variant on sale (§2)
	if (status === 'active') {
		const lineage = categoryIds.flatMap((id) => [id, ...(rules.categoryPaths.get(id) ?? [])]);
		for (const required of rules.attributes.values()) {
			if (!required.required || !required.active || !fieldApplies(required, lineage) || !typeTakes(type, required.id))
				continue;
			const needed = `${required.name} is required on products on sale.`;
			if (required.on === 'product' && specs[required.id] === undefined) fail(`/specs/${required.id}`, needed);
			if (required.on === 'variant')
				variants.forEach((variant, index) => {
					if (variant.active && variant.attributes[required.id] === undefined)
						fail(`/variants/${index}/attributes/${required.id}`, needed);
				});
		}
	}

	const trackStock = field(
		'trackStock',
		(v) => (typeof v === 'boolean' ? v : null),
		kind === 'physical',
		'Track stock is true or false.',
	);

	/** @type {ProductRecord['digital']} */
	let digital = null;
	if (kind === 'digital') {
		const before = existing?.digital ?? { files: [], retired: [], licenseKeys: false, downloadLimit: 0 };
		const given = input.digital === undefined ? {} : input.digital;
		if (!isObject(given)) fail('/digital', 'Give the download settings.');
		const raw = isObject(given) ? given : {};
		if (raw.licenseKeys !== undefined && typeof raw.licenseKeys !== 'boolean')
			fail('/digital/licenseKeys', 'License keys is true or false.');
		if (raw.downloadLimit !== undefined && !isCount(raw.downloadLimit, LIMITS.downloadLimit))
			fail('/digital/downloadLimit', `Downloads are a whole number from 0 (no limit) to ${LIMITS.downloadLimit}.`);
		digital = {
			files: before.files,
			retired: before.retired,
			licenseKeys: typeof raw.licenseKeys === 'boolean' ? raw.licenseKeys : before.licenseKeys,
			downloadLimit: isCount(raw.downloadLimit, LIMITS.downloadLimit) ? raw.downloadLimit : before.downloadLimit,
		};
	}
	// a service booked in time slots (its type's `slots`): how long one lasts, and the booking schedule it is booked on
	// ('' = the first; E30)
	/** @type {ProductRecord['booking']} */
	let booking = null;
	if (kind === 'service' && type.elements.slots) {
		const given = isObject(input.booking) ? input.booking : {};
		const minutes = given.durationMinutes ?? existing?.booking?.durationMinutes;
		const schedule = given.schedule ?? existing?.booking?.schedule ?? '';
		if (!Number.isSafeInteger(minutes) || Number(minutes) < 5 || Number(minutes) > 1440)
			fail('/booking/durationMinutes', 'A booking lasts 5 to 1440 minutes.');
		else if (schedule !== '' && (typeof schedule !== 'string' || !/^[a-z][a-z0-9_]{1,39}$/.test(schedule)))
			fail('/booking/schedule', 'The schedule is the key of a booking schedule, or empty for the first.');
		else booking = { durationMinutes: Number(minutes), schedule: String(schedule) };
	}

	const seo = checkSeo(input.seo, existing?.seo, '/seo', errors);
	let faqs = existing?.faqs ?? [];
	if (input.faqs !== undefined) faqs = checkFaqs(input.faqs, CONTENT_LIMITS.faqs, '/faqs', errors) ?? faqs;
	const featured = field('featured', (v) => (typeof v === 'boolean' ? v : null), false, 'Featured is true or false.');
	const hideSizeGuide = field(
		'hideSizeGuide',
		(v) => (typeof v === 'boolean' ? v : null),
		false,
		'Hide size guide is true or false.',
	);
	let sizeChartId = existing?.sizeChartId ?? null;
	if (input.sizeChartId !== undefined) {
		if (input.sizeChartId === null || input.sizeChartId === '') sizeChartId = null;
		else if (rules.sizeCharts && typeof input.sizeChartId === 'string' && rules.sizeChartIds?.has(input.sizeChartId))
			sizeChartId = input.sizeChartId;
		else fail('/sizeChartId', rules.sizeCharts ? 'Pick an existing size chart.' : 'Switch on Size charts first.');
	}
	// a rich description (E3): cleaned, and the plain description is derived from it
	let descriptionHtml = existing?.descriptionHtml ?? '';
	let plain = description;
	if (input.descriptionHtml !== undefined) {
		const html = checkHtml(input.descriptionHtml);
		if (html === null) fail('/descriptionHtml', `A rich description has at most ${LIMITS.description} characters.`);
		else descriptionHtml = html;
	}
	if (descriptionHtml) plain = htmlToText(descriptionHtml).slice(0, LIMITS.description);
	else if (input.descriptionHtml !== undefined && input.description === undefined && existing?.descriptionHtml) plain = '';
	/** @type {ProductRecord['video']} */
	let video = existing?.video ?? null;
	if (input.video !== undefined) {
		const checked = checkVideo(input.video, '/video', errors);
		if (checked !== undefined) {
			// a new file is under the product's folder; a key it already holds stays whatever its folder (CA-5)
			const folder = rules.importing ? '' : existing ? `ecommerce/products/${existing.id}/` : null;
			const held = existing ? heldKeys(existing) : NO_KEYS;
			if (checked?.kind === 'file' && (folder === null || !keyAllowed(checked.key, folder, held)))
				fail('/video/key', 'Give the key of a video uploaded for this product (save the product first).');
			else if (checked?.kind === 'file' && rules.importing) {
				// an imported file keeps the type and size the import gives (MP4 or WebM)
				const facts = givenFacts(/** @type {Record<string, any>} */ (input.video), '/video', errors);
				if (!Object.hasOwn(VIDEO_TYPES, facts.type)) fail('/video/type', 'A video file is video/mp4 or video/webm.');
				video = { kind: 'file', key: checked.key, ...facts };
			}
			// a file keeps its type and size when it is the same file; the route fills them for a new one
			else
				video =
					checked?.kind === 'file'
						? existing?.video?.kind === 'file' && existing.video.key === checked.key
							? existing.video
							: { kind: 'file', key: checked.key, type: '', size: 0 }
						: checked;
		}
	}
	/** Its own return or warranty time (E14): a number and its unit; null: its grade's, else the setting's. @param {'returnTime' | 'warrantyTime'} name */
	const timeOf = (name) => {
		const before = existing?.[name] ?? null;
		if (input[name] === undefined) return before;
		const given = durationOf(input[name]);
		if (given === undefined) {
			fail(`/${name}`, DURATION_RULE);
			return before;
		}
		return given;
	};
	const returnTime = timeOf('returnTime');
	const warrantyTime = timeOf('warrantyTime');
	// the product that replaces it once archived (G9); the route checks that it exists
	let replacedBy = existing?.replacedBy ?? null;
	if (input.replacedBy !== undefined) {
		if (input.replacedBy === null || input.replacedBy === '') replacedBy = null;
		else if (isId(input.replacedBy, 'prd') && input.replacedBy !== existing?.id) replacedBy = input.replacedBy;
		else fail('/replacedBy', 'Give the id of another product, or null.');
	}
	const feedGroupId = rules.importing
		? importedFeedId(input.feedGroupId, '/feedGroupId', errors)
		: (existing?.feedGroupId ?? '');

	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			slug,
			name,
			kind,
			typeKey,
			status,
			summary,
			description: plain,
			categoryIds,
			brandId,
			tags,
			specs,
			options,
			variants,
			trackStock,
			digital,
			booking,
			seo,
			returnTime,
			warrantyTime,
			replacedBy,
			featured,
			descriptionHtml,
			video,
			sizeChartId,
			hideSizeGuide,
			attributeSetup,
			faqs,
			...(feedGroupId ? { feedGroupId } : {}),
		},
	};
};

/**
 * A new price after a bulk change: `percent` (−90 = 90 % off, 10 = 10 % more) or `fixed` (minor units added, may be
 * negative); rounded to whole minor units and never below 0.
 * @param {number} price
 * @param {{ mode: 'percent' | 'fixed', value: number }} change
 */
export const changedPrice = (price, { mode, value }) =>
	Math.max(0, mode === 'percent' ? Math.round(price + (price * value) / 100) : Math.round(price + value));

/**
 * Check a bulk price change.
 * @param {unknown} value
 * @returns {{ mode: 'percent' | 'fixed', value: number } | null}
 */
export const checkPriceChange = (value) => {
	if (!isObject(value)) return null;
	if (value.mode === 'percent' && typeof value.value === 'number' && Number.isFinite(value.value))
		return value.value >= -100 && value.value <= 1000 ? { mode: 'percent', value: value.value } : null;
	if (value.mode === 'fixed' && Number.isSafeInteger(value.value) && Math.abs(value.value) <= 1_000_000_000_000)
		return { mode: 'fixed', value: value.value };
	return null;
};

/**
 * Apply a stock change to a variant: set or adjust, overall or at one location (then `stock` is the sum of its
 * locations). Null when the result would be below 0 or above the limit.
 * @param {Pick<VariantRecord, 'stock' | 'locations'>} variant
 * @param {{ set?: number, adjust?: number, locationId?: string | null }} change
 * @returns {{ stock: number, locations: Record<string, number> } | null}
 */
export const changedStock = (variant, { set, adjust, locationId = null }) => {
	if (locationId) {
		const current = variant.locations[locationId] ?? 0;
		const next = set ?? current + (adjust ?? 0);
		if (next < 0 || next > LIMITS.stock) return null;
		const locations = { ...variant.locations, [locationId]: next };
		return { stock: Object.values(locations).reduce((a, b) => a + b, 0), locations };
	}
	const next = set ?? variant.stock + (adjust ?? 0);
	if (next < 0 || next > LIMITS.stock) return null;
	return { stock: next, locations: variant.locations };
};

/**
 * Check a list of stock changes: set or adjust units, and/or mark a variant sold out (E9).
 * @param {unknown} value
 * @param {{ locations: boolean }} rules
 * @returns {{ ok: true, value: Array<{ variantId: string, set?: number, adjust?: number, locationId: string | null, soldOut?: boolean }> } | { ok: false, errors: FieldError[] }}
 */
export const checkStockChanges = (value, rules) => {
	const list = isObject(value) && Array.isArray(value.changes) ? value.changes : null;
	if (!list || list.length === 0 || list.length > LIMITS.variants)
		return { ok: false, errors: [{ path: '/changes', message: `Give 1 to ${LIMITS.variants} stock changes.` }] };
	/** @type {FieldError[]} */
	const errors = [];
	/** @type {Array<{ variantId: string, set?: number, adjust?: number, locationId: string | null, soldOut?: boolean }>} */
	const out = [];
	list.forEach((entry, index) => {
		const path = `/changes/${index}`;
		if (!isObject(entry) || typeof entry.variantId !== 'string')
			return void errors.push({ path, message: 'Name the variant.' });
		const hasSet = entry.set !== undefined;
		const hasAdjust = entry.adjust !== undefined;
		const hasSoldOut = entry.soldOut !== undefined;
		if (hasSoldOut && typeof entry.soldOut !== 'boolean')
			return void errors.push({ path: `${path}/soldOut`, message: 'Sold out is true or false.' });
		if (hasSet && hasAdjust) return void errors.push({ path, message: 'Give either set or adjust.' });
		if (!hasSet && !hasAdjust && !hasSoldOut) return void errors.push({ path, message: 'Give set, adjust or soldOut.' });
		if (hasSet && !isCount(entry.set, LIMITS.stock))
			return void errors.push({ path: `${path}/set`, message: 'Stock is a whole number from 0.' });
		if (hasAdjust && (!Number.isSafeInteger(entry.adjust) || Math.abs(entry.adjust) > LIMITS.stock))
			return void errors.push({ path: `${path}/adjust`, message: 'Adjust by a whole number.' });
		const locationId = typeof entry.locationId === 'string' && entry.locationId ? entry.locationId : null;
		if (hasSet || hasAdjust) {
			if (rules.locations && !locationId)
				return void errors.push({ path: `${path}/locationId`, message: 'Name the location.' });
			if (!rules.locations && locationId)
				return void errors.push({ path: `${path}/locationId`, message: 'Switch on Multi-location stock first.' });
		}
		out.push({
			variantId: entry.variantId,
			...(hasSet ? { set: entry.set } : hasAdjust ? { adjust: entry.adjust } : {}),
			locationId,
			...(hasSoldOut ? { soldOut: entry.soldOut } : {}),
		});
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
};
