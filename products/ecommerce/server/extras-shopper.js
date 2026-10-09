/**
 * The wishlist (feature `wishlist`) and compare (feature `compare`), PLAN 0.8.8. A signed-in shopper keeps up to
 * {@link MAX_WISHLIST} products, shown as product cards of the ones still active; visitors compare a few products
 * side by side on their comparable attributes, price, brand, grade, rating and image.
 * @module
 */
import { defineRoute, problem } from '@ss/app-kit';
import { userIdsOf } from '../adapters/extras-store.js';
import { MAX_COMPARE, compareRows, gradeLabels, parseCompareIds } from '../core/compare.js';
import { COLLECTIONS } from '../core/model.js';
import { VISITOR_LIMITS, VISITOR_WRITE_LIMITS } from './service.js';

/** Rate limits (mutable copies of the shared constants, as route definitions take them). */
const VISITOR = [...VISITOR_LIMITS];
const VISITOR_WRITE = [...VISITOR_WRITE_LIMITS];

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./extras-cards.js').Cards} Cards */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/model.js').WishlistRecord} WishlistRecord */
/** @typedef {import('../core/model.js').AttributeRecord} AttributeRecord */

/** Products in a wishlist, at most. */
export const MAX_WISHLIST = 200;
const NO_ID = { projection: { _id: 0 } };

/**
 * @param {Product} _product
 * @param {Service} service
 * @param {Cards} cards
 */
export const createShopperLists = (_product, service, cards) => {
	/** @param {WebsiteData} data */
	const wishlists = (data) => data.collection(COLLECTIONS.wishlists);

	/**
	 * @param {WebsiteData} data
	 * @param {string} userId
	 * @returns {Promise<string[]>}
	 */
	const savedIds = async (data, userId) => {
		const found = /** @type {WishlistRecord | null} */ (
			await wishlists(data).findOne({ websiteId: data.websiteId, userId }, NO_ID)
		);
		return found?.productIds ?? [];
	};

	/**
	 * The wishlist as product cards (products no longer active are left out).
	 * @param {Site} s
	 * @param {WebsiteData} data
	 * @param {string} userId
	 */
	const wishlistView = async (s, data, userId) => {
		const ids = await savedIds(data, userId);
		return { items: await cards.cards(s, ids), max: MAX_WISHLIST };
	};

	/** @param {any} ctx */
	const readWishlist = async (ctx) => {
		const s = await service.site(ctx);
		const shopper = await service.requireShopper(s);
		return wishlistView(s, await s.data(), shopper.id);
	};

	/** @param {any} ctx */
	const add = async (ctx) => {
		const s = await service.site(ctx);
		const shopper = await service.requireShopper(s);
		const productId = String(ctx.params.productId);
		const [item] = /^prd_[A-Za-z0-9]{1,64}$/.test(productId) ? await cards.activeProducts(s, [productId]) : [];
		if (!item) throw problem('not_found', 'No such product.');
		const data = await s.data();
		const ids = await savedIds(data, shopper.id);
		if (!ids.includes(productId)) {
			if (ids.length >= MAX_WISHLIST) throw service.invalid('productId', `A wishlist holds at most ${MAX_WISHLIST} products.`);
			await wishlists(data).updateOne(
				{ websiteId: data.websiteId, userId: shopper.id },
				{ $addToSet: { productIds: productId }, $setOnInsert: { userId: shopper.id } },
				{ upsert: true },
			);
		}
		return wishlistView(s, data, shopper.id);
	};

	/** @param {any} ctx */
	const remove = async (ctx) => {
		const s = await service.site(ctx);
		const shopper = await service.requireShopper(s);
		const data = await s.data();
		await wishlists(data).updateOne(
			{ websiteId: data.websiteId, userId: shopper.id },
			{ $pull: { productIds: String(ctx.params.productId) } },
		);
		return wishlistView(s, data, shopper.id);
	};

	/** @param {any} ctx */
	const compare = async (ctx) => {
		const s = await service.site(ctx);
		const { maxProducts } = await s.values('compare');
		const max = Math.min(MAX_COMPARE, Math.max(2, Number(maxProducts) || MAX_COMPARE));
		const parsed = parseCompareIds(ctx.query.ids, max);
		if (!parsed.ok) throw service.invalid('ids', parsed.message);
		const products = await cards.activeProducts(s, parsed.ids);
		const data = await s.data();
		const attributes = /** @type {AttributeRecord[]} */ (
			await data.collection(COLLECTIONS.attributes).find({ websiteId: data.websiteId, comparable: true }, NO_ID).toArray()
		);
		const brandIds = [...new Set(products.flatMap((p) => (p.brandId ? [p.brandId] : [])))];
		const brands = /** @type {Array<{ id: string, name: string }>} */ (
			brandIds.length === 0
				? []
				: await data
						.collection(COLLECTIONS.brands)
						.find({ websiteId: data.websiteId, id: { $in: brandIds } }, { projection: { _id: 0, id: 1, name: 1 } })
						.toArray()
		);
		const graded = products.some((p) => p.variants.some((v) => v.grade));
		const grades = graded ? await s.list('grades') : [];
		return {
			products: await Promise.all(
				products.map(async (item) => ({
					...(await cards.card(s, item)),
					brand: brands.find((brand) => brand.id === item.brandId)?.name ?? null,
					grades: gradeLabels(item, Array.isArray(grades) ? grades : []),
				})),
			),
			rows: compareRows(products, attributes),
		};
	};

	/**
	 * @param {Site} s
	 * @param {{ id?: string, email?: string, phone?: string }} person
	 */
	const exportUser = async (s, person) => {
		const data = await s.data();
		const users = await userIdsOf(data, person);
		const rows = /** @type {WishlistRecord[]} */ (
			users.length === 0
				? []
				: await wishlists(data)
						.find(
							{ websiteId: data.websiteId, userId: { $in: users } },
							{ projection: { _id: 0, userId: 1, productIds: 1 } },
						)
						.toArray()
		);
		return { wishlist: rows };
	};

	/**
	 * @param {Site} s
	 * @param {{ id?: string, email?: string, phone?: string }} person
	 */
	const deleteUser = async (s, person) => {
		const data = await s.data();
		const users = await userIdsOf(data, person);
		if (users.length === 0) return { deleted: 0, anonymised: 0 };
		const result = await wishlists(data).deleteMany({ websiteId: data.websiteId, userId: { $in: users } });
		return { deleted: result.deletedCount, anonymised: 0 };
	};

	const routes = [
		defineRoute({
			method: 'GET',
			path: '/v1/shop/wishlist',
			auth: 'browser',
			feature: 'wishlist',
			rateLimit: VISITOR,
			handler: readWishlist,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/shop/wishlist/items/:productId',
			auth: 'browser',
			feature: 'wishlist',
			rateLimit: VISITOR_WRITE,
			handler: add,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/shop/wishlist/items/:productId',
			auth: 'browser',
			feature: 'wishlist',
			rateLimit: VISITOR_WRITE,
			handler: remove,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/shop/compare',
			auth: 'browser',
			feature: 'compare',
			rateLimit: VISITOR,
			handler: compare,
		}),
	];

	return { routes, exportUser, deleteUser };
};
