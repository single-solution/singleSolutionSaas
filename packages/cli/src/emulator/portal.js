/**
 * The Portal side of the App Protocol, for local development (`ss dev`) and certification (`ss certify`).
 *
 * HTTP-free: `handleProduct()` implements the `/v1/product/*` API app-kit calls (client-assertion authenticated),
 * and the admin operations (register, launch, keys, emit, settle, entitlement switches) are plain functions. The
 * node:http glue lives in `server.js`. Everything uses the real primitives: `@ss/protocol` for signatures and the
 * handshake, `@ss/entitlements` for resolution and settlement, `@ss/contracts` for validation.
 * @module
 */
import { createId, createProblemFactory, createValidator, RESOURCE_KINDS, validateEvent, validateManifest } from '@ss/contracts';
import { normaliseProduct, resolveEntitlement, toDocument } from '@ss/entitlements';
import {
	canonicalUrl,
	createJwks,
	createKeyResolver,
	createMemoryReplayStore,
	createRegistrationRequest,
	createSigner,
	generateSigningKey,
	issueLaunch,
	issueWebsiteKey,
	signEntitlementDocument,
	signEvent,
	signRequest,
	toPublicJwk,
	verifyAssertion,
	verifyRegistrationResponse,
} from '@ss/protocol';
import { compile, evaluateCondition } from '@ss/rules';
import { isObject } from '../fsutil.js';
import { buildEnvelope, withVersion } from './events.js';
import { simulateSettlement } from './settle.js';

/** @typedef {import('./fixture.js').Fixture} Fixture */
/** @typedef {import('./fixture.js').FixtureWebsite} FixtureWebsite */
/** @typedef {import('./fixture.js').FixtureSubscription} FixtureSubscription */
/** @typedef {import('@ss/protocol').PublicJwk} PublicJwk */
/** @typedef {import('@ss/protocol').PrivateJwk} PrivateJwk */
/** @typedef {import('@ss/contracts').Manifest} Manifest */

/**
 * @typedef {object} App
 * @property {string} appId
 * @property {string} baseUrl where the running product is reachable (dev URL, not manifest `endpoints.base`)
 * @property {Manifest} manifest
 * @property {PublicJwk[]} keys registered product keys (old keys carry `exp` after a rotation)
 * @property {string} thumbprint
 * @property {string} registeredAt
 */
/**
 * @typedef {object} IssuedKey
 * @property {string} keyId
 * @property {'pk' | 'sk'} kind
 * @property {'live' | 'test'} env
 * @property {string} websiteId
 * @property {string} key
 * @property {string} issuedAt
 * @property {string | null} revokedAt
 */
/**
 * @typedef {object} UsageRow
 * @property {string} appId
 * @property {string} websiteId
 * @property {string} [subscriptionId]
 * @property {string} unit
 * @property {number} quantity
 * @property {string} idempotencyKey
 * @property {string} occurredAt
 * @property {string} receivedAt
 */
/** @typedef {{ status: number, headers: Record<string, string>, body: unknown }} PortalResponse */

/** Default lifetime of signed entitlement documents (the product caches them and survives outages via offlineGrace). */
export const DEFAULT_ENTITLEMENT_TTL_SECONDS = 600;
/** Overlap during which a rotated-out product key keeps verifying. */
export const KEY_ROTATION_OVERLAP_SECONDS = 3600;

/** Launch kinds and the fake users that open them. */
const LAUNCH_USERS = Object.freeze({
	merchant: { id: 'usr_devmerchant01', email: 'owner@example.com', name: 'Dev Owner', roles: ['owner'] },
	admin: { id: 'usr_devstaff01', email: 'staff@example.com', name: 'Dev Staff', roles: ['platform_admin'] },
	impersonate: { id: 'usr_devmerchant01', email: 'owner@example.com', name: 'Dev Owner', roles: ['owner'] },
	demo: { id: 'usr_demo', name: 'Demo visitor', roles: ['demo'] },
	partner: { id: 'usr_devpartner01', email: 'partner@example.com', name: 'Dev Partner', roles: ['partner'] },
	developer: { id: 'usr_devdeveloper01', email: 'developer@example.com', name: 'Dev Developer', roles: ['developer'] },
});

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 * @returns {Error & { code: string }}
 */
export const portalError = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/**
 * Rule evaluator injected into the resolver (rollout rules).
 * @param {() => number} now
 * @returns {(source: string, context: Readonly<Record<string, unknown>>) => boolean}
 */
const ruleEvaluator = (now) => (source, context) => {
	const compiled = compile(source);
	if (!compiled.ok) return false;
	const result = evaluateCondition(compiled.program, context, { now: new Date(now()) });
	return result.ok && result.value === true;
};

/**
 * @typedef {object} PortalOptions
 * @property {Fixture} fixture normalised fixture (see fixture.js); copied, never mutated
 * @property {string} [portalUrl] defaults to `fixture.portal.url`
 * @property {PrivateJwk} [signingKey] Portal Ed25519 key (generated when absent)
 * @property {Record<string, any>} [snapshot] state saved by `snapshot()` (keys, apps, website keys, usage, …)
 * @property {() => number} [now]
 * @property {typeof fetch} [fetch]
 * @property {number} [entitlementTtlSeconds]
 * @property {string} [assertionAudience] expected `aud` of product client assertions (default: the Portal URL)
 * @property {{ resolve: (target: { merchantId: string, websiteId: string }) => Promise<{ uri: string, dbName: string }> }} [database]
 * @property {Record<string, object>} [eventSchemas] product event data schemas by `type@v`
 * @property {(line: string) => void} [log]
 * @property {() => void} [onChange] called after every state change (persistence)
 */

/**
 * Create the emulated Portal.
 * @param {PortalOptions} options
 */
export const createPortal = async ({
	fixture: fixtureIn,
	portalUrl: portalUrlIn,
	signingKey,
	snapshot,
	now = Date.now,
	fetch = globalThis.fetch,
	entitlementTtlSeconds = DEFAULT_ENTITLEMENT_TTL_SECONDS,
	assertionAudience,
	database,
	eventSchemas = {},
	log = () => {},
	onChange = () => {},
}) => {
	/** @type {Fixture} */
	const fixture = structuredClone(fixtureIn);
	const portalUrl = canonicalUrl(portalUrlIn ?? fixture.portal.url);
	const audience = assertionAudience ?? portalUrl;
	const privateJwk = /** @type {PrivateJwk} */ (
		snapshot?.signingKey ?? signingKey ?? (await generateSigningKey({ kid: 'portal-dev-1' })).privateJwk
	);
	const signer = createSigner(privateJwk);
	const publicJwk = toPublicJwk(privateJwk);
	const problems = createProblemFactory({ baseUri: `${portalUrl}/problems/` });
	const replayStore = createMemoryReplayStore({ now });
	const evaluateRule = ruleEvaluator(now);
	const eventValidator =
		Object.keys(eventSchemas).length > 0
			? createValidator({ events: /** @type {Record<string, Record<string, unknown>>} */ (eventSchemas) })
			: null;

	/** @type {Map<string, App>} */
	const apps = new Map((snapshot?.apps ?? []).map((/** @type {App} */ app) => [app.appId, app]));
	/** @type {Map<string, IssuedKey>} */
	const keys = new Map((snapshot?.keys ?? []).map((/** @type {IssuedKey} */ key) => [key.keyId, key]));
	/** @type {UsageRow[]} */
	const usage = [...(snapshot?.usage ?? [])];
	const usageKeys = new Set(usage.map((row) => `${row.appId}|${row.idempotencyKey}`));
	/** @type {Array<{ appId: string, receivedAt: string, event: unknown }>} */
	const published = [...(snapshot?.published ?? [])];
	/** @type {Map<string, { hash: string, version: number }>} */
	const docVersions = new Map(Object.entries(snapshot?.docVersions ?? {}));
	/** @type {Set<string>} */
	const consumed = new Set();
	/** @type {Map<string, unknown>} */
	const usageBatches = new Map();
	/** @type {Map<string, Record<string, unknown>>} */
	const heartbeats = new Map();
	/** @type {WeakMap<Manifest, ReturnType<typeof normaliseProduct>>} */
	const products = new WeakMap();
	for (const subscription of fixture.subscriptions) {
		const layers = snapshot?.layers?.[subscription.id];
		if (isObject(layers)) subscription.layers = layers;
	}

	const iso = () => new Date(now()).toISOString();
	/**
	 * @param {unknown} body
	 * @param {number} [status]
	 * @returns {PortalResponse}
	 */
	const json = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body });
	/**
	 * @param {string} code
	 * @param {string} [detail]
	 * @returns {PortalResponse}
	 */
	const fail = (code, detail) => {
		const body = problems.create(code, detail === undefined ? {} : { detail });
		return { status: body.status, headers: { 'content-type': 'application/problem+json' }, body };
	};

	/** @param {string} websiteId */
	const websiteOf = (websiteId) => fixture.websites.find((website) => website.id === websiteId);
	/**
	 * @param {App} app
	 * @param {string} websiteId
	 */
	const subscriptionOf = (app, websiteId) =>
		fixture.subscriptions.find(
			(subscription) =>
				subscription.websiteId === websiteId &&
				(subscription.product === null || subscription.product === app.manifest.product.slug),
		);
	/**
	 * @param {App} app
	 * @param {FixtureSubscription} subscription
	 * @returns {string | null}
	 */
	const planOf = (app, subscription) =>
		subscription.plan === undefined ? (app.manifest.plans?.[0]?.code ?? null) : subscription.plan;
	/** @param {App} app */
	const productOf = (app) => {
		let product = products.get(app.manifest);
		if (!product) {
			product = normaliseProduct(/** @type {any} */ (app.manifest));
			products.set(app.manifest, product);
		}
		return product;
	};

	/**
	 * @param {string | undefined} appId
	 * @returns {App}
	 */
	const appOf = (appId) => {
		if (appId !== undefined) {
			const app = apps.get(appId);
			if (!app) throw portalError('unknown_app', `no registered app ${appId}`);
			return app;
		}
		const [only, ...rest] = apps.values();
		if (!only) throw portalError('not_registered', 'no product is registered yet (ss dev register --url … --token …)');
		if (rest.length > 0) throw portalError('ambiguous_app', 'several apps are registered; pass an appId');
		return only;
	};

	/**
	 * Resolve the effective entitlement of a website for an app.
	 * @param {App} app
	 * @param {string} websiteId
	 */
	const resolveFor = (app, websiteId) => {
		const website = websiteOf(websiteId);
		const subscription = website ? subscriptionOf(app, websiteId) : undefined;
		if (!website || !subscription) return null;
		const resolved = resolveEntitlement({
			product: productOf(app),
			subscription: {
				id: subscription.id,
				plan: planOf(app, subscription),
				status: subscription.status,
				websiteId,
				merchantId: website.merchantId,
				...(subscription.priceBookVersion ? { priceBookVersion: subscription.priceBookVersion } : {}),
			},
			layers: subscription.layers,
			runtime: { resources: website.resources, ...subscription.runtime },
			now: now(),
			evaluateRule,
		});
		return { website, subscription, resolved };
	};

	/**
	 * Signed entitlement document for a website (Portal-side `toDocument` + `signEntitlementDocument`).
	 * @param {App} app
	 * @param {string} websiteId
	 */
	const entitlementDocument = async (app, websiteId) => {
		const found = resolveFor(app, websiteId);
		if (!found) return { error: /** @type {const} */ ('not_found') };
		const { website, subscription, resolved } = found;
		if (resolved.state === 'cancelled') return { error: /** @type {const} */ ('gone') };
		const previous = docVersions.get(subscription.id);
		const version =
			previous === undefined ? 1 : previous.hash === resolved.contentHash ? previous.version : previous.version + 1;
		if (previous?.hash !== resolved.contentHash) {
			docVersions.set(subscription.id, { hash: resolved.contentHash, version });
			onChange();
		}
		const issuedAt = now();
		const result = toDocument(resolved, {
			websiteId,
			merchantId: website.merchantId,
			domain: website.domain,
			allowSubdomains: website.allowSubdomains,
			env: website.env,
			version,
			issuedAt: new Date(issuedAt).toISOString(),
			validFrom: new Date(issuedAt).toISOString(),
			validUntil: new Date(issuedAt + entitlementTtlSeconds * 1000).toISOString(),
			resources: Object.entries(website.resources)
				.filter(([kind]) => /** @type {readonly string[]} */ (RESOURCE_KINDS).includes(kind))
				.map(([kind, status]) => ({ kind, ref: `res_${kind}_${website.id}`, status })),
			dataScope: { prefix: `ss_${app.manifest.product.slug.replace(/-/g, '_')}_` },
		});
		if (!result.ok) {
			const detail =
				'problems' in result
					? result.problems.map((problem) => `${problem.path} ${problem.message}`).join('; ')
					: result.reason;
			throw portalError('document_invalid', `entitlement document rejected: ${detail}`);
		}
		const token = await signEntitlementDocument({ signer, payload: /** @type {any} */ (result.document) });
		return { token, document: result.document };
	};

	/**
	 * Authenticate a product call (client assertion).
	 * @param {Record<string, string | undefined>} headers lower-case names
	 * @returns {Promise<App | null>}
	 */
	const authenticate = async (headers) => {
		const match = /^Bearer (\S+)$/.exec(headers.authorization ?? '');
		if (!match) return null;
		try {
			const { appId } = await verifyAssertion({
				token: match[1],
				keyResolverForApp: (id) => {
					const app = apps.get(id);
					return app ? createKeyResolver({ jwks: createJwks(app.keys), now }) : null;
				},
				audience,
				replayStore,
				now,
			});
			return apps.get(appId) ?? null;
		} catch {
			return null;
		}
	};

	/**
	 * @param {unknown} value
	 * @returns {value is string}
	 */
	const isText = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;

	/**
	 * `/v1/product/*` — the API app-kit's signed Portal client calls.
	 * @param {{ method: string, path: string, query?: URLSearchParams, headers?: Record<string, string | undefined>, body?: unknown }} request
	 * @returns {Promise<PortalResponse>}
	 */
	const handleProduct = async ({ method, path, query = new URLSearchParams(), headers = {}, body }) => {
		const app = await authenticate(headers);
		if (!app) return fail('unauthorized', 'a valid client assertion (Authorization: Bearer <ss-assertion+jwt>) is required');
		const route = `${method.toUpperCase()} ${path}`;
		const input = isObject(body) ? body : {};
		switch (route) {
			case 'GET /v1/product/entitlements': {
				const websiteId = query.get('websiteId') ?? '';
				const result = await entitlementDocument(app, websiteId);
				if ('error' in result)
					return result.error === 'gone'
						? fail('gone', 'subscription cancelled')
						: fail('not_found', 'no subscription for this website');
				return json({ document: result.token });
			}
			case 'GET /v1/product/revocations': {
				const since = Date.parse(query.get('since') ?? '');
				const keyIds = [...keys.values()]
					.filter((key) => key.revokedAt !== null && (Number.isNaN(since) || Date.parse(key.revokedAt) >= since))
					.map((key) => key.keyId);
				return json({ keyIds, cursor: iso() });
			}
			case 'POST /v1/product/usage': {
				const records = Array.isArray(input.records) ? input.records : null;
				if (records === null) return fail('bad_request', 'body must be { records: [...] }');
				const batchKey = headers['idempotency-key'];
				const cached = batchKey ? usageBatches.get(`${app.appId}|${batchKey}`) : undefined;
				if (cached) return json(cached);
				/** @type {Array<{ idempotencyKey: string, status: 'accepted' | 'duplicate' | 'rejected', reason?: string }>} */
				const results = [];
				for (const raw of records) {
					const record = isObject(raw) ? raw : {};
					const key = isText(record.idempotencyKey) ? record.idempotencyKey : '';
					if (
						!key ||
						!isText(record.websiteId) ||
						!isText(record.unit) ||
						!Number.isInteger(record.quantity) ||
						/** @type {number} */ (record.quantity) <= 0
					) {
						results.push({
							idempotencyKey: key,
							status: 'rejected',
							reason: 'websiteId, unit, idempotencyKey and a positive integer quantity are required',
						});
						continue;
					}
					const subscription = subscriptionOf(app, /** @type {string} */ (record.websiteId));
					if (!subscription) {
						results.push({ idempotencyKey: key, status: 'rejected', reason: 'not_subscribed' });
						continue;
					}
					if (isText(record.subscriptionId) && record.subscriptionId !== subscription.id) {
						results.push({ idempotencyKey: key, status: 'rejected', reason: 'subscription_mismatch' });
						continue;
					}
					const dedupe = `${app.appId}|${key}`;
					if (usageKeys.has(dedupe)) {
						results.push({ idempotencyKey: key, status: 'duplicate' });
						continue;
					}
					usageKeys.add(dedupe);
					/** @type {UsageRow} */
					const row = {
						appId: app.appId,
						websiteId: /** @type {string} */ (record.websiteId),
						subscriptionId: subscription.id,
						unit: /** @type {string} */ (record.unit),
						quantity: /** @type {number} */ (record.quantity),
						idempotencyKey: key,
						occurredAt:
							typeof record.occurredAt === 'string' && !Number.isNaN(Date.parse(record.occurredAt))
								? record.occurredAt
								: iso(),
						receivedAt: iso(),
					};
					usage.push(row);
					results.push({ idempotencyKey: key, status: 'accepted' });
					log(`usage  ${row.websiteId}  ${row.unit} +${row.quantity}  (${row.idempotencyKey})`);
				}
				const response = { results };
				if (batchKey) usageBatches.set(`${app.appId}|${batchKey}`, response);
				if (results.some((result) => result.status === 'accepted')) onChange();
				return json(response);
			}
			case 'POST /v1/product/launch/consume': {
				if (!isText(input.jti)) return fail('bad_request', 'jti is required');
				const key = `${app.appId}|${input.jti}`;
				if (consumed.has(key)) return json({ consumed: false });
				consumed.add(key);
				return json({ consumed: true });
			}
			case 'POST /v1/product/heartbeat': {
				heartbeats.set(app.appId, { ...input, receivedAt: iso() });
				log(`heartbeat  ${app.appId}  ${typeof input.version === 'string' ? input.version : ''}`);
				return json({ ok: true, serverTime: iso() });
			}
			case 'POST /v1/product/keys/rotate': {
				/** @type {PublicJwk} */
				let next;
				try {
					next = toPublicJwk(input.publicJwk);
				} catch {
					return fail('bad_request', 'publicJwk must be an Ed25519 public JWK');
				}
				if (app.keys.some((key) => key.kid === next.kid)) return fail('conflict', 'kid already registered');
				const expires = Math.floor(now() / 1000) + KEY_ROTATION_OVERLAP_SECONDS;
				app.keys = [...app.keys.map((key) => (key.exp === undefined ? { ...key, exp: expires } : key)), next];
				onChange();
				log(`keys  ${app.appId} rotated to ${next.kid}`);
				return json({
					kid: next.kid,
					kids: app.keys.map((key) => key.kid),
					previousValidUntil: new Date(expires * 1000).toISOString(),
				});
			}
			case 'POST /v1/product/events': {
				const list = Array.isArray(input.events)
					? input.events
					: isObject(input.event)
						? [input.event]
						: 'type' in input
							? [input]
							: null;
				if (list === null || list.length === 0) return fail('bad_request', 'body must be { events: [...] }');
				const validator = eventValidator ?? { validateEvent };
				/** @type {Array<{ id: string | null, status: 'accepted' | 'rejected', reason?: string }>} */
				const results = [];
				for (const raw of list) {
					const event = isObject(raw) ? raw : {};
					const id = typeof event.id === 'string' ? event.id : null;
					const checked = validator.validateEvent(event);
					if (!checked.ok) {
						results.push({
							id,
							status: 'rejected',
							reason: checked.problems.map((problem) => `${problem.path} ${problem.message}`).join('; '),
						});
						continue;
					}
					const type = /** @type {string} */ (event.type);
					if (!(app.manifest.events?.publishes ?? []).includes(type)) {
						results.push({ id, status: 'rejected', reason: `${type} is not declared in events.publishes` });
						continue;
					}
					if (!subscriptionOf(app, /** @type {string} */ (event.websiteId))) {
						results.push({ id, status: 'rejected', reason: 'not_subscribed' });
						continue;
					}
					published.push({ appId: app.appId, receivedAt: iso(), event });
					results.push({ id, status: 'accepted' });
					log(`event  ${type}  ${String(event.websiteId)}  ${String(event.id)}`);
				}
				const accepted = results.filter((result) => result.status === 'accepted').length;
				if (accepted > 0) onChange();
				return json({ accepted, results }, accepted > 0 ? 202 : 422);
			}
			case 'POST /v1/product/resources/resolve': {
				const websiteId = typeof input.websiteId === 'string' ? input.websiteId : '';
				const kind = typeof input.kind === 'string' ? input.kind : '';
				const website = websiteOf(websiteId);
				if (!website || !subscriptionOf(app, websiteId)) return fail('not_found', 'no subscription for this website');
				if (!(app.manifest.requires?.resources ?? []).includes(/** @type {any} */ (kind)))
					return fail('forbidden', `the manifest does not require '${kind}'`);
				if (website.resources[kind] !== 'connected')
					return fail('resource_missing', `${kind} is not connected for this website`);
				const expiresAt = new Date(now() + 15 * 60_000).toISOString();
				if (kind === 'database') {
					if (!database) return fail('resource_missing', 'no database configured for the emulator');
					const descriptor = await database.resolve({ merchantId: website.merchantId, websiteId });
					return json({ kind, descriptor, expiresAt });
				}
				return json({ kind, descriptor: { provider: 'dev', ref: `res_${kind}_${website.id}` }, expiresAt });
			}
			default:
				return fail('not_found', `${route} is not a Portal product endpoint`);
		}
	};

	/**
	 * Registration handshake as the Portal (acting as an admin who pasted the token).
	 * @param {{ url: string, token: string, appId?: string, audience?: string }} input
	 */
	const register = async ({ url, token, appId = createId('app'), audience: audienceIn }) => {
		const baseUrl = canonicalUrl(url);
		/** @type {Record<string, any> | null} */
		let advertised = null;
		try {
			const response = await fetch(`${baseUrl}/.well-known/ss-app.json`);
			if (response.ok) advertised = /** @type {Record<string, any>} */ (await response.json());
		} catch {
			// the manifest is also carried by the registration response
		}
		const aud = audienceIn ?? (typeof advertised?.endpoints?.base === 'string' ? advertised.endpoints.base : undefined);
		const registerPath =
			typeof advertised?.endpoints?.register === 'string' ? advertised.endpoints.register : '/.well-known/ss-register';
		const request = await createRegistrationRequest({
			portalUrl,
			portalJwksUrl: `${portalUrl}/.well-known/jwks.json`,
			signer,
			registrationToken: token,
			appId,
			...(aud === undefined ? {} : { audience: aud }),
			now,
		});
		const response = await fetch(`${baseUrl}${registerPath}`, { method: 'POST', headers: request.headers, body: request.body });
		/** @type {unknown} */
		let body = null;
		try {
			body = await response.json();
		} catch {
			// handled below
		}
		if (response.status !== 200)
			throw portalError('registration_rejected', `the product answered ${response.status}`, { status: response.status, body });
		const verified = await verifyRegistrationResponse({
			response: body,
			expectedNonce: request.nonce,
			expectedPortalUrl: portalUrl,
			expectedAppId: appId,
			now,
		});
		const checked = validateManifest(verified.manifest);
		if (!checked.ok) {
			throw portalError(
				'invalid_manifest',
				checked.problems.map((problem) => `${problem.path} ${problem.message}`).join('; '),
				{ problems: checked.problems },
			);
		}
		/** @type {App} */
		const app = {
			appId,
			baseUrl,
			manifest: checked.value,
			keys: [verified.publicJwk],
			thumbprint: verified.thumbprint,
			registeredAt: iso(),
		};
		apps.set(appId, app);
		onChange();
		log(`registered  ${checked.value.product.slug} as ${appId} (key ${verified.publicJwk.kid}, jkt ${verified.thumbprint})`);
		return {
			appId,
			thumbprint: verified.thumbprint,
			kid: verified.publicJwk.kid,
			manifest: checked.value,
			status: response.status,
		};
	};

	/**
	 * Issue pk_/sk_ website keys (test env unless the website is live).
	 * @param {{ websiteId?: string }} [input]
	 * @returns {Promise<IssuedKey[]>}
	 */
	const issueKeys = async ({ websiteId } = {}) => {
		const targets = websiteId === undefined ? fixture.websites : fixture.websites.filter((website) => website.id === websiteId);
		if (targets.length === 0) throw portalError('unknown_website', `no website ${websiteId}`);
		/** @type {IssuedKey[]} */
		const issued = [];
		for (const website of targets) {
			for (const kind of /** @type {const} */ (['pk', 'sk'])) {
				const keyId = createId('key');
				const { key } = await issueWebsiteKey({
					signer,
					kind,
					websiteId: website.id,
					merchantId: website.merchantId,
					domain: website.domain,
					allowSubdomains: website.allowSubdomains,
					env: website.env,
					scopes: kind === 'pk' ? ['read', 'write'] : ['read', 'write', 'admin'],
					keyId,
					now,
				});
				const record = { keyId, kind, env: website.env, websiteId: website.id, key, issuedAt: iso(), revokedAt: null };
				keys.set(keyId, record);
				issued.push(record);
			}
		}
		onChange();
		return issued;
	};

	/**
	 * Current (unrevoked) keys, issuing a pair for websites that have none.
	 * @returns {Promise<IssuedKey[]>}
	 */
	const websiteKeys = async () => {
		for (const website of fixture.websites) {
			if (![...keys.values()].some((key) => key.websiteId === website.id && key.revokedAt === null))
				await issueKeys({ websiteId: website.id });
		}
		return [...keys.values()].filter((key) => key.revokedAt === null);
	};

	/**
	 * @param {string} keyId
	 * @returns {Promise<IssuedKey>}
	 */
	const revokeKey = async (keyId) => {
		const key = keys.get(keyId);
		if (!key) throw portalError('unknown_key', `no key ${keyId}`);
		if (key.revokedAt === null) {
			const revokedAt = iso();
			key.revokedAt = revokedAt;
			onChange();
			await deliverControl({ type: 'key.revoked@1', websiteId: key.websiteId, data: () => ({ keyIds: [keyId], revokedAt }) });
		}
		return key;
	};

	/**
	 * Launch URL generator for every kind.
	 * @param {{ kind: import('@ss/protocol').LaunchKind, appId?: string, merchantId?: string, scope?: string, websiteId?: string,
	 *   partnerId?: string, developerId?: string, actor?: string, userId?: string, ttlSeconds?: number, baseUrl?: string, now?: () => number }} input
	 */
	const launch = async ({
		kind,
		appId,
		merchantId,
		scope,
		websiteId,
		partnerId,
		developerId,
		actor,
		userId,
		ttlSeconds,
		baseUrl,
		now: clock = now,
	}) => {
		const app = appId !== undefined && !apps.has(appId) && baseUrl ? null : appOf(appId);
		const audienceId = app?.appId ?? /** @type {string} */ (appId);
		if (!Object.hasOwn(LAUNCH_USERS, kind))
			throw portalError('invalid_kind', `kind must be one of ${Object.keys(LAUNCH_USERS).join(', ')}`);
		const user = { ...LAUNCH_USERS[kind], ...(userId ? { id: userId } : {}) };
		const merchant = merchantId ?? (kind === 'admin' && scope ? scope : undefined) ?? fixture.merchants[0]?.id;
		const merchantWebsites = fixture.websites.filter((website) => website.merchantId === merchant).map((website) => website.id);
		/** @type {{ merchantId?: string, websiteIds?: string[], partnerId?: string, developerId?: string, permissions?: string[] }} */
		let launchScope = {};
		if (kind === 'merchant' || kind === 'impersonate' || kind === 'admin') {
			if (!merchant) throw portalError('invalid_scope', `${kind} launches need a merchant`);
			launchScope = { merchantId: merchant, websiteIds: websiteId ? [websiteId] : merchantWebsites };
			if (kind === 'admin') launchScope.permissions = ['admin:*'];
		} else if (kind === 'partner') launchScope = { partnerId: partnerId ?? fixture.ids.partner };
		else if (kind === 'developer') launchScope = { developerId: developerId ?? fixture.ids.developer };
		const subscriptions =
			kind === 'demo' || kind === 'partner' || kind === 'developer'
				? []
				: fixture.subscriptions
						.filter((subscription) => (launchScope.websiteIds ?? []).includes(subscription.websiteId))
						.map((subscription) => ({ id: subscription.id, websiteId: subscription.websiteId }));
		const issued = await issueLaunch({
			signer,
			issuer: portalUrl,
			audience: audienceId,
			subject: user.id,
			kind,
			user,
			scope: launchScope,
			subscriptions,
			...(kind === 'impersonate' ? { actor: actor ?? fixture.ids.staff } : {}),
			...(ttlSeconds === undefined ? {} : { ttlSeconds }),
			now: clock,
		});
		const target = baseUrl ?? app?.baseUrl ?? '';
		return {
			token: issued.token,
			claims: issued.claims,
			url: `${target}/sso?launch=${encodeURIComponent(issued.token)}`, // app-kit exchanges it for a session, then redirects to endpoints.dashboard
		};
	};

	/**
	 * POST a signed body to the app's events endpoint.
	 * @param {App} app
	 * @param {string} rawBody
	 * @param {Record<string, string>} headers
	 */
	const post = async (app, rawBody, headers) => {
		const path = app.manifest.endpoints?.events ?? '/.well-known/ss-events';
		const response = await fetch(`${app.baseUrl}${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: rawBody,
		});
		const text = await response.text();
		/** @type {unknown} */
		let body = text;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			// keep text
		}
		return { status: response.status, body };
	};

	/**
	 * Portal-signed detached headers for a body (events and Portal → product calls such as data export).
	 * @param {string} rawBody
	 * @param {{ timestamp?: number }} [options]
	 */
	const signBody = (rawBody, { timestamp } = {}) =>
		signEvent({ signer, body: rawBody, timestamp: timestamp ?? Math.floor(now() / 1000) });

	/**
	 * Portal → product request signature (`@ss/protocol` signRequest, audience = the product's appId).
	 * @param {{ method: string, path: string, body?: string, appId?: string, timestamp?: number }} input
	 */
	const signProductRequest = ({ method, path, body = '', appId, timestamp }) =>
		signRequest({
			signer,
			method,
			path,
			audience: appId ?? appOf(undefined).appId,
			body,
			timestamp: timestamp ?? Math.floor(now() / 1000),
		});

	/**
	 * Deliver a Portal control event (entitlement.changed, key.revoked, resource.changed, subscription.*) to every
	 * registered app subscribed for the website. Failures are reported, never thrown.
	 * @param {{ type: string, websiteId: string, data: (app: App) => Promise<Record<string, unknown>> | Record<string, unknown> }} input
	 */
	const deliverControl = async ({ type, websiteId, data }) => {
		/** @type {Array<{ appId: string, status: number, error?: string }>} */
		const deliveries = [];
		const website = websiteOf(websiteId);
		for (const app of apps.values()) {
			if (!website || !subscriptionOf(app, website.id) || !app.baseUrl) continue;
			try {
				const event = buildEnvelope({ type, websiteId: website.id, env: website.env, data: await data(app), now: now() });
				const checked = validateEvent(event);
				if (!checked.ok) throw new Error(checked.problems.map((problem) => `${problem.path} ${problem.message}`).join('; '));
				const rawBody = JSON.stringify(event);
				const result = await post(app, rawBody, { ...(await signBody(rawBody)) });
				deliveries.push({ appId: app.appId, status: result.status });
				log(`control  ${type} → ${app.appId} ${result.status}`);
			} catch (error) {
				deliveries.push({ appId: app.appId, status: 0, error: /** @type {Error} */ (error).message });
				log(`control  ${type} → ${app.appId} failed: ${/** @type {Error} */ (error).message}`);
			}
		}
		return deliveries;
	};

	/**
	 * Announce a changed entitlement document (`entitlement.changed@1`, document included).
	 * @param {string} websiteId
	 */
	const notifyEntitlement = (websiteId) =>
		deliverControl({
			type: 'entitlement.changed@1',
			websiteId,
			data: async (app) => {
				const subscription = /** @type {FixtureSubscription} */ (subscriptionOf(app, websiteId));
				const result = await entitlementDocument(app, websiteId);
				if ('error' in result)
					return { subscriptionId: subscription.id, websiteId, version: docVersions.get(subscription.id)?.version ?? 1 };
				return { subscriptionId: subscription.id, websiteId, version: result.document.version, document: result.token };
			},
		});

	/**
	 * Event injector: build, validate, sign and deliver an event to the product.
	 * @param {{ type: string, websiteId?: string, data?: Record<string, unknown>, id?: string, appId?: string, force?: boolean }} input
	 */
	const emit = async ({ type, websiteId, data, id, appId, force = false }) => {
		const app = appOf(appId);
		const website = websiteId === undefined ? fixture.websites[0] : websiteOf(websiteId);
		if (!website) throw portalError('unknown_website', `no website ${websiteId}`);
		const typed = withVersion(type);
		const consumes = app.manifest.events?.consumes ?? [];
		if (!force && !consumes.includes(typed))
			throw portalError(
				'not_subscribed',
				`${app.manifest.product.slug} does not consume ${typed} (events.consumes: ${consumes.join(', ') || 'none'})`,
			);
		const event = buildEnvelope({
			type: typed,
			websiteId: website.id,
			env: website.env,
			now: now(),
			...(data ? { data } : {}),
			...(id ? { id } : {}),
		});
		const checked = validateEvent(event);
		if (!checked.ok)
			throw portalError('invalid_event', checked.problems.map((problem) => `${problem.path} ${problem.message}`).join('; '));
		const rawBody = JSON.stringify(event);
		const headers = await signBody(rawBody);
		const result = await post(app, rawBody, { ...headers });
		log(`emit  ${typed} → ${app.baseUrl} ${result.status}`);
		return { ...result, event, rawBody, headers };
	};

	/**
	 * Re-deliver exact bytes (replay tests) or arbitrary headers (signature tests).
	 * @param {{ rawBody: string, headers: Record<string, string>, appId?: string }} input
	 */
	const deliver = ({ rawBody, headers, appId }) => post(appOf(appId), rawBody, headers);

	/**
	 * Switch an element (or set a feature) in one resolver layer of a website's subscription.
	 * @param {{ websiteId: string, element: string, enabled?: boolean, feature?: string, value?: unknown, layer?: 'platform' | 'merchant' | 'website' | 'admin' }} input
	 */
	const setEntitlement = async ({ websiteId, element, enabled, feature, value, layer = 'website' }) => {
		const subscription = fixture.subscriptions.find((candidate) => candidate.websiteId === websiteId);
		if (!subscription) throw portalError('unknown_website', `no subscription for ${websiteId}`);
		const current = isObject(subscription.layers[layer]) ? subscription.layers[layer] : {};
		const elements = isObject(current.elements) ? current.elements : {};
		const features = isObject(current.features) ? current.features : {};
		subscription.layers = {
			...subscription.layers,
			[layer]: {
				...current,
				elements: enabled === undefined ? elements : { ...elements, [element]: { enabled } },
				features: feature === undefined ? features : { ...features, [`${element}.${feature}`]: { value } },
			},
		};
		onChange();
		const deliveries = await notifyEntitlement(websiteId);
		return { layer: subscription.layers[layer], deliveries };
	};

	/**
	 * Change a subscription's status and announce it (`subscription.activated|paused|resumed|cancelled@1`, then
	 * `entitlement.changed@1` unless cancelled).
	 * @param {{ websiteId: string, status: string, reason?: string }} input
	 */
	const setSubscriptionStatus = async ({ websiteId, status, reason }) => {
		const subscription = fixture.subscriptions.find((candidate) => candidate.websiteId === websiteId);
		if (!subscription) throw portalError('unknown_website', `no subscription for ${websiteId}`);
		if (status !== 'active' && status !== 'paused' && status !== 'cancelled')
			throw portalError('invalid_status', 'status must be active, paused or cancelled');
		const previous = subscription.status;
		subscription.status = status;
		onChange();
		const type =
			status === 'cancelled'
				? 'subscription.cancelled@1'
				: status === 'paused'
					? 'subscription.paused@1'
					: previous === 'paused'
						? 'subscription.resumed@1'
						: 'subscription.activated@1';
		const deliveries = await deliverControl({
			type,
			websiteId,
			data: () => ({ subscriptionId: subscription.id, websiteId, ...(reason ? { reason } : {}) }),
		});
		if (status !== 'cancelled') deliveries.push(...(await notifyEntitlement(websiteId)));
		return { status, type, deliveries };
	};

	/**
	 * Change a client resource's status and announce it (`resource.changed@1`, then `entitlement.changed@1`).
	 * @param {{ websiteId: string, kind: string, status: string }} input
	 */
	const setResource = async ({ websiteId, kind, status }) => {
		const website = websiteOf(websiteId);
		if (!website) throw portalError('unknown_website', `no website ${websiteId}`);
		website.resources = { ...website.resources, [kind]: status };
		onChange();
		const deliveries = await deliverControl({
			type: 'resource.changed@1',
			websiteId,
			data: () => ({ websiteId, kind, status, ref: `res_${kind}_${websiteId}` }),
		});
		deliveries.push(...(await notifyEntitlement(websiteId)));
		return { resources: website.resources, deliveries };
	};

	/**
	 * Hourly settlement simulator over stored usage.
	 * @param {{ hours: number, appId?: string }} input
	 */
	const settle = ({ hours, appId }) => {
		const app = appOf(appId);
		return simulateSettlement({
			product: productOf(app),
			fixture: {
				...fixture,
				subscriptions: fixture.subscriptions.map((subscription) => ({ ...subscription, plan: planOf(app, subscription) })),
			},
			usage: usage.filter((row) => row.appId === app.appId),
			enabledElements: (subscription) => {
				const found = resolveFor(app, subscription.websiteId);
				return found
					? Object.entries(found.resolved.elements)
							.filter(([, element]) => element.enabled)
							.map(([key]) => key)
					: [];
			},
			now: now(),
			hours,
		});
	};

	/**
	 * Adopt an app without a handshake (tests, or a state file from `ss dev`).
	 * @param {App} app
	 */
	const adoptApp = (app) => {
		apps.set(app.appId, app);
		onChange();
	};

	return Object.freeze({
		portalUrl,
		signer,
		publicJwk,
		jwks: () => createJwks([publicJwk]),
		handleProduct,
		register,
		adoptApp,
		issueKeys,
		websiteKeys,
		revokeKey,
		launch,
		emit,
		deliver,
		signBody,
		signRequest: signProductRequest,
		deliverControl,
		setEntitlement,
		setSubscriptionStatus,
		setResource,
		settle,
		entitlementDocument: (/** @type {string} */ websiteId, /** @type {string | undefined} */ appId) =>
			entitlementDocument(appOf(appId), websiteId),
		apps: () => [...apps.values()],
		usage: () => [...usage],
		published: () => [...published],
		heartbeats: () => Object.fromEntries(heartbeats),
		fixture: () => fixture,
		snapshot: () => ({
			version: 1,
			portalUrl,
			signingKey: privateJwk,
			apps: [...apps.values()],
			keys: [...keys.values()],
			usage,
			published,
			docVersions: Object.fromEntries(docVersions),
			layers: Object.fromEntries(fixture.subscriptions.map((subscription) => [subscription.id, subscription.layers])),
		}),
	});
};

/** @typedef {Awaited<ReturnType<typeof createPortal>>} Portal */
