/**
 * What Ecommerce's staff alerts (PLAN 0.8.10 K6, E32) are made of: their events, the values they carry and the
 * permission `staffPermission: all_staff` stands for in each. Who gets an alert is the kit's rule
 * (`product.staffAlerts.prepare`): the website's alert team in the Portal (Website settings › Team and alerts: an email
 * address, or an international phone number that gets SMS, or WhatsApp when the team says so), plus every unblocked
 * Accounts user whose role grants `staffPermission` (asked through the pasted Accounts token, kept 5 minutes on this
 * instance; with the team's staff push on they get a staff push too), at most `maxRecipients` people; the template is `ecommerce.staff_<event>` (default words in
 * `schemas/messages.json`, parity P1), and `adminUrl` filled from the values is sent as `link`. With `includePhone` on,
 * an alert also carries the shopper's phone as `phone`. `server/order-events.js` hands the prepared messages to
 * Ecommerce's outbox, which saves every alert before the answer (K-17, owner decision D7) and shares its one retry
 * queue and data-rights removal (by address and order number) with the order messages.
 * @module
 */

/** The values every staff alert carries (`server/order-events.js` fills them; the docs list them). */
export const STAFF_ALERT_VALUES = Object.freeze(
	/** @type {const} */ (['id', 'number', 'name', 'total', 'status', 'paymentMethod', 'business']),
);
/**
 * The events of the `staff_alerts` setting `events` (template `ecommerce.staff_<event>`), each with the values it adds
 * to {@link STAFF_ALERT_VALUES}.
 */
export const STAFF_ALERT_EVENTS = Object.freeze({
	placed: Object.freeze([]),
	status: Object.freeze(/** @type {const} */ (['from'])),
	paid: Object.freeze([]),
	proof_uploaded: Object.freeze(/** @type {const} */ (['reference'])),
	canceled: Object.freeze(/** @type {const} */ (['reason'])),
	expired: Object.freeze(/** @type {const} */ (['reason'])),
	return_requested: Object.freeze(/** @type {const} */ (['claimId', 'reference'])),
	refund_due: Object.freeze(/** @type {const} */ (['amount'])),
});
/** The value the link to the order in the merchant's admin goes as (the setting `adminUrl` filled in), when it is set. */
export const STAFF_ALERT_LINK = 'link';
/** The value the shopper's phone on the order goes as, with the setting `includePhone` on. */
export const STAFF_ALERT_PHONE = 'phone';

/**
 * The permission `staffPermission: all_staff` stands for, per event: every staff member who may see orders, and for a
 * claim every one who handles claims.
 */
export const ALL_STAFF_PERMISSIONS = Object.freeze(
	/** @type {Record<keyof typeof STAFF_ALERT_EVENTS, string>} */ ({
		placed: 'orders.read',
		status: 'orders.read',
		paid: 'orders.read',
		proof_uploaded: 'orders.read',
		canceled: 'orders.read',
		expired: 'orders.read',
		return_requested: 'returns.manage',
		refund_due: 'orders.refund',
	}),
);

/**
 * The values a staff alert may carry: a value not listed above fails the type check of the code that sends it.
 * @typedef {{ [key in typeof STAFF_ALERT_VALUES[number] | typeof STAFF_ALERT_EVENTS[keyof typeof STAFF_ALERT_EVENTS][number] | typeof STAFF_ALERT_PHONE]?: string | number }} StaffAlertValues
 */
