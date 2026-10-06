/**
 * End to end against the REAL Portal (`@ss/platform/testing`: `createPortal` with every production module), in process, on the test
 * run's MongoMemoryReplSet:
 *
 *   bootstrap staff (password + TOTP) → register this product through the real catalog handshake → activate →
 *   merchant signs up (e-mail verification) → adds a website → staff adds credits → merchant subscribes (starter) →
 *   connects a database connector (MongoMemory URI, dev allowlist) → the merchant's server creates a standalone
 *   configurator (sk_) → the website sends item.created@1 + inventory.changed@1 to the Portal Event Hub → signed
 *   delivery to the product → the item lands in the merchant's own database → a catalog-linked configurator resolves
 *   against the live stock from the browser (pk_, origin-bound) → evaluations reported as metered usage once →
 *   hourly settlement charges the base price. Plus the merchant console's "Try demo" launch.
 *
 * The Portal is served over http on 127.0.0.1 (allowed outside production); the product over https on localhost with a
 * throw-away certificate trusted for this process only (the manifest's `endpoints.base` must be https).
 * System test (the `e2e/` workspace): it runs the Portal (`@ss/platform/testing`) and the product (`@ss/product-configurator/serve`).
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
import { ROOT, loadManifest, startServer } from '@ss/product-configurator/serve';
import { connectProduct, createClock, mongoUri, postSetup } from './helpers.js';

const HOUR = 3_600_000;
const STAFF = { email: 'root@portal.test', password: 'staff password 123!' };
const MERCHANT_USER = { email: 'owner@shop.example.com', password: 'merchant password 123!' };
const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];
const ORIGIN = 'https://shop.example.com';

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
	const work = await mkdtemp(path.join(tmpdir(), 'ss-configurator-e2e-'));
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
	/**
	 * A call to the product over https (website keys; browser keys send the website's origin).
	 * @param {string} method
	 * @param {string} pathname
	 * @param {{ key: string, body?: unknown, browser?: boolean }} init
	 */
	const productCall = async (method, pathname, { key: bearer, body, browser = false }) => {
		const response = await fetch(`${PRODUCT_URL}${pathname}`, {
			method,
			headers: {
				authorization: `Bearer ${bearer}`,
				...(browser ? { origin: ORIGIN } : {}),
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
				...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const text = await response.text();
		return { status: response.status, json: text ? JSON.parse(text) : null };
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
		productCall,
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

describe.skipIf(!hasOpenssl)('Configurator Builder on the real Portal', () => {
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

	it('connects the product with a connection code and lists it after activation', async () => {
		const { call, state, PRODUCT_URL } = ctx;
		// Admin → Apps → Add product: a one-time code, pasted into the product's /setup
		const registered = await connectProduct(call, state.staff, PRODUCT_URL);
		expect(registered.status, JSON.stringify(registered.json)).toBe(201);
		expect(registered.json).toMatchObject({ slug: 'configurator', kind: 'service', status: 'pending', currentVersion: 1 });
		state.appId = registered.json.appId;
		const activated = await call('POST', `/v1/admin/apps/${state.appId}/lifecycle`, {
			cookie: state.staff,
			body: { action: 'activate' },
		});
		expect(activated.json.status).toBe('active');
		const catalog = await call('GET', '/v1/catalog/products');
		const listed = catalog.json.items.find((/** @type {any} */ item) => item.slug === 'configurator');
		expect(listed).toMatchObject({ appId: state.appId });
		expect(listed.elements.map((/** @type {any} */ element) => element.key)).toEqual([
			'schema',
			'resolver',
			'price_deltas',
			'url_sync',
			'widget',
			'api',
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
		expect(subscribed.json.subscription).toMatchObject({ status: 'active', planCode: 'starter', productSlug: 'configurator' });
		state.subscriptionId = subscribed.json.subscription.subscriptionId;
		state.subscribedAt = ctx.clock.now();
	});

	it('connects the merchant’s database and issues website keys', async () => {
		const { call, state, clientDbName, drain } = ctx;
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

	it('creates a standalone configurator from the merchant’s server and resolves it from the browser', async () => {
		const { state, productCall, mongo, clientDbName } = ctx;
		const created = await productCall('POST', '/v1/configurators', {
			key: state.sk,
			body: {
				key: 'team-plan',
				name: 'Team plan',
				status: 'published',
				groups: [
					{ key: 'plan', options: [{ key: 'team' }, { key: 'business' }] },
					{ key: 'seats', type: 'range', min: 1, max: 50, required: true, default: 5 },
				],
				rules: [{ id: 'team-max', when: "selection.plan == 'team' and selection.seats > 20" }],
			},
		});
		expect(created.status, JSON.stringify(created.json)).toBe(201);
		const stored = await mongo
			.db(clientDbName)
			.collection('ss_configurator_configurators')
			.findOne({ websiteId: state.websiteId, key: 'team-plan' });
		expect(stored).toMatchObject({ status: 'published', merchantId: state.merchantId, env: 'live' });
		const evaluation = await productCall('POST', '/v1/evaluations', {
			key: state.pk,
			browser: true,
			body: { configurator: 'team-plan', selection: { plan: 'team', seats: 35 }, changed: 'plan', search: '?ref=ad' },
		});
		expect(evaluation.status, JSON.stringify(evaluation.json)).toBe(200);
		expect(evaluation.json).toMatchObject({
			selection: { plan: 'team', seats: 20 },
			adjusted: [{ group: 'seats', from: 35, to: 20, reason: 'conflict' }],
			url: { search: '?ref=ad&plan=team&seats=20' },
			price: null,
		});
		// browser keys are bound to the website's domain
		const foreign = await fetch(`${ctx.PRODUCT_URL}/v1/evaluations`, {
			method: 'POST',
			headers: { authorization: `Bearer ${state.pk}`, origin: 'https://evil.example.net', 'content-type': 'application/json' },
			body: JSON.stringify({ configurator: 'team-plan' }),
		});
		expect(foreign.status).toBe(403);
	});

	it('routes item.created@1 and inventory.changed@1 through the Event Hub into the merchant database (catalog link)', async () => {
		const { call, state, drain, clock, productCall, mongo, clientDbName } = ctx;
		const envelope = (/** @type {string} */ type, /** @type {Record<string, unknown>} */ data) => {
			const id = createId('evt');
			return {
				id,
				type,
				websiteId: state.websiteId,
				env: 'live',
				occurredAt: new Date(clock.now()).toISOString(),
				idempotencyKey: id,
				actor: { type: 'merchant', id: 'catalog-sync' },
				data,
			};
		};
		const created = envelope('item.created@1', {
			itemId: 'itm_phone',
			title: 'Phone',
			status: 'active',
			currency: 'EUR',
			variants: [
				{
					variantId: 'ph-128-bk',
					sku: 'PH-128-BK',
					attributes: { storage: '128', color: 'Black' },
					price: 49900,
					inventory: 0,
				},
				{
					variantId: 'ph-256-bk',
					sku: 'PH-256-BK',
					attributes: { storage: '256', color: 'Black' },
					price: 59900,
					inventory: 4,
				},
				{
					variantId: 'ph-128-wh',
					sku: 'PH-128-WH',
					attributes: { storage: '128', color: 'White' },
					price: 49900,
					inventory: 2,
				},
			],
		});
		const accepted = await call('POST', '/v1/events', { bearer: state.sk, body: { events: [created] } });
		expect(accepted.status, JSON.stringify(accepted.json)).toBe(202);
		expect(accepted.json.results[0].status).toBe('accepted');
		expect((await drain()).stats.dead).toBe(0);
		clock.advance(1000);
		const restock = envelope('inventory.changed@1', {
			itemId: 'itm_phone',
			variantId: 'ph-128-bk',
			quantity: 3,
			previousQuantity: 0,
		});
		expect((await call('POST', '/v1/events', { bearer: state.sk, body: { events: [restock] } })).json.results[0].status).toBe(
			'accepted',
		);
		expect((await drain()).stats.dead).toBe(0);
		const item = await mongo
			.db(clientDbName)
			.collection('ss_configurator_items')
			.findOne({ websiteId: state.websiteId, itemId: 'itm_phone' });
		expect(item).toMatchObject({ title: 'Phone', currency: 'EUR', merchantId: state.merchantId });
		expect(
			(await productCall('GET', '/v1/catalog-items/itm_phone', { key: state.sk })).json.variants.map(
				(/** @type {any} */ v) => v.stock,
			),
		).toEqual([3, 4, 2]);
		const linked = await productCall('POST', '/v1/configurators', {
			key: state.sk,
			body: {
				key: 'phone',
				name: 'Phone',
				status: 'published',
				source: { type: 'catalog', itemId: 'itm_phone' },
				groups: [{ key: 'storage' }, { key: 'color', display: 'swatches' }],
			},
		});
		expect(linked.status, JSON.stringify(linked.json)).toBe(201);
		const widget = await productCall('GET', `/v1/widgets/phone?search=${encodeURIComponent('?color=White&storage=256')}`, {
			key: state.pk,
			browser: true,
		});
		expect(widget.status, JSON.stringify(widget.json)).toBe(200);
		expect(
			widget.json.configurator.schema.groups.map((/** @type {any} */ g) => g.options.map((/** @type {any} */ o) => o.key)),
		).toEqual([
			['128', '256'],
			['Black', 'White'],
		]);
		expect(widget.json.evaluation).toMatchObject({
			// no pick was just made, so the earlier group keeps its value: the closest combination changes the colour
			selection: { storage: '256', color: 'Black' },
			combination: { id: 'ph-256-bk', sku: 'PH-256-BK', inStock: true },
		});
		const evaluation = await productCall('POST', '/v1/evaluations', {
			key: state.pk,
			browser: true,
			body: { configurator: 'phone', selection: { storage: '128', color: 'Black' } },
		});
		expect(evaluation.json).toMatchObject({ exact: true, inStock: true, combination: { id: 'ph-128-bk' } });
	});

	it('reports evaluations as metered usage once and settles complete hours (base price)', async () => {
		const { call, state, clock, product } = ctx;
		const flushed = await product.product.usage.flush();
		expect(flushed.rejected).toBe(0);
		expect(flushed.sent + flushed.duplicates).toBeGreaterThanOrEqual(1);
		const usage = await ctx.portalDb.collection('commerce_usage').find({ subscriptionId: state.subscriptionId }).toArray();
		const evaluations = usage.filter((/** @type {any} */ record) => record.unit === 'evaluation');
		expect(evaluations.reduce((/** @type {number} */ sum, /** @type {any} */ record) => sum + record.quantity, 0)).toBe(3);
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
		// starter: schema 100 + resolver 150 + url_sync 0 + widget 150 + api 50 millicredits per hour
		expect(
			settlements.find((/** @type {any} */ e) => e.periodKey === `${state.subscriptionId}:${iso(hour0 + HOUR)}`)
				?.amountMillicredits,
			entries,
		).toBe(-450);
		// 3 evaluations are inside the starter's 10 000 included per hour: nothing metered is charged
		const metered = settlements.filter((/** @type {any} */ e) => String(e.periodKey).endsWith(':metered'));
		expect(
			metered.every((/** @type {any} */ e) => e.amountMillicredits === 0),
			entries,
		).toBe(true);
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
