/**
 * Orders (pure): the canonical order an intake turns into a document, its validation, the snapshot rules and the
 * views. Everything an invoice or receipt prints comes from the snapshot taken at placement — line titles, warranty
 * (A8 lesson: per line, never a blanket text), attributes, tax lines and adjustments — so later catalog changes never
 * rewrite history. No country, currency or tax rule is assumed: tax lines are copied from the order as given.
 * @module
 */
import { cleanText, httpsUrl, isId, isKey, isObject, issue, normalizeEmail, normalizePhone } from './text.js';
import { isAmount, isCurrency } from './money.js';

/** Order sources. */
export const SOURCES = Object.freeze(/** @type {const} */ (['checkout', 'api', 'import', 'dashboard']));
/** Address fields kept (all free text: no country format assumed). */
export const ADDRESS_FIELDS = Object.freeze(
	/** @type {const} */ (['name', 'company', 'phone', 'line1', 'line2', 'city', 'region', 'postalCode', 'country']),
);
const MAX_QUANTITY = 1_000_000;
const MAX_ATTRIBUTES = 30;
const MAX_TAX_LINES = 20;
const MAX_ADJUSTMENTS = 20;
const MAX_CUSTOM = 50;
const LANG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

/**
 * @typedef {object} OrderLine
 * @property {string} id
 * @property {string | null} itemId
 * @property {string | null} variantId
 * @property {string | null} sku
 * @property {string} title
 * @property {string | null} variantTitle
 * @property {number} quantity
 * @property {number} unitAmount
 * @property {number} totalAmount
 * @property {number | null} taxAmount
 * @property {{ label: string | null, days: number | null } | null} warranty
 * @property {Record<string, string | number | boolean>} attributes
 * @property {boolean} serialRequired
 * @property {string[]} serials
 * @property {string | null} imageUrl
 */

/**
 * @typedef {object} OrderDraft a validated new order (before the intake gives it a status, number and id)
 * @property {string | null} id
 * @property {string | null} externalId
 * @property {string | null} number
 * @property {Date | null} placedAt
 * @property {string} currency
 * @property {string | null} lang the customer's language (messages, receipts)
 * @property {{ customerId: string | null, subject: string | null, email: string | null, phone: string | null, name: string | null }} customer
 * @property {Record<string, string> | null} shipping
 * @property {Record<string, string> | null} billing
 * @property {{ method: string | null, label: string | null }} delivery
 * @property {{ method: string | null, cod: boolean, status: 'unpaid' | 'paid', paidAmount: number, reference: string | null }} payment
 * @property {OrderLine[]} lines
 * @property {{ subtotal: number, discount: number, shipping: number, tax: number, total: number }} amounts
 * @property {Array<{ label: string, rate: string | null, amount: number }>} taxLines
 * @property {Array<{ label: string, amount: number }>} adjustments
 * @property {{ customer: string | null }} notes
 * @property {Record<string, string | number | boolean>} custom
 */

/**
 * @param {unknown} value
 * @returns {Record<string, string> | null}
 */
const addressOf = (value) => {
	if (!isObject(value)) return null;
	/** @type {Record<string, string>} */
	const out = {};
	for (const field of ADDRESS_FIELDS) {
		const text = field === 'phone' ? normalizePhone(value[field]) : cleanText(value[field], 200);
		if (text) out[field] = text;
	}
	return Object.keys(out).length > 0 ? out : null;
};

/**
 * A small flat map of scalars (attributes, custom fields).
 * @param {unknown} value
 * @param {number} max
 * @returns {Record<string, string | number | boolean> | null} null when invalid
 */
const scalarMap = (value, max) => {
	if (value === undefined || value === null) return {};
	if (!isObject(value) || Object.keys(value).length > max) return null;
	/** @type {Record<string, string | number | boolean>} */
	const out = {};
	for (const [key, raw] of Object.entries(value)) {
		if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) return null;
		if (typeof raw === 'boolean' || (typeof raw === 'number' && Number.isFinite(raw))) out[key] = raw;
		else if (typeof raw === 'string') {
			const text = cleanText(raw, 500);
			if (text) out[key] = text;
		} else return null;
	}
	return out;
};

/**
 * @param {unknown} value
 * @returns {{ label: string | null, days: number | null } | null | undefined} undefined when invalid
 */
const warrantyOf = (value) => {
	if (value === undefined || value === null) return null;
	if (!isObject(value)) return undefined;
	const label = value.label === undefined || value.label === null ? null : cleanText(value.label, 120);
	const days = value.days === undefined || value.days === null ? null : value.days;
	if (label === null && value.label !== undefined && value.label !== null) return undefined;
	if (days !== null && !(Number.isSafeInteger(days) && days >= 0 && days <= 36_500)) return undefined;
	return label === null && days === null ? null : { label, days: /** @type {number | null} */ (days) };
};

/**
 * @param {unknown} raw
 * @param {number} index
 * @param {Array<{ path: string, code: string }>} problems
 * @returns {OrderLine | null}
 */
const lineOf = (raw, index, problems) => {
	const at = `/lines/${index}`;
	if (!isObject(raw)) {
		problems.push(issue(at, 'line_invalid'));
		return null;
	}
	const before = problems.length;
	const title = cleanText(raw.title, 300);
	if (!title) problems.push(issue(`${at}/title`, 'required'));
	const itemId = raw.itemId === undefined || raw.itemId === null ? null : isId(raw.itemId) ? raw.itemId : undefined;
	if (itemId === undefined) problems.push(issue(`${at}/itemId`, 'id_invalid'));
	const variantId =
		raw.variantId === undefined || raw.variantId === null ? null : isId(raw.variantId) ? raw.variantId : undefined;
	if (variantId === undefined) problems.push(issue(`${at}/variantId`, 'id_invalid'));
	const sku = raw.sku === undefined || raw.sku === null ? null : cleanText(raw.sku, 100);
	if (raw.sku !== undefined && raw.sku !== null && sku === null) problems.push(issue(`${at}/sku`, 'text_invalid'));
	if (!Number.isSafeInteger(raw.quantity) || raw.quantity < 1 || raw.quantity > MAX_QUANTITY)
		problems.push(issue(`${at}/quantity`, 'quantity_invalid'));
	if (!isAmount(raw.unitAmount)) problems.push(issue(`${at}/unitAmount`, 'amount_invalid'));
	const total = raw.totalAmount === undefined || raw.totalAmount === null ? null : raw.totalAmount;
	if (total !== null && !isAmount(total)) problems.push(issue(`${at}/totalAmount`, 'amount_invalid'));
	const tax = raw.taxAmount === undefined || raw.taxAmount === null ? null : raw.taxAmount;
	if (tax !== null && !isAmount(tax)) problems.push(issue(`${at}/taxAmount`, 'amount_invalid'));
	const warranty = warrantyOf(raw.warranty);
	if (warranty === undefined) problems.push(issue(`${at}/warranty`, 'warranty_invalid'));
	const attributes = scalarMap(raw.attributes, MAX_ATTRIBUTES);
	if (attributes === null) problems.push(issue(`${at}/attributes`, 'attributes_invalid'));
	const imageUrl = raw.imageUrl === undefined || raw.imageUrl === null ? null : httpsUrl(raw.imageUrl);
	if (raw.imageUrl !== undefined && raw.imageUrl !== null && imageUrl === null)
		problems.push(issue(`${at}/imageUrl`, 'url_invalid'));
	if (problems.length > before) return null;
	const quantity = /** @type {number} */ (raw.quantity);
	const unitAmount = /** @type {number} */ (raw.unitAmount);
	const lineTotal = total ?? unitAmount * quantity;
	if (!Number.isSafeInteger(lineTotal)) {
		problems.push(issue(`${at}/totalAmount`, 'amount_invalid'));
		return null;
	}
	return {
		id: `l${index + 1}`,
		itemId: /** @type {string | null} */ (itemId),
		variantId: /** @type {string | null} */ (variantId),
		sku,
		title: /** @type {string} */ (title),
		variantTitle: cleanText(raw.variantTitle, 300),
		quantity,
		unitAmount,
		totalAmount: lineTotal,
		taxAmount: /** @type {number | null} */ (tax),
		warranty: warranty ?? null,
		attributes: attributes ?? {},
		serialRequired: raw.serialRequired === true,
		serials: [],
		imageUrl,
	};
};

/**
 * @param {unknown} value
 * @param {string} path
 * @param {Array<{ path: string, code: string }>} problems
 */
const amountField = (value, path, problems) => {
	if (value === undefined || value === null) return null;
	if (!isAmount(value)) {
		problems.push(issue(path, 'amount_invalid'));
		return null;
	}
	return value;
};

/**
 * Validate a canonical order (POST /v1/inbound-orders, a mapped payload, order.placed@1 data).
 * @param {unknown} input
 * @param {{ maxLines: number, defaultCurrency: string | null }} limits
 * @returns {{ ok: true, draft: OrderDraft } | { ok: false, errors: Array<{ path: string, code: string }> }}
 */
export const validateOrder = (input, { maxLines, defaultCurrency }) => {
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	if (!isObject(input)) return { ok: false, errors: [issue('', 'object_required')] };
	const id = input.id === undefined || input.id === null ? null : isId(input.id) ? input.id : undefined;
	if (id === undefined) problems.push(issue('/id', 'id_invalid'));
	const externalId = input.externalId === undefined || input.externalId === null ? null : cleanText(input.externalId, 128);
	if (input.externalId !== undefined && input.externalId !== null && externalId === null)
		problems.push(issue('/externalId', 'text_invalid'));
	const number = input.number === undefined || input.number === null ? null : cleanText(input.number, 64);
	if (input.number !== undefined && input.number !== null && number === null) problems.push(issue('/number', 'text_invalid'));
	const placedAt = input.placedAt === undefined || input.placedAt === null ? null : new Date(String(input.placedAt));
	if (placedAt && Number.isNaN(placedAt.getTime())) problems.push(issue('/placedAt', 'date_invalid'));
	const currency = input.currency === undefined || input.currency === null ? defaultCurrency : input.currency;
	const lang =
		input.lang === undefined || input.lang === null ? null : LANG.test(String(input.lang)) ? String(input.lang) : undefined;
	if (lang === undefined) problems.push(issue('/lang', 'lang_invalid'));
	if (!isCurrency(currency)) problems.push(issue('/currency', 'currency_invalid'));
	const rawLines = Array.isArray(input.lines) ? input.lines : null;
	if (!rawLines || rawLines.length === 0) problems.push(issue('/lines', 'required'));
	else if (rawLines.length > maxLines) problems.push(issue('/lines', 'too_many_lines'));
	const lines = rawLines && rawLines.length <= maxLines ? rawLines.map((raw, index) => lineOf(raw, index, problems)) : [];

	const customerRaw = isObject(input.customer) ? input.customer : {};
	const rawCustomerId = customerRaw.customerId ?? input.customerId ?? null;
	const customerId = rawCustomerId === null ? null : isId(rawCustomerId) ? rawCustomerId : undefined;
	if (customerId === undefined) problems.push(issue('/customer/customerId', 'id_invalid'));
	const email = customerRaw.email === undefined || customerRaw.email === null ? null : normalizeEmail(customerRaw.email);
	if (customerRaw.email !== undefined && customerRaw.email !== null && email === null)
		problems.push(issue('/customer/email', 'email_invalid'));
	const phone = customerRaw.phone === undefined || customerRaw.phone === null ? null : normalizePhone(customerRaw.phone);
	if (customerRaw.phone !== undefined && customerRaw.phone !== null && phone === null)
		problems.push(issue('/customer/phone', 'phone_invalid'));

	const amountsRaw = isObject(input.amounts) ? input.amounts : {};
	const discount = amountField(amountsRaw.discount, '/amounts/discount', problems) ?? 0;
	const shipping = amountField(amountsRaw.shipping, '/amounts/shipping', problems) ?? 0;
	const givenTax = amountField(amountsRaw.tax, '/amounts/tax', problems);
	const givenSubtotal = amountField(amountsRaw.subtotal, '/amounts/subtotal', problems);
	const givenTotal = amountField(amountsRaw.total, '/amounts/total', problems);

	/** @type {OrderDraft['taxLines']} */
	const taxLines = [];
	if (input.taxLines !== undefined && input.taxLines !== null) {
		if (!Array.isArray(input.taxLines) || input.taxLines.length > MAX_TAX_LINES) problems.push(issue('/taxLines', 'invalid'));
		else
			input.taxLines.forEach((raw, index) => {
				const label = cleanText(raw?.label, 120);
				const rate = raw?.rate === undefined || raw?.rate === null ? null : cleanText(raw.rate, 40);
				if (!label || !isAmount(raw?.amount) || (raw?.rate !== undefined && raw?.rate !== null && rate === null))
					problems.push(issue(`/taxLines/${index}`, 'tax_line_invalid'));
				else taxLines.push({ label, rate, amount: raw.amount });
			});
	}
	/** @type {OrderDraft['adjustments']} */
	const adjustments = [];
	if (input.adjustments !== undefined && input.adjustments !== null) {
		if (!Array.isArray(input.adjustments) || input.adjustments.length > MAX_ADJUSTMENTS)
			problems.push(issue('/adjustments', 'invalid'));
		else
			input.adjustments.forEach((raw, index) => {
				const label = cleanText(raw?.label, 120);
				if (!label || !Number.isSafeInteger(raw?.amount)) problems.push(issue(`/adjustments/${index}`, 'adjustment_invalid'));
				else adjustments.push({ label, amount: raw.amount });
			});
	}

	const paymentRaw = isObject(input.payment) ? input.payment : {};
	const method =
		paymentRaw.method === undefined || paymentRaw.method === null
			? null
			: isKey(paymentRaw.method)
				? paymentRaw.method
				: undefined;
	if (method === undefined) problems.push(issue('/payment/method', 'key_invalid'));
	const paymentStatus = paymentRaw.status === undefined ? 'unpaid' : paymentRaw.status;
	if (paymentStatus !== 'unpaid' && paymentStatus !== 'paid') problems.push(issue('/payment/status', 'invalid'));
	const paidAmount = amountField(paymentRaw.paidAmount, '/payment/paidAmount', problems);
	const deliveryRaw = isObject(input.delivery) ? input.delivery : {};
	const deliveryMethod =
		deliveryRaw.method === undefined || deliveryRaw.method === null
			? null
			: isKey(deliveryRaw.method)
				? deliveryRaw.method
				: undefined;
	if (deliveryMethod === undefined) problems.push(issue('/delivery/method', 'key_invalid'));
	const custom = scalarMap(input.custom, MAX_CUSTOM);
	if (custom === null) problems.push(issue('/custom', 'custom_invalid'));

	if (problems.length > 0) return { ok: false, errors: problems };
	const validLines = /** @type {OrderLine[]} */ (lines);
	const subtotal = givenSubtotal ?? validLines.reduce((sum, line) => sum + line.totalAmount, 0);
	const tax = givenTax ?? taxLines.reduce((sum, line) => sum + line.amount, 0);
	const adjusted = adjustments.reduce((sum, a) => sum + a.amount, 0);
	// a missing total is the plain sum: the source system knows whether its tax was included, so pass the total
	const total = givenTotal ?? Math.max(0, subtotal - discount + shipping + (givenTax === null ? 0 : tax) + adjusted);
	if (!Number.isSafeInteger(subtotal) || !Number.isSafeInteger(total))
		return { ok: false, errors: [issue('/amounts', 'amount_invalid')] };
	const paid = paymentStatus === 'paid' ? (paidAmount ?? total) : (paidAmount ?? 0);
	return {
		ok: true,
		draft: {
			id: /** @type {string | null} */ (id),
			externalId,
			number,
			placedAt,
			currency: /** @type {string} */ (currency),
			lang: /** @type {string | null} */ (lang),
			customer: {
				customerId: /** @type {string | null} */ (customerId),
				subject: cleanText(customerRaw.subject, 255),
				email,
				phone,
				name: cleanText(customerRaw.name, 200),
			},
			shipping: addressOf(input.shipping),
			billing: addressOf(input.billing),
			delivery: { method: /** @type {string | null} */ (deliveryMethod), label: cleanText(deliveryRaw.label, 120) },
			payment: {
				method: /** @type {string | null} */ (method),
				cod: paymentRaw.cod === true,
				status: paid >= total ? 'paid' : 'unpaid',
				paidAmount: Math.min(paid, Number.MAX_SAFE_INTEGER),
				reference: cleanText(paymentRaw.reference, 200),
			},
			lines: validLines,
			amounts: { subtotal, discount, shipping, tax, total },
			taxLines,
			adjustments,
			notes: { customer: cleanText(isObject(input.notes) ? input.notes.customer : null, 2000, { multiline: true }) },
			custom: custom ?? {},
		},
	};
};

/**
 * Canonical order input from `order.placed@1` data (the Checkout product's placement): the event's `orderId` becomes
 * our order id, so every order event we publish later names the same order for the other products.
 * @param {Record<string, any>} data
 */
export const placedToInput = (data) => ({
	id: data.orderId,
	externalId: data.orderId,
	number: data.number ?? null,
	currency: data.currency,
	customer: {
		...(isObject(data.customer) ? data.customer : {}),
		...(data.customerId && !data.customer?.customerId ? { customerId: data.customerId } : {}),
	},
	lines: Array.isArray(data.lines)
		? data.lines.map((/** @type {any} */ line) => ({ ...line, title: line?.title ?? line?.sku ?? line?.itemId }))
		: data.lines,
	amounts: data.amounts,
});

/**
 * Keys that identify the order's customer for risk (customer id, subject, e-mail, phone match digits).
 * @param {{ customerId?: string | null, subject?: string | null, email?: string | null, phone?: string | null }} customer
 * @param {number} phoneDigits
 */
export const customerKeys = (customer, phoneDigits) => {
	/** @type {string[]} */
	const out = [];
	if (customer.customerId) out.push(`c:${customer.customerId}`);
	if (customer.subject) out.push(`s:${customer.subject}`);
	if (customer.email) out.push(`e:${customer.email}`);
	if (customer.phone) {
		const digits = customer.phone.replace(/\D/g, '');
		out.push(`p:${phoneDigits > 0 ? digits.slice(-phoneDigits) : digits}`);
	}
	return out;
};

/**
 * Identity references for events (never contact details: personal data stays in the merchant's database).
 * @param {{ customer?: { customerId?: string | null, subject?: string | null } | null }} order
 */
export const customerRef = (order) => {
	const ref = {
		...(order.customer?.customerId ? { customerId: order.customer.customerId } : {}),
		...(order.customer?.subject ? { subject: order.customer.subject.slice(0, 255) } : {}),
	};
	return Object.keys(ref).length > 0 ? ref : null;
};

/**
 * The optional order context of the catalogued order events (`number`, `customerId`, `customer`, `currency`, `lines`,
 * `amounts`). Lines without a catalog id fall back to an id-shaped SKU; others are left out of the event lines.
 * @param {Record<string, any>} order
 */
export const eventContext = (order) => {
	const lines = (order.lines ?? [])
		.map((/** @type {OrderLine} */ line) => {
			const itemId = line.itemId ?? (line.sku && isId(line.sku) ? line.sku : null);
			if (!itemId) return null;
			return {
				itemId,
				...(line.variantId ? { variantId: line.variantId } : {}),
				...(line.sku ? { sku: line.sku } : {}),
				title: line.title,
				quantity: line.quantity,
				unitAmount: line.unitAmount,
				totalAmount: line.totalAmount,
			};
		})
		.filter(Boolean)
		.slice(0, 500);
	const ref = customerRef(order);
	return {
		...(order.number ? { number: String(order.number).slice(0, 64) } : {}),
		...(ref?.customerId ? { customerId: ref.customerId } : {}),
		...(ref ? { customer: ref } : {}),
		currency: order.currency,
		...(lines.length > 0 ? { lines } : {}),
		amounts: {
			subtotal: order.amounts.subtotal,
			discount: order.amounts.discount,
			shipping: order.amounts.shipping,
			tax: order.amounts.tax,
			total: order.amounts.total,
		},
	};
};

/**
 * Format an order number from a sequence (`prefix` + zero-padded digits).
 * @param {string} prefix
 * @param {number} sequence
 * @param {number} padding
 */
export const formatNumber = (prefix, sequence, padding) => `${prefix}${String(sequence).padStart(padding, '0')}`;

/** Fields never shown outside the service. */
const INTERNAL = new Set([
	'_id',
	'websiteId',
	'merchantId',
	'env',
	'schemaVersion',
	'pending',
	'pendingAt',
	'customerKeys',
	'version',
]);

/**
 * The owner's view (sk_ keys, dashboard): everything but internal bookkeeping.
 * @param {Record<string, any>} order
 */
export const ownerView = (order) => Object.fromEntries(Object.entries(order).filter(([key]) => !INTERNAL.has(key)));
