/**
 * The lookups other products call with the pasted Ecommerce server token: Chat's shop tools (PLAN 0.8.3 Shop tools;
 * exactly the endpoints of `products/chat/core/shop.js`) and the customer orders lookup Accounts' Orders tab and
 * Chat's context panel use. All read-only with small answers. The `me` lookups take the visitor's Accounts sign-in
 * forwarded in `SS-Sign-In`, verify it here and answer only that user's data — never street addresses or phone
 * numbers; any query value naming another user is ignored.
 * @module
 */
import { defineRoute } from '@ss/app-kit';
import { loyaltyAccount } from '../adapters/ledger.js';
import { loadOffers } from '../adapters/promotions-store.js';
import {
	cardVariant,
	gradeLabels,
	limitOf,
	orderSummary,
	productCard,
	productDetails,
	searchTerms,
	shipmentSummary,
	statusLabel,
} from '../core/lookup.js';
import { COLLECTIONS } from '../core/model.js';
import { formatMoney } from '../core/money.js';
import { applyPromotions } from '../core/promotions.js';
import { SERVER_LIMITS } from './service.js';
import { activeProduct, brandNames, categoriesById } from './seo-reads.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./catalog-media.js').Media} Media */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */
/** @typedef {import('../core/model.js').DealRecord} DealRecord */

/** The rate limits of these routes. @type {Array<{ limit: number, windowSeconds: number, per?: 'website' | 'visitor' }>} */
const SERVER_RATE = [...SERVER_LIMITS];

/**
 * The website's order flow.
 * @param {Site} s
 * @returns {Promise<import('../core/model.js').OrderFlow>}
 */
const flowOf = async (s) => /** @type {any} */ (await s.list('order_flow'));

/** What a product card reads of a product. */
const CARD_FIELDS = Object.freeze({
	_id: 0,
	id: 1,
	slug: 1,
	name: 1,
	media: 1,
	variants: 1,
	trackStock: 1,
	price: 1,
	inStock: 1,
});

/** What the order lookups read of an order (never the address or the customer's phone). */
const ORDER_FIELDS = Object.freeze({
	_id: 0,
	id: 1,
	number: 1,
	status: 1,
	totals: 1,
	shipment: 1,
	placedAt: 1,
	createdAt: 1,
});

/**
 * @param {Product} product
 * @param {Service} service
 * @param {Media} media
 */
export const createChatLookup = (product, service, media) => {
	/**
	 * Product cards of products.
	 * @param {Site} s
	 * @param {ProductRecord[]} items
	 */
	const cards = (s, items) =>
		Promise.all(
			items.map(async (item) =>
				productCard(item, {
					currency: s.currency,
					image: await media.mediaUrl(s, item.media?.[0]?.key),
					url: await media.productUrl(s, item),
				}),
			),
		);

	/**
	 * The loyalty balance of a user (0 while loyalty is off).
	 * @param {Site} s
	 * @param {WebsiteData} data
	 * @param {string} userId
	 */
	const pointsOf = async (s, data, userId) =>
		s.has('loyalty') ? (await loyaltyAccount(data, userId, { now: service.now() })).balance : 0;

	/**
	 * A user's most recent orders.
	 * @param {WebsiteData} data
	 * @param {string} userId
	 * @param {number} limit
	 * @param {boolean} [shipped] only orders with a shipment
	 * @returns {Promise<OrderRecord[]>}
	 */
	const ordersOf = async (data, userId, limit, shipped = false) =>
		/** @type {OrderRecord[]} */ (
			await data
				.collection(COLLECTIONS.orders)
				.find(
					{ websiteId: data.websiteId, 'customer.userId': userId, ...(shipped ? { shipment: { $ne: null } } : {}) },
					{ projection: ORDER_FIELDS },
				)
				.sort({ placedAt: -1, id: -1 })
				.limit(limit)
				.toArray()
		);

	/** @param {any} ctx */
	const search = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const terms = searchTerms(ctx.query.q);
		if (terms.length === 0) return { items: [] };
		const limit = limitOf(ctx.query.limit, 5, 10);
		const brands = await data
			.collection(COLLECTIONS.brands)
			.find(
				{ websiteId: data.websiteId, $or: terms.map((term) => ({ name: { $regex: term, $options: 'i' } })) },
				{ projection: { _id: 0, id: 1, name: 1 } },
			)
			.limit(50)
			.toArray();
		const filter = {
			websiteId: data.websiteId,
			status: 'active',
			$and: terms.map((term) => {
				const pattern = { $regex: term, $options: 'i' };
				const brandIds = brands.filter((brand) => new RegExp(term, 'i').test(String(brand.name))).map((brand) => brand.id);
				return {
					$or: [
						{ name: pattern },
						{ summary: pattern },
						{ tags: pattern },
						{ 'variants.sku': pattern },
						...(brandIds.length > 0 ? [{ brandId: { $in: brandIds } }] : []),
					],
				};
			}),
		};
		const found = /** @type {ProductRecord[]} */ (
			await data
				.collection(COLLECTIONS.products)
				.find(filter, { projection: CARD_FIELDS })
				.sort({ inStock: -1, sold: -1, id: 1 })
				.limit(limit)
				.toArray()
		);
		return { items: await cards(s, found) };
	};

	/** @param {any} ctx */
	const top = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const kind = ctx.query.kind === 'new' ? 'new' : 'top';
		if (ctx.query.kind !== undefined && ctx.query.kind !== 'new' && ctx.query.kind !== 'top')
			throw service.invalid('kind', 'kind must be top or new.');
		const found = /** @type {ProductRecord[]} */ (
			await data
				.collection(COLLECTIONS.products)
				.find({ websiteId: data.websiteId, status: 'active' }, { projection: CARD_FIELDS })
				.sort(kind === 'new' ? { publishedAt: -1, id: -1 } : { sold: -1, publishedAt: -1, id: -1 })
				.limit(limitOf(ctx.query.limit, 5, 10))
				.toArray()
		);
		return { items: await cards(s, found) };
	};

	/** @param {any} ctx */
	const details = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const item = await activeProduct(data, ctx.params.id);
		const specIds = Object.keys(item.specs);
		const [brands, attributes, grades] = await Promise.all([
			brandNames(data, [item.brandId]),
			specIds.length === 0
				? []
				: data
						.collection(COLLECTIONS.attributes)
						.find({ websiteId: data.websiteId, id: { $in: specIds } }, { projection: { _id: 0, id: 1, name: 1, unit: 1 } })
						.toArray(),
			s.has('grades_serials') ? s.list('grades') : Promise.resolve([]),
		]);
		return productDetails(item, {
			currency: s.currency,
			image: await media.mediaUrl(s, item.media?.[0]?.key),
			url: await media.productUrl(s, item),
			brand: item.brandId ? (brands.get(item.brandId) ?? null) : null,
			attributes: new Map(attributes.map((row) => [String(row.id), { name: String(row.name), unit: String(row.unit) }])),
			grades: gradeLabels(grades),
		});
	};

	/** @param {any} ctx */
	const quote = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const item = await activeProduct(data, ctx.params.id);
		const variant = cardVariant(item);
		const price = variant ? variant.price : item.price;
		const now = service.now();
		const categories = await categoriesById(data, item.categoryIds);
		const categoryIds = [...new Set([...item.categoryIds, ...categories.flatMap((category) => category.path)])];
		const offers = await loadOffers(data, { now, deals: true, bundles: false });
		const result = variant
			? applyPromotions({
					lines: [
						{
							key: `${item.id}|${variant.id}`,
							productId: item.id,
							variantId: variant.id,
							categoryIds,
							brandId: item.brandId,
							unitPrice: price,
							quantity: 1,
						},
					],
					deals: offers.deals,
					bundles: [],
					coupon: null,
					couponCode: '',
					customer: { orderCount: 0, couponUses: 0 },
					now,
				})
			: null;
		const savings = Math.min(price, Math.max(0, result?.lines[0]?.dealDiscount ?? 0));
		const names = new Map(offers.deals.map((deal) => [deal.id, deal.name]));
		return {
			productId: item.id,
			price,
			priceAfterDeals: price - savings,
			savings,
			currency: s.currency,
			deals: result && savings > 0 ? result.dealIds.map((id) => names.get(id) ?? '').filter(Boolean) : [],
		};
	};

	/** @param {any} ctx */
	const deals = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const offers = await loadOffers(data, { now: service.now(), deals: true, bundles: false });
		return {
			items: offers.deals.slice(0, limitOf(ctx.query.limit, 10, 20)).map((/** @type {DealRecord} */ deal) => ({
				id: deal.id,
				name: deal.name,
				description: deal.description,
				endsAt: deal.endsAt ? new Date(deal.endsAt).toISOString() : null,
			})),
		};
	};

	/** @param {any} ctx */
	const myOrders = async (ctx) => {
		const s = await service.site(ctx);
		const shopper = await service.requireShopper(s);
		const data = await s.data();
		const [orders, flow, loyaltyPoints] = await Promise.all([
			ordersOf(data, shopper.id, limitOf(ctx.query.limit, 5, 10)),
			flowOf(s),
			pointsOf(s, data, shopper.id),
		]);
		return { items: orders.map((order) => orderSummary(order, flow)), loyaltyPoints, name: shopper.name };
	};

	/** @param {any} ctx */
	const myAccount = async (ctx) => {
		const s = await service.site(ctx);
		const shopper = await service.requireShopper(s);
		return { name: shopper.name, loyaltyPoints: await pointsOf(s, await s.data(), shopper.id) };
	};

	/** @param {any} ctx */
	const myShipments = async (ctx) => {
		const s = await service.site(ctx);
		const shopper = await service.requireShopper(s);
		const data = await s.data();
		const [orders, flow] = await Promise.all([ordersOf(data, shopper.id, limitOf(ctx.query.limit, 5, 10), true), flowOf(s)]);
		return { items: orders.map((order) => shipmentSummary(order, flow)).filter((found) => found !== null) };
	};

	/** @param {any} ctx */
	const customerOrders = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const userId = String(ctx.params.userId);
		const [orders, flow, loyaltyPoints] = await Promise.all([
			ordersOf(data, userId, limitOf(ctx.query.limit, 10, 50)),
			flowOf(s),
			pointsOf(s, data, userId),
		]);
		return {
			items: orders.map((order) => ({
				id: order.id,
				number: order.number,
				status: order.status,
				statusLabel: statusLabel(flow, order.status),
				total: order.totals.total,
				totalText: formatMoney(order.totals.total, order.totals.currency),
				currency: order.totals.currency,
				createdAt: new Date(order.placedAt).toISOString(),
			})),
			loyaltyPoints,
		};
	};

	return {
		routes: [
			defineRoute({
				method: 'GET',
				path: '/v1/chat/products',
				auth: 'server',
				feature: 'catalog',
				rateLimit: SERVER_RATE,
				handler: search,
			}),
			// before /v1/chat/products/:id, so `top` is never taken for a product
			defineRoute({
				method: 'GET',
				path: '/v1/chat/products/top',
				auth: 'server',
				feature: 'catalog',
				rateLimit: SERVER_RATE,
				handler: top,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/chat/products/:id',
				auth: 'server',
				feature: 'catalog',
				rateLimit: SERVER_RATE,
				handler: details,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/chat/products/:id/quote',
				auth: 'server',
				feature: 'deals',
				rateLimit: SERVER_RATE,
				handler: quote,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/chat/deals',
				auth: 'server',
				feature: 'deals',
				rateLimit: SERVER_RATE,
				handler: deals,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/chat/me/orders',
				auth: 'server',
				feature: 'checkout',
				rateLimit: SERVER_RATE,
				handler: myOrders,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/chat/me/account',
				auth: 'server',
				feature: 'checkout',
				rateLimit: SERVER_RATE,
				handler: myAccount,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/chat/me/shipments',
				auth: 'server',
				feature: 'checkout',
				rateLimit: SERVER_RATE,
				handler: myShipments,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/customers/:userId/orders',
				auth: 'server',
				feature: 'checkout',
				rateLimit: SERVER_RATE,
				handler: customerOrders,
			}),
		],
	};
};
