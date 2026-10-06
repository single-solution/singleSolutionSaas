/**
 * End to end against the REAL Portal (`@ss/platform/testing`: `createPortal` with every production module), in process, on the test
 * run's MongoMemoryReplSet — bring-your-own identity proven across products:
 *
 *   bootstrap staff (password + TOTP) → register Signups AND Loyalty through the real catalog handshake → activate →
 *   merchant signs up → website → credits → subscribes to both → connects a database connector and a messaging
 *   connector (a fake HTTP gateway on loopback, dev allowlist; the connector check calls it) → a browser asks Signups
 *   for a code (pk_ key, website origin) → the gateway receives the code → verify → EdDSA access token → Signups asks
 *   the Portal to be the website's identity issuer (product route, pending) → the merchant approves it (the Portal
 *   fetches the per-website JWKS from Signups) → the re-signed entitlement document reaches Loyalty → Loyalty accepts
 *   the Signups token as the customer (`GET /v1/wallet` with SS-Identity) → customer.created@1 from Signups is routed
 *   by the Event Hub to Loyalty → usage (otp_send) reported exactly once → hourly settlement charges the Signups
 *   subscription.
 *
 * The Portal and the gateway are served over http on 127.0.0.1 (allowed outside production); the products over https
 * on localhost with a throw-away certificate trusted for this process only (`endpoints.base` must be https).
 * System test (the `e2e/` workspace): it runs the Portal (`@ss/platform/testing`) and the product (`@ss/product-signups/serve`) plus Loyalty (`@ss/product-loyalty/serve`).
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
import {
	ROOT as LOYALTY_ROOT,
	loadManifest as loadLoyaltyManifest,
	startServer as startLoyalty,
} from '@ss/product-loyalty/serve';
import { ROOT, loadManifest, startServer } from '@ss/product-signups/serve';
import { createClock, mongoUri } from './helpers.js';

const HOUR = 3_600_000;
const SIGNUPS_TOKEN = `rt_${randomBytes(24).toString('hex')}`;
const LOYALTY_TOKEN = `rt_${randomBytes(24).toString('hex')}`;
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
 * Resolve `localhost` to IPv4 only (the products listen on 127.0.0.1).
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
 * The merchant's messaging gateway: records every message and answers the connector check.
 * @param {number} port
 */
const startGateway = async (port) => {
	/** @type {Array<{ path: string, authorization: string | undefined, body: Record<string, any> }>} */
	const received = [];
	const server = createServer(async (incoming, outgoing) => {
		const chunks = [];
		for await (const chunk of incoming) chunks.push(chunk);
		const text = Buffer.concat(chunks).toString('utf8');
		if (incoming.headers.authorization !== 'Bearer gw-secret-key') {
			outgoing.writeHead(401, { 'content-type': 'application/json' });
			outgoing.end('{"error":"unauthorized"}');
			return;
		}
		if (incoming.method === 'POST' && incoming.url === '/messages')
			received.push({ path: incoming.url, authorization: incoming.headers.authorization, body: JSON.parse(text) });
		outgoing.writeHead(incoming.method === 'POST' ? 202 : 200, { 'content-type': 'application/json' });
		outgoing.end(JSON.stringify({ id: `msg_${received.length}`, status: 'queued' }));
	});
	await new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(undefined)));
	return { url: `http://127.0.0.1:${port}`, received, server };
};

/** @type {any} */
let ctx;

beforeAll(async () => {
	if (!hasOpenssl) return;
	const clock = createClock(Math.floor(Date.now() / HOUR) * HOUR + 10 * 60_000);
	const work = await mkdtemp(path.join(tmpdir(), 'ss-signups-e2e-'));
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
	const clientDbName = `e2e_signups_client_${suffix}`;
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
			createIdentityModule({ mailer, issuers: { allowHosts: LOCAL_HOSTS, resolve: resolveLocal } }),
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

	// ── the merchant's messaging gateway (loopback, allowlisted) ────────────────────────────────────────────
	const gateway = await startGateway(await freePort());

	// ── the products: https on localhost, pinned to this Portal ──────────────────────────────────────────────
	/**
	 * @param {{ start: typeof startServer, root: string, manifest: any, token: string, kid: string }} input
	 */
	const launchProduct = async ({ start, root, manifest, token, kid }) => {
		const port = await freePort();
		const url = `https://localhost:${port}`;
		const { privateJwk } = await generateSigningKey({ kid });
		const running = await start({
			port,
			host: '127.0.0.1',
			root,
			tls: { key, cert },
			env: {
				SS_PORTAL_URL: PORTAL_URL,
				SS_APP_SIGNING_KEY: JSON.stringify(privateJwk),
				SS_REGISTRATION_TOKEN_HASH: hashRegistrationToken(token),
				SS_LOG_LEVEL: 'error',
				SIGNUPS_SEAL_SECRET: randomBytes(32).toString('hex'),
			},
			overrides: {
				now: clock.now,
				logger: noopLogger,
				manifest: { ...manifest, endpoints: { ...manifest.endpoints, base: url } },
			},
		});
		return { url, running };
	};
	const signups = await launchProduct({
		start: startServer,
		root: ROOT,
		manifest: await loadManifest(ROOT),
		token: SIGNUPS_TOKEN,
		kid: 'signups-e2e-1',
	});
	const loyalty = await launchProduct({
		start: /** @type {any} */ (startLoyalty),
		root: LOYALTY_ROOT,
		manifest: await loadLoyaltyManifest(LOYALTY_ROOT),
		token: LOYALTY_TOKEN,
		kid: 'loyalty-e2e-1',
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
	 * A browser call to a product (pk_ key from the website's origin).
	 * @param {string} base
	 * @param {string} method
	 * @param {string} pathname
	 * @param {{ body?: unknown, key: string, identity?: string }} init
	 */
	const browser = async (base, method, pathname, { body, key: bearer, identity }) => {
		const response = await fetch(`${base}${pathname}`, {
			method,
			headers: {
				authorization: `Bearer ${bearer}`,
				origin: ORIGIN,
				'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1.15',
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
				...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}),
				...(identity ? { 'ss-identity': identity } : {}),
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
		browser,
		drain,
		gateway,
		signups,
		loyalty,
		PORTAL_URL,
		work,
		defaultCAs,
		portalServer,
		state: {},
	};
}, 120_000);

afterAll(async () => {
	if (!ctx) return;
	await ctx.signups.running.close();
	await ctx.loyalty.running.close();
	for (const server of [ctx.portalServer, ctx.gateway.server])
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

describe.skipIf(!hasOpenssl)('Signups & Identity on the real Portal (bring-your-own identity end to end)', () => {
	it('bootstraps the first staff user (password + TOTP)', async () => {
		const { call, portal, clock, state } = ctx;
		const { link } = await portal.modules.service('identity').bootstrapSuperadmin({ email: STAFF.email });
		const token = decodeURIComponent(String(link).split('#token=')[1] ?? '');
		expect(
			(await call('POST', '/v1/auth/staff/password-reset/confirm', { body: { token, password: STAFF.password } })).status,
		).toBe(204);
		const login = await call('POST', '/v1/auth/staff/login', { body: STAFF });
		const enrol = await call('POST', '/v1/auth/staff/mfa/enrol', { cookie: login.cookie });
		clock.advance(30_000);
		const confirm = await call('POST', '/v1/auth/staff/mfa/confirm', {
			cookie: login.cookie,
			body: { code: totpCode(enrol.json.secret, clock.now()) },
		});
		expect(confirm.status, JSON.stringify(confirm.json)).toBe(200);
		state.staff = confirm.cookie ?? login.cookie;
	});

	it('registers and activates Signups and Loyalty through the catalog handshake', async () => {
		const { call, state, signups, loyalty } = ctx;
		for (const [name, product, token] of /** @type {const} */ ([
			['signups', signups, SIGNUPS_TOKEN],
			['loyalty', loyalty, LOYALTY_TOKEN],
		])) {
			const registered = await call('POST', '/v1/admin/apps/register', {
				cookie: state.staff,
				body: { baseUrl: product.url, token },
			});
			expect(registered.status, JSON.stringify(registered.json)).toBe(201);
			expect(registered.json).toMatchObject({ slug: name, kind: 'service', status: 'pending' });
			const activated = await call('POST', `/v1/admin/apps/${registered.json.appId}/lifecycle`, {
				cookie: state.staff,
				body: { action: 'activate' },
			});
			expect(activated.json.status).toBe('active');
			state[`${name}AppId`] = registered.json.appId;
		}
		const catalog = await call('GET', '/v1/catalog/products');
		const listed = catalog.json.items.find((/** @type {any} */ item) => item.slug === 'signups');
		expect(listed.elements.map((/** @type {any} */ element) => element.key)).toEqual([
			'profile',
			'sessions',
			'otp',
			'magic_link',
			'account_pages',
			'widget',
			'risk',
			'consent',
			'data_rights',
		]);
	});

	it('lets a merchant sign up, add a website, receive credits and subscribe to both products', async () => {
		const { call, mailer, state, clock } = ctx;
		expect((await call('POST', '/v1/auth/merchant/signup', { body: { ...MERCHANT_USER, merchantName: 'Shop' } })).status).toBe(
			202,
		);
		const verified = await call('POST', '/v1/auth/merchant/verify-email', {
			body: { token: mailer.token(MERCHANT_USER.email, 'verify_email') },
		});
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
		for (const name of ['signups', 'loyalty']) {
			const subscribed = await call('POST', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/subscriptions`, {
				cookie: state.merchant,
				body: { appId: state[`${name}AppId`], planCode: 'starter' },
			});
			expect(subscribed.status, JSON.stringify(subscribed.json)).toBe(201);
			expect(subscribed.json.subscription).toMatchObject({ status: 'active', planCode: 'starter', productSlug: name });
			state[`${name}SubscriptionId`] = subscribed.json.subscription.subscriptionId;
		}
		state.subscribedAt = clock.now();
	});

	it('connects the merchant’s database and messaging gateway (connector checks pass) and issues website keys', async () => {
		const { call, state, clientDbName, drain, gateway } = ctx;
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
				label: 'Shop gateway',
				credentials: { baseUrl: gateway.url, apiKey: 'gw-secret-key', testPath: '/health' },
				websiteIds: [state.websiteId],
			},
		});
		expect(messaging.status, JSON.stringify(messaging.json)).toBe(201);
		expect(messaging.json.connector.status).toBe('connected');
		const resources = await call('GET', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/resources`, {
			cookie: state.merchant,
		});
		expect(resources.json.resources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: 'database', status: 'connected' }),
				expect.objectContaining({ kind: 'messaging', status: 'connected' }),
			]),
		);
		for (const kind of ['pk', 'sk']) {
			const issued = await call('POST', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/keys`, {
				cookie: state.merchant,
				body: { kind, scopes: ['events.*'] },
			});
			expect(issued.status, JSON.stringify(issued.json)).toBe(201);
			state[kind] = issued.json.key;
		}
		const drained = await drain();
		expect(drained.stats.dead).toBe(0);
	});

	it('signs a customer in passwordlessly: the code goes to the merchant’s gateway, the verification issues a JWT', async () => {
		const { browser, signups, state, gateway, mongo, clientDbName } = ctx;
		const sent = await browser(signups.url, 'POST', '/v1/otp', {
			key: state.pk,
			body: { channel: 'email', to: 'Ada@Example.com', deviceId: 'device-e2e-00001' },
		});
		expect(sent.status, JSON.stringify(sent.json)).toBe(202);
		expect(sent.json).toMatchObject({ channel: 'email', destination: 'a•••@example.com' });
		const message = gateway.received.at(-1);
		expect(message?.authorization).toBe('Bearer gw-secret-key');
		expect(message?.body).toMatchObject({
			channel: 'email',
			to: 'ada@example.com',
			purpose: 'otp',
			reference: sent.json.challengeId,
		});
		const code = String(message?.body.variables.code);
		expect(code).toMatch(/^\d{6}$/);
		const verified = await browser(signups.url, 'POST', `/v1/otp/${sent.json.challengeId}/verify`, {
			key: state.pk,
			body: { code, deviceId: 'device-e2e-00001' },
		});
		expect(verified.status, JSON.stringify(verified.json)).toBe(200);
		expect(verified.json).toMatchObject({
			created: true,
			customer: { email: 'ada@example.com', verified: { email: 'verified' } },
		});
		state.customerId = verified.json.customer.id;
		state.accessToken = verified.json.tokens.accessToken;
		// the customer and the hashed challenge live in the merchant's own database, keyed by websiteId
		const clientDb = mongo.db(clientDbName);
		const customer = await clientDb
			.collection('ss_signups_customers')
			.findOne({ websiteId: state.websiteId, id: state.customerId });
		expect(customer).toMatchObject({ email: 'ada@example.com', merchantId: state.merchantId, env: 'live' });
		const challenge = await clientDb
			.collection('ss_signups_challenges')
			.findOne({ websiteId: state.websiteId, id: sent.json.challengeId });
		expect(JSON.stringify(challenge)).not.toContain(code);
		const keys = await clientDb.collection('ss_signups_keys').find({ websiteId: state.websiteId }).toArray();
		expect(keys.map((/** @type {any} */ k) => k.kind).sort()).toEqual(['pepper', 'signing']);
		expect(JSON.stringify(keys)).not.toMatch(/"d":/); // private keys are sealed
	});

	it('is refused by Loyalty until the merchant approves Signups’ request to be the website’s identity issuer', async () => {
		const { browser, loyalty, signups, state, call, drain } = ctx;
		const before = await browser(loyalty.url, 'GET', '/v1/wallet', { key: state.pk, identity: state.accessToken });
		expect(before.status, JSON.stringify(before.json)).toBe(401);
		const sk = { authorization: `Bearer ${state.sk}` };
		// what Signups would register (sk_ only), and the merchant-side call it documents
		const issuer = await fetch(`${signups.url}/v1/issuer`, { headers: sk }).then((r) => r.json());
		expect(issuer).toMatchObject({
			registered: false,
			portal: { method: 'PUT', path: `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/identity` },
		});
		// Signups asks the real Portal (product auth, capabilities.identityIssuer): pending until the merchant decides
		const register = () =>
			fetch(`${signups.url}/v1/issuer:register`, { method: 'POST', headers: { ...sk, 'idempotency-key': randomUUID() } }).then(
				async (r) => ({ status: r.status, json: await r.json() }),
			);
		const requested = await register();
		expect(requested.status, JSON.stringify(requested.json)).toBe(202);
		expect(requested.json).toMatchObject({ status: 'pending', registered: false });
		const shown = await call('GET', issuer.portal.path, { cookie: state.merchant });
		expect(shown.json.request).toMatchObject({
			status: 'pending',
			issuer: `${signups.url}/i/${state.websiteId}`,
			product: { slug: 'signups' },
		});
		const approved = await call('POST', `${issuer.portal.path}/request/approve`, { cookie: state.merchant, body: {} });
		expect(approved.status, JSON.stringify(approved.json)).toBe(200);
		expect(approved.json.issuer).toMatchObject({ issuer: `${signups.url}/i/${state.websiteId}` });
		// asking again is safe: the Portal answers active
		expect(await register()).toMatchObject({ status: 200, json: { status: 'active', registered: true } });
		await drain(); // entitlement.changed@1 → both products refresh their signed documents
		const accepted = await browser(loyalty.url, 'GET', '/v1/wallet', { key: state.pk, identity: state.accessToken });
		expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
		expect(accepted.json).toMatchObject({ customerId: state.customerId, balance: 0 });
		const after = await fetch(`${signups.url}/v1/issuer`, { headers: { authorization: `Bearer ${state.sk}` } }).then((r) =>
			r.json(),
		);
		expect(after.registered).toBe(true);
		// a forged token is still refused by Loyalty
		const [head, payload] = state.accessToken.split('.');
		expect(
			(await browser(loyalty.url, 'GET', '/v1/wallet', { key: state.pk, identity: `${head}.${payload}.AAAA` })).status,
		).toBe(401);
	});

	it('routes Signups’ customer.created@1 through the Event Hub, reports usage once and settles the hours', async () => {
		const { call, state, drain, signups, clock } = ctx;
		const drained = await drain();
		expect(drained.stats.dead).toBe(0);
		const log = await call('GET', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/deliveries`, {
			cookie: state.merchant,
		});
		expect(log.status).toBe(200);
		expect(JSON.stringify(log.json)).toContain('customer.created@1');
		expect(JSON.stringify(log.json)).not.toContain('ada@example.com'); // routing metadata only
		const flushed = await signups.running.product.usage.flush();
		expect(flushed.sent + flushed.duplicates).toBeGreaterThanOrEqual(1);
		expect(flushed.rejected).toBe(0);
		const hour0 = Math.floor(state.subscribedAt / HOUR) * HOUR;
		clock.set(hour0 + 2 * HOUR + 5 * 60_000);
		// no cron: reading the statement settles the merchant's complete hours first
		const statement = await call(
			'GET',
			`/v1/merchants/${state.merchantId}/statement?from=${encodeURIComponent(new Date(hour0 - HOUR).toISOString())}&to=${encodeURIComponent(new Date(clock.now() + HOUR).toISOString())}`,
			{ cookie: state.merchant },
		);
		const iso = (/** @type {number} */ ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
		const second = statement.json.entries.find(
			(/** @type {any} */ entry) =>
				entry.type === 'settlement' && entry.periodKey === `${state.signupsSubscriptionId}:${iso(hour0 + HOUR)}`,
		);
		// starter: profile 200 + sessions 300 + otp 300 + widget 0 + account_pages 100 millicredits per hour
		expect(
			second?.amountMillicredits,
			JSON.stringify(statement.json.entries.map((/** @type {any} */ e) => [e.type, e.periodKey, e.amountMillicredits])),
		).toBe(-900);
	});

	it('opens the Signups demo from the merchant console ("Try demo")', async () => {
		const { call, state, signups } = ctx;
		const demo = await call('POST', `/v1/merchants/${state.merchantId}/apps/${state.signupsAppId}/demo`, {
			cookie: state.merchant,
			body: {},
		});
		expect(demo.status, JSON.stringify(demo.json)).toBe(200);
		const sso = await fetch(demo.json.url, { redirect: 'manual' });
		expect(sso.status).toBe(303);
		const session = /ss_session=(ses_[^;]+)/.exec(sso.headers.get('set-cookie') ?? '')?.[1];
		const view = await fetch(`${signups.url}/v1/session`, { headers: { authorization: `Bearer ${session}` } });
		expect(await view.json()).toMatchObject({ kind: 'demo', role: 'demo' });
	});
});
