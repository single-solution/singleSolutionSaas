/**
 * `createProduct` — one call wires the Product Standard for a service product: registration, events, launches,
 * website keys, entitlements with offline grace, usage, the signed Portal client, client-owned data, connectors,
 * audit, health and the request handler. Every side effect is injected (fetch, clock, randomness, logger, stores).
 * @module
 */
import { PROBLEM_CODES, createId, createProblemFactory, eventGlobMatches, eventNamespace, validateManifest } from '@ss/contracts';
import { createOutboundPolicy, safeFetch } from '@ss/net';
import {
	DEFAULT_GRACE_MS,
	canonicalUrl,
	createKeyResolver,
	createRegistrationHandler,
	createSigner,
	isProtocolError,
	signManifest,
	toPublicJwk,
	verifyRequest,
} from '@ss/protocol';
import { createAudit } from './audit.js';
import { createBackground } from './background.js';
import { createConnectors } from './connectors/index.js';
import { createData } from './data.js';
import { createEntitlements } from './entitlements.js';
import { checkEvent, createEvents } from './events.js';
import { createHealth } from './health.js';
import { createIdentity } from './identity.js';
import { createRequestHandler } from './http/handler.js';
import { createWebsiteKeys } from './keys.js';
import { createLaunch } from './launch.js';
import { noopLogger } from './logger.js';
import { createOutbox } from './outbox.js';
import { createPortalClient } from './portal-client.js';
import { createPrivacy } from './privacy.js';
import { createMemoryStores } from './stores/memory.js';
import { createUsage } from './usage.js';
import { createHmac } from 'node:crypto';
import { createReplayBodies } from './http/replay.js';
import { defaultRandomBytes, isObject, kitError, parseDurationMs, sha256Hex } from './util.js';

/** @typedef {import('@ss/contracts').Manifest} Manifest */

/** `cache-control` max-age of `/.well-known/ss-app.json` (seconds). */
const MANIFEST_CACHE_SECONDS = 300;
/** A manifest signature is reused for at most this long, then re-signed with a fresh `iat`. */
const MANIFEST_RESIGN_MS = 3_600_000;
/** @typedef {import('./stores/types.js').Stores} Stores */
/** @typedef {import('./logger.js').Logger} Logger */

/**
 * @typedef {object} ProductOptions
 * @property {Manifest} manifest validated SSPS manifest (service product, features inline)
 * @property {string} portalUrl pinned Portal URL (`SS_PORTAL_URL`)
 * @property {string | null} [appId] assigned at registration; when null the id recorded by the registration is used
 * @property {Record<string, unknown> | string} signingKey product private Ed25519 JWK (object or JSON)
 * @property {string | null} [registrationTokenHash] SHA-256 hex of the one-time registration token
 * @property {Partial<Stores>} [stores] defaults: in-memory (development only)
 * @property {typeof globalThis.fetch} [fetch]
 * @property {() => number} [now]
 * @property {(length: number) => Uint8Array} [randomBytes]
 * @property {Logger} [logger]
 * @property {string} [portalIssuer] `iss` of launches (default: the canonical Portal URL)
 * @property {string | string[]} [registrationAudience] extra accepted `aud` values of registration requests (always accepted: `endpoints.base` and the appId)
 * @property {boolean} [devProbes] mount `/v1/ss-probe/*` (only when `nodeEnv !== 'production'`)
 * @property {string} [nodeEnv] default `process.env.NODE_ENV`
 * @property {(registration: { portalUrl: string, appId?: string, portalKid: string }) => unknown} [onRegistered]
 * @property {string} [problemBaseUri] RFC 9457 type base (default `<endpoints.base>/problems/`)
 * @property {Record<string, { status: number, title: string }>} [problemCodes] product-specific problem codes
 * @property {string} [requestIdHeader] default `x-request-id`
 * @property {string} [sessionCookie] default `ss_session`
 * @property {number} [sessionTtlMs]
 * @property {boolean} [onlineLaunchConsume] also burn launches at the Portal
 * @property {Record<string, Record<string, string>> | ((lang: string) => Promise<Record<string, string> | null>)} [strings]
 * @property {string} [defaultLang] default `en`
 * @property {{ indexes?: import('./data.js').IndexDefinition[], migrations?: import('./data.js').MigrationStep[], createClient?: (uri: string, options: import('mongodb').MongoClientOptions) => import('mongodb').MongoClient, clientOptions?: import('mongodb').MongoClientOptions, idleMs?: number }} [data]
 * @property {Record<string, Record<string, import('./connectors/index.js').AdapterFactory>>} [connectors] provider adapters per kind
 * @property {import('@ss/net').OutboundPolicyOptions} [outbound] SSRF policy of connector calls and the merchant database (`@ss/net`); `allowHosts`
 *   is ignored when `nodeEnv === 'production'`
 * @property {import('./connectors/index.js').OutboundSend} [outboundSend] replaces `safeFetch` for connector calls and
 *   `product.outbound.fetch` (tests)
 * @property {import('./connectors/smtp.js').CreateSmtpTransport} [createSmtpTransport] replaces nodemailer's transport of
 *   the built-in `smtp` messaging adapter (tests)
 * @property {{ collections?: import('./privacy.js').PrivacyCollection[], export?: (input: any) => Promise<unknown>, anonymize?: (input: any) => Promise<unknown> }} [privacy]
 * @property {((entry: any) => Promise<unknown>) | null} [auditSink]
 * @property {{ entitlementTtlMs?: number, revocationSyncMs?: number }} [cache]
 * @property {{ mode?: import('./background.js').BackgroundMode, intervalMs?: number, everyRequests?: number }} [background]
 *   automatic flushing of the usage queue and the event outbox (default `auto`; `off` when `NODE_ENV=test`)
 */

/** Problem codes the kit itself answers with (registered unless `@ss/contracts` already defines them). */
const KIT_PROBLEM_CODES = Object.freeze({
	idempotency_replay_no_body: Object.freeze({ status: 409, title: 'Idempotent replay body unavailable' }),
});

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
const parseKey = (value) => {
	if (isObject(value)) return value;
	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value);
			if (isObject(parsed)) return parsed;
		} catch {
			// fall through
		}
	}
	throw kitError('invalid_config', 'signingKey must be a private Ed25519 JWK (object or JSON string)');
};

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean} true when both are URLs with the same canonical form
 */
const sameUrl = (a, b) => {
	try {
		return canonicalUrl(a) === canonicalUrl(b);
	} catch {
		return false;
	}
};

/**
 * Read (without verifying) the claims of a registration request, only to choose which accepted audience the protocol
 * handler must then verify against the signed `aud`.
 * @param {unknown} body
 * @returns {Record<string, unknown> | null}
 */
const peekRegistrationClaims = (body) => {
	try {
		const parsed = typeof body === 'string' ? JSON.parse(body) : body;
		const payload = isObject(parsed) && typeof parsed.request === 'string' ? parsed.request.split('.')[1] : undefined;
		if (!payload) return null;
		const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
		return isObject(claims) ? claims : null;
	} catch {
		return null;
	}
};

/**
 * Wire a product.
 * @param {ProductOptions} options
 */
export const createProduct = (options) => {
	const {
		manifest,
		portalUrl,
		appId = null,
		registrationTokenHash = null,
		fetch = globalThis.fetch,
		now = Date.now,
		randomBytes = defaultRandomBytes,
		logger = noopLogger,
	} = options;

	const checked = validateManifest(manifest);
	if (!checked.ok) {
		throw kitError(
			'invalid_manifest',
			`manifest is invalid: ${checked.problems.map((p) => `${p.path} ${p.message}`).join('; ')}`,
		);
	}
	if (manifest.product.kind !== 'service' || !manifest.endpoints) {
		throw kitError('invalid_manifest', 'app-kit serves service products; element packs have no backend');
	}
	if (typeof portalUrl !== 'string') throw kitError('invalid_config', 'portalUrl is required');
	const pinnedPortal = canonicalUrl(portalUrl);
	const privateJwk = parseKey(options.signingKey);
	const publicJwk = toPublicJwk(privateJwk);
	if (typeof privateJwk.d !== 'string') throw kitError('invalid_config', 'signingKey must include the private member d');
	const signer = createSigner(/** @type {import('@ss/protocol').PrivateJwk} */ (privateJwk));

	const defaults = createMemoryStores({ now });
	if (!options.stores) logger.warn('using in-memory stores: development only (use createMongoStores in production)');
	/** @type {Stores} */
	const stores = { ...defaults, ...(options.stores ?? {}) };
	if (options.stores && !options.stores.ping) delete stores.ping;

	const tokenHash =
		typeof registrationTokenHash === 'string' && /^[0-9a-f]{64}$/.test(registrationTokenHash) ? registrationTokenHash : null;
	/** @type {string | null} */
	let knownAppId = appId;
	const resolveAppId = async () => {
		if (knownAppId) return knownAppId;
		if (!tokenHash) return null;
		const registration = await stores.burnedTokens.get(tokenHash).catch(() => null);
		if (registration && typeof registration.appId === 'string') knownAppId = registration.appId;
		return knownAppId;
	};

	/** @type {{ appId: string, at: number, jws: string } | null} the current manifest signature (re-signed hourly) */
	let manifestSignature = null;

	const portal = createPortalClient({ portalUrl: pinnedPortal, appId: resolveAppId, signer, fetch, now, randomBytes });
	const graceMs = parseDurationMs(manifest.capabilities?.offlineGrace, DEFAULT_GRACE_MS);
	// The last good Portal JWKS is persisted so cold instances can verify during a Portal outage. Serving stays bounded
	// by the documents themselves (entitlements: validUntil + grace; keys: revocation staleness ≤ grace).
	const keyResolver = createKeyResolver({
		fetchJwks: async () => {
			try {
				const jwks = await portal.jwks();
				await stores.portalKeys.put(jwks, now()).catch(() => {});
				return jwks;
			} catch (error) {
				const cached = await stores.portalKeys.get().catch(() => null);
				if (cached && now() - cached.fetchedAt < graceMs) {
					logger.warn('Portal JWKS unreachable; using the stored copy', { ageMs: now() - cached.fetchedAt });
					return cached.jwks;
				}
				throw error;
			}
		},
		now,
		maxStaleMs: graceMs,
	});

	const entitlements = createEntitlements({
		portal,
		keyResolver,
		store: stores.entitlements,
		productSlug: manifest.product.slug,
		graceMs,
		now,
		logger,
		...(options.cache?.entitlementTtlMs ? { ttlMs: options.cache.entitlementTtlMs } : {}),
	});
	const keys = createWebsiteKeys({
		keyResolver,
		portal,
		store: stores.revocations,
		now,
		logger,
		maxStaleMs: graceMs,
		...(options.cache?.revocationSyncMs ? { syncIntervalMs: options.cache.revocationSyncMs } : {}),
	});
	const launch = createLaunch({
		keyResolver,
		issuer: options.portalIssuer ?? pinnedPortal,
		audience: resolveAppId,
		replay: stores.replay,
		sessions: stores.sessions,
		now,
		randomBytes,
		...(options.sessionTtlMs ? { sessionTtlMs: options.sessionTtlMs } : {}),
		onlineConsume: options.onlineLaunchConsume ? (input) => portal.consumeLaunch(input) : null,
	});
	const meteredUnits = manifest.elements.flatMap((element) => (element.price.metered ?? []).map((m) => m.unit));
	const usage = createUsage({
		queue: stores.usageQueue,
		portal,
		units: meteredUnits.length > 0 ? meteredUnits : null,
		now,
		randomBytes,
		logger,
		subscriptionFor: async (websiteId) => {
			const result = await entitlements.forWebsite(websiteId);
			return result.ok ? result.doc.subscriptionId : null;
		},
	});
	const outbox = createOutbox({ store: stores.eventOutbox, portal, now, randomBytes, logger });
	const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
	const background = createBackground({
		tasks: [
			{ name: 'usage', run: () => usage.flush() },
			{ name: 'events', run: () => outbox.flush() },
		],
		mode: options.background?.mode ?? (nodeEnv === 'test' ? 'off' : 'auto'),
		logger,
		...(options.background?.intervalMs ? { intervalMs: options.background.intervalMs } : {}),
		...(options.background?.everyRequests ? { everyRequests: options.background.everyRequests } : {}),
	});
	const production = nodeEnv === 'production';
	const { allowHosts = [], ...outboundRest } = options.outbound ?? {};
	if (production && allowHosts.length > 0) logger.warn('outbound.allowHosts is ignored in production');
	const outbound = { ...outboundRest, allowHosts: production ? [] : allowHosts };
	const data = createData({ portal, slug: manifest.product.slug, now, randomBytes, logger, outbound, ...(options.data ?? {}) });
	const outboundPolicy = createOutboundPolicy(outbound);
	/** @type {import('./connectors/index.js').OutboundSend} */
	const outboundSend = options.outboundSend ?? ((url, init) => safeFetch(url, init, outboundPolicy));
	const connectors = createConnectors({
		portal,
		slug: manifest.product.slug,
		fetch,
		now,
		adapters: options.connectors ?? {},
		outbound,
		...(options.outboundSend ? { send: options.outboundSend } : {}),
		...(options.createSmtpTransport ? { createSmtpTransport: options.createSmtpTransport } : {}),
	});
	const audit = createAudit({ data, now, sink: options.auditSink ?? null });
	const devProbes = options.devProbes === true && !production;
	// HMAC key for idempotency records (key + request fingerprint): derived from the product signing key, so the
	// control store never holds request content or brute-forceable plain hashes of it.
	const hmacKey = createHmac('sha256', 'ss-app-kit.idempotency.v1').update(String(privateJwk.d)).digest();
	const hmac = (/** @type {string} */ value) => createHmac('sha256', hmacKey).update(value).digest('hex');
	const replayBodies = createReplayBodies({ data, now, logger });
	const events = createEvents({ keyResolver, replay: stores.replay, now, logger, trackEffects: devProbes });
	const health = createHealth({ product: manifest.product, portal, ping: stores.ping ?? null, now });
	const privacy = createPrivacy({ data, now, ...(options.privacy ?? {}) });

	events.on('entitlement.changed', async (event) => {
		if (event.websiteId) await entitlements.refresh(event.websiteId);
	});
	events.on('key.revoked', async (event) => {
		const ids = Array.isArray(event.data.keyIds) ? event.data.keyIds : [event.data.keyId];
		await keys.revoke(/** @type {string[]} */ (ids));
	});
	events.on('resource.changed', (event) => {
		if (!event.websiteId) return;
		data.forget(event.websiteId);
		connectors.forget(event.websiteId);
	});

	/** @type {{ handle: (request: { headers: any, body: unknown }) => Promise<{ status: number, body: Record<string, unknown> }> }} */
	let registration = {
		handle: async () => {
			logger.warn('registration attempted without a registration token hash');
			return { status: 401, body: { error: 'unauthorized' } };
		},
	};
	if (tokenHash) {
		/** @type {Parameters<typeof createRegistrationHandler>[0]} */
		const registrationOptions = {
			registrationTokenHash: tokenHash,
			allowedPortalUrl: pinnedPortal,
			fetchJwks: async (url) => {
				const response = await fetch(url, {
					headers: { accept: 'application/json' },
					signal: AbortSignal.timeout(10_000),
					redirect: 'error',
				});
				if (!response.ok) throw kitError('portal_error', `JWKS answered ${response.status}`);
				return response.json();
			},
			manifest,
			productPublicJwk: publicJwk,
			productSigner: signer,
			onRegistered: async (reg) => {
				await stores.burnedTokens.annotate(tokenHash, {
					appId: reg.appId ?? null,
					portalKid: reg.portalKid,
					portalUrl: reg.portalUrl,
					registeredAt: reg.registeredAt,
				});
				if (reg.appId) knownAppId = knownAppId ?? reg.appId;
				await options.onRegistered?.(reg);
			},
			burnToken: () => stores.burnedTokens.burn(tokenHash),
			isTokenBurned: () => stores.burnedTokens.isBurned(tokenHash),
			nonceStore: stores.nonce,
			now,
		};
		/** @type {Map<string, ReturnType<typeof createRegistrationHandler>>} */
		const byAudience = new Map();
		/** @param {string} aud one protocol handler per accepted audience; the protocol still verifies the signed `aud` */
		const handlerFor = (aud) => {
			let found = byAudience.get(aud);
			if (!found) {
				found = createRegistrationHandler({ ...registrationOptions, expectedAudience: aud });
				byAudience.set(aud, found);
			}
			return found;
		};
		registration = {
			handle: async (request) => {
				const claims = peekRegistrationClaims(request.body);
				const endpointsBase = /** @type {{ base: string }} */ (manifest.endpoints).base;
				const allowed = new Set([
					endpointsBase,
					canonicalUrl(endpointsBase),
					...[options.registrationAudience ?? []].flat(),
					...(knownAppId ? [knownAppId] : typeof claims?.appId === 'string' ? [claims.appId] : []),
				]);
				if (typeof claims?.aud !== 'string' || claims.aud.length === 0) {
					logger.warn('registration refused', { reason: 'audience_missing', status: 401 });
					return { status: 401, body: { error: 'unauthorized' } };
				}
				// an audience outside the accepted set is pinned to a value the signed aud can never equal
				const chosen = handlerFor(
					allowed.has(claims.aud) || sameUrl(claims.aud, endpointsBase) ? claims.aud : `\u0000refused`,
				);
				const result = await chosen.handle(request);
				if (result.reason) logger.warn('registration refused', { reason: result.reason, status: result.status });
				else logger.info('product registered with the Portal', { portalUrl: pinnedPortal });
				return { status: result.status, body: result.body };
			},
		};
	}

	/**
	 * Verify a Portal-signed request (`@ss/protocol` `verifyRequest`: method, canonical path + query, audience = appId,
	 * body hash, ±300 s, replay store).
	 * @param {{ method: string, path: string, headers: Headers | Record<string, string | string[] | undefined>, rawBody: string }} request
	 */
	const verifyPortalRequest = async ({ method, path, headers, rawBody }) => {
		const audience = await resolveAppId();
		if (!audience) return { ok: false, kid: '', timestamp: 0 };
		try {
			const { kid, timestamp } = await verifyRequest({
				method,
				path,
				audience,
				headers,
				rawBody,
				keyResolver,
				replayStore: stores.replay,
				now,
			});
			return { ok: true, kid, timestamp };
		} catch (error) {
			logger.warn('Portal request signature rejected', { reason: isProtocolError(error) ? error.code : 'error' });
			return { ok: false, kid: '', timestamp: 0 };
		}
	};

	const namespace = eventNamespace(manifest.product.slug);
	const publishes = manifest.events?.publishes ?? [];
	/**
	 * Publish a product event: fills in the envelope (`id`, `occurredAt`, `env` from the website's entitlement,
	 * `actor: { type: 'product', id: slug }`, `context: { source: 'product', product: slug }`), validates it, sends it.
	 * The envelope goes through the durable outbox: it is stored first (idempotent by event id), sent right away when
	 * the Portal is reachable, and otherwise retried with backoff by `flush` / the background flusher (dead-lettered on
	 * a Portal rejection). The event id is derived from `(websiteId, type, idempotencyKey)` unless `id` is given, so a
	 * repeated publish of the same logical event is a no-op.
	 * @param {{ websiteId: string, type: string, data: Record<string, unknown>, idempotencyKey: string, id?: string, env?: 'live' | 'test', occurredAt?: string, context?: Record<string, unknown> }} input
	 */
	const publishEvent = async ({ websiteId, type, data, idempotencyKey, id, env, occurredAt, context: extraContext }) => {
		if (
			typeof type !== 'string' ||
			!(type.startsWith(`${namespace}.`) || publishes.some((pattern) => eventGlobMatches(pattern, type)))
		) {
			throw kitError('invalid_event', `'${String(type)}' is not an event this product publishes`);
		}
		let resolvedEnv = env;
		if (!resolvedEnv) {
			const result = await entitlements.forWebsite(websiteId);
			if (!result.ok) throw kitError('invalid_event', 'the website has no entitlement, so its env is unknown');
			resolvedEnv = result.doc.env;
		}
		if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0)
			throw kitError('invalid_event', 'idempotencyKey is required');
		const digest = Buffer.from(sha256Hex(`ss-event.v1\n${websiteId}\n${type}\n${idempotencyKey}`), 'hex');
		const envelope = {
			id: id ?? createId('evt', { randomBytes: (length) => new Uint8Array(digest.subarray(0, length)) }),
			type,
			websiteId,
			env: resolvedEnv,
			occurredAt: occurredAt ?? new Date(now()).toISOString(),
			idempotencyKey,
			actor: { type: 'product', id: manifest.product.slug },
			data,
			context: { source: 'product', product: manifest.product.slug, ...(extraContext ?? {}) },
		};
		const checked = checkEvent(envelope);
		if (!checked.ok) {
			throw kitError(
				'invalid_event',
				`event envelope is invalid: ${checked.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
			);
		}
		const { status } = await outbox.publish(envelope);
		if (status === 'queued') background.markDirty();
		return envelope;
	};

	const problems = createProblemFactory({
		baseUri: options.problemBaseUri ?? `${canonicalUrl(manifest.endpoints.base)}/problems/`,
		codes: {
			...Object.fromEntries(Object.entries(KIT_PROBLEM_CODES).filter(([code]) => !Object.hasOwn(PROBLEM_CODES, code))),
			...(options.problemCodes ?? {}),
		},
	});

	const context = Object.freeze({
		manifest,
		stores,
		logger,
		now,
		randomBytes,
		problems,
		verifyPortalRequest,
		privacy,
		strings: options.strings,
		defaultLang: options.defaultLang ?? 'en',
		sessionCookie: options.sessionCookie ?? 'ss_session',
		requestIdHeader: options.requestIdHeader ?? 'x-request-id',
		publicJwk,
		appId: resolveAppId,
		devProbes,
		hmac,
		replayBodies,
		background,
	});

	/** @type {any} */
	const product = {
		manifest,
		registration,
		events: Object.freeze({ handle: events.handle, on: events.on, dispatch: events.dispatch, effects: events.effects }),
		/**
		 * The manifest as served at `/.well-known/ss-app.json`: once the appId is known (after registration) it carries
		 * `SS-Manifest-Signature` (`@ss/protocol` `signManifest` with the product key); cacheable for 5 minutes.
		 * @returns {Promise<{ status: number, body: Manifest, headers: Record<string, string> }>}
		 */
		manifestRoute: async () => {
			/** @type {Record<string, string>} */
			const headers = { 'cache-control': `public, max-age=${MANIFEST_CACHE_SECONDS}` };
			const id = await resolveAppId().catch(() => null);
			if (id) {
				const at = now();
				if (!manifestSignature || manifestSignature.appId !== id || at - manifestSignature.at > MANIFEST_RESIGN_MS) {
					manifestSignature = { appId: id, at, jws: await signManifest({ signer, manifest, appId: id, now: () => at }) };
				}
				headers['ss-manifest-signature'] = manifestSignature.jws;
			}
			return { status: 200, body: manifest, headers };
		},
		launch,
		keys,
		entitlements,
		/** Bring-your-own customer identity: `verify(request, { doc, body })`, `verifyToken(token, section)`. */
		identity: createIdentity({ now }),
		usage: Object.freeze({
			...usage,
			/** @type {typeof usage.record} */
			record: async (input) => {
				const result = await usage.record(input);
				if (!result.duplicate) background.markDirty();
				return result;
			},
		}),
		/** Durable event outbox behind `portal.publishEvent`: `flush()` sends due events, `stats()` counts them. */
		outbox: Object.freeze({ flush: outbox.flush, stats: outbox.stats }),
		/**
		 * SSRF-guarded outbound HTTP under the product's outbound policy (`@ss/net` `safeFetch`: public https only,
		 * every DNS answer vetted at connect time, redirects only same-origin GET/HEAD, deadline, size cap). Resolves
		 * `{ status, headers, body: Buffer, url }`; rejects with a typed `NetError`.
		 */
		outbound: Object.freeze({
			/** @type {import('./connectors/index.js').OutboundSend} */
			fetch: (url, init) => outboundSend(url, init),
			policy: outboundPolicy,
		}),
		/** Flush the usage queue and the event outbox now (also run by the background flusher). */
		flush: () => background.tick(),
		background: Object.freeze({ mode: background.mode, start: background.start, stop: background.stop }),
		portal: Object.freeze({ ...portal, publishEvent }),
		data,
		connectors,
		audit,
		health,
		context,
		/** @param {ReadonlyArray<import('./http/routes.js').RouteDefinition>} routes @param {Parameters<typeof createRequestHandler>[2]} [handlerOptions] */
		handler: (routes, handlerOptions) => createRequestHandler(product, routes, handlerOptions),
		/** Flush the queues, then send a heartbeat `{ version, status, queues }`. */
		heartbeat: async () => {
			await background.tick();
			const [queues, events] = await Promise.all([usage.stats().catch(() => null), outbox.stats().catch(() => null)]);
			return portal.heartbeat({
				version: manifest.product.version,
				status: 'ok',
				...(queues || events
					? {
							queues: {
								...(queues ? { usagePending: queues.pending, usageDead: queues.dead } : {}),
								...(events ? { eventsPending: events.pending, eventsDead: events.dead } : {}),
							},
						}
					: {}),
			});
		},
		/** Stop the background flusher and close pooled client-database connections (graceful shutdown, tests). */
		close: () => {
			background.stop();
			return data.closeAll();
		},
	};
	return Object.freeze(product);
};
