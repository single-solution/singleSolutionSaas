/**
 * Contacts (pure): who an alert goes to. A subscription has one channel (`email`, `sms`, `whatsapp`) and one address —
 * an e-mail, or a phone number in international E.164 form (`+` country code and number; no regional default, no
 * guessing of local formats). The address comes from the customer's own verified identity (bring-your-own identity:
 * `ctx.identity.email` / `phone`) or, when the merchant allows it, from what the shopper typed.
 * @module
 */

/** Channels a subscription can use; the merchant's messaging connector delivers them. */
export const CHANNELS = Object.freeze(/** @type {const} */ (['email', 'sms', 'whatsapp']));

/** @typedef {(typeof CHANNELS)[number]} Channel */
/** @typedef {{ email: string } | { phone: string }} Address */

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * @param {unknown} value
 * @returns {value is Channel}
 */
export const isChannel = (value) => typeof value === 'string' && /** @type {readonly string[]} */ (CHANNELS).includes(value);

/**
 * Which address field a channel needs.
 * @param {Channel} channel
 * @returns {'email' | 'phone'}
 */
export const fieldOf = (channel) => (channel === 'email' ? 'email' : 'phone');

/**
 * Normalised e-mail (trimmed, lower-case) or null.
 * @param {unknown} raw
 * @returns {string | null}
 */
export const normalizeEmail = (raw) => {
	if (typeof raw !== 'string') return null;
	const email = raw.trim().toLowerCase();
	return email.length <= 254 && EMAIL.test(email) ? email : null;
};

/**
 * Normalised E.164 phone number or null. Spaces, dots, dashes and parentheses are ignored and a leading `00` is the
 * international prefix; anything else must already be international (`+<country><number>`).
 * @param {unknown} raw
 * @returns {string | null}
 */
export const normalizePhone = (raw) => {
	if (typeof raw !== 'string' || raw.length > 40) return null;
	let phone = raw.replace(/[\s.()-]/g, '');
	if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
	return E164.test(phone) ? phone : null;
};

/**
 * Normalised address for a channel (null when invalid).
 * @param {Channel} channel
 * @param {unknown} value
 * @returns {Address | null}
 */
export const addressFor = (channel, value) => {
	if (fieldOf(channel) === 'email') {
		const email = normalizeEmail(value);
		return email ? { email } : null;
	}
	const phone = normalizePhone(value);
	return phone ? { phone } : null;
};

/**
 * Stable contact identity before hashing (`email:<address>` / `phone:<e164>`): the same person on sms and whatsapp
 * is one contact for caps and unsubscribe.
 * @param {Address} address
 */
export const contactIdOf = (address) => ('email' in address ? `email:${address.email}` : `phone:${address.phone}`);

/**
 * @typedef {object} ContactChoice
 * @property {Channel} channel
 * @property {unknown} [email] typed by the shopper
 * @property {unknown} [phone] typed by the shopper
 */

/**
 * Resolve the address of a subscription: the verified identity's own address first (when `preferIdentity`), else the
 * typed one (when `allowEntry`).
 * @param {ContactChoice} input
 * @param {{ email?: string, phone?: string } | null} identity verified customer identity
 * @param {{ allowEntry: boolean, preferIdentity: boolean }} policy
 * @returns {{ ok: true, address: Address, source: 'identity' | 'entry' } | { ok: false, code: 'contact_required' | 'contact_invalid' | 'entry_not_allowed' }}
 */
export const resolveAddress = ({ channel, email, phone }, identity, { allowEntry, preferIdentity }) => {
	const field = fieldOf(channel);
	const fromIdentity = identity ? addressFor(channel, identity[field]) : null;
	const typed = field === 'email' ? email : phone;
	if (fromIdentity && (preferIdentity || typed === undefined || typed === null || typed === ''))
		return { ok: true, address: fromIdentity, source: 'identity' };
	if (typed === undefined || typed === null || typed === '')
		return fromIdentity
			? { ok: true, address: fromIdentity, source: 'identity' }
			: { ok: false, code: allowEntry ? 'contact_required' : 'entry_not_allowed' };
	if (!allowEntry)
		return fromIdentity ? { ok: true, address: fromIdentity, source: 'identity' } : { ok: false, code: 'entry_not_allowed' };
	const entered = addressFor(channel, typed);
	return entered ? { ok: true, address: entered, source: 'entry' } : { ok: false, code: 'contact_invalid' };
};

/**
 * Masked address for display (`j•••@example.com`, `+44•••••••123`).
 * @param {Address | null | undefined} address
 * @returns {string | null}
 */
export const maskAddress = (address) => {
	if (!address) return null;
	if ('email' in address && typeof address.email === 'string') {
		const [local = '', domain = ''] = address.email.split('@');
		return `${local.slice(0, 1)}•••@${domain}`;
	}
	if ('phone' in address && typeof address.phone === 'string') {
		const digits = address.phone;
		return `${digits.slice(0, 3)}${'•'.repeat(Math.max(0, digits.length - 6))}${digits.slice(-3)}`;
	}
	return null;
};
