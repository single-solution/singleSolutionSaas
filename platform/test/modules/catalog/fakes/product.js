/**
 * A fake service product on a local node:http server, built with `@ss/protocol` exactly as `@ss/app-kit` does:
 * `GET /.well-known/ss-app.json` serves the manifest; `connectRequest(code)` / `accept(answer, request)` are the product
 * side of the connection-code handshake (its `/setup`). Behaviour can be tampered with per test (manifest signature,
 * redirects, oversized bodies).
 * @module
 */
import { createServer } from 'node:http';
import {
	MANIFEST_SIGNATURE_HEADER,
	createConnectRequest,
	createSigner,
	generateSigningKey,
	signManifest,
	verifyConnectResponse,
} from '@ss/protocol';

/**
 * @typedef {object} Tamper
 * @property {(manifest: any) => any} [advertised] rewrite the advertised manifest
 * @property {{ status: number, location: string }} [redirectManifest]
 * @property {number} [manifestBytes] pad ss-app.json to this many bytes
 * @property {'omit' | 'garbage' | 'other_app' | 'stale' | 'other_manifest' | 'foreign_key'} [signature] how
 *   `SS-Manifest-Signature` is tampered with (default: signed with the registered key once an appId is known)
 */

/**
 * @param {{ manifest: any, portalUrl: string, now?: () => number, kid?: string }} options
 */
export const startFakeProduct = async ({ manifest, portalUrl, now = Date.now, kid = 'product-k1' }) => {
	const { privateJwk, publicJwk } = await generateSigningKey({ kid });
	const signer = createSigner(privateJwk);
	const foreign = createSigner((await generateSigningKey({ kid: 'foreign-k9' })).privateJwk);
	/** @type {Array<Record<string, unknown>>} */
	const registrations = [];
	/** @type {Tamper} */
	const tamper = {};
	let current = manifest;

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
				const served = tamper.advertised ? tamper.advertised(structuredClone(current)) : current;
				let text = JSON.stringify(served);
				if (tamper.manifestBytes) text = text.padEnd(tamper.manifestBytes, ' ');
				/** @type {Record<string, string>} */
				const headers = { 'content-type': 'application/json' };
				const appId = /** @type {string | undefined} */ (registrations.at(-1)?.appId);
				if (appId && tamper.signature !== 'omit') {
					const by = tamper.signature === 'foreign_key' ? foreign : signer;
					headers[MANIFEST_SIGNATURE_HEADER] =
						tamper.signature === 'garbage'
							? 'not.a.jws'
							: await signManifest({
									signer: by,
									manifest: tamper.signature === 'other_manifest' ? { ...served, extra: true } : served,
									appId: tamper.signature === 'other_app' ? 'app_someoneelse' : appId,
									now: tamper.signature === 'stale' ? () => now() - 2 * 86_400_000 : now,
								});
				}
				res.writeHead(200, headers);
				return void res.end(text);
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
		/**
		 * The product's connect request for a connection code (as its `/setup` builds it).
		 * @param {string} code
		 * @param {{ baseUrl?: string, manifest?: any }} [override]
		 */
		connectRequest: (code, override = {}) =>
			createConnectRequest({
				code,
				baseUrl: override.baseUrl ?? url,
				manifest: override.manifest ?? current,
				signer,
				publicJwk,
				now,
			}),
		/**
		 * Verify the Portal's answer and record the connection (appId, Portal kid).
		 * @param {unknown} answer
		 * @param {{ nonce: string, jkt: string }} request
		 */
		accept: async (answer, request) => {
			const accepted = await verifyConnectResponse({ body: answer, portalUrl, nonce: request.nonce, jkt: request.jkt, now });
			registrations.push({ appId: accepted.appId, portalKid: accepted.portalKid });
			return accepted;
		},
		close: () =>
			new Promise((resolve) => {
				server.close(() => resolve(undefined));
				server.closeAllConnections();
			}),
	};
};
