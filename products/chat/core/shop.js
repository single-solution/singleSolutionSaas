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
 * (PLAN 0.8.10 K7), so the chat answers show them as the website does: Ecommerce's `priceText` when it sends one. The
 * fuller lookups (C13, Ecommerce E37) pass the category, grade, price and stock filters and answer grades, variants,
 * stock left, warranty, quotes per variant and payment method, order lines and the store context (C1).
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

/** Products one top list asks for, and the default of a search (setting `maxResults` of `shop_search`, 1–12). */
export const SHOP_LIMIT = 5;

/** Most products one search asks for, and most cards under one answer (C13). */
export const SHOP_MAX = 12;

/** Most units one quote asks for (C13). */
const QUOTE_MAX_QUANTITY = 5;

/** The longest store context given to the AI (characters, C1). */
export const CONTEXT_MAX = 6000;

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
		request: 'GET /v1/chat/products/<productId>/quote?variantId=<id>&quantity=<1–5>&paymentMethod=<key>',
	},
	{ tool: SHOP_TOOLS.deals, feature: 'shop_deals', signIn: false, request: 'GET /v1/chat/deals?limit=10' },
	{ tool: SHOP_TOOLS.top, feature: 'shop_top', signIn: false, request: 'GET /v1/chat/products/top?kind=top|new&limit=5' },
	{ tool: SHOP_TOOLS.orders, feature: 'shop_my_orders', signIn: true, request: 'GET /v1/chat/me/orders?limit=5 (SS-Sign-In)' },
	{ tool: SHOP_TOOLS.account, feature: 'shop_my_orders', signIn: true, request: 'GET /v1/chat/me/account (SS-Sign-In)' },
	{ tool: SHOP_TOOLS.track, feature: 'track_shipment', signIn: true, request: 'GET /v1/chat/me/shipments (SS-Sign-In)' },
]);

/** The store context of an AI reply (C1, store context on; the visitor's verified sign-in forwarded when there is one). */
export const STORE_CONTEXT_ENDPOINT = Object.freeze({
	feature: 'shop_context',
	request: 'GET /v1/chat/context?productId=<the product of SSChat.setPage> (SS-Sign-In when signed in)',
});

/** The request of the context panel's shop info (server token; the conversation's signed-in visitor). */
export const CONTEXT_ENDPOINT = Object.freeze({
	feature: 'context_panel',
	request: 'GET /v1/customers/<userId>/orders?limit=5',
});

/** What each answer carries (product cards use the product fields). */
export const SHOP_ANSWERS = Object.freeze({
	product:
		'id, name, price (integer minor units), priceText, currency, image (https or null), url (the product page), inStock, variantId (or null), grade, stockLeft, category',
	details:
		'a product plus summary, description, brand, options, specs, warranty, variants: [{ id, options, price, priceText, grade, inStock, stockLeft, warranty }]',
	quote: 'productId, variantId, quantity, paymentMethod, price, priceAfterDeals, savings, fees, delivery, freeDeliveryThreshold, total (each with its …Text), currency, deals: [name]',
	deals: 'items: [{ id, name, description, endsAt, and display fields: offerText, appliesTo }]',
	orders:
		'items: [{ number, status, total, totalText, currency, placedAt, expectedAt, trackingNote, dispatchVideo, lines: [{ name, variant, quantity, totalText }] }] (the last 5), loyaltyPoints, name',
	account: 'name, loyaltyPoints, city, area',
	shipments: 'items: [{ orderNumber, courier, trackingNumber, trackingUrl, status }]',
	context:
		'text (at most 6,000 characters): the policies, the 10 newest products with grade prices, the deals table, the named product and, signed in, first name, city and points',
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
 * @property {string | null} priceText the price as the website shows it (Ecommerce, K7)
 * @property {string | null} grade
 * @property {number | null} stockLeft
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

/** A grade as text (`{ label }`, `{ name }` or a string), else null. @param {unknown} value */
const gradeOf = (value) => textOf(isObject(value) ? (value.label ?? value.name) : value, 60);

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
		priceText: textOf(raw.priceText, 60),
		grade: gradeOf(raw.grade),
		stockLeft: countOf(raw.stockLeft),
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

/** @type {Record<string, ToolSchema>} */
const SCHEMAS = {
	[SHOP_TOOLS.search]: schema(
		SHOP_TOOLS.search,
		'Search the live shop catalog by name, brand, model or kind of product, optionally within a category, a grade, a price range or only in stock. Returns matching products with price, grade, stock, link and id. Use it for any product, price, budget or availability question.',
		{
			query: { type: 'string', description: 'What to search for, e.g. a product name or brand (may be empty with a filter).' },
			category: { type: 'string', description: 'Only this category (its name).' },
			grade: { type: 'string', description: 'Only this grade or condition.' },
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
		'Get the full details of ONE product you already found: summary, description, brand, options, specs, warranty and its variants with grade, price and stock left.',
		{ productId: PRODUCT_ID },
		['productId'],
	),
	[SHOP_TOOLS.quote]: schema(
		SHOP_TOOLS.quote,
		'Quote ONE product’s price after the active deals, for a variant, a quantity and a payment method: the price, the price after deals, the saving, the fees, the delivery charge, the free-delivery threshold, the total and the deals that apply.',
		{
			productId: PRODUCT_ID,
			variantId: { type: 'string', description: 'The variant id from get_product_details (optional).' },
			quantity: { type: 'integer', description: 'How many (1–5, default 1).' },
			paymentMethod: { type: 'string', description: 'The payment method the visitor asks about, e.g. cod (optional).' },
		},
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
		'Look up the signed-in visitor’s own last orders (number, status, total, date, items, expected date, tracking note), loyalty points and name. Only for questions about their own orders.',
	),
	[SHOP_TOOLS.account]: schema(
		SHOP_TOOLS.account,
		'Get the signed-in visitor’s own name, loyalty points balance, city and area.',
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

/** @param {unknown} value */
const productId = (value) => (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value.trim()) ? value.trim() : null);

/** @param {unknown} value @param {number} max */
const word = (value, max) => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null);

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
 * @param {{ limit?: number, minor?: (amount: number) => number }} [options] `limit`: products per search (1–12)
 * @returns {{ ok: true, path: string, signIn: boolean } | { ok: false, content: string }}
 */
export const shopRequest = (name, args, { limit = SHOP_LIMIT, minor = (amount) => Math.round(amount * 100) } = {}) => {
	const row = SHOP_ENDPOINTS.find((r) => r.tool === name);
	if (!row) return { ok: false, content: 'No such tool.' };
	if (name === SHOP_TOOLS.search) {
		const query = new URLSearchParams();
		const q = word(args.query, 100);
		if (q) query.set('q', q);
		const category = word(args.category, 100);
		if (category) query.set('category', category);
		const grade = word(args.grade, 60);
		if (grade) query.set('grade', grade);
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
		const variant = productId(args.variantId);
		if (variant) query.set('variantId', variant);
		const quantity = Number(args.quantity);
		if (Number.isInteger(quantity) && quantity > 0) query.set('quantity', String(Math.min(QUOTE_MAX_QUANTITY, quantity)));
		const method =
			typeof args.paymentMethod === 'string' && /^[a-z0-9_]{1,40}$/i.test(args.paymentMethod.trim())
				? args.paymentMethod.trim()
				: null;
		if (method) query.set('paymentMethod', method);
		const search = query.toString();
		return { ok: true, signIn: false, path: `${path}/quote${search ? `?${search}` : ''}` };
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

/**
 * The store context request (C1): the product the visitor is viewing, when there is one.
 * @param {string | null | undefined} viewing the product id of `SSChat.setPage`
 */
export const contextPath = (viewing) => {
	const id = productId(viewing);
	return id ? `/v1/chat/context?productId=${encodeURIComponent(id)}` : '/v1/chat/context';
};

/**
 * The store context the AI gets (C1): Ecommerce's `text`, else its answer as compact JSON; at most 6,000 characters.
 * @param {unknown} body
 * @returns {string | null}
 */
export const contextText = (body) => {
	if (!isObject(body)) return null;
	const text =
		typeof body.text === 'string' ? body.text : typeof body.context === 'string' ? body.context : JSON.stringify(body);
	const trimmed = text.trim();
	if (trimmed === '' || trimmed === '{}') return null;
	return trimmed.length > CONTEXT_MAX ? `${trimmed.slice(0, CONTEXT_MAX - 1)}…` : trimmed;
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
	return isMinor(b[key]) && isCurrency(b.currency) ? moneyText(Number(b[key]), b.currency, look) : null;
};

/** @param {ShopProduct} p @param {Look} look */
const productLine = (p, look) => ({
	id: p.id,
	name: p.name,
	price: p.priceText ?? moneyText(p.price, p.currency, look),
	inStock: p.inStock,
	...(p.grade ? { grade: p.grade } : {}),
	...(p.stockLeft !== null ? { stockLeft: p.stockLeft } : {}),
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
			.map(
				(spec) =>
					`${textOf(spec.name ?? spec.label, 80) ?? ''}: ${textOf(spec.value, 200) ?? ''}${spec.unit ? ` ${textOf(spec.unit, 20)}` : ''}`,
			);
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

/** A warranty as text (`{ text }`, `{ label }`, `{ months }` or a string), else null. @param {unknown} value */
const warrantyOf = (value) => {
	if (isObject(value)) return textOf(value.text ?? value.label ?? (value.months ? `${value.months} months` : null), 200);
	return textOf(value, 200);
};

/** @param {unknown} value */
const variantOptions = (value) =>
	isObject(value)
		? Object.entries(value)
				.slice(0, 10)
				.map(([key, v]) => `${key.slice(0, 40)}: ${textOf(v, 80) ?? ''}`)
				.join(', ')
		: textOf(value, 200);

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
				const grade = gradeOf(v.grade);
				const stockLeft = countOf(v.stockLeft);
				const warranty = warrantyOf(v.warranty);
				return {
					id: textOf(v.id, 100),
					options: variantOptions(v.options),
					price: priceOf({ ...v, currency: product.currency }, 'price', look),
					...(grade ? { grade } : {}),
					inStock: v.inStock !== false,
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
				...(warrantyOf(b.warranty) ? { warranty: warrantyOf(b.warranty) } : {}),
				...(variants.length > 0 ? { variants } : {}),
			},
			products: [product],
		};
	}
	if (name === SHOP_TOOLS.quote) {
		if (!isCurrency(b.currency) || !isMinor(b.price) || !isMinor(b.priceAfterDeals))
			return { content: 'No quote for this product. Do not invent prices.', products: [] };
		/** @type {Record<string, unknown>} */
		const content = {
			productId: textOf(b.productId, 100),
			...(textOf(b.variantId, 100) ? { variantId: textOf(b.variantId, 100) } : {}),
			...(countOf(b.quantity) !== null ? { quantity: countOf(b.quantity) } : {}),
			...(textOf(b.paymentMethod, 60) ? { paymentMethod: textOf(b.paymentMethod, 60) } : {}),
			price: priceOf(b, 'price', look),
			priceAfterDeals: priceOf(b, 'priceAfterDeals', look),
			savings: priceOf(b, 'savings', look) ?? moneyText(0, b.currency, look),
			deals: listOfTexts(b.deals),
		};
		for (const key of ['fees', 'delivery', 'freeDeliveryThreshold', 'total']) {
			const text = priceOf(b, key, look);
			if (text) content[key] = text;
		}
		return { content, products: [] };
	}
	if (name === SHOP_TOOLS.deals) {
		const deals = itemsOf(b.items)
			.filter(isObject)
			.slice(0, DEALS_LIMIT)
			.map((d) => ({
				name: textOf(d.name, 120),
				description: textOf(d.description, 300),
				...(textOf(d.offerText, 200) ? { offer: textOf(d.offerText, 200) } : {}),
				...(textOf(d.appliesTo, 200) ? { appliesTo: textOf(d.appliesTo, 200) } : {}),
				endsAt: dateText(d.endsAt, look, 'datetime'),
			}))
			.filter((d) => d.name);
		return { content: deals.length > 0 ? { deals } : 'No deals are running right now.', products: [] };
	}
	if (name === SHOP_TOOLS.orders) {
		const orders = itemsOf(b.items)
			.filter(isObject)
			.slice(0, SHOP_LIMIT)
			.map((o) => {
				const lines = itemsOf(o.lines)
					.filter(isObject)
					.slice(0, 20)
					.map((line) =>
						[
							textOf(line.name, 120),
							textOf(line.variant, 120),
							countOf(line.quantity) !== null ? `× ${line.quantity}` : null,
							textOf(line.totalText ?? line.priceText, 60),
						]
							.filter(Boolean)
							.join(' '),
					);
				const expected = dateText(o.expectedAt ?? o.expectedDate, look, 'date');
				const note = textOf(o.trackingNote, 300);
				const video = pageUrl(o.dispatchVideo);
				return {
					number: textOf(o.number, 40),
					status: textOf(o.status, 60),
					total: priceOf(o, 'total', look),
					placedAt: dateText(o.placedAt, look, 'date'),
					...(lines.length > 0 ? { items: lines } : {}),
					...(expected ? { expected } : {}),
					...(note ? { trackingNote: note } : {}),
					...(video ? { dispatchVideo: video } : {}),
				};
			});
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
		return {
			content: {
				name: textOf(b.name, 120),
				loyaltyPoints: countOf(b.loyaltyPoints),
				...(textOf(b.city, 80) ? { city: textOf(b.city, 80) } : {}),
				...(textOf(b.area, 80) ? { area: textOf(b.area, 80) } : {}),
			},
			products: [],
		};
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
