/**
 * Small helpers of the adapters.
 * @module
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

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
