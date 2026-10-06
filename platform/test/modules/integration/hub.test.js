import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@ss/contracts';
import {
	createKeyResolver,
	createMemoryReplayStore,
	createSigner,
	generateSigningKey,
	issueWebsiteKey,
	signAssertion,
	toPublicJwk,
	createJwks,
	verifyEvent,
} from '@ss/protocol';
import { closeMongoClients } from '../../../src/infra/db.js';
import { createIntegrationModule } from '../../../src/modules/integration/index.js';
import { createPortal } from '../../../src/portal.js';
import {
	MERCHANT,
	MERCHANT_2,
	PORTAL_URL,
	WEBSITE,
	createClock,
	createTestLogger,
	startMongo,
	testConfig,
} from '../../helpers.js';
import { createWorld } from './fakes/index.js';

const WEBSITE_2 = 'web_1123456789abcdefghjkmnpq';
const SHOP = 'https://shop.example.com';
const MARKER = 'PLAINTEXT-MARKER-7f3a';
const SAME_ORIGIN = { origin: PORTAL_URL, 'sec-fetch-site': 'same-origin' };

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
beforeAll(async () => {
	mongo = await startMongo();
}, 120_000);
afterAll(async () => {
	await closeMongoClients();
	await mongo?.stop();
});

/** @type {Array<() => Promise<void>>} */
const cleanups = [];
afterAll(async () => {
	for (const fn of cleanups) await fn();
});

/**
 * Local product: verifies every delivery with @ss/protocol verifyEvent under the Portal JWKS.
 * @param {{ jwks: any, now: () => number }} options
 */
const startReceiver = async ({ jwks, now }) => {
	const keyResolver = createKeyResolver({ jwks });
	/** @type {Map<string, ReturnType<typeof createMemoryReplayStore>>} one replay store per product (first path segment) */
	const stores = new Map();
	/** @param {string} path */
	const replayOf = (path) => {
		const product = path.split('/')[1] ?? '';
		const store = stores.get(product) ?? createMemoryReplayStore({ now });
		stores.set(product, store);
		return store;
	};
	/** @type {Array<{ path: string, event?: any, verified: boolean, error?: string, headers: Record<string, any> }>} */
	const received = [];
	/** @type {(path: string) => number | 'hang' | { status: number, location: string }} */
	let responder = () => 200;
	const server = createServer((req, res) => {
		/** @type {Buffer[]} */
		const chunks = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', async () => {
			const rawBody = Buffer.concat(chunks).toString('utf8');
			const path = String(req.url);
			try {
				await verifyEvent({
					headers: /** @type {any} */ (req.headers),
					rawBody,
					keyResolver,
					replayStore: replayOf(path),
					now,
				});
				received.push({ path, event: JSON.parse(rawBody), verified: true, headers: req.headers });
			} catch (error) {
				received.push({ path, verified: false, error: /** @type {any} */ (error).code, headers: req.headers });
				res.writeHead(401).end();
				return;
			}
			const status = responder(path);
			if (status === 'hang') return;
			if (typeof status === 'object') res.writeHead(status.status, { location: status.location }).end();
			else res.writeHead(status).end('ok');
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
	const address = /** @type {import('node:net').AddressInfo} */ (server.address());
	const close = () =>
		new Promise((resolve) => {
			server.closeAllConnections();
			server.close(() => resolve(undefined));
		});
	cleanups.push(async () => void (await close()));
	return {
		base: `http://127.0.0.1:${address.port}`,
		received,
		/** @param {(path: string) => number | 'hang' | { status: number, location: string }} fn */
		respond: (fn) => {
			responder = fn;
		},
	};
};

/**
 * @param {string} dbName
 * @param {{ options?: import('../../../src/modules/integration/service.js').IntegrationOptions, withoutIdentity?: boolean,
 *   background?: any }} [setup]
 */
const boot = async (dbName, { options = {}, withoutIdentity = false, background } = {}) => {
	const world = createWorld();
	const clock = createClock();
	const config = await testConfig();
	const { logger, entries } = createTestLogger();
	const portal = createPortal({
		config,
		db: mongo.db(dbName),
		modules: [
			...world.modules.filter((m) => !(withoutIdentity && m.name === 'identity')),
			createIntegrationModule({ allowHosts: ['127.0.0.1'], routingCacheMs: 0, timeoutMs: 1_000, ...options }),
		],
		logger,
		now: clock.now,
		...(background ? { background } : {}),
	});
	await portal.ensureIndexes();
	const receiver = await startReceiver({ jwks: portal.shared.keys.jwks(), now: clock.now });
	world.state.websites.set(WEBSITE, {
		websiteId: WEBSITE,
		merchantId: MERCHANT,
		domain: 'shop.example.com',
		env: 'live',
		status: 'active',
	});
	world.state.websites.set(WEBSITE_2, {
		websiteId: WEBSITE_2,
		merchantId: MERCHANT_2,
		domain: 'other.example.com',
		env: 'live',
		status: 'active',
	});
	const db = mongo.db(dbName);
	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ headers?: Record<string, string>, body?: unknown, raw?: string }} [init]
	 */
	const call = async (method, path, { headers = {}, body, raw } = {}) => {
		const response = await portal.handle(
			new Request(`${PORTAL_URL}${path}`, {
				method,
				headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
				...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		const text = await response.text();
		return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null };
	};
	const drain = () => portal.shared.jobs.runBatch({ handlers: portal.modules.jobs, deadlineMs: 20_000 });
	/**
	 * @param {'pk' | 'sk'} kind
	 * @param {{ keyId?: string, websiteId?: string, merchantId?: string, domain?: string, signer?: any, env?: 'live' | 'test' }} [over]
	 */
	const key = async (kind, over = {}) =>
		(
			await issueWebsiteKey({
				signer: over.signer ?? portal.shared.keys.websiteKeySigner,
				kind,
				websiteId: over.websiteId ?? WEBSITE,
				merchantId: over.merchantId ?? MERCHANT,
				domain: over.domain ?? 'shop.example.com',
				env: over.env ?? 'live',
				scopes: [],
				keyId: over.keyId ?? `key_${kind}`,
				now: clock.now,
			})
		).key;
	/**
	 * @param {{ kind: 'staff' | 'merchant', subject: string, merchantId?: string, roles: string[] }} input
	 */
	const login = async (input) => {
		const { token } = await portal.shared.sessions.create({ ...input, mfa: true });
		return `${portal.shared.cookies.name(input.kind)}=${token}`;
	};
	/** @param {string} appId */
	const productAuth = async (appId) => {
		let entry = signers.get(appId);
		if (!entry) {
			const { privateJwk } = await generateSigningKey({ kid: `${appId}-k1` });
			entry = createSigner(privateJwk);
			world.state.appJwks.set(appId, createJwks([toPublicJwk(privateJwk)]));
			signers.set(appId, entry);
		}
		return `Bearer ${await signAssertion({ signer: entry, appId, audience: PORTAL_URL, now: clock.now })}`;
	};
	/** @type {Map<string, any>} */
	const signers = new Map();
	const svc = () =>
		/** @type {import('../../../src/modules/integration/service.js').IntegrationService} */ (
			portal.modules.service('integration')
		);
	return { world, clock, portal, receiver, call, drain, key, login, productAuth, db, entries, svc };
};

/**
 * @param {Record<string, unknown>} [over]
 */
const pageViewed = (over = {}) => {
	const id = createId('evt');
	return {
		id,
		type: 'page.viewed@1',
		websiteId: WEBSITE,
		env: 'live',
		occurredAt: '2026-10-01T09:59:00.000Z',
		idempotencyKey: id,
		actor: { type: 'anonymous', id: 'anon_1' },
		data: { url: `${SHOP}/p?m=${MARKER}`, path: '/p', title: MARKER },
		...over,
	};
};

/**
 * @param {Record<string, unknown>} [over]
 */
const orderCompleted = (over = {}) => pageViewed({ type: 'order.completed@1', data: { orderId: `ord-${MARKER}` }, ...over });

/**
 * Standard catalogue of apps used by most tests.
 * @param {ReturnType<typeof createWorld>} world
 * @param {string} base receiver base URL
 */
const seedApps = (world, base) => {
	const endpoints = (/** @type {string} */ name) => ({ base: `${base}/${name}`, events: '/.well-known/ss-events' });
	world.addApp({
		appId: 'app_pages',
		slug: 'pages',
		consumes: ['page.viewed@1'],
		scopes: ['events.subscribe:page.*'],
		endpoints: endpoints('pages'),
	});
	world.addApp({
		appId: 'app_any',
		slug: 'anything',
		consumes: ['page.*', 'order.*'],
		scopes: ['events.subscribe:*'],
		endpoints: endpoints('any'),
	});
	world.addApp({
		appId: 'app_v2',
		slug: 'vtwo',
		consumes: ['page.viewed@2'],
		scopes: ['events.subscribe:page.*'],
		endpoints: endpoints('v2'),
	});
	world.addApp({
		appId: 'app_noscope',
		slug: 'noscope',
		consumes: ['page.viewed@1'],
		scopes: [],
		endpoints: endpoints('noscope'),
	});
	world.addApp({
		appId: 'app_paused',
		slug: 'paused',
		consumes: ['page.viewed@1'],
		scopes: ['events.subscribe:*'],
		endpoints: endpoints('paused'),
	});
	world.addApp({
		appId: 'app_retired',
		slug: 'retired',
		status: 'retired',
		consumes: ['page.viewed@1'],
		scopes: ['events.subscribe:*'],
		endpoints: endpoints('retired'),
	});
	world.addApp({ appId: 'app_pack', slug: 'pack', kind: 'pack', consumes: ['page.viewed@1'], scopes: ['events.subscribe:*'] });
	world.addApp({
		appId: 'app_orders',
		slug: 'orders',
		consumes: ['order.completed@1'],
		publishes: ['orders.synced@1', 'order.completed@1'],
		scopes: ['events.subscribe:order.*', 'events.publish:order.*'],
		endpoints: endpoints('orders'),
	});
	world.addApp({
		appId: 'app_other_site',
		slug: 'other',
		consumes: ['page.viewed@1'],
		scopes: ['events.subscribe:*'],
		endpoints: endpoints('other'),
	});
	for (const appId of ['app_pages', 'app_any', 'app_v2', 'app_noscope', 'app_retired', 'app_pack', 'app_orders'])
		world.subscribe(WEBSITE, appId);
	world.subscribe(WEBSITE, 'app_paused', 'paused');
	world.subscribe(WEBSITE, 'app_unknown');
	world.subscribe(WEBSITE_2, 'app_other_site');
};

/**
 * Every value in a document tree (to assert payloads never leak into collections).
 * @param {unknown} value
 * @param {string[]} [keys]
 */
const keysOf = (value, keys = []) => {
	if (Array.isArray(value)) for (const v of value) keysOf(v, keys);
	else if (value && typeof value === 'object' && !(value instanceof Date)) {
		for (const [k, v] of Object.entries(value)) {
			keys.push(k);
			keysOf(v, keys);
		}
	}
	return keys;
};

describe('Event Hub ingest', () => {
	it('accepts header-authenticated events, fans out by manifest and delivers signed events', async () => {
		const { world, receiver, call, drain, key, db, svc } = await boot('int_fanout');
		seedApps(world, receiver.base);
		const pk = await key('pk');
		const a = pageViewed();
		const b = pageViewed({ type: 'page.viewed@2' });
		const res = await call('POST', '/v1/events', {
			headers: { authorization: `Bearer ${pk}`, origin: SHOP, 'ss-identity': 'site-token' },
			body: { events: [a, b] },
		});
		expect(res.status).toBe(202);
		expect(res.headers.get('access-control-allow-origin')).toBe(SHOP);
		expect(res.json.results[0]).toEqual({ id: a.id, idempotencyKey: a.id, status: 'accepted' });
		// page.viewed@2 is not catalogued in contracts v1
		expect(res.json.results[1]).toMatchObject({ status: 'rejected', reason: 'invalid_event' });
		expect(res.json.accepted).toBe(1);

		const stats = await drain();
		expect(stats).toMatchObject({ succeeded: 2, retried: 0, dead: 0 });
		const paths = receiver.received.map((r) => r.path).sort();
		expect(paths).toEqual(['/any/.well-known/ss-events', '/pages/.well-known/ss-events']);
		expect(receiver.received.every((r) => r.verified)).toBe(true);
		// F.16: the Event Hub stamps the verified key kind
		expect(receiver.received[0]?.event).toEqual({ ...a, context: { keyKind: 'pk' } });
		expect(receiver.received[0]?.headers['ss-signature'].split(',').length).toBe(2); // dual-signed (2 Portal keys)

		const record = await db.collection('integration_events').findOne({ eventId: a.id });
		expect(record).toMatchObject({
			type: 'page.viewed@1',
			websiteId: WEBSITE,
			merchantId: MERCHANT,
			env: 'live',
			source: 'website',
			fanout: 'done',
			deliveries: { total: 2, delivered: 2, dead: 0 },
		});

		const log = await svc().deliveryLog({ websiteId: WEBSITE });
		expect(log.items.map((i) => i.status)).toEqual(['delivered', 'delivered']);
		expect(log.items[0]).toMatchObject({ eventId: a.id, attempts: 1, lastHttpStatus: 200, kind: 'event' });
		expect(await svc().metrics({ websiteId: WEBSITE })).toEqual({
			deliveries: { pending: 0, retrying: 0, delivered: 2, dead: 0 },
			deadLetters: 0,
		});
		// redelivering the same job is a no-op
		expect(await drain()).toMatchObject({ leased: 0 });
	});

	it('delivers an ingested event right after the response, without any cron (F.19)', async () => {
		/** @type {Array<() => Promise<unknown>>} */
		const after = [];
		const run = async () => {
			while (after.length > 0) await after.shift()?.();
		};
		const { world, receiver, call, drain, key } = await boot('int_immediate', {
			background: { mode: 'on', fallback: (/** @type {any} */ task) => void after.push(task) },
		});
		seedApps(world, receiver.base);
		const pk = await key('pk');
		const a = pageViewed();
		const headers = { authorization: `Bearer ${pk}`, origin: SHOP };
		expect((await call('POST', '/v1/events', { headers, body: { events: [a] } })).status).toBe(202);
		expect(receiver.received).toHaveLength(0); // nothing during the request
		expect(after).toHaveLength(1);
		await run();
		expect(receiver.received).toHaveLength(2);
		expect(await drain()).toMatchObject({ leased: 0 }); // nothing left for the queue
		// a duplicate enqueues nothing, so nothing is delivered again
		await call('POST', '/v1/events', { headers, body: { events: [a] } });
		await run();
		expect(receiver.received).toHaveLength(2);
	});

	it('retries a failed delivery when the target product next calls the Portal, or on "Retry now"', async () => {
		/** @type {Array<() => Promise<unknown>>} */
		const after = [];
		const run = async () => {
			while (after.length > 0) await after.shift()?.();
		};
		const { world, receiver, call, key, clock, db, productAuth, login } = await boot('int_natural_retry', {
			background: { mode: 'on', fallback: (/** @type {any} */ task) => void after.push(task) },
		});
		seedApps(world, receiver.base);
		receiver.respond((path) => (path.startsWith('/pages') ? 500 : 200));
		const sk = await key('sk');
		await call('POST', '/v1/events', { headers: { authorization: `Bearer ${sk}` }, body: { events: [pageViewed()] } });
		await run();
		const pagesHits = () => receiver.received.filter((r) => r.path.startsWith('/pages')).length;
		expect(pagesHits()).toBe(1);
		expect(await db.collection('integration_deliveries').findOne({ appId: 'app_pages' })).toMatchObject({ status: 'retrying' });
		// time passing does nothing by itself
		clock.advance(10 * 60_000);
		expect(pagesHits()).toBe(1);
		// another product calling the Portal does not touch app_pages' queue
		receiver.respond(() => 200);
		await call('GET', '/v1/product/deliveries', { headers: { authorization: await productAuth('app_orders') } });
		await run();
		expect(pagesHits()).toBe(1);
		// app_pages calls the Portal (any product API): its due delivery is retried right after
		const res = await call('GET', '/v1/product/deliveries', { headers: { authorization: await productAuth('app_pages') } });
		expect(res.status).toBe(200);
		await run();
		expect(pagesHits()).toBe(2);
		expect(await db.collection('integration_deliveries').findOne({ appId: 'app_pages' })).toMatchObject({
			status: 'delivered',
		});

		// staff "Retry now": a delivery still waiting for its backoff is sent at once
		receiver.respond((path) => (path.startsWith('/pages') ? 500 : 200));
		await call('POST', '/v1/events', { headers: { authorization: `Bearer ${sk}` }, body: { events: [pageViewed()] } });
		await run();
		expect(pagesHits()).toBe(3);
		receiver.respond(() => 200);
		clock.advance(1_000); // a fresh signature timestamp (the receiver refuses replays)
		const admin = await login({ kind: 'staff', subject: 'stf_admin', roles: ['admin'] });
		const retried = await call('POST', '/v1/admin/apps/app_pages/deliveries/retry', {
			headers: { cookie: admin, ...SAME_ORIGIN },
		});
		expect(retried.status).toBe(200);
		expect(retried.json).toMatchObject({ appId: 'app_pages', succeeded: 1 });
		expect(pagesHits()).toBe(4);
		expect(await db.collection('platform_audit').countDocuments({ action: 'integration.deliveries_retried' })).toBe(1);
	});

	it('accepts body authentication (sendBeacon text/plain) and enforces the origin for pk_', async () => {
		const { world, receiver, call, key } = await boot('int_beacon');
		seedApps(world, receiver.base);
		const pk = await key('pk');
		const beacon = (/** @type {Record<string, unknown>} */ body, /** @type {Record<string, string>} */ headers = {}) =>
			call('POST', '/v1/events', {
				headers: { 'content-type': 'text/plain;charset=UTF-8', ...headers },
				raw: JSON.stringify(body),
			});
		const ok = await beacon({ key: pk, identity: 'tok', events: [pageViewed()] }, { origin: SHOP });
		expect(ok.status).toBe(202);
		expect(ok.json.accepted).toBe(1);
		// Referer is used when Origin is absent
		expect((await beacon({ key: pk, events: [pageViewed()] }, { referer: `${SHOP}/checkout` })).status).toBe(202);
		const wrong = await beacon({ key: pk, events: [pageViewed()] }, { origin: 'https://evil.example.net' });
		expect([wrong.status, wrong.json.type.split('/').pop()]).toEqual([403, 'origin_not_allowed']);
		expect((await beacon({ key: pk, events: [pageViewed()] })).status).toBe(403); // no origin at all
		expect((await beacon({ key: pk, events: [pageViewed()] }, { origin: 'http://shop.example.com' })).status).toBe(403);
		// header path: same origin rules
		expect(
			(
				await call('POST', '/v1/events', {
					headers: { authorization: `Bearer ${pk}`, origin: 'https://evil.example.net' },
					body: { events: [pageViewed()] },
				})
			).status,
		).toBe(403);
		// sk_ keys are server-side: no origin needed
		const sk = await key('sk');
		expect((await beacon({ key: sk, events: [pageViewed()] })).status).toBe(202);
		// garbage, forged, revoked and other-website keys
		expect((await beacon({ key: 'nope', events: [pageViewed()] })).status).toBe(401);
		expect((await beacon({ key: 'pk_live_abc', events: [pageViewed()] }, { origin: SHOP })).status).toBe(401);
		const { privateJwk } = await generateSigningKey({ kid: 'portal-2026-10' });
		const forged = await key('pk', { signer: createSigner(privateJwk) });
		expect((await beacon({ key: forged, events: [pageViewed()] }, { origin: SHOP })).status).toBe(401);
		world.state.revoked.add('key_pk');
		const revoked = await beacon({ key: pk, events: [pageViewed()] }, { origin: SHOP });
		expect([revoked.status, revoked.json.detail]).toEqual([401, 'The website key is revoked.']);
		const header = await call('POST', '/v1/events', {
			headers: { authorization: `Bearer ${pk}`, origin: SHOP },
			body: { events: [pageViewed()] },
		});
		expect(header.status).toBe(401);
		// an event for another website with this site's key
		const other = await beacon({ key: sk, events: [pageViewed({ websiteId: WEBSITE_2 })] });
		expect(other.json.results[0]).toMatchObject({ status: 'rejected', reason: 'website_mismatch' });
		// the revocation check failing closes the door
		world.state.failures.revocation = true;
		expect((await beacon({ key: sk, events: [pageViewed()] })).status).toBe(500);
	});

	it('fails closed without identity (no revocation check)', async () => {
		const { call, key } = await boot('int_noident', { withoutIdentity: true });
		const sk = await key('sk');
		const res = await call('POST', '/v1/events', {
			headers: { authorization: `Bearer ${sk}` },
			body: { events: [pageViewed()] },
		});
		expect([res.status, res.headers.get('retry-after')]).toEqual([503, '30']);
	});

	it('validates requests and envelopes', async () => {
		const { world, receiver, call, key } = await boot('int_validate');
		seedApps(world, receiver.base);
		const sk = await key('sk');
		const auth = { authorization: `Bearer ${sk}` };
		const post = (/** @type {unknown} */ body, /** @type {Record<string, string>} */ headers = {}) =>
			call('POST', '/v1/events', { headers: { ...auth, ...headers }, body });
		expect((await post({ events: [] })).status).toBe(400);
		expect((await post({ nope: [] })).status).toBe(400);
		expect((await post({ events: Array.from({ length: 101 }, () => pageViewed()) })).status).toBe(413);
		const big = Array.from({ length: 40 }, () =>
			pageViewed({ data: { url: `${SHOP}/x`, path: '/x', title: 'x'.repeat(500) }, context: { userAgent: 'u'.repeat(500) } }),
		);
		expect((await post({ events: big.map((e) => ({ ...e, pad: 'p'.repeat(6000) })) })).status).toBe(413);
		const huge = await call('POST', '/v1/events', { headers: auth, raw: 'x'.repeat(300 * 1024) });
		expect(huge.status).toBe(413);
		expect(
			(await call('POST', '/v1/events', { headers: { ...auth, 'content-type': 'application/xml' }, raw: '{}' })).status,
		).toBe(415);
		expect(
			(await call('POST', '/v1/events', { headers: { ...auth, 'content-type': 'application/json' }, raw: '{' })).status,
		).toBe(400);
		expect(
			(
				await call('POST', '/v1/events', {
					headers: { authorization: 'Basic x', 'content-type': 'application/json' },
					raw: JSON.stringify({ events: [pageViewed()] }),
				})
			).status,
		).toBe(401);

		const good = pageViewed();
		const res = await post({
			events: [
				good,
				{ ...pageViewed(), id: 42 },
				{ ...pageViewed(), extra: true },
				pageViewed({ env: 'test' }),
				pageViewed({
					type: 'subscription.paused@1',
					data: { subscriptionId: 'sub_0123456789abcdefghjkmnpq', websiteId: WEBSITE },
				}),
				pageViewed({ data: { path: 'no-slash', url: SHOP } }),
				'not an object',
				pageViewed({ actor: { type: 'product' } }),
			],
		});
		expect(res.status).toBe(202);
		expect(res.json.results.map((/** @type {any} */ r) => r.reason ?? r.status)).toEqual([
			'accepted',
			'invalid_event',
			'invalid_event',
			'env_mismatch',
			'control_event',
			'invalid_event',
			'invalid_event',
			'actor_not_allowed',
		]);
		expect(res.json.results[1]).toMatchObject({ id: null, errors: expect.any(Array) });
		// CORS preflight is answered for browsers
		const pre = await portal(call)('OPTIONS', '/v1/events', SHOP);
		expect(pre.status).toBe(204);
	});

	it('deduplicates on (websiteId, idempotencyKey), within a batch, across requests and under races', async () => {
		const { world, receiver, call, drain, key, db } = await boot('int_dedupe');
		seedApps(world, receiver.base);
		const sk = await key('sk');
		const auth = { authorization: `Bearer ${sk}` };
		const e = pageViewed({ idempotencyKey: 'order:1:placed' });
		const first = await call('POST', '/v1/events', { headers: auth, body: { events: [e, { ...e, id: createId('evt') }] } });
		expect(first.json.results.map((/** @type {any} */ r) => r.status)).toEqual(['accepted', 'duplicate']);
		const again = await call('POST', '/v1/events', { headers: auth, body: { events: [e] } });
		expect(again.json.results[0].status).toBe('duplicate');

		const race = pageViewed();
		const all = await Promise.all(
			Array.from({ length: 6 }, () => call('POST', '/v1/events', { headers: auth, body: { events: [race] } })),
		);
		const statuses = all.map((r) => r.json.results[0].status).sort();
		expect(statuses.filter((s) => s === 'accepted')).toHaveLength(1);
		expect(statuses.filter((s) => s === 'duplicate')).toHaveLength(5);
		expect(await db.collection('integration_events').countDocuments({ eventId: race.id })).toBe(1);
		expect(await db.collection('integration_deliveries').countDocuments({ eventId: race.id })).toBe(2);
		expect(await db.collection('platform_jobs').countDocuments({ key: { $regex: race.id } })).toBe(2);
		await drain();
		expect(receiver.received.filter((r) => r.event?.id === race.id)).toHaveLength(2);
		// the same idempotency key on another website is a different event
		const sk2 = await key('sk', { websiteId: WEBSITE_2, merchantId: MERCHANT_2, keyId: 'key_sk2' });
		const other = await call('POST', '/v1/events', {
			headers: { authorization: `Bearer ${sk2}` },
			body: { events: [{ ...e, websiteId: WEBSITE_2 }] },
		});
		expect(other.json.results[0].status).toBe('accepted');
	});

	it('resumes an interrupted fan-out on a duplicate', async () => {
		const { world, receiver, drain, db, svc } = await boot('int_resume');
		seedApps(world, receiver.base);
		const e = pageViewed();
		// simulate a crash after the routing record was written
		await db.collection('integration_events').insertOne({
			_id: /** @type {any} */ ('iev_crashed'),
			eventId: e.id,
			type: e.type,
			websiteId: WEBSITE,
			merchantId: MERCHANT,
			env: 'live',
			source: 'website',
			idempotencyKey: e.idempotencyKey,
			receivedAt: new Date(),
			fanout: 'pending',
			deliveries: { total: 0, delivered: 0, dead: 0 },
		});
		const out = await svc().ingest({
			website: { websiteId: WEBSITE, merchantId: MERCHANT, env: 'live', kind: 'sk' },
			events: [e],
		});
		expect(out.results[0]?.status).toBe('duplicate');
		expect(await db.collection('integration_events').findOne({ _id: /** @type {any} */ ('iev_crashed') })).toMatchObject({
			fanout: 'done',
			deliveries: { total: 2 },
		});
		await drain();
		expect(receiver.received.filter((r) => r.event?.id === e.id)).toHaveLength(2);
	});

	it('answers 503 when routing dependencies are down', async () => {
		const { world, receiver, call, key } = await boot('int_down');
		seedApps(world, receiver.base);
		const sk = await key('sk');
		const post = () =>
			call('POST', '/v1/events', { headers: { authorization: `Bearer ${sk}` }, body: { events: [pageViewed()] } });
		world.state.failures.commerce = true;
		expect((await post()).status).toBe(503);
		world.state.failures.commerce = false;
		world.state.failures.catalog = true;
		const res = await post();
		expect([res.status, res.headers.get('retry-after')]).toEqual([503, '5']);
		world.state.failures.catalog = false;
		expect((await post()).status).toBe(202);
	});

	it('caches routing tables per website', async () => {
		const { world, receiver, svc } = await boot('int_cache', { options: { routingCacheMs: 60_000 } });
		seedApps(world, receiver.base);
		const website = /** @type {const} */ ({ websiteId: WEBSITE, merchantId: MERCHANT, env: 'live', kind: 'sk' });
		await svc().ingest({ website, events: [pageViewed()] });
		await svc().ingest({ website, events: [pageViewed()] });
		expect(world.state.calls.subscriptionsForWebsite).toBe(1);
		await expect(svc().ingest({ website, events: 'x' })).rejects.toMatchObject({ code: 'bad_request' });
	});
});

/**
 * Helper for raw OPTIONS calls.
 * @param {any} call
 */
const portal = (call) => (/** @type {string} */ method, /** @type {string} */ path, /** @type {string} */ origin) =>
	call(method, path, { headers: { origin, 'access-control-request-method': 'POST' } });

describe('delivery pipeline', () => {
	it('retries with backoff, dead-letters with a sealed payload and replays', async () => {
		const { world, receiver, call, drain, key, clock, db, login } = await boot('int_retry', { options: { maxAttempts: 3 } });
		seedApps(world, receiver.base);
		receiver.respond((path) => (path.startsWith('/pages') ? 500 : 200));
		const sk = await key('sk');
		const e = pageViewed();
		await call('POST', '/v1/events', { headers: { authorization: `Bearer ${sk}` }, body: { events: [e] } });
		expect(await drain()).toMatchObject({ succeeded: 1, retried: 1 });
		const pages = await db.collection('integration_deliveries').findOne({ appId: 'app_pages' });
		expect(pages).toMatchObject({ status: 'retrying', attempts: 1, lastErrorCode: 'http_500', lastHttpStatus: 500 });
		const job = await db.collection('platform_jobs').findOne({ key: { $regex: 'app_pages' } });
		expect(job?.runAt.getTime()).toBeGreaterThan(clock.now()); // backoff
		expect(await drain()).toMatchObject({ leased: 0 }); // not due yet
		clock.advance(10 * 60_000);
		expect(await drain()).toMatchObject({ retried: 1 });
		clock.advance(10 * 60_000);
		expect(await drain()).toMatchObject({ succeeded: 1 }); // last attempt → DLQ, job completes
		const dead = await db.collection('integration_deliveries').findOne({ appId: 'app_pages' });
		expect(dead).toMatchObject({ status: 'dead', attempts: 3, lastErrorCode: 'http_500' });
		const letter = await db.collection('integration_dead_letters').findOne({ _id: /** @type {any} */ (dead?._id) });
		expect(letter?.sealed).toMatch(/^ssenc1\./);
		expect(letter?.expireAt.getTime()).toBe(clock.now() + 7 * 24 * 60 * 60_000);
		expect(JSON.stringify(letter)).not.toContain(MARKER);
		expect((await db.collection('integration_events').findOne({ eventId: e.id }))?.deliveries).toEqual({
			total: 2,
			delivered: 1,
			dead: 1,
		});

		const admin = await login({ kind: 'staff', subject: 'stf_admin', roles: ['admin'] });
		const support = await login({ kind: 'staff', subject: 'stf_support', roles: ['support'] });
		const list = await call('GET', '/v1/admin/dead-letters', { headers: { cookie: support } });
		expect(list.status).toBe(200);
		expect(list.json.items).toEqual([
			expect.objectContaining({ deliveryId: dead?._id, appId: 'app_pages', lastErrorCode: 'http_500', attempts: 3 }),
		]);
		expect(JSON.stringify(list.json)).not.toContain('ssenc1');
		expect((await call('GET', '/v1/admin/integration/metrics', { headers: { cookie: support } })).json).toEqual({
			deliveries: { pending: 0, retrying: 0, delivered: 1, dead: 1 },
			deadLetters: 1,
		});
		// support cannot replay; admin can
		const replayPath = `/v1/admin/deliveries/${dead?._id}/replay`;
		const idem = (/** @type {string} */ k) => ({ ...SAME_ORIGIN, 'idempotency-key': k });
		expect((await call('POST', replayPath, { headers: { cookie: support, ...idem('r0') } })).status).toBe(403);
		receiver.respond(() => 200);
		const replayed = await call('POST', replayPath, { headers: { cookie: admin, ...idem('r1') } });
		expect([replayed.status, replayed.json]).toEqual([200, { deliveryId: dead?._id, status: 'pending', replays: 1 }]);
		expect(await db.collection('integration_dead_letters').countDocuments({})).toBe(0);
		expect((await call('POST', replayPath, { headers: { cookie: admin, ...idem('r2') } })).status).toBe(409);
		clock.advance(1_000);
		expect(await drain()).toMatchObject({ succeeded: 1 });
		expect(await db.collection('integration_deliveries').findOne({ _id: /** @type {any} */ (dead?._id) })).toMatchObject({
			status: 'delivered',
			attempts: 4,
			replays: 1,
		});
		expect((await db.collection('integration_events').findOne({ eventId: e.id }))?.deliveries).toEqual({
			total: 2,
			delivered: 2,
			dead: 0,
		});
		const audit = await db.collection('platform_audit').findOne({ action: 'integration.delivery_replayed' });
		expect(audit).toMatchObject({ actor: { type: 'staff', id: 'stf_admin' }, target: { type: 'delivery', id: dead?._id } });
		expect(
			(await call('POST', '/v1/admin/deliveries/dlv_missing/replay', { headers: { cookie: admin, ...idem('r3') } })).status,
		).toBe(404);
		expect(receiver.received.filter((r) => r.path.startsWith('/pages')).every((r) => r.verified)).toBe(true);
	});

	it('refuses to replay an expired DLQ payload and keeps the first expiry', async () => {
		const { world, receiver, call, drain, key, clock, db, svc } = await boot('int_expired', { options: { maxAttempts: 1 } });
		seedApps(world, receiver.base);
		receiver.respond(() => 503);
		const sk = await key('sk');
		await call('POST', '/v1/events', { headers: { authorization: `Bearer ${sk}` }, body: { events: [pageViewed()] } });
		await drain();
		const [dead] = await db.collection('integration_deliveries').find({ status: 'dead' }).toArray();
		const firstExpiry = /** @type {any} */ (dead).payloadExpiresAt;
		const actor = /** @type {any} */ ({ type: 'staff', id: 'stf_admin', roles: ['admin'] });
		await svc().replay(String(dead?._id), { actor });
		clock.advance(60_000);
		await drain();
		const again = await db.collection('integration_dead_letters').findOne({ _id: /** @type {any} */ (dead?._id) });
		expect(again?.expireAt.getTime()).toBe(firstExpiry.getTime());
		clock.advance(8 * 24 * 60 * 60_000);
		await expect(svc().replay(String(dead?._id), { actor })).rejects.toMatchObject({ code: 'gone' });
		await expect(svc().replay(String(dead?._id), { actor, websiteId: WEBSITE_2 })).rejects.toMatchObject({ code: 'not_found' });
	});

	it('delivers to the registered environment (staging for test websites), never the manifest base', async () => {
		const { world, receiver, call, drain, key, db } = await boot('int_targets');
		const TEST_SITE = 'web_2123456789abcdefghjkmnpq';
		world.state.websites.set(TEST_SITE, {
			websiteId: TEST_SITE,
			merchantId: MERCHANT,
			domain: 'test.example.com',
			env: 'test',
			status: 'active',
		});
		const events = '/.well-known/ss-events';
		const common = { consumes: ['page.viewed@1'], scopes: ['events.subscribe:*'] };
		// the manifest claims another host: deliveries must ignore it
		world.addApp({
			appId: 'app_staged',
			slug: 'staged',
			...common,
			endpoints: { base: 'https://claimed.example.com', events },
			environments: { production: `${receiver.base}/prod`, staging: `${receiver.base}/staging` },
		});
		world.addApp({
			appId: 'app_prodonly',
			slug: 'prodonly',
			...common,
			endpoints: { base: 'https://claimed.example.com', events },
			environments: { production: `${receiver.base}/prodonly` },
		});
		world.addApp({
			appId: 'app_noenv',
			slug: 'noenv',
			...common,
			endpoints: { base: `${receiver.base}/manifest`, events },
			environments: { production: null },
		});
		for (const site of [WEBSITE, TEST_SITE])
			for (const appId of ['app_staged', 'app_prodonly', 'app_noenv']) world.subscribe(site, appId);
		const live = await key('sk');
		const test = await key('sk', { websiteId: TEST_SITE, domain: 'test.example.com', env: 'test', keyId: 'key_test' });
		await call('POST', '/v1/events', { headers: { authorization: `Bearer ${live}` }, body: { events: [pageViewed()] } });
		await call('POST', '/v1/events', {
			headers: { authorization: `Bearer ${test}` },
			body: {
				events: [pageViewed({ websiteId: TEST_SITE, env: 'test', data: { url: 'https://test.example.com/', path: '/' } })],
			},
		});
		await drain();
		const paths = receiver.received.map((r) => `${r.event?.env}:${r.path}`).sort();
		expect(paths).toEqual([
			`live:/prod${events}`,
			`live:/prodonly${events}`,
			`test:/prodonly${events}`, // no staging registered: production
			`test:/staging${events}`,
		]);
		const noenv = await db.collection('integration_deliveries').find({ appId: 'app_noenv' }).toArray();
		expect(noenv.map((d) => [d.status, d.lastErrorCode])).toEqual([
			['dead', 'no_endpoint'],
			['dead', 'no_endpoint'],
		]);
	});

	it('fans out consumed globs (custom.*, order.*@1) end to end', async () => {
		const { world, receiver, call, drain, key } = await boot('int_globs');
		world.addApp({
			appId: 'app_loyalty',
			slug: 'loyalty',
			consumes: ['order.*@1', 'custom.*'],
			scopes: ['events.subscribe:order.*', 'events.subscribe:custom.*'],
			endpoints: { base: `${receiver.base}/loyalty`, events: '/.well-known/ss-events' },
		});
		world.subscribe(WEBSITE, 'app_loyalty');
		const sk = await key('sk');
		const custom = pageViewed({ type: 'custom.review_written@1', data: { stars: 5 } });
		const completed = orderCompleted();
		const paged = pageViewed();
		const res = await call('POST', '/v1/events', {
			headers: { authorization: `Bearer ${sk}` },
			body: { events: [custom, completed, paged] },
		});
		expect(res.json.accepted).toBe(3);
		await drain();
		expect(receiver.received.map((r) => r.event?.type).sort()).toEqual(['custom.review_written@1', 'order.completed@1']);
		expect(receiver.received.every((r) => r.verified)).toBe(true);
	});

	it('times out slow products and refuses unsafe endpoints (SSRF)', async () => {
		const resolve = async (/** @type {string} */ host) =>
			host === 'rebind.example.com'
				? [
						{ address: '93.184.216.34', family: 4 },
						{ address: '10.0.0.7', family: 4 },
					]
				: host === 'meta.example.com'
					? [{ address: '169.254.169.254', family: 4 }]
					: host === 'empty.example.com'
						? []
						: [{ address: '93.184.216.34', family: 4 }];
		const { world, receiver, call, drain, key, db } = await boot('int_ssrf', {
			options: { timeoutMs: 200, resolve, maxAttempts: 2 },
		});
		// redirects are never followed (here: towards the cloud metadata endpoint)
		receiver.respond((path) =>
			path.startsWith('/redirect') ? { status: 307, location: 'https://169.254.169.254/latest/meta-data' } : 'hang',
		);
		/** @type {Array<[string, Record<string, string> | null]>} */
		const apps = [
			['app_slow', { base: `${receiver.base}/slow`, events: '/events' }],
			['app_private', { base: 'https://10.0.0.5', events: '/events' }],
			['app_metadata', { base: 'https://169.254.169.254', events: '/latest' }],
			['app_http', { base: 'http://plain.example.com', events: '/events' }],
			['app_localhost', { base: 'https://localhost:8443', events: '/events' }],
			['app_rebind', { base: 'https://rebind.example.com', events: '/events' }],
			['app_dnsmeta', { base: 'https://meta.example.com', events: '/latest' }],
			['app_redirect', { base: `${receiver.base}/redirect`, events: '/events' }],
			['app_userinfo', { base: 'https://user:pw@app.example.com', events: '/events' }],
			['app_nodns', { base: 'https://empty.example.com', events: '/events' }],
			['app_noendpoint', null],
		];
		for (const [appId, endpoints] of apps) {
			world.addApp({
				appId,
				slug: appId.replace('app_', ''),
				consumes: ['page.viewed@1'],
				scopes: ['events.subscribe:*'],
				endpoints,
			});
			world.subscribe(WEBSITE, appId);
		}
		const sk = await key('sk');
		await call('POST', '/v1/events', { headers: { authorization: `Bearer ${sk}` }, body: { events: [pageViewed()] } });
		await drain();
		const byApp = Object.fromEntries(
			(await db.collection('integration_deliveries').find({}).toArray()).map((d) => [d.appId, [d.status, d.lastErrorCode]]),
		);
		expect(byApp).toEqual({
			app_slow: ['retrying', 'timeout'],
			app_private: ['dead', 'ssrf_blocked'],
			app_metadata: ['dead', 'ssrf_blocked'],
			app_http: ['dead', 'ssrf_blocked'],
			app_localhost: ['dead', 'ssrf_blocked'],
			app_rebind: ['dead', 'ssrf_blocked'],
			app_dnsmeta: ['dead', 'ssrf_blocked'],
			app_redirect: ['retrying', 'http_307'],
			app_userinfo: ['dead', 'ssrf_blocked'],
			app_nodns: ['retrying', 'dns_failed'],
			app_noendpoint: ['dead', 'no_endpoint'],
		});
	});

	it('dead-letters deliveries whose product disappeared and tolerates odd job payloads', async () => {
		const { world, receiver, call, drain, key, db, svc } = await boot('int_gone');
		seedApps(world, receiver.base);
		const sk = await key('sk');
		await call('POST', '/v1/events', { headers: { authorization: `Bearer ${sk}` }, body: { events: [pageViewed()] } });
		world.state.apps.delete('app_pages');
		/** @type {any} */ (world.state.apps.get('app_any')).status = 'retired';
		await drain();
		const codes = (await db.collection('integration_deliveries').find({}).toArray()).map((d) => [d.appId, d.lastErrorCode]);
		expect(Object.fromEntries(codes)).toEqual({ app_pages: 'app_unavailable', app_any: 'app_unavailable' });
		const job = /** @type {any} */ ({ attempts: 1, maxAttempts: 3 });
		expect(await svc().runDelivery(null, { job })).toEqual({ status: 'invalid' });
		expect(await svc().runDelivery({ deliveryId: 'dlv_x', sealed: 's' }, { job })).toEqual({ status: 'skipped' });
		// a tampered payload cannot be opened → DLQ
		const pending = await db.collection('integration_deliveries').insertOne({
			_id: /** @type {any} */ ('dlv_tampered'),
			websiteId: WEBSITE,
			eventId: 'evt_x',
			appId: 'app_orders',
			status: 'pending',
			attempts: 0,
			eventRecordId: 'iev_none',
			createdAt: new Date(),
		});
		void pending;
		expect(await svc().runDelivery({ deliveryId: 'dlv_tampered', sealed: 'ssenc1.x.y.z' }, { job })).toEqual({
			status: 'dead',
			code: 'payload_unavailable',
		});
		world.state.failures.catalog = true;
		await db.collection('integration_deliveries').insertOne({
			_id: /** @type {any} */ ('dlv_catalog'),
			websiteId: WEBSITE,
			eventId: 'evt_y',
			appId: 'app_orders',
			status: 'pending',
			attempts: 0,
			eventRecordId: 'iev_none',
			createdAt: new Date(),
		});
		await expect(svc().runDelivery({ deliveryId: 'dlv_catalog', sealed: 'x' }, { job })).rejects.toMatchObject({
			code: 'catalog_unavailable',
		});
	});

	it('never persists payloads outside the sealed job and DLQ copies', async () => {
		const { world, receiver, call, drain, key, db } = await boot('int_nopayload', { options: { maxAttempts: 1 } });
		seedApps(world, receiver.base);
		receiver.respond((path) => (path.startsWith('/pages') ? 500 : 200));
		const sk = await key('sk');
		await call('POST', '/v1/events', {
			headers: { authorization: `Bearer ${sk}` },
			body: { events: [pageViewed(), orderCompleted()] },
		});
		const jobs = await db.collection('platform_jobs').find({ name: 'integration.deliver' }).toArray();
		expect(jobs.length).toBeGreaterThan(0);
		for (const j of jobs) {
			expect(Object.keys(j.payload).sort()).toEqual(['deliveryId', 'sealed']);
			expect(j.payload.sealed).toMatch(/^ssenc1\./);
		}
		await drain();
		for (const name of [
			'integration_events',
			'integration_deliveries',
			'integration_dead_letters',
			'platform_jobs',
			'platform_idempotency',
		]) {
			const docs = await db.collection(name).find({}).toArray();
			expect(JSON.stringify(docs)).not.toContain(MARKER);
			if (name.startsWith('integration_')) expect(keysOf(docs)).not.toContain('data');
		}
		expect(await db.collection('integration_dead_letters').countDocuments({})).toBe(1);
	});
});

describe('product events', () => {
	it('publishes from a product to the other subscribed products only', async () => {
		const { world, receiver, call, drain, productAuth, db } = await boot('int_product');
		seedApps(world, receiver.base);
		const own = pageViewed({ type: 'orders.synced@1', data: { count: 3 }, actor: { type: 'product', id: 'app_orders' } });
		const standard = orderCompleted({ actor: { type: 'product', id: 'app_orders' } });
		world.addApp({
			appId: 'app_sync',
			slug: 'sync',
			consumes: ['orders.synced@1'],
			scopes: ['events.subscribe:orders.*'],
			endpoints: { base: `${receiver.base}/sync`, events: '/e' },
		});
		world.subscribe(WEBSITE, 'app_sync');
		const res = await call('POST', '/v1/product/events', {
			headers: { authorization: await productAuth('app_orders') },
			body: {
				events: [
					own,
					standard,
					own,
					pageViewed({ type: 'orders.unknown@1', data: {} }),
					pageViewed({ type: 'key.revoked@1', data: { keyIds: ['k'], revokedAt: '2026-10-01T10:00:00.000Z' } }),
					orderCompleted({ websiteId: WEBSITE_2 }),
					orderCompleted({ websiteId: 'web_9999999999abcdefghjkmnpq' }),
					orderCompleted({ env: 'test' }),
				],
			},
		});
		expect(res.status).toBe(202);
		expect(res.json.results.map((/** @type {any} */ r) => r.reason ?? r.status)).toEqual([
			'accepted',
			'accepted',
			'duplicate',
			'not_declared',
			'control_event',
			'not_subscribed',
			'unknown_website',
			'env_mismatch',
		]);
		await drain();
		expect(receiver.received.map((r) => [r.path.split('/')[1], r.event?.type]).sort()).toEqual([
			['any', 'order.completed@1'],
			['sync', 'orders.synced@1'],
		]);
		expect(await db.collection('integration_events').findOne({ eventId: own.id })).toMatchObject({
			source: 'product',
			publisherAppId: 'app_orders',
		});
		// the product reads its own delivery log only
		const sync = await call('GET', '/v1/product/deliveries', { headers: { authorization: await productAuth('app_sync') } });
		expect(sync.json.items.map((/** @type {any} */ i) => i.appId)).toEqual(['app_sync']);
	});

	it('refuses inactive or unknown products and bad batches', async () => {
		const { world, receiver, call, productAuth } = await boot('int_product_bad');
		seedApps(world, receiver.base);
		world.addApp({ appId: 'app_pending', slug: 'pending', status: 'pending' });
		expect(
			(
				await call('POST', '/v1/product/events', {
					headers: { authorization: await productAuth('app_pending') },
					body: { events: [orderCompleted()] },
				})
			).status,
		).toBe(403);
		expect(
			(
				await call('POST', '/v1/product/events', {
					headers: { authorization: await productAuth('app_ghost') },
					body: { events: [orderCompleted()] },
				})
			).status,
		).toBe(403);
		expect(
			(
				await call('POST', '/v1/product/events', {
					headers: { authorization: await productAuth('app_orders') },
					body: { events: [] },
				})
			).status,
		).toBe(400);
		expect(
			(await call('POST', '/v1/product/events', { headers: { authorization: await productAuth('app_orders') }, body: [] }))
				.status,
		).toBe(400);
		world.state.failures.catalog = true;
		expect(
			(
				await call('POST', '/v1/product/events', {
					headers: { authorization: await productAuth('app_orders') },
					body: { events: [orderCompleted()] },
				})
			).status,
		).toBe(503);
		world.state.failures.catalog = false;
		world.state.manifests.delete('app_orders');
		world.state.manifests.set('app_orders', null);
		expect(
			(
				await call('POST', '/v1/product/events', {
					headers: { authorization: await productAuth('app_orders') },
					body: { events: [orderCompleted()] },
				})
			).status,
		).toBe(403);
		expect((await call('POST', '/v1/product/events', { body: { events: [orderCompleted()] } })).status).toBe(401);
	});
});

describe('control events', () => {
	it('delivers to targeted apps or to every subscribed app of a website', async () => {
		const { world, receiver, drain, svc, db } = await boot('int_control');
		seedApps(world, receiver.base);
		const revokedAt = '2026-10-01T10:00:00.000Z';
		const toApps = await svc().emitControl(
			'key.revoked@1',
			{ keyIds: ['key_pk'], revokedAt },
			{ appIds: ['app_orders', 'app_orders'], websiteId: WEBSITE },
		);
		expect(toApps).toMatchObject({ websiteId: WEBSITE, deliveries: 1, appIds: ['app_orders'] });
		const site = await svc().emitControl(
			'resource.changed@1',
			{ websiteId: WEBSITE, kind: 'database', status: 'connected', ref: 'con_1' },
			{ websiteId: WEBSITE },
		);
		// every non-cancelled subscription, whether or not it lists the type in events.consumes
		expect(site.appIds.sort()).toEqual(
			[
				'app_any',
				'app_noscope',
				'app_orders',
				'app_pack',
				'app_pages',
				'app_paused',
				'app_retired',
				'app_unknown',
				'app_v2',
			].sort(),
		);
		const platform = await svc().emitControl(
			'manifest.accepted@1',
			{ appId: 'app_pages', version: '1.2.0' },
			{ appIds: ['app_pages'] },
		);
		expect(platform.websiteId).toBeNull();
		await drain();
		const got = receiver.received.filter((r) => r.verified).map((r) => [r.path.split('/')[1], r.event.type]);
		expect(got).toEqual(
			expect.arrayContaining([
				['orders', 'key.revoked@1'],
				['pages', 'resource.changed@1'],
				['paused', 'resource.changed@1'],
				['pages', 'manifest.accepted@1'],
			]),
		);
		const manifestEvent = receiver.received.find((r) => r.event?.type === 'manifest.accepted@1')?.event;
		expect(manifestEvent).not.toHaveProperty('websiteId');
		expect(manifestEvent).toMatchObject({
			scope: 'platform',
			env: 'test',
			actor: { type: 'system' },
			context: { source: 'portal' },
		});
		const dead = await db.collection('integration_deliveries').find({ status: 'dead' }).toArray();
		expect(dead.map((d) => [d.appId, d.lastErrorCode]).sort()).toEqual([
			['app_pack', 'app_unavailable'],
			['app_retired', 'app_unavailable'],
			['app_unknown', 'app_unavailable'],
		]);
		expect((await db.collection('integration_deliveries').findOne({ appId: 'app_orders', type: 'key.revoked@1' }))?.kind).toBe(
			'control',
		);
	});

	it('validates control events', async () => {
		const { svc } = await boot('int_control_bad');
		await expect(svc().emitControl('page.viewed@1', {}, { appIds: ['a'] })).rejects.toMatchObject({
			code: 'validation_failed',
		});
		await expect(svc().emitControl('manifest.accepted@1', { appId: 'a' }, { appIds: ['a'] })).rejects.toMatchObject({
			code: 'validation_failed',
			errors: expect.any(Array),
		});
		await expect(svc().emitControl('manifest.accepted@1', { appId: 'a', version: '1.0.0' })).rejects.toMatchObject({
			code: 'validation_failed',
		});
		// platform-scoped events never target a website; website-scoped ones always do
		await expect(
			svc().emitControl('manifest.accepted@1', { appId: 'a', version: '1.0.0' }, { appIds: ['a'], websiteId: WEBSITE }),
		).rejects.toMatchObject({ code: 'validation_failed' });
		await expect(
			svc().emitControl('key.revoked@1', { keyIds: ['k'], revokedAt: '2026-10-01T10:00:00.000Z' }, { appIds: ['a'] }),
		).rejects.toMatchObject({ code: 'validation_failed' });
		await expect(
			svc().emitControl('manifest.accepted@1', { appId: 'a', version: '1.0.0' }, { appIds: [''] }),
		).rejects.toMatchObject({
			code: 'validation_failed',
		});
		await expect(
			svc().emitControl(
				'key.revoked@1',
				{ keyIds: ['k'], revokedAt: '2026-10-01T10:00:00.000Z' },
				{ websiteId: 'web_9999999999abcdefghjkmnpq' },
			),
		).rejects.toMatchObject({ code: 'not_found' });
	});
});

describe('delivery logs', () => {
	it('isolates tenants and paginates', async () => {
		const { world, receiver, call, drain, key, login, productAuth } = await boot('int_logs');
		seedApps(world, receiver.base);
		const sk = await key('sk');
		const sk2 = await key('sk', { websiteId: WEBSITE_2, merchantId: MERCHANT_2, keyId: 'key_sk2' });
		await call('POST', '/v1/events', {
			headers: { authorization: `Bearer ${sk}` },
			body: { events: [pageViewed(), pageViewed(), pageViewed()] },
		});
		await call('POST', '/v1/events', {
			headers: { authorization: `Bearer ${sk2}` },
			body: { events: [pageViewed({ websiteId: WEBSITE_2 })] },
		});
		await drain();
		const owner = await login({ kind: 'merchant', subject: 'usr_a', merchantId: MERCHANT, roles: ['owner'] });
		const ownPath = `/v1/merchants/${MERCHANT}/websites/${WEBSITE}/deliveries`;
		const page1 = await call('GET', `${ownPath}?limit=4`, { headers: { cookie: owner } });
		expect(page1.status).toBe(200);
		expect(page1.json).toMatchObject({ hasMore: true, nextCursor: expect.any(String) });
		expect(page1.json.items).toHaveLength(4);
		const page2 = await call('GET', `${ownPath}?limit=4&cursor=${page1.json.nextCursor}`, { headers: { cookie: owner } });
		expect(page2.json).toMatchObject({ hasMore: false, nextCursor: null });
		expect(page2.json.items).toHaveLength(2);
		const ids = [...page1.json.items, ...page2.json.items].map((/** @type {any} */ i) => i.deliveryId);
		expect(new Set(ids).size).toBe(6);
		expect(JSON.stringify(page1.json)).not.toContain(MARKER);
		expect((await call('GET', `${ownPath}?status=delivered&limit=1`, { headers: { cookie: owner } })).json.items).toHaveLength(
			1,
		);
		expect((await call('GET', `${ownPath}?status=bogus`, { headers: { cookie: owner } })).status).toBe(400);
		expect((await call('GET', `${ownPath}?cursor=***`, { headers: { cookie: owner } })).status).toBe(400);
		expect((await call('GET', `${ownPath}?limit=0`, { headers: { cookie: owner } })).status).toBe(400);
		// another merchant's website under my merchant id → 404; under theirs → 403
		expect(
			(await call('GET', `/v1/merchants/${MERCHANT}/websites/${WEBSITE_2}/deliveries`, { headers: { cookie: owner } })).status,
		).toBe(404);
		expect(
			(await call('GET', `/v1/merchants/${MERCHANT_2}/websites/${WEBSITE_2}/deliveries`, { headers: { cookie: owner } }))
				.status,
		).toBe(403);
		expect(
			(
				await call('GET', `/v1/merchants/${MERCHANT}/websites/web_9999999999abcdefghjkmnpq/deliveries`, {
					headers: { cookie: owner },
				})
			).status,
		).toBe(404);
		// merchant replay of another merchant's delivery is refused
		const other = await login({ kind: 'merchant', subject: 'usr_b', merchantId: MERCHANT_2, roles: ['owner'] });
		const theirs = (
			await call('GET', `/v1/merchants/${MERCHANT_2}/websites/${WEBSITE_2}/deliveries`, { headers: { cookie: other } })
		).json.items;
		expect(theirs).toHaveLength(1);
		const crossReplay = await call(
			'POST',
			`/v1/merchants/${MERCHANT}/websites/${WEBSITE}/deliveries/${theirs[0].deliveryId}/replay`,
			{
				headers: { cookie: owner, ...SAME_ORIGIN, 'idempotency-key': 'x1' },
			},
		);
		expect(crossReplay.status).toBe(404);
		const notDead = await call(
			'POST',
			`/v1/merchants/${MERCHANT_2}/websites/${WEBSITE_2}/deliveries/${theirs[0].deliveryId}/replay`,
			{
				headers: { cookie: other, ...SAME_ORIGIN, 'idempotency-key': 'x2' },
			},
		);
		expect(notDead.status).toBe(409);
		// staff see everything; products only their own app
		const support = await login({ kind: 'staff', subject: 'stf_s', roles: ['support'] });
		expect(
			(await call('GET', `/v1/admin/deliveries?websiteId=${WEBSITE_2}`, { headers: { cookie: support } })).json.items,
		).toHaveLength(1);
		expect(
			(await call('GET', '/v1/admin/deliveries?appId=app_pages', { headers: { cookie: support } })).json.items,
		).toHaveLength(3);
		expect((await call('GET', '/v1/admin/deliveries', { headers: { cookie: support } })).status).toBe(400);
		expect((await call('GET', '/v1/admin/deliveries', { headers: { cookie: owner } })).status).toBe(401);
		const mine = await call('GET', '/v1/product/deliveries', {
			headers: { authorization: await productAuth('app_other_site') },
		});
		expect(mine.json.items.map((/** @type {any} */ i) => i.websiteId)).toEqual([WEBSITE_2]);
		const metrics = await call('GET', `/v1/admin/integration/metrics?appId=app_pages`, { headers: { cookie: support } });
		expect(metrics.json.deliveries.delivered).toBe(3);
		const dl = await call('GET', `/v1/admin/dead-letters?websiteId=${WEBSITE}&appId=app_pages`, {
			headers: { cookie: support },
		});
		expect(dl.json).toEqual({ items: [], nextCursor: null, hasMore: false });
	});
});
