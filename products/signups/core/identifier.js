/**
 * Sign-in identifiers (pure): a channel (`email`, `sms`, `whatsapp`) and the address typed by the customer become one
 * canonical identifier — an e-mail address or an E.164 phone number. Customers are matched on the canonical value, so
 * one person never gets two accounts because they typed their number differently.
 * @module
 */
import { maskEmail, normaliseEmail } from './email.js';
import { maskPhone, normalisePhone } from './phone.js';

/** Channels a code or link can be delivered on. */
export const CHANNELS = Object.freeze(/** @type {const} */ (['email', 'sms', 'whatsapp']));

/** @typedef {typeof CHANNELS[number]} Channel */
/** @typedef {'email' | 'phone'} IdentifierKind */
/**
 * @typedef {object} Identifier
 * @property {IdentifierKind} kind
 * @property {Channel} channel
 * @property {string} value canonical e-mail address or E.164 number
 * @property {string} masked for display
 */

/**
 * Kind of identifier a channel delivers to.
 * @param {Channel} channel
 * @returns {IdentifierKind}
 */
export const kindOfChannel = (channel) => (channel === 'email' ? 'email' : 'phone');

/**
 * @param {unknown} channel
 * @returns {channel is Channel}
 */
export const isChannel = (channel) =>
	typeof channel === 'string' && /** @type {readonly string[]} */ (CHANNELS).includes(channel);

/**
 * Parse a `{ channel, to }` pair.
 * @param {{ channel: unknown, to: unknown }} input
 * @param {{ channels: readonly string[], defaultCallingCode?: string, trunkPrefix?: string }} options enabled channels and
 *   phone parsing options
 * @returns {{ ok: true, identifier: Identifier } | { ok: false, code: 'channel_disabled' | 'identifier_invalid' }}
 */
export const parseIdentifier = ({ channel, to }, { channels, defaultCallingCode = '', trunkPrefix = '' }) => {
	if (!isChannel(channel) || !channels.includes(channel)) return { ok: false, code: 'channel_disabled' };
	if (channel === 'email') {
		const value = normaliseEmail(to);
		return value
			? { ok: true, identifier: { kind: 'email', channel, value, masked: maskEmail(value) } }
			: { ok: false, code: 'identifier_invalid' };
	}
	const value = normalisePhone(to, { defaultCallingCode, trunkPrefix });
	return value
		? { ok: true, identifier: { kind: 'phone', channel, value, masked: maskPhone(value) } }
		: { ok: false, code: 'identifier_invalid' };
};

/**
 * Mask a stored identifier.
 * @param {IdentifierKind} kind
 * @param {string} value
 */
export const maskIdentifier = (kind, value) => (kind === 'email' ? maskEmail(value) : maskPhone(value));
