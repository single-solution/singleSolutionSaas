/**
 * Typed errors of `@ss/net`. Messages never contain credentials, response bodies or upstream error text.
 * @module
 */

/** Every error code `@ss/net` throws. */
export const NET_ERROR_CODES = Object.freeze(
	/** @type {const} */ (['bad_url', 'ssrf_blocked', 'timeout', 'too_large', 'redirect_refused', 'aborted', 'network']),
);

/** @typedef {typeof NET_ERROR_CODES[number]} NetErrorCode */

/**
 * @typedef {Error & { name: 'NetError', code: NetErrorCode, reason: string, detail?: string }} NetError
 * `reason` is a stable machine-readable refinement (e.g. `https_required`, `private_address`); `detail` is the
 * underlying system error code for `network` failures (e.g. `ENOTFOUND`, `CERT_HAS_EXPIRED`).
 */

/**
 * Create a typed error.
 * @param {NetErrorCode} code
 * @param {string} reason
 * @param {string} message
 * @param {string} [detail]
 * @returns {NetError}
 */
export const netError = (code, reason, message, detail) => {
	const error = /** @type {NetError} */ (new Error(message));
	error.name = 'NetError';
	error.code = code;
	error.reason = reason;
	if (detail !== undefined) error.detail = detail;
	return error;
};

/**
 * Type guard for errors produced by this package.
 * @param {unknown} value
 * @param {NetErrorCode} [code] when given, also require this code
 * @returns {value is NetError}
 */
export const isNetError = (value, code) =>
	value instanceof Error &&
	value.name === 'NetError' &&
	typeof (/** @type {{ code?: unknown }} */ (value).code) === 'string' &&
	(code === undefined || /** @type {NetError} */ (value).code === code);
