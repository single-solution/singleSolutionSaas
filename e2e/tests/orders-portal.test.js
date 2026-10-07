/**
 * End to end against the REAL Portal (`@ss/platform/testing`: `createPortal` with every production module), in process, on the test
 * run's MongoMemoryReplSet:
 *
 *   first admin from the sign-in page (password, then TOTP) → register the Order Manager through the real catalog handshake → activate →
 *   merchant signs up → adds a website → staff adds credits → merchant subscribes (starter) → connects a database
 *   connector → an external checkout sends an order with the sk_ key (inbound API, metered `order`) → order.placed@1
 *   reaches the Portal Event Hub through the product's durable outbox → the website sends order.placed@1 from its own
 *   Checkout to the Event Hub → signed delivery to the product → the order is stored in the merchant's own database
 *   with the event's order id → a status move publishes orders.status_changed@1 → usage (`order`) reaches the Portal →
 *   hourly settlement charges the starter elements. Plus the widgets: staff upload the `ss pack build` output
 *   ("Upload widgets") and the compiled website script mounts the real order tracker.
 *
 * The Portal is served over http on 127.0.0.1 (allowed outside production); the product over https on localhost with a
 * throw-away certificate trusted for this process only (the manifest's `endpoints.base` must be https).
 * System test (the `e2e/` workspace): it runs the Portal (`@ss/platform/testing`) and the product (`@ss/product-orders`
 * `./platform` + `./routes`, served through app-kit).
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
	createDeliveryModule,
	createIdentityModule,
	createIntegrationModule,
	createPortal,
	loadConfig,
	testSystemState,
	systemModule,
	totpCode,
	SESSIONS,
} from '@ss/platform/testing';
import { buildPack, descriptorOf } from '@ss/cli/pack';
import { createPlatform, loadManifest } from '@ss/product-orders/platform';
import { buildRoutes, createOrders, wireEvents } from '@ss/product-orders/routes';
import { CONNECT_SECRET, connectProduct, createClock, mongoUri, productRoot, startProduct } from './helpers.js';

const ROOT = productRoot('@ss/product-orders');

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
	const work = await mkdtemp(path.join(tmpdir(), 'ss-orders-e2e-'));
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
			STORAGE_DIR: ':memory:',
		},
		// keys and secrets as the Portal generates them on first start; the Portal URL is each request's origin
		testSystemState(),
		// long staff sessions for the scripted clock
		{
			baseUrl: PORTAL_URL,
			overrides: {
				sessions: { ...SESSIONS, staff: { idleMs: 720 * 60_000, absoluteMs: SESSIONS.staff.absoluteMs } },
				delivery: { storage: { kind: 'memory' } },
			},
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
			createDeliveryModule(),
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
	const orders = wireEvents(
		createOrders(
			await createPlatform({
				root: ROOT,
				env: { LOG_LEVEL: 'error', CONNECT_SECRET },
				overrides: {
					now: clock.now,
					logger: noopLogger,
					manifest: { ...manifest, endpoints: { ...manifest.endpoints, base: PRODUCT_URL } },
				},
			}),
		),
	);
	const product = await startProduct({
		product: orders.product,
		routes: buildRoutes(orders),
		close: () => orders.app.close(),
		tls: { key, cert },
		port: productPort,
		handlerOptions: { maxBodyBytes: 3_900_000 },
	});

	/**
	 * In-process Portal call (cookie sessions send the Portal origin for CSRF).
	 * @param {string} method
	 * @param {string} pathname
	 * @param {{ body?: unknown, raw?: Uint8Array, cookie?: string, bearer?: string, headers?: Record<string, string> }} [init]
	 */
	const call = async (method, pathname, { body, raw, cookie, bearer, headers = {} } = {}) => {
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
				...(raw ? { body: new Uint8Array(raw) } : body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		const text = await response.text();
		const setCookie = response.headers
			.getSetCookie()
			.map((value) => value.split(';')[0])
			.find((pair) => /=.+/.test(pair ?? ''));
		const json = (() => {
			try {
				return text ? JSON.parse(text) : null;
			} catch {
				return null;
			}
		})();
		return { status: response.status, json, text, cookie: setCookie ?? null };
	};
	/** Run what the Portal deferred after its responses (deliveries, retries); returns the job outcome counts. */
	const drain = async () => {
		const jobs = portalDb.collection('platform_jobs');
		const count = async () => ({
			done: await jobs.countDocuments({ status: 'done' }),
			failed: await jobs.countDocuments({ status: 'failed' }),
		});
		const before = await count();
		while (afterResponseTasks.length > 0) await afterResponseTasks.shift()?.();
		const after = await count();
		return { status: 'ok', stats: { succeeded: after.done - before.done, failed: after.failed - before.failed } };
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

describe.skipIf(!hasOpenssl)('Order Manager on the real Portal', () => {
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
		expect(registered.json).toMatchObject({ slug: 'orders', kind: 'service', status: 'inactive', currentVersion: 1 });
		state.appId = registered.json.appId;
		// a wrong secret is refused
		expect((await connectProduct(call, state.staff, PRODUCT_URL, 'w'.repeat(40))).status).toBe(401);
		// Active/Inactive switch: merchants see and subscribe to active apps only
		const activated = await call('POST', `/v1/admin/apps/${state.appId}/status`, {
			cookie: state.staff,
			body: { status: 'active' },
		});
		expect(activated.json.status).toBe('active');
		const catalog = await call('GET', '/v1/catalog/products');
		const listed = catalog.json.items.find((/** @type {any} */ item) => item.slug === 'orders');
		expect(listed).toMatchObject({ appId: state.appId });
		expect(listed.elements.map((/** @type {any} */ element) => element.key)).toEqual([
			'lifecycle',
			'fulfilment',
			'serials',
			'invoices',
			'print',
			'bulk',
			'risk',
			'customer_updates',
			'ledger',
			'inbound_api',
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
		expect(subscribed.json.subscription).toMatchObject({ status: 'active', planCode: 'starter', productSlug: 'orders' });
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
		expect(drained.stats.failed).toBe(0);
	});

	it('receives an order from an external checkout (sk_, metered); order.placed@1 reaches the Event Hub', async () => {
		const { state, PRODUCT_URL, portalDb, mongo, clientDbName } = ctx;
		/**
		 * @param {string} method
		 * @param {string} pathname
		 * @param {{ body?: unknown, key?: string }} [init]
		 */
		const product = async (method, pathname, { body, key = state.sk } = {}) => {
			const response = await fetch(`${PRODUCT_URL}${pathname}`, {
				method,
				headers: {
					...(key ? { authorization: `Bearer ${key}` } : {}),
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			const text = await response.text();
			let json = null;
			try {
				json = text ? JSON.parse(text) : null;
			} catch {
				json = null;
			}
			return { status: response.status, json, text, headers: response.headers };
		};
		state.product = product;
		const created = await product('POST', '/v1/inbound-orders', {
			body: {
				externalId: 'EXT-1',
				currency: 'EUR',
				customer: { customerId: 'cus_e2e', email: 'ada@example.com', name: 'Ada' },
				payment: { method: 'bank_transfer' },
				lines: [
					{ itemId: 'itm_e2e', sku: 'LAMP-1', title: 'Desk lamp', quantity: 2, unitAmount: 4500, warranty: { days: 365 } },
				],
			},
		});
		expect(created.status, created.text).toBe(201);
		expect(created.json).toMatchObject({
			number: '000001',
			status: 'pending_payment',
			source: 'api',
			amounts: { total: 9000 },
		});
		state.order = created.json;
		const outbox = await ctx.product.product.outbox.flush();
		expect(outbox.rejected).toBe(0);
		const stored = await portalDb
			.collection('integration_events')
			.findOne({ websiteId: state.websiteId, idempotencyKey: `order.placed:${state.order.id}` });
		expect(stored, 'order.placed@1 in the Portal Event Hub').toBeTruthy();
		expect(JSON.stringify(stored)).not.toContain('ada@example.com');
		const doc = await mongo
			.db(clientDbName)
			.collection('ss_orders_orders')
			.findOne({ websiteId: state.websiteId, id: state.order.id });
		expect(doc).toMatchObject({ merchantId: state.merchantId, env: 'live', customer: { email: 'ada@example.com' } });
		expect((await product('GET', '/v1/orders', { key: undefined })).status).toBe(200);
	});

	it('routes the Checkout’s order.placed@1 through the Event Hub; the order keeps its id in the merchant DB', async () => {
		const { call, state, drain, mongo, clientDbName, clock } = ctx;
		const id = createId('evt');
		const placed = await call('POST', '/v1/events', {
			bearer: state.sk,
			body: {
				events: [
					{
						id,
						type: 'order.placed@1',
						websiteId: state.websiteId,
						env: 'live',
						occurredAt: new Date(clock.now()).toISOString(),
						idempotencyKey: id,
						actor: { type: 'customer', id: 'cus_2' },
						data: {
							orderId: 'ord_e2e_checkout',
							number: 'C-1',
							currency: 'EUR',
							customer: { customerId: 'cus_2' },
							lines: [{ itemId: 'itm_e2e', sku: 'LAMP-1', quantity: 1, unitAmount: 4500 }],
							amounts: { subtotal: 4500, total: 4500 },
						},
					},
				],
			},
		});
		expect(placed.status, JSON.stringify(placed.json)).toBe(202);
		const drained = await drain();
		expect(drained.stats.failed).toBe(0);
		const doc = await mongo
			.db(clientDbName)
			.collection('ss_orders_orders')
			.findOne({ websiteId: state.websiteId, id: 'ord_e2e_checkout' });
		expect(doc).toMatchObject({ source: 'checkout', number: 'C-1', status: 'pending_payment' });
	});

	it('moves an order (orders.status_changed@1) and reports metered usage once', async () => {
		const { state, portalDb } = ctx;
		const moved = await state.product('POST', `/v1/orders/${state.order.id}/transitions`, { body: { status: 'cancelled' } });
		expect(moved.status, moved.text).toBe(200);
		await ctx.product.product.outbox.flush();
		const cancelled = await portalDb
			.collection('integration_events')
			.findOne({ websiteId: state.websiteId, idempotencyKey: `order.cancelled:${state.order.id}` });
		expect(cancelled, 'order.cancelled@1 in the Portal Event Hub').toBeTruthy();
		const flushed = await ctx.product.product.usage.flush();
		expect(flushed.sent + flushed.duplicates).toBeGreaterThanOrEqual(1);
		expect(flushed.rejected).toBe(0);
		expect((await ctx.product.product.usage.flush()).sent).toBe(0);
		state.meteredAt = ctx.clock.now();
	});

	it('settles complete hours: the starter elements are charged, the metered orders booked', async () => {
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
		// starter: lifecycle 200 + fulfilment 100 + serials 50 + invoices 50 + print 50 + customer_updates 0 + ledger 100
		// + inbound_api 0 millicredits per hour
		expect(
			second?.amountMillicredits,
			JSON.stringify(entries.map((/** @type {any} */ e) => [e.type, e.periodKey, e.amountMillicredits])),
		).toBe(-550);
		const meteredHour = Math.floor(state.meteredAt / HOUR) * HOUR;
		const metered = entries.find(
			(/** @type {any} */ entry) =>
				entry.type === 'metered' && entry.periodKey === `${state.subscriptionId}:${iso(meteredHour)}:metered`,
		);
		expect(metered, JSON.stringify(entries.map((/** @type {any} */ e) => [e.type, e.periodKey]))).toBeTruthy();
		// the first 1 000 orders a month are included in starter: booked at zero
		expect(metered.amountMillicredits).toBe(0);
		expect(JSON.stringify(metered.details)).toContain('order');
	});

	it('delivers the real order tracker in the compiled website script after staff upload it ("Upload widgets")', async () => {
		const { call, state } = ctx;
		// `ss pack build` of the product's mode-A modules (headless/ + ui/), uploaded as built
		const pack = await buildPack(ROOT);
		const uploaded = await call('POST', '/v1/admin/packs', { cookie: state.staff, body: { descriptor: descriptorOf(pack) } });
		expect(uploaded.status, JSON.stringify(uploaded.json)).toBe(201);
		expect(uploaded.json).toMatchObject({ appId: state.appId, kind: 'service', status: 'uploading' });
		for (const path of uploaded.json.missing) {
			const asset = /** @type {any} */ (pack.assets.find((a) => a.path === path));
			const put = await call('PUT', `${uploaded.json.uploadPath}${path}`, {
				cookie: state.staff,
				raw: asset.bytes,
				headers: { 'content-type': asset.contentType },
			});
			expect(put.status, `${path}: ${put.text}`).toBe(200);
		}
		await ctx.drain();
		const site = `/v1/merchants/${state.merchantId}/websites/${state.websiteId}`;
		const compiled = await call('POST', `${site}/delivery/compile`, { cookie: state.merchant });
		expect(compiled.status, JSON.stringify(compiled.json)).toBe(200);
		const loader = await call('GET', `/w/${state.websiteId}/loader.js`);
		expect(loader.status).toBe(200);
		const base = `packs/${state.appId}/${uploaded.json.version}`;
		expect(loader.text).toContain(`${base}/headless/orderTracker.js`);
		expect(loader.text).toContain(`${base}/ui/orderTracker.js`);
		expect(loader.text).toContain(ctx.PRODUCT_URL);
		const served = await call('GET', `/w/${base}/ui/orderTracker.js`);
		expect(served.status).toBe(200);
		expect(Buffer.from(served.text)).toEqual(
			/** @type {any} */ (pack.assets.find((a) => a.path === 'ui/orderTracker.js')).bytes,
		);
	});
});
