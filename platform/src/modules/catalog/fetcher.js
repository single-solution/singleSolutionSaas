/**
 * SSRF-safe HTTP client for the catalog's outbound calls (product registration, manifest refresh).
 *
 * Every request: URL policy (`core/net.js` `checkTarget`) → DNS resolution of **all** addresses, each checked with
 * `addressRefusal` (one bad answer refuses the whole name) → connection to the vetted address only (pinned through the
 * socket `lookup`, so a second DNS answer cannot rebind the target; TLS still verifies the certificate for the host
 * name) → overall timeout → response size cap (declared `content-length` and streamed bytes) → redirects followed only
 * for GET, only to the same scheme/host/port, at most 3 times. Hosts on the development allowlist may use plain http
 * and private addresses; nothing else may.
 * @module
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { platformError } from '../../infra/errors.js';
import { addressRefusal, checkTarget, normaliseAllowlist, sameTarget } from './core/net.js';

/** @typedef {import('../../infra/errors.js').PlatformError} PlatformError */
/** @typedef {(host: string) => Promise<Array<{ address: string, family: number }>>} ResolveHost */
/**
 * @typedef {object} FetchResult
 * @property {number} status
 * @property {Record<string, string>} headers lower-case names
 * @property {string} text body as UTF-8
 * @property {string} url final URL (after same-host redirects)
 */
/**
 * @typedef {(url: string, init?: { method?: 'GET' | 'POST', headers?: Record<string, string>, body?: string,
 *   maxBytes?: number, timeoutMs?: number }) => Promise<FetchResult>} SafeFetch
 */

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;

/** @type {ResolveHost} */
const defaultResolve = (host) => dnsLookup(host, { all: true, verbatim: true });

/**
 * @param {string} code `target_refused` | `redirect_refused` | `too_large` | `timeout` | `network`
 * @param {string} message
 * @returns {PlatformError}
 */
const fetchError = (code, message) => platformError(code, message);

/**
 * @param {unknown} error
 * @returns {error is PlatformError}
 */
export const isFetchError = (error) =>
	error instanceof Error &&
	error.name === 'PlatformError' &&
	['target_refused', 'redirect_refused', 'too_large', 'timeout', 'network'].includes(/** @type {PlatformError} */ (error).code);

/**
 * @param {{ allowlist?: ReadonlyArray<string> | null, resolveHost?: ResolveHost, timeoutMs?: number, maxBytes?: number,
 *   userAgent?: string }} [options]
 * @returns {SafeFetch}
 */
export const createSafeFetch = ({
	allowlist,
	resolveHost = defaultResolve,
	timeoutMs: defaultTimeout = DEFAULT_TIMEOUT_MS,
	maxBytes: defaultMax = DEFAULT_MAX_BYTES,
	userAgent = 'ss-portal-catalog/1',
} = {}) => {
	const allowed = normaliseAllowlist(allowlist);

	/**
	 * Resolve and vet the target's addresses.
	 * @param {string} host
	 * @param {boolean} allowlisted
	 * @returns {Promise<{ address: string, family: 4 | 6 }>}
	 */
	const vet = async (host, allowlisted) => {
		const literal = isIP(host);
		/** @type {Array<{ address: string, family: number }>} */
		let answers;
		if (literal) answers = [{ address: host, family: literal }];
		else {
			try {
				answers = await resolveHost(host);
			} catch {
				throw fetchError('network', `could not resolve ${host}`);
			}
		}
		if (!Array.isArray(answers) || answers.length === 0) throw fetchError('network', `no address for ${host}`);
		if (!allowlisted) {
			for (const answer of answers) {
				const refused = addressRefusal(String(answer.address));
				if (refused) throw fetchError('target_refused', `${host}: ${refused}`);
			}
		}
		const first = /** @type {{ address: string, family: number }} */ (answers[0]);
		return { address: String(first.address), family: first.family === 6 ? 6 : 4 };
	};

	/**
	 * One request to a vetted address.
	 * @param {URL} url
	 * @param {{ address: string, family: 4 | 6 }} pinned
	 * @param {{ method: string, headers: Record<string, string>, body?: string, maxBytes: number, signal: AbortSignal }} init
	 * @returns {Promise<{ status: number, headers: Record<string, string>, text: string }>}
	 */
	const once = (url, pinned, { method, headers, body, maxBytes, signal }) =>
		new Promise((resolve, reject) => {
			const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
			const req = send(
				url,
				{
					method,
					headers: {
						'user-agent': userAgent,
						accept: 'application/json',
						...headers,
						...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
					},
					signal,
					/** @type {any} */
					lookup: (/** @type {string} */ _host, /** @type {any} */ options, /** @type {any} */ callback) => {
						if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
						else callback(null, pinned.address, pinned.family);
					},
				},
				(res) => {
					const declared = Number(res.headers['content-length'] ?? '0');
					if (Number.isFinite(declared) && declared > maxBytes) {
						res.destroy();
						reject(fetchError('too_large', `response exceeds ${maxBytes} bytes`));
						return;
					}
					/** @type {Buffer[]} */
					const chunks = [];
					let size = 0;
					res.on('data', (/** @type {Buffer} */ chunk) => {
						size += chunk.length;
						if (size > maxBytes) {
							res.destroy();
							reject(fetchError('too_large', `response exceeds ${maxBytes} bytes`));
							return;
						}
						chunks.push(chunk);
					});
					res.on('end', () => {
						/** @type {Record<string, string>} */
						const out = {};
						for (const [name, value] of Object.entries(res.headers)) {
							if (value !== undefined) out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
						}
						resolve({ status: res.statusCode ?? 0, headers: out, text: Buffer.concat(chunks).toString('utf8') });
					});
					res.on('error', () => reject(fetchError('network', 'response failed')));
				},
			);
			req.on('error', () =>
				reject(signal.aborted ? fetchError('timeout', 'request timed out') : fetchError('network', 'request failed')),
			);
			if (body !== undefined) req.write(body);
			req.end();
		});

	return async (target, { method = 'GET', headers = {}, body, maxBytes = defaultMax, timeoutMs = defaultTimeout } = {}) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			let current = target;
			for (let hop = 0; ; hop += 1) {
				const checked = checkTarget(current, { allowlist: allowed });
				if (!checked.ok) throw fetchError('target_refused', checked.reason);
				const pinned = await vet(checked.host, checked.allowlisted);
				const res = await once(checked.url, pinned, { method, headers, body, maxBytes, signal: controller.signal });
				if (res.status < 300 || res.status > 399 || res.status === 304) return { ...res, url: checked.url.href };
				const location = res.headers.location;
				if (method !== 'GET' || !location) throw fetchError('redirect_refused', `redirect (${res.status}) refused`);
				/** @type {URL} */
				let next;
				try {
					next = new URL(location, checked.url);
				} catch {
					throw fetchError('redirect_refused', 'redirect location is invalid');
				}
				if (!sameTarget(checked.url, next)) throw fetchError('redirect_refused', 'redirect to another host refused');
				if (hop + 1 >= MAX_REDIRECTS) throw fetchError('redirect_refused', 'too many redirects');
				current = next.href;
			}
		} finally {
			clearTimeout(timer);
		}
	};
};
