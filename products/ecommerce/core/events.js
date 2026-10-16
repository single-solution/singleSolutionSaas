/**
 * The events the shop publishes while Events is on (`ecommerce.<type>`, PLAN 0.8.10 K5, E32; `server/order-events.js`),
 * besides the kit's own `ecommerce.settings.changed`: listed by `GET /v1/events`, sent to webhooks through Notifications,
 * documented in the guide and named in the website's Setup sheet. Server only (the widgets never load it).
 * @module
 */

/** Every event type, in the order the guide lists them. */
export const EVENT_TYPES = Object.freeze(
	/** @type {const} */ ([
		'order.placed',
		'order.status_changed',
		'order.paid',
		'order.payment_recorded',
		'order.proof_uploaded',
		'order.canceled',
		'order.refunded',
		'return.requested',
		'return.status_changed',
		'review.submitted',
		'catalog.changed',
		'stock.low',
		'stock.out',
	]),
);

/** @typedef {(typeof EVENT_TYPES)[number]} EventType */
