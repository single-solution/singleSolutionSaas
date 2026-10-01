/**
 * Outbound HTTP for deliveries over `node:http(s)` with the SSRF guard enforced at connect time: the transport's
 * own `lookup` resolves the host, refuses any private answer (unless the host is allow-listed) and pins the
 * connection to the checked address, so DNS rebinding cannot redirect a delivery. Redirects are never followed.
 * @module
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isPrivateAddress } from './core/outbound.js';

/** @typedef {(hostname: string) => Promise<Array<{ address: string, family: number }>>} ResolveHost */

/** @type {ResolveHost} */
const defaultResolve = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * @param {string} message
 * @param {string} code
 */
const codedError = (message, code) => Object.assign(new Error(message), { code });

/**
 * @param {{ resolveHost?: ResolveHost, timeoutMs: number, maxResponseBytes?: number }} options
 */
export const createTransport = ({ resolveHost = defaultResolve, timeoutMs, maxResponseBytes = 64 * 1024 }) => {
	/**
	 * POST a body; resolves with the response status (body discarded), rejects with a coded error.
	 * @param {{ url: URL, headers: Record<string, string>, body: string, allowPrivate: boolean, signal?: AbortSignal }} input
	 * @returns {Promise<{ status: number }>}
	 */
	const post = ({ url, headers, body, allowPrivate, signal }) =>
		new Promise((resolve, reject) => {
			/**
			 * @param {string} hostname
			 * @param {any} options
			 * @param {(error: Error | null, address?: any, family?: number) => void} callback
			 */
			const lookup = (hostname, options, callback) => {
				resolveHost(hostname).then(
					(addresses) => {
						if (addresses.length === 0) return callback(codedError('no address', 'ENOTFOUND'));
						if (!allowPrivate && addresses.some((entry) => isPrivateAddress(entry.address)))
							return callback(codedError('destination address is not allowed', 'ssrf_blocked'));
						const first = /** @type {{ address: string, family: number }} */ (addresses[0]);
						return options?.all ? callback(null, addresses) : callback(null, first.address, first.family);
					},
					(error) => callback(error),
				);
			};
			const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
			let settled = false;
			/** @param {() => void} fn */
			const settle = (fn) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				fn();
			};
			const req = send(url, {
				method: 'POST',
				headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
				lookup,
				agent: false,
				...(signal ? { signal } : {}),
			});
			const timer = setTimeout(() => req.destroy(codedError('delivery timed out', 'timeout')), timeoutMs);
			req.on('error', (error) => settle(() => reject(error)));
			req.on('response', (res) => {
				let received = 0;
				res.on('data', (chunk) => {
					received += chunk.length;
					if (received > maxResponseBytes) res.destroy();
				});
				const done = () => settle(() => resolve({ status: res.statusCode ?? 0 }));
				res.on('end', done);
				res.on('close', done);
				res.on('error', done);
			});
			req.end(body);
		});
	return Object.freeze({ post });
};
/** @typedef {ReturnType<typeof createTransport>} Transport */
