/**
 * Generic HTTP client for a merchant's own provider (kept for messaging until Notifications ships, PLAN 0.3): JSON
 * requests to the provider base URL of a connection value `{ baseUrl, apiKey, authScheme?, authHeader?, headers?,
 * paths? }`, authenticated with the merchant's API key. Only relative paths under the base URL are allowed. Requests go
 * through the outbound `send` (`@ss/net` `safeFetch` under the product's outbound policy: https only, every DNS answer
 * vetted at connect time, no redirects, size cap). Credentials never appear in logs or errors.
 * @module
 */
import { checkUrl, createOutboundPolicy, isNetError } from '@ss/net';
import { isObject, kitError } from '../util.js';

/** @typedef {import('../connections.js').OutboundSend} OutboundSend */

/**
 * @typedef {object} HttpDescriptor
 * @property {string} baseUrl
 * @property {string} apiKey
 * @property {string} [provider]
 * @property {string} [model]
 * @property {'bearer' | 'header'} [authScheme] default bearer
 * @property {string} [authHeader] header name when `authScheme: 'header'` (e.g. `x-api-key`)
 * @property {Record<string, string>} [headers] extra non-secret headers (e.g. API version)
 * @property {Record<string, string>} [paths] named operation paths (`complete`, `send`, …)
 */

/**
 * @param {Record<string, unknown>} descriptor
 * @param {import('@ss/net').OutboundPolicy} policy
 * @returns {HttpDescriptor}
 */
const checkDescriptor = (descriptor, policy) => {
	if (typeof descriptor.baseUrl !== 'string' || typeof descriptor.apiKey !== 'string' || descriptor.apiKey === '') {
		throw kitError('connection_invalid', 'the connection needs baseUrl and apiKey');
	}
	if (/[?#]/.test(descriptor.baseUrl)) throw kitError('connection_invalid', 'provider baseUrl must be plain');
	const checked = checkUrl(descriptor.baseUrl, policy);
	if (!checked.ok) {
		throw kitError(
			'connection_invalid',
			checked.reason === 'https_required' ? 'provider baseUrl must be https' : `provider baseUrl refused (${checked.reason})`,
		);
	}
	return /** @type {HttpDescriptor} */ (/** @type {unknown} */ (descriptor));
};

/**
 * @param {{ descriptor: Record<string, unknown>, kind: string, send: OutboundSend, timeoutMs?: number,
 *   policy?: import('@ss/net').OutboundPolicy }} options `policy` vets the base URL up front (default: public https only)
 */
export const createHttpClient = ({ descriptor, kind, send, timeoutMs = 30_000, policy = createOutboundPolicy() }) => {
	const d = checkDescriptor(descriptor, policy);
	const base = new URL(d.baseUrl);
	const basePath = base.pathname.replace(/\/+$/, '');

	/**
	 * @param {{ method?: string, path: string, body?: unknown, headers?: Record<string, string>, timeoutMs?: number }} input
	 * @returns {Promise<{ ok: boolean, status: number, body: unknown }>}
	 */
	const request = async ({ method = 'POST', path, body, headers = {}, timeoutMs: t = timeoutMs }) => {
		if (
			typeof path !== 'string' ||
			!path.startsWith('/') ||
			path.startsWith('//') ||
			path.includes('..') ||
			/[\s\\]/.test(path)
		) {
			throw kitError('invalid_argument', 'provider path must be a relative path starting with /');
		}
		const url = new URL(`${basePath}${path}`, base.origin);
		if (url.origin !== base.origin) throw kitError('invalid_argument', 'provider path escapes the provider origin');
		/** @type {Record<string, string>} */
		const h = { accept: 'application/json', ...(d.headers ?? {}), ...headers };
		if (body !== undefined) h['content-type'] = 'application/json';
		if (d.authScheme === 'header') h[(d.authHeader ?? 'x-api-key').toLowerCase()] = d.apiKey;
		else h.authorization = `Bearer ${d.apiKey}`;
		/** @type {import('@ss/net').SafeResponse} */
		let response;
		try {
			response = await send(url.href, {
				method,
				headers: h,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				timeoutMs: t,
				redirect: 'error',
			});
		} catch (error) {
			const timeout = isNetError(error, 'timeout');
			throw kitError(timeout ? 'timeout' : 'upstream_error', `${kind} provider request failed`, {
				...(isNetError(error) ? { reason: error.code } : {}),
			});
		}
		const text = response.body.toString('utf8');
		/** @type {unknown} */
		let parsed = text;
		try {
			parsed = text.length > 0 ? JSON.parse(text) : null;
		} catch {
			// keep text
		}
		return { ok: response.status >= 200 && response.status <= 299, status: response.status, body: parsed };
	};

	/**
	 * @param {string} name
	 * @param {string} fallback
	 */
	const pathOf = (name, fallback) => (isObject(d.paths) && typeof d.paths[name] === 'string' ? d.paths[name] : fallback);

	return Object.freeze({ kind, provider: d.provider ?? 'http', model: d.model, request, pathOf });
};

/**
 * Messaging adapter: `send(message)` POSTs the message to `paths.send` (default `/messages`).
 * @param {{ descriptor: Record<string, unknown>, send: OutboundSend, policy?: import('@ss/net').OutboundPolicy }} options
 */
export const createHttpMessaging = ({ descriptor, send, policy }) => {
	const http = createHttpClient({ descriptor, kind: 'messaging', send, ...(policy ? { policy } : {}) });
	return Object.freeze({
		...http,
		/** @param {Record<string, unknown>} message */
		send: async (message) => {
			const result = await http.request({ path: http.pathOf('send', '/messages'), body: message });
			if (!result.ok)
				throw kitError('upstream_error', `messaging provider answered ${result.status}`, { status: result.status });
			return result.body;
		},
	});
};
