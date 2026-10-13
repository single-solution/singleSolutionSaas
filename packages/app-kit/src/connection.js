/**
 * The product's connection to the Portal (PLAN 0.4.12 row 1, 0.10), kept in the product database:
 *
 * - `state/productKey`: the product's Ed25519 key, generated on the first connect and kept (insert-if-absent, so
 *   concurrent instances agree), its private part sealed with `ENCRYPTION_KEY` (PLAN 0.4.8, K-21; a key kept in clear
 *   before is sealed on its next use). A key that no longer opens (`ENCRYPTION_KEY` lost) leaves the product not
 *   connected until the owner connects it again from the Portal, which makes a new key;
 * - `state/connection`: `{ portalUrl, jwks, baseUrl, connectedAt }`, written when a Portal proves it holds the
 *   deployer's `CONNECT_SECRET`. The Portal URL and its keys are pinned; `baseUrl` is this product's own address.
 *   Connecting again replaces it: whoever holds the secret is the authority;
 * - `state/prices`: the last accepted price list `{ version, features, pending }` (`pending`: a price report after a
 *   manifest change still has to be sent).
 *
 * Each instance re-reads the connection at most once a second while unconnected and every 30 seconds once connected.
 * @module
 */
import { manifestPriceList } from '@ss/contracts';
import {
	createConnectResponse,
	createKeyResolver,
	createSigner,
	generateSigningKey,
	toPublicJwk,
	verifyConnectRequest,
} from '@ss/protocol';
import { createPortalClient } from './portal-client.js';
import { problem } from './http/results.js';
import { openKey, resealKey, sealKey } from './sealing.js';
import { kitError } from './util.js';

/** @typedef {import('@ss/contracts').Manifest} Manifest */
/** @typedef {import('@ss/contracts').PriceList} PriceList */
/** @typedef {import('./stores/types.js').Store} Store */
/** @typedef {import('./portal-client.js').PortalClient} PortalClient */
/** @typedef {import('@ss/protocol').KeyResolver} KeyResolver */

/**
 * @typedef {object} ActiveConnection
 * @property {string} portalUrl pinned Portal URL (issuer of tokens and launches)
 * @property {string} baseUrl this product's own address
 * @property {PortalClient} client
 * @property {KeyResolver} portalKeys resolver over the pinned Portal keys
 */

const RECHECK_MS = 1000;
const CONNECTED_RECHECK_MS = 30_000;
const NONCE_TTL_MS = 15 * 60_000;
/** What the sealed product key is bound to. */
export const PRODUCT_KEY_AAD = 'state|productKey';
const KEY_AAD = PRODUCT_KEY_AAD;

/**
 * The price list of a manifest's current features, keeping the prices of `accepted` (new features 0, missing dropped).
 * @param {Manifest} manifest
 * @param {PriceList | null} accepted
 * @returns {PriceList['features']}
 */
export const currentFeatures = (manifest, accepted) =>
	manifestPriceList(manifest).features.map((feature) => ({
		...feature,
		millicreditsPerHour: accepted?.features.find((f) => f.key === feature.key)?.millicreditsPerHour ?? 0,
	}));

/**
 * True when the feature keys, names, descriptions or dependencies differ (prices are ignored).
 * @param {PriceList['features']} a
 * @param {PriceList['features']} b
 */
export const featuresDiffer = (a, b) => {
	/** @param {PriceList['features']} list */
	const shape = (list) =>
		JSON.stringify(list.map(({ key, name, description, dependsOn }) => [key, name, description, dependsOn]));
	return shape(a) !== shape(b);
};

/**
 * @param {{ store: Store, manifest: Manifest, connectSecret: string, sealer: import('./sealing.js').Sealer,
 *   fetch: typeof globalThis.fetch, now: () => number, randomBytes: (length: number) => Uint8Array,
 *   nodeEnv: string | undefined, logger: import('./logger.js').Logger }} options
 */
export const createConnection = ({ store, manifest, connectSecret, sealer, fetch, now, randomBytes, nodeEnv, logger }) => {
	const productId = manifest.id;
	/** @type {(ActiveConnection & { doc: Record<string, any> }) | null} */
	let current = null;
	let checkedAt = 0;

	/**
	 * @param {Record<string, any>} doc
	 * @param {Record<string, any>} privateJwk
	 */
	const activate = (doc, privateJwk) => {
		const client = createPortalClient({
			portalUrl: doc.portalUrl,
			productId,
			signer: createSigner(/** @type {any} */ (privateJwk)),
			fetch,
			now,
			randomBytes,
		});
		const portalKeys = createKeyResolver({
			jwks: doc.jwks,
			// an unknown kid (key rotation) refetches the Portal keys, at most once a minute
			fetchJwks: async () => {
				const jwks = await client.jwks();
				await store.put('state', 'connection', { ...doc, jwks });
				return jwks;
			},
			cacheTtlMs: 24 * 60 * 60_000,
			minRefreshIntervalMs: 60_000,
			maxStaleMs: Number.MAX_SAFE_INTEGER,
			now,
		});
		current = { portalUrl: doc.portalUrl, baseUrl: doc.baseUrl, client, portalKeys, doc };
	};

	/** Load the connection (cached per instance). */
	const ready = async () => {
		const at = now();
		if (checkedAt !== 0 && at - checkedAt < (current ? CONNECTED_RECHECK_MS : RECHECK_MS)) return;
		checkedAt = at;
		const doc = await store.get('state', 'connection');
		if (!doc || (current && doc.connectedAt === current.doc.connectedAt)) return;
		const privateJwk = await storedKey();
		if (privateJwk) activate(doc, privateJwk);
		else logger.error('the product key does not open: connect this product again from the Portal (ENCRYPTION_KEY)');
	};

	/** @returns {ActiveConnection} */
	const active = () => {
		if (!current) throw kitError('not_connected', 'this product is not connected to a Portal yet');
		return current;
	};

	/**
	 * The stored private key, sealed on its first use when it was kept in clear (K-21); null when there is none or it
	 * does not open.
	 * @returns {Promise<Record<string, any> | null>}
	 */
	const storedKey = async () => {
		const stored = await store.get('state', 'productKey');
		if (!stored) return null;
		if (stored.privateJwk) await store.put('state', 'productKey', sealKey(sealer, stored.privateJwk, KEY_AAD));
		return openKey(sealer, stored, KEY_AAD);
	};

	/**
	 * The product's private key: generated on the first connect, and made again by a connect when the stored one does
	 * not open (the Portal takes the new public key from the connect answer).
	 * @returns {Promise<Record<string, any>>}
	 */
	const productKey = async () => {
		const opened = await storedKey();
		if (opened) return opened;
		const day = new Date(now()).toISOString().slice(0, 10).replace(/-/g, '');
		const kid = `${productId}-${day}-${Buffer.from(randomBytes(3)).toString('hex')}`;
		const { privateJwk } = await generateSigningKey({ kid });
		const fresh = sealKey(sealer, privateJwk, KEY_AAD);
		if (await store.get('state', 'productKey')) {
			logger.warn('the product key did not open: a new one is made (ENCRYPTION_KEY changed)');
			await store.put('state', 'productKey', fresh);
		} else await store.insert('state', 'productKey', fresh);
		return /** @type {Record<string, any>} */ (await storedKey());
	};

	/** @returns {Promise<(PriceList & { pending: boolean }) | null>} the last accepted price list */
	const acceptedPrices = async () => {
		const doc = await store.get('state', 'prices');
		return doc ? { version: doc.version, features: doc.features, pending: doc.pending === true } : null;
	};

	/**
	 * @param {PriceList} list
	 * @param {boolean} [pending]
	 */
	const savePrices = (list, pending = false) =>
		store.put('state', 'prices', { version: list.version, features: list.features, pending, at: now() });

	/**
	 * `POST /.well-known/ss-connect`.
	 * @param {{ headers: Headers, rawBody: string }} input
	 * @returns {Promise<import('./http/results.js').RouteResult | Response>}
	 */
	const handleConnect = async ({ headers, rawBody }) => {
		/** @type {ReturnType<typeof verifyConnectRequest>} */
		let request;
		try {
			request = verifyConnectRequest({ secret: connectSecret, headers, body: rawBody, now });
		} catch {
			logger.warn('connect refused', { reason: 'signature' });
			return problem('unauthorized', 'The connect request does not verify.');
		}
		if (await store.seen(`connect|${request.nonce}`, now() + NONCE_TTL_MS))
			return problem('unauthorized', 'The connect request does not verify.');
		const { hostname, protocol } = new URL(request.baseUrl);
		const local = hostname === 'localhost' || hostname.endsWith('.localhost') || /^(127\.0\.0\.1|\[::1\])$/.test(hostname);
		if (protocol !== 'https:' && (nodeEnv === 'production' || !local))
			return problem('bad_request', 'The product address must use https.');
		const privateJwk = await productKey();
		const accepted = await acceptedPrices();
		const base = accepted ?? manifestPriceList(manifest);
		// the Portal's last accepted version wins when it is higher: the next report continues from it
		const prices = { version: Math.max(base.version, request.priceListVersion), features: base.features };
		await savePrices(prices, accepted?.pending ?? false);
		const doc = { portalUrl: request.portalUrl, jwks: request.jwks, baseUrl: request.baseUrl, connectedAt: now() };
		await store.put('state', 'connection', doc);
		activate(doc, privateJwk);
		checkedAt = now();
		logger.info('connected to the Portal', { portalUrl: request.portalUrl });
		const answer = createConnectResponse({
			secret: connectSecret,
			productId,
			nonce: request.nonce,
			publicJwk: toPublicJwk(privateJwk),
			manifest: { ...manifest, endpoints: { ...manifest.endpoints, base: request.baseUrl } },
			prices,
			now,
		});
		return new Response(answer.body, { status: 200, headers: answer.headers });
	};

	return Object.freeze({
		ready,
		active,
		handleConnect,
		/** The Owner's Re-seal of the product key (RT-14). */
		resealKey: () => resealKey(store, sealer, 'productKey', KEY_AAD),
		acceptedPrices,
		savePrices,
		/** @returns {boolean} */
		connected: () => current !== null,
	});
};
