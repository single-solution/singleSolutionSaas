/**
 * Small helpers of the gateway adapters: form encoding and reading gateway answers (comparing and signing are
 * `@ss/protocol`'s).
 * @module
 */

/** @typedef {(url: string, init?: import('@ss/net').SafeFetchInit) => Promise<import('@ss/net').SafeResponse>} OutboundSend */

/** Timeout of one gateway call. */
export const GATEWAY_TIMEOUT_MS = 15_000;

/**
 * `application/x-www-form-urlencoded` body of fields in the given order (nested names as given, e.g. `a[b]`).
 * @param {Record<string, string | number>} fields
 */
export const formBody = (fields) => new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)])).toString();

/**
 * PHP's `urlencode` (spaces as `+`, every other character except letters, digits, `-`, `_` and `.` percent-encoded in
 * capitals), which PayFast signs with.
 * @param {string} text
 */
export const phpUrlencode = (text) =>
	encodeURIComponent(text)
		.replace(/[!'()*~]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
		.replace(/%20/g, '+');

/**
 * The JSON of a gateway answer, or null.
 * @param {import('@ss/net').SafeResponse} response
 * @returns {any}
 */
export const jsonOf = (response) => {
	try {
		return JSON.parse(response.body.toString('utf8'));
	} catch {
		return null;
	}
};

/**
 * Fields of a form body or query string, in their order (the last value wins for a repeated name).
 * @param {string} text
 * @returns {Array<[string, string]>}
 */
export const formFields = (text) => {
	/** @type {Map<string, string>} */
	const fields = new Map();
	for (const [name, value] of new URLSearchParams(text)) fields.set(name, value);
	return [...fields];
};
