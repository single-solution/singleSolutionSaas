/**
 * Staff alerts (PLAN 0.8.10 K6, E32) sent by Ecommerce as required messages through its outbox (K-17, owner decision
 * D7: an alert is saved before it is sent, right after the answer, and tried again on the website's next uses while
 * Notifications cannot be reached). Recipients and the link follow the kit's staff-alert rules: the feature's
 * `recipients` setting (e-mail addresses, and international phone numbers that get WhatsApp, or SMS with
 * `phoneChannel: sms`; at most 20), plus every unblocked Accounts user whose role grants `staffPermission` (asked
 * through the pasted Accounts token, kept 5 minutes on this instance); the template is `ecommerce.staff_<event>`, and
 * `adminUrl` filled from the values is sent as `link`.
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

/**
 * An address as a recipient: `{ email }` or `{ phone }` with its dedupe key, or null. Phones are E.164 through the
 * normaliser every product shares (`@ss/contracts/phone`, K12), with their `+` or `00` and calling code, as the kit's
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
	 * The e-mail addresses (else phones) of unblocked Accounts users whose role grants a permission.
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
	 * @param {{ feature: string, event: string, values: Record<string, string | number> }} alert
	 * @returns {Promise<number>} the messages saved
	 */
	const send = async (s, { feature, event, values }) => {
		if (!EVENT.test(event)) return 0;
		const own = await s.values(feature);
		const listed = Array.isArray(own.recipients) ? own.recipients.slice(0, MAX_RECIPIENTS) : [];
		const permission = typeof own.staffPermission === 'string' ? own.staffPermission : '';
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
			values: { ...values, ...(link === '' ? {} : { link }) },
		}));
		await service.sendRequired(s, messages, { later: true });
		return messages.length;
	};

	return Object.freeze({ send });
};
