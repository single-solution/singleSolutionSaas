/**
 * A fake Portal for product tests, built only from `@ss/protocol` primitives: it signs entitlement documents,
 * website keys, launches and events with its own Ed25519 key, publishes a JWKS, verifies the product's client
 * assertions, deduplicates usage by idempotency key, serves revocations and resource descriptors, records
 * identity-issuer requests (approve or reject them as the merchant), and can simulate outages. `fetch` routes requests
 * for the Portal origin and delegates anything else to `fallbackFetch`.
 *
 * Test/development only — never deploy it.
 * @module
 */
import {
	createJwks,
	createKeyResolver,
	createConnectRequest,
	createMemoryReplayStore,
	createSigner,
	generateSigningKey,
	issueLaunch,
	issueWebsiteKey,
	signEntitlementDocument,
	signEvent,
	verifyAssertion,
	verifyConnectResponse,
} from '@ss/protocol';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { isObject } from './util.js';

/** @typedef {import('@ss/protocol').PublicJwk} PublicJwk */

/**
 * @param {number} status
 * @param {unknown} body
 * @returns {Response}
 */
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Build an entitlement payload with sensible defaults.
 * @param {Partial<import('@ss/contracts').EntitlementDocument> & { websiteId: string, productSlug: string, now: number, validForMs?: number }} input
 * @returns {import('@ss/contracts').EntitlementDocument}
 */
export const entitlementPayload = ({ now, validForMs = 5 * 60_000, ...input }) => ({
	subscriptionId: 'sub_0123456789abcdefghjkmnpq',
	merchantId: 'mer_0123456789abcdefghjkmnpq',
	domain: 'shop.example.com',
	allowSubdomains: false,
	env: 'live',
	priceBookVersion: '2026-10-01',
	version: 1,
	issuedAt: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
	validFrom: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
	validUntil: new Date(now + validForMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
	elements: {},
	features: {},
	config: {},
	runtime: { state: 'active' },
	resources: [],
	dataScope: { prefix: `ss_${input.productSlug.replace(/-/g, '_')}_` },
	...input,
});

/**
 * @param {{ url?: string, now?: () => number, appId?: string, kid?: string, fallbackFetch?: typeof globalThis.fetch }} [options]
 */
export const createFakePortal = async ({
	url = 'https://portal.test',
	now = Date.now,
	appId = 'app_test',
	kid = 'portal-1',
	fallbackFetch,
} = {}) => {
	const base = url.replace(/\/+$/, '');
	const { privateJwk, publicJwk } = await generateSigningKey({ kid });
	const signer = createSigner(privateJwk);
	/** @type {PublicJwk[]} */
	let jwksKeys = [publicJwk];
	/** @type {PublicJwk | null} */
	let productKey = null;
	const replay = createMemoryReplayStore({ now });
	/** @type {Map<string, string>} */
	const documents = new Map();
	/** @type {string[]} */
	const revoked = [];
	/** @type {Map<string, { descriptor: Record<string, unknown>, ttlMs: number }>} */
	const resources = new Map();
	/** @type {Map<string, Record<string, unknown>>} */
	const usage = new Map();
	/** @type {Set<string>} */
	const consumedLaunches = new Set();
	/** @type {unknown[]} */
	const published = [];
	/** @type {Array<{ method: string, path: string, appId?: string }>} */
	const calls = [];
	/** @type {Map<string, number[]>} */
	const failures = new Map();
	/** @type {Set<string>} */
	const rejectUsage = new Set();
	/** @type {Set<string>} event types answered `rejected` */
	const rejectEvents = new Set();
	/** @type {Set<string>} `${websiteId}|${idempotencyKey}` of accepted events (the Event Hub dedupes on it) */
	const seenEvents = new Set();
	/** @type {Map<string, { status: 'pending' | 'approved' | 'rejected', appId: string, input: Record<string, unknown> }>} */
	const identityRequests = new Map();
	/** @type {Map<string, Record<string, unknown>>} approved (active) issuers by websiteId */
	const identityIssuers = new Map();
	/** @type {Set<string>} websites whose identity requests are refused (403) */
	const refuseIdentity = new Set();
	const state = { down: false };
	/** @type {{ baseUrl: string, manifest: unknown } | null} the product bound by the last connect */
	let connected = null;

	/**
	 * @param {Request} request
	 * @returns {Promise<string | null>} appId when the assertion verifies
	 */
	const authenticate = async (request) => {
		const match = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '');
		if (!match || !productKey) return null;
		const key = productKey;
		try {
			const { appId: id } = await verifyAssertion({
				token: match[1],
				keyResolverForApp: (claimed) => (claimed === appId ? createKeyResolver({ jwks: createJwks([key]), now }) : null),
				audience: base,
				replayStore: replay,
				now,
			});
			return id;
		} catch {
			return null;
		}
	};

	/**
	 * @param {RequestInfo | URL} input
	 * @param {RequestInit} [init]
	 * @returns {Promise<Response>}
	 */
	const fetch = async (input, init) => {
		const request = new Request(input, init);
		const target = new URL(request.url);
		if (target.origin !== new URL(base).origin) {
			if (!fallbackFetch) throw new TypeError(`fake portal: no route to ${target.origin}`);
			return fallbackFetch(input, init);
		}
		if (state.down) throw new TypeError('fetch failed');
		const path = target.pathname;
		const queued = failures.get(path);
		if (queued && queued.length > 0) {
			const status = /** @type {number} */ (queued.shift());
			calls.push({ method: request.method, path });
			return json(status, { type: `${base}/problems/failure`, title: 'Injected failure', status });
		}
		if (path === '/.well-known/jwks.json') {
			calls.push({ method: 'GET', path });
			return json(200, createJwks(jwksKeys));
		}
		const caller = await authenticate(request);
		calls.push({ method: request.method, path, ...(caller ? { appId: caller } : {}) });
		if (!caller) return json(401, { type: `${base}/problems/invalid_credentials`, title: 'Invalid credentials', status: 401 });
		const body = request.method === 'POST' || request.method === 'PUT' ? await request.json().catch(() => null) : null;
		const identityPath = /^\/v1\/product\/websites\/([^/]+)\/identity$/.exec(path);
		if (request.method === 'PUT' && identityPath) {
			const websiteId = decodeURIComponent(identityPath[1] ?? '');
			if (refuseIdentity.has(websiteId))
				return json(403, { type: `${base}/problems/forbidden`, title: 'Forbidden', status: 403 });
			if (!isObject(body) || typeof body.issuer !== 'string')
				return json(422, { type: `${base}/problems/validation_failed`, title: 'Validation failed', status: 422 });
			const input = { claimMap: { subject: 'sub' }, ...body };
			const active = identityIssuers.get(websiteId);
			if (active && JSON.stringify(active) === JSON.stringify(input)) return json(200, { status: 'active', issuer: active });
			identityRequests.set(websiteId, { status: 'pending', appId: caller, input });
			return json(202, { status: 'pending', request: { websiteId, status: 'pending', ...input } });
		}
		switch (`${request.method} ${path}`) {
			case 'GET /v1/product/entitlements': {
				const token = documents.get(target.searchParams.get('websiteId') ?? '');
				return token
					? json(200, { document: token })
					: json(404, { type: `${base}/problems/not_found`, title: 'Not found', status: 404 });
			}
			case 'GET /v1/product/revocations': {
				const since = Number(target.searchParams.get('since') ?? '0');
				return json(200, { keyIds: revoked.slice(since), cursor: String(revoked.length) });
			}
			case 'POST /v1/product/usage': {
				const records = isObject(body) && Array.isArray(body.records) ? body.records : [];
				const results = records.map((/** @type {Record<string, any>} */ record) => {
					const key = String(record.idempotencyKey);
					if (rejectUsage.has(key)) return { idempotencyKey: key, status: 'rejected', reason: 'invalid_subscription' };
					if (usage.has(key)) return { idempotencyKey: key, status: 'duplicate' };
					usage.set(key, record);
					return { idempotencyKey: key, status: 'accepted' };
				});
				return json(200, { results });
			}
			case 'POST /v1/product/launch/consume': {
				const jti = isObject(body) ? String(body.jti) : '';
				const consumed = !consumedLaunches.has(jti);
				consumedLaunches.add(jti);
				return json(200, { consumed });
			}
			case 'POST /v1/product/events': {
				published.push(body);
				// like the Event Hub: per-event results, dedupe on (websiteId, idempotencyKey)
				const results = (isObject(body) && Array.isArray(body.events) ? body.events : []).map((/** @type {any} */ e) => {
					const ids = { id: e?.id, idempotencyKey: e?.idempotencyKey };
					if (rejectEvents.has(e?.type)) return { ...ids, status: 'rejected', reason: 'invalid_event' };
					const dedupe = `${e?.websiteId}|${e?.idempotencyKey}`;
					if (seenEvents.has(dedupe)) return { ...ids, status: 'duplicate' };
					seenEvents.add(dedupe);
					return { ...ids, status: 'accepted' };
				});
				return json(202, { accepted: results.filter((r) => r.status === 'accepted').length, results });
			}
			case 'POST /v1/product/resources/resolve': {
				const key = isObject(body) ? `${body.websiteId}|${body.kind}` : '';
				const resource = resources.get(key);
				if (!resource) return json(424, { type: `${base}/problems/resource_missing`, title: 'Missing', status: 424 });
				return json(200, {
					kind: /** @type {any} */ (body).kind,
					descriptor: resource.descriptor,
					expiresAt: new Date(now() + resource.ttlMs).toISOString(),
				});
			}
			default:
				return json(404, { type: `${base}/problems/not_found`, title: 'Not found', status: 404 });
		}
	};

	return {
		url: base,
		kid,
		publicJwk,
		signer,
		fetch,
		calls,
		published,
		usage,
		/** @param {boolean} down */
		setDown: (down) => {
			state.down = down;
		},
		/** Answer the next request to `path` with `status` (repeatable). @param {string} path @param {number} status */
		failNext: (path, status) => {
			failures.set(path, [...(failures.get(path) ?? []), status]);
		},
		/** @param {string} key */
		rejectUsageKey: (key) => rejectUsage.add(key),
		/** Identity-issuer requests (`PUT /v1/product/websites/:websiteId/identity`) by websiteId. */
		identityRequests,
		/**
		 * Decide a pending identity-issuer request as the merchant: `approve` makes it the active issuer (a repeated
		 * identical request then answers `active`). Returns the request, or null when none is pending.
		 * @param {string} websiteId
		 * @param {'approve' | 'reject'} decision
		 */
		decideIdentityRequest: (websiteId, decision) => {
			const pending = identityRequests.get(websiteId);
			if (!pending || pending.status !== 'pending') return null;
			pending.status = decision === 'approve' ? 'approved' : 'rejected';
			if (decision === 'approve') identityIssuers.set(websiteId, pending.input);
			return pending;
		},
		/** Answer identity-issuer requests for this website with 403. @param {string} websiteId */
		refuseIdentityRequests: (websiteId) => refuseIdentity.add(websiteId),
		/** Answer events of this type with `rejected`. @param {string} type */
		rejectEventType: (type) => rejectEvents.add(type),
		/** Trust this product key for client assertions. @param {PublicJwk} jwk */
		trustProductKey: (jwk) => {
			productKey = jwk;
		},
		/** Replace the published JWKS (rotation tests). @param {PublicJwk[]} keys */
		setJwks: (keys) => {
			jwksKeys = keys;
		},
		/** Sign and publish an entitlement document. @param {Parameters<typeof entitlementPayload>[0] extends infer P ? Omit<P, 'now'> & { now?: number } : never} input */
		setEntitlement: async (input) => {
			const payload = entitlementPayload({ now: now(), ...input });
			const token = await signEntitlementDocument({ signer, payload: /** @type {any} */ (payload) });
			documents.set(payload.websiteId, token);
			return { token, payload };
		},
		/** @param {string} websiteId */
		removeEntitlement: (websiteId) => documents.delete(websiteId),
		/** Sign an arbitrary document with the Portal key. @param {Record<string, unknown>} payload */
		signDocument: (payload) => signEntitlementDocument({ signer, payload: /** @type {any} */ (payload) }),
		/** @param {Omit<Parameters<typeof issueWebsiteKey>[0], 'signer' | 'now'>} input */
		issueWebsiteKey: (input) => issueWebsiteKey({ signer, now, ...input }),
		/** @param {string} keyId */
		revoke: (keyId) => revoked.push(keyId),
		/** @param {Omit<Parameters<typeof issueLaunch>[0], 'signer' | 'issuer' | 'audience' | 'now'> & { audience?: string }} input */
		issueLaunch: (input) => issueLaunch({ signer, issuer: base, audience: appId, now, ...input }),
		/** @param {string} websiteId @param {string} kind @param {Record<string, unknown>} descriptor @param {number} [ttlMs] */
		setResource: (websiteId, kind, descriptor, ttlMs = 5 * 60_000) =>
			resources.set(`${websiteId}|${kind}`, { descriptor, ttlMs }),
		/** Sign an event (or any body) for delivery to the product. @param {unknown} payload */
		signEvent: async (payload) => {
			const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
			const headers = await signEvent({ signer, body, timestamp: Math.floor(now() / 1000) });
			return { headers: { ...headers, 'content-type': 'application/json' }, body };
		},
		/**
		 * Connect a product the way the Portal does (`POST <productUrl>/.well-known/ss-connect`, HMAC with the connect
		 * secret): on success the product's key is pinned for client assertions.
		 * @param {{ productUrl: string, secret: string, fetch: (request: Request) => Promise<Response> }} input `fetch`
		 *   reaches the product (its request handler in tests)
		 * @returns {Promise<{ status: number, appId?: string }>}
		 */
		connect: async ({ productUrl, secret, fetch: productFetch }) => {
			const request = createConnectRequest({ secret, productUrl, portalUrl: base, jwks: createJwks(jwksKeys), appId, now });
			const res = await productFetch(
				new Request(request.url, { method: 'POST', headers: request.headers, body: request.body }),
			);
			if (!res.ok) return { status: res.status };
			const answer = await verifyConnectResponse({
				secret,
				headers: res.headers,
				body: await res.text(),
				nonce: request.nonce,
				appId,
				now,
			});
			productKey = answer.publicJwk;
			connected = { baseUrl: request.baseUrl, manifest: answer.manifest };
			return { status: res.status, appId };
		},
		/** The product bound by the last successful connect (`{ baseUrl, manifest }`), or null. */
		connected: () => connected,
	};
};

/**
 * A website's own identity issuer for tests (bring-your-own identity): a fresh key pair, the entitlement-document
 * `identity` section to pass to `setEntitlement({ identity })`, and `sign(claims, header?)` minting customer tokens.
 * @param {{ alg?: 'EdDSA' | 'ES256' | 'RS256', kid?: string, issuer?: string, audience?: string,
 *   claimMap?: { subject: string, email?: string, phone?: string } }} [options]
 */
export const createTestIdentityIssuer = ({
	alg = 'EdDSA',
	kid = 'site-key-1',
	issuer = 'https://login.shop.example.com/',
	audience,
	claimMap = { subject: 'sub', email: 'email', phone: 'phone_number' },
} = {}) => {
	const pair =
		alg === 'EdDSA'
			? generateKeyPairSync('ed25519')
			: alg === 'ES256'
				? generateKeyPairSync('ec', { namedCurve: 'P-256' })
				: generateKeyPairSync('rsa', { modulusLength: 2048 });
	const jwk = /** @type {Record<string, string>} */ (pair.publicKey.export({ format: 'jwk' }));
	const section = /** @type {import('@ss/contracts').IdentitySection} */ ({
		issuer,
		jwks: [{ ...jwk, kid, alg, use: 'sig' }],
		...(audience ? { audience } : {}),
		claimMap,
	});
	/** @param {unknown} value */
	const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
	return Object.freeze({
		section,
		/**
		 * @param {Record<string, unknown>} claims
		 * @param {Record<string, unknown>} [header] extra/overriding JWS header members
		 */
		sign: (claims, header = {}) => {
			const input = `${b64({ alg, kid, typ: 'JWT', ...header })}.${b64(claims)}`;
			const signature = cryptoSign(
				alg === 'EdDSA' ? null : 'sha256',
				Buffer.from(input),
				alg === 'ES256' ? { key: pair.privateKey, dsaEncoding: 'ieee-p1363' } : pair.privateKey,
			);
			return `${input}.${signature.toString('base64url')}`;
		},
	});
};
