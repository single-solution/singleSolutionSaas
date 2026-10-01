/**
 * A fake service product on a local node:http server, built with `@ss/protocol` `createRegistrationHandler` exactly
 * as `@ss/app-kit` does: `GET /.well-known/ss-app.json` serves the manifest, `POST /.well-known/ss-register` runs the
 * product side of the handshake. Behaviour can be tampered with per test (bad proof, wrong nonce, invalid manifest,
 * redirects, oversized bodies).
 * @module
 */
import { createServer } from 'node:http';
import {
	createMemoryReplayStore,
	createRegistrationHandler,
	createSigner,
	generateSigningKey,
	hashRegistrationToken,
} from '@ss/protocol';

/**
 * @typedef {object} Tamper
 * @property {(body: any) => any} [response] rewrite the 200 registration body
 * @property {(manifest: any) => any} [advertised] rewrite the advertised manifest
 * @property {{ status: number, location: string }} [redirectManifest]
 * @property {number} [manifestBytes] pad ss-app.json to this many bytes
 * @property {number} [registerStatus] answer the register endpoint with this status
 */

/**
 * @param {{ manifest: any, portalUrl: string, fetchJwks: () => Promise<unknown>, token?: string, now?: () => number }} options
 */
export const startFakeProduct = async ({ manifest, portalUrl, fetchJwks, token = 'tok_'.padEnd(40, 'x'), now = Date.now }) => {
	const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'product-k1' });
	const signer = createSigner(privateJwk);
	let burned = false;
	/** @type {Array<Record<string, unknown>>} */
	const registrations = [];
	/** @type {Tamper} */
	const tamper = {};
	let current = manifest;
	/** @param {any} m */
	const handlerFor = (m) =>
		createRegistrationHandler({
			registrationTokenHash: hashRegistrationToken(token),
			allowedPortalUrl: portalUrl,
			fetchJwks: () => fetchJwks(),
			manifest: m,
			productPublicJwk: publicJwk,
			productSigner: signer,
			onRegistered: (registration) => void registrations.push(registration),
			burnToken: () => {
				if (burned) return false;
				burned = true;
				return true;
			},
			isTokenBurned: () => burned,
			nonceStore: createMemoryReplayStore({ now }),
			expectedAudience: m.endpoints?.base,
			now,
		});
	let handler = handlerFor(current);

	const server = createServer((req, res) => {
		/** @type {Buffer[]} */
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', async () => {
			const body = Buffer.concat(chunks).toString('utf8');
			if (req.method === 'GET' && req.url === '/.well-known/ss-app.json') {
				if (tamper.redirectManifest) {
					res.writeHead(tamper.redirectManifest.status, { location: tamper.redirectManifest.location });
					return void res.end();
				}
				let text = JSON.stringify(tamper.advertised ? tamper.advertised(structuredClone(current)) : current);
				if (tamper.manifestBytes) text = text.padEnd(tamper.manifestBytes, ' ');
				res.writeHead(200, { 'content-type': 'application/json' });
				return void res.end(text);
			}
			if (req.method === 'POST' && req.url === '/.well-known/ss-register') {
				if (tamper.registerStatus) {
					res.writeHead(tamper.registerStatus, { 'content-type': 'application/json' });
					return void res.end('{"error":"nope"}');
				}
				const result = await handler.handle({ headers: /** @type {any} */ (req.headers), body });
				const out = result.status === 200 && tamper.response ? tamper.response(structuredClone(result.body)) : result.body;
				res.writeHead(result.status, { 'content-type': 'application/json' });
				return void res.end(JSON.stringify(out));
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
		token,
		signer,
		privateJwk,
		publicJwk,
		registrations,
		tamper,
		/** Replace the served manifest (and the registration handler). @param {any} m */
		setManifest: (m) => {
			current = m;
			handler = handlerFor(m);
		},
		/** Allow a new registration with a fresh handler (new token not needed: same token, unburned). */
		reset: () => {
			burned = false;
			handler = handlerFor(current);
		},
		close: () =>
			new Promise((resolve) => {
				server.close(() => resolve(undefined));
				server.closeAllConnections();
			}),
	};
};
