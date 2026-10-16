/**
 * Helpers of the Sisters Boutique mapping (PLAN 0.8.10 Migration, "Per store", SB): the store's values (its calling
 * code, its order number form), its shapes (Mongoose documents with ObjectIds, rupees, `StoredImage` photos with
 * full https addresses, SEO blocks) and the rules that turn them into the products' shapes (paisa, storage keys, the
 * products' SEO fields, E.164 phones through `@ss/contracts/phone`). Store names and shapes appear only here and in the
 * other files of this folder (PLAN 0.10, 0.13).
 * @module
 */
import { createHash } from 'node:crypto';
import { normalizePhone } from '@ss/contracts/phone';
import { hexOf, legacyId } from '../../mapping.js';

/** @typedef {import('../../mapping.js').MapContext} MapContext */

/**
 * SB's phone format: Pakistan numbers, `+92` and the trunk `0` (`packages/shared/src/phone.ts`:21, :56); written into
 * the products' phone settings too, so the products read national numbers the same way (K12).
 */
export const PHONE_FORMAT = Object.freeze({ defaultCallingCode: '+92', trunkPrefix: '0' });

/** SB's order numbers: `IM-<year>-<4 digits>`, a counter per year (`packages/db/src/orderNumber.ts`:22, :27; kept, E30). */
export const ORDER_PATTERN = '{prefix}{year}-{number}';
export const ORDER_PREFIX = 'IM-';
export const ORDER_DIGITS = 4;

/** SB's currency (rupees; the products keep paisa, rupees × 100). */
export const CURRENCY = 'PKR';

/** @param {unknown} value @returns {value is Record<string, any>} */
export const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Trimmed text ('' for anything else). @param {unknown} value */
export const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** A time as ISO-8601 (a Date or a date text), or null. @param {unknown} value */
export const iso = (value) => {
	const at =
		value instanceof Date ? value.getTime() : typeof value === 'string' && value !== '' ? Date.parse(value) : Number.NaN;
	return Number.isFinite(at) ? new Date(at).toISOString() : null;
};

/** The earlier of two ISO times (either may be null). @param {unknown} a @param {unknown} b */
export const earliest = (a, b) => {
	const [x, y] = [iso(a), iso(b)];
	return x === null ? y : y === null || x <= y ? x : y;
};

/** Rupees to paisa (whole). @param {unknown} rupees */
export const paisa = (rupees) => Math.round((Number(rupees) || 0) * 100);

/** The 24 hex digits of a source id, or '' when it is none. @param {unknown} id */
export const hexKey = (id) => {
	try {
		return hexOf(id);
	} catch {
		return '';
	}
};

/** An id of a source id, or null when the source id is none. @param {string} prefix @param {unknown} id */
export const idOrNull = (prefix, id) => (hexKey(id) === '' ? null : legacyId(prefix, id));

/** A phone as E.164 with SB's format, or null. @param {unknown} raw */
export const phoneOf = (raw) => normalizePhone(text(raw), PHONE_FORMAT);

/** A phone as the products keep it: E.164 when it reads as one, else as typed (the product's check names it). @param {unknown} raw */
export const phoneText = (raw) => phoneOf(raw) ?? text(raw);

/** `{ createdAt }` when the time is known (the products take no null creation time). @param {unknown} value */
export const created = (value) => {
	const at = iso(value);
	return at === null ? {} : { createdAt: at };
};

/**
 * A deterministic id of a record that has no source document of its own (SB's built-in size chart, the user of an
 * invited membership request): `<prefix>_<24 hex digits of a SHA-256>` of a name that never holds personal data in
 * clear.
 * @param {string} prefix @param {string} name
 */
export const derivedId = (prefix, name) =>
	legacyId(prefix, createHash('sha256').update(`sisters-boutique:${name}`).digest('hex').slice(0, 24));

/**
 * A website address as SB renders it (IMP-39, `packages/shared/src/seo/composeSeoMeta.ts`:74-77): https kept, http and
 * protocol-relative addresses made https, a bare path made a path of the site; '' when empty.
 * @param {unknown} value
 */
export const siteAddress = (value) => {
	const raw = text(value);
	if (raw === '' || /^https:\/\//i.test(raw)) return raw;
	if (/^http:\/\//i.test(raw)) return `https://${raw.slice(7)}`;
	if (raw.startsWith('//')) return `https:${raw}`;
	return raw.startsWith('/') ? raw : `/${raw}`;
};

/** @param {string} segment */
const decoded = (segment) => {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
};

/**
 * The storage key of a file SB keeps as a full https address: its path, each part decoded (Ecommerce builds the address
 * again from `catalog.mediaBaseUrl` and the key, so it stays the same; Migration "image URLs do not change").
 * @param {unknown} value
 */
export const mediaKey = (value) => {
	const raw = text(value);
	if (raw === '') return '';
	try {
		return new URL(raw).pathname.split('/').filter(Boolean).map(decoded).join('/');
	} catch {
		return raw.replace(/^\/+/, '');
	}
};

/** Media types by file extension. */
const TYPES = Object.freeze({
	webp: 'image/webp',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	avif: 'image/avif',
	gif: 'image/gif',
	mp4: 'video/mp4',
	webm: 'video/webm',
});

/** The media type of a key by its extension ('' when unknown). @param {string} key */
export const typeOfKey = (key) => /** @type {Record<string, string>} */ (TYPES)[key.split('.').pop()?.toLowerCase() ?? ''] ?? '';

/** A blur placeholder Ecommerce keeps (a small base64 data URI image). */
const BLUR = /^data:image\/(png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/;

/**
 * A photo as SB keeps it (`StoredImage`: `variants.thumb|card|detail|full` addresses, `blurDataURL`, source size, alt)
 * as Ecommerce's file: the `full` copy is the file, the smaller copies its `sizes` (E6), the blur kept when Ecommerce
 * can show it.
 * @param {unknown} image
 * @returns {Record<string, unknown> | null}
 */
export const photoOf = (image) => {
	if (!isObject(image) || !isObject(image.variants)) return null;
	const { variants } = image;
	const key = mediaKey(variants.full || variants.detail || variants.card || variants.thumb);
	if (key === '') return null;
	/** @type {Record<string, string>} */
	const sizes = {};
	for (const name of ['thumb', 'card', 'detail']) {
		const size = mediaKey(variants[name]);
		if (size !== '' && size !== key) sizes[name] = size;
	}
	const blur = text(image.blurDataURL);
	return {
		key,
		type: typeOfKey(key),
		size: 0,
		alt: text(image.alt),
		...(Object.keys(sizes).length > 0 ? { sizes } : {}),
		...(Number.isSafeInteger(Number(image.width)) && Number(image.width) > 0 ? { width: Number(image.width) } : {}),
		...(Number.isSafeInteger(Number(image.height)) && Number(image.height) > 0 ? { height: Number(image.height) } : {}),
		...(blur.length <= 2048 && BLUR.test(blur) ? { blur } : {}),
	};
};

/**
 * SB's SEO block (`SeoMeta`) as Ecommerce's SEO fields (E16): title, description, canonical and social image
 * addresses (made addresses Ecommerce takes, IMP-39), noindex, nofollow and the focus keyword; SB's stored score and
 * AI stamps are not kept (E42 works the score out on read). Only the fields SB holds are given.
 * @param {unknown} seo
 * @returns {Record<string, unknown>}
 */
export const seoOf = (seo) => {
	if (!isObject(seo)) return {};
	/** @type {Record<string, unknown>} */
	const out = {};
	for (const [from, to] of /** @type {const} */ ([
		['title', 'title'],
		['description', 'description'],
		['focusKeyword', 'focusKeyword'],
	]))
		if (text(seo[from]) !== '') out[to] = text(seo[from]);
	for (const [from, to] of /** @type {const} */ ([
		['canonicalUrl', 'canonicalUrl'],
		['ogImageUrl', 'ogImage'],
	]))
		if (text(seo[from]) !== '') out[to] = siteAddress(seo[from]);
	for (const name of ['noindex', 'nofollow']) if (typeof seo[name] === 'boolean') out[name] = seo[name];
	return out;
};

/**
 * The questions of an SB SEO block: entries with a question and an answer (an entry with neither holds nothing; one
 * with only one of them is kept, so the product's check names it).
 * @param {unknown} seo
 * @returns {Array<{ question: string, answer: string }>}
 */
export const faqsOf = (seo) =>
	(isObject(seo) && Array.isArray(seo.faqs) ? seo.faqs : [])
		.map((/** @type {unknown} */ faq) => ({
			question: isObject(faq) ? text(faq.question) : '',
			answer: isObject(faq) ? text(faq.answer) : '',
		}))
		.filter((faq) => faq.question !== '' || faq.answer !== '');

/**
 * A lookup table whose records are numbered as they come (`<name>#0`, `<name>#1` …), so a later step can list every
 * record noted under one name (the brands with one slug in several categories, every category). The number is found
 * while mapping (the next free one under the name) and handed to `lookups` through the record itself, so the mapping
 * keeps no state between runs.
 * @param {string} table
 */
export const numberedTable = (table) => {
	/** @type {WeakMap<object, string[]>} */
	const claimed = new WeakMap();
	return Object.freeze({
		table,
		/**
		 * Number a record under each name.
		 * @template {object} T
		 * @param {T} record @param {ReadonlyArray<string>} names @param {MapContext} ctx
		 * @returns {T}
		 */
		claim: (record, names, ctx) => {
			claimed.set(
				record,
				names.map((name) => {
					let n = 0;
					while (ctx.lookup(table, `${name}#${n}`) !== null) n += 1;
					return `${name}#${n}`;
				}),
			);
			return record;
		},
		/** The keys a step's `lookups` notes for a record. @param {object} record */
		keysOf: (record) => claimed.get(record) ?? null,
		/**
		 * Every record noted under a name.
		 * @param {string} name @param {MapContext} ctx
		 * @returns {string[]}
		 */
		all: (name, ctx) => {
			/** @type {string[]} */
			const out = [];
			for (let n = 0; ; n += 1) {
				const key = ctx.lookup(table, `${name}#${n}`);
				if (key === null) return out;
				out.push(key);
			}
		},
	});
};
