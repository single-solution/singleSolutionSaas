/**
 * Order summaries for the account pages (pure). Order events (`order.placed|completed|cancelled|refunded@1`) from the
 * Event Hub become a minimal summary per order — number, status, total — attributed to the customer the event names
 * (`customerId`, else `customer.customerId`, else the federated `customer.subject`, which is this product's customer
 * id when Signups is the website's identity issuer). Lines and addresses are not kept.
 * @module
 */

/** Status after each order event. */
export const ORDER_STATUS = Object.freeze({
	'order.placed@1': 'placed',
	'order.completed@1': 'completed',
	'order.cancelled@1': 'cancelled',
	'order.refunded@1': 'refunded',
});

/** Later lifecycle states win, whatever order the events arrive in. */
const RANK = Object.freeze(['refunded', 'cancelled', 'completed', 'placed']);

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The customer an order event names.
 * @param {Record<string, any>} data
 * @returns {string | null}
 */
export const orderCustomerId = (data) => {
	if (typeof data.customerId === 'string' && data.customerId) return data.customerId;
	const ref = isObject(data.customer) ? data.customer : {};
	if (typeof ref.customerId === 'string' && ref.customerId) return ref.customerId;
	return typeof ref.subject === 'string' && ref.subject ? ref.subject : null;
};

/**
 * Summary fields an event contributes (one timestamp per lifecycle state, so out-of-order deliveries converge) (`null` when the event is not an order event or has no order id).
 * @param {{ type: string, occurredAt: string, data: Record<string, any> }} event
 * @returns {{ orderId: string, status: string, set: Record<string, unknown> } | null}
 */
export const orderUpdate = (event) => {
	const status = /** @type {Record<string, string>} */ (ORDER_STATUS)[event.type];
	const data = isObject(event.data) ? event.data : {};
	if (!status || typeof data.orderId !== 'string' || !data.orderId) return null;
	/** @type {Record<string, unknown>} */
	const set = { [`${status}At`]: event.occurredAt };
	const customerId = orderCustomerId(data);
	if (customerId) set.customerId = customerId;
	if (typeof data.number === 'string') set.number = data.number;
	if (typeof data.currency === 'string') set.currency = data.currency;
	if (isObject(data.amounts) && Number.isInteger(data.amounts.total)) set.totalAmount = data.amounts.total;
	return { orderId: data.orderId, status, set };
};

/**
 * Public view of a stored summary.
 * @param {Record<string, any>} order
 */
export const orderView = (order) => ({
	orderId: order.orderId,
	number: order.number ?? null,
	status: RANK.find((status) => typeof order[`${status}At`] === 'string') ?? 'placed',
	totalAmount: order.totalAmount ?? null,
	currency: order.currency ?? null,
	placedAt: order.placedAt ?? null,
	updatedAt: order.updatedAt instanceof Date ? order.updatedAt.toISOString() : (order.updatedAt ?? null),
});
