/**
 * Items (pure): validation of item writes, publication (merchant statuses mapped to the standard draft / active /
 * archived, scheduled windows), the denormalised rollups used for indexed listing (price range — ported from the
 * store's price summary — stock, facets) and change detection for `item.updated@1`.
 *
 * Items are generic: a website declares its item types (physical, digital, service, rental, other), its statuses and
 * its custom fields in the settings; nothing about what is sold is assumed.
 * @module
 */
import { facetsOf } from './attributes.js';
import { wordsOf } from './query.js';
import { validateCustom, fieldsForType } from './fields.js';
import { isCurrency, priceRange } from './money.js';
import { availabilityOf } from './variants.js';
import { cleanText, isId, isKey, isObject, isSlug, issue, seoOf, slugify, textList } from './text.js';

/** Fields of an item that `item.updated@1` reports in `changed`. */
export const TRACKED_FIELDS = Object.freeze([
	'title',
	'slug',
	'type',
	'status',
	'summary',
	'description',
	'brandId',
	'collectionIds',
	'attributes',
	'custom',
	'tags',
	'currency',
	'options',
	'optionPool',
	'variants',
	'media',
	'seo',
	'translations',
	'publishAt',
	'unpublishAt',
	'externalId',
]);

const LIMITS = Object.freeze({ title: 300, summary: 1000, tag: 50, seoTitle: 200, seoDescription: 500, previousSlugs: 20 });

/**
 * @typedef {object} ItemSettings
 * @property {Array<{ key: string, label: string, kind: string, requires_shipping?: boolean, custom_fields?: string[] }>} item_types
 * @property {string} default_type
 * @property {Array<{ key: string, label: string, base: 'draft' | 'active' | 'archived', visible: boolean }>} statuses
 * @property {string} default_status
 * @property {import('./fields.js').FieldDefinition[]} custom_fields
 * @property {boolean} item_currency
 * @property {boolean} scheduled_publish
 * @property {string[]} languages
 * @property {number} max_description_length
 * @property {number} max_tags
 */

/**
 * @typedef {object} ItemFields the item-level fields (variants and media are validated by their own modules)
 * @property {string} title
 * @property {string} slug
 * @property {string} type
 * @property {string} status
 * @property {string | null} summary
 * @property {string | null} description
 * @property {string | null} brandId
 * @property {string[]} collectionIds
 * @property {Record<string, unknown>} custom
 * @property {string[]} tags
 * @property {string | null} currency
 * @property {{ title: string | null, description: string | null }} seo
 * @property {Record<string, { title?: string, summary?: string, description?: string, seo?: { title?: string, description?: string } }>} translations
 * @property {string | null} publishAt
 * @property {string | null} unpublishAt
 * @property {string | null} externalId
 */

/**
 * The status definition of a key (falls back to a hidden draft).
 * @param {ItemSettings['statuses']} statuses
 * @param {string} key
 */
export const statusDef = (statuses, key) =>
	statuses.find((s) => s.key === key) ?? { key, label: key, base: /** @type {const} */ ('draft'), visible: false };

/**
 * @param {unknown} value
 * @returns {string | null | undefined} ISO string, null to clear, undefined when invalid
 */
const isoOrNull = (value) => {
	if (value === null) return null;
	if (typeof value !== 'string' || value.length > 40) return undefined;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
};

/**
 * @param {unknown} input
 * @param {string[]} languages
 * @param {number} maxDescription
 * @returns {ItemFields['translations'] | null}
 */
const translationsOf = (input, languages, maxDescription) => {
	if (!isObject(input)) return null;
	/** @type {ItemFields['translations']} */
	const out = {};
	for (const [lang, raw] of Object.entries(/** @type {Record<string, unknown>} */ (input))) {
		if (!languages.includes(lang) || !isObject(raw)) return null;
		const entry = /** @type {Record<string, any>} */ (raw);
		/** @type {ItemFields['translations'][string]} */
		const value = {};
		for (const [key, max, multiline] of /** @type {const} */ ([
			['title', LIMITS.title, false],
			['summary', LIMITS.summary, false],
			['description', maxDescription, true],
		])) {
			if (entry[key] === undefined) continue;
			const text = cleanText(entry[key], max, { multiline });
			if (text === null) return null;
			value[key] = text;
		}
		if (entry.seo !== undefined) {
			if (!isObject(entry.seo)) return null;
			const seoTitle = entry.seo.title === undefined ? undefined : cleanText(entry.seo.title, LIMITS.seoTitle);
			const seoDescription =
				entry.seo.description === undefined ? undefined : cleanText(entry.seo.description, LIMITS.seoDescription);
			if (seoTitle === null || seoDescription === null) return null;
			value.seo = { ...(seoTitle ? { title: seoTitle } : {}), ...(seoDescription ? { description: seoDescription } : {}) };
		}
		out[lang] = value;
	}
	return out;
};

/**
 * Validate the item-level fields of a create (no `current`) or a JSON Merge Patch over `current`.
 * @param {unknown} input
 * @param {{ settings: ItemSettings, current?: ItemFields | null, maxCollections: number }} context
 * @returns {{ problems: Array<{ path: string, code: string }>, value: ItemFields | null }}
 */
export const validateItem = (input, { settings, current = null, maxCollections }) => {
	if (!isObject(input)) return { problems: [issue('', 'object_required')], value: null };
	const body = /** @type {Record<string, any>} */ (input);
	const has = (/** @type {string} */ key) => Object.hasOwn(body, key);
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	const title = has('title') ? cleanText(body.title, LIMITS.title) : (current?.title ?? null);
	if (title === null) problems.push(issue('/title', 'required'));
	const slug = has('slug') ? body.slug : (current?.slug ?? slugify(title ?? ''));
	if (!isSlug(slug)) problems.push(issue('/slug', 'slug_invalid'));
	const type = has('type') ? body.type : (current?.type ?? settings.default_type);
	const typeDef = settings.item_types.find((t) => t.key === type);
	if (!typeDef) problems.push(issue('/type', 'type_unknown'));
	const status = has('status') ? body.status : (current?.status ?? settings.default_status);
	if (!isKey(status) || !settings.statuses.some((s) => s.key === status)) problems.push(issue('/status', 'status_unknown'));
	/** @param {string} key @param {number} max @param {boolean} [multiline] */
	const optionalText = (key, max, multiline = false) => {
		if (!has(key)) return /** @type {any} */ (current)?.[key] ?? null;
		if (body[key] === null || body[key] === '') return null;
		const text = cleanText(body[key], max, { multiline });
		if (text === null)
			problems.push(issue(`/${key}`, typeof body[key] === 'string' && body[key].length > max ? 'too_long' : 'text_invalid'));
		return text;
	};
	const summary = optionalText('summary', LIMITS.summary);
	const description = optionalText('description', settings.max_description_length, true);
	const brandId = has('brandId') ? body.brandId : (current?.brandId ?? null);
	if (brandId !== null && !isId(brandId)) problems.push(issue('/brandId', 'id_invalid'));
	const collectionIds = has('collectionIds') ? body.collectionIds : (current?.collectionIds ?? []);
	if (!Array.isArray(collectionIds) || collectionIds.length > maxCollections || !collectionIds.every(isId))
		problems.push(issue('/collectionIds', 'ids_invalid'));
	const tags = has('tags') ? textList(body.tags, { max: settings.max_tags, itemMax: LIMITS.tag }) : (current?.tags ?? []);
	if (tags === null) problems.push(issue('/tags', 'tags_invalid'));
	let currency = current?.currency ?? null;
	if (has('currency')) {
		if (!settings.item_currency && body.currency !== null) problems.push(issue('/currency', 'item_currency_disabled'));
		else if (body.currency !== null && !isCurrency(body.currency)) problems.push(issue('/currency', 'currency_invalid'));
		else currency = body.currency;
	}
	let seo = current?.seo ?? { title: null, description: null };
	if (has('seo')) {
		if (!isObject(body.seo)) problems.push(issue('/seo', 'object_required'));
		else {
			const parsed = seoOf(body.seo);
			problems.push(...parsed.problems);
			seo = parsed.value;
		}
	}
	let translations = current?.translations ?? {};
	if (has('translations')) {
		const parsed =
			body.translations === null ? {} : translationsOf(body.translations, settings.languages, settings.max_description_length);
		if (parsed === null) problems.push(issue('/translations', 'translations_invalid'));
		else translations = parsed;
	}
	/** @param {string} key */
	const time = (key) => {
		if (!has(key)) return /** @type {any} */ (current)?.[key] ?? null;
		if (!settings.scheduled_publish && body[key] !== null) {
			problems.push(issue(`/${key}`, 'scheduling_disabled'));
			return null;
		}
		const value = isoOrNull(body[key]);
		if (value === undefined) problems.push(issue(`/${key}`, 'time_invalid'));
		return value ?? null;
	};
	const publishAt = time('publishAt');
	const unpublishAt = time('unpublishAt');
	if (publishAt && unpublishAt && Date.parse(unpublishAt) <= Date.parse(publishAt))
		problems.push(issue('/unpublishAt', 'before_publish'));
	const externalId = has('externalId') ? body.externalId : (current?.externalId ?? null);
	if (externalId !== null && !isId(externalId)) problems.push(issue('/externalId', 'id_invalid'));
	const fields = fieldsForType(settings.custom_fields, typeDef);
	const custom = validateCustom(fields, has('custom') ? body.custom : undefined, {
		current: current?.custom ?? {},
		partial: current !== null,
	});
	problems.push(...custom.problems);
	if (problems.length > 0) return { problems, value: null };
	return {
		problems,
		value: {
			title: /** @type {string} */ (title),
			slug,
			type,
			status,
			summary,
			description,
			brandId,
			collectionIds: [...new Set(/** @type {string[]} */ (collectionIds))],
			custom: custom.value,
			tags: /** @type {string[]} */ (tags),
			currency,
			seo,
			translations,
			publishAt,
			unpublishAt,
			externalId,
		},
	};
};

/**
 * The fields shorthand of a single-variant item (`price`, `sku`, … at item level) as a variant input.
 * @param {Record<string, unknown>} body
 * @returns {Record<string, unknown> | null}
 */
export const defaultVariantInput = (body) => {
	const keys = ['price', 'compareAtPrice', 'cost', 'sku', 'barcode', 'quantity', 'trackInventory', 'backorder'];
	if (!keys.some((key) => Object.hasOwn(body, key))) return null;
	return Object.fromEntries(keys.filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]]));
};

/**
 * Whether shoppers may see an item now: not deleted, a visible status, inside its publication window.
 * @param {{ status: string, deletedAt?: unknown, publishAt?: string | null, unpublishAt?: string | null }} item
 * @param {{ statuses: ItemSettings['statuses'], now: number, scheduled: boolean }} context
 */
export const isPublic = (item, { statuses, now, scheduled }) => {
	if (item.deletedAt) return false;
	if (!statusDef(statuses, item.status).visible) return false;
	if (!scheduled) return true;
	if (item.publishAt && Date.parse(item.publishAt) > now) return false;
	return !(item.unpublishAt && Date.parse(item.unpublishAt) <= now);
};

/**
 * The next instant the item's public visibility changes (scheduled publish / unpublish), or null.
 * @param {{ publishAt?: string | null, unpublishAt?: string | null }} item
 * @param {number} now
 * @returns {Date | null}
 */
export const nextTransition = (item, now) => {
	const times = [item.publishAt, item.unpublishAt].filter(Boolean).map((t) => Date.parse(/** @type {string} */ (t)));
	const next = times.filter((t) => t > now).sort((a, b) => a - b)[0];
	return next === undefined ? null : new Date(next);
};

/**
 * Denormalised rollups stored on the item for indexed listing and filtering.
 * @param {{ title: string, variants: ReadonlyArray<import('./variants.js').Variant>, attributes?: Record<string, unknown>, tags?: string[] }} item
 * @param {{ attributes: readonly import('./attributes.js').Attribute[], stock: { trackInventory: boolean, backorders: 'deny' | 'allow', lowStock: number } }} context
 * @returns {{ priceMin: number | null, priceMax: number | null, available: number, inStock: boolean, facets: string[], titleSort: string, searchTokens: string[] }}
 */
export const rollupOf = (item, { attributes, stock }) => {
	const active = item.variants.filter((v) => v.status !== 'inactive');
	const states = active.map((variant) => ({ variant, ...availabilityOf(variant, stock) }));
	return {
		...priceRange(active),
		available: states
			.filter((s) => s.tracked && !s.variant.forceOutOfStock)
			.reduce((sum, s) => sum + Math.max(0, s.variant.quantity), 0),
		inStock: states.some((s) => s.purchasable),
		facets: facetsOf(attributes, item),
		titleSort: item.title.toLocaleLowerCase('und').slice(0, 200),
		searchTokens: [
			...new Set(
				wordsOf([item.title, ...(item.tags ?? []), ...item.variants.map((v) => v.sku ?? '')].join(' ')).filter(
					(w) => w.length <= 40,
				),
			),
		].slice(0, 200),
	};
};

/**
 * Names of the tracked fields that differ (for `item.updated@1` `changed`).
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} after
 * @returns {string[]}
 */
export const changedFields = (before, after) =>
	TRACKED_FIELDS.filter((key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null));
