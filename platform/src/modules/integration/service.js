/**
 * Public service of the `integration` module (Event Hub + control events). Other modules reach it with
 * `ctx.service('integration')`.
 *
 * Flow: website/product/Portal event → checks (`core/events.js`) → routing metadata in `integration_events`
 * (unique `(websiteId, idempotencyKey)` = dedupe) → fan-out at ingest to the products that consume the type →
 * one delivery record + one job `integration.deliver` per (event, product) carrying the payload **sealed** with
 * `ctx.envelope` (aad websiteId + eventId) → signed POST to the product's events endpoint → retries with the job
 * queue's backoff for ~24 h → DLQ (sealed, ≤ 7 days) → replay. Payloads never reach a collection in clear text.
 * @module
 */
import { createHash } from 'node:crypto';
import { createId } from '@ss/contracts';
import { originAllowed, signEvent, verifyWebsiteKey } from '@ss/protocol';
import { isProblem, problem } from '../../infra/http.js';
import {
	DELIVERY_STATUSES,
	DELIVERY_TIMEOUT_MS,
	attemptsForWindow,
	classifyError,
	classifyStatus,
	decodeCursor,
	deliveryView,
	dlqExpiry,
	encodeCursor,
	parseLimit,
} from './core/delivery.js';
import {
	DELIVERABLE_APP_STATUSES,
	buildControlEvent,
	checkBatch,
	checkProductEvent,
	checkWebsiteEvent,
	consumersOf,
	identify,
	isControlEvent,
	isDeliverableApp,
	parseIngestRequest,
	routeOf,
} from './core/events.js';
import { checkOutboundUrl, eventsEndpoint } from './core/outbound.js';
import { createIntegrationRepo } from './repo.js';
import { DEAD_LETTERS, DELIVERIES, EVENTS } from './schema.js';
import { createTransport } from './transport.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('../../infra/jobs.js').Job} Job */
/** @typedef {import('@ss/contracts').EventEnvelope} EventEnvelope */
/** @typedef {import('@ss/contracts').Manifest} Manifest */
/** @typedef {import('./core/events.js').EventResult} EventResult */
/** @typedef {import('./core/events.js').Route} Route */
/** @typedef {import('./repo.js').EventRecord} EventRecord */
/** @typedef {import('./transport.js').ResolveHost} ResolveHost */

/** Job name of a delivery attempt. */
export const DELIVER_JOB = 'integration.deliver';

/**
 * Website id used in the envelope of a control event that targets products without a website (for example
 * `manifest.accepted@1`): the v1 envelope requires a `websiteId`, so platform-wide events carry this sentinel.
 */
export const PLATFORM_WEBSITE_ID = `web_${'0'.repeat(26)}`;

/**
 * @typedef {object} IntegrationOptions
 * @property {ReadonlyArray<string>} [allowHosts] outbound hosts that may be private / plain http (development only)
 * @property {ResolveHost} [resolveHost] DNS resolver (tests)
 * @property {number} [timeoutMs] per-attempt delivery timeout (default 10 s)
 * @property {number} [maxAttempts] job attempts before the DLQ (default: spans 24 h of the queue's backoff)
 * @property {number} [routingCacheMs] how long a website's routing table is reused (default 10 s; 0 = never)
 */

/**
 * @typedef {object} WebsiteClaims
 * @property {string} websiteId
 * @property {string} merchantId
 * @property {'live' | 'test'} env
 * @property {'pk' | 'sk'} kind
 * @property {string} [keyId]
 */

/** @param {unknown} error */
const isNotFound = (error) =>
	typeof error === 'object' && error !== null && /** @type {Record<string, unknown>} */ (error).code === 'not_found';

/** @param {string} value */
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/**
 * @param {ModuleContext} ctx
 * @param {IntegrationOptions} [options]
 */
export const createIntegrationService = (ctx, options = {}) => {
	const repo = createIntegrationRepo({
		events: ctx.collection(EVENTS),
		deliveries: ctx.collection(DELIVERIES),
		deadLetters: ctx.collection(DEAD_LETTERS),
		now: ctx.now,
	});
	const maxAttempts = options.maxAttempts ?? attemptsForWindow();
	const allowHosts = options.allowHosts ?? [];
	const routingCacheMs = options.routingCacheMs ?? 10_000;
	const transport = createTransport({
		timeoutMs: options.timeoutMs ?? DELIVERY_TIMEOUT_MS,
		...(options.resolveHost ? { resolveHost: options.resolveHost } : {}),
	});
	const log = ctx.logger;
	// Website keys are verified against the website-key signer when infra provides one, else the Portal keys
	// (exactly what the `websiteKey` authenticator uses).
	const websiteKeyResolver = /** @type {any} */ (ctx.keys).websiteKeyResolver ?? ctx.keys.keyResolver;

	/**
	 * @param {string} name
	 * @returns {any | null}
	 */
	const optionalService = (name) => {
		try {
			return ctx.service(name);
		} catch {
			return null;
		}
	};

	const unavailable = () =>
		problem('unavailable', 'Event routing is temporarily unavailable.', { headers: { 'retry-after': '5' } });

	// -----------------------------------------------------------------------------------------------------------
	// Website keys (header and body authentication share this path)

	/**
	 * Verify a website key like the `websiteKey` authenticator: offline signature, revocation (identity), origin for pk_.
	 * @param {{ key: string, origin: string | null, referer: string | null }} input
	 * @returns {Promise<WebsiteClaims>}
	 */
	const verifyKey = async ({ key, origin, referer }) => {
		if (!/^(pk|sk)_/.test(key)) throw problem('invalid_credentials', 'The website key is invalid.');
		const identity = optionalService('identity');
		if (!identity || typeof identity.websiteKeyRevoked !== 'function')
			throw problem('unavailable', 'Website key verification is not available.', { headers: { 'retry-after': '30' } });
		/** @type {import('@ss/protocol').WebsiteKeyClaims} */
		let claims;
		try {
			claims = await verifyWebsiteKey({ key, keyResolver: websiteKeyResolver, revocations: [], now: ctx.now });
		} catch {
			throw problem('invalid_credentials', 'The website key is invalid.');
		}
		if (await identity.websiteKeyRevoked(claims)) throw problem('invalid_credentials', 'The website key is revoked.');
		if (
			claims.kind === 'pk' &&
			!originAllowed({ origin, referer, domain: claims.domain, allowSubdomains: claims.allowSubdomains, env: claims.env })
		)
			throw problem('origin_not_allowed', 'This key cannot be used from this origin.');
		return /** @type {WebsiteClaims} */ (claims);
	};

	// -----------------------------------------------------------------------------------------------------------
	// Routing

	/** @type {Map<string, { at: number, value: Promise<{ subscribed: Map<string, string>, table: Route[] }> }>} */
	const routingCache = new Map();

	/**
	 * Subscriptions of a website (`appId → status`) and the routing table of its deliverable, actively subscribed apps.
	 * @param {string} websiteId
	 * @returns {Promise<{ subscribed: Map<string, string>, table: Route[] }>}
	 */
	const loadRouting = async (websiteId) => {
		/** @type {unknown} */
		let subs;
		try {
			subs = await ctx.service('commerce').subscriptionsForWebsite(websiteId);
		} catch (error) {
			log.warn('subscriptions unavailable for routing', { websiteId, error });
			throw unavailable();
		}
		const value = /** @type {any} */ (subs);
		/** @type {Array<Record<string, unknown>>} */
		const list = Array.isArray(value) ? value : (value?.items ?? []);
		/** @type {Map<string, string>} */
		const subscribed = new Map();
		for (const sub of list) {
			if (typeof sub.appId !== 'string') continue;
			const status = String(sub.status);
			// an active subscription wins over older cancelled ones of the same app
			if (subscribed.get(sub.appId) !== 'active') subscribed.set(sub.appId, status);
		}
		/** @type {Route[]} */
		const table = [];
		const catalog = ctx.service('catalog');
		for (const [appId, status] of subscribed) {
			if (status !== 'active') continue;
			try {
				const app = await catalog.getApp(appId);
				if (!isDeliverableApp(app)) continue;
				const manifest = await catalog.getManifest(appId);
				if (manifest) table.push(routeOf(appId, manifest));
			} catch (error) {
				if (isNotFound(error)) continue;
				log.warn('catalog unavailable for routing', { websiteId, appId, error });
				throw unavailable();
			}
		}
		return { subscribed, table };
	};

	/** @param {string} websiteId */
	const routingFor = (websiteId) => {
		if (routingCacheMs <= 0) return loadRouting(websiteId);
		const hit = routingCache.get(websiteId);
		if (hit && ctx.now() - hit.at < routingCacheMs) return hit.value;
		const value = loadRouting(websiteId);
		routingCache.set(websiteId, { at: ctx.now(), value });
		value.catch(() => routingCache.delete(websiteId));
		if (routingCache.size > 5_000) routingCache.delete(/** @type {string} */ (routingCache.keys().next().value));
		return value;
	};

	// -----------------------------------------------------------------------------------------------------------
	// Accept + fan-out

	/**
	 * @param {string} websiteId
	 * @param {string} eventId
	 * @param {string} appId
	 * @param {number} [replay]
	 */
	const jobKey = (websiteId, eventId, appId, replay) => {
		const key = `deliver:${websiteId}:${eventId}:${appId}${replay ? `:replay:${replay}` : ''}`;
		return key.length <= 256 ? key : `deliver:${sha256(key)}`;
	};

	/**
	 * Create the delivery records and jobs of an event (idempotent: delivery records and job keys dedupe).
	 * @param {EventRecord} record
	 * @param {EventEnvelope} event
	 * @param {string[]} targets
	 * @param {'event' | 'control'} kind
	 */
	const fanout = async (record, event, targets, kind) => {
		if (targets.length > 0) {
			const sealed = ctx.envelope.seal(JSON.stringify(event), {
				aad: { websiteId: record.websiteId, eventId: record.eventId },
			});
			for (const appId of targets) {
				const { deliveryId } = await repo.ensureDelivery({
					_id: createId('dlv', { randomBytes: ctx.randomBytes }),
					eventRecordId: record._id,
					eventId: record.eventId,
					type: record.type,
					kind,
					websiteId: record.websiteId,
					merchantId: record.merchantId,
					appId,
				});
				await ctx.jobs.enqueue({
					name: DELIVER_JOB,
					key: jobKey(record.websiteId, record.eventId, appId),
					payload: { deliveryId, sealed },
					maxAttempts,
				});
			}
		}
		await repo.fanoutDone(record._id, targets.length);
	};

	/**
	 * Record an event (dedupe) and fan it out. A duplicate whose fan-out never finished (crash, concurrent request)
	 * resumes it; job keys keep deliveries single.
	 * @param {{ event: EventEnvelope, merchantId: string | null, source: EventRecord['source'], publisherAppId: string | null,
	 *   targets: string[], kind: 'event' | 'control' }} input
	 * @returns {Promise<'accepted' | 'duplicate'>}
	 */
	const accept = async ({ event, merchantId, source, publisherAppId, targets, kind }) => {
		/** @type {EventRecord} */
		const record = {
			_id: createId('iev', { randomBytes: ctx.randomBytes }),
			eventId: event.id,
			type: event.type,
			websiteId: event.websiteId,
			merchantId,
			env: event.env,
			source,
			publisherAppId,
			idempotencyKey: event.idempotencyKey,
			receivedAt: new Date(ctx.now()),
			fanout: 'pending',
			deliveries: { total: 0, delivered: 0, dead: 0 },
		};
		if (await repo.insertEvent(record)) {
			await fanout(record, event, targets, kind);
			return 'accepted';
		}
		const existing = await repo.eventByKey(event.websiteId, event.idempotencyKey);
		if (existing && existing.fanout === 'pending' && existing.eventId === event.id)
			await fanout(existing, event, targets, kind);
		return 'duplicate';
	};

	/**
	 * @param {unknown} raw
	 * @param {{ ok: false, reason: string, errors?: Array<{ path: string, message: string }> }} failure
	 * @returns {EventResult}
	 */
	const rejected = (raw, failure) => ({
		...identify(raw),
		status: 'rejected',
		reason: failure.reason,
		...(failure.errors ? { errors: failure.errors } : {}),
	});

	/**
	 * @param {EventResult[]} results
	 */
	const summary = (results) => ({ accepted: results.filter((r) => r.status === 'accepted').length, results });

	// -----------------------------------------------------------------------------------------------------------
	// Public: ingest

	/**
	 * Ingest website events (already authenticated key claims). Consent and end-customer identity are the site's
	 * concern: events arrive consented; identity tokens are not stored.
	 * @param {{ website: WebsiteClaims, events: unknown }} input
	 */
	const ingest = async ({ website, events }) => {
		const batch = checkBatch(events);
		if (!batch.ok) throw problem(batch.code, batch.detail);
		const { table } = await routingFor(website.websiteId);
		/** @type {EventResult[]} */
		const results = [];
		/** @type {Set<string>} */
		const seen = new Set();
		for (const raw of batch.events) {
			const checked = checkWebsiteEvent(raw, website);
			if (!checked.ok) {
				results.push(rejected(raw, checked));
				continue;
			}
			const { event } = checked;
			const ids = { id: event.id, idempotencyKey: event.idempotencyKey };
			if (seen.has(event.idempotencyKey)) {
				results.push({ ...ids, status: 'duplicate' });
				continue;
			}
			seen.add(event.idempotencyKey);
			const status = await accept({
				event,
				merchantId: website.merchantId,
				source: 'website',
				publisherAppId: null,
				targets: consumersOf(event.type, table),
				kind: 'event',
			});
			results.push({ ...ids, status });
		}
		return summary(results);
	};

	/**
	 * `POST /v1/events`: header (`Authorization: Bearer`) or body (`{ key, identity?, events }`, sendBeacon) auth.
	 * @param {{ rawBody: string, headers: Headers }} input
	 * @returns {Promise<{ body: ReturnType<typeof summary>, headers: Record<string, string> }>}
	 */
	const ingestRequest = async ({ rawBody, headers }) => {
		const parsed = parseIngestRequest({
			rawBody,
			contentType: headers.get('content-type'),
			authorization: headers.get('authorization'),
			identity: headers.get('ss-identity'),
		});
		if (!parsed.ok) throw problem(parsed.code, parsed.detail);
		const origin = headers.get('origin');
		const website = await verifyKey({ key: parsed.key, origin, referer: headers.get('referer') });
		/** @type {Record<string, string>} */
		const cors = website.kind === 'pk' && origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
		try {
			return { body: await ingest({ website, events: parsed.events }), headers: cors };
		} catch (error) {
			if (isProblem(error)) throw { ...error, headers: { ...error.headers, ...cors } };
			throw error;
		}
	};

	// -----------------------------------------------------------------------------------------------------------
	// Public: product events

	/**
	 * Events published by a product (`POST /v1/product/events`, F.9): manifest namespace + publish-scope rules,
	 * active subscription on the event's website, fan-out to the other subscribed products.
	 * @param {{ appId: string, events: unknown }} input
	 */
	const publishFromProduct = async ({ appId, events }) => {
		const batch = checkBatch(events);
		if (!batch.ok) throw problem(batch.code, batch.detail);
		const catalog = ctx.service('catalog');
		/** @type {Manifest} */
		let manifest;
		try {
			const app = await catalog.getApp(appId);
			if (!app || !DELIVERABLE_APP_STATUSES.includes(String(app.status)))
				throw problem('forbidden', 'The product is not active.');
			manifest = await catalog.getManifest(appId);
		} catch (error) {
			if (isNotFound(error)) throw problem('forbidden', 'The product is not registered.');
			if (isProblem(error)) throw error;
			throw unavailable();
		}
		if (!manifest) throw problem('forbidden', 'The product has no accepted manifest.');
		const identity = ctx.service('identity');
		/** @type {Map<string, Promise<{ merchantId: string, env: string } | null>>} */
		const websites = new Map();
		/** @param {string} websiteId */
		const websiteOf = (websiteId) => {
			let hit = websites.get(websiteId);
			if (!hit) {
				hit = Promise.resolve(identity.getWebsite(websiteId)).catch((error) => {
					if (isNotFound(error)) return null;
					throw unavailable();
				});
				websites.set(websiteId, hit);
			}
			return hit;
		};
		/** @type {EventResult[]} */
		const results = [];
		/** @type {Set<string>} */
		const seen = new Set();
		for (const raw of batch.events) {
			const checked = checkProductEvent(raw, manifest);
			if (!checked.ok) {
				results.push(rejected(raw, checked));
				continue;
			}
			const { event } = checked;
			const website = await websiteOf(event.websiteId);
			if (!website) {
				results.push(rejected(raw, { ok: false, reason: 'unknown_website' }));
				continue;
			}
			if (website.env !== event.env) {
				results.push(rejected(raw, { ok: false, reason: 'env_mismatch' }));
				continue;
			}
			const { subscribed, table } = await routingFor(event.websiteId);
			if (subscribed.get(appId) !== 'active') {
				results.push(rejected(raw, { ok: false, reason: 'not_subscribed' }));
				continue;
			}
			const ids = { id: event.id, idempotencyKey: event.idempotencyKey };
			const dedupe = `${event.websiteId}|${event.idempotencyKey}`;
			if (seen.has(dedupe)) {
				results.push({ ...ids, status: 'duplicate' });
				continue;
			}
			seen.add(dedupe);
			const status = await accept({
				event,
				merchantId: website.merchantId,
				source: 'product',
				publisherAppId: appId,
				targets: consumersOf(event.type, table, { exclude: appId }),
				kind: 'event',
			});
			results.push({ ...ids, status });
		}
		return summary(results);
	};

	// -----------------------------------------------------------------------------------------------------------
	// Public: control events

	/**
	 * Emit a Portal control event (`@ss/contracts` control schemas). Targets: `appIds` when given, otherwise every
	 * product with a (non-cancelled) subscription on `websiteId`. Control events reach their targets whether or not
	 * the manifest lists them in `events.consumes` (contracts: control events are delivered to every product).
	 * @param {string} type
	 * @param {unknown} data
	 * @param {{ appIds?: string[], websiteId?: string }} [target]
	 * @returns {Promise<{ eventId: string, websiteId: string, deliveries: number, appIds: string[] }>}
	 */
	const emitControl = async (type, data, { appIds, websiteId } = {}) => {
		if (!isControlEvent(type)) throw problem('validation_failed', `${type} is not a control event.`);
		if (appIds !== undefined && (!Array.isArray(appIds) || appIds.some((id) => typeof id !== 'string' || id === '')))
			throw problem('validation_failed', 'appIds must be a list of app ids.');
		if (!websiteId && (!appIds || appIds.length === 0))
			throw problem('validation_failed', 'A control event needs appIds or a websiteId.');
		/** @type {'live' | 'test'} */
		let env = ctx.config.env === 'production' ? 'live' : 'test';
		/** @type {string | null} */
		let merchantId = null;
		if (websiteId) {
			const website = await ctx.service('identity').getWebsite(websiteId);
			if (!website) throw problem('not_found', 'Unknown website.');
			env = website.env;
			merchantId = website.merchantId ?? null;
		}
		const id = createId('evt', { randomBytes: ctx.randomBytes });
		const built = buildControlEvent({
			type,
			data,
			websiteId: websiteId ?? PLATFORM_WEBSITE_ID,
			env,
			id,
			occurredAt: new Date(ctx.now()).toISOString(),
		});
		if (!built.ok)
			throw problem('validation_failed', `Invalid ${type}: ${built.reason}.`, {
				...(built.errors ? { errors: built.errors } : {}),
			});
		/** @type {string[]} */
		let targets;
		if (appIds && appIds.length > 0) targets = [...new Set(appIds)];
		else {
			const { subscribed } = await loadRouting(/** @type {string} */ (websiteId));
			targets = [...subscribed].filter(([, status]) => status !== 'cancelled').map(([appId]) => appId);
		}
		await accept({ event: built.event, merchantId, source: 'portal', publisherAppId: null, targets, kind: 'control' });
		return { eventId: id, websiteId: built.event.websiteId, deliveries: targets.length, appIds: targets };
	};

	// -----------------------------------------------------------------------------------------------------------
	// Delivery (job handler)

	/**
	 * One delivery attempt: resolve the endpoint, SSRF-check it, open the sealed payload, sign and POST.
	 * @param {Record<string, any>} delivery
	 * @param {string} sealed
	 * @param {AbortSignal | undefined} signal
	 * @returns {Promise<import('./core/delivery.js').AttemptOutcome>}
	 */
	const attempt = async (delivery, sealed, signal) => {
		/** @type {any} */
		let app;
		try {
			app = await ctx.service('catalog').getApp(delivery.appId);
		} catch (error) {
			if (isNotFound(error)) return { ok: false, code: 'app_unavailable', permanent: true };
			return { ok: false, code: 'catalog_unavailable', permanent: false };
		}
		if (!isDeliverableApp(app)) return { ok: false, code: 'app_unavailable', permanent: true };
		const endpoint = eventsEndpoint(app.endpoints);
		if (!endpoint) return { ok: false, code: 'no_endpoint', permanent: true };
		const guard = checkOutboundUrl(endpoint, { allowHosts });
		if (!guard.ok) return { ok: false, code: guard.code, permanent: true };
		/** @type {string} */
		let body;
		try {
			body = ctx.envelope.openText(sealed, { aad: { websiteId: delivery.websiteId, eventId: delivery.eventId } });
		} catch {
			return { ok: false, code: 'payload_unavailable', permanent: true };
		}
		const signed = await signEvent({
			signers: [...ctx.keys.signers].slice(0, 4),
			body,
			timestamp: Math.floor(ctx.now() / 1000),
		});
		try {
			const { status } = await transport.post({
				url: guard.url,
				headers: {
					'content-type': 'application/json',
					'user-agent': 'ss-portal-events/1',
					'ss-delivery-id': String(delivery._id),
					...signed,
				},
				body,
				allowPrivate: guard.allowPrivate,
				...(signal ? { signal } : {}),
			});
			return classifyStatus(status);
		} catch (error) {
			return classifyError(error);
		}
	};

	/**
	 * Job handler of `integration.deliver`. Idempotent: delivered/dead records are skipped. A failed attempt throws so
	 * the queue retries with backoff; the last allowed attempt (or a permanent failure) moves the sealed payload to the
	 * DLQ and completes the job.
	 * @param {unknown} payload `{ deliveryId, sealed }`
	 * @param {{ job: Job, signal?: AbortSignal }} jobCtx
	 * @returns {Promise<{ status: string, code?: string }>}
	 */
	const runDelivery = async (payload, { job, signal }) => {
		const input = /** @type {{ deliveryId?: unknown, sealed?: unknown }} */ (payload ?? {});
		if (typeof input.deliveryId !== 'string' || typeof input.sealed !== 'string') return { status: 'invalid' };
		const delivery = await repo.getDelivery(input.deliveryId);
		if (!delivery || delivery.status === 'delivered' || delivery.status === 'dead') return { status: 'skipped' };
		const outcome = await attempt(delivery, input.sealed, signal);
		const t = new Date(ctx.now());
		const common = { lastAttemptAt: t, lastHttpStatus: outcome.ok ? outcome.status : (outcome.status ?? null) };
		if (outcome.ok) {
			const changed = await repo.updateDelivery(
				delivery._id,
				{ $set: { ...common, status: 'delivered', deliveredAt: t, lastErrorCode: null }, $inc: { attempts: 1 } },
				{ status: { $in: ['pending', 'retrying'] } },
			);
			if (changed) await repo.bump(delivery.eventRecordId, { delivered: 1 });
			return { status: 'delivered' };
		}
		if (outcome.permanent || job.attempts >= job.maxAttempts) {
			const expireAt = dlqExpiry(ctx.now(), delivery.payloadExpiresAt);
			await repo.putDeadLetter({
				_id: delivery._id,
				websiteId: delivery.websiteId,
				merchantId: delivery.merchantId ?? null,
				appId: delivery.appId,
				eventId: delivery.eventId,
				type: delivery.type,
				sealed: input.sealed,
				attempts: (delivery.attempts ?? 0) + 1,
				lastErrorCode: outcome.code,
				expireAt,
			});
			const changed = await repo.updateDelivery(
				delivery._id,
				{
					$set: { ...common, status: 'dead', deadAt: t, lastErrorCode: outcome.code, payloadExpiresAt: expireAt },
					$inc: { attempts: 1 },
				},
				{ status: { $in: ['pending', 'retrying'] } },
			);
			if (changed) await repo.bump(delivery.eventRecordId, { dead: 1 });
			log.warn('delivery dead-lettered', { deliveryId: delivery._id, appId: delivery.appId, code: outcome.code });
			return { status: 'dead', code: outcome.code };
		}
		await repo.updateDelivery(
			delivery._id,
			{ $set: { ...common, status: 'retrying', lastErrorCode: outcome.code }, $inc: { attempts: 1 } },
			{ status: { $in: ['pending', 'retrying'] } },
		);
		throw Object.assign(new Error(`delivery failed: ${outcome.code}`), { code: outcome.code });
	};

	// -----------------------------------------------------------------------------------------------------------
	// Logs, DLQ, replay, metrics

	/**
	 * Throw `not_found` unless the website belongs to the merchant (merchant console tenant check).
	 * @param {string} websiteId
	 * @param {string} merchantId
	 */
	const assertWebsiteOf = async (websiteId, merchantId) => {
		/** @type {any} */
		let website = null;
		try {
			website = await ctx.service('identity').getWebsite(websiteId);
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
		if (!website || website.merchantId !== merchantId) throw problem('not_found', 'Unknown website.');
	};

	/**
	 * @param {{ cursor?: string | null, limit?: unknown }} input
	 */
	const pageOf = ({ cursor, limit }) => {
		const decoded = decodeCursor(cursor);
		if (!decoded.ok) throw problem('bad_request', 'cursor is invalid');
		const n = parseLimit(limit);
		if (n === null) throw problem('bad_request', 'limit must be 1..200');
		return { after: decoded.after, limit: n };
	};

	/**
	 * @template T
	 * @param {Array<Record<string, any>>} docs
	 * @param {number} limit
	 * @param {string} timeField
	 * @param {(doc: Record<string, any>) => T} view
	 */
	const respond = (docs, limit, timeField, view) => {
		const hasMore = docs.length > limit;
		const slice = hasMore ? docs.slice(0, limit) : docs;
		const last = slice[slice.length - 1];
		return {
			items: slice.map(view),
			nextCursor: hasMore && last ? encodeCursor({ createdAt: last[timeField], _id: last._id }) : null,
			hasMore,
		};
	};

	/**
	 * @param {unknown} status
	 */
	const statusFilter = (status) => {
		if (status === undefined || status === null || status === '') return {};
		if (!DELIVERY_STATUSES.includes(/** @type {any} */ (status))) throw problem('bad_request', 'status is invalid');
		return { status };
	};

	/**
	 * Delivery log of a website or an app (newest first, cursor pagination, no payloads). With `merchantId`, the
	 * website must belong to that merchant.
	 * @param {{ websiteId?: string, appId?: string, merchantId?: string, status?: string, cursor?: string | null, limit?: unknown }} input
	 */
	const deliveryLog = async ({ websiteId, appId, merchantId, status, cursor, limit }) => {
		if (!websiteId && !appId) throw problem('bad_request', 'websiteId or appId is required');
		if (merchantId) {
			if (!websiteId) throw problem('bad_request', 'websiteId is required');
			await assertWebsiteOf(websiteId, merchantId);
		}
		const page = pageOf({ cursor, limit });
		const docs = await repo.listDeliveries(
			{ ...(websiteId ? { websiteId } : {}), ...(appId ? { appId } : {}), ...statusFilter(status) },
			{ after: page.after, limit: page.limit + 1 },
		);
		return respond(docs, page.limit, 'createdAt', deliveryView);
	};

	/**
	 * Dead letters (staff): newest first, without the sealed payload.
	 * @param {{ websiteId?: string, appId?: string, cursor?: string | null, limit?: unknown }} [input]
	 */
	const deadLetters = async ({ websiteId, appId, cursor, limit } = {}) => {
		const page = pageOf({ cursor, limit });
		const docs = await repo.listDeadLetters(
			{ ...(websiteId ? { websiteId } : {}), ...(appId ? { appId } : {}) },
			{ after: page.after, limit: page.limit + 1 },
		);
		return respond(docs, page.limit, 'deadAt', (doc) => ({
			deliveryId: doc._id,
			eventId: doc.eventId,
			type: doc.type,
			websiteId: doc.websiteId,
			appId: doc.appId,
			attempts: doc.attempts,
			lastErrorCode: doc.lastErrorCode,
			deadAt: doc.deadAt,
			expiresAt: doc.expireAt,
		}));
	};

	/**
	 * Re-enqueue a dead delivery from its sealed DLQ copy (audited). Merchants pass `merchantId` (+ `websiteId`).
	 * @param {string} deliveryId
	 * @param {{ actor: Actor, merchantId?: string, websiteId?: string, requestId?: string | null, ip?: string | null }} context
	 */
	const replay = async (deliveryId, { actor, merchantId, websiteId, requestId = null, ip = null }) => {
		const delivery = await repo.getDelivery(deliveryId);
		if (!delivery || (websiteId && delivery.websiteId !== websiteId)) throw problem('not_found', 'Unknown delivery.');
		if (merchantId) await assertWebsiteOf(delivery.websiteId, merchantId);
		if (delivery.status !== 'dead')
			throw problem('conflict', `The delivery is ${delivery.status}; only dead deliveries replay.`);
		const letter = await repo.getDeadLetter(deliveryId);
		if (!letter || (letter.expireAt instanceof Date && letter.expireAt.getTime() <= ctx.now()))
			throw problem('gone', 'The payload of this delivery has expired.');
		const replays = (delivery.replays ?? 0) + 1;
		const changed = await repo.updateDelivery(
			deliveryId,
			{ $set: { status: 'pending', lastErrorCode: null, replayedAt: new Date(ctx.now()) }, $inc: { replays: 1 } },
			{ status: 'dead' },
		);
		if (!changed) throw problem('conflict', 'The delivery is being replayed.');
		await ctx.jobs.enqueue({
			name: DELIVER_JOB,
			key: jobKey(delivery.websiteId, delivery.eventId, delivery.appId, replays),
			payload: { deliveryId, sealed: letter.sealed },
			maxAttempts,
		});
		await repo.deleteDeadLetter(deliveryId);
		await repo.bump(delivery.eventRecordId, { dead: -1 });
		await ctx.audit.record({
			actor: /** @type {any} */ (actor),
			action: 'integration.delivery_replayed',
			target: { type: 'delivery', id: deliveryId, merchantId: delivery.merchantId ?? null, websiteId: delivery.websiteId },
			before: { status: 'dead' },
			after: { status: 'pending', replays },
			requestId,
			ip,
		});
		return { deliveryId, status: 'pending', replays };
	};

	/**
	 * Delivery counts per status (observability), optionally for one website or app.
	 * @param {{ websiteId?: string, appId?: string }} [input]
	 */
	const metrics = async ({ websiteId, appId } = {}) => {
		const match = { ...(websiteId ? { websiteId } : {}), ...(appId ? { appId } : {}) };
		const rows = await repo.countByStatus(match);
		/** @type {Record<string, number>} */
		const deliveries = Object.fromEntries(DELIVERY_STATUSES.map((status) => [status, 0]));
		for (const row of rows) if (Object.hasOwn(deliveries, row._id)) deliveries[row._id] = row.n;
		return { deliveries, deadLetters: await repo.countDeadLetters(match) };
	};

	return {
		verifyKey,
		ingest,
		ingestRequest,
		publishFromProduct,
		emitControl,
		runDelivery,
		deliveryLog,
		deadLetters,
		replay,
		metrics,
	};
};
/** @typedef {ReturnType<typeof createIntegrationService>} IntegrationService */
