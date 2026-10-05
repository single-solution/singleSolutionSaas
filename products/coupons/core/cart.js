/**
 * The generic cart every evaluation runs on (pure). Coupons make no store assumptions: a cart is
 * `{ currency, lines: [{ lineId?, itemId, variantId?, quantity, unitAmount, attributes?, collections? }], shipping?,
 * customer?, paymentMethod?, deliveryMethod?, context? }` with integer minor units in one ISO-4217 currency. Validation
 * lives in `validate.js`; this module only derives the normalised shape (line ids, line amounts, totals).
 * @module
 */

/**
 * @typedef {object} CartLine
 * @property {string} lineId
 * @property {string} itemId
 * @property {string | null} variantId
 * @property {number} quantity
 * @property {number} unitAmount
 * @property {number} amount quantity × unitAmount
 * @property {Record<string, string | string[]>} attributes
 * @property {string[]} collections
 */

/**
 * @typedef {object} CartCustomer
 * @property {string | null} id customer id (the verified identity's subject for browser keys)
 * @property {boolean} identified true when `id` comes from a verified identity or a server key
 * @property {number | null} orderCount completed orders before this one (null = unknown)
 * @property {string[]} segments
 * @property {string | null} email
 * @property {string | null} country
 */

/**
 * @typedef {object} Cart
 * @property {string} currency
 * @property {CartLine[]} lines
 * @property {number} subtotal Σ line amounts
 * @property {number} quantity Σ line quantities
 * @property {number} shipping
 * @property {CartCustomer} customer
 * @property {string | null} paymentMethod
 * @property {string | null} deliveryMethod
 * @property {{ country: string | null, device: string | null, source: string | null, deviceId: string | null }} context
 */

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @param {unknown} v */
const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Normalise a validated cart input.
 * @param {Record<string, any>} input
 * @param {{ customerId?: string | null, identified?: boolean }} [identity] the customer as the API resolved it
 * @returns {Cart}
 */
export const normaliseCart = (input, identity = {}) => {
	const lines = (Array.isArray(input.lines) ? input.lines : []).map((/** @type {Record<string, any>} */ line, index) => {
		const attributes = isObject(line.attributes) ? line.attributes : {};
		return {
			lineId: str(line.lineId) ?? String(index + 1),
			itemId: String(line.itemId),
			variantId: str(line.variantId),
			quantity: Number(line.quantity),
			unitAmount: Number(line.unitAmount),
			amount: Number(line.quantity) * Number(line.unitAmount),
			attributes: /** @type {Record<string, string | string[]>} */ (attributes),
			collections: Array.isArray(line.collections) ? line.collections.map(String) : [],
		};
	});
	const customer = isObject(input.customer) ? input.customer : {};
	const context = isObject(input.context) ? input.context : {};
	const customerId = identity.customerId === undefined ? str(customer.id) : identity.customerId;
	return {
		currency: String(input.currency),
		lines,
		subtotal: lines.reduce((sum, line) => sum + line.amount, 0),
		quantity: lines.reduce((sum, line) => sum + line.quantity, 0),
		shipping: Number.isInteger(input.shipping) ? input.shipping : 0,
		customer: {
			id: customerId,
			identified: customerId !== null && (identity.identified ?? true),
			orderCount: Number.isInteger(customer.orderCount) ? customer.orderCount : null,
			segments: Array.isArray(customer.segments) ? customer.segments.map(String) : [],
			email: typeof customer.email === 'string' ? customer.email.trim().toLowerCase() : null,
			country: str(customer.country),
		},
		paymentMethod: str(input.paymentMethod),
		deliveryMethod: str(input.deliveryMethod),
		context: {
			country: str(context.country) ?? str(customer.country),
			device: str(context.device),
			source: str(context.source),
			deviceId: str(context.deviceId),
		},
	};
};

/**
 * Summary stored with a reservation (no line attributes, no personal data).
 * @param {Cart} cart
 */
export const cartSummary = (cart) => ({
	currency: cart.currency,
	subtotal: cart.subtotal,
	quantity: cart.quantity,
	shipping: cart.shipping,
	lines: cart.lines.length,
});
