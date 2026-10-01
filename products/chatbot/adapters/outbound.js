/**
 * Outbound HTTP to merchant-chosen URLs (knowledge pages, webhook tools) through the kit's SSRF guard: app-kit's
 * connector `send` — `@ss/net` `safeFetch` under the product's outbound policy (public https only, every DNS answer
 * vetted at connect time, size cap, deadline; the development allowlist is ignored in production).
 *
 * app-kit exposes that `send` only to connector adapters, so this module obtains it the supported way: a private
 * `createConnectors` instance whose single adapter returns its context (see README "Platform gaps").
 * @module
 */
import { createConnectors } from '@ss/app-kit';

/** @typedef {(url: string, init?: Record<string, unknown>) => Promise<{ status: number, headers: Record<string, string> | Headers, body: Buffer, url?: string }>} Send */

/**
 * @param {{ slug: string, outbound: Record<string, unknown>, send?: Send, nodeEnv?: string }} options
 *   `send` replaces safeFetch (tests); in production the allowlist is dropped, as app-kit does for connectors
 * @returns {Promise<{ fetch: Send }>}
 */
export const createOutbound = async ({ slug, outbound, send, nodeEnv = process.env.NODE_ENV }) => {
	const production = nodeEnv === 'production';
	const { allowHosts = [], ...rest } = /** @type {{ allowHosts?: string[] }} */ (outbound);
	/** @type {any} */
	let captured = null;
	const connectors = createConnectors({
		portal: { resolveResource: async () => ({ descriptor: { provider: 'outbound' }, expiresAt: '9999-12-31T00:00:00.000Z' }) },
		slug,
		outbound: { ...rest, allowHosts: production ? [] : allowHosts },
		...(send ? { send: /** @type {any} */ (send) } : {}),
		adapters: {
			messaging: {
				outbound: (/** @type {any} */ context) => {
					captured = context.send;
					return { send: context.send };
				},
			},
		},
	});
	await connectors.messaging('outbound');
	return { fetch: /** @type {Send} */ (captured) };
};
