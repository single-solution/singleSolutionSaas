/**
 * The Chat lookups' answers (PLAN 0.8.3 Shop tools; the endpoints in `products/chat/core/shop.js`): small, read-only
 * views of products, deals, and one signed-in shopper's orders, account and shipments. Answers never carry street
 * addresses or phone numbers. Every amount (integer minor units) comes with its text (`priceText`, `totalText` …) by
 * the website's Format (PLAN 0.8.10 K7). Pure functions, no I/O.
 * @module
 */
import { statusOf } from './flow.js';
import { activeVariants, variantInStock } from './seo.js';

/** @typedef {import('./model.js').ProductRecord} ProductRecord */
/** @typedef {import('./model.js').VariantRecord} VariantRecord */
/** @typedef {import('./model.js').OrderRecord} OrderRecord */
/** @typedef {import('./model.js').OrderFlow} OrderFlow */
/** An amount as text, by the website's Format. @typedef {(amount: number, currency: string) => string} Money */

/** A product description in a details answer is cut to this many characters. */
const DETAILS_DESCRIPTION_LENGTH = 1500;
/** A details answer lists at most this many variants. */
const DETAILS_VARIANTS = 20;
/** A search uses at most this many words, each at most 40 characters. */
const MAX_TERMS = 6;
/** The longest search text. */
const MAX_QUERY = 120;
/** Chat product searches answer at most this many products (E37). */
export const MAX_CHAT_RESULTS = 12;
/** A Chat quote prices at most this many units (E37). */
export const MAX_QUOTE_QUANTITY = 5;
/** Most grades a `grade` filter takes. */
const MAX_GRADE_FILTER = 10;
/** Grade keys (as the `grades` list keeps them). */
const GRADE_KEY = /^[a-z][a-z0-9_-]{0,39}$/;
/** Category ids or slugs. */
const REF = /^[A-Za-z0-9_-]{1,120}$/;
/** The largest price a filter takes, in minor units. */
const MAX_PRICE = 1_000_000_000_000;

/**
 * A `limit` query value as a whole number from 1 to `max` (anything else: the default).
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 */
export const limitOf = (value, fallback, max) => {
	const n = typeof value === 'string' && /^\d{1,4}$/.test(value) ? Number(value) : Number.NaN;
	return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
};

/**
 * A whole amount of minor units from a query value, null when missing, or undefined when it is not one.
 * @param {unknown} value
 * @returns {number | null | undefined}
 */
const priceOf = (value) => {
	if (value === undefined || value === '') return null;
	if (typeof value !== 'string' || !/^\d{1,13}$/.test(value)) return undefined;
	const n = Number(value);
	return n <= MAX_PRICE ? n : undefined;
};

/**
 * What Chat's product search filters on (E37): a category (id or slug, with the categories below it), grades, a price
 * range on one variant (minor units), only items in stock, and how many to answer.
 * @typedef {{ category: string | null, grades: string[], minPrice: number | null, maxPrice: number | null,
 *   inStock: boolean, limit: number }} ChatFilters
 */

/**
 * Read Chat's product search filters from the query.
 * @param {Record<string, unknown>} query
 * @returns {{ ok: true, value: ChatFilters } | { ok: false, field: string, message: string }}
 */
export const chatFilters = (query) => {
	const category = query.category === undefined || query.category === '' ? null : query.category;
	if (category !== null && (typeof category !== 'string' || !REF.test(category)))
		return { ok: false, field: 'category', message: 'category is a category id or slug.' };
	const grades =
		typeof query.grade === 'string' && query.grade !== ''
			? [...new Set(query.grade.split(',').map((key) => key.trim().toLowerCase()))]
			: [];
	if (query.grade !== undefined && typeof query.grade !== 'string')
		return { ok: false, field: 'grade', message: 'grade is a grade key.' };
	if (grades.length > MAX_GRADE_FILTER || grades.some((key) => !GRADE_KEY.test(key)))
		return { ok: false, field: 'grade', message: `grade is a grade key, or up to ${MAX_GRADE_FILTER} separated by commas.` };
	const minPrice = priceOf(query.minPrice);
	if (minPrice === undefined) return { ok: false, field: 'minPrice', message: 'minPrice is a whole amount in minor units.' };
	const maxPrice = priceOf(query.maxPrice);
	if (maxPrice === undefined) return { ok: false, field: 'maxPrice', message: 'maxPrice is a whole amount in minor units.' };
	if (minPrice !== null && maxPrice !== null && minPrice > maxPrice)
		return { ok: false, field: 'maxPrice', message: 'maxPrice is at least minPrice.' };
	const inStock = query.inStock === '1' || query.inStock === 'true';
	if (query.inStock !== undefined && !['0', '1', 'true', 'false', ''].includes(String(query.inStock)))
		return { ok: false, field: 'inStock', message: 'inStock is 1 or 0.' };
	return {
		ok: true,
		value: { category, grades, minPrice, maxPrice, inStock, limit: limitOf(query.limit, 5, MAX_CHAT_RESULTS) },
	};
};

/**
 * Whether Chat's filters narrow the search (a search with filters needs no words).
 * @param {ChatFilters} filters
 */
export const filtersGiven = (filters) =>
	filters.category !== null ||
	filters.grades.length > 0 ||
	filters.minPrice !== null ||
	filters.maxPrice !== null ||
	filters.inStock;

/**
 * The variant conditions of Chat's filters: one active variant must match the price range, the grade and stock
 * together (as shop listings, E8). Null when no variant condition is asked.
 * @param {ChatFilters} filters
 * @returns {Record<string, unknown> | null}
 */
export const variantFilter = (filters) => {
	/** @type {Record<string, unknown>} */
	const variant = { active: true };
	if (filters.minPrice !== null || filters.maxPrice !== null)
		variant.price = {
			...(filters.minPrice !== null ? { $gte: filters.minPrice } : {}),
			...(filters.maxPrice !== null ? { $lte: filters.maxPrice } : {}),
		};
	if (filters.grades.length > 0) variant.grade = { $in: filters.grades };
	if (filters.inStock) {
		const selling = { ...variant, soldOut: { $ne: true } };
		return {
			$or: [
				{ trackStock: false, variants: { $elemMatch: selling } },
				{ variants: { $elemMatch: { ...selling, stock: { $gt: 0 } } } },
			],
		};
	}
	return Object.keys(variant).length > 1 ? { variants: { $elemMatch: variant } } : null;
};

/**
 * The cheapest active variant of a product that matches Chat's filters (in stock first), or null.
 * @param {ProductRecord} product
 * @param {Pick<ChatFilters, 'grades' | 'minPrice' | 'maxPrice' | 'inStock'>} filters
 * @returns {VariantRecord | null}
 */
export const matchingVariant = (product, filters) => {
	const matching = activeVariants(product).filter(
		(variant) =>
			(filters.minPrice === null || variant.price >= filters.minPrice) &&
			(filters.maxPrice === null || variant.price <= filters.maxPrice) &&
			(filters.grades.length === 0 || (variant.grade !== null && filters.grades.includes(variant.grade))) &&
			(!filters.inStock || variantInStock(product, variant)),
	);
	const cheapest = (/** @type {VariantRecord[]} */ list) =>
		list.reduce(
			(/** @type {VariantRecord | null} */ best, variant) => (!best || variant.price < best.price ? variant : best),
			null,
		);
	return cheapest(matching.filter((variant) => variantInStock(product, variant))) ?? cheapest(matching);
};

/**
 * Escape a text for a regular expression.
 * @param {string} text
 */
export const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The words of a search text, as escaped regular expression sources (at most a few; empty when there is nothing to
 * search for).
 * @param {unknown} q
 * @returns {string[]}
 */
export const searchTerms = (q) =>
	(typeof q === 'string' ? q.slice(0, MAX_QUERY) : '')
		.toLowerCase()
		.split(/[\s,;/]+/)
		.map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').slice(0, 40))
		.filter((word) => word.length > 0)
		.slice(0, MAX_TERMS)
		.map(escapeRegex);

/**
 * The variant a product card adds to the cart: the cheapest active one in stock, else the cheapest active one.
 * @param {ProductRecord} product
 * @returns {VariantRecord | null}
 */
export const cardVariant = (product) => {
	const variants = activeVariants(product);
	const cheapest = (/** @type {VariantRecord[]} */ list) =>
		list.reduce(
			(/** @type {VariantRecord | null} */ best, variant) => (!best || variant.price < best.price ? variant : best),
			null,
		);
	return cheapest(variants.filter((variant) => variantInStock(product, variant))) ?? cheapest(variants);
};

/**
 * Lowest and highest active variant prices.
 * @param {ProductRecord} product
 */
export const priceRange = (product) => {
	const prices = activeVariants(product).map((variant) => variant.price);
	return prices.length > 0 ? { min: Math.min(...prices), max: Math.max(...prices) } : { min: product.price, max: product.price };
};

/**
 * What a Chat card or details answer needs besides the product.
 * @typedef {object} CardContext
 * @property {string} currency
 * @property {string | null} image the main image's address
 * @property {string} url the product's page
 * @property {Money} money
 * @property {Map<string, string>} [grades] grade key → label
 * @property {(variant: VariantRecord) => number | null} [stockLeft] units shoppers are told are left (E9)
 */

/**
 * A product as a Chat card: the price of its card variant (the cheapest active one in stock, or the one the filters
 * chose), the highest active price, and that variant's grade and stock left.
 * @param {ProductRecord} product
 * @param {CardContext} context
 * @param {VariantRecord | null} [chosen] the variant Chat's filters matched
 */
export const productCard = (product, context, chosen = null) => {
	const { currency, image, url, money } = context;
	const variant = chosen ?? cardVariant(product);
	const price = variant ? variant.price : product.price;
	const range = priceRange(product);
	return {
		id: product.id,
		name: product.name,
		price,
		priceText: money(price, currency),
		priceMax: range.max,
		priceMaxText: money(range.max, currency),
		currency,
		image: image && /^https:\/\//.test(image) ? image : null,
		url,
		inStock: product.inStock,
		variantId: variant ? variant.id : null,
		grade: variant?.grade ? (context.grades?.get(variant.grade) ?? variant.grade) : null,
		stockLeft: variant ? (context.stockLeft?.(variant) ?? null) : null,
	};
};

/**
 * A product's details for Chat (`get_product_details`): every active variant (at most 20) with its grade, price, stock
 * left and warranty (E37).
 * @param {ProductRecord} product
 * @param {CardContext & { brand: string | null, attributes: Map<string, { name: string, unit: string }>,
 *   grades: Map<string, string>, warrantyDays?: (variant: VariantRecord) => number | null }} context
 *   `attributes`: attribute id → name and unit; `grades`: grade key → label; `warrantyDays`: the variant's warranty in
 *   days (E12)
 */
export const productDetails = (product, context) => {
	const description = String(product.description ?? '').trim();
	const range = priceRange(product);
	/** @param {number} amount */
	const text = (amount) => context.money(amount, context.currency);
	return {
		...productCard(product, context),
		summary: product.summary,
		description:
			description.length > DETAILS_DESCRIPTION_LENGTH
				? `${description.slice(0, DETAILS_DESCRIPTION_LENGTH - 1)}…`
				: description,
		brand: context.brand,
		options: product.options.map((option) => ({ name: option.name, values: [...option.values] })),
		priceRange: { ...range, minText: text(range.min), maxText: text(range.max) },
		specs: Object.entries(product.specs ?? {}).map(([id, value]) => {
			const attribute = context.attributes.get(id);
			return { name: attribute?.name ?? id, value, unit: attribute?.unit ?? '' };
		}),
		variants: activeVariants(product)
			.slice(0, DETAILS_VARIANTS)
			.map((variant) => ({
				id: variant.id,
				options: { ...variant.options },
				price: variant.price,
				priceText: text(variant.price),
				compareAtPrice: variant.compareAtPrice,
				compareAtPriceText: variant.compareAtPrice === null ? null : text(variant.compareAtPrice),
				grade: variant.grade ? (context.grades.get(variant.grade) ?? variant.grade) : null,
				gradeKey: variant.grade ?? null,
				inStock: variantInStock(product, variant),
				soldOut: variant.soldOut === true,
				stockLeft: context.stockLeft?.(variant) ?? null,
				warrantyDays: context.warrantyDays?.(variant) ?? null,
			})),
	};
};

/**
 * The warranty of a physical variant (E12): its own, else the product's, the grade's, then the `returns` setting;
 * null for digital goods and bookings, and when it comes to 0.
 * @param {ProductRecord} product
 * @param {VariantRecord} variant
 * @param {{ grades: ReadonlyMap<string, { warrantyDays: number | null }>, fallback: number }} rules
 * @returns {number | null}
 */
export const warrantyOf = (product, variant, { grades, fallback }) => {
	if (product.kind !== 'physical') return null;
	const days =
		variant.warrantyDays ??
		product.warrantyDays ??
		(variant.grade ? (grades.get(variant.grade)?.warrantyDays ?? null) : null) ??
		fallback;
	return days > 0 ? days : null;
};

/**
 * The lowest active price of a product per grade (in stock first), for the store context (E37): `[{ grade, price,
 * inStock }]` in the order the grades first appear; one entry with grade null for variants without a grade.
 * @param {ProductRecord} product
 * @returns {Array<{ grade: string | null, price: number, inStock: boolean }>}
 */
export const gradePrices = (product) => {
	/** @type {Map<string, { grade: string | null, price: number, inStock: boolean }>} */
	const out = new Map();
	for (const variant of activeVariants(product)) {
		const key = variant.grade ?? '';
		const inStock = variantInStock(product, variant);
		const found = out.get(key);
		if (!found || (inStock && !found.inStock) || (inStock === found.inStock && variant.price < found.price))
			out.set(key, { grade: variant.grade ?? null, price: variant.price, inStock });
	}
	return [...out.values()];
};

/**
 * Grade key → label, from the `grades` list (entries `{ key, label }`; others are skipped).
 * @param {unknown} list
 * @returns {Map<string, string>}
 */
export const gradeLabels = (list) =>
	new Map(
		(Array.isArray(list) ? list : [])
			.filter((grade) => grade && typeof grade.key === 'string')
			.map((grade) => [String(grade.key), typeof grade.label === 'string' && grade.label ? grade.label : String(grade.key)]),
	);

/**
 * The label of an order's status in the website's flow (the key when the flow no longer has it).
 * @param {OrderFlow} flow
 * @param {string} key
 */
export const statusLabel = (flow, key) => statusOf(flow, key)?.label ?? key;

/** Roles in which nothing is left to pay. */
const SETTLED_ROLES = Object.freeze(['cancelled', 'returned_to_origin', 'refunded', 'returned']);

/**
 * What an order lookup adds from outside the record: the tracking page (built from today's couriers, E28) and the
 * dispatch video's address.
 * @typedef {{ trackingUrl?: string, video?: { kind: 'file' | 'youtube' | 'url', url: string } | null }} OrderExtras
 */

/**
 * An order as Chat's `get_my_orders` sees it (E37): its status, totals, what is paid and due, its lines, and its
 * shipment with the tracking note, the expected date and the dispatch video. Never the address or phone.
 * @param {OrderRecord} order
 * @param {OrderFlow} flow
 * @param {Money} money
 * @param {OrderExtras} [extras]
 */
export const orderSummary = (order, flow, money, extras = {}) => {
	const currency = order.totals.currency;
	/** @param {number} amount */
	const text = (amount) => money(amount, currency);
	const paid = Math.max(0, Number(order.payment?.paid ?? 0) - Number(order.payment?.refunded ?? 0));
	const due = SETTLED_ROLES.includes(order.role) ? 0 : Math.max(0, order.totals.total - paid);
	const shipment = order.shipment ?? null;
	const expected = shipment?.estimatedDeliveryAt ? new Date(shipment.estimatedDeliveryAt) : null;
	return {
		id: order.id,
		number: order.number,
		status: statusLabel(flow, order.status),
		statusKey: order.status,
		total: order.totals.total,
		totalText: text(order.totals.total),
		currency,
		placedAt: new Date(order.placedAt).toISOString(),
		paymentMethod: order.payment?.method ?? null,
		paid,
		paidText: text(paid),
		balanceDue: due,
		balanceDueText: text(due),
		lines: (order.lines ?? []).map((line) => ({
			name: line.name,
			variantName: line.variantName,
			gradeLabel: line.gradeLabel,
			quantity: line.quantity,
			unitPrice: line.unitPrice,
			unitPriceText: text(line.unitPrice),
			total: line.total,
			totalText: text(line.total),
			warrantyDays: line.warrantyDays ?? null,
		})),
		courier: shipment?.courier ?? '',
		trackingNumber: shipment?.trackingNumber ?? '',
		trackingUrl: safeLink(extras.trackingUrl ?? shipment?.trackingUrl ?? ''),
		trackingNote: shipment?.trackingNote ?? '',
		expectedAt: expected && !Number.isNaN(expected.getTime()) ? expected.toISOString() : null,
		dispatchVideo: extras.video ?? null,
	};
};

/**
 * An http(s) address, else ''.
 * @param {unknown} url
 */
const safeLink = (url) => (typeof url === 'string' && /^https?:\/\//.test(url) ? url : '');

/**
 * An order's shipment as Chat's `track_shipment` sees it (null when it has none), with the tracking note and the
 * expected date (E37).
 * @param {OrderRecord} order
 * @param {OrderFlow} flow
 * @param {OrderExtras} [extras]
 */
export const shipmentSummary = (order, flow, extras = {}) => {
	if (!order.shipment) return null;
	const expected = order.shipment.estimatedDeliveryAt ? new Date(order.shipment.estimatedDeliveryAt) : null;
	return {
		orderNumber: order.number,
		courier: order.shipment.courier,
		trackingNumber: order.shipment.trackingNumber,
		trackingUrl: safeLink(extras.trackingUrl ?? order.shipment.trackingUrl),
		trackingNote: order.shipment.trackingNote ?? '',
		expectedAt: expected && !Number.isNaN(expected.getTime()) ? expected.toISOString() : null,
		status: order.shipment.status || statusLabel(flow, order.status),
	};
};

/**
 * A deal as Chat sees it (E37): its name, what it takes off, its display fields (E18) and when it ends.
 * @param {import('./model.js').DealRecord} deal
 * @param {{ currency: string, money: Money, date: (value: Date) => string, bannerUrl?: string | null }} context
 */
export const chatDeal = (deal, { currency, money, date, bannerUrl = null }) => {
	const record = /** @type {Record<string, any>} */ (deal);
	const kind = record.type === 'free_delivery' ? 'free_delivery' : record.type === 'fixed' ? 'fixed' : 'percent';
	const valueText =
		kind === 'free_delivery' ? '' : kind === 'fixed' ? money(Number(record.value), currency) : `${record.value}%`;
	const endsAt = deal.endsAt ? new Date(deal.endsAt) : null;
	return {
		id: deal.id,
		name: deal.name,
		description: deal.description,
		slug: typeof record.slug === 'string' ? record.slug : '',
		type: kind,
		value: kind === 'free_delivery' ? 0 : Number(record.value),
		valueText,
		badgeLabel: typeof record.badgeLabel === 'string' ? record.badgeLabel : '',
		discountLabel:
			typeof record.discountLabel === 'string' && record.discountLabel
				? record.discountLabel
				: kind === 'free_delivery'
					? 'Free delivery'
					: `${valueText} off`,
		color: typeof record.color === 'string' ? record.color : '',
		bannerUrl,
		minQuantity: Number(record.conditions?.minQuantity ?? 0) || null,
		days: Array.isArray(record.days) ? record.days : [],
		timeFrom: typeof record.timeFrom === 'string' ? record.timeFrom : '',
		timeTo: typeof record.timeTo === 'string' ? record.timeTo : '',
		endsAt: endsAt ? endsAt.toISOString() : null,
		endsText: endsAt ? date(endsAt) : '',
	};
};
