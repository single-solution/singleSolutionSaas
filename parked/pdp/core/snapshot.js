/**
 * Raw item data from a page snapshot — the plain strings a renderer collected from the page (`<meta>` tags, the item
 * root's `data-ss-item-*` attributes, its `[data-ss-item-image]` media and the inline `data-ss-item` JSON). Pure, so
 * the page contract is tested without a DOM. Precedence, lowest first: meta → attributes → inline JSON.
 * @module
 */
import { isObject } from './util.js';

/**
 * @typedef {object} PageSnapshot
 * @property {ReadonlyArray<readonly [string, string]>} [meta] `[name or property, content]` of every `<meta>`
 * @property {Readonly<Record<string, string>>} [attributes] `data-ss-item-*` attributes of the item root
 * @property {ReadonlyArray<Readonly<Record<string, string | null>>>} [media] attributes of each `[data-ss-item-image]`
 *   (plus `tag`)
 * @property {string} [json] text of `<script type="application/json" data-ss-item>`
 */

/** Open Graph / product meta → item field. */
const META = Object.freeze(
	/** @type {Record<string, string>} */ ({
		'og:title': 'title',
		'og:description': 'description',
		'og:url': 'url',
		'product:price:amount': 'price',
		'product:price:currency': 'currency',
		'product:availability': 'availability',
		'product:condition': 'condition',
		'product:brand': 'brand',
		'product:category': 'category',
		'product:retailer_item_id': 'sku',
	}),
);

/** `data-ss-item-<name>` names that differ from the field name. */
const RENAMED = Object.freeze(/** @type {Record<string, string>} */ ({ rating: 'ratingValue' }));

export const MAX_JSON = 256 * 1024;

/** @param {string} name kebab-case → camelCase */
const camel = (name) => name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());

/**
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} over
 */
const overlay = (base, over) => {
	const out = { ...base };
	for (const [key, value] of Object.entries(over))
		if (value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0))
			out[key] = value;
	return out;
};

/**
 * @param {PageSnapshot} snapshot
 * @returns {Record<string, unknown>}
 */
export const itemFromSnapshot = (snapshot) => {
	/** @type {Record<string, unknown>} */
	const meta = {};
	/** @type {string[]} */
	const images = [];
	for (const [name, content] of snapshot.meta ?? []) {
		if (typeof content !== 'string' || content === '') continue;
		if (name === 'og:image') images.push(content);
		else if (name === 'ss:item-id') meta.id = content;
		else if (name.startsWith('ss:item:')) meta[camel(name.slice(8))] = content;
		else if (Object.hasOwn(META, name) && meta[/** @type {string} */ (META[name])] === undefined)
			meta[/** @type {string} */ (META[name])] = content;
	}
	if (images.length > 0 && meta.images === undefined) meta.images = images;

	/** @type {Record<string, unknown>} */
	const attributes = {};
	for (const [name, value] of Object.entries(snapshot.attributes ?? {})) {
		if (!name.startsWith('data-ss-item-') || name === 'data-ss-item-image') continue;
		const field = camel(name.slice('data-ss-item-'.length));
		attributes[RENAMED[field] ?? field] = value;
	}
	const media = (snapshot.media ?? []).map((node) => ({
		type: node.tag === 'video' ? 'video' : 'image',
		src: node['data-ss-item-image'] || node.src,
		alt: node.alt,
		width: node.width,
		height: node.height,
		srcset: node.srcset,
		zoom: node['data-ss-zoom'],
		poster: node.poster,
	}));
	if (media.length > 0) attributes.images = media;

	/** @type {Record<string, unknown>} */
	let inline = {};
	const json = snapshot.json ?? '';
	if (json !== '' && json.length <= MAX_JSON) {
		try {
			const parsed = JSON.parse(json);
			if (isObject(parsed)) inline = parsed;
		} catch {
			/* a broken blob counts as none */
		}
	}
	return overlay(overlay(meta, attributes), inline);
};
