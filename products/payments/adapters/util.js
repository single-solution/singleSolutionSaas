/**
 * Small helpers of the adapters: object checks, timing-safe comparison, HMAC, form encoding and reading gateway
 * answers.
 * @module
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** @typedef {(url: string, init?: import('@ss/net').SafeFetchInit) => Promise<import('@ss/net').SafeResponse>} OutboundSend */

/** Timeout of one gateway call. */
export const GATEWAY_TIMEOUT_MS = 15_000;

/** @param {unknown} value @returns {value is Record<string, any>} */
export const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A non-empty trimmed text field of an object, or ''.
 * @param {Record<string, unknown>} value
 * @param {string} name
 */
export const field = (value, name) => (typeof value[name] === 'string' ? value[name].trim() : '');

/**
 * Timing-safe equality of two texts.
 * @param {string} a
 * @param {string} b
 */
export const same = (a, b) => {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Hex HMAC-SHA256.
 * @param {string} key
 * @param {string} text
 */
export const hmacHex = (key, text) => createHmac('sha256', key).update(text).digest('hex');

/**
 * Check an `SS-Signature`-style header (`t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`; Stripe's
 * `Stripe-Signature` has the same shape and may repeat `v1`).
 * @param {{ header: string | null, body: string, secret: string, now: number, toleranceSeconds?: number }} input
 */
export const verifyTimestamped = ({ header, body, secret, now, toleranceSeconds = 300 }) => {
	const parts = (header ?? '').split(',').map((part) => part.trim().split('=', 2));
	const t = Number(parts.find(([name]) => name === 't')?.[1]);
	if (!Number.isInteger(t) || Math.abs(now / 1000 - t) > toleranceSeconds) return false;
	const expected = hmacHex(secret, `${t}.${body}`);
	return parts.some(([name, value]) => name === 'v1' && typeof value === 'string' && same(value, expected));
};

/**
 * The header value of a body signed as {@link verifyTimestamped} checks it.
 * @param {string} body
 * @param {string} secret
 * @param {number} now epoch ms
 */
export const signTimestamped = (body, secret, now) => {
	const t = Math.floor(now / 1000);
	return `t=${t},v1=${hmacHex(secret, `${t}.${body}`)}`;
};

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
