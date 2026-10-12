/**
 * Messages to the shopper about their order (PLAN 0.8.8: messages go through Notifications): the order placed, and a
 * move into a status listed in the `checkout` setting `notifyStatuses`, on the channels of `messageChannels`. Template
 * keys (edited in Notifications): `ecommerce.order_placed` and `ecommerce.order_status` — or, with `statusTemplates:
 * per_status`, `ecommerce.order_status.<status key>` (PLAN 0.8.10 E32) — with the values `number`, `name`,
 * `firstName`, `status` (the status's name), `total` (by the website's Format, K7), `paymentMethod`,
 * `deliveryMethod`, `courier`, `trackingNumber`, `trackingUrl`, `trackingDetails`, `orderUrl` and `reviewUrl` (the
 * `checkout` templates with `{number}`), `cancelReason` (`staff`, `shopper` or `expired`) and `business`. A failed or
 * unconnected send never fails the order.
 * @module
 */

/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */

/** Template keys. */
const ORDER_TEMPLATES = Object.freeze({ placed: 'ecommerce.order_placed', status: 'ecommerce.order_status' });

/**
 * A `checkout` address template with the order number filled ('' when none).
 * @param {unknown} template @param {OrderRecord} order
 */
const linkOf = (template, order) =>
	typeof template === 'string' && template !== '' ? template.replaceAll('{number}', encodeURIComponent(order.number)) : '';

/**
 * @param {Service} service
 */
export const createOrderMessages = (service) => {
	/**
	 * @param {Site} s @param {string} template @param {OrderRecord} order @param {string} statusLabel
	 * @param {{ cancelReason?: string }} [extra]
	 */
	const send = async (s, template, order, statusLabel, { cancelReason = '' } = {}) => {
		const { messageChannels, orderUrl, reviewUrl } = await s.values('checkout');
		const shipment = order.shipment;
		const trackingDetails = shipment
			? [shipment.courier, shipment.trackingNumber, shipment.trackingUrl, shipment.trackingNote ?? '']
					.filter((part) => typeof part === 'string' && part !== '')
					.join(' · ')
			: '';
		return service.notify(
			s,
			template,
			{ email: order.customer.email, phone: order.customer.phone },
			{
				number: order.number,
				name: order.customer.name,
				firstName: order.customer.name.trim().split(/\s+/)[0] ?? '',
				status: statusLabel,
				total: (await s.format()).money(order.totals.total, order.totals.currency),
				paymentMethod: order.payment.method,
				deliveryMethod: order.delivery.method,
				courier: shipment?.courier ?? '',
				trackingNumber: shipment?.trackingNumber ?? '',
				trackingUrl: shipment?.trackingUrl ?? '',
				trackingDetails,
				orderUrl: linkOf(orderUrl, order),
				reviewUrl: linkOf(reviewUrl, order),
				cancelReason,
			},
			Array.isArray(messageChannels) ? messageChannels : ['email'],
		);
	};

	return Object.freeze({
		/**
		 * The order was placed.
		 * @param {Site} s @param {OrderRecord} order @param {string} statusLabel the name of its first status
		 */
		placed: (s, order, statusLabel) => send(s, ORDER_TEMPLATES.placed, order, statusLabel),
		/**
		 * The order moved into a status; sent only when the status is listed in `notifyStatuses`, with one template per
		 * status when `statusTemplates` says so (E32).
		 * @param {Site} s @param {OrderRecord} order the order after the move @param {string} statusLabel
		 * @param {{ cancelReason?: string }} [extra]
		 */
		status: async (s, order, statusLabel, extra = {}) => {
			const { notifyStatuses, statusTemplates } = await s.values('checkout');
			if (!Array.isArray(notifyStatuses) || !notifyStatuses.includes(order.status)) return 'skipped';
			const template = statusTemplates === 'per_status' ? `${ORDER_TEMPLATES.status}.${order.status}` : ORDER_TEMPLATES.status;
			return send(s, template, order, statusLabel, extra);
		},
	});
};
