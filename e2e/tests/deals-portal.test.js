/**
 * End to end against the REAL Portal (`@ss/platform/testing`: `createPortal` with every production module), in process, on the test
 * run's MongoMemoryReplSet:
 *
 *   bootstrap staff (password + TOTP) → register this product through the real catalog handshake → activate →
 *   merchant signs up (e-mail verification) → adds a website → staff adds credits → merchant subscribes (starter) →
 *   connects a database connector (MongoMemory URI, dev allowlist) → creates a weekday-evening deal with an overnight
 *   window in Asia/Karachi through the product API (sk_ key issued by the Portal) → quotes a cart outside and inside
 *   the window (browser pk_ key) → a price lock is honoured after the window closed → the quote is committed (uses
 *   counted in the merchant's own database, deals.applied@1 published to the Portal) → metered `quote` usage reaches
 *   the Portal exactly once → hourly settlement charges credits. Plus the merchant console's "Try demo" launch.
 *
 * The Portal is served over http on 127.0.0.1 (allowed outside production); the product over https on localhost with a
 * throw-away certificate trusted for this process only (the manifest's `endpoints.base` must be https).
 * System test (the `e2e/` workspace): it runs the Portal (`@ss/platform/testing`) and the product (`@ss/product-deals/serve`).
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
import { ROOT, loadManifest, startServer } from '@ss/product-deals/serve';
import { createClock, mongoUri } from './helpers.js';

const HOUR = 3_600_000;
const REGISTRATION_TOKEN = `rt_${randomBytes(24).toString('hex')}`;
const STAFF = { email: 'root@portal.test', password: 'staff password 123!' };
const MERCHANT_USER = { email: 'owner@shop.example.com', password: 'merchant password 123!' };
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

/**
 * 10:10 UTC on the next Wednesday (15:10 in Asia/Karachi, before the 18:00 window), so the test controls the weekday.
 * @param {number} from
 */
const nextWednesday = (from) => {
	const day = new Date(Math.floor(from / (24 * HOUR)) * 24 * HOUR);
	const ahead = (3 - day.getUTCDay() + 7) % 7 || 7;
	return day.getTime() + ahead * 24 * HOUR + 10 * HOUR + 10 * 60_000;
};

/** @type {any} */
let ctx;

beforeAll(async () => {
	if (!hasOpenssl) return;
	const clock = createClock(nextWednesday(Date.now()));
	const work = await mkdtemp(path.join(tmpdir(), 'ss-deals-e2e-'));
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
		PORTAL_URL,
		PORTAL_SIGNING_KEYS: JSON.stringify([portalKey]),
		WEBSITE_KEY_SIGNING_KEYS: JSON.stringify([websiteKeySigner]),
		SECRETS_KEK: `kek-1:${randomBytes(32).toString('base64')}`,
		SESSION_SECRET: randomBytes(32).toString('base64'),
		WEBSITE_KEY_PEPPER: randomBytes(32).toString('base64'),
		OUTBOUND_DEV_ALLOW_HOSTS: LOCAL_HOSTS.join(','),
		STAFF_SESSION_IDLE_MINUTES: '720',
	});
	const mongo = await new MongoClient(/** @type {string} */ (process.env.SS_TEST_MONGO_URI)).connect();
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

	// ── the product: https on localhost, pinned to this Portal ─────────────────────────────────────────────
	const productPort = await freePort();
	const PRODUCT_URL = `https://localhost:${productPort}`;
	const manifest = await loadManifest(ROOT);
	const { privateJwk: productKey } = await generateSigningKey({ kid: 'deals-e2e-1' });
	const product = await startServer({
		port: productPort,
		host: '127.0.0.1',
		root: ROOT,
		tls: { key, cert },
		env: {
			SS_PORTAL_URL: PORTAL_URL,
			SS_APP_SIGNING_KEY: JSON.stringify(productKey),
			SS_REGISTRATION_TOKEN_HASH: hashRegistrationToken(REGISTRATION_TOKEN),
			SS_LOG_LEVEL: 'error',
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
		state: {},
	};
}, 120_000);

afterAll(async () => {
	if (!ctx) return;
	await ctx.product.close();
	await new Promise((resolve) => {
		ctx.portalServer.close(() => resolve(undefined));
		ctx.portalServer.closeAllConnections();
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

/** Midnight UTC of the day of `ms`. @param {number} ms */
const startOfDay = (ms) => Math.floor(ms / (24 * HOUR)) * 24 * HOUR;

/**
 * A call to the product over https (like a merchant server with `sk_` or a browser with `pk_` from the shop's domain).
 * @param {string} method
 * @param {string} pathname
 * @param {{ bearer: string, body?: unknown, origin?: string }} init
 */
const product = async (method, pathname, { bearer, body, origin }) => {
	const response = await fetch(`${ctx.PRODUCT_URL}${pathname}`, {
		method,
		headers: {
			authorization: `Bearer ${bearer}`,
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
			...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}),
			...(origin ? { origin } : {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await response.text();
	return { status: response.status, json: text ? JSON.parse(text) : null };
};

/**
 * Quote the test cart as the merchant's checkout server (sk_, identified customer — the deal has a per-customer
 * limit) or from the browser (`browser: true`: pk_ key from the shop's origin, anonymous shopper).
 * @param {Record<string, unknown>} [extra]
 * @param {{ browser?: boolean }} [options]
 */
const quote = (extra = {}, { browser = false } = {}) =>
	product('POST', '/v1/quotes', {
		bearer: browser ? ctx.state.pk : ctx.state.sk,
		...(browser ? { origin: 'https://shop.example.com' } : {}),
		body: {
			currency: 'PKR',
			lines: [{ itemId: 'itm_phone', quantity: 1, unitAmount: 100_000, collections: ['phones'] }],
			...(browser ? {} : { customer: { id: 'cus_e2e' } }),
			...extra,
		},
	});

describe.skipIf(!hasOpenssl)('Deals & Promotions on the real Portal', () => {
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
		expect(registered.json).toMatchObject({ slug: 'deals', kind: 'service', status: 'pending', currentVersion: 1 });
		state.appId = registered.json.appId;
		// the product recorded its appId from the handshake; the token is burnt
		expect(
			(
				await call('POST', '/v1/admin/apps/register', {
					cookie: state.staff,
					body: { baseUrl: PRODUCT_URL, token: REGISTRATION_TOKEN },
				})
			).status,
		).toBe(409);
		const versions = await call('GET', `/v1/admin/apps/${state.appId}/versions`, { cookie: state.staff });
		expect(versions.json.items[0]).toMatchObject({ version: 1, status: 'accepted' });
		// approval of the registered version = activation (pending → active, manifest.accepted@1)
		const activated = await call('POST', `/v1/admin/apps/${state.appId}/lifecycle`, {
			cookie: state.staff,
			body: { action: 'activate' },
		});
		expect(activated.json.status).toBe('active');
		const catalog = await call('GET', '/v1/catalog/products');
		const listed = catalog.json.items.find((/** @type {any} */ item) => item.slug === 'deals');
		expect(listed).toMatchObject({ appId: state.appId });
		expect(listed.elements.map((/** @type {any} */ element) => element.key)).toEqual([
			'quote_api',
			'item_deals',
			'cart_deals',
			'flash_sales',
			'bundles',
			'stacking',
			'price_locks',
			'badges',
			'deals_page',
			'reporting',
		]);
	});

	it('lets a merchant sign up, add a website, receive credits and subscribe', async () => {
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
		expect(credits.json.balanceMillicredits).toBe(100_000);
		const subscribed = await call('POST', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/subscriptions`, {
			cookie: state.merchant,
			body: { appId: state.appId, planCode: 'starter' },
		});
		expect(subscribed.status, JSON.stringify(subscribed.json)).toBe(201);
		expect(subscribed.json.subscription).toMatchObject({ status: 'active', planCode: 'starter', productSlug: 'deals' });
		state.subscriptionId = subscribed.json.subscription.subscriptionId;
		state.subscribedAt = ctx.clock.now();
	});

	it('connects the merchant’s database (connector check passes) and issues website keys', async () => {
		const { call, state, clientDbName, drain } = ctx;
		const connector = await call('POST', `/v1/merchants/${state.merchantId}/connectors`, {
			cookie: state.merchant,
			body: {
				kind: 'database',
				provider: 'mongodb',
				label: 'Shop DB',
				credentials: { uri: mongoUri(clientDbName) },
				websiteIds: [state.websiteId],
			},
		});
		expect(connector.status, JSON.stringify(connector.json)).toBe(201);
		expect(connector.json.connector.status).toBe('connected');
		for (const kind of ['sk', 'pk']) {
			const keys = await call('POST', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/keys`, {
				cookie: state.merchant,
				body: { kind, scopes: kind === 'sk' ? ['events.*'] : ['elements.read'] },
			});
			expect(keys.status, JSON.stringify(keys.json)).toBe(201);
			state[kind] = keys.json.key;
		}
		const drained = await drain();
		expect(drained.stats.dead).toBe(0);
	});

	it('creates a weekday-evening deal (18:00–02:00 Asia/Karachi) and quotes a cart outside and inside the window', async () => {
		const { state, clock, mongo, clientDbName } = ctx;
		const created = await product('POST', '/v1/deals', {
			bearer: state.sk,
			body: {
				kind: 'item',
				name: 'Weekday evenings: 20% off phones',
				scope: { collections: ['phones'] },
				action: { type: 'percent', percent: 20 },
				schedule: {
					timeZone: 'Asia/Karachi',
					windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '18:00', end: '02:00' }],
				},
				limits: { perCustomer: 2 },
			},
		});
		expect(created.status, JSON.stringify(created.json)).toBe(201);
		state.dealId = created.json.id;
		// the deal lives in the merchant's own database, keyed by websiteId
		const stored = await mongo
			.db(clientDbName)
			.collection('ss_deals_deals')
			.findOne({ websiteId: state.websiteId, id: state.dealId });
		expect(stored).toMatchObject({ merchantId: state.merchantId, env: 'live', kind: 'item' });
		// Wednesday 15:xx in Karachi: outside the window
		const outside = await quote();
		expect(outside.status, JSON.stringify(outside.json)).toBe(201);
		expect(outside.json.discountTotal).toBe(0);
		const browser = await quote({}, { browser: true });
		expect(browser.status, JSON.stringify(browser.json)).toBe(201);
		expect(browser.json.discountTotal).toBe(0);
		// Wednesday 19:00 in Karachi (14:00 UTC): inside
		clock.set(startOfDay(clock.now()) + 14 * HOUR);
		const inside = await quote();
		expect(inside.json.deals.map((/** @type {any} */ d) => d.dealId)).toEqual([state.dealId]);
		expect(inside.json.lines[0]).toMatchObject({ discount: 20_000, total: 80_000 });
		// anonymous browser shoppers do not get per-customer-limited deals (quote_api.anonymous_limited_deals = exclude)
		expect((await quote({}, { browser: true })).json.discountTotal).toBe(0);
		// Thursday 01:30 in Karachi (Wednesday 20:30 UTC): still Wednesday's overnight window
		clock.set(startOfDay(clock.now()) + 20 * HOUR + 30 * 60_000);
		expect((await quote()).json.discountTotal).toBe(20_000);
	});

	it('honours a price lock after the window closed and commits the quote (usage counted, deals.applied@1 published)', async () => {
		const { state, clock, mongo, clientDbName, portalDb } = ctx;
		// Thursday 01:55 Karachi: 5 minutes left
		clock.set(startOfDay(clock.now()) + 20 * HOUR + 55 * 60_000);
		const locked = await quote();
		const lock = locked.json.locks[0];
		expect(lock.token).toMatch(/^pl1\./);
		clock.advance(10 * 60_000); // 02:05: the window closed, the 15-minute lock still holds
		expect((await quote()).json.discountTotal).toBe(0);
		const honoured = await quote({ locks: [lock.token] });
		expect(honoured.json.lines[0]).toMatchObject({ discount: 20_000, locked: true });
		const committed = await product('POST', `/v1/quotes/${honoured.json.id}/commit`, {
			bearer: state.sk,
			body: { orderId: 'ord_e2e_1', customerId: 'cus_e2e', expectedTotal: honoured.json.total },
		});
		expect(committed.status, JSON.stringify(committed.json)).toBe(201);
		const clientDb = mongo.db(clientDbName);
		expect(
			await clientDb.collection('ss_deals_counters').findOne({ websiteId: state.websiteId, dealId: state.dealId }),
		).toMatchObject({ uses: 1, units: 1 });
		expect(
			await clientDb.collection('ss_deals_applications').findOne({ websiteId: state.websiteId, orderId: 'ord_e2e_1' }),
		).toMatchObject({
			status: 'committed',
			discountTotal: 20_000,
		});
		// the Portal stores event routing metadata only — never the payload
		expect(JSON.stringify(await portalDb.listCollections().toArray())).not.toContain('ord_e2e_1');
		// metered `quote` usage reaches the Portal exactly once
		const flushed = await ctx.product.product.usage.flush();
		expect(flushed.sent).toBeGreaterThanOrEqual(5);
		expect(flushed.rejected).toBe(0);
		expect((await ctx.product.product.usage.flush()).sent).toBe(0);
	});

	it('settles complete hours: the subscription is charged in credits', async () => {
		const { call, state, clock } = ctx;
		const hour0 = Math.floor(state.subscribedAt / HOUR) * HOUR;
		clock.advance(HOUR);
		// no cron: reading the statement settles the merchant's complete hours first
		const statement = await call(
			'GET',
			`/v1/merchants/${state.merchantId}/statement?from=${encodeURIComponent(new Date(hour0 - HOUR).toISOString())}&to=${encodeURIComponent(new Date(clock.now() + HOUR).toISOString())}`,
			{ cookie: state.merchant },
		);
		expect(statement.status, JSON.stringify(statement.json)).toBe(200);
		const settlements = statement.json.entries.filter(
			(/** @type {any} */ entry) => entry.type === 'settlement' && entry.subscriptionId === state.subscriptionId,
		);
		const iso = (/** @type {any} */ ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
		const second = settlements.find(
			(/** @type {any} */ entry) => entry.periodKey === `${state.subscriptionId}:${iso(hour0 + HOUR)}`,
		);
		// starter: quote_api 200 + item_deals 300 + cart_deals 200 + price_locks 100 + badges 100 + deals_page 100 millicredits per hour
		expect(
			second?.amountMillicredits,
			JSON.stringify(statement.json.entries.map((/** @type {any} */ e) => [e.type, e.periodKey, e.amountMillicredits])),
		).toBe(-1000);
		const balance = await call('GET', `/v1/merchants/${state.merchantId}/balance`, { cookie: state.merchant });
		const charged = settlements.reduce((/** @type {any} */ sum, /** @type {any} */ entry) => sum + entry.amountMillicredits, 0);
		const trial = statement.json.entries
			.filter((/** @type {any} */ entry) => entry.type === 'adjustment')
			.reduce((/** @type {any} */ sum, /** @type {any} */ entry) => sum + entry.amountMillicredits, 0);
		expect(charged).toBeLessThan(0);
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
