/**
 * Product cards of the shopper extras (wishlist, alerts, compare): name, price as the grid's cards show it (after
 * automatic deals, SEO audit G4; with its text by the website's Format, PLAN 0.8.10 K7), main image, page address and
 * whether it can be bought now, read from the products collection.
 * @module
 */
import { categoryTrail } from '../adapters/promotions-store.js';
import { cardPhotos, shownRange } from '../core/catalog-views.js';
import { COLLECTIONS } from '../core/model.js';
import { createMedia } from './catalog-media.js';
import { hiddenFor, visibleMatch } from './catalog-visibility.js';
import { createShownPrices } from './shown-prices.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */

/**
 * @param {Product} product
 * @param {Service} service
 */
export const createCards = (product, service) => {
	const media = createMedia(product);
	const shownPrices = createShownPrices(service);

	/**
	 * Active products shoppers may see by id (in the order asked, missing and hidden ones left out; PLAN 0.8.10 E1).
	 * @param {Site} s
	 * @param {string[]} ids
	 * @returns {Promise<ProductRecord[]>}
	 */
	const activeProducts = async (s, ids) => {
		if (ids.length === 0) return [];
		const data = await s.data();
		const found = /** @type {ProductRecord[]} */ (
			await data
				.collection(COLLECTIONS.products)
				.find(
					{ websiteId: s.websiteId, id: { $in: ids }, status: 'active', ...visibleMatch(await hiddenFor(s)) },
					{ projection: { _id: 0 } },
				)
				.toArray()
		);
		const byId = new Map(found.map((p) => [p.id, p]));
		return ids.flatMap((id) => {
			const p = byId.get(id);
			return p ? [p] : [];
		});
	};

	/**
	 * The card of a product.
	 * @param {Site} s
	 * @param {ProductRecord} item
	 * @param {Awaited<ReturnType<ReturnType<typeof createShownPrices>>>} [prices] the website's shown prices, when
	 *   already read
	 */
	const card = async (s, item, prices) => {
		const data = await s.data();
		const priced = prices ?? (await shownPrices(s, data));
		const categoryIds = priced.deals.length > 0 ? await categoryTrail(data, item.categoryIds) : item.categoryIds;
		// as the grid's cards (PLAN 0.8.10 E2, E6, E8, G4)
		const { price, compareAtPrice, priceMax } = shownRange(item, priced.of(item, categoryIds));
		return {
			id: item.id,
			name: item.name,
			slug: item.slug,
			url: await media.productUrl(s, item),
			image: await media.mediaUrl(s, item.media[0]?.key),
			price,
			priceText: (await s.format()).money(price, s.currency),
			compareAtPrice,
			currency: s.currency,
			inStock: item.inStock,
			rating: item.rating,
			priceMax,
			featured: item.featured,
			cardImages: await Promise.all(
				cardPhotos(item).map(async (file) => ({
					url: await media.mediaUrl(s, file.sizes?.card ?? file.key),
					alt: file.alt || item.name,
				})),
			),
		};
	};

	/**
	 * Cards of active products by id.
	 * @param {Site} s
	 * @param {string[]} ids
	 */
	const cards = async (s, ids) => {
		const prices = await shownPrices(s, await s.data());
		return Promise.all((await activeProducts(s, ids)).map((item) => card(s, item, prices)));
	};

	return Object.freeze({ activeProducts, card, cards, media });
};

/** @typedef {ReturnType<typeof createCards>} Cards */
