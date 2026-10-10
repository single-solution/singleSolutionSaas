/**
 * The shop tools, track shipment, product cards and the context panel's shop info (PLAN 0.8.3 Shop tools, Context
 * panel; pure): the single list of the Ecommerce endpoints Chat calls (written in Chat's docs first; Ecommerce
 * implements exactly these), the tool schemas the AI sees, the request each tool call makes, and what of each answer the
 * AI, the cards and the context panel get. Chat calls Ecommerce with the pasted Ecommerce server token; the tools only
 * read. My orders, account and track shipment run only for a visitor whose Accounts sign-in Chat verified on that
 * request: Chat forwards it in the `SS-Sign-In` header and Ecommerce verifies it itself and answers only that user's
 * data. The AI never chooses the user, the website or the token: those tools take no arguments, and whatever the model
 * passes is ignored. Only whitelisted fields are kept, so no street address or phone number ever reaches the AI.
 * Prices and dates in what the AI and the context panel get follow the website's Format and business time zone
 * (PLAN 0.8.10 K7), so the chat answers show them as the website does.
 * @module
 */
import { formatDate, formatMoney } from '@ss/contracts/format';

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

/** Most products one search or top list asks for, and most cards under one answer. */
export const SHOP_LIMIT = 5;

/** Most deals one list asks for. */
const DEALS_LIMIT = 10;

/** Orders shown in the context panel. */
const CONTEXT_ORDERS = 5;

/** The tool answer when Ecommerce cannot be asked (not connected, token refused, stopped, unreachable). */
export const SHOP_UNAVAILABLE =
	'This cannot be looked up right now. Tell the visitor you cannot look this up right now, and offer other help.';

/**
 * One row per tool: the tool, the feature it belongs to, whether it needs the visitor's verified sign-in, and the
 * Ecommerce request it makes (server token).
 */
export const SHOP_ENDPOINTS = Object.freeze([
	{ tool: SHOP_TOOLS.search, feature: 'shop_search', signIn: false, request: 'GET /v1/chat/products?q=<text>&limit=5' },
	{ tool: SHOP_TOOLS.details, feature: 'shop_search', signIn: false, request: 'GET /v1/chat/products/<productId>' },
	{ tool: SHOP_TOOLS.quote, feature: 'shop_deals', signIn: false, request: 'GET /v1/chat/products/<productId>/quote' },
	{ tool: SHOP_TOOLS.deals, feature: 'shop_deals', signIn: false, request: 'GET /v1/chat/deals?limit=10' },
	{ tool: SHOP_TOOLS.top, feature: 'shop_top', signIn: false, request: 'GET /v1/chat/products/top?kind=top|new&limit=5' },
	{ tool: SHOP_TOOLS.orders, feature: 'shop_my_orders', signIn: true, request: 'GET /v1/chat/me/orders?limit=5 (SS-Sign-In)' },
	{ tool: SHOP_TOOLS.account, feature: 'shop_my_orders', signIn: true, request: 'GET /v1/chat/me/account (SS-Sign-In)' },
	{ tool: SHOP_TOOLS.track, feature: 'track_shipment', signIn: true, request: 'GET /v1/chat/me/shipments (SS-Sign-In)' },
]);

/** The request of the context panel's shop info (server token; the conversation's signed-in visitor). */
export const CONTEXT_ENDPOINT = Object.freeze({
	feature: 'context_panel',
	request: 'GET /v1/customers/<userId>/orders?limit=5',
});

/** What each answer carries (product cards use the product fields). */
export const SHOP_ANSWERS = Object.freeze({
	product:
		'id, name, price (integer minor units), currency, image (https or null), url (the product page), inStock, variantId (or null)',
	details: 'a product plus summary, description, brand, options, specs',
	quote: 'productId, price, priceAfterDeals, savings, currency, deals: [name]',
	deals: 'items: [{ id, name, description, endsAt }]',
	orders: 'items: [{ number, status, total, currency, placedAt }] (the last 5), loyaltyPoints, name',
	account: 'name, loyaltyPoints',
	shipments: 'items: [{ orderNumber, courier, trackingNumber, trackingUrl, status }]',
	customerOrders: 'items: [{ id, number, status, statusLabel, total, totalText, currency, createdAt }], loyaltyPoints',
});

/** Tool names the merchant's webhook tools may not take. */
export const SHOP_TOOL_NAMES = Object.freeze(Object.values(SHOP_TOOLS));

/** @typedef {import('./providers.js').ToolSchema} ToolSchema */
/**
 * A product as Ecommerce answers it (only these fields are kept).
 * @typedef {object} ShopProduct
 * @property {string} id
 * @property {string} name
 * @property {number} price integer minor units
 * @property {string} currency ISO 4217
 * @property {string | null} image https
 * @property {string | null} url the product page
 * @property {boolean} inStock
 * @property {string | null} variantId
 */
/**
 * A product card saved on an AI message.
 * @typedef {object} ProductCard
 * @property {string} productId
 * @property {string | null} variantId
 * @property {string} name
 * @property {number} price integer minor units
 * @property {string} currency
 * @property {string | null} image https
 * @property {string | null} url the product page
 * @property {boolean} inStock
 */
/**
 * The website's Format and business time zone (from the server's `product.format(websiteId)`).
 * @typedef {{ format?: Partial<import('@ss/contracts/format').Format>, timeZone?: string }} Look
 */
/**
 * The context panel's shop info.
 * @typedef {{ orders: Array<{ number: string, status: string, total: string, createdAt: string | null }>, loyaltyPoints: number | null }} ShopInfo
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} value @param {number} max */
const textOf = (value, max) => {
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	if (typeof value !== 'string' || value.trim() === '') return null;
	const trimmed = value.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

/** @param {unknown} value */
const isMinor = (value) => Number.isSafeInteger(value) && Number(value) >= 0;

/** @param {unknown} value @returns {value is string} */
const isCurrency = (value) => typeof value === 'string' && /^[A-Z]{3}$/.test(value);

/** @param {unknown} value */
const isHttpsUrl = (value) =>
	typeof value === 'string' && value.length <= 500 && /^https:\/\/[^\s/?#]+(?:[/?#]\S*)?$/.test(value);

/** An http(s) page address, else null. @param {unknown} value */
const pageUrl = (value) =>
	typeof value === 'string' && value.length <= 500 && /^https?:\/\/[^\s/?#]+\S*$/.test(value) ? value : null;

/** @param {unknown} value */
const countOf = (value) => (Number.isSafeInteger(value) ? Number(value) : null);

/**
 * An amount in minor units for people, in the website's Format (`125000`, `PKR` → `PKR 1,250.00` by default).
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
	if (!id || !name || !isMinor(raw.price) || !isCurrency(raw.currency)) return null;
	return {
		id,
		name,
		price: Number(raw.price),
		currency: raw.currency,
		image: isHttpsUrl(raw.image) ? String(raw.image) : null,
		url: pageUrl(raw.url),
		inStock: raw.inStock === true,
		variantId: textOf(raw.variantId, 100),
	};
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
	currency: product.currency,
	image: product.image,
	url: product.url,
	inStock: product.inStock,
});

/**
 * Cards saved on a message, checked again (they are shown to visitors).
 * @param {unknown} raw
 * @returns {ProductCard[]}
 */
export const cardsOf = (raw) =>
	(Array.isArray(raw) ? raw : [])
		.slice(0, SHOP_LIMIT)
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

/** @type {Record<string, ToolSchema>} */
const SCHEMAS = {
	[SHOP_TOOLS.search]: schema(
		SHOP_TOOLS.search,
		'Search the live shop catalog by name, brand, model or kind of product. Returns matching products with price, stock, link and id. Use it for any product, price or availability question.',
		{ query: { type: 'string', description: 'What to search for, e.g. a product name or brand.' } },
		['query'],
	),
	[SHOP_TOOLS.details]: schema(
		SHOP_TOOLS.details,
		'Get the full details of ONE product you already found: summary, description, brand, options and specs, with price and stock.',
		{ productId: PRODUCT_ID },
		['productId'],
	),
	[SHOP_TOOLS.quote]: schema(
		SHOP_TOOLS.quote,
		'Quote ONE product’s price after the active deals: the price, the price after deals, the saving and the deals that apply.',
		{ productId: PRODUCT_ID },
		['productId'],
	),
	[SHOP_TOOLS.deals]: schema(
		SHOP_TOOLS.deals,
		'List the active deals with their description and end date. Never invent offers that are not returned here.',
	),
	[SHOP_TOOLS.top]: schema(SHOP_TOOLS.top, 'List the best-selling products (kind "top") or the newest arrivals (kind "new").', {
		kind: { type: 'string', enum: ['top', 'new'], description: '"top" (default) or "new".' },
	}),
	[SHOP_TOOLS.orders]: schema(
		SHOP_TOOLS.orders,
		'Look up the signed-in visitor’s own last orders (number, status, total, date), loyalty points and name. Only for questions about their own orders.',
	),
	[SHOP_TOOLS.account]: schema(SHOP_TOOLS.account, 'Get the signed-in visitor’s own name and loyalty points balance.'),
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

/** @param {unknown} value */
const productId = (value) => (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value.trim()) ? value.trim() : null);

/**
 * The Ecommerce request of a tool call (only public inputs come from the model).
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {{ ok: true, path: string, signIn: boolean } | { ok: false, content: string }}
 */
export const shopRequest = (name, args) => {
	const row = SHOP_ENDPOINTS.find((r) => r.tool === name);
	if (!row) return { ok: false, content: 'No such tool.' };
	if (name === SHOP_TOOLS.search) {
		const query = typeof args.query === 'string' ? args.query.trim().slice(0, 100) : '';
		if (!query) return { ok: false, content: 'Say what to search for.' };
		return { ok: true, signIn: false, path: `/v1/chat/products?q=${encodeURIComponent(query)}&limit=${SHOP_LIMIT}` };
	}
	if (name === SHOP_TOOLS.details || name === SHOP_TOOLS.quote) {
		const id = productId(args.productId);
		if (!id) return { ok: false, content: 'Give the product id from a search result.' };
		const path = `/v1/chat/products/${encodeURIComponent(id)}`;
		return { ok: true, signIn: false, path: name === SHOP_TOOLS.quote ? `${path}/quote` : path };
	}
	if (name === SHOP_TOOLS.deals) return { ok: true, signIn: false, path: `/v1/chat/deals?limit=${DEALS_LIMIT}` };
	if (name === SHOP_TOOLS.top)
		return {
			ok: true,
			signIn: false,
			path: `/v1/chat/products/top?kind=${args.kind === 'new' ? 'new' : 'top'}&limit=${SHOP_LIMIT}`,
		};
	if (name === SHOP_TOOLS.orders) return { ok: true, signIn: true, path: `/v1/chat/me/orders?limit=${SHOP_LIMIT}` };
	if (name === SHOP_TOOLS.account) return { ok: true, signIn: true, path: '/v1/chat/me/account' };
	return { ok: true, signIn: true, path: '/v1/chat/me/shipments' };
};

/** @param {ShopProduct} p @param {Look} look */
const productLine = (p, look) => ({
	id: p.id,
	name: p.name,
	price: moneyText(p.price, p.currency, look),
	inStock: p.inStock,
	...(p.url ? { link: p.url } : {}),
});

/** @param {unknown} list */
const itemsOf = (list) => (Array.isArray(list) ? list : []);

/** @param {unknown} value */
const listOfTexts = (value) =>
	itemsOf(value)
		.map((item) => textOf(isObject(item) ? (item.name ?? item.value) : item, 120))
		.filter(Boolean)
		.slice(0, 20);

/** @param {unknown} value */
const specsOf = (value) => {
	if (Array.isArray(value))
		return value
			.filter(isObject)
			.slice(0, 30)
			.map((spec) => `${textOf(spec.name ?? spec.label, 80) ?? ''}: ${textOf(spec.value, 200) ?? ''}`);
	if (isObject(value))
		return Object.entries(value)
			.slice(0, 30)
			.map(([key, v]) => `${key.slice(0, 80)}: ${textOf(v, 200) ?? ''}`);
	return [];
};

/** @param {unknown} value */
const optionsOf = (value) =>
	itemsOf(value)
		.filter(isObject)
		.slice(0, 10)
		.map((option) => ({ name: textOf(option.name, 80), values: listOfTexts(option.values) }));

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
			.slice(0, SHOP_LIMIT);
		if (products.length === 0)
			return { content: 'Nothing in the catalog matched. Do not invent products; suggest another search.', products };
		return { content: { products: products.map((p) => productLine(p, look)) }, products };
	}
	if (name === SHOP_TOOLS.details) {
		const product = productOf(b);
		if (!product) return { content: 'No such product. Do not invent details.', products: [] };
		return {
			content: {
				...productLine(product, look),
				brand: textOf(b.brand, 120),
				summary: textOf(b.summary, 500),
				description: textOf(b.description, 1500),
				options: optionsOf(b.options),
				specs: specsOf(b.specs),
			},
			products: [product],
		};
	}
	if (name === SHOP_TOOLS.quote) {
		if (!isCurrency(b.currency) || !isMinor(b.price) || !isMinor(b.priceAfterDeals))
			return { content: 'No quote for this product. Do not invent prices.', products: [] };
		return {
			content: {
				productId: textOf(b.productId, 100),
				price: moneyText(Number(b.price), b.currency, look),
				priceAfterDeals: moneyText(Number(b.priceAfterDeals), b.currency, look),
				savings: moneyText(isMinor(b.savings) ? Number(b.savings) : 0, b.currency, look),
				deals: listOfTexts(b.deals),
			},
			products: [],
		};
	}
	if (name === SHOP_TOOLS.deals) {
		const deals = itemsOf(b.items)
			.filter(isObject)
			.slice(0, DEALS_LIMIT)
			.map((d) => ({
				name: textOf(d.name, 120),
				description: textOf(d.description, 300),
				endsAt: dateText(d.endsAt, look, 'datetime'),
			}))
			.filter((d) => d.name);
		return { content: deals.length > 0 ? { deals } : 'No deals are running right now.', products: [] };
	}
	if (name === SHOP_TOOLS.orders) {
		const orders = itemsOf(b.items)
			.filter(isObject)
			.slice(0, SHOP_LIMIT)
			.map((o) => ({
				number: textOf(o.number, 40),
				status: textOf(o.status, 60),
				total: isMinor(o.total) && isCurrency(o.currency) ? moneyText(Number(o.total), o.currency, look) : null,
				placedAt: dateText(o.placedAt, look, 'date'),
			}));
		return {
			content: {
				name: textOf(b.name, 120),
				loyaltyPoints: countOf(b.loyaltyPoints),
				orders: orders.length > 0 ? orders : 'No orders on this account yet.',
			},
			products: [],
		};
	}
	if (name === SHOP_TOOLS.account)
		return { content: { name: textOf(b.name, 120), loyaltyPoints: countOf(b.loyaltyPoints) }, products: [] };
	const shipments = itemsOf(b.items)
		.filter(isObject)
		.slice(0, 10)
		.map((s) => ({
			orderNumber: textOf(s.orderNumber, 40),
			courier: textOf(s.courier, 80),
			trackingNumber: textOf(s.trackingNumber, 80),
			trackingLink: pageUrl(s.trackingUrl),
			status: textOf(s.status, 120),
		}));
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
			.slice(0, CONTEXT_ORDERS)
			.map((o) => ({
				number: textOf(o.number, 40) ?? '',
				status: textOf(o.statusLabel, 60) ?? textOf(o.status, 60) ?? '',
				total:
					textOf(o.totalText, 40) ??
					(isMinor(o.total) && isCurrency(o.currency) ? moneyText(Number(o.total), o.currency, look) : ''),
				createdAt: textOf(o.createdAt, 40),
			})),
		loyaltyPoints: countOf(b.loyaltyPoints),
	};
};

/**
 * The context panel's request for a signed-in visitor.
 * @param {string} userId
 */
export const customerOrdersPath = (userId) => `/v1/customers/${encodeURIComponent(userId)}/orders?limit=${CONTEXT_ORDERS}`;
