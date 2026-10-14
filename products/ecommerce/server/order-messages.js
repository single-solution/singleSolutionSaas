/**
 * Messages to the shopper about their order (PLAN 0.8.8: messages go through Notifications): the order placed, and a
 * move into a status of the order flow that sends one (its `notify`), on the channels of `messageChannels`. Template
 * keys (edited in Notifications; default words in `schemas/messages.json`, parity P1): `ecommerce.order_placed` and
 * `ecommerce.order_status` — or, with `statusTemplates: per_status`, `ecommerce.order_status.<status key>` (PLAN 0.8.10
 * E32), sent with `ecommerce.order_status` as its fallback template: the website's template for the status, else its
 * template for the general message, else the general message's default words — with the values `number`, `name`,
 * `firstName`, `status` (the status's name for the shopper), `total` (by the website's Format, K7), `paymentMethod` and
 * `deliveryMethod` (words, not codes: the website's texts `checkout.method.<method>` and
 * `messages.delivery.<method>`, '' without delivery; K-10), `courier`, `trackingNumber`, `trackingUrl`,
 * `trackingDetails`, `orderUrl` and `reviewUrl` (the `checkout` templates with `{number}`), `cancelReason` (why it was
 * cancelled: the note for the shopper staff wrote with the move, else the note staff typed, else the text
 * `messages.cancelReason.<staff | shopper | unpaid | unconfirmed>`; '' for other statuses), `shopperNote` (the note for
 * the shopper staff wrote with the move, '' without one) and `business`. The merchant edits those words in Texts. Order messages are
 * required (sent whatever the shopper opted out of) and saved before they are sent, so a call to Notifications that
 * fails is tried again on the website's next uses (K-17, owner decision D7). A failed or unconnected send never fails
 * the order.
 * @module
 */

/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */

/** Template keys (`status` with `.<status key>` added under `statusTemplates: per_status`; the docs list them). */
export const ORDER_TEMPLATES = Object.freeze({ placed: 'ecommerce.order_placed', status: 'ecommerce.order_status' });

/**
 * The values every order message carries, in the order the docs list them (`business` is added by `service.notify`,
 * {@link import('./service.js').BUSINESS_VALUE}). `send` below fills exactly these, so the docs cannot drift.
 */
export const ORDER_MESSAGE_VALUES = Object.freeze(
	/** @type {const} */ ([
		'number',
		'name',
		'firstName',
		'status',
		'total',
		'paymentMethod',
		'deliveryMethod',
		'courier',
		'trackingNumber',
		'trackingUrl',
		'trackingDetails',
		'orderUrl',
		'reviewUrl',
		'cancelReason',
		'shopperNote',
	]),
);

/** @typedef {typeof ORDER_MESSAGE_VALUES[number]} OrderMessageValue */

/** Why an order was cancelled (`messages.cancelReason.<code>`). @typedef {'staff' | 'shopper' | 'unpaid' | 'unconfirmed'} CancelCode */

/**
 * The words messages and staff alerts show for an order's codes (K-10), from the website's texts.
 * @param {Site} s
 */
export const messageWords = async (s) => {
	const texts = await s.texts();
	return Object.freeze({
		/** @param {string} method */
		payment: (method) => texts[`checkout.method.${method}`] ?? method,
		/** @param {string} method `delivery`, `pickup` or `none` (no delivery: '') */
		delivery: (method) => (method === 'none' ? '' : (texts[`messages.delivery.${method}`] ?? method)),
		/**
		 * Why it was cancelled: the note staff typed with the move, else the text for who or what cancelled it.
		 * @param {CancelCode} code @param {string} [note]
		 */
		cancel: (code, note = '') => note.trim() || (texts[`messages.cancelReason.${code}`] ?? ''),
	});
};

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
	 * @param {{ cancelReason?: string, shopperNote?: string, fallbackTemplate?: string }} [extra] `cancelReason`: the
	 *   words, from {@link messageWords}; `shopperNote`: the note staff wrote for the shopper with the move;
	 *   `fallbackTemplate`: the key used when the website has no template for `template`
	 */
	const send = async (s, template, order, statusLabel, { cancelReason = '', shopperNote = '', fallbackTemplate } = {}) => {
		const { messageChannels, orderUrl, reviewUrl } = await s.values('checkout');
		const words = await messageWords(s);
		const shipment = order.shipment;
		const trackingDetails = shipment
			? [shipment.courier, shipment.trackingNumber, shipment.trackingUrl, shipment.trackingNote ?? '']
					.filter((part) => typeof part === 'string' && part !== '')
					.join(' · ')
			: '';
		/** Exactly {@link ORDER_MESSAGE_VALUES} (a missing or extra one fails the type check). @type {Record<OrderMessageValue, string>} */
		const values = {
			number: order.number,
			name: order.customer.name,
			firstName: order.customer.name.trim().split(/\s+/)[0] ?? '',
			status: statusLabel,
			total: (await s.format()).money(order.totals.total, order.totals.currency),
			paymentMethod: words.payment(order.payment.method),
			deliveryMethod: words.delivery(order.delivery.method),
			courier: shipment?.courier ?? '',
			trackingNumber: shipment?.trackingNumber ?? '',
			trackingUrl: shipment?.trackingUrl ?? '',
			trackingDetails,
			orderUrl: linkOf(orderUrl, order),
			reviewUrl: linkOf(reviewUrl, order),
			cancelReason,
			shopperNote,
		};
		return service.notify(
			s,
			template,
			{ email: order.customer.email, phone: order.customer.phone },
			values,
			Array.isArray(messageChannels) ? messageChannels : ['email'],
			{ required: true, ...(fallbackTemplate ? { fallbackTemplate } : {}) },
		);
	};

	return Object.freeze({
		/**
		 * The order was placed.
		 * @param {Site} s @param {OrderRecord} order @param {string} statusLabel the name of its first status
		 */
		placed: (s, order, statusLabel) => send(s, ORDER_TEMPLATES.placed, order, statusLabel),
		/**
		 * The order moved into a status; sent only when the flow says the status sends one (`notify`), with one template per
		 * status when `statusTemplates` says so (E32), falling back to the general one.
		 * @param {Site} s @param {OrderRecord} order the order after the move @param {string} statusLabel the shopper's name
		 * @param {{ cancelReason?: string, shopperNote?: string, notify: boolean }} extra `notify`: the flow's `notify`
		 */
		status: async (s, order, statusLabel, extra) => {
			const { statusTemplates } = await s.values('checkout');
			if (!extra.notify) return 'skipped';
			if (statusTemplates !== 'per_status') return send(s, ORDER_TEMPLATES.status, order, statusLabel, extra);
			return send(s, `${ORDER_TEMPLATES.status}.${order.status}`, order, statusLabel, {
				...extra,
				fallbackTemplate: ORDER_TEMPLATES.status,
			});
		},
	});
};
