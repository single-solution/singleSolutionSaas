/**
 * Request validation (pure): field problems `{ path, code }` with JSON-pointer paths, turned into RFC 9457
 * `validation_failed` by api/. Bounds that a merchant can change come in as arguments (from the feature schemas);
 * the fixed bounds here are the API contract (documented in openapi.json).
 * @module
 */
import { isAmount } from './money.js';
import { normaliseAttributes } from './scope.js';

/** @typedef {{ path: string, code: string }} FieldProblem */

/** Opaque ids (item, variant, line, order, customer…): printable, no spaces, ≤ 128 chars. */
export const ID_PATTERN = /^[\x21-\x7e]{1,128}$/;
/** Merchant-defined keys (payment/delivery methods, segments, classes, attribute names). */
export const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
/** Attribute names double as catalog paths, so no `.` or `$`. */
export const ATTRIBUTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** ISO-4217 currency code. */
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;
/** Max lines of a cart / items of an offers request (the contracts' order/cart line limit). */
export const MAX_LINES = 500;

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Body must be an object with known fields and the required ones present.
 * @param {unknown} body
 * @param {Record<string, unknown>} known field names (values unused)
 * @param {string[]} required
 * @param {string} [at] path prefix
 * @returns {FieldProblem[]}
 */
export const checkFields = (body, known, required, at = '') => {
	if (!isObject(body)) return [{ path: at, code: 'body_invalid' }];
	/** @type {FieldProblem[]} */
	const problems = [];
	for (const key of Object.keys(body))
		if (!Object.hasOwn(known, key)) problems.push({ path: `${at}/${key}`, code: 'unknown_field' });
	for (const key of required)
		if (body[key] === undefined || body[key] === null) problems.push({ path: `${at}/${key}`, code: 'required' });
	return problems;
};

/** @param {unknown} value */
export const idCheck = (value) => (typeof value === 'string' && ID_PATTERN.test(value) ? null : 'id_invalid');
/** @param {unknown} value */
export const keyCheck = (value) => (typeof value === 'string' && KEY_PATTERN.test(value) ? null : 'key_invalid');
/**
 * @param {unknown} value
 * @param {number} max
 */
export const textCheck = (value, max) =>
	typeof value === 'string' && value.trim().length > 0 && value.length <= max ? null : 'text_invalid';
/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 */
export const intCheck = (value, min, max) =>
	Number.isSafeInteger(value) && /** @type {number} */ (value) >= min && /** @type {number} */ (value) <= max
		? null
		: 'integer_invalid';

/**
 * Push a problem when `code` is not null.
 * @param {FieldProblem[]} problems
 * @param {string} path
 * @param {string | null} code
 */
export const push = (problems, path, code) => {
	if (code) problems.push({ path, code });
};

/**
 * A list of keys/ids (unique, bounded).
 * @param {unknown} value
 * @param {number} max
 * @param {(v: unknown) => string | null} each
 * @returns {string | null}
 */
export const listCheck = (value, max, each) => {
	if (!Array.isArray(value) || value.length > max || new Set(value).size !== value.length) return 'list_invalid';
	return value.every((v) => each(v) === null) ? null : 'list_invalid';
};

/**
 * Attributes object: `{ name: value | value[] }` with valid names and short values.
 * @param {unknown} value
 * @returns {string | null}
 */
export const attributesCheck = (value) => {
	if (!isObject(value)) return 'object_invalid';
	const entries = Object.entries(value);
	if (entries.length > 50) return 'too_many';
	for (const [name, raw] of entries) {
		if (!ATTRIBUTE_PATTERN.test(name)) return 'attribute_invalid';
		const values = Array.isArray(raw) ? raw : [raw];
		if (values.length > 50 || values.some((v) => !(typeof v === 'string' || typeof v === 'number') || String(v).length > 200))
			return 'attribute_invalid';
	}
	return null;
};

const LINE_FIELDS = {
	lineId: 1,
	itemId: 1,
	variantId: 1,
	quantity: 1,
	unitAmount: 1,
	attributes: 1,
	collections: 1,
	brand: 1,
};

/**
 * One line of a cart or offers request.
 * @param {unknown} line
 * @param {string} at
 * @param {{ unitAmountRequired: boolean }} options
 * @returns {FieldProblem[]}
 */
export const validateLine = (line, at, { unitAmountRequired }) => {
	const problems = checkFields(line, LINE_FIELDS, unitAmountRequired ? ['itemId', 'quantity', 'unitAmount'] : ['itemId'], at);
	if (!isObject(line)) return problems;
	if (line.itemId !== undefined) push(problems, `${at}/itemId`, idCheck(line.itemId));
	for (const key of ['lineId', 'variantId'])
		if (line[key] !== undefined && line[key] !== null) push(problems, `${at}/${key}`, idCheck(line[key]));
	if (line.quantity !== undefined) push(problems, `${at}/quantity`, intCheck(line.quantity, 1, 1_000_000));
	if (line.unitAmount !== undefined && !isAmount(line.unitAmount))
		problems.push({ path: `${at}/unitAmount`, code: 'amount_invalid' });
	if (line.attributes !== undefined) push(problems, `${at}/attributes`, attributesCheck(line.attributes));
	if (line.collections !== undefined) push(problems, `${at}/collections`, listCheck(line.collections, 100, idCheck));
	if (line.brand !== undefined && line.brand !== null) push(problems, `${at}/brand`, idCheck(line.brand));
	return problems;
};

const CUSTOMER_FIELDS = { id: 1, segments: 1, orders: 1, tags: 1 };

/**
 * The customer context of a quote (server keys only — browsers are identified by `SS-Identity`).
 * @param {unknown} customer
 * @returns {FieldProblem[]}
 */
export const validateCustomer = (customer) => {
	const problems = checkFields(customer, CUSTOMER_FIELDS, [], '/customer');
	if (!isObject(customer)) return problems;
	if (customer.id !== undefined) push(problems, '/customer/id', idCheck(customer.id));
	if (customer.segments !== undefined) push(problems, '/customer/segments', listCheck(customer.segments, 50, keyCheck));
	if (customer.tags !== undefined) push(problems, '/customer/tags', listCheck(customer.tags, 50, keyCheck));
	if (customer.orders !== undefined) push(problems, '/customer/orders', intCheck(customer.orders, 0, 1_000_000_000));
	return problems;
};

const QUOTE_FIELDS = {
	currency: 1,
	lines: 1,
	customer: 1,
	paymentMethod: 1,
	deliveryMethod: 1,
	shippingAmount: 1,
	locks: 1,
	cartId: 1,
};

/**
 * `POST /v1/quotes`.
 * @param {unknown} body
 * @param {{ maxLines: number }} limits
 * @returns {FieldProblem[]}
 */
export const validateQuote = (body, { maxLines }) => {
	const problems = checkFields(body, QUOTE_FIELDS, ['currency', 'lines']);
	if (!isObject(body)) return problems;
	if (body.currency !== undefined && !(typeof body.currency === 'string' && CURRENCY_PATTERN.test(body.currency)))
		problems.push({ path: '/currency', code: 'currency_invalid' });
	if (body.lines !== undefined) {
		if (!Array.isArray(body.lines) || body.lines.length === 0 || body.lines.length > Math.min(maxLines, MAX_LINES))
			problems.push({ path: '/lines', code: 'lines_invalid' });
		else {
			body.lines.forEach((line, index) =>
				problems.push(...validateLine(line, `/lines/${index}`, { unitAmountRequired: true })),
			);
			const ids = body.lines.map((line, index) =>
				isObject(line) && typeof line.lineId === 'string' ? line.lineId : `#${index}`,
			);
			if (new Set(ids).size !== ids.length) problems.push({ path: '/lines', code: 'line_ids_not_unique' });
		}
	}
	if (body.customer !== undefined) problems.push(...validateCustomer(body.customer));
	for (const key of ['paymentMethod', 'deliveryMethod'])
		if (body[key] !== undefined && body[key] !== null) push(problems, `/${key}`, keyCheck(body[key]));
	if (body.shippingAmount !== undefined && !isAmount(body.shippingAmount))
		problems.push({ path: '/shippingAmount', code: 'amount_invalid' });
	if (body.cartId !== undefined) push(problems, '/cartId', idCheck(body.cartId));
	if (body.locks !== undefined)
		push(
			problems,
			'/locks',
			Array.isArray(body.locks) &&
				body.locks.length <= MAX_LINES &&
				body.locks.every((t) => typeof t === 'string' && t.length <= 2048)
				? null
				: 'locks_invalid',
		);
	return problems;
};

const OFFERS_FIELDS = { currency: 1, items: 1, customer: 1, lock: 1 };

/**
 * `POST /v1/offers:evaluate` and `POST /v1/price-locks`.
 * @param {unknown} body
 * @param {{ maxItems: number }} limits
 * @returns {FieldProblem[]}
 */
export const validateOffers = (body, { maxItems }) => {
	const problems = checkFields(body, OFFERS_FIELDS, ['items']);
	if (!isObject(body)) return problems;
	if (body.currency !== undefined && !(typeof body.currency === 'string' && CURRENCY_PATTERN.test(body.currency)))
		problems.push({ path: '/currency', code: 'currency_invalid' });
	if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > Math.min(maxItems, MAX_LINES))
		problems.push({ path: '/items', code: 'items_invalid' });
	else
		body.items.forEach((item, index) => problems.push(...validateLine(item, `/items/${index}`, { unitAmountRequired: false })));
	if (body.customer !== undefined) problems.push(...validateCustomer(body.customer));
	if (body.lock !== undefined && typeof body.lock !== 'boolean') problems.push({ path: '/lock', code: 'boolean_invalid' });
	return problems;
};

const VARIANT_FIELDS = { variantId: 1, title: 1, price: 1, cost: 1, stock: 1, attributes: 1 };
const ITEM_FIELDS = {
	itemId: 1,
	title: 1,
	brand: 1,
	collections: 1,
	attributes: 1,
	price: 1,
	cost: 1,
	currency: 1,
	stock: 1,
	url: 1,
	image: 1,
	variants: 1,
};

/**
 * A synced catalog item (`PUT /v1/items/{itemId}`, `POST /v1/items:batch`, `item.*` events).
 * @param {unknown} item
 * @param {{ at?: string, requireId?: boolean, maxVariants: number }} options
 * @returns {FieldProblem[]}
 */
export const validateItem = (item, { at = '', requireId = true, maxVariants }) => {
	const problems = checkFields(item, ITEM_FIELDS, requireId ? ['itemId'] : [], at);
	if (!isObject(item)) return problems;
	if (item.itemId !== undefined) push(problems, `${at}/itemId`, idCheck(item.itemId));
	if (item.title !== undefined) push(problems, `${at}/title`, textCheck(item.title, 300));
	if (item.brand !== undefined && item.brand !== null) push(problems, `${at}/brand`, idCheck(item.brand));
	if (item.collections !== undefined) push(problems, `${at}/collections`, listCheck(item.collections, 100, idCheck));
	if (item.attributes !== undefined) push(problems, `${at}/attributes`, attributesCheck(item.attributes));
	for (const key of ['price', 'cost', 'stock'])
		if (item[key] !== undefined && item[key] !== null && !isAmount(item[key]))
			problems.push({ path: `${at}/${key}`, code: 'amount_invalid' });
	if (item.currency !== undefined && !(typeof item.currency === 'string' && CURRENCY_PATTERN.test(item.currency)))
		problems.push({ path: `${at}/currency`, code: 'currency_invalid' });
	for (const key of ['url', 'image'])
		if (
			item[key] !== undefined &&
			item[key] !== null &&
			!(typeof item[key] === 'string' && /^(?:https:\/\/|\/)[^\s<>"]{0,2047}$/.test(item[key]))
		)
			problems.push({ path: `${at}/${key}`, code: 'url_invalid' });
	if (item.variants !== undefined) {
		if (!Array.isArray(item.variants) || item.variants.length > maxVariants)
			problems.push({ path: `${at}/variants`, code: 'variants_invalid' });
		else
			item.variants.forEach((variant, index) => {
				const v = `${at}/variants/${index}`;
				problems.push(...checkFields(variant, VARIANT_FIELDS, ['variantId'], v));
				if (!isObject(variant)) return;
				if (variant.variantId !== undefined) push(problems, `${v}/variantId`, idCheck(variant.variantId));
				if (variant.title !== undefined) push(problems, `${v}/title`, textCheck(variant.title, 300));
				for (const key of ['price', 'cost', 'stock'])
					if (variant[key] !== undefined && variant[key] !== null && !isAmount(variant[key]))
						problems.push({ path: `${v}/${key}`, code: 'amount_invalid' });
				if (variant.attributes !== undefined) push(problems, `${v}/attributes`, attributesCheck(variant.attributes));
			});
	}
	return problems;
};

/**
 * A catalog item as stored (attributes normalised to arrays).
 * @param {Record<string, any>} item validated input
 */
export const catalogItem = (item) => ({
	itemId: item.itemId,
	title: item.title ?? null,
	brand: item.brand ?? null,
	collections: Array.isArray(item.collections) ? item.collections : [],
	attributes: normaliseAttributes(item.attributes),
	price: item.price ?? null,
	cost: item.cost ?? null,
	currency: item.currency ?? null,
	stock: item.stock ?? null,
	url: item.url ?? null,
	image: item.image ?? null,
	variants: (Array.isArray(item.variants) ? item.variants : []).map((/** @type {Record<string, any>} */ v) => ({
		variantId: v.variantId,
		title: v.title ?? null,
		price: v.price ?? null,
		cost: v.cost ?? null,
		stock: v.stock ?? null,
		attributes: normaliseAttributes(v.attributes),
	})),
});

const COMMIT_FIELDS = { orderId: 1, customerId: 1, expectedTotal: 1 };

/**
 * `POST /v1/quotes/{id}/commit`.
 * @param {unknown} body
 * @returns {FieldProblem[]}
 */
export const validateCommit = (body) => {
	const problems = checkFields(body, COMMIT_FIELDS, ['orderId']);
	if (!isObject(body)) return problems;
	if (body.orderId !== undefined) push(problems, '/orderId', idCheck(body.orderId));
	if (body.customerId !== undefined) push(problems, '/customerId', idCheck(body.customerId));
	if (body.expectedTotal !== undefined && !isAmount(body.expectedTotal))
		problems.push({ path: '/expectedTotal', code: 'amount_invalid' });
	return problems;
};
