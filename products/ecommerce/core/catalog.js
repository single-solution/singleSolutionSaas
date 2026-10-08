/**
 * The catalog's product rules (PLAN 0.8.8 Catalog, Items): what a product and its variants may hold, checked against
 * what is switched on (variants, multi-location stock, grades and serials, digital goods, bookings) and the website's
 * categories, brands, attributes, locations and grades. A check returns the product's next editable fields (a new
 * product, or an existing one with the changes applied); the adapter writes them. Stock of an existing variant is
 * never changed here (that is the stock routes' job, so a product edit cannot undo an order's stock hold). Also the
 * text helpers (slugs, bounded text) and price changes of bulk actions. No I/O.
 * @module
 */
import { isPrice } from './money.js';

/** @typedef {import('./model.js').ProductRecord} ProductRecord */
/** @typedef {import('./model.js').VariantRecord} VariantRecord */
/** @typedef {import('./model.js').AttributeRecord} AttributeRecord */
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
	axes: 3,
	axisName: 40,
	axisValues: 50,
	axisValue: 60,
	variants: 250,
	sku: 64,
	specs: 100,
	specText: 200,
	seoTitle: 200,
	seoDescription: 500,
	days: 3650,
	stock: 1_000_000_000,
	downloadLimit: 1000,
	media: 20,
	alt: 200,
});

/** Product kinds and statuses. */
const KINDS = Object.freeze(/** @type {const} */ (['physical', 'digital', 'booking']));
const STATUSES = Object.freeze(/** @type {const} */ (['draft', 'active', 'archived']));

/** Slugs: lowercase letters of any script, digits, single dashes. */
const SLUG_PATTERN = /^[\p{Ll}\p{Lo}\p{N}]+(?:-[\p{Ll}\p{Lo}\p{N}]+)*$/u;
/** Longest slug. */
const MAX_SLUG = 120;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** @param {unknown} value @returns {value is Record<string, any>} */
export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

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

/** @param {unknown} value @returns {value is number | null} */
const isDays = (value) => value === null || isCount(value, LIMITS.days);

/**
 * The variant's display name: its option values in the product's axis order (`Red / 128 GB`), '' without options.
 * @param {Array<{ name: string }>} options
 * @param {Record<string, string>} values
 */
export const variantName = (options, values) =>
	options
		.map((axis) => values[axis.name])
		.filter((value) => typeof value === 'string' && value !== '')
		.join(' / ');

/**
 * Price and availability of a product from its variants (as the ledger's `refreshProducts` computes them).
 * @param {Array<Pick<VariantRecord, 'active' | 'price' | 'stock'>>} variants
 * @param {boolean} trackStock
 */
export const summarize = (variants, trackStock) => {
	const active = variants.filter((variant) => variant.active);
	return {
		price: active.length > 0 ? Math.min(...active.map((variant) => variant.price)) : 0,
		inStock: active.some((variant) => !trackStock || variant.stock > 0),
	};
};

/**
 * A variant can be sold now.
 * @param {Pick<VariantRecord, 'active' | 'stock'>} variant
 * @param {boolean} trackStock
 */
export const variantInStock = (variant, trackStock) => variant.active && (!trackStock || variant.stock > 0);

/**
 * What a check needs to know about the website.
 * @typedef {object} CatalogRules
 * @property {boolean} variants the `variants` feature is on
 * @property {boolean} locations `multi_location` is on
 * @property {boolean} grades `grades_serials` is on
 * @property {boolean} digital `digital_goods` is on
 * @property {boolean} bookings `bookings` is on
 * @property {ReadonlySet<string>} gradeKeys keys of the `grades` list
 * @property {ReadonlySet<string>} locationIds
 * @property {ReadonlySet<string>} categoryIds
 * @property {ReadonlySet<string>} brandIds
 * @property {ReadonlyMap<string, AttributeRecord>} attributes
 * @property {(prefix: string) => string} newId
 */

/**
 * The editable fields of a product (everything the adapter writes; `price`, `inStock`, `sold`, `rating`, `publishedAt`
 * and the timestamps are kept by the adapter and the ledger).
 * @typedef {Pick<ProductRecord, 'slug' | 'name' | 'kind' | 'status' | 'summary' | 'description' | 'categoryIds' | 'brandId'
 *   | 'tags' | 'specs' | 'options' | 'variants' | 'trackStock' | 'serialized' | 'digital' | 'booking' | 'seo' | 'returnDays'
 *   | 'warrantyDays'>} ProductFields `slug` '' = make one from the name
 */

/**
 * Check a spec value against its attribute's type.
 * @param {AttributeRecord} attribute
 * @param {unknown} value
 * @returns {string | number | boolean | null} null when invalid
 */
export const specValue = (attribute, value) => {
	if (attribute.type === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : null;
	if (attribute.type === 'boolean') return typeof value === 'boolean' ? value : null;
	const text = cleanText(value, LIMITS.specText);
	if (!text) return null;
	if (attribute.type === 'choice') return attribute.choices.includes(text) ? text : null;
	return text;
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
 * A variant from input, merged over the existing one (whose stock is kept).
 * @param {Record<string, any>} input
 * @param {VariantRecord | null} existing
 * @param {CatalogRules} rules
 * @param {string} path
 * @param {FieldError[]} errors
 * @returns {VariantRecord}
 */
const variantOf = (input, existing, rules, path, errors) => {
	/** @param {string} field @param {string} message */
	const fail = (field, message) => errors.push({ path: `${path}/${field}`, message });
	const sku = input.sku === undefined ? (existing?.sku ?? '') : cleanText(input.sku, LIMITS.sku);
	if (sku === null) fail('sku', `A SKU has at most ${LIMITS.sku} characters.`);
	const price = input.price === undefined ? existing?.price : input.price;
	if (!isPrice(price)) fail('price', 'The price is a whole number of minor units from 0.');
	/** @param {string} field */
	const optionalPrice = (field) => {
		const value = input[field] === undefined ? (existing ? /** @type {any} */ (existing)[field] : null) : input[field];
		if (value !== null && !isPrice(value)) fail(field, 'Give a whole number of minor units from 0, or null.');
		return value === null || isPrice(value) ? value : null;
	};
	const compareAtPrice = optionalPrice('compareAtPrice');
	const cost = optionalPrice('cost');
	let grade = existing?.grade ?? null;
	if (input.grade !== undefined) {
		if (input.grade === null || input.grade === '') grade = null;
		else if (!rules.grades || typeof input.grade !== 'string' || !rules.gradeKeys.has(input.grade))
			fail('grade', 'Pick a grade of your grades list.');
		else grade = input.grade;
	}
	if (input.active !== undefined && typeof input.active !== 'boolean') fail('active', 'Active is true or false.');
	const stock = existing ? { stock: existing.stock, locations: existing.locations } : stockOf(input, rules, path, errors);
	/** @type {Record<string, string>} */
	const options = {};
	if (input.options !== undefined && !isObject(input.options)) fail('options', 'Give the option values.');
	for (const [name, value] of Object.entries(isObject(input.options) ? input.options : (existing?.options ?? {}))) {
		const text = cleanText(value, LIMITS.axisValue);
		if (text) options[name] = text;
	}
	return {
		id: existing?.id ?? rules.newId('var'),
		sku: sku ?? '',
		options,
		price: isPrice(price) ? price : 0,
		compareAtPrice,
		cost,
		stock: stock.stock,
		locations: stock.locations,
		grade,
		active: typeof input.active === 'boolean' ? input.active : (existing?.active ?? true),
	};
};

/** The fields of a single-variant product that may be given at the top level. */
const SHORTCUT = Object.freeze(['sku', 'price', 'compareAtPrice', 'cost', 'stock', 'locations', 'grade']);

/**
 * The variants of the next product.
 * @param {Record<string, any>} input
 * @param {ProductRecord | null} existing
 * @param {Array<{ name: string, values: string[] }>} options the next option axes
 * @param {CatalogRules} rules
 * @param {FieldError[]} errors
 * @returns {VariantRecord[]}
 */
const variantsOf = (input, existing, options, rules, errors) => {
	const shortcut = SHORTCUT.some((field) => input[field] !== undefined);
	/** @type {Record<string, any>} the single variant's fields given at the top level */
	const single = Object.fromEntries(
		SHORTCUT.filter((field) => input[field] !== undefined).map((field) => [field, input[field]]),
	);
	/** @type {VariantRecord[]} */
	let variants;
	if (input.variants !== undefined) {
		if (shortcut) errors.push({ path: '/variants', message: 'Give either variants or the single price and SKU.' });
		if (!Array.isArray(input.variants) || input.variants.length === 0 || input.variants.length > LIMITS.variants) {
			errors.push({ path: '/variants', message: `Give 1 to ${LIMITS.variants} variants.` });
			return existing?.variants ?? [];
		}
		const known = new Map((existing?.variants ?? []).map((variant) => [variant.id, variant]));
		const seen = new Set();
		variants = input.variants.map((entry, index) => {
			const path = `/variants/${index}`;
			if (!isObject(entry)) {
				errors.push({ path, message: 'Each variant is an object.' });
				return variantOf({}, null, rules, path, []);
			}
			let before = null;
			if (entry.id !== undefined) {
				before = known.get(entry.id) ?? null;
				if (!before || seen.has(entry.id))
					errors.push({ path: `${path}/id`, message: 'This variant is not part of the product.' });
				seen.add(entry.id);
			}
			return variantOf(entry, before, rules, path, errors);
		});
	} else if (existing) {
		if (shortcut && existing.variants.length !== 1)
			errors.push({ path: '/variants', message: 'This product has several variants: change them in variants.' });
		variants =
			shortcut && existing.variants.length === 1
				? [variantOf(single, /** @type {VariantRecord} */ (existing.variants[0]), rules, '', errors)]
				: existing.variants;
	} else variants = [variantOf(single, null, rules, '', errors)];

	if (!rules.variants && variants.length !== 1)
		errors.push({ path: '/variants', message: 'Switch on Variants to sell more than one variant.' });
	if (options.length === 0) {
		if (variants.length > 1) errors.push({ path: '/variants', message: 'Several variants need options (such as Size).' });
		return variants.map((variant) => ({ ...variant, options: {} }));
	}
	const combinations = new Set();
	variants.forEach((variant, index) => {
		const names = Object.keys(variant.options);
		const fits =
			names.length === options.length &&
			options.every((axis) => axis.values.includes(/** @type {string} */ (variant.options[axis.name])));
		if (!fits) {
			errors.push({ path: `/variants/${index}/options`, message: 'Give one value of each option.' });
			return;
		}
		const key = JSON.stringify(options.map((axis) => variant.options[axis.name]));
		if (combinations.has(key))
			errors.push({ path: `/variants/${index}/options`, message: 'Two variants have the same options.' });
		combinations.add(key);
	});
	return variants;
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
	 * @param {T} fallback
	 * @param {string} message
	 * @returns {T}
	 */
	const field = (field, read, fallback, message) => {
		if (input[field] === undefined) return existing ? /** @type {any} */ (existing)[field] : fallback;
		const value = read(input[field]);
		if (value === null || value === undefined) {
			fail(`/${field}`, message);
			return existing ? /** @type {any} */ (existing)[field] : fallback;
		}
		return value;
	};

	const name = field('name', (v) => cleanText(v, LIMITS.name) || null, '', `Give a name of 1 to ${LIMITS.name} characters.`);
	if (!existing && input.name === undefined) fail('/name', 'Give the product a name.');
	const slug = field('slug', (v) => (v === '' ? '' : isSlug(v) ? v : null), '', 'Use lowercase letters, digits and dashes.');
	const kind = field(
		'kind',
		(v) => (KINDS.includes(/** @type {any} */ (v)) ? /** @type {any} */ (v) : null),
		'physical',
		'Kind is physical, digital or booking.',
	);
	if (kind === 'digital' && !rules.digital && (!existing || input.kind !== undefined))
		fail('/kind', 'Switch on Digital goods to sell digital products.');
	if (kind === 'booking' && !rules.bookings && (!existing || input.kind !== undefined))
		fail('/kind', 'Switch on Bookings to sell bookings.');
	const status = field(
		'status',
		(v) => (STATUSES.includes(/** @type {any} */ (v)) ? /** @type {any} */ (v) : null),
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

	/** @type {Record<string, string | number | boolean>} */
	let specs = existing?.specs ?? {};
	if (input.specs !== undefined) {
		if (!isObject(input.specs) || Object.keys(input.specs).length > LIMITS.specs)
			fail('/specs', 'Give the specs by attribute.');
		else {
			specs = {};
			for (const [id, value] of Object.entries(input.specs)) {
				if (value === null || value === '') continue;
				const attribute = rules.attributes.get(id);
				const checked = attribute ? specValue(attribute, value) : null;
				if (!attribute) fail(`/specs/${id}`, 'There is no such attribute.');
				else if (checked === null) fail(`/specs/${id}`, `This is not a valid ${attribute.type} for ${attribute.name}.`);
				else specs[id] = checked;
			}
		}
	}

	const options = input.options === undefined ? (existing?.options ?? []) : optionsOf(input.options, errors);
	if (options.length > 0 && !rules.variants) fail('/options', 'Switch on Variants to give options.');
	const variants = variantsOf(input, existing, options, rules, errors);
	const skus = variants.map((variant) => variant.sku).filter(Boolean);
	if (new Set(skus).size !== skus.length) fail('/variants', 'Each variant needs its own SKU.');

	const trackStock = field(
		'trackStock',
		(v) => (typeof v === 'boolean' ? v : null),
		kind === 'physical',
		'Track stock is true or false.',
	);
	const serialized = field('serialized', (v) => (typeof v === 'boolean' ? v : null), false, 'Serialized is true or false.');
	if (!rules.grades && input.serialized === true) fail('/serialized', 'Switch on Grades and serials first.');

	/** @type {ProductRecord['digital']} */
	let digital = null;
	if (kind === 'digital') {
		const before = existing?.digital ?? { files: [], licenceKeys: false, downloadLimit: 0 };
		const given = input.digital === undefined ? {} : input.digital;
		if (!isObject(given)) fail('/digital', 'Give the download settings.');
		const raw = isObject(given) ? given : {};
		if (raw.licenceKeys !== undefined && typeof raw.licenceKeys !== 'boolean')
			fail('/digital/licenceKeys', 'Licence keys is true or false.');
		if (raw.downloadLimit !== undefined && !isCount(raw.downloadLimit, LIMITS.downloadLimit))
			fail('/digital/downloadLimit', `Downloads are a whole number from 0 (no limit) to ${LIMITS.downloadLimit}.`);
		digital = {
			files: before.files,
			licenceKeys: typeof raw.licenceKeys === 'boolean' ? raw.licenceKeys : before.licenceKeys,
			downloadLimit: isCount(raw.downloadLimit, LIMITS.downloadLimit) ? raw.downloadLimit : before.downloadLimit,
		};
	}
	/** @type {ProductRecord['booking']} */
	let booking = null;
	if (kind === 'booking') {
		const minutes = isObject(input.booking) ? input.booking.durationMinutes : existing?.booking?.durationMinutes;
		if (!Number.isSafeInteger(minutes) || Number(minutes) < 5 || Number(minutes) > 1440)
			fail('/booking/durationMinutes', 'A booking lasts 5 to 1440 minutes.');
		else booking = { durationMinutes: Number(minutes) };
	}

	let seo = existing?.seo ?? { title: '', description: '' };
	if (input.seo !== undefined) {
		const title =
			isObject(input.seo) && input.seo.title !== undefined ? cleanText(input.seo.title, LIMITS.seoTitle) : seo.title;
		const text =
			isObject(input.seo) && input.seo.description !== undefined
				? cleanText(input.seo.description, LIMITS.seoDescription)
				: seo.description;
		if (title === null) fail('/seo/title', `An SEO title has at most ${LIMITS.seoTitle} characters.`);
		if (text === null) fail('/seo/description', `An SEO description has at most ${LIMITS.seoDescription} characters.`);
		seo = { title: title ?? seo.title, description: text ?? seo.description };
	}
	/** @param {'returnDays' | 'warrantyDays'} name */
	const daysOf = (name) => {
		const before = existing?.[name] ?? null;
		if (input[name] === undefined) return before;
		if (!isDays(input[name])) {
			fail(`/${name}`, `Give whole days from 0 to ${LIMITS.days}, or null.`);
			return before;
		}
		return input[name];
	};
	const returnDays = daysOf('returnDays');
	const warrantyDays = daysOf('warrantyDays');

	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			slug,
			name,
			kind,
			status,
			summary,
			description,
			categoryIds,
			brandId,
			tags,
			specs,
			options,
			variants,
			trackStock,
			serialized,
			digital,
			booking,
			seo,
			returnDays,
			warrantyDays,
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
 * Check a list of stock changes.
 * @param {unknown} value
 * @param {{ locations: boolean }} rules
 * @returns {{ ok: true, value: Array<{ variantId: string, set?: number, adjust?: number, locationId: string | null }> } | { ok: false, errors: FieldError[] }}
 */
export const checkStockChanges = (value, rules) => {
	const list = isObject(value) && Array.isArray(value.changes) ? value.changes : null;
	if (!list || list.length === 0 || list.length > LIMITS.variants)
		return { ok: false, errors: [{ path: '/changes', message: `Give 1 to ${LIMITS.variants} stock changes.` }] };
	/** @type {FieldError[]} */
	const errors = [];
	/** @type {Array<{ variantId: string, set?: number, adjust?: number, locationId: string | null }>} */
	const out = [];
	list.forEach((entry, index) => {
		const path = `/changes/${index}`;
		if (!isObject(entry) || typeof entry.variantId !== 'string')
			return void errors.push({ path, message: 'Name the variant.' });
		const hasSet = entry.set !== undefined;
		const hasAdjust = entry.adjust !== undefined;
		if (hasSet === hasAdjust) return void errors.push({ path, message: 'Give either set or adjust.' });
		if (hasSet && !isCount(entry.set, LIMITS.stock))
			return void errors.push({ path: `${path}/set`, message: 'Stock is a whole number from 0.' });
		if (hasAdjust && (!Number.isSafeInteger(entry.adjust) || Math.abs(entry.adjust) > LIMITS.stock))
			return void errors.push({ path: `${path}/adjust`, message: 'Adjust by a whole number.' });
		const locationId = typeof entry.locationId === 'string' && entry.locationId ? entry.locationId : null;
		if (rules.locations && !locationId) return void errors.push({ path: `${path}/locationId`, message: 'Name the location.' });
		if (!rules.locations && locationId)
			return void errors.push({ path: `${path}/locationId`, message: 'Switch on Multi-location stock first.' });
		out.push({ variantId: entry.variantId, ...(hasSet ? { set: entry.set } : { adjust: entry.adjust }), locationId });
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
};
