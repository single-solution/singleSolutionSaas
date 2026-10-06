/**
 * End to end against the REAL Portal (`@ss/platform/testing`: `createPortal` with every production module), in process, on the test
 * run's MongoMemoryReplSet:
 *
 *   first admin from the sign-in page (password, then TOTP) → register this product through the real catalog handshake → activate →
 *   merchant signs up (e-mail verification) → adds a website → staff adds credits → merchant subscribes (starter) →
 *   connects a database connector (MongoMemory URI, dev allowlist) → sets the website currency and turns on cash on
 *   delivery in the Portal (signed entitlement) → the merchant's server posts an item with one unit of stock → two
 *   concurrent placements for the last unit: exactly one wins, priced on the server, `order.placed@1` published → the
 *   merchant confirms the cash-on-delivery order → the website sends order.completed@1 to the Portal Event Hub → signed
 *   delivery to the product → the order is completed in the merchant's own database → usage (`order`) reaches the
 *   Portal → hourly settlement charges the elements and books the metered hour. Plus the "Try demo" launch.
 *
 * The Portal is served over http on 127.0.0.1 (allowed outside production); the product over https on localhost with a
 * throw-away certificate trusted for this process only (the manifest's `endpoints.base` must be https).
 * System test (the `e2e/` workspace): it runs the Portal (`@ss/platform/testing`) and the product (`@ss/product-checkout/serve`).
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
	testSystemState,
	systemModule,
	totpCode,
	SESSIONS,
} from '@ss/platform/testing';
import { ROOT, loadManifest, startServer } from '@ss/product-checkout/serve';
import { CONNECT_SECRET, connectProduct, createClock, mongoUri } from './helpers.js';

const HOUR = 3_600_000;
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

/** @type {any} */
let ctx;

beforeAll(async () => {
	if (!hasOpenssl) return;
	const clock = createClock(Math.floor(Date.now() / HOUR) * HOUR + 10 * 60_000);
	const work = await mkdtemp(path.join(tmpdir(), 'ss-checkout-e2e-'));
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
	const config = loadConfig(
		{
			NODE_ENV: 'test',
			MONGODB_URI: mongoUri('unused'),
			OUTBOUND_DEV_ALLOW_HOSTS: LOCAL_HOSTS.join(','),
		},
		// keys and secrets as the Portal generates them on first start; the Portal URL is each request's origin
		testSystemState(),
		// long staff sessions for the scripted clock
		{
			baseUrl: PORTAL_URL,
			overrides: { sessions: { ...SESSIONS, staff: { idleMs: 720 * 60_000, absoluteMs: SESSIONS.staff.absoluteMs } } },
		},
	);
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

	// ── the product: https on localhost, pinned to this Portal ─────────────────────────────────────────────
	const productPort = await freePort();
	const PRODUCT_URL = `https://localhost:${productPort}`;
	const manifest = await loadManifest(ROOT);
	const product = await startServer({
		port: productPort,
		host: '127.0.0.1',
		root: ROOT,
		tls: { key, cert },
		env: {
			LOG_LEVEL: 'error',
			CONNECT_SECRET,
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

describe.skipIf(!hasOpenssl)('Cart & Checkout on the real Portal', () => {
	it('creates the first admin from the sign-in page, then signs in and turns on TOTP', async () => {
		const { call, clock, state } = ctx;
		const created = await call('POST', '/v1/auth/staff/first-admin', { body: { password: STAFF.password } });
		expect(created.status, JSON.stringify(created.json)).toBe(201);
		expect((await call('PATCH', '/v1/me', { cookie: created.cookie ?? '', body: { email: STAFF.email } })).status).toBe(200);
		const login = await call('POST', '/v1/auth/staff/login', { body: STAFF });
		expect(login.json.status).toBe('ok');
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

	it('connects the product with its connect secret and lists it after activation', async () => {
		const { call, state, PRODUCT_URL } = ctx;
		// Admin → Apps → Add product: the product URL and its connect secret
		const registered = await connectProduct(call, state.staff, PRODUCT_URL);
		expect(registered.status, JSON.stringify(registered.json)).toBe(201);
		expect(registered.json).toMatchObject({ slug: 'checkout', kind: 'service', status: 'pending', currentVersion: 1 });
		state.appId = registered.json.appId;
		// a wrong secret is refused
		expect((await connectProduct(call, state.staff, PRODUCT_URL, 'w'.repeat(40))).status).toBe(401);
		const versions = await call('GET', `/v1/admin/apps/${state.appId}/versions`, { cookie: state.staff });
		expect(versions.json.items[0]).toMatchObject({ version: 1, status: 'accepted' });
		// approval of the registered version = activation (pending → active, manifest.accepted@1)
		const activated = await call('POST', `/v1/admin/apps/${state.appId}/lifecycle`, {
			cookie: state.staff,
			body: { action: 'activate' },
		});
		expect(activated.json.status).toBe('active');
		const catalog = await call('GET', '/v1/catalog/products');
		const listed = catalog.json.items.find((/** @type {any} */ item) => item.slug === 'checkout');
		expect(listed).toMatchObject({ appId: state.appId });
		expect(listed.elements.map((/** @type {any} */ element) => element.key)).toEqual([
			'cart',
			'checkout_form',
			'place_order',
			'payment_manual',
			'payment_proofs',
			'payment_gateway',
			'offer_apply',
			'loyalty_redeem',
			'success_page',
			'policies_notice',
			'signin_gate',
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
		expect(subscribed.json.subscription).toMatchObject({ status: 'active', planCode: 'starter', productSlug: 'checkout' });
		state.subscriptionId = subscribed.json.subscription.subscriptionId;
		state.subscribedAt = ctx.clock.now();
	});

	it('connects the merchant’s database (connector check passes) and delivers control events', async () => {
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
		const resources = await call('GET', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/resources`, {
			cookie: state.merchant,
		});
		expect(resources.json.resources).toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: 'database', status: 'connected' })]),
		);
		const keys = await call('POST', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/keys`, {
			cookie: state.merchant,
			body: { kind: 'sk', scopes: ['events.*'] },
		});
		expect(keys.status, JSON.stringify(keys.json)).toBe(201);
		state.sk = keys.json.key;
		const drained = await drain();
		expect(drained.stats.dead).toBe(0);
		const log = await call('GET', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/deliveries`, {
			cookie: state.merchant,
		});
		expect(log.status).toBe(200);
	});

	it('sets the website currency and turns on cash on delivery in the Portal (signed entitlement)', async () => {
		const { call, state, drain } = ctx;
		const settings = await call('PATCH', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}`, {
			cookie: state.merchant,
			body: { currency: 'EUR' },
		});
		expect(settings.status, JSON.stringify(settings.json)).toBe(200);
		const config = await call(
			'PATCH',
			`/v1/merchants/${state.merchantId}/websites/${state.websiteId}/subscriptions/${state.subscriptionId}/config`,
			{
				cookie: state.merchant,
				body: {
					features: {
						'payment_manual.cod_enabled': { value: true },
						'payment_manual.cod_surcharge_bp': { value: 100 },
						'place_order.number_prefix': { value: 'E2E-' },
					},
				},
			},
		);
		expect(config.status, JSON.stringify(config.json)).toBe(200);
		const drained = await drain();
		expect(drained.stats.dead).toBe(0);
	});

	it('places orders atomically: of two placements for the last unit exactly one wins, priced on the server', async () => {
		const { state, PRODUCT_URL } = ctx;
		/**
		 * @param {string} method
		 * @param {string} pathname
		 * @param {unknown} [body]
		 */
		const product = async (method, pathname, body) => {
			const response = await fetch(`${PRODUCT_URL}${pathname}`, {
				method,
				headers: {
					authorization: `Bearer ${state.sk}`,
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			const text = await response.text();
			return { status: response.status, json: text ? JSON.parse(text) : null };
		};
		state.product = product;
		const item = await product('PUT', '/v1/items/itm_lamp', {
			title: 'Desk lamp',
			currency: 'EUR',
			variants: [{ variantId: 'lamp_black', sku: 'LAMP-B', price: 4500, available: 1 }],
		});
		expect(item.status, JSON.stringify(item.json)).toBe(200);
		/** @param {string} name */
		const order = (name) => ({
			lines: [{ itemId: 'itm_lamp', variantId: 'lamp_black', quantity: 1 }],
			contact: { name, phone: '+447700900123' },
			address: { recipient_name: name, line1: 'Main street 1', city: 'Metropolis' },
			deliveryMethod: 'standard',
			paymentMethod: 'cod',
			customer: { subject: `cus_${name}` },
		});
		const [a, b] = await Promise.all([
			product('POST', '/v1/orders', order('ada')),
			product('POST', '/v1/orders', order('bob')),
		]);
		expect([a.status, b.status].sort(), JSON.stringify([a.json, b.json])).toEqual([201, 409]);
		const winner = a.status === 201 ? a : b;
		const loser = a.status === 201 ? b : a;
		expect(loser.json.type).toMatch(/\/problems\/insufficient_stock$/);
		expect(winner.json).toMatchObject({
			status: 'awaiting_confirmation',
			number: 'E2E-000001',
			currency: 'EUR',
			totals: { subtotal: 4500, surcharge: 45, total: 4545 },
			payment: { method: 'cod', dueLater: 4545 },
		});
		const stock = await product('GET', '/v1/items/itm_lamp');
		expect(stock.json.variants[0].available).toBe(0);
		const confirmed = await product('POST', `/v1/orders/${winner.json.id}/confirm`, {});
		expect(confirmed.json.status).toBe('confirmed');
		state.order = winner.json;
	});

	it('routes order.completed@1 through the Event Hub to the product, which completes the order in the merchant DB', async () => {
		const { call, state, drain, mongo, clientDbName, clock } = ctx;
		const id = createId('evt');
		const completed = await call('POST', '/v1/events', {
			bearer: state.sk,
			body: {
				events: [
					{
						id,
						type: 'order.completed@1',
						websiteId: state.websiteId,
						env: 'live',
						occurredAt: new Date(clock.now()).toISOString(),
						idempotencyKey: id,
						actor: { type: 'merchant', id: 'usr_owner' },
						data: { orderId: state.order.id },
					},
				],
			},
		});
		expect(completed.status, JSON.stringify(completed.json)).toBe(202);
		expect(completed.json.results[0].status, JSON.stringify(completed.json)).toBe('accepted');
		const drained = await drain();
		expect(drained.stats.succeeded).toBeGreaterThanOrEqual(1);
		expect(drained.stats.dead).toBe(0);
		// the order lives in the merchant's own database, keyed by websiteId (ss_checkout_ prefix), totals snapshot stored
		const clientDb = mongo.db(clientDbName);
		const stored = await clientDb.collection('ss_checkout_orders').findOne({ websiteId: state.websiteId, id: state.order.id });
		expect(stored).toMatchObject({
			status: 'completed',
			merchantId: state.merchantId,
			env: 'live',
			stock: { source: 'checkout', state: 'committed' },
			totals: { total: 4545 },
		});
		const view = await state.product('GET', `/v1/orders/${state.order.id}`);
		expect(view.json.status).toBe('completed');
		// the Portal stored routing metadata only — no payloads
		const deliveries = await call('GET', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/deliveries`, {
			cookie: state.merchant,
		});
		expect(JSON.stringify(deliveries.json)).not.toContain('Main street');
		// metered usage (`order`) reaches the Portal exactly once
		const flushed = await ctx.product.product.usage.flush();
		expect(flushed.sent + flushed.duplicates).toBeGreaterThanOrEqual(1);
		expect(flushed.rejected).toBe(0);
		expect((await ctx.product.product.usage.flush()).sent).toBe(0);
		state.placedAt = Date.parse(String(stored?.placedAt));
	});

	it('settles complete hours: elements charged in credits, the metered order booked', async () => {
		const { call, state, clock } = ctx;
		const hour0 = Math.floor(state.subscribedAt / HOUR) * HOUR;
		clock.set(hour0 + 2 * HOUR + 5 * 60_000);
		// no cron: reading the statement settles the merchant's complete hours first
		const statement = await call(
			'GET',
			`/v1/merchants/${state.merchantId}/statement?from=${encodeURIComponent(new Date(hour0 - HOUR).toISOString())}&to=${encodeURIComponent(new Date(clock.now() + HOUR).toISOString())}`,
			{ cookie: state.merchant },
		);
		expect(statement.status, JSON.stringify(statement.json)).toBe(200);
		const entries = statement.json.entries.filter((/** @type {any} */ entry) => entry.subscriptionId === state.subscriptionId);
		const iso = (/** @type {any} */ ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
		const second = entries.find(
			(/** @type {any} */ entry) =>
				entry.type === 'settlement' && entry.periodKey === `${state.subscriptionId}:${iso(hour0 + HOUR)}`,
		);
		// starter: cart 200 + checkout_form 150 + place_order 250 + payment_manual 150 millicredits per hour (others free)
		expect(
			second?.amountMillicredits,
			JSON.stringify(entries.map((/** @type {any} */ e) => [e.type, e.periodKey, e.amountMillicredits])),
		).toBe(-750);
		const orderHour = Math.floor(state.placedAt / HOUR) * HOUR;
		const metered = entries.find(
			(/** @type {any} */ entry) =>
				entry.type === 'metered' && entry.periodKey === `${state.subscriptionId}:${iso(orderHour)}:metered`,
		);
		expect(metered, JSON.stringify(entries.map((/** @type {any} */ e) => [e.type, e.periodKey]))).toBeTruthy();
		// the first 300 orders of a month are included in starter: booked at zero
		expect(metered.amountMillicredits).toBe(0);
		expect(JSON.stringify(metered.details)).toContain('order');
		const balance = await call('GET', `/v1/merchants/${state.merchantId}/balance`, { cookie: state.merchant });
		const charged = entries
			.filter((/** @type {any} */ entry) => entry.type === 'settlement' || entry.type === 'metered')
			.reduce((/** @type {any} */ sum, /** @type {any} */ entry) => sum + entry.amountMillicredits, 0);
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
