/**
 * End to end against the REAL Portal (`@ss/platform/testing`: `createPortal` with every production module), in process, on the test
 * run's MongoMemoryReplSet:
 *
 *   bootstrap staff (password + TOTP) → register this product through the real catalog handshake → activate →
 *   merchant signs up (e-mail verification) → adds a website → staff adds credits → merchant subscribes (starter) →
 *   connects a database connector (MongoMemory URI, dev allowlist) → the website's catalog sends item.created@1 to the
 *   Portal Event Hub → signed delivery to the product → the item and the tiers its variants name are stored in the
 *   merchant's own database → the browser (pk_) reads badges, filter options, warranty and the schema.org condition;
 *   the server (sk_) grades a standalone unit → grades.tier_assigned@1 reaches the Portal → hourly settlement charges
 *   credits. Plus the merchant console's "Try demo".
 *
 * The Portal is served over http on 127.0.0.1 (allowed outside production); the product over https on localhost with a
 * throw-away certificate trusted for this process only (the manifest's `endpoints.base` must be https).
 * System test (the `e2e/` workspace): it runs the Portal (`@ss/platform/testing`) and the product (`@ss/product-grades/serve`).
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
} from '@ss/platform/testing';
import { ROOT, loadManifest, startServer } from '@ss/product-grades/serve';
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
	const work = await mkdtemp(path.join(tmpdir(), 'ss-grades-e2e-'));
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

describe.skipIf(!hasOpenssl)('Grade & Condition System on the real Portal', () => {
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
		expect(registered.json).toMatchObject({ slug: 'grades', kind: 'service', status: 'pending', currentVersion: 1 });
		state.appId = registered.json.appId;
		const versions = await call('GET', `/v1/admin/apps/${state.appId}/versions`, { cookie: state.staff });
		expect(versions.json.items[0]).toMatchObject({ version: 1, status: 'accepted' });
		const activated = await call('POST', `/v1/admin/apps/${state.appId}/lifecycle`, {
			cookie: state.staff,
			body: { action: 'activate' },
		});
		expect(activated.json.status).toBe('active');
		const catalog = await call('GET', '/v1/catalog/products');
		const listed = catalog.json.items.find((/** @type {any} */ item) => item.slug === 'grades');
		expect(listed).toMatchObject({ appId: state.appId });
		expect(listed.elements.map((/** @type {any} */ element) => element.key)).toEqual([
			'tiers',
			'showcase',
			'filters',
			'warranty',
			'mapping',
			'inspection',
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
		const subscribed = await call('POST', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/subscriptions`, {
			cookie: state.merchant,
			body: { appId: state.appId, planCode: 'starter' },
		});
		expect(subscribed.status, JSON.stringify(subscribed.json)).toBe(201);
		expect(subscribed.json.subscription).toMatchObject({ status: 'active', planCode: 'starter', productSlug: 'grades' });
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
		const sk = await call('POST', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/keys`, {
			cookie: state.merchant,
			body: { kind: 'sk', scopes: ['events.*'] },
		});
		expect(sk.status, JSON.stringify(sk.json)).toBe(201);
		state.sk = sk.json.key;
		const pk = await call('POST', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/keys`, {
			cookie: state.merchant,
			body: { kind: 'pk', scopes: ['elements.read'] },
		});
		expect(pk.status, JSON.stringify(pk.json)).toBe(201);
		state.pk = pk.json.key;
		const drained = await drain();
		expect(drained.stats.dead).toBe(0);
	});

	it('routes item.created@1 through the Event Hub: the catalog attribute grades the variants in the merchant DB', async () => {
		const { call, state, drain, mongo, clientDbName, clock } = ctx;
		const id = createId('evt');
		const sent = await call('POST', '/v1/events', {
			bearer: state.sk,
			body: {
				events: [
					{
						id,
						type: 'item.created@1',
						websiteId: state.websiteId,
						env: 'live',
						occurredAt: new Date(clock.now()).toISOString(),
						idempotencyKey: id,
						actor: { type: 'merchant', id: 'catalog-sync' },
						data: {
							itemId: 'itm_e2e',
							title: 'E2E jacket',
							status: 'active',
							collections: ['outerwear'],
							currency: 'EUR',
							variants: [
								{ variantId: 'var_like_new', sku: 'J-1', attributes: { tier: 'Excellent' }, price: 12000 },
								{ variantId: 'var_worn', sku: 'J-2', attributes: { tier: 'fair' }, price: 6000 },
							],
						},
					},
				],
			},
		});
		expect(sent.status, JSON.stringify(sent.json)).toBe(202);
		expect(sent.json.results[0].status, JSON.stringify(sent.json)).toBe('accepted');
		const drained = await drain();
		expect(drained.stats.succeeded).toBeGreaterThanOrEqual(1);
		expect(drained.stats.dead).toBe(0);
		const clientDb = mongo.db(clientDbName);
		const item = await clientDb.collection('ss_grades_items').findOne({ websiteId: state.websiteId, itemId: 'itm_e2e' });
		expect(item).toMatchObject({
			known: true,
			title: 'E2E jacket',
			tiers: ['excellent', 'fair'],
			merchantId: state.merchantId,
		});
		const assignments = await clientDb
			.collection('ss_grades_assignments')
			.find({ websiteId: state.websiteId, itemId: 'itm_e2e' })
			.toArray();
		expect(assignments.map((/** @type {any} */ row) => [row.variantId, row.tier, row.source]).sort()).toEqual([
			['var_like_new', 'excellent', 'catalog'],
			['var_worn', 'fair', 'catalog'],
		]);
	});

	it('serves badges, filters, warranty and the schema.org condition to the browser (pk_) and grades a unit (sk_)', async () => {
		const { state, PRODUCT_URL } = ctx;
		const browser = { authorization: `Bearer ${state.pk}`, origin: 'https://shop.example.com' };
		const badges = await (await fetch(`${PRODUCT_URL}/v1/items/itm_e2e`, { headers: browser })).json();
		expect(badges.variants.map((/** @type {any} */ v) => [v.variantId, v.tier.label])).toEqual([
			['var_like_new', 'Excellent'],
			['var_worn', 'Fair'],
		]);
		const filters = await (await fetch(`${PRODUCT_URL}/v1/tier-filters?collection=outerwear`, { headers: browser })).json();
		expect(filters.options.map((/** @type {any} */ o) => [o.key, o.count])).toEqual([
			['excellent', 1],
			['fair', 1],
		]);
		const warranty = await (await fetch(`${PRODUCT_URL}/v1/warranty/excellent`, { headers: browser })).json();
		expect(warranty).toMatchObject({ tier: 'excellent', periodText: 'No warranty' });
		// the Loader element stub's action (ss-element-stub@2) answers the next view model with the Portal-issued pk_
		const stubCtx = encodeURIComponent(JSON.stringify({ path: '/p/jacket', itemId: 'itm_e2e' }));
		const selected = await fetch(`${PRODUCT_URL}/v1/elements/warranty/actions/select?ctx=${stubCtx}`, {
			method: 'POST',
			headers: { ...browser, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
			body: JSON.stringify({ fields: { tier: 'excellent' } }),
		});
		const stub = await selected.json();
		expect(selected.status, JSON.stringify(stub)).toBe(200);
		expect(stub.items).toEqual([{ text: expect.stringMatching(/^Excellent: No warranty/) }]);
		expect(stub.actions).toEqual([{ action: 'select', label: 'Show' }]);
		const stubOff = await fetch(`${PRODUCT_URL}/v1/elements/inspection/actions/refresh`, {
			method: 'POST',
			headers: { ...browser, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
			body: '{}',
		});
		expect(stubOff.status).toBe(403); // the inspection add-on is off on starter
		const conditions = await (await fetch(`${PRODUCT_URL}/v1/condition-mappings/items/itm_e2e`, { headers: browser })).json();
		expect(conditions.variants[0].offer).toEqual({ itemCondition: 'https://schema.org/UsedCondition' });
		// the browser key cannot write; the server key grades a standalone unit of an external id
		const refused = await fetch(`${PRODUCT_URL}/v1/units`, {
			method: 'POST',
			headers: { ...browser, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
			body: JSON.stringify({ itemId: 'erp:4711', tier: 'good' }),
		});
		expect(refused.status).toBe(403);
		const unit = await fetch(`${PRODUCT_URL}/v1/units`, {
			method: 'POST',
			headers: { authorization: `Bearer ${state.sk}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
			body: JSON.stringify({ itemId: 'erp:4711', serial: 'SN-E2E-1', tier: 'good' }),
		});
		const created = await unit.json();
		expect(unit.status, JSON.stringify(created)).toBe(201);
		expect(created).toMatchObject({ itemId: 'erp:4711', serial: 'SN-E2E-1', tier: 'good' });
		// inspection is an add-on on starter: switched off in every mode
		const inspections = await fetch(`${PRODUCT_URL}/v1/checklists`, { headers: { authorization: `Bearer ${state.sk}` } });
		expect(inspections.status).toBe(403);
		// the product's own events reach the Portal (durable outbox)
		await ctx.product.product.flush();
		const outbox = await ctx.product.product.outbox.stats();
		expect(outbox, JSON.stringify(outbox)).toMatchObject({ pending: 0, dead: 0 });
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
		// starter: tiers 200 + filters 0 + warranty 0 + mapping 0 millicredits per hour
		expect(
			second?.amountMillicredits,
			JSON.stringify(statement.json.entries.map((/** @type {any} */ e) => [e.type, e.periodKey, e.amountMillicredits])),
		).toBe(-200);
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
