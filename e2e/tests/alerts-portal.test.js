/**
 * End to end against the REAL Portal (`@ss/platform/testing`: `createPortal` with every production module), in process, on the test
 * run's MongoMemoryReplSet:
 *
 *   bootstrap staff (password + TOTP) → register this product through the real catalog handshake → activate →
 *   merchant signs up (e-mail verification) → adds a website → staff adds credits → merchant subscribes (starter) →
 *   connects a database connector (MongoMemory URI) and a messaging connector (a fake HTTP messaging provider on
 *   127.0.0.1, dev allowlist) → a shopper subscribes to back-in-stock with the website's pk_ key → the website sends
 *   inventory.changed@1 (0 → 5) to the Portal Event Hub, twice, plus a second event with the same change and an
 *   in-process redelivery → exactly one message reaches the provider → the shopper opens the unsubscribe link (GET
 *   changes nothing) and confirms (POST) → usage reported once → hourly settlement charges the base price and the
 *   metered send. Plus the merchant console's "Try demo" launch.
 *
 * The Portal is served over http on 127.0.0.1 (allowed outside production); the product over https on localhost with a
 * throw-away certificate trusted for this process only (the manifest's `endpoints.base` must be https).
 * System test (the `e2e/` workspace): it runs the Portal (`@ss/platform/testing`) and the product (`@ss/product-alerts/serve`).
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { noopLogger } from '@ss/app-kit';
import { createId } from '@ss/contracts';
import { generateSigningKey, hashRegistrationToken } from '@ss/protocol';
import {
	closeMongoClients,
	commerceModule,
	configModule,
	createCatalogModule,
	createConnectorsModule,
	createIdentityModule,
	createIntegrationModule,
	createPortal,
	loadConfig,
	systemModule,
	totpCode,
} from '@ss/platform/testing';
import { ROOT, loadManifest, startServer } from '@ss/product-alerts/serve';
import { createClock, mongoUri } from './helpers.js';

const HOUR = 3_600_000;
const REGISTRATION_TOKEN = `rt_${randomBytes(24).toString('hex')}`;
const STAFF = { email: 'root@portal.test', password: 'staff password 123!' };
const MERCHANT_USER = { email: 'owner@shop.example.com', password: 'merchant password 123!' };
const SHOPPER = 'jane@example.com';
const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];

const hasOpenssl = (() => {
	try {
		execFileSync('openssl', ['version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

/** @returns {Promise<number>} */
const freePort = () =>
	new Promise((resolve, reject) => {
		const server = createNetServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
			server.close(() => resolve(port));
		});
	});

/**
 * Resolve `localhost` to IPv4 only (the product listens on 127.0.0.1).
 * @param {string} hostname
 * @returns {Promise<Array<{ address: string, family: number }>>}
 */
const resolveLocal = async (hostname) => (LOCAL_HOSTS.includes(hostname) ? [{ address: '127.0.0.1', family: 4 }] : []);

/** In-memory mailer (identity e-mails: verification, password reset). */
const createMailer = () => {
	/** @type {Array<{ to: string, template: string, data: Record<string, any> }>} */
	const sent = [];
	return {
		available: true,
		/** @param {any} message */
		send: async (message) => {
			sent.push(message);
		},
		/** @param {string} to @param {string} template */
		token: (to, template) => {
			const message = [...sent].reverse().find((m) => m.to === to && m.template === template);
			return decodeURIComponent(String(message?.data?.link ?? '').split('#token=')[1] ?? '');
		},
	};
};

/** @type {any} */
let ctx;

beforeAll(async () => {
	if (!hasOpenssl) return;
	const clock = createClock(Math.floor(Date.now() / HOUR) * HOUR + 10 * 60_000);
	const work = await mkdtemp(path.join(tmpdir(), 'ss-alerts-e2e-'));
	execFileSync(
		'openssl',
		[
			'req',
			'-x509',
			'-newkey',
			'ec',
			'-pkeyopt',
			'ec_paramgen_curve:prime256v1',
			'-nodes',
			'-days',
			'2',
			'-subj',
			'/CN=localhost',
			'-addext',
			'subjectAltName=DNS:localhost,IP:127.0.0.1',
			'-keyout',
			path.join(work, 'key.pem'),
			'-out',
			path.join(work, 'cert.pem'),
		],
		{ stdio: 'ignore' },
	);
	const cert = await readFile(path.join(work, 'cert.pem'), 'utf8');
	const key = await readFile(path.join(work, 'key.pem'), 'utf8');
	const defaultCAs = tls.getCACertificates('default');
	tls.setDefaultCACertificates([...defaultCAs, cert]);

	// ── the Portal: real modules, http on 127.0.0.1 ─────────────────────────────────────────────────────────
	const portalPort = await freePort();
	const PORTAL_URL = `http://127.0.0.1:${portalPort}`;
	const { privateJwk: portalKey } = await generateSigningKey({ kid: 'portal-e2e-1' });
	const { privateJwk: websiteKeySigner } = await generateSigningKey({ kid: 'website-e2e-1' });
	const config = loadConfig({
		NODE_ENV: 'test',
		MONGODB_URI: mongoUri('unused'),
		PUBLIC_URL: PORTAL_URL,
		SIGNING_KEYS: `${portalKey.kid}:${portalKey.d}`,
		WEBSITE_SIGNING_KEYS: `${websiteKeySigner.kid}:${websiteKeySigner.d}`,
		ENCRYPTION_KEYS: `kek-1:${randomBytes(32).toString('base64')}`,
		SESSION_SECRET: randomBytes(32).toString('base64'),
		KEY_PEPPER: randomBytes(32).toString('base64'),
		OUTBOUND_DEV_ALLOW_HOSTS: LOCAL_HOSTS.join(','),
		STAFF_SESSION_IDLE_MINUTES: '720',
	});
	const mongo = await new MongoClient(/** @type {string} */ (process.env.TEST_MONGODB_URI)).connect();
	const suffix = randomBytes(4).toString('hex');
	const portalDb = mongo.db(`e2e_portal_${suffix}`);
	const clientDbName = `e2e_client_${suffix}`;
	const mailer = createMailer();
	/** @type {Array<() => Promise<unknown>>} work the Portal runs right after each response (F.19: no cron) */
	const afterResponseTasks = [];
	const portal = createPortal({
		config,
		db: portalDb,
		logger: /** @type {any} */ (noopLogger),
		now: clock.now,
		background: { mode: 'on', fallback: (task) => void afterResponseTasks.push(task) },
		mailer,
		modules: [
			systemModule,
			createIntegrationModule({ allowHosts: LOCAL_HOSTS, resolve: resolveLocal, routingCacheMs: 0, timeoutMs: 15_000 }),
			createCatalogModule({ allowHosts: LOCAL_HOSTS, resolve: resolveLocal }),
			createIdentityModule({ mailer }),
			configModule,
			createConnectorsModule({ allowHosts: LOCAL_HOSTS, resolve: resolveLocal }),
			commerceModule,
		],
	});
	await portal.ensureIndexes();
	const portalServer = createServer(async (incoming, outgoing) => {
		const chunks = [];
		for await (const chunk of incoming) chunks.push(chunk);
		const body = Buffer.concat(chunks);
		/** @type {Record<string, string>} */
		const headers = {};
		for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers[name] = value;
		const request = new Request(`${PORTAL_URL}${incoming.url}`, {
			method: incoming.method,
			headers,
			...(body.length > 0 && incoming.method !== 'GET' ? { body } : {}),
		});
		const response = incoming.url === '/.well-known/jwks.json' ? portal.jwks() : await portal.handle(request);
		/** @type {Record<string, string>} */
		const out = {};
		response.headers.forEach((value, name) => {
			out[name] = value;
		});
		outgoing.writeHead(response.status, out);
		outgoing.end(Buffer.from(await response.arrayBuffer()));
	});
	await new Promise((resolve) => portalServer.listen(portalPort, '127.0.0.1', () => resolve(undefined)));

	// ── the merchant's messaging provider (fake): http on 127.0.0.1 (dev allowlist) ─────────────────────────
	const messagingPort = await freePort();
	const MESSAGING_URL = `http://127.0.0.1:${messagingPort}`;
	/** @type {Array<{ method: string, url: string, headers: Record<string, string | string[] | undefined>, body: any }>} */
	const providerLog = [];
	const messagingServer = createServer(async (incoming, outgoing) => {
		const chunks = [];
		for await (const chunk of incoming) chunks.push(chunk);
		const text = Buffer.concat(chunks).toString('utf8');
		providerLog.push({
			method: incoming.method ?? 'GET',
			url: incoming.url ?? '/',
			headers: incoming.headers,
			body: text ? JSON.parse(text) : null,
		});
		const authorized = incoming.headers.authorization === 'Bearer provider-secret-key';
		outgoing.writeHead(authorized ? (incoming.method === 'POST' ? 202 : 200) : 401, { 'content-type': 'application/json' });
		outgoing.end(JSON.stringify(authorized ? { id: `prov_${providerLog.length}`, ok: true } : { error: 'unauthorized' }));
	});
	await new Promise((resolve) => messagingServer.listen(messagingPort, '127.0.0.1', () => resolve(undefined)));

	// ── the product: https on localhost, pinned to this Portal ─────────────────────────────────────────────
	const productPort = await freePort();
	const PRODUCT_URL = `https://localhost:${productPort}`;
	const manifest = await loadManifest(ROOT);
	const { privateJwk: productKey } = await generateSigningKey({ kid: 'alerts-e2e-1' });
	const product = await startServer({
		port: productPort,
		host: '127.0.0.1',
		root: ROOT,
		tls: { key, cert },
		env: {
			PORTAL_URL,
			SIGNING_KEY: `${productKey.kid}:${productKey.d}`,
			REGISTRATION_TOKEN_HASH: hashRegistrationToken(REGISTRATION_TOKEN),
			LOG_LEVEL: 'error',
		},
		overrides: {
			now: clock.now,
			logger: noopLogger,
			manifest: { ...manifest, endpoints: { ...manifest.endpoints, base: PRODUCT_URL } },
		},
	});

	/**
	 * In-process Portal call (cookie sessions send the Portal origin for CSRF).
	 * @param {string} method
	 * @param {string} pathname
	 * @param {{ body?: unknown, cookie?: string, bearer?: string, headers?: Record<string, string> }} [init]
	 */
	const call = async (method, pathname, { body, cookie, bearer, headers = {} } = {}) => {
		const response = await portal.handle(
			new Request(`${PORTAL_URL}${pathname}`, {
				method,
				headers: {
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(cookie ? { cookie, origin: PORTAL_URL, 'sec-fetch-site': 'same-origin' } : {}),
					...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
					...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}),
					...headers,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		const text = await response.text();
		const setCookie = response.headers
			.getSetCookie()
			.map((value) => value.split(';')[0])
			.find((pair) => /=.+/.test(pair ?? ''));
		return { status: response.status, json: text ? JSON.parse(text) : null, cookie: setCookie ?? null };
	};
	/** Run what the Portal deferred after its responses (deliveries, retries); returns the job outcome counts. */
	const drain = async () => {
		const jobs = portalDb.collection('platform_jobs');
		const count = async () => ({
			done: await jobs.countDocuments({ status: 'done' }),
			dead: await jobs.countDocuments({ status: 'dead' }),
		});
		const before = await count();
		while (afterResponseTasks.length > 0) await afterResponseTasks.shift()?.();
		const after = await count();
		return { status: 'ok', stats: { succeeded: after.done - before.done, dead: after.dead - before.dead } };
	};
	ctx = {
		clock,
		portal,
		portalDb,
		mongo,
		clientDbName,
		mailer,
		call,
		drain,
		product,
		PORTAL_URL,
		PRODUCT_URL,
		work,
		defaultCAs,
		portalServer,
		messagingServer,
		MESSAGING_URL,
		providerLog,
		state: {},
	};
}, 120_000);

afterAll(async () => {
	if (!ctx) return;
	await ctx.product.close();
	for (const server of [ctx.portalServer, ctx.messagingServer])
		await new Promise((resolve) => {
			server.close(() => resolve(undefined));
			server.closeAllConnections();
		});
	tls.setDefaultCACertificates(ctx.defaultCAs);
	await ctx.portalDb.dropDatabase().catch(() => undefined);
	await ctx.mongo
		.db(ctx.clientDbName)
		.dropDatabase()
		.catch(() => undefined);
	await ctx.mongo.close();
	await closeMongoClients();
	await rm(ctx.work, { recursive: true, force: true });
});

describe.skipIf(!hasOpenssl)('Alerts & Waitlists on the real Portal', () => {
	it('bootstraps the first staff user (password + TOTP)', async () => {
		const { call, portal, clock, state } = ctx;
		const { link } = await portal.modules.service('identity').bootstrapSuperadmin({ email: STAFF.email });
		const token = decodeURIComponent(String(link).split('#token=')[1] ?? '');
		expect(
			(await call('POST', '/v1/auth/staff/password-reset/confirm', { body: { token, password: STAFF.password } })).status,
		).toBe(204);
		const login = await call('POST', '/v1/auth/staff/login', { body: STAFF });
		expect(login.json.status).toBe('mfa_enrolment_required');
		const enrol = await call('POST', '/v1/auth/staff/mfa/enrol', { cookie: login.cookie });
		expect(enrol.status).toBe(200);
		clock.advance(30_000);
		const confirm = await call('POST', '/v1/auth/staff/mfa/confirm', {
			cookie: login.cookie,
			body: { code: totpCode(enrol.json.secret, clock.now()) },
		});
		expect(confirm.status, JSON.stringify(confirm.json)).toBe(200);
		state.staff = confirm.cookie ?? login.cookie;
	});

	it('registers the product through the catalog handshake and lists it after activation', async () => {
		const { call, state, PRODUCT_URL } = ctx;
		const registered = await call('POST', '/v1/admin/apps/register', {
			cookie: state.staff,
			body: { baseUrl: PRODUCT_URL, token: REGISTRATION_TOKEN },
		});
		expect(registered.status, JSON.stringify(registered.json)).toBe(201);
		expect(registered.json).toMatchObject({ slug: 'alerts', kind: 'service', status: 'pending', currentVersion: 1 });
		state.appId = registered.json.appId;
		const activated = await call('POST', `/v1/admin/apps/${state.appId}/lifecycle`, {
			cookie: state.staff,
			body: { action: 'activate' },
		});
		expect(activated.json.status).toBe('active');
		const catalog = await call('GET', '/v1/catalog/products');
		const listed = catalog.json.items.find((/** @type {any} */ item) => item.slug === 'alerts');
		expect(listed).toMatchObject({ appId: state.appId });
		expect(listed.elements.map((/** @type {any} */ element) => element.key)).toEqual([
			'triggers',
			'types',
			'capture',
			'dispatch',
			'waitlist_priority',
			'unsubscribe',
			'analytics',
		]);
	});

	it('lets a merchant sign up, add a website, receive credits and subscribe (starter)', async () => {
		const { call, mailer, state } = ctx;
		expect((await call('POST', '/v1/auth/merchant/signup', { body: { ...MERCHANT_USER, merchantName: 'Shop' } })).status).toBe(
			202,
		);
		const verified = await call('POST', '/v1/auth/merchant/verify-email', {
			body: { token: mailer.token(MERCHANT_USER.email, 'verify_email') },
		});
		expect(verified.status, JSON.stringify(verified.json)).toBe(201);
		state.merchantId = verified.json.merchantId;
		state.merchant = verified.cookie;
		const website = await call('POST', `/v1/merchants/${state.merchantId}/websites`, {
			cookie: state.merchant,
			body: { domain: 'shop.example.com' },
		});
		expect(website.status, JSON.stringify(website.json)).toBe(201);
		state.websiteId = website.json.website.websiteId;
		const credits = await call('POST', `/v1/admin/merchants/${state.merchantId}/credits`, {
			cookie: state.staff,
			body: { amountMillicredits: 100_000, reference: 'e2e-topup-1', note: 'end-to-end test credits' },
		});
		expect(credits.status, JSON.stringify(credits.json)).toBe(201);
		const subscribed = await call('POST', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/subscriptions`, {
			cookie: state.merchant,
			body: { appId: state.appId, planCode: 'starter' },
		});
		expect(subscribed.status, JSON.stringify(subscribed.json)).toBe(201);
		expect(subscribed.json.subscription).toMatchObject({ status: 'active', planCode: 'starter', productSlug: 'alerts' });
		state.subscriptionId = subscribed.json.subscription.subscriptionId;
		state.subscribedAt = ctx.clock.now();
	});

	it('connects the merchant’s database and messaging provider (connector checks pass)', async () => {
		const { call, state, clientDbName, drain, MESSAGING_URL, providerLog } = ctx;
		const database = await call('POST', `/v1/merchants/${state.merchantId}/connectors`, {
			cookie: state.merchant,
			body: {
				kind: 'database',
				provider: 'mongodb',
				label: 'Shop DB',
				credentials: { uri: mongoUri(clientDbName) },
				websiteIds: [state.websiteId],
			},
		});
		expect(database.status, JSON.stringify(database.json)).toBe(201);
		expect(database.json.connector.status).toBe('connected');
		const messaging = await call('POST', `/v1/merchants/${state.merchantId}/connectors`, {
			cookie: state.merchant,
			body: {
				kind: 'messaging',
				provider: 'generic-http',
				label: 'Shop messaging',
				credentials: { baseUrl: MESSAGING_URL, apiKey: 'provider-secret-key', testPath: '/health' },
				websiteIds: [state.websiteId],
			},
		});
		expect(messaging.status, JSON.stringify(messaging.json)).toBe(201);
		expect(messaging.json.connector.status).toBe('connected');
		expect(providerLog.some((/** @type {any} */ r) => r.method === 'GET' && r.url === '/health')).toBe(true);
		const resources = await call('GET', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/resources`, {
			cookie: state.merchant,
		});
		expect(resources.json.resources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: 'database', status: 'connected' }),
				expect.objectContaining({ kind: 'messaging', status: 'connected' }),
			]),
		);
		for (const kind of ['sk', 'pk']) {
			const keys = await call('POST', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/keys`, {
				cookie: state.merchant,
				body: { kind, scopes: ['events.*'] },
			});
			expect(keys.status, JSON.stringify(keys.json)).toBe(201);
			state[kind] = keys.json.key;
		}
		const drained = await drain();
		expect(drained.stats.dead).toBe(0);
	});

	it('lets a shopper subscribe to back-in-stock from the website (pk_ key, consent)', async () => {
		const { state, PRODUCT_URL } = ctx;
		const response = await fetch(`${PRODUCT_URL}/v1/subscriptions`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${state.pk}`,
				origin: 'https://shop.example.com',
				'content-type': 'application/json',
				'idempotency-key': randomUUID(),
			},
			body: JSON.stringify({
				type: 'back_in_stock',
				itemId: 'itm_phone_x',
				channel: 'email',
				email: SHOPPER,
				consent: true,
				item: { name: 'Phone X', url: 'https://shop.example.com/p/phone-x' },
			}),
		});
		const body = await response.json();
		expect(response.status, JSON.stringify(body)).toBe(201);
		expect(body).toMatchObject({ type: 'back_in_stock', status: 'pending', contactMasked: 'j•••@example.com', contact: null });
		state.alertSubscriptionId = body.id;
		const stored = await ctx.mongo
			.db(ctx.clientDbName)
			.collection('ss_alerts_subscriptions')
			.findOne({ websiteId: state.websiteId, id: body.id });
		expect(stored).toMatchObject({ status: 'pending', merchantId: state.merchantId, env: 'live', address: { email: SHOPPER } });
	});

	it('routes inventory.changed@1 (0 → 5) through the Event Hub and sends exactly one message, despite duplicates', async () => {
		const { call, state, drain, clock, providerLog, product } = ctx;
		const envelope = (/** @type {string} */ id) => ({
			id,
			type: 'inventory.changed@1',
			websiteId: state.websiteId,
			env: 'live',
			occurredAt: new Date(clock.now()).toISOString(),
			idempotencyKey: id,
			actor: { type: 'merchant', id: 'stock-sync' },
			data: { itemId: 'itm_phone_x', quantity: 5, previousQuantity: 0 },
		});
		const first = envelope(createId('evt'));
		const accepted = await call('POST', '/v1/events', { bearer: state.sk, body: { events: [first] } });
		expect(accepted.status, JSON.stringify(accepted.json)).toBe(202);
		expect(accepted.json.results[0].status).toBe('accepted');
		// the website retries the same event: the Event Hub deduplicates on (websiteId, idempotencyKey)
		const again = await call('POST', '/v1/events', { bearer: state.sk, body: { events: [first] } });
		expect(again.json.results[0].status).toBe('duplicate');
		const drained = await drain();
		expect(drained.stats.dead).toBe(0);
		// a second event reporting the same change, and an in-process redelivery of the first one
		const second = envelope(createId('evt'));
		expect((await call('POST', '/v1/events', { bearer: state.sk, body: { events: [second] } })).json.results[0].status).toBe(
			'accepted',
		);
		await drain();
		await product.product.events.dispatch(first, { source: 'portal' });
		const sends = providerLog.filter((/** @type {any} */ r) => r.method === 'POST');
		expect(sends).toHaveLength(1);
		const [send] = sends;
		expect(send.url).toBe('/messages');
		expect(send.headers.authorization).toBe('Bearer provider-secret-key');
		expect(send.headers['idempotency-key']).toBe(send.body.id);
		expect(send.body).toMatchObject({ channel: 'email', to: { email: SHOPPER }, subject: 'Phone X is back in stock' });
		state.unsubscribeUrl = /Stop these alerts: (\S+)/.exec(send.body.text)?.[1];
		expect(state.unsubscribeUrl).toMatch(/^https:\/\/localhost:\d+\/u\/us1\./);
		const clientDb = ctx.mongo.db(ctx.clientDbName);
		expect(
			await clientDb
				.collection('ss_alerts_subscriptions')
				.findOne({ websiteId: state.websiteId, id: state.alertSubscriptionId }),
		).toMatchObject({
			status: 'notified',
			cycle: 1,
		});
		const runs = await clientDb.collection('ss_alerts_triggers').find({ websiteId: state.websiteId }).toArray();
		expect(runs.map((/** @type {any} */ run) => run.queued).sort()).toEqual([0, 1]);
		// the Portal stored routing metadata only — no payloads, no addresses
		const deliveries = await call('GET', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/deliveries`, {
			cookie: state.merchant,
		});
		expect(JSON.stringify(deliveries.json)).not.toContain('itm_phone_x');
		expect(JSON.stringify(deliveries.json)).not.toContain(SHOPPER);
	});

	it('unsubscribes only after the confirm button (a GET of the link changes nothing)', async () => {
		const { state } = ctx;
		const clientDb = ctx.mongo.db(ctx.clientDbName);
		const page = await fetch(state.unsubscribeUrl);
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain('<form method="post"');
		expect(html).toContain('j•••@example.com');
		expect(await clientDb.collection('ss_alerts_suppressions').countDocuments({ websiteId: state.websiteId })).toBe(0);
		const done = await fetch(state.unsubscribeUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'List-Unsubscribe=One-Click',
		});
		expect(done.status).toBe(200);
		expect(await done.text()).toContain('Alerts stopped');
		expect(await clientDb.collection('ss_alerts_suppressions').countDocuments({ websiteId: state.websiteId })).toBe(1);
		// the merchant's server cannot sign the unsubscribed address up again (only the shopper, with new consent)
		const response = await fetch(`${ctx.PRODUCT_URL}/v1/subscriptions`, {
			method: 'POST',
			headers: { authorization: `Bearer ${state.sk}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
			body: JSON.stringify({ type: 'back_in_stock', itemId: 'itm_phone_y', channel: 'email', email: SHOPPER }),
		});
		expect(response.status).toBe(409);
		expect((await response.json()).type).toMatch(/\/problems\/contact_suppressed$/);
	});

	it('reports the send once and settles complete hours (base price + metered alert_send)', async () => {
		const { call, state, clock, product } = ctx;
		const flushed = await product.product.usage.flush();
		expect(flushed.sent + flushed.duplicates).toBeGreaterThanOrEqual(1);
		expect(flushed.rejected).toBe(0);
		const usage = await ctx.portalDb.collection('commerce_usage').find({ subscriptionId: state.subscriptionId }).toArray();
		expect(usage.filter((/** @type {any} */ record) => record.unit === 'alert_send')).toHaveLength(1);
		const hour0 = Math.floor(state.subscribedAt / HOUR) * HOUR;
		clock.set(hour0 + 2 * HOUR + 5 * 60_000);
		// no cron: reading the statement settles the merchant's complete hours first
		const statement = await call(
			'GET',
			`/v1/merchants/${state.merchantId}/statement?from=${encodeURIComponent(new Date(hour0 - HOUR).toISOString())}&to=${encodeURIComponent(new Date(clock.now() + HOUR).toISOString())}`,
			{ cookie: state.merchant },
		);
		expect(statement.status, JSON.stringify(statement.json)).toBe(200);
		const settlements = statement.json.entries.filter(
			(/** @type {any} */ entry) =>
				['settlement', 'metered'].includes(entry.type) && entry.subscriptionId === state.subscriptionId,
		);
		const iso = (/** @type {any} */ ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
		const entries = JSON.stringify(
			statement.json.entries.map((/** @type {any} */ e) => [e.type, e.periodKey, e.amountMillicredits]),
		);
		// starter: triggers 100 + types 200 + capture 200 + dispatch 300 + unsubscribe 50 millicredits per hour
		expect(
			settlements.find((/** @type {any} */ e) => e.periodKey === `${state.subscriptionId}:${iso(hour0 + HOUR)}`)
				?.amountMillicredits,
			entries,
		).toBe(-850);
		// one alert_send at 1 millicredit (starter includes no sends), in the hour the Portal received it
		expect(
			settlements.find((/** @type {any} */ e) => e.periodKey === `${state.subscriptionId}:${iso(hour0)}:metered`)
				?.amountMillicredits,
			entries,
		).toBe(-1);
		const balance = await call('GET', `/v1/merchants/${state.merchantId}/balance`, { cookie: state.merchant });
		const charged = settlements.reduce((/** @type {any} */ sum, /** @type {any} */ entry) => sum + entry.amountMillicredits, 0);
		const trial = statement.json.entries
			.filter((/** @type {any} */ entry) => entry.type === 'adjustment')
			.reduce((/** @type {any} */ sum, /** @type {any} */ entry) => sum + entry.amountMillicredits, 0);
		expect(balance.json.balanceMillicredits).toBe(100_000 + trial + charged);
	});

	it('opens the product demo from the merchant console ("Try demo")', async () => {
		const { call, state } = ctx;
		const demo = await call('POST', `/v1/merchants/${state.merchantId}/apps/${state.appId}/demo`, {
			cookie: state.merchant,
			body: {},
		});
		expect(demo.status, JSON.stringify(demo.json)).toBe(200);
		const sso = await fetch(demo.json.url, { redirect: 'manual' });
		expect(sso.status).toBe(303);
		const session = /ss_session=(ses_[^;]+)/.exec(sso.headers.get('set-cookie') ?? '')?.[1];
		const view = await fetch(`${ctx.PRODUCT_URL}/v1/session`, { headers: { authorization: `Bearer ${session}` } });
		expect(await view.json()).toMatchObject({ kind: 'demo', role: 'demo' });
	});
});
