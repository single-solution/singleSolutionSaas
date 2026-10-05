/**
 * Internal errors with a stable machine `code`. Messages never contain secrets, so they are safe to log.
 * HTTP-facing errors are RFC 9457 problems (see `http.js`); these are for infra failures and programming errors.
 * @module
 */

/**
 * @typedef {Error & { name: 'PlatformError', code: string, details?: Record<string, unknown> }} PlatformError
 */

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {PlatformError}
 */
export const platformError = (code, message, details) => {
	const error = /** @type {PlatformError} */ (new Error(message));
	error.name = 'PlatformError';
	error.code = code;
	if (details) error.details = details;
	return error;
};

/**
 * @param {unknown} error
 * @param {string} [code]
 * @returns {error is PlatformError}
 */
export const isPlatformError = (error, code) =>
	error instanceof Error &&
	error.name === 'PlatformError' &&
	(code === undefined || /** @type {PlatformError} */ (error).code === code);
