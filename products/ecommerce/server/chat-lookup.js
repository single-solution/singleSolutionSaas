/**
 * The lookups other products call with the pasted Ecommerce server token: Chat's shop tools (PLAN 0.8.3 Shop tools;
 * exactly the endpoints of `products/chat/core/shop.js`) and the customer orders lookup Accounts' Orders tab and
 * Chat's context panel use. All read-only with small answers. The `me` lookups take the visitor's Accounts sign-in
 * forwarded in `SS-Sign-In`, verify it here and answer only that user's data — never street addresses or phone
 * numbers; any query value naming another user is ignored. Every price and total comes with its text (`priceText`,
 * `totalText` …) by the website's Format (PLAN 0.8.10 K7), and products are priced as shoppers see them: each variant at
 * its shown price (`server/shown-prices.js`, SEO audit G4), with the price struck through above it and the deal in it.
 * E37 adds search filters, warranties, quotes per variant and payment method with fees and delivery, deal display
 * fields, fuller orders and accounts, and the live store context (`GET /v1/chat/context`) Chat's AI replies add (C1).
 * @module
 */
import { defineRoute, problem } from '@ss/app-kit';
import { categoriesOf, locationsOf, productTypes } from '../adapters/catalog-store.js';
import { ADDRESS_LIMITS } from '../core/address.js';
import { ownerOrders } from '../adapters/fulfilment-store.js';
import { loyaltyAccount } from '../adapters/ledger.js';
import { dealsLiveNow, loadOffers } from '../adapters/promotions-store.js';
import { htmlToText } from '../core/catalog-content.js';
import { topField } from '../core/catalog-query.js';
import { lineageOf } from '../core/catalog-taxonomy.js';
import { stockLeftOf } from '../core/catalog-views.js';
import { CONTEXT_BASICS, CONTEXT_DEALS, CONTEXT_PRODUCTS, contextText, contextWordsOf } from '../core/chat-context.js';
import { paymentMethodsOn } from '../core/health.js';
import { isMethodKey } from '../core/payment-methods.js';
import { shipmentLink } from '../core/couriers.js';
import { byShowOrder } from '../core/deals.js';
import { gradesFor } from '../core/grades.js';
import {
	cardVariant,
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
import { MAX_QUANTITY, measureView, toThousandths } from '../core/measure.js';
import { COLLECTIONS } from '../core/model.js';
import { customerOwner, isCustomerId } from '../core/orders.js';
import { isLoyaltyMember } from '../core/loyalty.js';
import { listShown } from '../core/promotions.js';
import { windowDefaults } from '../core/returns.js';
import { createCatalogSearch } from './catalog-search.js';
import { hiddenFor, visible, visibleMatch } from './catalog-visibility.js';
import { createQuoting } from './checkout-quote.js';
import { policiesOf } from './policies.js';
import { SERVER_LIMITS } from './service.js';
import { activeProduct, brandNames } from './seo-reads.js';
import { createShownPrices } from './shown-prices.js';

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
 * Read a Chat quote's query (E37): `variantId`, `quantity` (whole pieces up to the most of one item; for an item sold in
 * a unit of its own a number of its units with at most three decimals, such as `2.5`, converted exactly to thousandths;
 * the item's least when left out, C3), `paymentMethod` and where it goes (`country`, `region`, `city`, `area`,
 * `postalCode`; dynamic model §5). Steps, least and most are checked as the cart checks them (the quote's problems).
 * @param {Record<string, unknown>} query
 * @param {import('../core/measure.js').Measure | null} measure the item's measure (none: pieces)
 * @param {number} least the least pieces of an item counted in pieces (its type's quantity rule)
 * @returns {{ variantId: string | null, quantity: number, paymentMethod: import('../core/model.js').PaymentMethod | null,
 *   place: Record<'country' | 'region' | 'city' | 'area' | 'postalCode', string> }}
 */
const quoteQuery = (query, measure, least = 1) => {
	const variantId = query.variantId === undefined || query.variantId === '' ? null : query.variantId;
	if (variantId !== null && (typeof variantId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(variantId)))
		throw invalidQuery('variantId', 'variantId is a variant id.');
	const given = query.quantity === undefined || query.quantity === '' ? null : query.quantity;
	/** @type {number} */
	let quantity;
	if (measure) {
		const read = given === null ? measure.min : toThousandths(given);
		if (read === null)
			throw invalidQuery('quantity', `quantity is a number of ${measure.unit} with at most three decimals, such as 2.5.`);
		quantity = read;
	} else {
		quantity = given === null ? least : Number(given);
		if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY || !/^\d+$/.test(String(given ?? least)))
			throw invalidQuery('quantity', `quantity is a whole number from 1 to ${MAX_QUANTITY}.`);
	}
	const method = query.paymentMethod === undefined || query.paymentMethod === '' ? null : query.paymentMethod;
	if (method !== null && !isMethodKey(method)) throw invalidQuery('paymentMethod', 'paymentMethod is a payment method key.');
	/** @type {Record<'country' | 'region' | 'city' | 'area' | 'postalCode', string>} */
	const place = { country: '', region: '', city: '', area: '', postalCode: '' };
	for (const field of /** @type {Array<keyof typeof place>} */ (Object.keys(place))) {
		const value = typeof query[field] === 'string' ? String(query[field]).trim() : '';
		if (value.length > ADDRESS_LIMITS[field])
			throw invalidQuery(field, `${field} is at most ${ADDRESS_LIMITS[field]} characters.`);
		place[field] = value;
	}
	return {
		variantId: /** @type {string | null} */ (variantId),
		quantity,
		paymentMethod: /** @type {import('../core/model.js').PaymentMethod | null} */ (method),
		place,
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

/** What a product card reads of a product (its specs for the deal conditions of its shown price). */
const CARD_FIELDS = Object.freeze({
	_id: 0,
	id: 1,
	slug: 1,
	name: 1,
	kind: 1,
	typeKey: 1,
	media: 1,
	variants: 1,
	trackStock: 1,
	price: 1,
	inStock: 1,
	categoryIds: 1,
	brandId: 1,
	specs: 1,
	warrantyTime: 1,
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
	const shownPrices = createShownPrices(service);

	/**
	 * Each product's shown prices (G4), the website's live deals read once: `(item) => (variant) => ShownPrice`.
	 * @param {Site} s @param {WebsiteData} data
	 */
	const pricesFor = async (s, data) => {
		const prices = await shownPrices(s, data);
		return async (/** @type {ProductRecord} */ item) => prices.of(item);
	};

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
			/** @param {ProductRecord} item @param {import('../core/measure.js').Measure | null} [measure] */
			stockLeft:
				(item, measure = null) =>
				(/** @type {import('../core/model.js').VariantRecord} */ variant) =>
					stockLeftOf(variant, item.trackStock, stock, measure),
			/** @param {ProductRecord} item */
			warranty: (item) => (/** @type {import('../core/model.js').VariantRecord} */ variant) =>
				warrantyOf(item, variant, { grades: gradesOf(item), fallback: windowDefaults(returns).warrantyTime }),
		};
	};

	/**
	 * How the products given are measured (their type's `measure`, while Sell in any unit is on), by id; none: pieces.
	 * @param {Site} s @param {WebsiteData} data @param {ProductRecord[]} items
	 * @returns {Promise<Map<string, import('../core/measure.js').Measure>>}
	 */
	const measuresOf = async (s, data, items) => {
		const types = s.has('measured_sales') ? await s.list('item_types') : [];
		if (!types.some((/** @type {any} */ type) => type.elements.measure)) return new Map();
		const typed = await productTypes(data, items, types);
		return new Map(
			[...typed].flatMap(([id, type]) => (type.elements.measure ? [/** @type {const} */ ([id, type.elements.measure])] : [])),
		);
	};

	/**
	 * Product cards of products at their shown prices, each with the variant Chat's filters matched (when given).
	 * @param {Site} s
	 * @param {WebsiteData} data
	 * @param {ProductRecord[]} items
	 * @param {import('../core/lookup.js').ChatFilters | null} [filters]
	 */
	const cards = async (s, data, items, filters = null) => {
		const [rules, shownOf, measures] = await Promise.all([cardRules(s), pricesFor(s, data), measuresOf(s, data, items)]);
		return Promise.all(
			items.map(async (item) => {
				const shown = await shownOf(item);
				const measure = measures.get(item.id) ?? null;
				return productCard(
					item,
					{
						currency: s.currency,
						image: await media.mediaUrl(s, item.media?.[0]?.key),
						url: await media.productUrl(s, item),
						money: rules.money,
						shown,
						grades: rules.labels(item),
						stockLeft: rules.stockLeft(item, measure),
						measure,
					},
					filters ? matchingVariant(item, filters, shown) : null,
				);
			}),
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
	 * The signed-in shopper's own points: null while loyalty is off, and for a shopper who is not a loyalty member
	 * (the loyalty setting `memberFlag`, E47: only members see points).
	 * @param {Site} s @param {WebsiteData} data @param {string} userId
	 */
	const shopperPointsOf = async (s, data, userId) => {
		if (!s.has('loyalty')) return null;
		const record = await data
			.collection(COLLECTIONS.customers)
			.findOne({ websiteId: data.websiteId, userId }, { projection: { _id: 0, loyaltyMember: 1 } });
		return isLoyaltyMember(await s.values('loyalty'), record) ? pointsOf(s, data, userId) : null;
	};

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
			if (found.ok) return { items: await cards(s, data, /** @type {ProductRecord[]} */ (found.items), filters) };
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
				.sort({ inStock: -1, [topField((await s.values('catalog')).topBasis)]: -1, id: 1 })
				.limit(filters.limit)
				.toArray()
		);
		return { items: await cards(s, data, found, filters) };
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
				.sort(
					kind === 'new'
						? { publishedAt: -1, id: -1 }
						: { [topField((await s.values('catalog')).topBasis)]: -1, publishedAt: -1, id: -1 },
				)
				.limit(limitOf(ctx.query.limit, 5, 12))
				.toArray()
		);
		return { items: await cards(s, data, found) };
	};

	/**
	 * A product's details: variants with grade, shown price, stock left (E9) and warranty (E12).
	 * @param {Site} s @param {WebsiteData} data @param {ProductRecord} item
	 * @param {import('../core/lookup.js').Shown} shown its variants' shown prices
	 */
	const detailsOf = async (s, data, item, shown) => {
		const specIds = Object.keys(item.specs ?? {});
		const [brands, attributes, rules, measures] = await Promise.all([
			brandNames(data, [item.brandId]),
			specIds.length === 0
				? []
				: data
						.collection(COLLECTIONS.attributes)
						.find(
							// only the fields the merchant shows in Chat (staff-only values never leave staff answers)
							{ websiteId: data.websiteId, id: { $in: specIds }, 'show.chat': true },
							{ projection: { _id: 0, id: 1, name: 1, unit: 1 } },
						)
						.toArray(),
			cardRules(s),
			measuresOf(s, data, [item]),
		]);
		const measure = measures.get(item.id) ?? null;
		return productDetails(item, {
			currency: s.currency,
			image: await media.mediaUrl(s, item.media?.[0]?.key),
			url: await media.productUrl(s, item),
			money: rules.money,
			shown,
			brand: item.brandId ? (brands.get(item.brandId) ?? null) : null,
			attributes: new Map(attributes.map((row) => [String(row.id), { name: String(row.name), unit: String(row.unit) }])),
			grades: rules.labels(item),
			stockLeft: rules.stockLeft(item, measure),
			measure,
			warrantyTime: rules.warranty(item),
		});
	};

	/** @param {any} ctx */
	const details = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const item = await shownProduct(s, data, ctx.params.id);
		return detailsOf(s, data, item, await (await pricesFor(s, data))(item));
	};

	/**
	 * GET /v1/chat/products/:id/quote: one variant (`variantId`, else the card variant) times `quantity` (pieces, or a
	 * decimal number of the units of an item sold in a unit of its own; its steps, least and most in `limits`, C3), priced exactly as the cart prices it for the
	 * payment method asked (deals, fees, delivery to the place asked — `country`, `region`, `city`, `area`, `postalCode`
	 * — with its zone's free-delivery threshold and taxes; a forwarded sign-in adds role pricing) (E37), with the
	 * variant's own "was" price struck through on the product page. A measured item's prices and savings are per unit,
	 * its `quantity` thousandths of the unit (`measure.quantityText` in units).
	 * @param {any} ctx
	 */
	const quote = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const item = await shownProduct(s, data, ctx.params.id);
		const measure = (await measuresOf(s, data, [item])).get(item.id) ?? null;
		// an item counted in pieces starts at its type's least (C3)
		const rule = measure
			? null
			: (await productTypes(data, [item], await s.list('item_types'))).get(item.id)?.elements.quantity;
		const { variantId, quantity, paymentMethod, place } = quoteQuery(ctx.query, measure, rule?.min ?? 1);
		const variant = variantId
			? item.variants.find((candidate) => candidate.id === variantId && candidate.active)
			: cardVariant(item, await (await pricesFor(s, data))(item));
		if (!variant) throw problem('not_found', 'There is no such variant.');
		const shopper = await service.shopper(s);
		// a method paid at pickup is quoted for a picked-up order
		const asked = paymentMethod ? (await service.methods.methodsOf(s)).find((entry) => entry.key === paymentMethod) : null;
		const q = await quoting.quote(
			s,
			{
				lines: [{ productId: item.id, variantId: variant.id, quantity, slot: null }],
				coupon: '',
				points: 0,
				delivery: { method: asked?.kind === 'at_pickup' ? 'pickup' : null, rate: null, ...place, locationId: null },
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
		const was = listShown(variant).was;
		const dealOff = Math.min(priced?.gross ?? 0, priced?.promotions ?? 0);
		// what the deals take off one piece, or one unit of a measured item
		const savings = measure ? Math.floor((dealOff * 1000) / quantity) : Math.floor(dealOff / quantity);
		const offers = q.promotions?.applied.filter((entry) => entry.kind === 'deal') ?? [];
		const deals = s.has('deals') ? (await loadOffers(data, { now: service.now(), deals: true })).deals : [];
		const { date } = await s.format();
		const words = contextWordsOf(await s.texts());
		const totals = /** @type {Record<string, number>} */ (/** @type {unknown} */ (q.totals));
		const delivery = q.delivery.method === 'none' ? null : q.delivery;
		const freeOver = delivery?.freeOver ?? 0;
		return {
			productId: item.id,
			variantId: variant.id,
			quantity,
			measure: measureView(quantity, measure),
			// the quantities the shopper may buy: pieces, or thousandths of the unit (C3)
			limits: line?.limits ?? null,
			price: unitPrice,
			priceText: text(unitPrice),
			compareAtPrice: was,
			compareAtPriceText: was === null ? null : text(was),
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
						? chatDeal(deal, { currency: s.currency, money, date: (at) => date(at, 'date'), words })
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
						rateName: delivery.rateName,
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
		const words = contextWordsOf(await s.texts());
		return Promise.all(
			[...live]
				.sort(byShowOrder)
				.slice(0, limit)
				.map(async (/** @type {DealRecord} */ deal) =>
					chatDeal(deal, {
						currency: s.currency,
						words,
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
			shopperPointsOf(s, data, shopper.id),
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
		const [points, profile] = await Promise.all([shopperPointsOf(s, data, shopper.id), service.accountProfile(s)]);
		return {
			name: shopper.name,
			firstName: firstNameOf(shopper.name),
			loyaltyPoints: points ?? 0,
			city: await cityOf(data, shopper.id, profile),
			area: profile?.area ?? '',
			region: profile?.region ?? '',
			country: profile?.country ?? '',
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
	 * The shop basics of the context (parity P5-17): the payment methods offered (in the merchant's order, as a cart
	 * with delivery lists them) with the merchant's notes, the cash handling fee, each delivery zone's rates (with their
	 * free-delivery amounts and days, E5), the pickup points, the loyalty earn rate, the top categories
	 * shoppers see, the return window and the warranty. Each part is there only while its feature is on.
	 * @param {Site} s @param {WebsiteData} data
	 * @returns {Promise<import('../core/chat-context.js').ShopBasics>}
	 */
	const basicsOf = async (s, data) => {
		const checkoutOn = s.has('checkout');
		const zonesOn = checkoutOn && s.has('delivery_zones');
		const [listed, zones, zoneList, locations, loyalty, returns, categories, payments, { money }] = await Promise.all([
			checkoutOn ? service.methods.methodsOf(s) : Promise.resolve([]),
			zonesOn ? s.values('delivery_zones') : Promise.resolve(null),
			zonesOn ? s.list('delivery_zones') : Promise.resolve([]),
			zonesOn && s.has('multi_location') ? locationsOf(data) : Promise.resolve([]),
			s.has('loyalty') ? s.values('loyalty') : Promise.resolve(null),
			s.has('returns') ? s.values('returns') : Promise.resolve(null),
			data
				.collection(COLLECTIONS.categories)
				.find(
					{ websiteId: data.websiteId, parentId: null, status: { $ne: 'hidden' } },
					{ projection: { _id: 0, name: 1 }, sort: { sort: 1, name: 1 }, limit: CONTEXT_BASICS },
				)
				.toArray(),
			checkoutOn ? product.connections.value(s.websiteId, 'payments') : Promise.resolve(null),
			s.format(),
		]);
		/** @param {number} amount */
		const text = (amount) => money(amount, s.currency);
		// one pickup point of the settings while stock has no locations, else the stock locations that take pickups (E22)
		// pickup is a kind of rate (E5): the pickup places count while a zone has a pickup rate
		const pickupRates = /** @type {import('../core/delivery.js').Zone[]} */ (zoneList).some((zone) =>
			zone.rates.some((rate) => rate.kind === 'pickup'),
		);
		const pickup = !pickupRates
			? []
			: s.has('multi_location')
				? /** @type {import('../core/model.js').LocationRecord[]} */ (locations)
						.filter((location) => location.pickup)
						.sort((a, b) => a.sort - b.sort)
						.map((location) => ({ name: location.name, address: '', hours: '' }))
				: zones?.pickupEnabled === true
					? [
							{
								name: String(zones.pickupName ?? ''),
								address: String(zones.pickupAddress ?? ''),
								hours: String(zones.pickupHours ?? ''),
							},
						]
					: [];
		// the methods the shop can take now, by the merchant's names, notes and fees
		const on = new Set(paymentMethodsOn({ methods: listed, paymentsConnected: payments !== null, pickup: pickup.length > 0 }));
		const methods = listed
			.filter((method) => on.has(method.key))
			.map((method) => ({ method: method.key, name: method.name, note: method.note, feePercent: method.feePercent }));
		return {
			payments: methods,
			zones: /** @type {import('../core/delivery.js').Zone[]} */ (zoneList).slice(0, CONTEXT_BASICS).map((zone) => ({
				name: zone.name,
				rates: zone.rates.map((rate) => ({
					name: rate.name,
					kind: rate.kind,
					fee: rate.price,
					feeText: text(rate.price),
					freeOver: rate.freeOver,
					freeOverText: text(rate.freeOver),
					minDays: rate.minDays,
					maxDays: rate.maxDays,
				})),
			})),
			pickup,
			earnPercent: loyalty ? Number(loyalty.earnPercent) || 0 : null,
			categories: categories.map((category) => String(category.name)),
			// as the merchant typed them (E14)
			returnTime: returns ? windowDefaults(returns).returnTime : null,
			warrantyTime: returns ? windowDefaults(returns).warrantyTime : null,
		};
	};

	/**
	 * GET /v1/chat/context?productId=: the live store context of Chat's AI replies (E37, C1): the shop basics, the policies, the 10
	 * newest products with their shown price per grade, the deals table, the product named (id or slug) and, with a forwarded
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
		const [business, rules, shownOf, filled, newest, dealList, viewed, shopper, basics] = await Promise.all([
			s.business(),
			cardRules(s),
			pricesFor(s, data),
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
			basicsOf(s, data),
		]);
		const product = viewed ? await detailsOf(s, data, viewed, await shownOf(viewed)) : null;
		/** @param {number} amount */
		const text = (amount) => rules.money(amount, s.currency);
		const products = await Promise.all(
			/** @type {ProductRecord[]} */ (newest).map(async (item) => ({
				id: item.id,
				name: item.name,
				url: await media.productUrl(s, item),
				inStock: item.inStock,
				prices: gradePrices(item, await shownOf(item)).map((entry) => ({
					grade: entry.grade ? (rules.labels(item).get(entry.grade) ?? entry.grade) : null,
					price: entry.price,
					priceText: text(entry.price),
					compareAtPrice: entry.compareAtPrice,
					compareAtPriceText: entry.compareAtPrice === null ? null : text(entry.compareAtPrice),
					inStock: entry.inStock,
				})),
			})),
		);
		// prices per unit of the products sold in a unit of their own
		const units = new Map(
			[...(await measuresOf(s, data, /** @type {ProductRecord[]} */ (newest)))].map(([id, measure]) => [id, measure.unit]),
		);
		const policies = filled
			? filled.policies.map((policy) => ({
					key: policy.key,
					title: policy.title,
					text: filled.format === 'html' ? htmlToText(policy.text) : policy.text,
				}))
			: [];
		/** @type {{ firstName: string, city: string, points: number | null } | null} */
		let visitor = null;
		if (shopper) {
			const [points, profile] = await Promise.all([shopperPointsOf(s, data, shopper.id), service.accountProfile(s)]);
			visitor = { firstName: firstNameOf(shopper.name), city: await cityOf(data, shopper.id, profile), points };
		}
		return {
			text: contextText({
				business: business.name,
				basics,
				policies,
				products,
				deals: dealList,
				product,
				visitor,
				units,
				words: contextWordsOf(await s.texts()),
			}),
			business: business.name,
			currency: s.currency,
			basics,
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
