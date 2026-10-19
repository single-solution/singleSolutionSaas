/**
 * Addresses of the shop's files in the merchant's own storage (PLAN 0.8.8: media in the merchant's own storage) and of
 * product pages on the merchant's website. Images are shown from the public address of the storage connection
 * (`publicBaseUrl`: the bucket's or CDN's, set in the Portal) when it has one, else through a signed link that lasts an
 * hour. Used by every part that shows a product (catalog, checkout, the Chat lookups, alerts). What search engines and
 * shopping catalogs keep (SEO answers, sitemaps, feeds) never carries a signed link (SEO audit G1): `stableUrl` is the
 * public address, else the website's own media route (`/media`, the guide's `app/media/[...key]/route.js`) with a
 * signature that never changes for the file. Links follow the URL templates (PLAN 0.8.10 E13).
 * @module
 */

import { mediaSignature } from '../adapters/crypto.js';
import { categoryLink, productLink, variantQueryOf, withQuery } from '../core/links.js';
import { COLLECTIONS } from '../core/model.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/links.js').LinkContext} LinkContext */

/** At most this many categories and brands are read for links. */
const MAX_RECORDS = 5000;

/** A signed image link lasts this long. */
const SIGNED_MEDIA_SECONDS = 3600;
/** Where the website serves its images when its storage has no public address (the guide's media route). */
const MEDIA_PATH = '/media';

/**
 * A storage key in an address: each part encoded.
 * @param {string} key
 */
const keyPath = (key) => key.split('/').map(encodeURIComponent).join('/');

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
		const storage = await product.connections.storage(s.websiteId);
		if (!storage) return null;
		return storage.publicUrl(key) ?? storage.presignGet({ key, expiresIn: SIGNED_MEDIA_SECONDS }).url;
	};

	/**
	 * The address of a stored image that never changes, for what search engines and shopping catalogs keep (G1): the
	 * public address of the storage connection when it has one, else `https://<domain>/media/<signature>/<key>` on the
	 * website, whose media route fetches the file through `GET /v1/media`; null without storage.
	 * @param {Site} s
	 * @param {string | null | undefined} key
	 * @returns {Promise<string | null>}
	 */
	const stableUrl = async (s, key) => {
		if (!key) return null;
		const storage = await product.connections.storage(s.websiteId);
		if (!storage) return null;
		const publicUrl = storage.publicUrl(key);
		if (publicUrl) return publicUrl;
		const signature = mediaSignature(await product.secrets.get(s.websiteId), key);
		return `https://${s.domain}${MEDIA_PATH}/${signature}/${keyPath(key)}`;
	};

	/**
	 * An order's attachments shoppers see (E20): those of the attachment kinds marked for shoppers, each with the kind's
	 * name and type and its address (an upload's address, or the https address kept; a YouTube one is its private embed
	 * address), oldest first.
	 * @param {Site} s
	 * @param {{ attachments?: ReadonlyArray<{ kind: string, key: string | null, url: string | null }> }} order
	 * @returns {Promise<Array<{ kind: string, label: string, type: string, url: string }>>}
	 */
	const shopperAttachments = async (s, order) => {
		const held = order.attachments ?? [];
		if (held.length === 0) return [];
		/** @type {Array<{ key: string, label: string, type: string, shoppers: boolean }>} */
		const kinds = await s.list('attachment_kinds');
		const out = [];
		for (const attachment of held) {
			const kind = kinds.find((entry) => entry.key === attachment.kind && entry.shoppers);
			if (!kind) continue;
			const url = attachment.key
				? await mediaUrl(s, attachment.key)
				: typeof attachment.url === 'string' && /^https:\/\//.test(attachment.url)
					? attachment.url
					: null;
			if (url) out.push({ kind: kind.key, label: kind.label, type: kind.type, url });
		}
		return out;
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
					categories: new Map(categories.map((c) => [String(c.id), { slug: String(c.slug), path: c.path }])),
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
	 * @param {ReadonlyMap<string, { slug: string, active: boolean, show: { page: boolean } }>} attributes the fields by id
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

	return Object.freeze({ mediaUrl, stableUrl, shopperAttachments, productUrl, variantUrl, categoryUrl, linkContext });
};

/** @typedef {ReturnType<typeof createMedia>} Media */
