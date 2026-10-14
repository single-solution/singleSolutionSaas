/**
 * Staff alerts (PLAN 0.8.10 K6, E32) sent by Ecommerce as required messages through its outbox (K-17, owner decision
 * D7: an alert is saved before it is sent, right after the answer, and tried again on the website's next uses while
 * Notifications cannot be reached). Recipients and the link follow the kit's staff-alert rules: the feature's
 * `recipients` setting (email addresses, and international phone numbers that get WhatsApp, or SMS with
 * `phoneChannel: sms`; at most 20), plus every unblocked Accounts user whose role grants `staffPermission` (asked
 * through the pasted Accounts token, kept 5 minutes on this instance) — `all_staff` stands for the permission of each
 * alert's own work ({@link ALL_STAFF_PERMISSIONS}: `orders.read` for orders, `returns.manage` for claims); the
 * template is `ecommerce.staff_<event>` (default words in `schemas/messages.json`, parity P1), and `adminUrl` filled
 * from the values is sent as `link`. With `includePhone` on, an alert also carries the shopper's phone as `phone`.
 * @module
 */
import { formatText } from '@ss/app-kit';
import { normalisePhone } from '@ss/contracts/phone';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../adapters/outbox.js').OutboxMessage} OutboxMessage */

/** Most recipients a `recipients` setting holds. */
const MAX_RECIPIENTS = 20;
/** Accounts users with a permission are asked again after this long. */
const STAFF_CACHE_MS = 5 * 60_000;
/** Most Accounts users read per permission. */
const STAFF_PAGE = 100;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;
const EVENT = /^[a-z][a-z0-9_]{0,40}$/;
const PERMISSION = /^[a-z][a-z0-9_.]{0,63}$/;

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
	cancelled: Object.freeze(/** @type {const} */ (['reason'])),
	expired: Object.freeze(/** @type {const} */ (['reason'])),
	return_requested: Object.freeze(/** @type {const} */ (['claimId', 'reference'])),
});
/** The value the link to the order in the merchant's admin goes as (the setting `adminUrl` filled in), when it is set. */
export const STAFF_ALERT_LINK = 'link';
/** The value the shopper's phone on the order goes as, with the setting `includePhone` on. */
export const STAFF_ALERT_PHONE = 'phone';

/** The `staffPermission` value that alerts every staff member who works with the alert's subject. */
const ALL_STAFF = 'all_staff';
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
		cancelled: 'orders.read',
		expired: 'orders.read',
		return_requested: 'returns.manage',
	}),
);

/**
 * The values a staff alert may carry: a value not listed above fails the type check of the code that sends it.
 * @typedef {{ [key in typeof STAFF_ALERT_VALUES[number] | typeof STAFF_ALERT_EVENTS[keyof typeof STAFF_ALERT_EVENTS][number] | typeof STAFF_ALERT_PHONE]?: string | number }} StaffAlertValues
 */

/**
 * An address as a recipient: `{ email }` or `{ phone }` with its dedupe key, or null. Phones are E.164 through the
 * normalizer every product shares (`@ss/contracts/phone`, K12), with their `+` or `00` and calling code, as the kit's
 * staff alerts read them; a local number is left out.
 * @param {unknown} value
 * @returns {{ key: string, to: { email: string } | { phone: string } } | null}
 */
export const recipientOf = (value) => {
	if (typeof value !== 'string') return null;
	const text = value.trim();
	if (EMAIL.test(text)) return { key: `e:${text.toLowerCase()}`, to: { email: text.toLowerCase() } };
	const phone = normalisePhone(text);
	return phone ? { key: `p:${phone.slice(1)}`, to: { phone } } : null;
};

/**
 * @param {Product} product
 * @param {Service} service
 */
export const createStaffAlerts = (product, service) => {
	/** @type {Map<string, { at: number, addresses: string[] }>} */
	const staffCache = new Map();

	/**
	 * The email addresses (else phones) of unblocked Accounts users whose role grants a permission.
	 * @param {Site} s @param {string} permission `ecommerce:<key>`
	 * @returns {Promise<string[]>}
	 */
	const staffWith = async (s, permission) => {
		const key = `${s.websiteId}|${permission}`;
		const cached = staffCache.get(key);
		if (cached && service.now() - cached.at < STAFF_CACHE_MS) return cached.addresses;
		const answer = await product
			.callProduct(
				s.websiteId,
				'accounts',
				`/v1/users?permission=${encodeURIComponent(permission)}&blocked=false&limit=${STAFF_PAGE}`,
			)
			.catch(() => /** @type {const} */ ({ ok: false }));
		if (!answer.ok) return cached?.addresses ?? [];
		const items = /** @type {any} */ (answer.body)?.items;
		const addresses = (Array.isArray(items) ? items : [])
			.filter((user) => typeof user === 'object' && user !== null && user.blocked !== true)
			.map((user) => (typeof user.email === 'string' && user.email ? user.email : user.phone))
			.filter((address) => typeof address === 'string' && address !== '');
		staffCache.set(key, { at: service.now(), addresses });
		return addresses;
	};

	/**
	 * Alert the staff of an event, as the feature's settings say. Never throws once the alerts are saved.
	 * @param {Site} s
	 * @param {{ feature: string, event: string, values: StaffAlertValues }} alert
	 * @returns {Promise<number>} the messages saved
	 */
	const send = async (s, { feature, event, values }) => {
		if (!EVENT.test(event)) return 0;
		const own = await s.values(feature);
		const listed = Array.isArray(own.recipients) ? own.recipients.slice(0, MAX_RECIPIENTS) : [];
		const chosen = typeof own.staffPermission === 'string' ? own.staffPermission : '';
		const byEvent = /** @type {Readonly<Record<string, string>>} */ (ALL_STAFF_PERMISSIONS);
		const permission = chosen === ALL_STAFF ? (byEvent[event] ?? ALL_STAFF_PERMISSIONS.placed) : chosen;
		const staff = permission !== '' && PERMISSION.test(permission) ? await staffWith(s, `ecommerce:${permission}`) : [];
		/** @type {Map<string, { email: string } | { phone: string }>} */
		const to = new Map();
		for (const value of [...listed, ...staff]) {
			const found = recipientOf(value);
			if (found && !to.has(found.key)) to.set(found.key, found.to);
		}
		const adminUrl = typeof own.adminUrl === 'string' ? own.adminUrl : '';
		const link = adminUrl === '' ? '' : formatText(adminUrl, values);
		/** @type {OutboxMessage[]} */
		const messages = [...to.values()].map((recipient) => ({
			channel: 'email' in recipient ? 'email' : own.phoneChannel === 'sms' ? 'sms' : 'whatsapp',
			template: `ecommerce.staff_${event}`,
			to: recipient,
			values: { ...values, ...(link === '' ? {} : { [STAFF_ALERT_LINK]: link }) },
		}));
		await service.sendRequired(s, messages, { later: true });
		return messages.length;
	};

	return Object.freeze({ send });
};
