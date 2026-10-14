/**
 * The lookups other products call with the pasted Ecommerce server token: Chat's shop tools (PLAN 0.8.3 Shop tools;
 * exactly the endpoints of `products/chat/core/shop.js`) and the customer orders lookup Accounts' Orders tab and
 * Chat's context panel use. All read-only with small answers. The `me` lookups take the visitor's Accounts sign-in
 * forwarded in `SS-Sign-In`, verify it here and answer only that user's data — never street addresses or phone
 * numbers; any query value naming another user is ignored. Every price and total comes with its text (`priceText`,
 * `totalText` …) by the website's Format (PLAN 0.8.10 K7). E37 adds search filters, warranties, quotes per variant and
 * payment method with fees and delivery, deal display fields, fuller orders and accounts, and the live store context
 * (`GET /v1/chat/context`) Chat's AI replies add (C1).
 * @module
 */
import { defineRoute, problem } from '@ss/app-kit';
import { categoriesOf } from '../adapters/catalog-store.js';
import { ownerOrders } from '../adapters/fulfilment-store.js';
import { loyaltyAccount } from '../adapters/ledger.js';
import { dealsLiveNow, loadOffers } from '../adapters/promotions-store.js';
import { htmlToText } from '../core/catalog-content.js';
import { lineageOf } from '../core/catalog-taxonomy.js';
import { stockLeftOf } from '../core/catalog-views.js';
import { CONTEXT_DEALS, CONTEXT_PRODUCTS, contextText } from '../core/chat-context.js';
import { shipmentLink } from '../core/couriers.js';
import { byShowOrder } from '../core/deals.js';
import { gradesFor } from '../core/grades.js';
import {
	MAX_QUOTE_QUANTITY,
	chatDeal,
	chatFilters,
	filtersGiven,
	gradeLabels,
	gradePrices,
	limitOf,
	matchingVariant,
	orderSummary,
	productCard,
	productDetails,
	searchTerms,
	shipmentSummary,
	statusLabel,
	variantFilter,
	warrantyOf,
} from '../core/lookup.js';
import { COLLECTIONS } from '../core/model.js';
import { PAYMENT_METHODS, customerOwner, isCustomerId } from '../core/orders.js';
import { createCatalogSearch } from './catalog-search.js';
import { hiddenFor, visible, visibleMatch } from './catalog-visibility.js';
import { createQuoting } from './checkout-quote.js';
import { policiesOf } from './policies.js';
import { SERVER_LIMITS } from './service.js';
import { activeProduct, brandNames } from './seo-reads.js';

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
 * A first name: the first word of a name.
 * @param {string} name
 */
const firstNameOf = (name) =>
	String(name ?? '')
		.trim()
		.split(/\s+/)[0] ?? '';

/**
 * Read a Chat quote's query (E37): `variantId`, `quantity` (1–5), `paymentMethod` and `city`.
 * @param {Record<string, unknown>} query
 * @returns {{ variantId: string | null, quantity: number, paymentMethod: import('../core/model.js').PaymentMethod | null,
 *   city: string }}
 */
const quoteQuery = (query) => {
	const variantId = query.variantId === undefined || query.variantId === '' ? null : query.variantId;
	if (variantId !== null && (typeof variantId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(variantId)))
		throw invalidQuery('variantId', 'variantId is a variant id.');
	const quantity = query.quantity === undefined || query.quantity === '' ? 1 : Number(query.quantity);
	if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUOTE_QUANTITY || !/^\d+$/.test(String(query.quantity ?? 1)))
		throw invalidQuery('quantity', `quantity is a whole number from 1 to ${MAX_QUOTE_QUANTITY}.`);
	const method = query.paymentMethod === undefined || query.paymentMethod === '' ? null : query.paymentMethod;
	if (method !== null && !PAYMENT_METHODS.includes(/** @type {any} */ (method)))
		throw invalidQuery('paymentMethod', `paymentMethod is one of ${PAYMENT_METHODS.join(', ')}.`);
	const city = typeof query.city === 'string' ? query.city.trim() : '';
	if (city.length > 80) throw invalidQuery('city', 'city is at most 80 characters.');
	return {
		variantId: /** @type {string | null} */ (variantId),
		quantity,
		paymentMethod: /** @type {import('../core/model.js').PaymentMethod | null} */ (method),
		city,
	};
};

/**
 * A 422 naming a query field.
 * @param {string} field @param {string} message
 */
const invalidQuery = (field, message) =>
	problem('validation_failed', message, { errors: [{ path: `/${field}`, message, code: 'invalid' }] });

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
	kind: 1,
	media: 1,
	variants: 1,
	trackStock: 1,
	price: 1,
	inStock: 1,
	categoryIds: 1,
	brandId: 1,
	warrantyDays: 1,
	publishedAt: 1,
});

/** What the order lookups read of an order (never the address or the customer's phone). */
const ORDER_FIELDS = Object.freeze({
	_id: 0,
	id: 1,
	number: 1,
	status: 1,
	role: 1,
	totals: 1,
	lines: 1,
	payment: 1,
	shipment: 1,
	media: 1,
	placedAt: 1,
	createdAt: 1,
});

/**
 * @param {Product} product
 * @param {Service} service
 * @param {Media} media
 */
export const createChatLookup = (product, service, media) => {
	const atlas = createCatalogSearch(product);
	const quoting = createQuoting(product, service);

	/**
	 * An active product shoppers may see (E1), or 404.
	 * @param {Site} s @param {WebsiteData} data @param {unknown} ref
	 */
	const shownProduct = async (s, data, ref) => {
		const item = await activeProduct(data, ref);
		if (!visible(item, await hiddenFor(s))) throw problem('not_found', 'There is no such product.');
		return item;
	};

	/**
	 * What cards and details need of the website: the Format, grade labels, stock shown (E9) and warranties (E12).
	 * @param {Site} s
	 */
	const cardRules = async (s) => {
		const [{ money, date }, catalog, returns, grades] = await Promise.all([
			s.format(),
			s.values('catalog'),
			s.values('returns'),
			s.has('grades_serials') ? s.list('grades') : Promise.resolve([]),
		]);
		const categories =
			grades.length > 0 ? new Map((await categoriesOf(await s.data())).map((category) => [category.id, category])) : new Map();
		/** @type {Map<string, Map<string, import('../core/grades.js').Grade>>} the grades of each category list, read once */
		const known = new Map();
		/** A product's grades: the entries of its category or the nearest one above it first (E45). @param {ProductRecord} item */
		const gradesOf = (item) => {
			const lineage = lineageOf(item.categoryIds, categories);
			const found = known.get(lineage.join(',')) ?? gradesFor(grades, lineage);
			known.set(lineage.join(','), found);
			return found;
		};
		const stock = { showStock: String(catalog.showStock ?? 'none'), lowStockShown: Number(catalog.lowStockShown ?? 5) };
		return {
			money,
			date,
			/** @param {ProductRecord} item */
			labels: (item) => gradeLabels([...gradesOf(item).values()]),
			/** @param {ProductRecord} item */
			stockLeft: (item) => (/** @type {import('../core/model.js').VariantRecord} */ variant) =>
				stockLeftOf(variant, item.trackStock, stock),
			/** @param {ProductRecord} item */
			warranty: (item) => (/** @type {import('../core/model.js').VariantRecord} */ variant) =>
				warrantyOf(item, variant, { grades: gradesOf(item), fallback: Number(returns.warrantyDays ?? 0) }),
		};
	};

	/**
	 * Product cards of products, each with the variant Chat's filters matched (when given).
	 * @param {Site} s
	 * @param {ProductRecord[]} items
	 * @param {import('../core/lookup.js').ChatFilters | null} [filters]
	 */
	const cards = async (s, items, filters = null) => {
		const rules = await cardRules(s);
		return Promise.all(
			items.map(async (item) =>
				productCard(
					item,
					{
						currency: s.currency,
						image: await media.mediaUrl(s, item.media?.[0]?.key),
						url: await media.productUrl(s, item),
						money: rules.money,
						grades: rules.labels(item),
						stockLeft: rules.stockLeft(item),
					},
					filters ? matchingVariant(item, filters) : null,
				),
			),
		);
	};

	/**
	 * The loyalty balance of a user, or of a guest by customer id (null while loyalty is off).
	 * @param {Site} s
	 * @param {WebsiteData} data
	 * @param {string | { userId: string } | { customerId: string }} owner
	 */
	const pointsOf = async (s, data, owner) =>
		s.has('loyalty') ? (await loyaltyAccount(data, owner, { now: service.now() })).balance : null;

	/**
	 * A user's most recent orders, or a guest's by customer id.
	 * @param {WebsiteData} data
	 * @param {string | { userId: string } | { customerId: string }} owner
	 * @param {number} limit
	 * @param {boolean} [shipped] only orders with a shipment
	 * @returns {Promise<OrderRecord[]>}
	 */
	const ordersOf = async (data, owner, limit, shipped = false) =>
		/** @type {OrderRecord[]} */ (
			await data
				.collection(COLLECTIONS.orders)
				.find(
					{
						websiteId: data.websiteId,
						...ownerOrders(typeof owner === 'string' ? { userId: owner } : owner),
						...(shipped ? { shipment: { $ne: null } } : {}),
					},
					{ projection: ORDER_FIELDS },
				)
				.sort({ placedAt: -1, id: -1 })
				.limit(limit)
				.toArray()
		);

	/**
	 * The categories a `category` filter names (by id or slug), with every category below it; null when there is no
	 * such category.
	 * @param {WebsiteData} data
	 * @param {string} ref
	 * @returns {Promise<string[] | null>}
	 */
	const categoryScope = async (data, ref) => {
		const found = await data
			.collection(COLLECTIONS.categories)
			.findOne(
				{ websiteId: data.websiteId, $or: [{ id: ref }, { slug: ref.toLowerCase() }] },
				{ projection: { _id: 0, id: 1 } },
			);
		if (!found) return null;
		const below = await data
			.collection(COLLECTIONS.categories)
			.find({ websiteId: data.websiteId, path: found.id }, { projection: { _id: 0, id: 1 } })
			.toArray();
		return [String(found.id), ...below.map((row) => String(row.id))];
	};

	/**
	 * GET /v1/chat/products: words and filters (E37: category, grade, price range, in stock; at most 12 answers). With
	 * filters the words may be left out.
	 * @param {any} ctx
	 */
	const search = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const terms = searchTerms(ctx.query.q);
		const read = chatFilters(ctx.query);
		if (!read.ok) throw service.invalid(read.field, read.message);
		const filters = read.value;
		if (terms.length === 0 && !filtersGiven(filters)) return { items: [] };
		/** @type {Record<string, unknown>[]} */
		const and = [];
		if (filters.category !== null) {
			const scope = await categoryScope(data, filters.category);
			if (!scope) return { items: [] };
			and.push({ categoryIds: { $in: scope } });
		}
		const variant = variantFilter(filters);
		if (variant) and.push(variant);
		const base = { websiteId: data.websiteId, status: 'active', ...visibleMatch(await hiddenFor(s)) };
		const narrowed = and.length > 0 ? { ...base, $and: and } : base;
		const q = terms.join(' ');
		// Atlas Search first when the website uses it, the basic search when it fails (E14)
		if (q && (await atlas.useAtlas(s, q, 'chat'))) {
			const found = await atlas.run(s, data, q, {
				match: narrowed,
				sort: null,
				skip: 0,
				limit: filters.limit,
				project: CARD_FIELDS,
			});
			if (found.ok) return { items: await cards(s, /** @type {ProductRecord[]} */ (found.items), filters) };
		}
		/** @type {Record<string, unknown>[]} */
		const words = [];
		if (terms.length > 0) {
			const brands = await data
				.collection(COLLECTIONS.brands)
				.find(
					{ websiteId: data.websiteId, $or: terms.map((term) => ({ name: { $regex: term, $options: 'i' } })) },
					{ projection: { _id: 0, id: 1, name: 1 } },
				)
				.limit(50)
				.toArray();
			for (const term of terms) {
				const pattern = { $regex: term, $options: 'i' };
				const brandIds = brands.filter((brand) => new RegExp(term, 'i').test(String(brand.name))).map((brand) => brand.id);
				words.push({
					$or: [
						{ name: pattern },
						{ summary: pattern },
						{ tags: pattern },
						{ 'variants.sku': pattern },
						...(brandIds.length > 0 ? [{ brandId: { $in: brandIds } }] : []),
					],
				});
			}
		}
		const all = [...and, ...words];
		const found = /** @type {ProductRecord[]} */ (
			await data
				.collection(COLLECTIONS.products)
				.find(all.length > 0 ? { ...base, $and: all } : base, { projection: CARD_FIELDS })
				.sort({ inStock: -1, sold: -1, id: 1 })
				.limit(filters.limit)
				.toArray()
		);
		return { items: await cards(s, found, filters) };
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
				.find(
					{ websiteId: data.websiteId, status: 'active', ...visibleMatch(await hiddenFor(s)) },
					{ projection: CARD_FIELDS },
				)
				.sort(kind === 'new' ? { publishedAt: -1, id: -1 } : { sold: -1, publishedAt: -1, id: -1 })
				.limit(limitOf(ctx.query.limit, 5, 12))
				.toArray()
		);
		return { items: await cards(s, found) };
	};

	/**
	 * A product's details: variants with grade, price, stock left (E9) and warranty (E12).
	 * @param {Site} s @param {WebsiteData} data @param {ProductRecord} item
	 */
	const detailsOf = async (s, data, item) => {
		const specIds = Object.keys(item.specs ?? {});
		const [brands, attributes, rules] = await Promise.all([
			brandNames(data, [item.brandId]),
			specIds.length === 0
				? []
				: data
						.collection(COLLECTIONS.attributes)
						.find({ websiteId: data.websiteId, id: { $in: specIds } }, { projection: { _id: 0, id: 1, name: 1, unit: 1 } })
						.toArray(),
			cardRules(s),
		]);
		return productDetails(item, {
			currency: s.currency,
			image: await media.mediaUrl(s, item.media?.[0]?.key),
			url: await media.productUrl(s, item),
			money: rules.money,
			brand: item.brandId ? (brands.get(item.brandId) ?? null) : null,
			attributes: new Map(attributes.map((row) => [String(row.id), { name: String(row.name), unit: String(row.unit) }])),
			grades: rules.labels(item),
			stockLeft: rules.stockLeft(item),
			warrantyDays: rules.warranty(item),
		});
	};

	/** @param {any} ctx */
	const details = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		return detailsOf(s, data, await shownProduct(s, data, ctx.params.id));
	};

	/**
	 * GET /v1/chat/products/:id/quote: one variant (`variantId`, else the card variant) times `quantity` (1–5), priced
	 * exactly as the cart prices it for the payment method asked (deals, fees, delivery to `city` and its free-delivery
	 * threshold; a forwarded sign-in adds role pricing) (E37).
	 * @param {any} ctx
	 */
	const quote = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const item = await shownProduct(s, data, ctx.params.id);
		const { variantId, quantity, paymentMethod, city } = quoteQuery(ctx.query);
		const variant = variantId
			? item.variants.find((candidate) => candidate.id === variantId && candidate.active)
			: matchingVariant(item, { grades: [], minPrice: null, maxPrice: null, inStock: false });
		if (!variant) throw problem('not_found', 'There is no such variant.');
		const shopper = await service.shopper(s);
		const q = await quoting.quote(
			s,
			{
				lines: [{ productId: item.id, variantId: variant.id, quantity, slot: null }],
				coupon: '',
				points: 0,
				delivery: { method: paymentMethod === 'pickup' ? 'pickup' : null, city, area: '', country: '', locationId: null },
				payment: paymentMethod,
			},
			shopper,
		);
		const { money } = await s.format();
		/** @param {number} amount */
		const text = (amount) => money(amount, s.currency);
		const line = q.lines[0];
		const priced = q.prices[0];
		const unitPrice = variant.price;
		const dealOff = Math.min(unitPrice * quantity, priced?.promotions ?? 0);
		const savings = Math.floor(dealOff / quantity);
		const offers = q.promotions?.applied.filter((entry) => entry.kind === 'deal') ?? [];
		const deals = s.has('deals') ? (await loadOffers(data, { now: service.now(), deals: true })).deals : [];
		const { date } = await s.format();
		const totals = /** @type {Record<string, number>} */ (/** @type {unknown} */ (q.totals));
		const delivery = q.delivery.method === 'none' ? null : q.delivery;
		const freeOver = delivery?.freeOver ?? 0;
		return {
			productId: item.id,
			variantId: variant.id,
			quantity,
			price: unitPrice,
			priceText: text(unitPrice),
			priceAfterDeals: unitPrice - savings,
			priceAfterDealsText: text(unitPrice - savings),
			savings,
			savingsText: text(savings),
			currency: s.currency,
			deals: offers.map((entry) => entry.name),
			dealsApplied: offers.map((entry) => {
				const deal = deals.find((candidate) => candidate.id === entry.id);
				return {
					...(deal
						? chatDeal(deal, { currency: s.currency, money, date: (at) => date(at, 'date') })
						: { id: entry.id, name: entry.name }),
					amount: entry.amount,
					amountText: text(entry.amount),
				};
			}),
			inStock: line ? !line.problems.some((found) => found.code === 'out_of_stock') : false,
			problems: line?.problems ?? [],
			paymentMethod,
			paymentMethods: q.payments.map((option) => ({ ...option, advanceText: text(option.advance) })),
			subtotal: q.totals.subtotal,
			subtotalText: text(q.totals.subtotal),
			discount: q.totals.discount,
			discountText: text(q.totals.discount),
			roleDiscount: Number(totals.roleDiscount ?? 0),
			roleDiscountText: text(Number(totals.roleDiscount ?? 0)),
			fee: Number(totals.fee ?? 0),
			feeText: text(Number(totals.fee ?? 0)),
			tax: q.totals.tax,
			taxText: text(q.totals.tax),
			delivery: delivery
				? {
						method: delivery.method,
						name: delivery.name,
						fee: delivery.fee,
						feeText: text(delivery.fee),
						minDays: delivery.minDays,
						maxDays: delivery.maxDays,
					}
				: null,
			freeDeliveryOver: freeOver > 0 ? freeOver : null,
			freeDeliveryOverText: freeOver > 0 ? text(freeOver) : '',
			total: q.totals.total,
			totalText: text(q.totals.total),
		};
	};

	/**
	 * The deals live now as Chat shows them (E37: with their display fields; weekdays and hours as the cart judges them,
	 * PR-6), in the shoppers' order.
	 * @param {Site} s @param {WebsiteData} data @param {number} limit
	 */
	const dealRows = async (s, data, limit) => {
		const live = await dealsLiveNow(data, { now: service.now(), clock: await service.pricing(s) });
		const { money, date } = await s.format();
		return Promise.all(
			[...live]
				.sort(byShowOrder)
				.slice(0, limit)
				.map(async (/** @type {DealRecord} */ deal) =>
					chatDeal(deal, {
						currency: s.currency,
						money,
						date: (at) => date(at, 'date'),
						bannerUrl: await media.mediaUrl(s, /** @type {any} */ (deal).banner?.key),
					}),
				),
		);
	};

	/** @param {any} ctx */
	const deals = async (ctx) => {
		const s = await service.site(ctx);
		return { items: await dealRows(s, await s.data(), limitOf(ctx.query.limit, 10, 20)) };
	};

	/**
	 * What order lookups add: each order's tracking page from today's couriers and its dispatch video (E28).
	 * @param {Site} s
	 */
	const orderExtras = async (s) => {
		const couriers = s.has('checkout') ? await s.list('couriers') : [];
		return async (/** @type {OrderRecord} */ order) => ({
			trackingUrl: shipmentLink(couriers, order.shipment),
			video: await media.dispatchVideo(s, order),
		});
	};

	/** @param {any} ctx */
	const myOrders = async (ctx) => {
		const s = await service.site(ctx);
		const shopper = await service.requireShopper(s);
		const data = await s.data();
		const [orders, flow, loyaltyPoints, { money }, extras] = await Promise.all([
			ordersOf(data, shopper.id, limitOf(ctx.query.limit, 5, 10)),
			flowOf(s),
			pointsOf(s, data, shopper.id),
			s.format(),
			orderExtras(s),
		]);
		return {
			items: await Promise.all(orders.map(async (order) => orderSummary(order, flow, money, await extras(order)))),
			loyaltyPoints: loyaltyPoints ?? 0,
			name: shopper.name,
		};
	};

	/**
	 * The shopper's city: their default address's in Accounts, else the city of their last delivered-to order.
	 * @param {WebsiteData} data @param {string} userId @param {{ city: string } | null} profile
	 */
	const cityOf = async (data, userId, profile) => {
		if (profile?.city) return profile.city;
		const customer = await data
			.collection(COLLECTIONS.customers)
			.findOne({ websiteId: data.websiteId, userId }, { projection: { _id: 0, city: 1 } });
		if (typeof customer?.city === 'string' && customer.city) return customer.city;
		const last = await data
			.collection(COLLECTIONS.orders)
			.find(
				{ websiteId: data.websiteId, 'customer.userId': userId, 'address.city': { $nin: [null, ''] } },
				{ projection: { _id: 0, 'address.city': 1 } },
			)
			.sort({ placedAt: -1 })
			.limit(1)
			.toArray();
		return String(last[0]?.address?.city ?? '');
	};

	/** @param {any} ctx */
	const myAccount = async (ctx) => {
		const s = await service.site(ctx);
		const shopper = await service.requireShopper(s);
		const data = await s.data();
		const [points, profile] = await Promise.all([pointsOf(s, data, shopper.id), service.accountProfile(s)]);
		return {
			name: shopper.name,
			firstName: firstNameOf(shopper.name),
			loyaltyPoints: points ?? 0,
			city: await cityOf(data, shopper.id, profile),
			area: profile?.area ?? '',
		};
	};

	/** @param {any} ctx */
	const myShipments = async (ctx) => {
		const s = await service.site(ctx);
		const shopper = await service.requireShopper(s);
		const data = await s.data();
		const [orders, flow, extras] = await Promise.all([
			ordersOf(data, shopper.id, limitOf(ctx.query.limit, 5, 10), true),
			flowOf(s),
			orderExtras(s),
		]);
		const found = await Promise.all(orders.map(async (order) => shipmentSummary(order, flow, await extras(order))));
		return { items: found.filter((entry) => entry !== null) };
	};

	/**
	 * GET /v1/chat/context?productId=: the live store context of Chat's AI replies (E37, C1): the policies, the 10
	 * newest products with their price per grade, the deals table, the product named (id or slug) and, with a forwarded
	 * sign-in, the visitor's first name, city and points; `text` (at most 6,000 characters) holds all of it for the AI's
	 * instructions. Each part is there only while its feature is on.
	 * @param {any} ctx
	 */
	const context = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const hidden = visibleMatch(await hiddenFor(s));
		const ref = typeof ctx.query.productId === 'string' && ctx.query.productId ? ctx.query.productId : null;
		if (ref !== null && !/^[A-Za-z0-9_-]{1,120}$/.test(ref))
			throw service.invalid('productId', 'productId is a product id or slug.');
		const [business, rules, filled, newest, dealList, viewed, shopper] = await Promise.all([
			s.business(),
			cardRules(s),
			s.has('checkout') ? policiesOf(s) : Promise.resolve(null),
			data
				.collection(COLLECTIONS.products)
				.find({ websiteId: data.websiteId, status: 'active', ...hidden }, { projection: CARD_FIELDS })
				.sort({ publishedAt: -1, id: -1 })
				.limit(CONTEXT_PRODUCTS)
				.toArray(),
			s.has('deals') ? dealRows(s, data, CONTEXT_DEALS) : Promise.resolve([]),
			ref === null ? Promise.resolve(null) : shownProduct(s, data, ref).catch(() => null),
			service.shopper(s),
		]);
		const product = viewed ? await detailsOf(s, data, viewed) : null;
		const products = await Promise.all(
			/** @type {ProductRecord[]} */ (newest).map(async (item) => ({
				id: item.id,
				name: item.name,
				url: await media.productUrl(s, item),
				inStock: item.inStock,
				prices: gradePrices(item).map((entry) => ({
					grade: entry.grade ? (rules.labels(item).get(entry.grade) ?? entry.grade) : null,
					price: entry.price,
					priceText: rules.money(entry.price, s.currency),
					inStock: entry.inStock,
				})),
			})),
		);
		const policies = filled
			? Object.entries(filled.policies).map(([key, value]) => ({
					key,
					text: filled.format === 'html' ? htmlToText(String(value)) : String(value),
				}))
			: [];
		/** @type {{ firstName: string, city: string, points: number | null } | null} */
		let visitor = null;
		if (shopper) {
			const [points, profile] = await Promise.all([pointsOf(s, data, shopper.id), service.accountProfile(s)]);
			visitor = { firstName: firstNameOf(shopper.name), city: await cityOf(data, shopper.id, profile), points };
		}
		return {
			text: contextText({ business: business.name, policies, products, deals: dealList, product, visitor }),
			business: business.name,
			currency: s.currency,
			policies,
			products,
			deals: dealList,
			product,
			visitor,
		};
	};

	/**
	 * A customer's latest orders and points (the Accounts Orders tab, Chat's context panel): by Accounts user id, or by
	 * customer id for members and guests alike (K-6).
	 * @param {any} ctx
	 */
	const customerOrders = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const ref = String(ctx.params.userId);
		const record = isCustomerId(ref)
			? await data
					.collection(COLLECTIONS.customers)
					.findOne({ websiteId: data.websiteId, id: ref }, { projection: { _id: 0 } })
			: null;
		const owner = record ? customerOwner(record) : { userId: ref };
		const [orders, flow, loyaltyPoints, { money }] = await Promise.all([
			ordersOf(data, owner, limitOf(ctx.query.limit, 10, 50)),
			flowOf(s),
			pointsOf(s, data, owner),
			s.format(),
		]);
		return {
			items: orders.map((order) => ({
				id: order.id,
				number: order.number,
				status: order.status,
				statusLabel: statusLabel(flow, order.status),
				total: order.totals.total,
				totalText: money(order.totals.total, order.totals.currency),
				currency: order.totals.currency,
				createdAt: new Date(order.placedAt).toISOString(),
			})),
			loyaltyPoints: loyaltyPoints ?? 0,
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
				path: '/v1/chat/context',
				auth: 'server',
				feature: 'catalog',
				rateLimit: SERVER_RATE,
				handler: context,
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
