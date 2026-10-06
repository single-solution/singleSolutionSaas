/**
 * End to end against the REAL Portal (`@ss/platform/testing`: `createPortal` with every production module), in process, on the test
 * run's MongoMemoryReplSet:
 *
 *   bootstrap staff (password + TOTP) → register this product through the real catalog handshake → activate →
 *   merchant signs up (e-mail verification) → adds a website → staff adds credits → merchant subscribes (starter) →
 *   connects a database connector and an AI connector (a fake OpenAI-compatible provider on local https, dev
 *   allowlist; the Portal's connection check calls its /models) → issues a pk_ key → a guest opens a conversation
 *   through the product REST from the website's origin → the product resolves the merchant's AI credentials through
 *   the Portal and the fake provider answers → conversation and messages in the merchant's own database → ai_token
 *   usage reported → hourly settlement charges the elements and the metered tokens. Plus the "Try demo" launch.
 *
 * The Portal is served over http on 127.0.0.1 (allowed outside production); the product and the AI provider over
 * https on localhost with a throw-away certificate trusted for this process only.
 * System test (the `e2e/` workspace): it runs the Portal (`@ss/platform/testing`) and the product (`@ss/product-chatbot/serve`).
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { noopLogger } from '@ss/app-kit';
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
import { ROOT, loadManifest, startServer } from '@ss/product-chatbot/serve';
import { connectProduct, createClock, mongoUri, postSetup } from './helpers.js';

const HOUR = 3_600_000;
const STAFF = { email: 'root@portal.test', password: 'staff password 123!' };
const MERCHANT_USER = { email: 'owner@shop.example.com', password: 'merchant password 123!' };
const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];
const AI_KEY = 'sk-merchant-own-ai-key';
/** Tokens the fake provider reports: above the starter plan's included 250 000 ai_token, so the metered unit is charged. */
const AI_PROMPT_TOKENS = 260_000;

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
	const work = await mkdtemp(path.join(tmpdir(), 'ss-chatbot-e2e-'));
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

	// ── the merchant's AI provider: a fake OpenAI-compatible API on https://localhost ────────────────────────────
	const aiPort = await freePort();
	const AI_URL = `https://localhost:${aiPort}/v1`;
	/** @type {Array<{ url: string, auth: string, body: any }>} */
	const aiRequests = [];
	const aiServer = createHttpsServer({ key, cert }, async (incoming, outgoing) => {
		const chunks = [];
		for await (const chunk of incoming) chunks.push(chunk);
		const text = Buffer.concat(chunks).toString('utf8');
		aiRequests.push({
			url: String(incoming.url),
			auth: String(incoming.headers.authorization ?? ''),
			body: text ? JSON.parse(text) : null,
		});
		if (incoming.headers.authorization !== `Bearer ${AI_KEY}`) {
			outgoing.writeHead(401, { 'content-type': 'application/json' });
			outgoing.end('{"error":"invalid key"}');
			return;
		}
		outgoing.writeHead(200, { 'content-type': 'application/json' });
		if (incoming.url === '/v1/models') outgoing.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
		else
			outgoing.end(
				JSON.stringify({
					choices: [{ message: { content: 'We ship worldwide — orders leave within 24 hours.' }, finish_reason: 'stop' }],
					usage: { prompt_tokens: AI_PROMPT_TOKENS, completion_tokens: 12 },
				}),
			);
	});
	await new Promise((resolve) => aiServer.listen(aiPort, '127.0.0.1', () => resolve(undefined)));

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
		aiServer,
		aiRequests,
		AI_URL,
		state: {},
	};
}, 120_000);

afterAll(async () => {
	if (!ctx) return;
	await ctx.product.close();
	for (const server of [ctx.portalServer, ctx.aiServer])
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

describe.skipIf(!hasOpenssl)('Chatbot & Support on the real Portal', () => {
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
		expect(registered.json).toMatchObject({ slug: 'chatbot', kind: 'service', status: 'pending', currentVersion: 1 });
		state.appId = registered.json.appId;
		const activated = await call('POST', `/v1/admin/apps/${state.appId}/lifecycle`, {
			cookie: state.staff,
			body: { action: 'activate' },
		});
		expect(activated.json.status).toBe('active');
		const listed = (await call('GET', '/v1/catalog/products')).json.items.find(
			(/** @type {any} */ item) => item.slug === 'chatbot',
		);
		expect(listed.elements.map((/** @type {any} */ element) => element.key)).toEqual([
			'window',
			'launcher',
			'ai_replies',
			'knowledge',
			'flows',
			'tools',
			'inbox',
			'handoff',
			'proactive',
			'lead_capture',
			'csat',
			'transcripts',
			'moderation',
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
		expect(subscribed.json.subscription).toMatchObject({ status: 'active', planCode: 'starter', productSlug: 'chatbot' });
		state.subscriptionId = subscribed.json.subscription.subscriptionId;
		state.subscribedAt = ctx.clock.now();
	});

	it('connects the merchant’s database and AI provider (connection checks pass) and issues a pk_ key', async () => {
		const { call, state, clientDbName, drain, AI_URL, aiRequests } = ctx;
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
		const ai = await call('POST', `/v1/merchants/${state.merchantId}/connectors`, {
			cookie: state.merchant,
			body: {
				kind: 'ai',
				provider: 'generic',
				label: 'Our LLM',
				credentials: { baseUrl: AI_URL, apiKey: AI_KEY, model: 'fake-model' },
				websiteIds: [state.websiteId],
			},
		});
		expect(ai.status, JSON.stringify(ai.json)).toBe(201);
		expect(ai.json.connector.status).toBe('connected');
		expect(aiRequests.map((/** @type {any} */ r) => r.url)).toEqual(['/v1/models']);
		expect(JSON.stringify(ai.json)).not.toContain(AI_KEY);
		const resources = await call('GET', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/resources`, {
			cookie: state.merchant,
		});
		expect(resources.json.resources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: 'database', status: 'connected' }),
				expect.objectContaining({ kind: 'ai', status: 'connected' }),
			]),
		);
		const keys = await call('POST', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/keys`, {
			cookie: state.merchant,
			body: { kind: 'pk', scopes: ['elements.read'] },
		});
		expect(keys.status, JSON.stringify(keys.json)).toBe(201);
		state.pk = keys.json.key;
		expect(state.pk).toMatch(/^pk_/);
		expect((await drain()).stats.dead).toBe(0);
	});

	it('lets a guest open a conversation from the website and answers with the merchant’s AI through the Portal', async () => {
		const { state, PRODUCT_URL, mongo, clientDbName, aiRequests } = ctx;
		/** @param {string} pathname @param {RequestInit & { identity?: string }} [init] */
		const browser = (pathname, init = {}) =>
			fetch(`${PRODUCT_URL}${pathname}`, {
				...init,
				headers: {
					authorization: `Bearer ${state.pk}`,
					origin: 'https://shop.example.com',
					...(init.body ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() } : {}),
					...(init.identity ? { 'ss-identity': init.identity } : {}),
				},
			});
		const started = await browser('/v1/conversations', {
			method: 'POST',
			body: JSON.stringify({ text: 'Hi! Do you ship internationally?', context: { page: { path: '/faq' } } }),
		});
		const body = await started.json();
		expect(started.status, JSON.stringify(body)).toBe(201);
		expect(started.headers.get('access-control-allow-origin')).toBe('https://shop.example.com');
		expect(body.replies.map((/** @type {any} */ m) => m.text)).toEqual(['We ship worldwide — orders leave within 24 hours.']);
		expect(body.marker.token).toMatch(/^cm1\./);
		// the product called the merchant's provider with the merchant's own key (resolved through the Portal)
		const completion = aiRequests.find((/** @type {any} */ r) => r.url === '/v1/chat/completions');
		expect(completion).toMatchObject({ auth: `Bearer ${AI_KEY}`, body: { model: 'fake-model' } });
		// a foreign origin is refused
		const foreign = await fetch(`${PRODUCT_URL}/v1/conversations`, {
			headers: { authorization: `Bearer ${state.pk}`, origin: 'https://evil.example.net' },
		});
		expect(foreign.status).toBe(403);
		// the guest comes back with its marker
		const mine = await (await browser('/v1/conversations', { identity: body.marker.token })).json();
		expect(mine.items.map((/** @type {any} */ c) => c.id)).toEqual([body.conversation.id]);
		// data lives in the merchant's own database, messages in their own collection
		const clientDb = mongo.db(clientDbName);
		const conversation = await clientDb
			.collection('ss_chatbot_conversations')
			.findOne({ websiteId: state.websiteId, id: body.conversation.id });
		expect(conversation).toMatchObject({ merchantId: state.merchantId, env: 'live', tokens: AI_PROMPT_TOKENS + 12 });
		expect(
			await clientDb
				.collection('ss_chatbot_messages')
				.countDocuments({ websiteId: state.websiteId, conversationId: body.conversation.id }),
		).toBe(2);
		state.conversationId = body.conversation.id;
		// usage reaches the Portal exactly once
		const flushed = await ctx.product.product.usage.flush();
		expect(flushed.rejected).toBe(0);
		expect(flushed.sent + flushed.duplicates).toBeGreaterThanOrEqual(2);
		expect((await ctx.product.product.usage.flush()).sent).toBe(0);
	});

	it('settles complete hours: elements and metered AI tokens are charged in credits', async () => {
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
			(/** @type {any} */ e) => (e.type === 'settlement' || e.type === 'metered') && e.subscriptionId === state.subscriptionId,
		);
		const iso = (/** @type {number} */ ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
		const summary = JSON.stringify(
			statement.json.entries.map((/** @type {any} */ e) => [e.type, e.periodKey, e.amountMillicredits]),
		);
		// starter: window 400 + launcher 100 + ai_replies 500 + knowledge 200 + handoff 100 + lead_capture 150 + moderation 100
		const second = settlements.find((/** @type {any} */ e) => e.periodKey === `${state.subscriptionId}:${iso(hour0 + HOUR)}`);
		expect(second?.amountMillicredits, summary).toBe(-1550);
		// ai_token: 260 012 tokens − 250 000 included = 10 012 → 1 millicredit per 1 000 → 10; conversation: 1 of 300 included → 0
		const metered = settlements.find((/** @type {any} */ e) => e.periodKey === `${state.subscriptionId}:${iso(hour0)}:metered`);
		expect(metered?.amountMillicredits, summary).toBe(-10);
		const balance = await call('GET', `/v1/merchants/${state.merchantId}/balance`, { cookie: state.merchant });
		const charged = settlements.reduce((/** @type {number} */ sum, /** @type {any} */ e) => sum + e.amountMillicredits, 0);
		const trial = statement.json.entries
			.filter((/** @type {any} */ e) => e.type === 'adjustment')
			.reduce((/** @type {number} */ sum, /** @type {any} */ e) => sum + e.amountMillicredits, 0);
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
