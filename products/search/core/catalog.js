/**
 * Catalog items as search documents (pure): the standard `item.created@1` / `item.updated@1` snapshot (title, status,
 * brand, collections, attributes, variants with SKUs and prices in minor units) becomes a document of the configured
 * type; only `active` items are searchable. A variant's private cost is never read. The item page URL comes from the
 * configured template (`/items/{itemId}`), so no URL scheme is assumed.
 * @module
 */
import { ID, isObject, linkOf } from './schema.js';

/**
 * Item page URL from a template.
 * @param {string} template
 * @param {string} itemId
 * @returns {string | null}
 */
export const itemUrl = (template, itemId) => {
	if (typeof template !== 'string' || template.trim() === '' || !template.includes('{itemId}')) return null;
	return linkOf(template.trim().replaceAll('{itemId}', encodeURIComponent(itemId))) ?? null;
};

/**
 * Attribute map as text pairs.
 * @param {unknown} attributes
 * @returns {string[]}
 */
const attributeText = (attributes) =>
	isObject(attributes)
		? Object.entries(attributes)
				.slice(0, 50)
				.flatMap(([key, value]) =>
					(Array.isArray(value) ? value : [value])
						.filter((v) => ['string', 'number', 'boolean'].includes(typeof v))
						.map((v) => `${key} ${String(v)}`),
				)
		: [];

/**
 * The document of a catalog item, or the instruction to remove it.
 * @param {unknown} data event data (item snapshot)
 * @param {{ type: string, urlTemplate: string }} options
 * @returns {{ action: 'upsert', document: Record<string, unknown> } | { action: 'remove', id: string } | null}
 */
export const documentFromItem = (data, { type, urlTemplate }) => {
	if (!isObject(data) || typeof data.itemId !== 'string' || !ID.test(data.itemId)) return null;
	const id = data.itemId;
	if (data.status !== undefined && data.status !== 'active') return { action: 'remove', id };
	if (typeof data.title !== 'string' || data.title.trim() === '') return null;
	const variants = (Array.isArray(data.variants) ? data.variants : []).filter(isObject).slice(0, 250);
	const prices = variants.map((v) => v.price).filter((p) => Number.isSafeInteger(p) && p >= 0);
	const skus = variants.map((v) => v.sku).filter((s) => typeof s === 'string' && s !== '');
	const variantAttributes = variants.flatMap((v) => attributeText(v.attributes));
	return {
		action: 'upsert',
		document: {
			id,
			type,
			url: itemUrl(urlTemplate, id),
			image: null,
			price: prices.length > 0 ? Math.min(...prices) : null,
			currency: prices.length > 0 && typeof data.currency === 'string' ? data.currency : null,
			boost: 0,
			fields: {
				title: data.title,
				...(typeof data.brand === 'string' ? { brand: data.brand } : {}),
				...(skus.length > 0 ? { skus: [...new Set(skus)].slice(0, 100) } : {}),
				attributes: [...new Set([...attributeText(data.attributes), ...variantAttributes])].slice(0, 100),
				...(Array.isArray(data.collections) ? { collections: data.collections.slice(0, 100) } : {}),
			},
		},
	};
};
