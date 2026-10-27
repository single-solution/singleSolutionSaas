/**
 * A fake product on a local node:http server, built with `@ss/protocol` the way `@ss/app-kit` does:
 *
 * - `POST /.well-known/ss-connect`: the product side of the connect handshake (HMAC-verified request, single-use
 *   nonce, HMAC-signed answer with its id, public key, manifest and current price list). It pins the Portal's keys
 *   and continues its price list from the Portal's `priceListVersion` when that is higher.
 * - `POST /.well-known/ss-events`: notices, verified with `verifyNotice` against the pinned Portal keys and recorded.
 * - `GET /v1/blueprint?websiteId=`: its part of a Setup sheet, a Portal call verified with `verifyPortalCall` (the
 *   `@ss/contracts/testing` product blueprint under its own id and name, unless a test sets another).
 * - `POST /v1/blueprint/features?websiteId=`: the advisor's Switch on, a Portal call with a body: recorded, and
 *   answered `{ version, on, added }` with the asked features added (or as a test tampers it).
 *
 * Behavior can be tampered with per test (the connect answer, the notice status, the blueprint answer).
 * @module
 */
import { createServer } from 'node:http';
import { manifestPriceList } from '@ss/contracts';
import { productBlueprint } from '@ss/contracts/testing';
import {
	createConnectResponse,
	createJwks,
	createKeyResolver,
	createSigner,
	generateSigningKey,
	signAssertion,
	verifyConnectRequest,
	verifyNotice,
	verifyPortalCall,
} from '@ss/protocol';
import { createMemoryReplayStore } from '@ss/protocol/testing';

/** The connect secret fake products are deployed with (unless a test passes another). */
const PRODUCT_SECRET = 'fake-product-connect-secret-0123456789abcdef';

/**
 * @typedef {object} Tamper
 * @property {'bad_signature' | 'other_nonce' | 'no_secret' | 'status_500' | 'other_id' | 'bad_prices'} [connect]
 * @property {number} [noticeStatus] answer notices with this status (and record nothing)
 * @property {number} [pricesVersion] answer this price-list version
 * @property {'hang' | 'status_500' | 'refuse' | 'invalid' | 'other_id'} [blueprint] never answer, answer 500 or 403, a
 *   body that is no blueprint, or another product's blueprint
 * @property {'hang' | 'status_500' | 'refuse'} [switchOn] never answer, answer 500, or refuse with a 422 problem
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
	/** The websites the Portal asked for blueprints, in order. @type {string[]} */
	const blueprintCalls = [];
	/** The Switch on calls, in order. @type {Array<{ websiteId: string, body: any }>} */
	const switchCalls = [];
	/** @type {(websiteId: string) => Record<string, any>} */
	let blueprintOf = () => ({ ...productBlueprint(), productId: current.id, name: current.name });

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
						audience: current.id,
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
			if (req.method === 'POST' && (req.url ?? '').startsWith('/v1/blueprint/features')) {
				if (tamper.switchOn === 'hang') return;
				if (tamper.switchOn === 'status_500') return answer(500, {});
				try {
					if (!portalKeys) throw new Error('not connected');
					await verifyPortalCall({
						headers: /** @type {any} */ (req.headers),
						audience: current.id,
						method: 'POST',
						target: String(req.url),
						rawBody: body,
						keyResolver: portalKeys,
						replayStore,
						now,
					});
				} catch {
					return answer(401, { code: 'unauthorized' });
				}
				const websiteId = new URL(String(req.url), 'http://local').searchParams.get('websiteId') ?? '';
				const asked = JSON.parse(body);
				switchCalls.push({ websiteId, body: asked });
				if (tamper.switchOn === 'refuse')
					return answer(422, {
						code: 'validation_failed',
						detail: 'The Portal refused the change (forbidden). Nothing was changed.',
					});
				return answer(200, { version: 2, on: asked.features, added: asked.features });
			}
			if (req.method === 'GET' && (req.url ?? '').startsWith('/v1/blueprint')) {
				if (tamper.blueprint === 'hang') return;
				if (tamper.blueprint === 'status_500') return answer(500, {});
				if (tamper.blueprint === 'refuse') return answer(403, { code: 'forbidden' });
				try {
					if (!portalKeys) throw new Error('not connected');
					await verifyPortalCall({
						headers: /** @type {any} */ (req.headers),
						audience: current.id,
						method: 'GET',
						target: String(req.url),
						keyResolver: portalKeys,
						replayStore,
						now,
					});
				} catch {
					return answer(401, { code: 'unauthorized' });
				}
				const websiteId = new URL(String(req.url), 'http://local').searchParams.get('websiteId') ?? '';
				blueprintCalls.push(websiteId);
				if (tamper.blueprint === 'invalid') return answer(200, { nope: true });
				if (tamper.blueprint === 'other_id') return answer(200, { ...blueprintOf(websiteId), productId: 'someone-else' });
				return answer(200, blueprintOf(websiteId));
			}
			if (req.method === 'GET' && req.url === '/openapi.json') {
				return answer(200, {
					openapi: '3.1.0',
					info: { title: `${current.name} API`, version: current.version },
					paths: {
						'/v1/test': {
							get: {
								summary: 'Test operation',
								'x-ss-auth': 'server',
								'x-ss-permission': 'test.read',
								'x-ss-feature': 'always',
							},
						},
					},
				});
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
		/** The websites the Portal asked for blueprints, in order. */
		blueprintCalls,
		/** The Switch on calls, in order. */
		switchCalls,
		/** Answer another blueprint. @param {(websiteId: string) => Record<string, any>} make */
		setBlueprint: (make) => {
			blueprintOf = make;
		},
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
