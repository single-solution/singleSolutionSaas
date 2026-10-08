/**
 * Messages to the shopper about their order (PLAN 0.8.8: messages go through Notifications): the order placed, and a
 * move into a status listed in the `checkout` setting `notifyStatuses`, on the channels of `messageChannels`. Template
 * keys (edited in Notifications): `ecommerce.order_placed` and `ecommerce.order_status`, with the values `number`,
 * `name`, `status` (the status's name), `total` (formatted), `courier`, `trackingNumber` and `trackingUrl`. A failed or
 * unconnected send never fails the order.
 * @module
 */
import { formatMoney } from '../core/money.js';

/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */

/** Template keys. */
export const ORDER_TEMPLATES = Object.freeze({ placed: 'ecommerce.order_placed', status: 'ecommerce.order_status' });

/**
 * @param {Service} service
 */
export const createOrderMessages = (service) => {
	/**
	 * @param {Site} s @param {string} template @param {OrderRecord} order @param {string} statusLabel
	 */
	const send = async (s, template, order, statusLabel) => {
		const { messageChannels } = await s.values('checkout');
		return service.notify(
			s,
			template,
			{ email: order.customer.email, phone: order.customer.phone },
			{
				number: order.number,
				name: order.customer.name,
				status: statusLabel,
				total: formatMoney(order.totals.total, order.totals.currency),
				courier: order.shipment?.courier ?? '',
				trackingNumber: order.shipment?.trackingNumber ?? '',
				trackingUrl: order.shipment?.trackingUrl ?? '',
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
		 * The order moved into a status; sent only when the status is listed in `notifyStatuses`.
		 * @param {Site} s @param {OrderRecord} order the order after the move @param {string} statusLabel
		 */
		status: async (s, order, statusLabel) => {
			const { notifyStatuses } = await s.values('checkout');
			if (!Array.isArray(notifyStatuses) || !notifyStatuses.includes(order.status)) return 'skipped';
			return send(s, ORDER_TEMPLATES.status, order, statusLabel);
		},
	});
};
