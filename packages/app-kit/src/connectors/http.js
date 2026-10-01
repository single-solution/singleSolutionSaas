/**
 * Generic HTTP connector for merchant-owned providers (AI, messaging): JSON requests to the provider base URL from
 * the resolved descriptor, authenticated with the merchant's API key. Only relative paths under the base URL are
 * allowed (no SSRF through the path), https only (http on localhost for development). Credentials are never logged
 * and never appear in errors.
 * @module
 */
import { isObject, kitError } from '../util.js';

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
 * @returns {HttpDescriptor}
 */
const checkDescriptor = (descriptor) => {
	if (typeof descriptor.baseUrl !== 'string' || typeof descriptor.apiKey !== 'string' || descriptor.apiKey === '') {
		throw kitError('resource_invalid', 'connector descriptor needs baseUrl and apiKey');
	}
	/** @type {URL} */
	let url;
	try {
		url = new URL(descriptor.baseUrl);
	} catch {
		throw kitError('resource_invalid', 'connector baseUrl is invalid');
	}
	const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	if (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
		throw kitError('resource_invalid', 'connector baseUrl must be https');
	if (url.username || url.password || url.search || url.hash)
		throw kitError('resource_invalid', 'connector baseUrl must be plain');
	return /** @type {HttpDescriptor} */ (/** @type {unknown} */ (descriptor));
};

/**
 * @param {{ descriptor: Record<string, unknown>, kind: string, fetch: typeof globalThis.fetch, timeoutMs?: number }} options
 */
export const createHttpConnector = ({ descriptor, kind, fetch, timeoutMs = 30_000 }) => {
	const d = checkDescriptor(descriptor);
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
			throw kitError('invalid_argument', 'connector path must be a relative path starting with /');
		}
		const url = new URL(`${basePath}${path}`, base.origin);
		if (url.origin !== base.origin) throw kitError('invalid_argument', 'connector path escapes the provider origin');
		/** @type {Record<string, string>} */
		const h = { accept: 'application/json', ...(d.headers ?? {}), ...headers };
		if (body !== undefined) h['content-type'] = 'application/json';
		if (d.authScheme === 'header') h[(d.authHeader ?? 'x-api-key').toLowerCase()] = d.apiKey;
		else h.authorization = `Bearer ${d.apiKey}`;
		/** @type {Response} */
		let response;
		try {
			response = await fetch(url, {
				method,
				headers: h,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(t),
				redirect: 'error',
			});
		} catch (error) {
			const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
			throw kitError(timeout ? 'timeout' : 'upstream_error', `${kind} provider request failed`);
		}
		const text = await response.text();
		/** @type {unknown} */
		let parsed = text;
		try {
			parsed = text.length > 0 ? JSON.parse(text) : null;
		} catch {
			// keep text
		}
		return { ok: response.ok, status: response.status, body: parsed };
	};

	/**
	 * @param {string} name
	 * @param {string} fallback
	 */
	const pathOf = (name, fallback) => (isObject(d.paths) && typeof d.paths[name] === 'string' ? d.paths[name] : fallback);

	return Object.freeze({ kind, provider: d.provider ?? 'http', model: d.model, request, pathOf });
};

/**
 * AI adapter: `complete(input)` POSTs `{ model, ...input }` to `paths.complete` (default `/v1/chat/completions`).
 * @param {{ descriptor: Record<string, unknown>, fetch: typeof globalThis.fetch }} options
 */
export const createHttpAi = ({ descriptor, fetch }) => {
	const http = createHttpConnector({ descriptor, kind: 'ai', fetch });
	return Object.freeze({
		...http,
		/** @param {Record<string, unknown>} input */
		complete: async (input) => {
			const result = await http.request({
				path: http.pathOf('complete', '/v1/chat/completions'),
				body: { ...(http.model ? { model: http.model } : {}), ...input },
			});
			if (!result.ok) throw kitError('upstream_error', `ai provider answered ${result.status}`, { status: result.status });
			return result.body;
		},
	});
};

/**
 * Messaging adapter: `send(message)` POSTs the message to `paths.send` (default `/messages`).
 * @param {{ descriptor: Record<string, unknown>, fetch: typeof globalThis.fetch }} options
 */
export const createHttpMessaging = ({ descriptor, fetch }) => {
	const http = createHttpConnector({ descriptor, kind: 'messaging', fetch });
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
