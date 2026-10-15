/**
 * Small helpers of the adapters.
 * @module
 */
import { normalizeEmail } from '@ss/contracts/email';

/** `Name <address>`: a display name of up to 128 characters (no quotes, backslashes or line breaks), then the address. */
const DISPLAY = /^([^<>\r\n"\\]{0,128}?)\s*<([^<>\s]+)>$/;

/**
 * A sender or reply-to mailbox: `address` or `Name <address>` on one line, the address one that every sending path can
 * deliver to (the one email rule of `@ss/contracts/email`; it is sent as given).
 * @param {unknown} value
 * @returns {value is string}
 */
export const isMailbox = (value) => {
	if (typeof value !== 'string' || value.length > 400 || /[\r\n]/.test(value)) return false;
	const address = DISPLAY.exec(value)?.[2] ?? value;
	return !/\s/.test(address) && normalizeEmail(address) !== null;
};

/**
 * An error with a stable code (and safe details: never credentials or message contents).
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 */
export const providerError = (code, message, details) => {
	const error = /** @type {Error & { code: string, details?: Record<string, unknown> }} */ (new Error(message));
	error.name = 'ProviderError';
	error.code = code;
	if (details) error.details = details;
	return error;
};
