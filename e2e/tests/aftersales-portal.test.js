/**
 * End to end against the REAL Portal (`@ss/platform/testing`: `createPortal` with every production module), in process, on the test
 * run's MongoMemoryReplSet:
 *
 *   bootstrap staff (password + TOTP) → register this product through the real catalog handshake → activate →
 *   merchant signs up (e-mail verification) → adds a website → registers the website's identity issuer → staff adds
 *   credits → merchant subscribes (starter) → connects a database connector (MongoMemory URI, dev allowlist) → website
 *   sends order.placed@1 and order.completed@1 to the Portal Event Hub → signed deliveries to the product → an eligible
 *   purchase in the merchant's own database → the signed-in customer (the website's own login token, verified offline
 *   from the signed entitlement) lists it and submits a return claim with the pk_ key → staff approve it through the
 *   queue with the sk_ key → the claim events reach the Event Hub → hourly settlement charges credits. Plus the merchant
 *   console's "Try demo".
 *
 * The Portal is served over http on 127.0.0.1 (allowed outside production); the product over https on localhost with a
 * throw-away certificate trusted for this process only (the manifest's `endpoints.base` must be https).
 * System test (the `e2e/` workspace): it runs the Portal (`@ss/platform/testing`) and the product (`@ss/product-aftersales/serve`).
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
import { createTestIdentityIssuer } from '@ss/app-kit/testing';
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
} from '@ss/platform/testing';
import { ROOT, loadManifest, startServer } from '@ss/product-aftersales/serve';
import { CONNECT_SECRET, connectProduct, createClock, mongoUri } from './helpers.js';

const HOUR = 3_600_000;
const STAFF = { email: 'root@portal.test', password: 'staff password 123!' };
const MERCHANT_USER = { email: 'owner@shop.example.com', password: 'merchant password 123!' };
const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];
const ISSUER = createTestIdentityIssuer({ alg: 'ES256', audience: 'shop-web' });

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
	const work = await mkdtemp(path.join(tmpdir(), 'ss-aftersales-e2e-'));
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
			STAFF_SESSION_IDLE_MINUTES: '720',
		},
		// keys and secrets as the Portal generates them on first start; the URL as recorded at /setup
		testSystemState({ portalUrl: PORTAL_URL }),
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

describe.skipIf(!hasOpenssl)('After-sales on the real Portal', () => {
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

	it('connects the product with its connect secret and lists it after activation', async () => {
		const { call, state, PRODUCT_URL } = ctx;
		// Admin → Apps → Add product: the product URL and its connect secret
		const registered = await connectProduct(call, state.staff, PRODUCT_URL);
		expect(registered.status, JSON.stringify(registered.json)).toBe(201);
		expect(registered.json).toMatchObject({ slug: 'aftersales', kind: 'service', status: 'pending', currentVersion: 1 });
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
		const listed = catalog.json.items.find((/** @type {any} */ item) => item.slug === 'aftersales');
		expect(listed).toMatchObject({ appId: state.appId });
		expect(listed.elements.map((/** @type {any} */ element) => element.key)).toEqual([
			'claims',
			'photos',
			'queue',
			'refunds',
			'restock',
			'serial_registry',
			'messages',
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
		// the website's own customer login (bring-your-own identity): public keys only, inline
		const issuer = await call('PUT', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/identity`, {
			cookie: state.merchant,
			body: {
				issuer: ISSUER.section.issuer,
				publicJwks: ISSUER.section.jwks,
				audience: 'shop-web',
				claimMap: { subject: 'sub' },
			},
		});
		expect(issuer.status, JSON.stringify(issuer.json)).toBe(200);
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
		expect(subscribed.json.subscription).toMatchObject({ status: 'active', planCode: 'starter', productSlug: 'aftersales' });
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

	it('routes order.placed@1 and order.completed@1 through the Event Hub to an eligible purchase in the merchant DB', async () => {
		const { call, state, drain, mongo, clientDbName, clock } = ctx;
		/** @param {string} type @param {Record<string, unknown>} data */
		const envelope = (type, data) => {
			const id = createId('evt');
			return {
				id,
				type,
				websiteId: state.websiteId,
				env: 'live',
				occurredAt: new Date(clock.now()).toISOString(),
				idempotencyKey: id,
				actor: { type: 'staff', id: 'stf_e2e' },
				data,
			};
		};
		const sent = await call('POST', '/v1/events', {
			bearer: state.sk,
			body: {
				events: [
					envelope('order.placed@1', {
						orderId: 'ord_e2e_1',
						number: 'E2E-1',
						customer: { customerId: 'cus_e2e', email: 'buyer@shop.example.com' },
						currency: 'USD',
						lines: [{ itemId: 'itm_e2e', sku: 'SKU-E2E', title: 'E2E phone case', quantity: 1, unitAmount: 2500 }],
						amounts: { subtotal: 2500, total: 2500 },
					}),
				],
			},
		});
		expect(sent.status, JSON.stringify(sent.json)).toBe(202);
		expect((await drain()).stats.dead).toBe(0);
		const completed = await call('POST', '/v1/events', {
			bearer: state.sk,
			body: { events: [envelope('order.completed@1', { orderId: 'ord_e2e_1' })] },
		});
		expect(completed.json.results[0].status, JSON.stringify(completed.json)).toBe('accepted');
		const drained = await drain();
		expect(drained.stats.dead).toBe(0);
		const purchase = await mongo
			.db(clientDbName)
			.collection('ss_aftersales_purchases')
			.findOne({ websiteId: state.websiteId, orderId: 'ord_e2e_1' });
		expect(purchase).toMatchObject({ status: 'delivered', customerId: 'cus_e2e', merchantId: state.merchantId, env: 'live' });
		expect(purchase?.lines.map((/** @type {any} */ line) => line.itemId)).toEqual(['itm_e2e']);
		state.purchaseId = purchase?.id;
		// the Portal stored routing metadata only — no payloads
		const deliveries = await call('GET', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/deliveries`, {
			cookie: state.merchant,
		});
		expect(JSON.stringify(deliveries.json)).not.toContain('SKU-E2E');
	});

	it('lets the signed-in customer claim with the pk_ key and their own login token; staff move it through the queue', async () => {
		const { call, state, clock, mongo, clientDbName, PRODUCT_URL } = ctx;
		const keys = await call('POST', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/keys`, {
			cookie: state.merchant,
			body: { kind: 'pk', scopes: ['elements.read'] },
		});
		expect(keys.status, JSON.stringify(keys.json)).toBe(201);
		const pk = keys.json.key;
		const now = Math.floor(clock.now() / 1000);
		const login = ISSUER.sign({ iss: ISSUER.section.issuer, aud: 'shop-web', sub: 'cus_e2e', iat: now, exp: now + 600 });
		const browser = { authorization: `Bearer ${pk}`, origin: 'https://shop.example.com', 'ss-identity': login };
		const purchases = await (await fetch(`${PRODUCT_URL}/v1/purchases`, { headers: browser })).json();
		expect(purchases.items).toHaveLength(1);
		expect(purchases.items[0]).toMatchObject({ id: state.purchaseId, canClaim: true });
		expect(purchases.items[0].lines[0].windows.return.eligible).toBe(true);
		const submitted = await fetch(`${PRODUCT_URL}/v1/claims`, {
			method: 'POST',
			headers: { ...browser, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
			body: JSON.stringify({
				purchaseId: state.purchaseId,
				type: 'return',
				reason: 'defective',
				details: 'It cracked on day two.',
				lines: [{ lineId: 'itm_e2e', quantity: 1 }],
			}),
		});
		const claim = await submitted.json();
		expect(submitted.status, JSON.stringify(claim)).toBe(201);
		expect(claim).toMatchObject({ type: 'return', status: 'requested', statusLabel: 'Requested' });
		// a forged login token is refused
		const forged = createTestIdentityIssuer({ alg: 'ES256' }).sign({
			iss: ISSUER.section.issuer,
			aud: 'shop-web',
			sub: 'cus_e2e',
			iat: now,
			exp: now + 600,
		});
		const refused = await fetch(`${PRODUCT_URL}/v1/claims`, { headers: { ...browser, 'ss-identity': forged } });
		expect(refused.status).toBe(401);
		const server = { authorization: `Bearer ${state.sk}`, 'content-type': 'application/json' };
		const moved = await fetch(`${PRODUCT_URL}/v1/queue/${claim.id}/transition`, {
			method: 'POST',
			headers: { ...server, 'idempotency-key': randomUUID() },
			body: JSON.stringify({ to: 'approved', note: 'Send it back.' }),
		});
		expect(moved.status).toBe(200);
		expect(await moved.json()).toMatchObject({ status: 'approved', nextStatuses: ['received', 'rejected'] });
		const stored = await mongo
			.db(clientDbName)
			.collection('ss_aftersales_claims')
			.findOne({ websiteId: state.websiteId, id: claim.id });
		expect(stored).toMatchObject({ status: 'approved', orderId: 'ord_e2e_1', merchantId: state.merchantId });
		// the claim events reach the Portal Event Hub
		await ctx.product.product.flush();
		expect(await ctx.product.product.outbox.stats()).toMatchObject({ pending: 0, dead: 0 });
		const mine = await (await fetch(`${PRODUCT_URL}/v1/claims/${claim.id}`, { headers: browser })).json();
		expect(mine).toMatchObject({ status: 'approved' });
		expect(mine.notes).toBeUndefined();
	});

	it('settles complete hours: the subscription is charged in credits', async () => {
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
		const settlements = statement.json.entries.filter(
			(/** @type {any} */ entry) => entry.type === 'settlement' && entry.subscriptionId === state.subscriptionId,
		);
		const iso = (/** @type {any} */ ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
		const second = settlements.find(
			(/** @type {any} */ entry) => entry.periodKey === `${state.subscriptionId}:${iso(hour0 + HOUR)}`,
		);
		// starter: claims 300 + queue 200 millicredits per hour
		expect(
			second?.amountMillicredits,
			JSON.stringify({
				entries: statement.json.entries.map((/** @type {any} */ e) => [e.type, e.periodKey, e.amountMillicredits]),
			}),
		).toBe(-500);
		expect(settlements.some((/** @type {any} */ entry) => entry.periodKey === `${state.subscriptionId}:${iso(hour0)}`)).toBe(
			true,
		);
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
