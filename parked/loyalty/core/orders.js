/**
 * Order events (pure): the customer of an order and the order snapshot kept for completion, refunds and rules.
 * Contracts v1 (additive) let `order.completed@1`, `order.cancelled@1` and `order.refunded@1` carry the same context
 * as `order.placed@1` (`customer`, `currency`, `lines`, `amounts`).
 * @module
 */

/**
 * The customer of an order event: `customerId`, else the identity reference (`customer.customerId`, then the
 * federated `customer.subject` — the website's own login, bring-your-own identity).
 * @param {Record<string, any>} data
 * @returns {string | undefined}
 */
export const orderCustomer = (data) => {
	if (typeof data.customerId === 'string') return data.customerId;
	if (typeof data.customer?.customerId === 'string') return data.customer.customerId;
	if (typeof data.customer?.subject === 'string') return data.customer.subject;
	return undefined;
};

/**
 * Whether an order event carries the full order context (contracts v1: `currency`, `lines`, `amounts`).
 * @param {Record<string, any>} data
 */
export const hasOrderContext = (data) =>
	typeof data.currency === 'string' && Array.isArray(data.lines) && typeof data.amounts?.total === 'number';

/**
 * The order snapshot kept for completion, refunds and rules.
 * @param {Record<string, any>} data
 * @param {string} at ISO time of the event
 */
export const orderSnapshot = (data, at) => {
	const customerId = orderCustomer(data);
	return {
		orderId: data.orderId,
		...(typeof data.number === 'string' ? { number: data.number } : {}),
		...(customerId ? { customerId } : {}),
		currency: data.currency,
		lines: data.lines ?? [],
		amounts: data.amounts,
		placedAt: at,
	};
};
