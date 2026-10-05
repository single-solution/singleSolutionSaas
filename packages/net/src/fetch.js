/**
 * `safeFetch`: SSRF-safe HTTP(S) client over `node:http` / `node:https`.
 *
 * Every hop: URL policy (`checkUrl`: https only unless allowlisted, no userinfo, allowed ports, public IP literals,
 * no internal names) → connection through `guardedLookup` (every DNS answer vetted, socket pinned to the vetted
 * answers, no connection reuse) → response size cap (declared `content-length` and streamed bytes) → redirects per
 * policy (GET/HEAD only, same origin unless `sameHostRedirectsOnly: false`, credentials dropped across origins, at
 * most `maxRedirects`). One overall deadline covers every hop. Failures are typed `NetError`s; messages never carry
 * upstream text.
 * @module
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isNetError, netError } from './errors.js';
import { guardedLookup } from './lookup.js';
import { checkUrl, createOutboundPolicy, sameOrigin } from './policy.js';

/** @typedef {import('./policy.js').OutboundPolicy} OutboundPolicy */
/** @typedef {import('./errors.js').NetError} NetError */

/**
 * @typedef {object} SafeFetchInit
 * @property {string} [method] default `GET`
 * @property {Record<string, string>} [headers]
 * @property {string | Uint8Array} [body]
 * @property {AbortSignal} [signal] aborts with `aborted`
 * @property {'follow' | 'manual' | 'error'} [redirect] `follow` (default) obeys the policy; `manual` returns 3xx
 *   responses as they are; `error` refuses any redirect with `redirect_refused`
 * @property {number} [timeoutMs] overrides the policy deadline
 * @property {number} [maxBytes] overrides the policy body cap
 */

/**
 * @typedef {object} SafeResponse
 * @property {number} status
 * @property {Record<string, string>} headers lower-case names; repeated headers joined with `, `
 * @property {Buffer} body
 * @property {string} url final URL (after redirects)
 */

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];
const TLS_CODE = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME|ALTNAME|EPROTO/;

/**
 * @param {Record<string, string | string[] | undefined>} raw
 * @returns {Record<string, string>}
 */
const flattenHeaders = (raw) => {
	/** @type {Record<string, string>} */
	const out = {};
	for (const [name, value] of Object.entries(raw)) {
		if (value !== undefined) out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
	}
	return out;
};

/**
 * Map a socket/request error to a `NetError`.
 * @param {unknown} error
 * @returns {NetError}
 */
const toNetError = (error) => {
	if (isNetError(error)) return error;
	const code = String(/** @type {{ code?: unknown }} */ (error)?.code ?? 'ERR');
	return netError('network', TLS_CODE.test(code) ? 'tls_failed' : 'request_failed', 'the request failed', code);
};

/**
 * One request to a checked URL.
 * @param {URL} url
 * @param {{ method: string, headers: Record<string, string>, body: Buffer | undefined, maxBytes: number,
 *   policy: OutboundPolicy, register: (cancel: (error: NetError) => void) => void }} input
 * @returns {Promise<{ status: number, headers: Record<string, string> , body: Buffer }>}
 */
const once = (url, { method, headers, body, maxBytes, policy, register }) =>
	new Promise((resolve, reject) => {
		let settled = false;
		/** @param {() => void} fn */
		const settle = (fn) => {
			if (settled) return;
			settled = true;
			fn();
		};
		const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
		const req = send(url, {
			method,
			headers: {
				'user-agent': policy.userAgent,
				...headers,
				...(body === undefined ? {} : { 'content-length': String(body.length) }),
			},
			lookup: /** @type {any} */ (guardedLookup(policy)),
			agent: false,
		});
		register((error) => {
			settle(() => reject(error));
			req.destroy();
		});
		req.on('error', (error) => settle(() => reject(toNetError(error))));
		req.on('response', (res) => {
			/** @param {NetError} error */
			const fail = (error) => {
				settle(() => reject(error));
				res.destroy();
				req.destroy();
			};
			const declared = Number(res.headers['content-length'] ?? '0');
			if (Number.isFinite(declared) && declared > maxBytes) {
				fail(netError('too_large', 'declared_length', `the response exceeds ${maxBytes} bytes`));
				return;
			}
			/** @type {Buffer[]} */
			const chunks = [];
			let size = 0;
			res.on('data', (/** @type {Buffer} */ chunk) => {
				size += chunk.length;
				if (size > maxBytes) fail(netError('too_large', 'body_length', `the response exceeds ${maxBytes} bytes`));
				else chunks.push(chunk);
			});
			res.on('end', () =>
				settle(() =>
					resolve({ status: res.statusCode ?? 0, headers: flattenHeaders(res.headers), body: Buffer.concat(chunks) }),
				),
			);
			res.on('error', (error) => settle(() => reject(toNetError(error))));
		});
		req.end(body);
	});

/**
 * Fetch a URL under an outbound policy.
 * @param {string | URL} target
 * @param {SafeFetchInit} [init]
 * @param {OutboundPolicy} [policy] default: `createOutboundPolicy()` (public https only)
 * @returns {Promise<SafeResponse>}
 */
export const safeFetch = async (target, init = {}, policy = createOutboundPolicy()) => {
	const {
		headers: initHeaders = {},
		body: initBody,
		signal,
		redirect = 'follow',
		timeoutMs = policy.timeoutMs,
		maxBytes = policy.maxBytes,
	} = init;
	const method = String(init.method ?? 'GET').toUpperCase();
	if (!/^[A-Z]{1,16}$/.test(method)) throw netError('bad_url', 'invalid_method', 'the request method is invalid');
	/** @type {Record<string, string>} */
	let headers = Object.fromEntries(Object.entries(initHeaders).map(([k, v]) => [k.toLowerCase(), String(v)]));
	const body = initBody === undefined ? undefined : typeof initBody === 'string' ? Buffer.from(initBody) : Buffer.from(initBody);

	/** @type {((error: NetError) => void) | null} */
	let cancel = null;
	/** @type {NetError | null} */
	let stopped = null;
	/** @param {NetError} error */
	const stop = (error) => {
		stopped = stopped ?? error;
		cancel?.(stopped);
	};
	const timer = setTimeout(
		() => stop(netError('timeout', 'deadline', `the request took longer than ${timeoutMs} ms`)),
		timeoutMs,
	);
	const onAbort = () => stop(netError('aborted', 'signal', 'the request was aborted'));
	if (signal?.aborted) onAbort();
	signal?.addEventListener('abort', onAbort, { once: true });
	try {
		let current = target;
		/** @type {URL | null} */
		let previous = null;
		for (let hop = 0; ; hop += 1) {
			if (stopped) throw stopped;
			const checked = checkUrl(current, policy);
			if (!checked.ok) throw netError(checked.code, checked.reason, `destination refused: ${checked.reason}`);
			if (previous && !sameOrigin(previous, checked.url)) {
				headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.includes(name)));
			}
			const res = await once(checked.url, {
				method,
				headers,
				body,
				maxBytes,
				policy,
				register: (fn) => {
					cancel = fn;
					if (stopped) fn(stopped);
				},
			});
			const location = res.headers.location;
			if (!REDIRECTS.has(res.status) || location === undefined || redirect === 'manual')
				return { ...res, url: checked.url.href };
			if (redirect === 'error') throw netError('redirect_refused', 'redirect_mode', `redirect (${res.status}) refused`);
			if (method !== 'GET' && method !== 'HEAD')
				throw netError('redirect_refused', 'method', `redirect (${res.status}) of a ${method} refused`);
			if (hop >= policy.maxRedirects) throw netError('redirect_refused', 'too_many', 'too many redirects');
			/** @type {URL} */
			let next;
			try {
				next = new URL(location, checked.url);
			} catch {
				throw netError('redirect_refused', 'invalid_location', 'the redirect location is invalid');
			}
			if (policy.sameHostRedirectsOnly && !sameOrigin(checked.url, next))
				throw netError('redirect_refused', 'cross_origin', 'redirect to another origin refused');
			previous = checked.url;
			current = next.href;
		}
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', onAbort);
	}
};

/**
 * Decode a response body as UTF-8 text.
 * @param {SafeResponse} response
 * @returns {string}
 */
export const textOf = (response) => response.body.toString('utf8');

/**
 * Parse a response body as JSON (`null` for an empty body); throws `SyntaxError` on invalid JSON.
 * @param {SafeResponse} response
 * @returns {unknown}
 */
export const jsonOf = (response) => (response.body.length === 0 ? null : JSON.parse(textOf(response)));
