/**
 * Staff alerts (PLAN 0.8.10 K6): one kit helper for products that alert the merchant's staff through Notifications
 * (the pasted Notifications token).
 *
 * - Recipients: the feature's `recipients` setting (e-mail addresses and phone numbers, at most 20); plus, when its
 *   `staffPermission` setting names a permission, every unblocked Accounts user whose role grants it (through the
 *   pasted Accounts token: `GET /v1/users?permission=<product>:<key>&blocked=false`, cached 5 minutes); plus the
 *   assignee where the product has one.
 * - An e-mail address gets e-mail; an international phone number gets WhatsApp, or SMS with the feature's
 *   `phoneChannel` setting.
 * - Templates `<product>.staff_<event>` (required, not urgent); one message per address per event, sent right after the
 *   request; the link is built from the feature's `adminUrl` template (`{placeholders}` filled from the values) and
 *   sent as the value `link`.
 * @module
 */
import { formatText } from './text.js';

/** @typedef {{ email?: string | null, phone?: string | null }} Assignee */
/** @typedef {{ websiteId: string, after: (task: () => Promise<unknown>) => void }} AlertContext */

/** Most recipients a `recipients` setting holds. */
export const MAX_RECIPIENTS = 20;
/** Accounts users with a permission are asked again after this long. */
const STAFF_CACHE_MS = 5 * 60_000;
/** Most Accounts users read per permission. */
const STAFF_PAGE = 100;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;
const PHONE = /^(?:\+|00)[0-9 ().-]{8,40}$/;
const EVENT = /^[a-z][a-z0-9_]{0,40}$/;
const PERMISSION = /^[a-z][a-z0-9_.]{0,63}$/;

/**
 * An address as a recipient: `{ email }` or `{ phone }` with its dedupe key, or null. Phones are international
 * (`+` or `00`, then 8–15 digits), as Notifications sends to them; a local number is left out.
 * @param {unknown} value
 * @returns {{ key: string, to: { email: string } | { phone: string } } | null}
 */
export const recipientOf = (value) => {
	if (typeof value !== 'string') return null;
	const text = value.trim();
	if (EMAIL.test(text)) return { key: `e:${text.toLowerCase()}`, to: { email: text.toLowerCase() } };
	if (PHONE.test(text)) {
		const compact = text.replace(/[^0-9+]/g, '');
		const digits = compact.startsWith('00') ? compact.slice(2) : compact.slice(1);
		if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
		return { key: `p:${digits}`, to: { phone: `+${digits}` } };
	}
	return null;
};

/**
 * @param {{ productId: string, settings: import('./settings.js').Settings,
 *   connections: import('./connections.js').Connections, now: () => number, logger: import('./logger.js').Logger }} options
 */
export const createStaffAlerts = ({ productId, settings, connections, now, logger }) => {
	/** @type {Map<string, { at: number, addresses: string[] }>} */
	const staffCache = new Map();

	/**
	 * The e-mail addresses and phones of unblocked Accounts users whose role grants a permission (cached 5 minutes).
	 * @param {string} websiteId
	 * @param {string} permission `<product>:<key>`
	 * @returns {Promise<string[]>}
	 */
	const staffWith = async (websiteId, permission) => {
		const key = `${websiteId}|${permission}`;
		const cached = staffCache.get(key);
		if (cached && now() - cached.at < STAFF_CACHE_MS) return cached.addresses;
		const answer = await connections.callProduct(
			websiteId,
			'accounts',
			`/v1/users?permission=${encodeURIComponent(permission)}&blocked=false&limit=${STAFF_PAGE}`,
		);
		if (!answer.ok) {
			logger.info('staff with a permission not read from Accounts', { websiteId, reason: answer.reason });
			return cached?.addresses ?? [];
		}
		const body = /** @type {{ items?: unknown }} */ (answer.body ?? {});
		const items = Array.isArray(body.items) ? body.items : [];
		/** @type {string[]} */
		const addresses = [];
		for (const user of items) {
			if (typeof user !== 'object' || user === null) continue;
			const { email, phone, blocked } = /** @type {Record<string, unknown>} */ (user);
			if (blocked === true) continue;
			if (typeof email === 'string' && email !== '') addresses.push(email);
			else if (typeof phone === 'string' && phone !== '') addresses.push(phone);
		}
		staffCache.set(key, { at: now(), addresses });
		return addresses;
	};

	/**
	 * Everyone an alert of a feature goes to, deduplicated.
	 * @param {string} websiteId
	 * @param {Record<string, any>} values the feature's settings
	 * @param {Assignee | null | undefined} assignee
	 */
	const recipientsOf = async (websiteId, values, assignee) => {
		const listed = Array.isArray(values.recipients) ? values.recipients.slice(0, MAX_RECIPIENTS) : [];
		const permission = typeof values.staffPermission === 'string' ? values.staffPermission : '';
		const staff =
			permission !== '' && PERMISSION.test(permission) ? await staffWith(websiteId, `${productId}:${permission}`) : [];
		const assigned = [assignee?.email, assignee?.phone].filter((value) => typeof value === 'string' && value !== '');
		/** @type {Map<string, { email: string } | { phone: string }>} */
		const out = new Map();
		for (const value of [...listed, ...staff, ...assigned]) {
			const found = recipientOf(value);
			if (found && !out.has(found.key)) out.set(found.key, found.to);
		}
		return [...out.values()];
	};

	/**
	 * Alert the merchant's staff of an event, right after the request. Never throws.
	 * @param {AlertContext} ctx
	 * @param {{ feature: string, event: string, values: Record<string, string | number>, assignee?: Assignee | null }} alert
	 *   `feature`: the feature whose settings hold `recipients`, `staffPermission`, `phoneChannel` and `adminUrl`;
	 *   `event`: the template is `<product>.staff_<event>`; `values`: the template's values (at most 1,000 characters each)
	 * @returns {Promise<number>} the messages queued after the request
	 */
	const send = async (ctx, { feature, event, values, assignee = null }) => {
		if (!EVENT.test(event)) return 0;
		const own = await settings.values(ctx.websiteId, feature);
		const to = await recipientsOf(ctx.websiteId, own, assignee);
		if (to.length === 0) return 0;
		const template = `${productId}.staff_${event}`;
		const adminUrl = typeof own.adminUrl === 'string' ? own.adminUrl : '';
		const link = adminUrl === '' ? '' : formatText(adminUrl, values);
		const channelOfPhone = own.phoneChannel === 'sms' ? 'sms' : 'whatsapp';
		ctx.after(async () => {
			for (const recipient of to) {
				const channel = 'email' in recipient ? 'email' : channelOfPhone;
				const answer = await connections.callProduct(ctx.websiteId, 'notifications', `/v1/messages/${channel}`, {
					method: 'POST',
					body: { template, to: recipient, values: { ...values, ...(link === '' ? {} : { link }) } },
				});
				if (!answer.ok) logger.info('staff alert not sent', { websiteId: ctx.websiteId, template, reason: answer.reason });
			}
		});
		return to.length;
	};

	return Object.freeze({ send, recipients: recipientsOf });
};

/** @typedef {ReturnType<typeof createStaffAlerts>} StaffAlerts */
