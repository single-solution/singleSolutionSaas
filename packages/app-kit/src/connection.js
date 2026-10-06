/**
 * The product's connection to its Portal, kept in its own control database (never in the environment).
 *
 * - **Secrets** (`settings: secrets`): one random 32-byte root secret generated on first start (insert-if-absent, so
 *   concurrent cold starts agree). `secret(label)` derives a purpose key from it (HKDF), e.g. the idempotency HMAC key or
 *   a product's feed-token secret.
 * - **Signing key** (`settings: signingKey`): the product's Ed25519 key, generated on the first connect and kept.
 * - **Connection** (`settings: connection`): `{ portalUrl, appId, baseUrl, privateJwk, connectedAt }`, written by
 *   `handleConnect` (`POST /.well-known/ss-connect`) when a Portal proves it holds the deployer's `CONNECT_SECRET`
 *   (`@ss/protocol` `verifyConnectRequest`). Connecting again replaces it: whoever holds the secret is the authority.
 *
 * Both are loaded once per instance and cached; the connection is re-read at most once a second while unconnected and
 * every 30 seconds once connected, so every instance notices a connect made on another one.
 * @module
 */
import { hkdfSync } from 'node:crypto';
import {
	canonicalUrl,
	createConnectResponse,
	createSigner,
	generateSigningKey,
	isConnectSecret,
	MIN_CONNECT_SECRET_LENGTH,
	toPublicJwk,
	verifyConnectRequest,
} from '@ss/protocol';
import { kitError } from './util.js';

/** @typedef {import('@ss/protocol').PrivateJwk} PrivateJwk */
/** @typedef {import('@ss/protocol').PublicJwk} PublicJwk */
/** @typedef {import('@ss/protocol').Signer} Signer */

/**
 * @typedef {object} Connection
 * @property {string} portalUrl canonical pinned Portal URL
 * @property {string | null} appId
 * @property {string | null} baseUrl where this product is reachable (recorded at setup; null for injected connections)
 * @property {Signer} signer
 * @property {PublicJwk} publicJwk
 * @property {PrivateJwk} privateJwk
 */

const RECHECK_MS = 1000;
const CONNECTED_RECHECK_MS = 30_000;
/** A connect nonce is remembered this long (well past the ±5 min window). */
const NONCE_TTL_MS = 15 * 60_000;

/**
 * @param {{
 *   settings: import('./stores/types.js').SettingsStore,
 *   portalKeys: import('./stores/types.js').PortalKeyStore,
 *   nonces: import('./stores/types.js').ReplayStore,
 *   connectSecret?: string,
 *   manifest: { product: { slug: string }, endpoints?: Record<string, any> },
 *   injected?: { portalUrl: string, appId: string | null, privateJwk: Record<string, unknown> } | null,
 *   now?: () => number,
 *   randomBytes: (length: number) => Uint8Array,
 *   nodeEnv?: string,
 *   logger: import('./logger.js').Logger,
 * }} options `injected` fixes the connection (tests, the emulator): connecting is then refused
 */
export const createConnection = ({
	settings,
	portalKeys,
	nonces,
	connectSecret,
	manifest,
	injected = null,
	now = Date.now,
	randomBytes,
	nodeEnv,
	logger,
}) => {
	/** @param {Record<string, any>} doc @returns {Connection} */
	const toConnection = (doc) => {
		const publicJwk = toPublicJwk(doc.privateJwk);
		if (typeof doc.privateJwk?.d !== 'string') throw kitError('invalid_config', 'signingKey must include the private member d');
		const privateJwk = /** @type {PrivateJwk} */ ({ ...publicJwk, d: doc.privateJwk.d });
		return Object.freeze({
			portalUrl: canonicalUrl(doc.portalUrl),
			appId: typeof doc.appId === 'string' && doc.appId.length > 0 ? doc.appId : null,
			baseUrl: typeof doc.baseUrl === 'string' ? doc.baseUrl : null,
			signer: createSigner(privateJwk),
			publicJwk,
			privateJwk,
		});
	};

	/** @type {Connection | null} */
	let current = injected ? toConnection(injected) : null;
	/** @type {Buffer | null} */
	let root = null;
	let checkedAt = 0;
	/** @type {Promise<void> | null} */
	let loading = null;

	const loadSecrets = async () => {
		if (root) return;
		let doc = await settings.get('secrets');
		if (!doc) {
			await settings.insert('secrets', { root: Buffer.from(randomBytes(32)).toString('base64url') });
			doc = await settings.get('secrets');
		}
		if (!doc || typeof doc.root !== 'string') throw kitError('internal_error', 'product secrets are unavailable');
		root = Buffer.from(doc.root, 'base64url');
	};

	const loadConnection = async () => {
		if (injected) return;
		const at = now();
		if (checkedAt !== 0 && at - checkedAt < (current ? CONNECTED_RECHECK_MS : RECHECK_MS)) return;
		checkedAt = at;
		const doc = await settings.get('connection');
		if (
			doc &&
			(!current || doc.appId !== current.appId || doc.portalUrl !== current.portalUrl || doc.baseUrl !== current.baseUrl)
		)
			current = toConnection(doc);
	};

	/** Load secrets and the connection (cached; an unconnected instance re-checks at most once a second). */
	const ready = async () => {
		loading ??= loadSecrets().finally(() => {
			loading = null;
		});
		await loading;
		await loadConnection();
	};

	/**
	 * A purpose key derived from the generated root secret (call after `ready()`).
	 * @param {string} label
	 * @returns {Buffer}
	 */
	const secret = (label) => {
		if (!root) throw kitError('internal_error', 'product secrets are not loaded yet (await product.ready())');
		return Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), `ss-app-kit.secret.v1|${label}`, 32));
	};

	/** @returns {Connection} */
	const active = () => {
		if (!current)
			throw kitError('not_connected', 'this product is not connected to a Portal yet (Portal: Admin → Apps → Add product)');
		return current;
	};

	/**
	 * The signing key kept in the control database (generated on first connect; an older deployment's connection key is
	 * kept).
	 * @returns {Promise<Record<string, any>>} private JWK
	 */
	const signingKey = async () => {
		const stored = await settings.get('signingKey');
		if (stored?.privateJwk) return stored.privateJwk;
		const legacy = (await settings.get('connection'))?.privateJwk;
		/** @type {Record<string, any>} */
		let privateJwk = legacy;
		if (!privateJwk) {
			const day = new Date(now()).toISOString().slice(0, 10).replace(/-/g, '');
			const kid = `${manifest.product.slug}-${day}-${Buffer.from(randomBytes(3)).toString('hex')}`;
			privateJwk = (await generateSigningKey({ kid })).privateJwk;
		}
		await settings.insert('signingKey', { privateJwk });
		const winner = await settings.get('signingKey');
		if (!winner?.privateJwk) throw kitError('internal_error', 'the signing key could not be stored');
		return winner.privateJwk;
	};

	/**
	 * `POST /.well-known/ss-connect`: a Portal connecting with the deployer's `CONNECT_SECRET` (HMAC over the exact body
	 * and timestamp, ±5 min, single-use nonce). Generates the signing key if there is none, records the Portal URL, the
	 * appId and this product's address, pins the Portal keys and answers the public key and the manifest, HMAC-signed
	 * with the same secret. Connecting again replaces the binding: whoever holds the secret is the authority.
	 * @param {{ headers: Headers, rawBody: string }} input
	 * @returns {Promise<{ status: number, headers: Record<string, string>, body: string }>}
	 */
	const handleConnect = async ({ headers, rawBody }) => {
		/** @param {number} status @param {string} code @param {string} detail */
		const refuse = (status, code, detail) => {
			logger.warn('connection refused', { reason: code });
			return {
				status,
				headers: { 'content-type': 'application/problem+json' },
				body: JSON.stringify({
					type: 'about:blank',
					title: detail,
					status,
					code,
					detail,
					...(code === 'misconfigured' ? { problems: [detail] } : {}),
				}),
			};
		};
		if (injected) return refuse(409, 'conflict', 'This product has a fixed connection.');
		if (!isConnectSecret(connectSecret)) return refuse(503, 'misconfigured', connectSecretProblem(connectSecret));
		/** @type {ReturnType<typeof verifyConnectRequest>} */
		let request;
		try {
			request = verifyConnectRequest({ secret: connectSecret, headers, body: rawBody, now });
		} catch {
			return refuse(401, 'unauthorized', 'The connect request does not verify.');
		}
		if (await nonces.seen(`ss-connect|${request.nonce}`, now() + NONCE_TTL_MS))
			return refuse(401, 'unauthorized', 'The connect request does not verify.');
		const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(request.baseUrl).hostname);
		if (new URL(request.baseUrl).protocol !== 'https:' && (nodeEnv === 'production' || !local))
			return refuse(400, 'bad_request', 'The product address must use https.');
		await ready();
		const privateJwk = await signingKey();
		const doc = {
			portalUrl: request.portalUrl,
			appId: request.appId,
			baseUrl: request.baseUrl,
			privateJwk,
			connectedAt: now(),
		};
		await settings.put('connection', doc);
		await portalKeys.put(request.jwks, now());
		current = toConnection(doc);
		checkedAt = now();
		logger.info('product connected to the Portal', { portalUrl: request.portalUrl, appId: request.appId });
		const answer = createConnectResponse({
			secret: connectSecret,
			appId: request.appId,
			nonce: request.nonce,
			publicJwk: current.publicJwk,
			manifest: withBase(manifest, request.baseUrl),
			now,
		});
		return { status: 200, headers: answer.headers, body: answer.body };
	};

	return Object.freeze({
		ready,
		secret,
		active,
		handleConnect,
		/** @returns {Connection | null} */
		current: () => current,
		/** @returns {boolean} */
		connected: () => current !== null,
		/** @returns {boolean} */
		fixed: () => injected !== null,
	});
};

/**
 * Why connecting is refused for this `CONNECT_SECRET` (names the variable, never its value).
 * @param {string | undefined} secret
 * @returns {string}
 */
export const connectSecretProblem = (secret) =>
	typeof secret === 'string' && secret !== ''
		? `This product refuses connections: CONNECT_SECRET is shorter than ${MIN_CONNECT_SECRET_LENGTH} characters.`
		: `This product refuses connections: CONNECT_SECRET is not set (at least ${MIN_CONNECT_SECRET_LENGTH} characters).`;

/**
 * The manifest as this deployment serves it: `endpoints.base` is the address recorded at setup.
 * @template {{ endpoints?: Record<string, any> }} M
 * @param {M} manifest
 * @param {string | null} baseUrl
 * @returns {M}
 */
export const withBase = (manifest, baseUrl) =>
	baseUrl?.startsWith('https://') && manifest.endpoints
		? { ...manifest, endpoints: { ...manifest.endpoints, base: baseUrl } }
		: manifest;
