/**
 * Channels and recipients (PLAN 0.8.5): the five channels, the feature each belongs to, and the checks of a recipient's
 * address. No I/O: the API, the adapters and the widgets share it.
 * @module
 */

/** @typedef {'email' | 'sms' | 'whatsapp' | 'push' | 'staff_push'} Channel */

/** Every channel, in the order screens list them. */
export const CHANNELS = Object.freeze(/** @type {Channel[]} */ (['email', 'sms', 'whatsapp', 'push', 'staff_push']));

/** The feature that switches each channel on. */
export const CHANNEL_FEATURES = Object.freeze({
	email: 'email',
	sms: 'sms',
	whatsapp: 'whatsapp',
	push: 'browser_push',
	staff_push: 'staff_push',
});

/** The connection each channel sends through (push and staff push share the merchant's push keys). */
export const CHANNEL_CONNECTIONS = Object.freeze({
	email: 'email',
	sms: 'sms',
	whatsapp: 'whatsapp',
	push: 'push_keys',
	staff_push: 'push_keys',
});

/** Channels a fallback may lead to (and come from): messages with a text body to an e-mail address or a phone. */
export const FALLBACK_CHANNELS = Object.freeze(/** @type {Array<'email' | 'sms' | 'whatsapp'>} */ (['email', 'sms', 'whatsapp']));

/** The member of `to` each channel needs. */
export const ADDRESS_FIELDS = Object.freeze({
	email: 'email',
	sms: 'phone',
	whatsapp: 'phone',
	push: 'subscriberId',
	staff_push: 'staffId',
});

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,63}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

/**
 * An e-mail address in its stored form (lower case), or null.
 * @param {unknown} value
 * @returns {string | null}
 */
export const normaliseEmail = (value) => {
	if (typeof value !== 'string') return null;
	const email = value.trim().toLowerCase();
	return email.length <= 254 && EMAIL.test(email) ? email : null;
};

/**
 * A phone number in international form (`+` and 8–15 digits; spaces, dashes, dots and brackets are dropped), or null.
 * Numbers without the leading `+` and country code are refused: the code never guesses a country.
 * @param {unknown} value
 * @returns {string | null}
 */
export const normalisePhone = (value) => {
	if (typeof value !== 'string') return null;
	const compact = value.trim().replace(/[\s().-]/g, '');
	const international = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
	return /^\+[1-9]\d{7,14}$/.test(international) ? international : null;
};

/**
 * A language tag (`en`, `ur`, `pt-BR`), or null.
 * @param {unknown} value
 * @returns {string | null}
 */
export const normaliseLanguage = (value) => (typeof value === 'string' && LANGUAGE.test(value) ? value : null);

/**
 * An IANA time zone the runtime knows, or null.
 * @param {unknown} value
 * @returns {string | null}
 */
export const normaliseTimeZone = (value) => {
	if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
	try {
		new Intl.DateTimeFormat('en', { timeZone: value });
		return value;
	} catch {
		return null;
	}
};

/**
 * @typedef {object} Recipient
 * @property {string | null} email
 * @property {string | null} phone
 * @property {string | null} subscriberId a browser push subscriber (from the push-permission widget)
 * @property {string | null} staffId a member of the merchant's staff (from a ticket)
 * @property {string | null} language
 * @property {string | null} timeZone
 */

/**
 * Check the `to` of a send: every given member must be valid; at least one address.
 * @param {unknown} input
 * @returns {{ ok: true, value: Recipient } | { ok: false, field: string }}
 */
export const checkRecipient = (input) => {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, field: 'to' };
	const to = /** @type {Record<string, unknown>} */ (input);
	/** @type {Recipient} */
	const value = {
		email: to.email === undefined ? null : normaliseEmail(to.email),
		phone: to.phone === undefined ? null : normalisePhone(to.phone),
		subscriberId:
			to.subscriberId === undefined
				? null
				: typeof to.subscriberId === 'string' && ID.test(to.subscriberId)
					? to.subscriberId
					: null,
		staffId: to.staffId === undefined ? null : typeof to.staffId === 'string' && ID.test(to.staffId) ? to.staffId : null,
		language: to.language === undefined ? null : normaliseLanguage(to.language),
		timeZone: to.timeZone === undefined ? null : normaliseTimeZone(to.timeZone),
	};
	for (const field of /** @type {const} */ (['email', 'phone', 'subscriberId', 'staffId', 'language', 'timeZone']))
		if (to[field] !== undefined && value[field] === null) return { ok: false, field: `to/${field}` };
	if (!value.email && !value.phone && !value.subscriberId && !value.staffId) return { ok: false, field: 'to' };
	return { ok: true, value };
};

/**
 * The address a channel sends to, or null when the recipient has none for it.
 * @param {Channel} channel
 * @param {Recipient} to
 * @returns {string | null}
 */
export const addressFor = (channel, to) => to[ADDRESS_FIELDS[channel]];
