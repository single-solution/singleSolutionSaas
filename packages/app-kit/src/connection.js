/**
 * The product's connection to its Portal, kept in its own control database (never in the environment).
 *
 * - **Secrets** (`settings: secrets`): one random 32-byte root secret generated on first start (insert-if-absent, so
 *   concurrent cold starts agree). `secret(label)` derives a purpose key from it (HKDF), e.g. the idempotency HMAC key or
 *   a product's feed-token secret.
 * - **Connection** (`settings: connection`): `{ portalUrl, appId, baseUrl, privateJwk, connectedAt }`, written once by
 *   `connect({ code, baseUrl })` (the `/setup` page): the product generates its Ed25519 key, proves possession to the
 *   Portal named in the connection code (`@ss/protocol` `createConnectRequest`), verifies the signed answer and pins
 *   the Portal URL, its appId and the Portal keys. Cleared only by a Portal-signed `disconnect` (or direct DB access).
 *
 * Both are loaded once per instance and cached; while unconnected, the connection is re-read at most once a second so
 * an instance notices a setup completed on another instance.
 * @module
 */
import { hkdfSync } from 'node:crypto';
import {
	canonicalUrl,
	createConnectRequest,
	createSigner,
	generateSigningKey,
	isProtocolError,
	parseConnectionCode,
	toPublicJwk,
	verifyConnectResponse,
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

/**
 * @param {{
 *   settings: import('./stores/types.js').SettingsStore,
 *   portalKeys: import('./stores/types.js').PortalKeyStore,
 *   manifest: { product: { slug: string }, endpoints?: Record<string, any> },
 *   injected?: { portalUrl: string, appId: string | null, privateJwk: Record<string, unknown> } | null,
 *   fetch?: typeof globalThis.fetch,
 *   now?: () => number,
 *   randomBytes: (length: number) => Uint8Array,
 *   nodeEnv?: string,
 *   logger: import('./logger.js').Logger,
 * }} options `injected` fixes the connection (tests, the emulator): setup and disconnect are then unavailable
 */
export const createConnection = ({
	settings,
	portalKeys,
	manifest,
	injected = null,
	fetch = globalThis.fetch,
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
		if (current || injected) return;
		const at = now();
		if (at - checkedAt < RECHECK_MS && checkedAt !== 0) return;
		checkedAt = at;
		const doc = await settings.get('connection');
		if (doc) current = toConnection(doc);
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
		if (!current) throw kitError('not_connected', 'this product is not connected to a Portal yet (open /setup)');
		return current;
	};

	/**
	 * Connect with a connection code (the `/setup` page). Refused when already connected.
	 * @param {{ code: string, baseUrl: string }} input
	 * @returns {Promise<{ appId: string, portalUrl: string, baseUrl: string }>}
	 */
	const connect = async ({ code, baseUrl }) => {
		if (injected) throw kitError('conflict', 'this product has a fixed connection');
		await ready();
		if (current || (await settings.get('connection'))) throw kitError('conflict', 'this product is already connected');
		/** @type {string} */
		let base;
		try {
			base = canonicalUrl(baseUrl);
			parseConnectionCode(code);
		} catch {
			throw kitError('invalid_argument', 'enter the connection code and the address this product is reachable at');
		}
		const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(base).hostname);
		if (new URL(base).protocol !== 'https:' && (nodeEnv === 'production' || !local))
			throw kitError('invalid_argument', 'the product address must use https');
		const day = new Date(now()).toISOString().slice(0, 10).replace(/-/g, '');
		const kid = `${manifest.product.slug}-${day}-${Buffer.from(randomBytes(3)).toString('hex')}`;
		const { privateJwk, publicJwk } = await generateSigningKey({ kid });
		const signer = createSigner(privateJwk);
		const request = await createConnectRequest({
			code,
			baseUrl: base,
			manifest: withBase(manifest, base),
			signer,
			publicJwk,
			now,
			randomBytes,
		});
		/** @type {Response} */
		let response;
		try {
			response = await fetch(request.url, {
				method: 'POST',
				headers: request.headers,
				body: request.body,
				signal: AbortSignal.timeout(15_000),
				redirect: 'error',
			});
		} catch {
			throw kitError('portal_unreachable', 'the Portal in the connection code could not be reached');
		}
		/** @type {unknown} */
		let body = null;
		try {
			body = await response.json();
		} catch {
			// handled below
		}
		if (!response.ok) {
			const detail = body && typeof body === 'object' && typeof (/** @type {any} */ (body).detail) === 'string';
			throw kitError(
				'portal_error',
				detail ? `the Portal refused the connection: ${/** @type {any} */ (body).detail}` : 'the Portal refused the connection',
				{ status: response.status },
			);
		}
		/** @type {Awaited<ReturnType<typeof verifyConnectResponse>>} */
		let accepted;
		try {
			accepted = await verifyConnectResponse({
				body,
				portalUrl: request.portalUrl,
				nonce: request.nonce,
				jkt: request.jkt,
				now,
			});
		} catch (error) {
			throw kitError('portal_error', `the Portal answer did not verify (${isProtocolError(error) ? error.code : 'invalid'})`);
		}
		const doc = { portalUrl: request.portalUrl, appId: accepted.appId, baseUrl: base, privateJwk, connectedAt: now() };
		if (!(await settings.insert('connection', doc))) throw kitError('conflict', 'this product is already connected');
		await portalKeys.put(accepted.jwks, now()).catch(() => {});
		current = toConnection(doc);
		logger.info('product connected to the Portal', { portalUrl: request.portalUrl, appId: accepted.appId });
		return { appId: accepted.appId, portalUrl: request.portalUrl, baseUrl: base };
	};

	/** Forget the connection (a Portal-signed disconnect): `/setup` accepts a new code afterwards. */
	const disconnect = async () => {
		if (injected) throw kitError('conflict', 'this product has a fixed connection');
		await settings.delete('connection');
		current = null;
		checkedAt = 0;
		logger.warn('product disconnected from its Portal');
	};

	return Object.freeze({
		ready,
		secret,
		active,
		connect,
		disconnect,
		/** @returns {Connection | null} */
		current: () => current,
		/** @returns {boolean} */
		connected: () => current !== null,
		/** @returns {boolean} */
		fixed: () => injected !== null,
	});
};

/**
 * The manifest as this deployment serves it: `endpoints.base` is the address recorded at setup.
 * @template {{ endpoints?: Record<string, any> }} M
 * @param {M} manifest
 * @param {string | null} baseUrl
 * @returns {M}
 */
export const withBase = (manifest, baseUrl) =>
	baseUrl?.startsWith('https://') && manifest.endpoints ? { ...manifest, endpoints: { ...manifest.endpoints, base: baseUrl } } : manifest;
