/**
 * A fake product on a local node:http server, built with `@ss/protocol` the way `@ss/app-kit` does:
 *
 * - `POST /.well-known/ss-connect`: the product side of the connect handshake (HMAC-verified request, single-use
 *   nonce, HMAC-signed answer with its id, public key, manifest and current price list). It pins the Portal's keys
 *   and continues its price list from the Portal's `priceListVersion` when that is higher.
 * - `POST /.well-known/ss-events`: notices, verified with `verifyNotice` against the pinned Portal keys and recorded.
 *
 * Behaviour can be tampered with per test (the connect answer, the notice status).
 * @module
 */
import { createServer } from 'node:http';
import { manifestPriceList } from '@ss/contracts';
import {
	createConnectResponse,
	createJwks,
	createKeyResolver,
	createMemoryReplayStore,
	createSigner,
	generateSigningKey,
	signAssertion,
	verifyConnectRequest,
	verifyNotice,
} from '@ss/protocol';

/** The connect secret fake products are deployed with (unless a test passes another). */
export const PRODUCT_SECRET = 'fake-product-connect-secret-0123456789abcdef';

/**
 * @typedef {object} Tamper
 * @property {'bad_signature' | 'other_nonce' | 'no_secret' | 'status_500' | 'other_id' | 'bad_prices'} [connect]
 * @property {number} [noticeStatus] answer notices with this status (and record nothing)
 * @property {number} [pricesVersion] answer this price-list version
 */

/**
 * @param {{ manifest: any, portalUrl: string, now?: () => number, kid?: string, secret?: string }} options
 */
export const startFakeProduct = async ({ manifest, portalUrl, now = Date.now, kid = 'product-k1', secret = PRODUCT_SECRET }) => {
	let key = await generateSigningKey({ kid });
	/** @type {Tamper} */
	const tamper = {};
	let current = manifest;
	/** @type {{ version: number, features: any[] }} */
	let prices = manifestPriceList(manifest);
	/** @type {Set<string>} */
	const nonces = new Set();
	/** @type {Array<{ portalUrl: string, baseUrl: string, priceListVersion: number }>} */
	const connects = [];
	/** @type {Array<{ type: string, websiteId?: string, subject?: string }>} */
	const notices = [];
	/** @type {import('@ss/protocol').KeyResolver | null} */
	let portalKeys = null;
	const replayStore = createMemoryReplayStore({ now });

	const server = createServer((req, res) => {
		/** @type {Buffer[]} */
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', async () => {
			const body = Buffer.concat(chunks).toString('utf8');
			/** @param {number} status @param {unknown} [json] */
			const answer = (status, json) => {
				res.writeHead(status, { 'content-type': 'application/json' });
				res.end(json === undefined ? '' : JSON.stringify(json));
			};
			if (req.method === 'POST' && req.url === '/.well-known/ss-connect') {
				if (tamper.connect === 'no_secret')
					return answer(503, { status: 503, detail: 'CONNECT_SECRET is shorter than 32 characters.', problems: [] });
				if (tamper.connect === 'status_500') return answer(500, {});
				/** @type {ReturnType<typeof verifyConnectRequest>} */
				let request;
				try {
					request = verifyConnectRequest({ secret, headers: /** @type {any} */ (req.headers), body, now });
				} catch {
					return answer(401, { code: 'unauthorized' });
				}
				if (nonces.has(request.nonce)) return answer(401, { code: 'unauthorized' });
				nonces.add(request.nonce);
				connects.push({ portalUrl: request.portalUrl, baseUrl: request.baseUrl, priceListVersion: request.priceListVersion });
				portalKeys = createKeyResolver({ jwks: request.jwks });
				if (request.priceListVersion > prices.version) prices = { ...prices, version: request.priceListVersion };
				const signed = createConnectResponse({
					secret: tamper.connect === 'bad_signature' ? `${secret}-other` : secret,
					productId: tamper.connect === 'other_id' ? 'someone-else' : current.id,
					nonce: tamper.connect === 'other_nonce' ? 'n'.repeat(22) : request.nonce,
					publicJwk: key.publicJwk,
					manifest: current,
					prices:
						tamper.connect === 'bad_prices'
							? { version: 1, features: [{ key: 'x', millicreditsPerHour: -1 }] }
							: { ...prices, ...(tamper.pricesVersion ? { version: tamper.pricesVersion } : {}) },
					now,
				});
				res.writeHead(200, signed.headers);
				return void res.end(signed.body);
			}
			if (req.method === 'POST' && req.url === '/.well-known/ss-events') {
				if (tamper.noticeStatus) return answer(tamper.noticeStatus, {});
				try {
					if (!portalKeys) throw new Error('not connected');
					const notice = await verifyNotice({
						headers: /** @type {any} */ (req.headers),
						rawBody: body,
						keyResolver: portalKeys,
						replayStore,
						now,
					});
					notices.push(notice);
					return answer(204);
				} catch {
					return answer(401, { code: 'invalid_notice' });
				}
			}
			answer(404);
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
	const address = /** @type {import('node:net').AddressInfo} */ (server.address());
	const url = `http://127.0.0.1:${address.port}`;
	return {
		url,
		productId: /** @type {string} */ (manifest.id),
		secret,
		tamper,
		connects,
		notices,
		get publicJwk() {
			return key.publicJwk;
		},
		/** A fresh client assertion of this product (`Authorization: Bearer …`). */
		assertion: () => signAssertion({ signer: createSigner(key.privateJwk), productId: current.id, audience: portalUrl, now }),
		/** Replace the served manifest. @param {any} m */
		setManifest: (m) => {
			current = m;
		},
		/** Replace the current price list. @param {{ version: number, features: any[] }} list */
		setPrices: (list) => {
			prices = list;
		},
		/** A new product key (the next connect answers it). @param {string} next */
		rotateKey: async (next) => {
			key = await generateSigningKey({ kid: next });
		},
		/** The Portal keys the product pinned at its last connect. */
		pinnedJwks: () => portalKeys,
		jwks: () => createJwks([key.publicJwk]),
		close: () =>
			new Promise((resolve) => {
				server.close(() => resolve(undefined));
				server.closeAllConnections();
			}),
	};
};
/** @typedef {Awaited<ReturnType<typeof startFakeProduct>>} FakeProduct */
