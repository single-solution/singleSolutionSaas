/**
 * Typed protocol errors. Every verification failure in this package throws a `ProtocolError` whose `code` is stable and
 * machine-readable. Messages never contain token material, keys or secrets, so they are safe to log.
 */

/**
 * @typedef {'invalid_argument'
 *   | 'malformed'
 *   | 'unsupported_alg'
 *   | 'wrong_type'
 *   | 'signature'
 *   | 'unknown_kid'
 *   | 'revoked_key'
 *   | 'key_not_active'
 *   | 'key_retired'
 *   | 'jwks_unavailable'
 *   | 'expired'
 *   | 'not_yet_valid'
 *   | 'lifetime_too_long'
 *   | 'audience'
 *   | 'issuer'
 *   | 'subject'
 *   | 'replay'
 *   | 'invalid_launch'
 *   | 'invalid_token'} ProtocolErrorCode
 */

/**
 * @typedef {Error & { name: 'ProtocolError', code: ProtocolErrorCode, details?: Record<string, unknown> }} ProtocolError
 */

/** Every error code this package can throw. */
export const ERROR_CODES = Object.freeze(
	/** @type {const} */ ([
		'invalid_argument',
		'malformed',
		'unsupported_alg',
		'wrong_type',
		'signature',
		'unknown_kid',
		'revoked_key',
		'key_not_active',
		'key_retired',
		'jwks_unavailable',
		'expired',
		'not_yet_valid',
		'lifetime_too_long',
		'audience',
		'issuer',
		'subject',
		'replay',
		'invalid_launch',
		'invalid_token',
	]),
);

/**
 * Create a typed protocol error. `details` must never contain secrets or raw tokens.
 * @param {ProtocolErrorCode} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {ProtocolError}
 */
export const createProtocolError = (code, message, details) => {
	const error = /** @type {ProtocolError} */ (new Error(message));
	error.name = 'ProtocolError';
	error.code = code;
	if (details) error.details = details;
	return error;
};

/**
 * Type guard for errors produced by this package.
 * @param {unknown} value
 * @param {ProtocolErrorCode} [code] when given, also require this code
 * @returns {value is ProtocolError}
 */
export const isProtocolError = (value, code) =>
	value instanceof Error &&
	value.name === 'ProtocolError' &&
	typeof (/** @type {{ code?: unknown }} */ (value).code) === 'string' &&
	(code === undefined || /** @type {ProtocolError} */ (value).code === code);
