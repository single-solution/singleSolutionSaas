/**
 * End to end against the REAL Portal (`@ss/platform/testing`: `createPortal` with every production module), in process, on the test
 * run's MongoMemoryReplSet:
 *
 *   first admin from the sign-in page (password, then TOTP) → register this product through the real catalog handshake → activate →
 *   merchant signs up (e-mail verification) → adds a website → registers the website's identity issuer → staff adds
 *   credits → merchant subscribes (starter) → connects a database connector (MongoMemory URI, dev allowlist) → website
 *   sends order.completed@1 to the Portal Event Hub → signed delivery to the product → review request in the merchant's
 *   own database → the verified customer (the website's own login token, verified offline from the signed entitlement)
 *   submits a review with the pk_ key → auto-approved by the default rules@1 rule → rating summary and Product JSON-LD
 *   reflect it → usage (`review`) reported → the billing is read (usage is never charged, PLAN 0.5.3). Plus the widgets: staff upload the
 *   `ss pack build` output ("Upload widgets") and the compiled website script mounts the real reviews widget, bound to
 *   the product's base URL.
 *
 * The Portal is served over http on 127.0.0.1 (allowed outside production); the product over https on localhost with a
 * throw-away certificate trusted for this process only (the manifest's `endpoints.base` must be https).
 * System test (the `e2e/` workspace): it runs the Portal (`@ss/platform/testing`) and the product (`@ss/product-reviews`
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
import { createTestIdentityIssuer } from '@ss/app-kit/testing';
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
} from '@ss/platform/testing';
import { buildPack, descriptorOf } from '@ss/cli/pack';
import { createPlatform, loadManifest } from '@ss/product-reviews/platform';
import { buildRoutes, createReviews, wireEvents } from '@ss/product-reviews/routes';
import {
	CONNECT_SECRET,
	connectProduct,
	createClock,
	mongoUri,
	productRoot,
	startProduct,
	LONG_SESSIONS,
	PORTAL_ENCRYPTION_KEY,
} from './helpers.js';

const ROOT = productRoot('@ss/product-reviews');

const HOUR = 3_600_000;
const STAFF = { email: 'root@portal.test', password: 'staff password 123!' };
const MERCHANT_USER = { email: 'owner@shop.example.com', password: 'merchant password 123!' };
const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];
const ISSUER = createTestIdentityIssuer({ alg: 'ES256', audience: 'shop-web' });
const BODY = 'Arrived quickly and works perfectly. Would buy again.';

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
	const work = await mkdtemp(path.join(tmpdir(), 'ss-reviews-e2e-'));
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
			PORTAL_URL,
			ENCRYPTION_KEY: PORTAL_ENCRYPTION_KEY,
			OUTBOUND_DEV_ALLOW_HOSTS: LOCAL_HOSTS.join(','),
			STORAGE_DIR: ':memory:',
		},
		// keys and secrets as the Portal generates them on first start
		testSystemState(),
		// long sign-ins for the scripted clock
		{
			overrides: {
				sessions: LONG_SESSIONS,
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
	const reviews = wireEvents(
		createReviews(
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
		product: reviews.product,
		routes: buildRoutes(reviews),
		close: () => reviews.app.close(),
		tls: { key, cert },
		port: productPort,
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

describe.skipIf(!hasOpenssl)('Reviews & Ratings on the real Portal', () => {
	it('creates the first admin from the sign-in page, then signs in and turns on TOTP', async () => {
		const { call, clock, state } = ctx;
		const created = await call('POST', '/v1/auth/first-admin', {
			body: { name: 'E2E Owner', email: STAFF.email, password: STAFF.password },
		});
		expect(created.status, JSON.stringify(created.json)).toBe(201);
		const start = await call('POST', '/v1/me/two-step/start', { cookie: created.cookie ?? '' });
		clock.advance(30_000);
		const confirm = await call('POST', '/v1/me/two-step/confirm', {
			cookie: created.cookie ?? '',
			body: { code: totpCode(start.json.secret, clock.now()) },
		});
		expect(confirm.status, JSON.stringify(confirm.json)).toBe(200);
		state.staff = created.cookie;
	});

	it('connects the product with its connect secret and lists it after activation', async () => {
		const { call, state, PRODUCT_URL } = ctx;
		// Admin → Apps → Add product: the product URL and its connect secret
		const registered = await connectProduct(call, state.staff, PRODUCT_URL);
		expect(registered.status, JSON.stringify(registered.json)).toBe(201);
		expect(registered.json).toMatchObject({ slug: 'reviews', kind: 'service', status: 'inactive', currentVersion: 1 });
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
		const listed = catalog.json.items.find((/** @type {any} */ item) => item.slug === 'reviews');
		expect(listed).toMatchObject({ appId: state.appId });
		expect(listed.elements.map((/** @type {any} */ element) => element.key)).toEqual([
			'collection',
			'request_flow',
			'moderation',
			'content',
			'photos',
			'display',
			'structured_data',
			'qna',
			'import',
			'analytics',
		]);
	});

	it('lets a merchant sign up, add a website, receive credits and subscribe', async () => {
		const { call, state } = ctx;
		const madeMerchant = await call('POST', '/v1/admin/merchants', {
			cookie: state.staff,
			body: { name: 'Shop', ownerName: 'Shop Owner', email: MERCHANT_USER.email },
		});
		expect(madeMerchant.status, JSON.stringify(madeMerchant.json)).toBe(201);
		state.merchantId = madeMerchant.json.merchant.merchantId;
		const setupLink = await call('POST', `/v1/admin/merchants/${state.merchantId}/setup-link`, {
			cookie: state.staff,
			body: { copy: true },
		});
		const verified = await call('POST', '/v1/auth/set-password', {
			body: {
				token: decodeURIComponent(String(setupLink.json.link).split('#token=')[1] ?? ''),
				password: MERCHANT_USER.password,
			},
		});
		expect(verified.status, JSON.stringify(verified.json)).toBe(200);
		state.merchant = verified.cookie;
		const website = await call('POST', `/v1/merchants/${state.merchantId}/websites`, {
			cookie: state.staff,
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
		const credits = await call('POST', `/v1/admin/merchants/${state.merchantId}/receipts`, {
			cookie: state.staff,
			body: { credits: 100, amountPaid: 'PKR 10,000', method: 'Bank transfer', reference: 'e2e-topup-1' },
		});
		expect(credits.status, JSON.stringify(credits.json)).toBe(201);
		expect(credits.json.summary.balance).toBe(100_000);
		const subscribed = await call('POST', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/subscriptions`, {
			cookie: state.staff,
			body: { appId: state.appId, planCode: 'starter' },
		});
		expect(subscribed.status, JSON.stringify(subscribed.json)).toBe(201);
		expect(subscribed.json.subscription).toMatchObject({ status: 'active', planCode: 'starter', productSlug: 'reviews' });
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

	it('routes order.completed@1 through the Event Hub to a review request in the merchant DB', async () => {
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
						actor: { type: 'customer', id: 'cus_e2e' },
						data: {
							orderId: 'ord_e2e_1',
							number: 'E2E-1',
							customer: { customerId: 'cus_e2e', email: 'buyer@shop.example.com' },
							currency: 'USD',
							lines: [{ itemId: 'itm_e2e', sku: 'SKU-E2E', title: 'E2E phone case', quantity: 1, unitAmount: 2500 }],
						},
					},
				],
			},
		});
		expect(completed.status, JSON.stringify(completed.json)).toBe(202);
		expect(completed.json.results[0].status, JSON.stringify(completed.json)).toBe('accepted');
		const drained = await drain();
		expect(drained.stats.succeeded).toBeGreaterThanOrEqual(1);
		expect(drained.stats.failed).toBe(0);
		const clientDb = mongo.db(clientDbName);
		const request = await clientDb
			.collection('ss_reviews_requests')
			.findOne({ websiteId: state.websiteId, orderId: 'ord_e2e_1' });
		expect(request).toMatchObject({ status: 'open', customerId: 'cus_e2e', merchantId: state.merchantId, env: 'live' });
		expect(request?.items.map((/** @type {any} */ item) => item.itemId)).toEqual(['itm_e2e']);
		// the Portal stored routing metadata only — no payloads
		const deliveries = await ctx.portalDb.collection('integration_deliveries').find({ websiteId: state.websiteId }).toArray();
		expect(deliveries.length).toBeGreaterThan(0);
		expect(JSON.stringify(deliveries)).not.toContain('SKU-E2E');
	});

	it('lets the verified customer review with the pk_ key and their own login token; auto-approved; summary and JSON-LD follow', async () => {
		const { call, state, clock, mongo, clientDbName, PRODUCT_URL } = ctx;
		const keys = await call('POST', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/keys`, {
			cookie: state.merchant,
			body: { kind: 'pk', scopes: ['elements.read'] },
		});
		expect(keys.status, JSON.stringify(keys.json)).toBe(201);
		const pk = keys.json.key;
		const now = Math.floor(clock.now() / 1000);
		const login = ISSUER.sign({ iss: ISSUER.section.issuer, aud: 'shop-web', sub: 'cus_e2e', iat: now, exp: now + 600 });
		const browser = { authorization: `Bearer ${pk}`, origin: 'https://shop.example.com' };
		const submitted = await fetch(`${PRODUCT_URL}/v1/reviews`, {
			method: 'POST',
			headers: { ...browser, 'content-type': 'application/json', 'ss-identity': login, 'idempotency-key': randomUUID() },
			body: JSON.stringify({
				itemId: 'itm_e2e',
				rating: 5,
				title: 'Great case',
				body: BODY,
				author: { name: 'Erin Example' },
			}),
		});
		const review = await submitted.json();
		expect(submitted.status, JSON.stringify(review)).toBe(201);
		expect(review).toMatchObject({ itemId: 'itm_e2e', status: 'approved', verifiedPurchase: true, author: 'Erin E.' });
		// a forged login token is refused
		const forged = createTestIdentityIssuer({ alg: 'ES256' }).sign({
			iss: ISSUER.section.issuer,
			aud: 'shop-web',
			sub: 'cus_e2e',
			iat: now,
			exp: now + 600,
		});
		const refused = await fetch(`${PRODUCT_URL}/v1/reviews`, {
			method: 'POST',
			headers: { ...browser, 'content-type': 'application/json', 'ss-identity': forged, 'idempotency-key': randomUUID() },
			body: JSON.stringify({ itemId: 'itm_e2e', rating: 1, body: BODY }),
		});
		expect(refused.status).toBe(401);
		const stored = await mongo
			.db(clientDbName)
			.collection('ss_reviews_reviews')
			.findOne({ websiteId: state.websiteId, id: review.id });
		expect(stored).toMatchObject({
			status: 'approved',
			moderation: { by: 'rule', ruleId: 'verified_clean' },
			orderId: 'ord_e2e_1',
		});
		const summary = await (await fetch(`${PRODUCT_URL}/v1/ratings/itm_e2e`, { headers: browser })).json();
		expect(summary).toMatchObject({ count: 1, average: 5, scale: 5, verified: 1 });
		const jsonLd = await fetch(`${PRODUCT_URL}/v1/structured-data/itm_e2e`, { headers: browser });
		expect(jsonLd.headers.get('content-type')).toBe('application/ld+json');
		expect(await jsonLd.json()).toMatchObject({
			'@type': 'Product',
			name: 'E2E phone case',
			sku: 'SKU-E2E',
			aggregateRating: { ratingValue: 5, reviewCount: 1, bestRating: 5 },
			review: [{ '@type': 'Review', author: { name: 'Erin E.' }, reviewBody: BODY }],
		});
		// usage reaches the Portal exactly once
		const flushed = await ctx.product.product.usage.flush();
		expect(flushed.sent + flushed.duplicates).toBeGreaterThanOrEqual(1);
		expect(flushed.rejected).toBe(0);
		expect(await ctx.product.product.usage.flush()).toMatchObject({ sent: 0 });
	});

	it('shows the billing: usage records are never charged', async () => {
		const { call, state, clock } = ctx;
		// charges follow the price-list and switch histories only (PLAN 0.5.3; reports fill them in 0.12 step 5)
		clock.set(clock.now() + 2 * HOUR);
		const billing = await call('GET', `/v1/merchants/${state.merchantId}/billing`, { cookie: state.merchant });
		expect(billing.status, JSON.stringify(billing.json)).toBe(200);
		expect(billing.json).toMatchObject({ status: 'active', balance: 100_000, spentThisMonth: 0 });
		const usage = await call('GET', `/v1/merchants/${state.merchantId}/usage`, { cookie: state.merchant });
		expect(usage.json.rows).toEqual([]);
	});

	it('delivers the real reviews widget in the compiled website script after staff upload it ("Upload widgets")', async () => {
		const { call, state, PRODUCT_URL } = ctx;
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
		const snippet = await call('GET', `${site}/delivery/snippet`, { cookie: state.merchant });
		expect(snippet.status, JSON.stringify(snippet.json)).toBe(200);
		expect(JSON.stringify(snippet.json)).toContain(`/w/${state.websiteId}/`);
		const loader = await call('GET', `/w/${state.websiteId}/loader.js`);
		expect(loader.status).toBe(200);
		expect(loader.text).toContain(`packs/${state.appId}/${uploaded.json.version}/headless/reviews.js`);
		expect(loader.text).toContain(`packs/${state.appId}/${uploaded.json.version}/ui/reviews.js`);
		expect(loader.text).toContain(PRODUCT_URL);
		expect(loader.text).not.toContain('ss-element-stub');
		const served = await call('GET', `/w/packs/${state.appId}/${uploaded.json.version}/ui/reviews.js`);
		expect(served.status).toBe(200);
		expect(Buffer.from(served.text)).toEqual(/** @type {any} */ (pack.assets.find((a) => a.path === 'ui/reviews.js')).bytes);
	});
});
