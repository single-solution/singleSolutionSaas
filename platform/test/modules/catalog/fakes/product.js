/**
 * A fake service product on a local node:http server, built with `@ss/protocol` exactly as `@ss/app-kit` does:
 * `GET /.well-known/ss-app.json` serves the manifest; `POST /.well-known/ss-connect` is the product side of the
 * connect-secret handshake (HMAC-verified request, single-use nonce, HMAC-signed answer). Behaviour can be tampered with
 * per test (redirects, oversized bodies, the connect answer).
 * @module
 */
import { createServer } from 'node:http';
import { createConnectResponse, createSigner, generateSigningKey, verifyConnectRequest } from '@ss/protocol';

/** The connect secret fake products are deployed with (unless a test passes another). */
export const PRODUCT_SECRET = 'fake-product-connect-secret-0123456789abcdef';

/**
 * @typedef {object} Tamper
 * @property {(manifest: any) => any} [advertised] rewrite the advertised manifest
 * @property {{ status: number, location: string }} [redirectManifest]
 * @property {number} [manifestBytes] pad ss-app.json to this many bytes
 * @property {'bad_signature' | 'other_nonce' | 'other_manifest' | 'no_secret'} [connect] how the connect answer is
 *   tampered with (`no_secret`: 503 like an app-kit product without a usable `CONNECT_SECRET`)
 * @property {string[]} [misconfigured] answer every request 503 `{ status: 'misconfigured', problems }` (app-kit)
 */

/**
 * @param {{ manifest: any, portalUrl: string, now?: () => number, kid?: string, secret?: string }} options
 */
export const startFakeProduct = async ({ manifest, portalUrl, now = Date.now, kid = 'product-k1', secret = PRODUCT_SECRET }) => {
	const { privateJwk, publicJwk } = await generateSigningKey({ kid });
	const signer = createSigner(privateJwk);
	/** @type {Array<Record<string, unknown>>} */
	const registrations = [];
	/** @type {Tamper} */
	const tamper = {};
	let current = manifest;
	/** @type {Set<string>} */
	const nonces = new Set();

	const server = createServer((req, res) => {
		/** @type {Buffer[]} */
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', async () => {
			if (tamper.misconfigured) {
				res.writeHead(503, { 'content-type': 'application/json' });
				return void res.end(JSON.stringify({ status: 'misconfigured', problems: tamper.misconfigured }));
			}
			if (req.method === 'GET' && req.url === '/.well-known/ss-app.json') {
				if (tamper.redirectManifest) {
					res.writeHead(tamper.redirectManifest.status, { location: tamper.redirectManifest.location });
					return void res.end();
				}
				const served = tamper.advertised ? tamper.advertised(structuredClone(current)) : current;
				let text = JSON.stringify(served);
				if (tamper.manifestBytes) text = text.padEnd(tamper.manifestBytes, ' ');
				res.writeHead(200, { 'content-type': 'application/json' });
				return void res.end(text);
			}
			if (req.method === 'POST' && req.url === '/.well-known/ss-connect' && tamper.connect === 'no_secret') {
				const detail = 'This product refuses connections: CONNECT_SECRET is shorter than 32 characters.';
				res.writeHead(503, { 'content-type': 'application/problem+json' });
				return void res.end(JSON.stringify({ status: 503, code: 'misconfigured', detail, problems: [detail] }));
			}
			if (req.method === 'POST' && req.url === '/.well-known/ss-connect') {
				/** @type {ReturnType<typeof verifyConnectRequest>} */
				let request;
				try {
					request = verifyConnectRequest({
						secret,
						headers: /** @type {any} */ (req.headers),
						body: Buffer.concat(chunks).toString('utf8'),
						now,
					});
				} catch {
					res.writeHead(401, { 'content-type': 'application/json' });
					return void res.end('{"code":"unauthorized"}');
				}
				if (nonces.has(request.nonce)) {
					res.writeHead(401, { 'content-type': 'application/json' });
					return void res.end('{"code":"unauthorized"}');
				}
				nonces.add(request.nonce);
				if (request.portalUrl !== portalUrl) throw new Error(`fake product: unexpected Portal ${request.portalUrl}`);
				registrations.push({ appId: request.appId, portalKid: request.jwks.keys[0]?.kid, baseUrl: request.baseUrl });
				const answer = createConnectResponse({
					secret: tamper.connect === 'bad_signature' ? `${secret}-other` : secret,
					appId: request.appId,
					nonce: tamper.connect === 'other_nonce' ? 'n'.repeat(22) : request.nonce,
					publicJwk,
					manifest:
						tamper.connect === 'other_manifest'
							? { ...current, product: { ...current.product, slug: 'someone-else' } }
							: current,
					now,
				});
				res.writeHead(200, answer.headers);
				return void res.end(answer.body);
			}
			res.writeHead(404);
			res.end();
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
	const address = /** @type {import('node:net').AddressInfo} */ (server.address());
	const url = `http://127.0.0.1:${address.port}`;
	return {
		url,
		signer,
		privateJwk,
		publicJwk,
		registrations,
		tamper,
		/** Replace the served manifest. @param {any} m */
		setManifest: (m) => {
			current = m;
		},
		secret,
		close: () =>
			new Promise((resolve) => {
				server.close(() => resolve(undefined));
				server.closeAllConnections();
			}),
	};
};
