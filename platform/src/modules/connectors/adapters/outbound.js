/**
 * Guarded outbound network access for connector checks (the SSRF guard's I/O half).
 *
 * - `createGuardedLookup` wraps DNS resolution: every resolved address must be public (`netguard.isBlockedAddress`)
 *   unless the host or address is on the development allowlist. It is passed as the socket `lookup` to Node's
 *   http/https clients and to the MongoDB driver, so the check happens **at connect time on the address actually
 *   used** (no DNS-rebinding window). IP literals bypass `lookup` in Node, so URLs and hosts are checked first.
 * - `createOutbound().request` makes one HTTP(S) request: https only (http only for allowlisted development hosts),
 *   no redirects, no connection reuse, a hard deadline and a response size cap. Network failures are returned as
 *   stable codes, never thrown and never with upstream text.
 * @module
 */
import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { checkUrl, isAllowlisted, isBlockedAddress } from '../core/netguard.js';

/** @typedef {import('../core/netguard.js').Allowlist} Allowlist */
/** @typedef {(hostname: string, options: any, callback: (error: NodeJS.ErrnoException | null, address?: any, family?: number) => void) => void} LookupFunction */

export const REFUSED_CODE = 'ESSRFREFUSED';

/**
 * @param {{ allowlist: Allowlist, lookup?: LookupFunction, onRefused?: () => void }} options
 * @returns {LookupFunction}
 */
export const createGuardedLookup =
	({ allowlist, lookup = /** @type {LookupFunction} */ (dnsLookup), onRefused }) =>
	(hostname, options, callback) => {
		const cb = typeof options === 'function' ? options : callback;
		const opts =
			typeof options === 'function' || options === undefined || options === null
				? {}
				: typeof options === 'number'
					? { family: options }
					: options;
		lookup(hostname, { ...opts, all: true }, (error, addresses) => {
			if (error) return cb(error);
			const list = /** @type {Array<{ address: string, family: number }>} */ (Array.isArray(addresses) ? addresses : []);
			const hostAllowed = isAllowlisted(allowlist, hostname);
			const refused =
				list.length === 0 ||
				(!hostAllowed && list.some(({ address }) => !isAllowlisted(allowlist, address) && isBlockedAddress(address)));
			if (refused) {
				onRefused?.();
				return cb(Object.assign(new Error('destination address refused'), { code: REFUSED_CODE }));
			}
			const first = /** @type {{ address: string, family: number }} */ (list[0]);
			return opts.all ? cb(null, list) : cb(null, first.address, first.family);
		});
	};

/**
 * @typedef {{ ok: true, status: number, headers: Record<string, string | string[] | undefined>, body: Buffer }
 *   | { ok: false, code: 'invalid_url' | 'https_required' | 'address_refused' | 'invalid_host' | 'timeout' | 'unreachable' | 'tls_error' | 'response_too_large' }} OutboundResult
 */

/**
 * @param {unknown} error
 * @returns {'timeout' | 'unreachable' | 'tls_error'}
 */
const classify = (error) => {
	const code = String(/** @type {any} */ (error)?.code ?? '');
	if (code === 'ETIMEDOUT' || code === 'ABORT_ERR') return 'timeout';
	if (/CERT|SSL|TLS|ERR_TLS|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME|ALTNAME/.test(code)) return 'tls_error';
	return 'unreachable';
};

/**
 * @param {{ allowlist: Allowlist, lookup?: LookupFunction, defaultTimeoutMs?: number }} options
 */
export const createOutbound = ({ allowlist, lookup, defaultTimeoutMs = 8_000 }) => {
	/**
	 * @param {{ method: string, url: string, headers?: Record<string, string>, body?: string | Buffer, timeoutMs?: number, maxBytes?: number }} input
	 * @returns {Promise<OutboundResult>}
	 */
	const request = ({ method, url, headers = {}, body, timeoutMs = defaultTimeoutMs, maxBytes = 64 * 1024 }) =>
		new Promise((resolve) => {
			const checked = checkUrl(url, allowlist);
			if (!checked.ok) return resolve({ ok: false, code: checked.code });
			let refused = false;
			const guarded = createGuardedLookup({
				allowlist,
				...(lookup ? { lookup } : {}),
				onRefused: () => {
					refused = true;
				},
			});
			const target = checked.url;
			const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
			let settled = false;
			/** @param {OutboundResult} result */
			const done = (result) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(result);
			};
			const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
			const req = send(
				target,
				{
					method,
					headers: { ...headers, ...(payload ? { 'content-length': String(payload.length) } : {}) },
					lookup: /** @type {any} */ (guarded),
					agent: false,
				},
				(res) => {
					/** @type {Buffer[]} */
					const chunks = [];
					let size = 0;
					res.on('data', (/** @type {Buffer} */ chunk) => {
						size += chunk.length;
						if (size > maxBytes) {
							req.destroy();
							done({ ok: false, code: 'response_too_large' });
							return;
						}
						chunks.push(chunk);
					});
					res.on('end', () =>
						done({ ok: true, status: res.statusCode ?? 0, headers: { ...res.headers }, body: Buffer.concat(chunks) }),
					);
					res.on('error', (error) => done({ ok: false, code: classify(error) }));
				},
			);
			const timer = setTimeout(() => {
				req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
				done({ ok: false, code: 'timeout' });
			}, timeoutMs);
			req.on('error', (error) => done({ ok: false, code: refused ? 'address_refused' : classify(error) }));
			req.end(payload);
		});
	return Object.freeze({ request });
};
/** @typedef {ReturnType<typeof createOutbound>} Outbound */
