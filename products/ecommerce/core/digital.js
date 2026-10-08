/**
 * Digital goods (PLAN 0.8.8: download/licence after payment). A digital product keeps its files in the merchant's own
 * storage (`ecommerce/digital/<productId>/<name>`) and may have licence keys (one per unit sold, given when the order
 * is paid). Downloads are short-lived signed links (5 minutes), counted per order line up to the product's download
 * limit (else the `digital_goods` setting `downloadLimit`; 0 = no limit). No I/O.
 * @module
 */

/** A download link lasts this long. */
export const DOWNLOAD_SECONDS = 300;
/** The largest digital file (one signed upload). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;
/** At most this many licence keys per call, and this long each. */
const MAX_KEYS_PER_CALL = 1000;
const MAX_KEY_LENGTH = 500;

/**
 * A file name safe for a storage key and a download (letters, digits, dot, dash, underscore; at most 120 characters),
 * or null.
 * @param {unknown} name
 * @returns {string | null}
 */
export const safeFileName = (name) => {
	if (typeof name !== 'string') return null;
	const clean = name
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, '-')
		.replace(/^[-.]+/, '')
		.slice(0, 120);
	return clean && /[A-Za-z0-9]/.test(clean) ? clean : null;
};

/** The storage key of a product's file. @param {string} productId @param {string} name a safe file name */
export const fileKey = (productId, name) => `ecommerce/digital/${productId}/${name}`;

/** The file name of a storage key. @param {string} key */
export const fileNameOf = (key) => key.slice(key.lastIndexOf('/') + 1);

/**
 * Licence keys to add: trimmed, without blanks and repeats.
 * @param {unknown} value
 * @returns {{ ok: true, value: string[] } | { ok: false, message: string }}
 */
export const checkLicenceKeys = (value) => {
	const message = `keys is a list of 1–${MAX_KEYS_PER_CALL} licence keys of at most ${MAX_KEY_LENGTH} characters.`;
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_KEYS_PER_CALL) return { ok: false, message };
	/** @type {Set<string>} */
	const keys = new Set();
	for (const item of value) {
		const key = typeof item === 'string' ? item.trim() : '';
		if (!key || key.length > MAX_KEY_LENGTH) return { ok: false, message };
		keys.add(key);
	}
	return { ok: true, value: [...keys] };
};

/**
 * The download limit of a product's files per order line (0 = no limit).
 * @param {{ digital: { downloadLimit: number } | null }} product
 * @param {number} settingLimit the `digital_goods` setting
 */
export const downloadLimitOf = (product, settingLimit) => {
	const own = product.digital?.downloadLimit ?? 0;
	return Number.isSafeInteger(own) && own > 0 ? own : Math.max(0, Math.floor(settingLimit) || 0);
};

/**
 * Whether an order line may be downloaded now: the order is paid (a partial refund keeps it) and the line is under its
 * limit.
 * @param {{ paymentState: string, downloads: number, limit: number }} input
 * @returns {{ ok: true } | { ok: false, reason: 'not_paid' | 'limit_reached' }}
 */
export const canDownload = ({ paymentState, downloads, limit }) => {
	if (paymentState !== 'paid' && paymentState !== 'partially_refunded') return { ok: false, reason: 'not_paid' };
	if (limit > 0 && downloads >= limit) return { ok: false, reason: 'limit_reached' };
	return { ok: true };
};
