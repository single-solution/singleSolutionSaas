/**
 * Addresses of the shop's files in the merchant's own storage (PLAN 0.8.8: media in the merchant's own storage) and of
 * product pages on the merchant's website. Images are shown from the `catalog` setting `mediaBaseUrl` (the bucket's or
 * CDN's public address) when it is set, else through a signed link that lasts an hour. Used by every part that shows
 * a product (catalog, checkout, the Chat lookups, feeds, alerts).
 * @module
 */

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Site} Site */

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
	 * The product page on the merchant's website (the `catalog` setting `productUrl`, made absolute).
	 * @param {Site} s
	 * @param {{ id: string, slug: string }} item
	 */
	const productUrl = async (s, item) => {
		const { productUrl: template } = await s.values('catalog');
		const path = String(template || '/products/{slug}')
			.replaceAll('{slug}', encodeURIComponent(item.slug))
			.replaceAll('{id}', encodeURIComponent(item.id));
		return /^https:\/\//.test(path) ? path : `https://${s.domain}${path.startsWith('/') ? '' : '/'}${path}`;
	};

	/**
	 * A category page on the merchant's website (`categoryUrl`).
	 * @param {Site} s
	 * @param {{ slug: string }} category
	 */
	const categoryUrl = async (s, category) => {
		const { categoryUrl: template } = await s.values('catalog');
		const path = String(template || '/categories/{slug}').replaceAll('{slug}', encodeURIComponent(category.slug));
		return /^https:\/\//.test(path) ? path : `https://${s.domain}${path.startsWith('/') ? '' : '/'}${path}`;
	};

	return Object.freeze({ mediaUrl, productUrl, categoryUrl });
};

/** @typedef {ReturnType<typeof createMedia>} Media */
