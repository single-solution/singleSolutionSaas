/**
 * Addresses of the shop's files in the merchant's own storage (PLAN 0.8.8: media in the merchant's own storage) and of
 * product pages on the merchant's website. Images are shown from the `catalog` setting `mediaBaseUrl` (the bucket's or
 * CDN's public address) when it is set, else through a signed link that lasts an hour. Used by every part that shows
 * a product (catalog, checkout, the Chat lookups, feeds, alerts). Links follow the URL templates (PLAN 0.8.10 E13).
 * @module
 */

import { categoryLink, productLink, variantQueryOf, withQuery } from '../core/links.js';
import { COLLECTIONS } from '../core/model.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/links.js').LinkContext} LinkContext */

/** At most this many categories and brands are read for links. */
const MAX_RECORDS = 5000;

/** A signed image link lasts this long. */
const SIGNED_MEDIA_SECONDS = 3600;

/**
 * @param {Product} product
 */
export const createMedia = (product) => {
	/**
	 * The address of a stored file, or null without storage.
	 * @param {Site} s
	 * @param {string | null | undefined} key
	 * @returns {Promise<string | null>}
	 */
	const mediaUrl = async (s, key) => {
		if (!key) return null;
		const { mediaBaseUrl } = await s.values('catalog');
		if (typeof mediaBaseUrl === 'string' && /^https:\/\//.test(mediaBaseUrl))
			return `${mediaBaseUrl.replace(/\/+$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
		const storage = await product.connections.storage(s.websiteId);
		if (!storage) return null;
		return storage.presignGet({ key, expiresIn: SIGNED_MEDIA_SECONDS }).url;
	};

	/**
	 * An order's dispatch video as shoppers get it (E28): an upload's address, or the YouTube or https address kept;
	 * null when the order has none.
	 * @param {Site} s
	 * @param {{ media?: Array<{ kind: string, key?: string | null, url?: string | null }> }} order
	 * @returns {Promise<{ kind: 'file' | 'youtube' | 'url', url: string } | null>}
	 */
	const dispatchVideo = async (s, order) => {
		const entry = (order.media ?? []).findLast((item) => item.kind === 'dispatch_video');
		if (!entry) return null;
		if (entry.key) {
			const url = await mediaUrl(s, entry.key);
			return url ? { kind: 'file', url } : null;
		}
		const url = typeof entry.url === 'string' && /^https:\/\//.test(entry.url) ? entry.url : '';
		if (!url) return null;
		return { kind: /^https:\/\/www\.youtube-nocookie\.com\/embed\//.test(url) ? 'youtube' : 'url', url };
	};

	/** The categories and brands links are made of, read once per request. @type {WeakMap<Site, Promise<LinkContext>>} */
	const contexts = new WeakMap();

	/**
	 * What links of a website are made of (E13).
	 * @param {Site} s
	 * @returns {Promise<LinkContext>}
	 */
	const linkContext = (s) => {
		let found = contexts.get(s);
		if (!found) {
			found = (async () => {
				const data = await s.data();
				const [categories, brands] = await Promise.all([
					data
						.collection(COLLECTIONS.categories)
						.find({ websiteId: data.websiteId }, { projection: { _id: 0, id: 1, slug: 1, path: 1 } })
						.limit(MAX_RECORDS)
						.toArray(),
					data
						.collection(COLLECTIONS.brands)
						.find({ websiteId: data.websiteId }, { projection: { _id: 0, id: 1, slug: 1 } })
						.limit(MAX_RECORDS)
						.toArray(),
				]);
				return {
					domain: s.domain,
					categories: new Map(categories.map((c) => [String(c.id), { slug: String(c.slug), path: c.path ?? [] }])),
					brands: new Map(brands.map((b) => [String(b.id), { slug: String(b.slug) }])),
				};
			})();
			contexts.set(s, found);
		}
		return found;
	};

	/**
	 * The product page on the merchant's website (the `catalog` setting `productUrl`, made absolute; E13).
	 * @param {Site} s
	 * @param {{ id: string, slug: string, categoryIds?: string[], brandId?: string | null }} item
	 */
	const productUrl = async (s, item) => {
		const { productUrl: template } = await s.values('catalog');
		return productLink(String(template), item, await linkContext(s));
	};

	/**
	 * A variant's page: the product page with the `variantQuery` (E13).
	 * @param {Site} s
	 * @param {{ id: string, slug: string, categoryIds?: string[], brandId?: string | null }} item
	 * @param {{ grade?: string | null, attributes?: Record<string, unknown> }} variant
	 * @param {ReadonlyMap<string, { slug?: string }>} attributes by id
	 */
	const variantUrl = async (s, item, variant, attributes) => {
		const { variantQuery } = await s.values('catalog');
		return withQuery(await productUrl(s, item), variantQueryOf(String(variantQuery ?? ''), variant, attributes));
	};

	/**
	 * A category page on the merchant's website (`categoryUrl`; E13).
	 * @param {Site} s
	 * @param {{ id?: string, slug: string }} category
	 */
	const categoryUrl = async (s, category) => {
		const { categoryUrl: template } = await s.values('catalog');
		return categoryLink(String(template), category, await linkContext(s));
	};

	return Object.freeze({ mediaUrl, dispatchVideo, productUrl, variantUrl, categoryUrl, linkContext });
};

/** @typedef {ReturnType<typeof createMedia>} Media */
