/**
 * The shop tools, track shipment, product cards and the context panel's shop info (PLAN 0.8.3 Shop tools, Context
 * panel; pure): the single list of the Ecommerce endpoints Chat calls (written in Chat's docs first; Ecommerce
 * implements exactly these), the tool schemas the AI sees, the request each tool call makes, and what of each answer the
 * AI, the cards and the context panel get. Chat calls Ecommerce with the pasted Ecommerce server token; the tools only
 * read. My orders, account and track shipment run only for a visitor whose Accounts sign-in Chat verified on that
 * request: Chat forwards it in the `SS-Sign-In` header and Ecommerce verifies it itself and answers only that user's
 * data. The AI never chooses the user, the website or the token: those tools take no arguments, and whatever the model
 * passes is ignored. Only whitelisted fields are kept, so no street address or phone number ever reaches the AI.
 * Prices, dates and deal days and times in what the AI and the context panel get follow the website's Format and
 * business time zone (PLAN 0.8.10 K7; day names in the Format's language, else en-US), so the chat answers show them
 * as the website does: Ecommerce's `priceText` when it sends one. Products are priced as the shop shows them: the shown
 * price (after the best live deal on one unit), the price struck through beside it (`compareAtPrice`, the "was" price)
 * and the deal in it with what it saves; cards keep the "was" price and the AI gets it as `wasPrice`. The fuller lookups
 * (C13, Ecommerce E37) pass the category, grade, price and stock filters and answer grades, variants, stock left,
 * warranty, quotes per variant and payment method, order lines and the store context (C1).
 * @module
 */
import { formatDate, formatMoney, isAmount, isCurrency, normaliseFormat } from '@ss/contracts/format';
import { isObject } from '@ss/contracts/util';
import { isHttpsUrl } from './text.js';

/** The shop tool names. */
const SHOP_TOOLS = Object.freeze({
	search: 'search_catalog',
	details: 'get_product_details',
	quote: 'quote_product_savings',
	deals: 'list_active_deals',
	top: 'get_top_products',
	orders: 'get_my_orders',
	account: 'get_my_account',
	track: 'track_shipment',
});

/**
 * The default of a search and of a top list (settings `maxResults` of `shop_search` and `count` of `shop_top`), and of
 * the orders one answer and the context panel read (`count` of `shop_my_orders`, `orders` of `context_panel`, C22).
 */
export const SHOP_LIMIT = 5;

/** Most products one search or top list asks for, and most cards under one answer (C13): Ecommerce's most. */
const SHOP_MAX = 12;

/** The largest quantity a quote asks for: Ecommerce holds it to the item's own steps, least and most (C3). */
const MAX_QUOTE_QUANTITY = 1_000_000;

/** The longest store context given to the AI (characters, C1): Ecommerce's, and the default of `shop_context`. */
const CONTEXT_MAX = 6000;

/** Deals one list asks for by default (setting `count` of `shop_deals`, C22), and at most (Ecommerce's most). */
const DEALS_LIMIT = 10;
const DEALS_MAX = 20;

/** Orders one answer reads at most (Ecommerce's most). */
const ORDERS_MAX = 10;

/** Orders the context panel shows at most (setting `orders` of `context_panel`, C22). */
const CONTEXT_ORDERS_MAX = 20;

/**
 * A count within 1–`max`, else the default.
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 */
const countIn = (value, fallback, max) => {
	const n = Math.floor(Number(value));
	return Number.isFinite(n) && n >= 1 ? Math.min(max, n) : fallback;
};

/** The tool answer when Ecommerce cannot be asked (not connected, token refused, stopped, unreachable). */
export const SHOP_UNAVAILABLE =
	'This cannot be looked up right now. Tell the visitor you cannot look this up right now, and offer other help.';

/**
 * One row per tool: the tool, the feature it belongs to, whether it needs the visitor's verified sign-in, and the
 * Ecommerce request it makes (server token).
 */
export const SHOP_ENDPOINTS = Object.freeze([
	{
		tool: SHOP_TOOLS.search,
		feature: 'shop_search',
		signIn: false,
		request:
			'GET /v1/chat/products?q=<text>&category=<name>&grade=<grade>&minPrice=<minor units>&maxPrice=<minor units>&inStock=1&limit=<1–12>',
	},
	{ tool: SHOP_TOOLS.details, feature: 'shop_search', signIn: false, request: 'GET /v1/chat/products/<productId>' },
	{
		tool: SHOP_TOOLS.quote,
		feature: 'shop_deals',
		signIn: false,
		request:
			'GET /v1/chat/products/<productId>/quote?variantId=<id>&quantity=<pieces, or an amount of its unit such as 2.5>&paymentMethod=<payment method key>&country=<country>&region=<region>&city=<city>&postalCode=<postal code>',
	},
	{ tool: SHOP_TOOLS.deals, feature: 'shop_deals', signIn: false, request: 'GET /v1/chat/deals?limit=<1–20>' },
	{ tool: SHOP_TOOLS.top, feature: 'shop_top', signIn: false, request: 'GET /v1/chat/products/top?kind=top|new&limit=<1–12>' },
	{
		tool: SHOP_TOOLS.orders,
		feature: 'shop_my_orders',
		signIn: true,
		request: 'GET /v1/chat/me/orders?limit=<1–10> (SS-Sign-In)',
	},
	{ tool: SHOP_TOOLS.account, feature: 'shop_my_orders', signIn: true, request: 'GET /v1/chat/me/account (SS-Sign-In)' },
	{ tool: SHOP_TOOLS.track, feature: 'track_shipment', signIn: true, request: 'GET /v1/chat/me/shipments (SS-Sign-In)' },
]);

/** The request of the store context the AI replies add (server token; the verified sign-in forwarded, C1). */
export const STORE_CONTEXT_ENDPOINT = Object.freeze({
	feature: 'shop_context',
	request: 'GET /v1/chat/context?productId=<the product the visitor views> (SS-Sign-In when signed in)',
});

/** The request of the context panel's shop info (server token; the conversation's signed-in visitor). */
export const CONTEXT_ENDPOINT = Object.freeze({
	feature: 'context_panel',
	request: 'GET /v1/customers/<userId>/orders?limit=<1–20>',
});

/**
 * What Chat reads of each answer (Ecommerce's schemas, as its API reference documents them; product cards use the
 * product fields). Amounts are integer minor units; each comes with its `…Text` as the website shows it.
 */
export const SHOP_ANSWERS = Object.freeze({
	product:
		'id, name, price (the shown price: after the best live deal on one unit), priceText, compareAtPrice and compareAtPriceText (the price struck through beside it, or null), deal ({ name, savings, savingsText } or null), priceMax, priceMaxText, currency, image (https or null), url (the product page), inStock, variantId (or null), grade (the label, or null), stockLeft (or null)',
	details:
		'a product plus summary, description, brand, options: [{ name, values: [text] }], specs: [{ name, value (text, number, true/false or a list), unit }], variants: [{ id, options: { name: value }, price, priceText, compareAtPrice, compareAtPriceText, deal, grade, gradeKey, inStock, soldOut, stockLeft, warrantyTime }]',
	quote: 'productId, variantId, quantity, paymentMethod, price (one unit before deals), compareAtPrice (its own price struck through, or null), priceAfterDeals, savings, subtotal, discount, roleDiscount, fee, tax, freeDeliveryOver, total (each with its …Text), currency, delivery ({ method, name, rateName, fee, feeText, minDays, maxDays } or null), limits ({ step, min, max } of pieces, or thousandths of its unit with measure { unit, quantityText }), inStock, deals: [name], paymentMethods: [{ method (the website’s payment method key), name, available, reason (or null), advance, advanceText, fee }]',
	deals: 'items: [{ name, description, valueText, badgeLabel, discountLabel, minQuantity, days (weekdays, 0 = Sunday), timeFrom, timeTo, endsAt, endsText }]',
	orders:
		'items: [{ number, status (the label), total, totalText, currency, placedAt, paymentMethod, balanceDue, balanceDueText, courier, trackingNumber, trackingUrl, trackingNote, expectedAt, attachments: [{ label, type (photo, video or file), url }], lines: [{ name, variantName, gradeLabel, quantity, totalText, warrantyTime }] }] (the latest, as many as asked), extraFields: [{ label, value }] (such as the loyalty points, in the website’s words), name',
	account:
		'name, firstName, city, region, country, extraFields: [{ label, value }] (such as the loyalty points and the area, in the website’s words)',
	shipments: 'items: [{ orderNumber, courier, trackingNumber, trackingUrl, status, trackingNote, expectedAt }]',
	context:
		'text (at most 6,000 characters: the policies, the 10 newest products with their shown price per grade and its "was" price, the deals table, the named product and, signed in, first name, city and points), currency',
	customerOrders: 'items: [{ number, status, statusLabel, total, totalText, currency, createdAt }], loyaltyPoints',
});

/**
 * A payment method key of the website's own list (Ecommerce's `payment_methods`, C1): lowercase letters, digits and `_`
 * (`payments` and `other` name money entries, never a method).
 */
const METHOD_KEY = /^[a-z][a-z0-9_]{0,39}$/;
/** @param {unknown} value @returns {value is string} */
const isMethodKey = (value) => typeof value === 'string' && METHOD_KEY.test(value) && value !== 'payments' && value !== 'other';
/** A quote passes at most this many payment methods (the most a website's list has). */
const MAX_METHODS = 20;

/** A Sunday (2026-01-04 UTC): a deal's `days` (0 = Sunday) are named from it. */
const SUNDAY = Date.UTC(2026, 0, 4);
const DAY_MS = 86_400_000;

/** Tool names the merchant's webhook tools may not take. */
export const SHOP_TOOL_NAMES = Object.freeze(Object.values(SHOP_TOOLS));

/** @typedef {import('./providers.js').ToolSchema} ToolSchema */
/**
 * The deal in a shown price, with what it takes off one unit (Ecommerce's `deal`).
 * @typedef {{ name: string, savings: number, savingsText: string | null }} ShopDeal
 */
/**
 * A product as Ecommerce answers it (only these fields are kept).
 * @typedef {object} ShopProduct
 * @property {string} id
 * @property {string} name
 * @property {number} price integer minor units: the shown price, as the product page shows it
 * @property {number | null} compareAtPrice the price struck through beside it (higher than `price`), else null
 * @property {string | null} compareAtPriceText
 * @property {ShopDeal | null} deal the deal in the price
 * @property {string} currency ISO 4217
 * @property {string | null} image https
 * @property {string | null} url the product page
 * @property {boolean} inStock
 * @property {string | null} variantId
 * @property {string | null} priceText the price as the website shows it (Ecommerce, K7)
 * @property {string | null} [priceMaxText] the highest variant price, when it is higher (E37)
 * @property {string | null} grade
 * @property {number | null} stockLeft
 * @property {QuantityLimits | null} limits the quantities a shopper may buy (pieces, or thousandths of `unit`)
 * @property {string | null} unit the item's own unit when it is sold in one
 */
/** @typedef {{ step: number, min: number, max: number }} QuantityLimits */
/**
 * A product card saved on an AI message.
 * @typedef {object} ProductCard
 * @property {string} productId
 * @property {string | null} variantId
 * @property {string} name
 * @property {number} price integer minor units
 * @property {number | null} compareAtPrice the price struck through beside it (higher than `price`), else null
 * @property {string} currency
 * @property {string | null} image https
 * @property {string | null} url the product page
 * @property {boolean} inStock
 * @property {QuantityLimits | null} [limits] what Add to cart adds: the least, in the item's steps (Ecommerce's limits)
 * @property {string | null} [unit] the item's own unit when it is sold in one (quantities in thousandths of it)
 */
/**
 * The website's Format and business time zone (from the server's `product.format(websiteId)`).
 * @typedef {{ format?: Partial<import('@ss/contracts/format').Format>, timeZone?: string }} Look
 */
/**
 * The context panel's shop info.
 * @typedef {{ orders: Array<{ number: string, status: string, total: string, createdAt: string | null }>, loyaltyPoints: number | null }} ShopInfo
 */

/**
 * What a list of objects gives, each through `read` (null skipped), at most 10.
 * @param {unknown} value @param {(item: Record<string, unknown>) => string | null} read
 * @returns {string[]}
 */
const fieldsOf = (value, read) =>
	(Array.isArray(value) ? value : [])
		.filter(isObject)
		.slice(0, 10)
		.map(read)
		.filter((text) => text !== null);

/**
 * The extra fields a lookup gives (C19: `[{ label, value }]` in the website's words, such as the loyalty points or the
 * area) as `{ more: ['Label: value'] }`, or nothing.
 * @param {unknown} value
 * @returns {{ more?: string[] }}
 */
const extraOf = (value) => {
	const more = fieldsOf(value, (item) => {
		const label = textOf(item.label, 60);
		const text = textOf(item.value, 200);
		return label && text ? `${label}: ${text}` : null;
	});
	return more.length > 0 ? { more } : {};
};

/** @param {unknown} value @param {number} max */
const textOf = (value, max) => {
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	if (typeof value !== 'string' || value.trim() === '') return null;
	const trimmed = value.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

/** An http(s) page address, else null. @param {unknown} value */
const pageUrl = (value) =>
	typeof value === 'string' && value.length <= 500 && /^https?:\/\/[^\s/?#]+\S*$/.test(value) ? value : null;

/** @param {unknown} value */
const countOf = (value) => (Number.isSafeInteger(value) ? Number(value) : null);

/**
 * The price struck through beside a price (`compareAtPrice`) when it is higher, else null.
 * @param {Record<string, any>} b a product, variant or quote as Ecommerce answers it
 */
const wasOf = (b) =>
	isAmount(b.compareAtPrice) && isAmount(b.price) && b.compareAtPrice > b.price ? Number(b.compareAtPrice) : null;

/**
 * The deal in a shown price (`{ name, savings, savingsText }`), else null.
 * @param {unknown} raw
 * @returns {ShopDeal | null}
 */
const dealOf = (raw) => {
	if (!isObject(raw)) return null;
	const name = textOf(raw.name, 120);
	return name && isAmount(raw.savings) && raw.savings > 0
		? { name, savings: Number(raw.savings), savingsText: textOf(raw.savingsText, 60) }
		: null;
};

/**
 * What a shown price carries besides its amount (a product or variant as Ecommerce answers it): the price struck
 * through beside it and the deal in it.
 * @param {Record<string, any>} raw
 * @returns {{ compareAtPrice: number | null, compareAtPriceText: string | null, deal: ShopDeal | null }}
 */
const shownOf = (raw) => {
	const was = wasOf(raw);
	return {
		compareAtPrice: was,
		compareAtPriceText: was === null ? null : textOf(raw.compareAtPriceText, 60),
		deal: dealOf(raw.deal),
	};
};

/**
 * An amount in minor units for people, in the website's Format (`125000`, `USD` → `USD 1,250.00` by default).
 * @param {number} amount integer minor units
 * @param {string} currency ISO 4217
 * @param {Look} look
 */
const moneyText = (amount, currency, look) => formatMoney(amount, currency, look.format);

/**
 * A date or time from an answer for people, in the website's Format and business time zone (a calendar day such as
 * `2026-10-01` stays that day); the text as it came when it is not a time.
 * @param {unknown} value
 * @param {Look} look
 * @param {'date' | 'datetime'} style
 */
const dateText = (value, look, style) => {
	const text = textOf(value, 40);
	if (text === null) return null;
	const formatted = /^\d{4}-\d{2}-\d{2}$/.test(text)
		? formatDate(`${text}T00:00:00Z`, look.format, { timeZone: 'UTC', style: 'date' })
		: formatDate(text, look.format, { timeZone: look.timeZone, style });
	return formatted || text;
};

/**
 * A product from an Ecommerce answer, or null when it is not one.
 * @param {unknown} raw
 * @returns {ShopProduct | null}
 */
const productOf = (raw) => {
	if (!isObject(raw)) return null;
	const id = textOf(raw.id, 100);
	const name = textOf(raw.name, 200);
	if (!id || !name || !isAmount(raw.price) || !isCurrency(raw.currency)) return null;
	return {
		id,
		name,
		price: Number(raw.price),
		...shownOf(raw),
		currency: raw.currency,
		image: isHttpsUrl(raw.image) ? String(raw.image) : null,
		url: pageUrl(raw.url),
		inStock: raw.inStock === true,
		variantId: textOf(raw.variantId, 100),
		priceText: textOf(raw.priceText, 60),
		priceMaxText: isAmount(raw.priceMax) && Number(raw.priceMax) > Number(raw.price) ? textOf(raw.priceMaxText, 60) : null,
		grade: textOf(raw.grade, 60),
		stockLeft: countOf(raw.stockLeft),
		limits: cardLimitsOf(raw.limits),
		unit: textOf(raw.unit, 20),
	};
};

/**
 * The quantities a product may be bought in (Ecommerce's `limits`: whole step, least and most), else null.
 * @param {unknown} raw
 * @returns {QuantityLimits | null}
 */
const cardLimitsOf = (raw) => {
	if (!isObject(raw)) return null;
	const whole = (/** @type {unknown} */ value) => Number.isSafeInteger(value) && Number(value) >= 1;
	if (!whole(raw.step) || !whole(raw.min) || !whole(raw.max) || Number(raw.min) > Number(raw.max)) return null;
	return { step: Number(raw.step), min: Number(raw.min), max: Number(raw.max) };
};

/**
 * The card of a product.
 * @param {ShopProduct} product
 * @returns {ProductCard}
 */
export const cardOf = (product) => ({
	productId: product.id,
	variantId: product.variantId,
	name: product.name,
	price: product.price,
	compareAtPrice: product.compareAtPrice,
	currency: product.currency,
	image: product.image,
	url: product.url,
	inStock: product.inStock,
	limits: product.limits,
	unit: product.unit,
});

/**
 * Cards saved on a message, checked again (they are shown to visitors).
 * @param {unknown} raw
 * @returns {ProductCard[]}
 */
export const cardsOf = (raw) =>
	(Array.isArray(raw) ? raw : [])
		.slice(0, SHOP_MAX)
		.map((card) => (isObject(card) ? productOf({ ...card, id: card.productId }) : null))
		.filter((product) => product !== null)
		.map(cardOf);

/** @param {string} name @param {string} description @param {Record<string, unknown>} [properties] @param {string[]} [required] @returns {ToolSchema} */
const schema = (name, description, properties = {}, required = []) => ({
	name,
	description,
	parameters: { type: 'object', properties, required },
});

const PRODUCT_ID = { type: 'string', description: 'The product id from search_catalog or get_top_products.' };

/** How the product tools price, in their descriptions (so the AI names the price the product page shows). */
const PRICE_FIELDS =
	'price is what the product page charges now, after any live deal (lowest to highest when the variants differ); wasPrice, when given, is the old price the page shows struck through beside it (mention it as "was …", never as the price to pay); deal, when given, is the deal in the price and what it saves on one unit';

/** @type {Record<string, ToolSchema>} */
const SCHEMAS = {
	[SHOP_TOOLS.search]: schema(
		SHOP_TOOLS.search,
		`Search the live shop catalog by name, brand, model or kind of product, optionally within a category, a grade, a price range or only in stock. Returns matching products with price, wasPrice, deal, grade, stock, link and id: ${PRICE_FIELDS}. Use it for any product, price, budget or availability question.`,
		{
			query: { type: 'string', description: 'What to search for, e.g. a product name or brand (may be empty with a filter).' },
			category: { type: 'string', description: 'Only this category: its slug as in its link (e.g. new-arrivals) or id.' },
			grade: {
				type: 'string',
				description: 'Only these grades: grade keys (gradeKey in product details, e.g. new), separated by commas.',
			},
			minPrice: { type: 'number', description: 'Lowest price, in whole units of the shop’s currency.' },
			maxPrice: {
				type: 'number',
				description: 'Highest price (the visitor’s budget), in whole units of the shop’s currency.',
			},
			inStock: { type: 'boolean', description: 'Only products in stock.' },
		},
	),
	[SHOP_TOOLS.details]: schema(
		SHOP_TOOLS.details,
		'Get the full details of ONE product you already found: summary, description, brand, options, specs, warranty and its variants, each with grade, price, wasPrice and deal (as search_catalog gives them) and stock left.',
		{ productId: PRODUCT_ID },
		['productId'],
	),
	[SHOP_TOOLS.quote]: schema(
		SHOP_TOOLS.quote,
		'Quote ONE product’s price after the active deals, for a variant, a quantity and a payment method: price (one unit before deals) with wasPrice (its old price, struck through on the product page, when given), priceAfterDeals (one unit after the deals; for one unit, the price on the product page), the saving per unit, the fees, the delivery charge, the free-delivery threshold, the total, the deals that apply and the payment methods it can be paid with.',
		{
			productId: PRODUCT_ID,
			variantId: { type: 'string', description: 'The variant id from get_product_details (optional).' },
			quantity: {
				type: 'number',
				description:
					'How many: pieces, or an amount of the product’s own unit such as 2.5 (default: its least). Keep to its steps, least and most (limits in the answer).',
			},
			paymentMethod: {
				type: 'string',
				description:
					'The payment method the visitor asks about (optional): a payment method key of a quote’s paymentMethods (the website’s own methods, each with its name).',
			},
			country: { type: 'string', description: 'The visitor’s country, for the delivery charge and tax (optional).' },
			region: {
				type: 'string',
				description: 'The visitor’s state, province or region, for the delivery charge and tax (optional).',
			},
			city: { type: 'string', description: 'The visitor’s city, for the delivery charge (optional).' },
			postalCode: { type: 'string', description: 'The visitor’s postal code, for the delivery charge and tax (optional).' },
		},
		['productId'],
	),
	[SHOP_TOOLS.deals]: schema(
		SHOP_TOOLS.deals,
		'List the active deals with their description and end date. Never invent offers that are not returned here.',
	),
	[SHOP_TOOLS.top]: schema(
		SHOP_TOOLS.top,
		'List the best-selling products (kind "top") or the newest arrivals (kind "new"), with the fields search_catalog gives.',
		{ kind: { type: 'string', enum: ['top', 'new'], description: '"top" (default) or "new".' } },
	),
	[SHOP_TOOLS.orders]: schema(
		SHOP_TOOLS.orders,
		'Look up the signed-in visitor’s own last orders (number, status, total, date, items, expected date, tracking note, the shop’s attachments such as a packing video), their name and more about them (such as loyalty points). Only for questions about their own orders.',
	),
	[SHOP_TOOLS.account]: schema(
		SHOP_TOOLS.account,
		'Get the signed-in visitor’s own name, city, region and country, and more about them the shop gives (such as loyalty points or their area).',
	),
	[SHOP_TOOLS.track]: schema(
		SHOP_TOOLS.track,
		'Track the signed-in visitor’s own shipments: courier, tracking number, tracking link and latest status per order.',
	),
};

/**
 * The shop tools offered for a turn: those whose feature is on; the sign-in tools only for a verified sign-in.
 * @param {string[]} on switched-on features
 * @param {{ signedIn: boolean }} visitor
 * @returns {ToolSchema[]}
 */
export const shopSchemas = (on, { signedIn }) =>
	SHOP_ENDPOINTS.filter((row) => on.includes(row.feature) && (signedIn || !row.signIn)).map(
		(row) => /** @type {ToolSchema} */ (SCHEMAS[row.tool]),
	);

/** A product id or slug as Ecommerce takes it, else null. @param {unknown} value */
const productId = (value) => (typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value.trim()) ? value.trim() : null);

/** A variant id as Ecommerce takes it, else null. @param {unknown} value */
const variantId = (value) => (typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value.trim()) ? value.trim() : null);

/** @param {unknown} value @param {number} max */
const word = (value, max) => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null);

/** A category id or slug from the model (`New Arrivals` → `new-arrivals`), else null. @param {unknown} value */
const slugOf = (value) => {
	if (typeof value !== 'string') return null;
	const slug = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 120);
	return slug === '' ? null : slug;
};

/** A whole amount the model gave (whole units of the shop's currency), else null. @param {unknown} value */
const wholeAmount = (value) => {
	const number = typeof value === 'string' ? Number(value.replace(/[^\d.]/g, '')) : Number(value);
	return Number.isFinite(number) && number > 0 && number < 1e12 ? number : null;
};

/**
 * Whether a tool call gives prices (they need the shop's currency to become minor units).
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
export const needsCurrency = (name, args) =>
	name === SHOP_TOOLS.search && (wholeAmount(args.minPrice) !== null || wholeAmount(args.maxPrice) !== null);

/**
 * The Ecommerce request of a tool call (only public inputs come from the model). Prices the model gives in whole units
 * become minor units with `minor` (the shop's currency).
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {{ limit?: number, top?: number, deals?: number, orders?: number, minor?: (amount: number) => number }}
 *   [options] `limit`: products per search (1–12); `top`, `deals`, `orders`: what one list asks for (C22)
 * @returns {{ ok: true, path: string, signIn: boolean } | { ok: false, content: string }}
 */
export const shopRequest = (
	name,
	args,
	{
		limit = SHOP_LIMIT,
		top = SHOP_LIMIT,
		deals = DEALS_LIMIT,
		orders = SHOP_LIMIT,
		minor = (amount) => Math.round(amount * 100),
	} = {},
) => {
	const row = SHOP_ENDPOINTS.find((r) => r.tool === name);
	if (!row) return { ok: false, content: 'No such tool.' };
	if (name === SHOP_TOOLS.search) {
		const query = new URLSearchParams();
		const q = word(args.query, 100);
		if (q) query.set('q', q);
		const category = slugOf(args.category);
		if (category) query.set('category', category);
		const grades = (typeof args.grade === 'string' ? args.grade.split(',') : [])
			.map((key) => key.trim().toLowerCase().replace(/\s+/g, '_'))
			.filter((key) => /^[a-z][a-z0-9_-]{0,39}$/.test(key))
			.slice(0, 10);
		if (grades.length > 0) query.set('grade', grades.join(','));
		const min = wholeAmount(args.minPrice);
		if (min !== null) query.set('minPrice', String(minor(min)));
		const max = wholeAmount(args.maxPrice);
		if (max !== null) query.set('maxPrice', String(minor(max)));
		if (args.inStock === true || args.inStock === 'true') query.set('inStock', '1');
		if ([...query.keys()].length === 0) return { ok: false, content: 'Say what to search for, or give a filter.' };
		query.set('limit', String(Math.max(1, Math.min(SHOP_MAX, Math.floor(limit) || SHOP_LIMIT))));
		return { ok: true, signIn: false, path: `/v1/chat/products?${query.toString()}` };
	}
	if (name === SHOP_TOOLS.details || name === SHOP_TOOLS.quote) {
		const id = productId(args.productId);
		if (!id) return { ok: false, content: 'Give the product id from a search result.' };
		const path = `/v1/chat/products/${encodeURIComponent(id)}`;
		if (name === SHOP_TOOLS.details) return { ok: true, signIn: false, path };
		const query = new URLSearchParams();
		const variant = variantId(args.variantId);
		if (variant) query.set('variantId', variant);
		// pieces, or an amount of an item sold in a unit of its own (at most three decimals; Ecommerce checks the steps, C3)
		const quantity = Number(args.quantity);
		if (Number.isFinite(quantity) && quantity > 0 && quantity <= MAX_QUOTE_QUANTITY && Number.isInteger(quantity * 1000))
			query.set('quantity', String(quantity));
		const method = typeof args.paymentMethod === 'string' ? args.paymentMethod.trim().toLowerCase() : '';
		if (isMethodKey(method)) query.set('paymentMethod', method);
		// where it goes (Ecommerce's address lengths), for the delivery zone and tax
		for (const [field, max] of /** @type {const} */ ([
			['country', 60],
			['region', 100],
			['city', 100],
			['postalCode', 20],
		])) {
			const value = word(args[field], max);
			if (value) query.set(field, value);
		}
		const search = query.toString();
		return { ok: true, signIn: false, path: `${path}/quote${search ? `?${search}` : ''}` };
	}
	if (name === SHOP_TOOLS.deals)
		return { ok: true, signIn: false, path: `/v1/chat/deals?limit=${countIn(deals, DEALS_LIMIT, DEALS_MAX)}` };
	if (name === SHOP_TOOLS.top)
		return {
			ok: true,
			signIn: false,
			path: `/v1/chat/products/top?kind=${args.kind === 'new' ? 'new' : 'top'}&limit=${countIn(top, SHOP_LIMIT, SHOP_MAX)}`,
		};
	if (name === SHOP_TOOLS.orders)
		return { ok: true, signIn: true, path: `/v1/chat/me/orders?limit=${countIn(orders, SHOP_LIMIT, ORDERS_MAX)}` };
	if (name === SHOP_TOOLS.account) return { ok: true, signIn: true, path: '/v1/chat/me/account' };
	return { ok: true, signIn: true, path: '/v1/chat/me/shipments' };
};

/**
 * The store context request (C1): the product the visitor is viewing, when there is one.
 * @param {string | null | undefined} viewing the product id of `SSChat.setPage`
 */
export const contextPath = (viewing) => {
	const id = productId(viewing);
	return id ? `/v1/chat/context?productId=${encodeURIComponent(id)}` : '/v1/chat/context';
};

/**
 * The store context the AI gets (C1): Ecommerce's `text`, at most `max` characters (setting `maxCharacters` of
 * `shop_context`, 6,000 by default and at most, C22); null when it has none.
 * @param {unknown} body
 * @param {number} [max]
 * @returns {string | null}
 */
export const contextText = (body, max = CONTEXT_MAX) => {
	const trimmed = isObject(body) && typeof body.text === 'string' ? body.text.trim() : '';
	if (trimmed === '') return null;
	const most = countIn(max, CONTEXT_MAX, CONTEXT_MAX);
	return trimmed.length > most ? `${trimmed.slice(0, most - 1)}…` : trimmed;
};

/**
 * A price for people: Ecommerce's text when it sent one, else the amount in the website's Format; null when neither.
 * @param {Record<string, any>} b
 * @param {string} key the amount's field (its text is `<key>Text`)
 * @param {Look} look
 */
const priceOf = (b, key, look) => {
	const text = textOf(b[`${key}Text`], 60);
	if (text) return text;
	return isAmount(b[key]) && isCurrency(b.currency) ? moneyText(Number(b[key]), b.currency, look) : null;
};

/**
 * What a shown price adds for the AI (a product or variant): `wasPrice`, the price struck through beside it, and `deal`,
 * the deal in the price with what it saves on one unit; each only when there is one.
 * @param {{ compareAtPrice: number | null, compareAtPriceText: string | null, deal: ShopDeal | null }} shown
 * @param {string} currency
 * @param {Look} look
 */
const shownExtras = ({ compareAtPrice, compareAtPriceText, deal }, currency, look) => ({
	...(compareAtPrice !== null ? { wasPrice: compareAtPriceText ?? moneyText(compareAtPrice, currency, look) } : {}),
	...(deal ? { deal: { name: deal.name, savings: deal.savingsText ?? moneyText(deal.savings, currency, look) } } : {}),
});

/** @param {ShopProduct} p @param {Look} look */
const productLine = (p, look) => ({
	id: p.id,
	name: p.name,
	price: `${p.priceText ?? moneyText(p.price, p.currency, look)}${p.priceMaxText ? ` – ${p.priceMaxText}` : ''}`,
	...shownExtras(p, p.currency, look),
	inStock: p.inStock,
	...(p.grade ? { grade: p.grade } : {}),
	...(p.stockLeft !== null ? { stockLeft: p.stockLeft } : {}),
	...(p.url ? { link: p.url } : {}),
});

/** @param {unknown} list */
const itemsOf = (list) => (Array.isArray(list) ? list : []);

/** Texts of a list of texts (the names of a quote's deals, an option's values). @param {unknown} value */
const listOfTexts = (value) =>
	itemsOf(value)
		.map((item) => textOf(item, 120))
		.filter(Boolean)
		.slice(0, 20);

/** A spec value as text: a text, a number, yes or no, or a list. @param {unknown} value */
const specValueText = (value) => {
	if (typeof value === 'boolean') return value ? 'yes' : 'no';
	if (Array.isArray(value)) return textOf(listOfTexts(value).join(', '), 200);
	return textOf(value, 200);
};

/** A product's specs (`[{ name, value, unit }]`) as `name: value unit` lines. @param {unknown} value */
const specsOf = (value) =>
	itemsOf(value)
		.filter(isObject)
		.slice(0, 30)
		.map((spec) => {
			const unit = textOf(spec.unit, 20);
			return `${textOf(spec.name, 80) ?? ''}: ${specValueText(spec.value) ?? ''}${unit ? ` ${unit}` : ''}`;
		});

/** A product's options (`[{ name, values }]`). @param {unknown} value */
const optionsOf = (value) =>
	itemsOf(value)
		.filter(isObject)
		.slice(0, 10)
		.map((option) => ({ name: textOf(option.name, 80), values: listOfTexts(option.values) }));

/**
 * The quantities a quoted product is sold in (`limits`, C3): pieces, or amounts of its own unit (Ecommerce gives
 * thousandths of the unit), as the AI reads them; nothing when not given.
 * @param {Record<string, any>} b the quote
 */
const limitsOf = (b) => {
	const l = isObject(b.limits) ? b.limits : null;
	if (!l || countOf(l.step) === null || countOf(l.min) === null || countOf(l.max) === null) return {};
	const scale = isObject(b.measure) ? 1000 : 1;
	return { limits: { step: Number(l.step) / scale, least: Number(l.min) / scale, most: Number(l.max) / scale } };
};

/** Intl's unit of each time unit Ecommerce gives. */
const TIME_UNITS = Object.freeze(/** @type {Record<string, string>} */ ({ days: 'day', months: 'month', years: 'year' }));

/**
 * A return or warranty time (`{ amount, unit }`, as the merchant typed it, C8) in the website's language (`1 year`,
 * `6 months`), else null.
 * @param {unknown} value @param {Look} look
 */
const timeOf = (value, look) => {
	if (!isObject(value) || !Number.isSafeInteger(value.amount) || Number(value.amount) <= 0) return null;
	const unit = TIME_UNITS[String(value.unit)];
	if (!unit) return null;
	return new Intl.NumberFormat(localeOf(look), { style: 'unit', unit, unitDisplay: 'long' }).format(Number(value.amount));
};

/**
 * Delivery days (`min`–`max`) in the website's language (`2–4 days`), else null (C8).
 * @param {unknown} min @param {unknown} max @param {Look} look
 */
const deliveryDaysOf = (min, max, look) => {
	if (countOf(min) === null || countOf(max) === null) return null;
	const days = (/** @type {number} */ n) =>
		new Intl.NumberFormat(localeOf(look), { style: 'unit', unit: 'day', unitDisplay: 'long' }).format(n);
	return min === max ? days(Number(max)) : `${min}–${days(Number(max))}`;
};

/** A variant's options (`{ name: value }`) as `name: value` text. @param {unknown} value */
const variantOptions = (value) =>
	isObject(value)
		? Object.entries(value)
				.slice(0, 10)
				.map(([key, v]) => `${key.slice(0, 40)}: ${textOf(v, 80) ?? ''}`)
				.join(', ')
		: null;

/**
 * The language of text Chat makes for the website: its Format's, else `en-US`.
 * @param {Look} look
 */
const localeOf = (look) => normaliseFormat(look.format).locale || 'en-US';

/**
 * A deal's weekdays (`days`, 0 = Sunday) as names in the website's language, listed as that language lists them
 * ("Friday and Saturday", "vendredi et samedi").
 * @param {unknown} value
 * @param {Look} look
 */
const weekdaysOf = (value, look) => {
	const days = itemsOf(value).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
	if (days.length === 0) return '';
	const locale = localeOf(look);
	const names = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
	return new Intl.ListFormat(locale, { type: 'conjunction' }).format(days.map((day) => names.format(SUNDAY + day * DAY_MS)));
};

/**
 * A deal's wall-clock time (`HH:MM`, 00:00–24:00 in the business time zone) in the website's Format ("2:30 PM",
 * "14:30"); any other text as it came.
 * @param {unknown} value
 * @param {Look} look
 */
const clockText = (value, look) => {
	const text = textOf(value, 10);
	const match = text === null ? null : /^(\d{1,2}):([0-5]\d)$/.exec(text);
	if (!match) return text;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (hour > 24 || (hour === 24 && minute > 0)) return text;
	const format = { ...look.format, locale: localeOf(look) };
	return formatDate(Date.UTC(2026, 0, 4, hour, minute), format, { timeZone: 'UTC', style: 'time' });
};

/**
 * A product as a comparison shows it (C18).
 * @typedef {object} CompareFacts
 * @property {string} name
 * @property {string | null} link the product page
 * @property {string} price the shown price, as the product page shows it (lowest to highest when the variants differ)
 * @property {string | null} wasPrice the price struck through beside it
 * @property {boolean} inStock
 * @property {string | null} brand
 * @property {string | null} grade
 * @property {Array<{ name: string, value: string | boolean }>} details its options (their values) and specs (value and
 *   unit; true or false for a yes-or-no spec), in the shop's order
 */

/**
 * A product's details as a comparison shows them (C18), from Ecommerce's product details (E37); null when the answer
 * is not a product.
 * @param {unknown} body
 * @param {Look} [look] the website's Format and business time zone
 * @returns {CompareFacts | null}
 */
export const compareFactsOf = (body, look = {}) => {
	const b = isObject(body) ? body : {};
	const product = productOf(b);
	if (!product) return null;
	const line = productLine(product, look);
	const options = optionsOf(b.options)
		.filter((option) => option.name !== null && option.values.length > 0)
		.map((option) => ({ name: String(option.name), value: option.values.join(', ') }));
	const specs = itemsOf(b.specs)
		.filter(isObject)
		.slice(0, 30)
		.map((spec) => {
			const unit = textOf(spec.unit, 20);
			const value = typeof spec.value === 'boolean' ? spec.value : specValueText(spec.value);
			return { name: textOf(spec.name, 80), value: typeof value === 'string' && unit ? `${value} ${unit}` : value };
		})
		.filter((spec) => spec.name !== null && spec.value !== null);
	return {
		name: product.name,
		link: product.url,
		price: line.price,
		wasPrice: 'wasPrice' in line ? String(line.wasPrice) : null,
		inStock: product.inStock,
		brand: textOf(b.brand, 120),
		grade: product.grade,
		details: [...options, .../** @type {Array<{ name: string, value: string | boolean }>} */ (specs)],
	};
};

/**
 * What the AI gets from an Ecommerce answer, and the products that become cards.
 * @param {string} name
 * @param {unknown} body
 * @param {Look} [look] the website's Format and business time zone
 * @returns {{ content: unknown, products: ShopProduct[] }}
 */
export const shopAnswer = (name, body, look = {}) => {
	const b = isObject(body) ? body : {};
	if (name === SHOP_TOOLS.search || name === SHOP_TOOLS.top) {
		const products = itemsOf(b.items)
			.map(productOf)
			.filter((p) => p !== null)
			.slice(0, SHOP_MAX);
		if (products.length === 0)
			return { content: 'Nothing in the catalog matched. Do not invent products; suggest another search.', products };
		return { content: { products: products.map((p) => productLine(p, look)) }, products };
	}
	if (name === SHOP_TOOLS.details) {
		const product = productOf(b);
		if (!product) return { content: 'No such product. Do not invent details.', products: [] };
		const variants = itemsOf(b.variants)
			.filter(isObject)
			.slice(0, 30)
			.map((v) => {
				const grade = textOf(v.grade, 60);
				const gradeKey = textOf(v.gradeKey, 40);
				const stockLeft = countOf(v.stockLeft);
				const warranty = timeOf(v.warrantyTime, look);
				return {
					id: textOf(v.id, 100),
					options: variantOptions(v.options),
					price: priceOf({ ...v, currency: product.currency }, 'price', look),
					...shownExtras(shownOf(v), product.currency, look),
					...(grade ? { grade } : {}),
					...(gradeKey ? { gradeKey } : {}),
					inStock: v.inStock === true && v.soldOut !== true,
					...(stockLeft !== null ? { stockLeft } : {}),
					...(warranty ? { warranty } : {}),
				};
			});
		return {
			content: {
				...productLine(product, look),
				brand: textOf(b.brand, 120),
				summary: textOf(b.summary, 500),
				description: textOf(b.description, 1500),
				options: optionsOf(b.options),
				specs: specsOf(b.specs),
				...(variants.length > 0 ? { variants } : {}),
			},
			products: [product],
		};
	}
	if (name === SHOP_TOOLS.quote) {
		if (!isCurrency(b.currency) || !isAmount(b.price) || !isAmount(b.priceAfterDeals))
			return { content: 'No quote for this product. Do not invent prices.', products: [] };
		/** @type {Record<string, unknown>} */
		const content = {
			productId: textOf(b.productId, 100),
			...(textOf(b.variantId, 100) ? { variantId: textOf(b.variantId, 100) } : {}),
			// an amount of the product's own unit reads as `2.5 m` (its quantity is thousandths of the unit, C3)
			...(isObject(b.measure) && textOf(b.measure.unit, 20)
				? { quantity: `${textOf(b.measure.quantityText, 20)} ${textOf(b.measure.unit, 20)}` }
				: countOf(b.quantity) !== null
					? { quantity: countOf(b.quantity) }
					: {}),
			...limitsOf(b),
			...(textOf(b.paymentMethod, 60) ? { paymentMethod: textOf(b.paymentMethod, 60) } : {}),
			price: priceOf(b, 'price', look),
			...(wasOf(b) !== null ? { wasPrice: priceOf(b, 'compareAtPrice', look) } : {}),
			priceAfterDeals: priceOf(b, 'priceAfterDeals', look),
			savings: priceOf(b, 'savings', look) ?? moneyText(0, b.currency, look),
			deals: listOfTexts(b.deals),
		};
		// the cart's pricing for this payment method: amounts that are there, the total always
		for (const key of ['subtotal', 'discount', 'roleDiscount', 'fee', 'tax', 'freeDeliveryOver', 'total']) {
			if (key !== 'total' && key !== 'subtotal' && !(Number(b[key]) > 0)) continue;
			const text = priceOf(b, key, look);
			if (text) content[key] = text;
		}
		if (isObject(b.delivery)) {
			const d = b.delivery;
			const fee = priceOf({ ...d, currency: b.currency }, 'fee', look);
			const days = deliveryDaysOf(d.minDays, d.maxDays, look);
			// the zone or pickup place, then the delivery rate's name (Ecommerce E5)
			content.delivery = [textOf(d.name, 80), textOf(d.rateName, 60), fee, days].filter(Boolean).join(', ');
		}
		if (b.inStock === false) content.inStock = false;
		// the website's payment methods in its list's order, by their own names (C1): whether each can pay for it (why
		// not), its advance and its fee
		const methods = itemsOf(b.paymentMethods)
			.filter((m) => isObject(m) && isMethodKey(m.method))
			.slice(0, MAX_METHODS)
			.map((m) => {
				const available = m.available === true;
				const reason = available ? null : textOf(m.reason, 40);
				const option = { ...m, currency: b.currency };
				const advance = Number(m.advance) > 0 ? priceOf(option, 'advance', look) : null;
				const fee = Number(m.fee) > 0 ? priceOf(option, 'fee', look) : null;
				const name = textOf(m.name, 60);
				return {
					method: m.method,
					...(name ? { name } : {}),
					available,
					...(reason ? { reason } : {}),
					...(advance ? { advance } : {}),
					...(fee ? { fee } : {}),
				};
			});
		if (methods.length > 0) content.paymentMethods = methods;
		return { content, products: [] };
	}
	if (name === SHOP_TOOLS.deals) {
		const deals = itemsOf(b.items)
			.filter(isObject)
			.slice(0, DEALS_MAX)
			.map((d) => {
				const offer = textOf(d.discountLabel, 200) ?? textOf(d.valueText, 200);
				const days = weekdaysOf(d.days, look);
				const from = clockText(d.timeFrom, look);
				const to = clockText(d.timeTo, look);
				const hours = from && to ? `${from}–${to}` : '';
				const when = [days, hours].filter(Boolean).join(' ');
				const badge = textOf(d.badgeLabel, 60);
				const minQuantity = countOf(d.minQuantity);
				return {
					name: textOf(d.name, 120),
					description: textOf(d.description, 300),
					...(offer ? { offer } : {}),
					...(badge ? { badge } : {}),
					...(minQuantity ? { minQuantity } : {}),
					...(when ? { when } : {}),
					endsAt: textOf(d.endsText, 60) ?? dateText(d.endsAt, look, 'datetime'),
				};
			})
			.filter((d) => d.name);
		return { content: deals.length > 0 ? { deals } : 'No deals are running right now.', products: [] };
	}
	if (name === SHOP_TOOLS.orders) {
		const orders = itemsOf(b.items)
			.filter(isObject)
			.slice(0, ORDERS_MAX)
			.map((o) => {
				const lines = itemsOf(o.lines)
					.filter(isObject)
					.slice(0, 20)
					.map((line) =>
						[
							textOf(line.name, 120),
							textOf(line.variantName, 120),
							textOf(line.gradeLabel, 60),
							countOf(line.quantity) !== null ? `× ${line.quantity}` : null,
							textOf(line.totalText, 60),
							timeOf(line.warrantyTime, look) ? `warranty ${timeOf(line.warrantyTime, look)}` : null,
						]
							.filter(Boolean)
							.join(' '),
					);
				const expected = dateText(o.expectedAt, look, 'date');
				const note = textOf(o.trackingNote, 300);
				const attachments = fieldsOf(o.attachments, (item) => {
					const url = pageUrl(item.url);
					const label = textOf(item.label, 60);
					return url && label ? `${label}: ${url}` : null;
				});
				const due = Number(o.balanceDue) > 0 ? priceOf(o, 'balanceDue', look) : null;
				const tracking = pageUrl(o.trackingUrl);
				const courier = textOf(o.courier, 80);
				const trackingNumber = textOf(o.trackingNumber, 80);
				const method = textOf(o.paymentMethod, 40);
				return {
					number: textOf(o.number, 40),
					status: textOf(o.status, 60),
					total: priceOf(o, 'total', look),
					placedAt: dateText(o.placedAt, look, 'date'),
					...(method ? { paymentMethod: method } : {}),
					...(due ? { balanceDue: due } : {}),
					...(lines.length > 0 ? { items: lines } : {}),
					...(courier ? { courier } : {}),
					...(trackingNumber ? { trackingNumber } : {}),
					...(tracking ? { trackingLink: tracking } : {}),
					...(expected ? { expected } : {}),
					...(note ? { trackingNote: note } : {}),
					...(attachments.length > 0 ? { attachments } : {}),
				};
			});
		return {
			content: {
				name: textOf(b.name, 120),
				...extraOf(b.extraFields),
				orders: orders.length > 0 ? orders : 'No orders on this account yet.',
			},
			products: [],
		};
	}
	if (name === SHOP_TOOLS.account) {
		const firstName = textOf(b.firstName, 60);
		const city = textOf(b.city, 100);
		const region = textOf(b.region, 100);
		const country = textOf(b.country, 60);
		return {
			content: {
				name: textOf(b.name, 120),
				...(firstName ? { firstName } : {}),
				...(city ? { city } : {}),
				...(region ? { region } : {}),
				...(country ? { country } : {}),
				...extraOf(b.extraFields),
			},
			products: [],
		};
	}
	const shipments = itemsOf(b.items)
		.filter(isObject)
		.slice(0, 10)
		.map((s) => {
			const note = textOf(s.trackingNote, 300);
			const expected = dateText(s.expectedAt, look, 'date');
			return {
				orderNumber: textOf(s.orderNumber, 40),
				courier: textOf(s.courier, 80),
				trackingNumber: textOf(s.trackingNumber, 80),
				trackingLink: pageUrl(s.trackingUrl),
				status: textOf(s.status, 120),
				...(note ? { trackingNote: note } : {}),
				...(expected ? { expected } : {}),
			};
		});
	return { content: shipments.length > 0 ? { shipments } : 'No shipments on this account yet.', products: [] };
};

/**
 * The context panel's shop info from `GET /v1/customers/<userId>/orders`: number, the status label (statuses are
 * merchant-defined) and the total of the last orders (Ecommerce's `totalText`, else the total in the website's
 * Format), and the loyalty points. `createdAt` stays the raw time.
 * @param {unknown} body
 * @param {Look} [look] the website's Format
 * @returns {ShopInfo}
 */
export const shopInfoOf = (body, look = {}) => {
	const b = isObject(body) ? body : {};
	return {
		orders: itemsOf(b.items)
			.filter(isObject)
			.slice(0, CONTEXT_ORDERS_MAX)
			.map((o) => ({
				number: textOf(o.number, 40) ?? '',
				status: textOf(o.statusLabel, 60) ?? textOf(o.status, 60) ?? '',
				total:
					textOf(o.totalText, 40) ??
					(isAmount(o.total) && isCurrency(o.currency) ? moneyText(Number(o.total), o.currency, look) : ''),
				createdAt: textOf(o.createdAt, 40),
			})),
		loyaltyPoints: countOf(b.loyaltyPoints),
	};
};

/**
 * The context panel's request for a signed-in visitor: their latest orders, as many as the setting `orders` of
 * `context_panel` asks (C22).
 * @param {string} userId
 * @param {number} [orders]
 */
export const customerOrdersPath = (userId, orders = SHOP_LIMIT) =>
	`/v1/customers/${encodeURIComponent(userId)}/orders?limit=${countIn(orders, SHOP_LIMIT, CONTEXT_ORDERS_MAX)}`;
