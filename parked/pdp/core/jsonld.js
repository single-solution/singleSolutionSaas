/**
 * schema.org structured data (JSON-LD) for an item: `Product` with an `Offer`, and `FAQPage` for visible questions.
 * Only values the page really has are emitted — never an invented rating, price or condition. The condition comes
 * from the merchant's mapping (their own values → schema.org conditions), then from schema.org tokens in the data.
 * @module
 */
import { CONDITIONS, vocabulary } from './item.js';
import { isObject, text } from './util.js';

const SCHEMA = 'https://schema.org/';

/** Item availability → schema.org `ItemAvailability`. */
export const AVAILABILITY_URL = Object.freeze({
	in_stock: `${SCHEMA}InStock`,
	out_of_stock: `${SCHEMA}OutOfStock`,
	preorder: `${SCHEMA}PreOrder`,
	backorder: `${SCHEMA}BackOrder`,
	limited: `${SCHEMA}LimitedAvailability`,
	discontinued: `${SCHEMA}Discontinued`,
});

/** Item condition → schema.org `OfferItemCondition`. */
export const CONDITION_URL = Object.freeze({
	new: `${SCHEMA}NewCondition`,
	used: `${SCHEMA}UsedCondition`,
	refurbished: `${SCHEMA}RefurbishedCondition`,
	damaged: `${SCHEMA}DamagedCondition`,
});

/** @typedef {(typeof CONDITIONS)[number]} Condition */
/** @typedef {Partial<Record<Condition, readonly string[]>>} ConditionMap */

/**
 * The schema.org condition of an item: the merchant mapping first (case-insensitive exact match), then schema.org
 * tokens (`NewCondition`, `new`, `https://schema.org/UsedCondition`), else the fallback ('' = omit).
 * @param {string} raw
 * @param {ConditionMap} map
 * @param {Condition | ''} fallback
 * @returns {Condition | ''}
 */
export const resolveCondition = (raw, map, fallback) => {
	const value = text(raw, 100).toLowerCase();
	if (value !== '') {
		for (const condition of CONDITIONS) {
			if ((map[condition] ?? []).some((entry) => text(entry, 100).toLowerCase() === value)) return condition;
		}
		const token = vocabulary(raw).replace(/condition$/, '');
		const known = CONDITIONS.find((condition) => condition === token);
		if (known) return known;
	}
	return fallback;
};

/**
 * Drop empty members (undefined, '', empty arrays and objects) recursively.
 * @param {Record<string, unknown>} node
 * @returns {Record<string, unknown>}
 */
export const compact = (node) => {
	/** @type {Record<string, unknown>} */
	const out = {};
	for (const [key, value] of Object.entries(node)) {
		const kept = isObject(value) ? compact(value) : value;
		if (kept === undefined || kept === '' || (Array.isArray(kept) && kept.length === 0)) continue;
		if (isObject(kept) && Object.keys(kept).every((name) => name.startsWith('@'))) continue;
		out[key] = kept;
	}
	return out;
};

/**
 * Absolute URL of a (possibly relative) reference against the page URL, or '' when that is impossible.
 * @param {string} ref
 * @param {string} base
 * @returns {string}
 */
export const absolute = (ref, base) => {
	if (ref === '') return '';
	try {
		const url = new URL(ref, base || undefined);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
	} catch {
		return '';
	}
};

/**
 * ISO date `days` after `nowMs` (Offer `priceValidUntil`), or '' for 0 days.
 * @param {number} nowMs
 * @param {number} days
 * @returns {string}
 */
export const priceValidUntil = (nowMs, days) => (days > 0 ? new Date(nowMs + days * 86_400_000).toISOString().slice(0, 10) : '');

/**
 * @typedef {object} ProductOptions
 * @property {string} pageUrl canonical page URL (absolute)
 * @property {Condition | ''} condition
 * @property {string} validUntil ISO date or ''
 * @property {string} seller seller organisation name or ''
 * @property {boolean} offer include the Offer
 * @property {boolean} rating include the aggregate rating the page shows
 */

/**
 * `Product` JSON-LD node of an item, or null without a name.
 * @param {import('./item.js').Item} item
 * @param {ProductOptions} options
 * @returns {Record<string, unknown> | null}
 */
export const productJsonLd = (item, { pageUrl, condition, validUntil, seller, offer, rating }) => {
	if (item.title === '') return null;
	const url = absolute(item.url, pageUrl) || absolute(pageUrl, '');
	const itemCondition = condition ? CONDITION_URL[condition] : undefined;
	const images = item.images.filter((image) => image.type === 'image').map((image) => absolute(image.src, pageUrl));
	return compact({
		'@context': 'https://schema.org',
		'@type': 'Product',
		...(url ? { '@id': `${url.split('#')[0]}#product` } : {}),
		name: item.title,
		description: item.description,
		url,
		image: images.filter(Boolean),
		sku: item.sku,
		gtin: item.gtin,
		mpn: item.mpn,
		category: item.category,
		brand: item.brand ? { '@type': 'Brand', name: item.brand } : undefined,
		itemCondition,
		aggregateRating:
			rating && item.ratingCount > 0 && item.ratingValue >= 1
				? {
						'@type': 'AggregateRating',
						ratingValue: item.ratingValue,
						reviewCount: item.ratingCount,
						bestRating: 5,
						worstRating: 1,
					}
				: undefined,
		offers:
			offer && item.price !== '' && item.currency !== ''
				? {
						'@type': 'Offer',
						url,
						price: item.price,
						priceCurrency: item.currency,
						priceValidUntil: validUntil,
						availability: item.availability ? AVAILABILITY_URL[item.availability] : undefined,
						itemCondition,
						seller: seller ? { '@type': 'Organization', name: seller } : undefined,
					}
				: undefined,
	});
};

/**
 * `FAQPage` JSON-LD node of the visible questions, or null when there are none.
 * @param {readonly import('./item.js').FaqEntry[]} entries
 * @param {string} pageUrl
 * @returns {Record<string, unknown> | null}
 */
export const faqJsonLd = (entries, pageUrl) =>
	entries.length === 0
		? null
		: compact({
				'@context': 'https://schema.org',
				'@type': 'FAQPage',
				url: absolute(pageUrl, ''),
				mainEntity: entries.map((entry) => ({
					'@type': 'Question',
					name: entry.question,
					acceptedAnswer: { '@type': 'Answer', text: entry.answer },
				})),
			});

/**
 * JSON for a `<script type="application/ld+json">`: `<`, U+2028 and U+2029 escaped so the text can never close the
 * script element or break a parser.
 * @param {unknown} node
 * @returns {string}
 */
export const scriptJson = (node) =>
	JSON.stringify(node)
		.replace(/</g, '\\u003c')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
