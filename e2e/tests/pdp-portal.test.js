/**
 * Pack delivery against the REAL Portal (`@ss/platform/testing`: `createPortal` with the production modules,
 * delivery included), in process, on the test run's MongoMemoryReplSet. An element pack has no server, so instead
 * of a product handshake this test publishes the Product Detail Page pack the way a developer does:
 *
 *   bootstrap staff (password + TOTP) → build the pack (`@ss/product-pdp/pack`: `ss pack build`, minified entries +
 *   shared chunks) → a staff API token (`POST /v1/admin/api-tokens`) → `ss pack publish` (`@ss/cli/pack`
 *   `publishPack`): sign the `ss-pack-bundle@1` descriptor with a developer key, upload it and every asset (bytes
 *   checked against the signed hashes) and activate → merchant signs up, adds a website, receives credits and subscribes
 *   (standard plan: gallery, price block, structured data on) → the website bundle compiles with exactly those
 *   elements, inside the website budget, serving the pack modules immutably → an add-on (reviews block) joins the
 *   bundle → switching every element on is refused for the budget and the live alias stays → hourly settlement
 *   charges the elements' prices.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { noopLogger } from '@ss/app-kit';
import { generateSigningKey } from '@ss/protocol';
import { publishPack } from '@ss/cli/pack';
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
	systemModule,
	totpCode,
} from '@ss/platform/testing';
import { buildPack } from '@ss/product-pdp/pack';
import { createClock, mongoUri } from './helpers.js';

const HOUR = 3_600_000;
const PORTAL_URL = 'http://127.0.0.1:4999';
const STAFF = { email: 'root@portal.test', password: 'staff password 123!' };
const MERCHANT_USER = { email: 'owner@shop.example.com', password: 'merchant password 123!' };
const DEFAULT_ELEMENTS = ['gallery', 'price_block', 'structured_data'];

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
	const clock = createClock(Date.UTC(2026, 9, 5, 10, 10));
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
		PLATFORM_ASSET_STORAGE: 'memory',
		// honest budgets (F.18): the default plan fits, every element at once does not
		DELIVERY_BUDGET_KB: '45',
		STAFF_SESSION_IDLE_MINUTES: '720',
	});
	const mongo = await new MongoClient(/** @type {string} */ (process.env.SS_TEST_MONGO_URI)).connect();
	const portalDb = mongo.db(`e2e_pdp_portal_${randomBytes(4).toString('hex')}`);
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
			createIntegrationModule({ routingCacheMs: 0 }),
			createCatalogModule({}),
			createIdentityModule({ mailer }),
			configModule,
			createConnectorsModule({}),
			commerceModule,
			createDeliveryModule({}),
		],
	});
	await portal.ensureIndexes();

	/**
	 * In-process Portal call (cookie sessions send the Portal origin for CSRF).
	 * @param {string} method
	 * @param {string} pathname
	 * @param {{ body?: unknown, raw?: Buffer, cookie?: string, bearer?: string, headers?: Record<string, string> }} [init]
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
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				...(raw === undefined ? {} : { body: new Uint8Array(raw) }),
			}),
		);
		const bytes = Buffer.from(await response.arrayBuffer());
		const text = bytes.toString('utf8');
		const type = response.headers.get('content-type') ?? '';
		const setCookie = response.headers
			.getSetCookie()
			.map((value) => value.split(';')[0])
			.find((pair) => /=.+/.test(pair ?? ''));
		return {
			status: response.status,
			headers: response.headers,
			bytes,
			text,
			json: text && type.includes('json') ? JSON.parse(text) : null,
			cookie: setCookie ?? null,
		};
	};
	ctx = { clock, portal, portalDb, mongo, mailer, call, pack: await buildPack(), state: {} };
}, 120_000);

afterAll(async () => {
	if (!ctx) return;
	await ctx.portalDb.dropDatabase().catch(() => undefined);
	await ctx.mongo.close();
	await closeMongoClients();
});

describe('Product Detail Page pack delivered by the real Portal', () => {
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

	it('publishes the signed pack with `ss pack publish` and a staff API token, and activates it', async () => {
		const { call, state, pack, portal } = ctx;
		const developer = await generateSigningKey({ kid: 'pdp-dev-1' });
		const minted = await call('POST', '/v1/admin/api-tokens', { cookie: state.staff, body: { minutes: 30, label: 'e2e' } });
		expect(minted.status, minted.text).toBe(201);
		const token = minted.json.token;
		expect(token).toMatch(/^sst_/);
		// an API token cannot mint another one, and is refused as a cookie
		expect((await call('POST', '/v1/admin/api-tokens', { bearer: token, body: { minutes: 5 } })).status).toBe(403);
		/** @type {typeof globalThis.fetch} */
		const fetch = async (/** @type {any} */ url, /** @type {any} */ init) => portal.handle(new Request(url, init));
		const published = await publishPack({
			pack,
			portalUrl: PORTAL_URL,
			token,
			signingKey: developer.privateJwk,
			fetch,
			activate: true,
		});
		expect(published).toMatchObject({ version: 1, uploaded: pack.assets.length, status: 'active' });
		state.appId = published.appId;

		// a tampered asset is refused against the signed hash
		const first = pack.assets[0];
		const tampered = await call('PUT', `/v1/admin/packs/${state.appId}/versions/1/assets/${first.path}`, {
			bearer: token,
			raw: Buffer.concat([first.bytes, Buffer.from(' ')]),
			headers: { 'content-type': first.contentType },
		});
		expect(tampered.status).toBe(422);
		expect(
			(await call('PUT', `/v1/admin/packs/${state.appId}/versions/1/assets/${first.path}`, { bearer: 'sst_nope' })).status,
		).toBe(401);
		const catalog = await call('GET', '/v1/catalog/products');
		const listed = catalog.json.items.find((/** @type {any} */ item) => item.slug === 'pdp');
		expect(listed).toMatchObject({ appId: state.appId });
		expect(listed.elements.map((/** @type {any} */ element) => element.key)).toEqual(
			pack.manifest.elements.map((/** @type {any} */ element) => element.key),
		);
	});

	it('lets a merchant sign up, add a website, receive credits and subscribe', async () => {
		const { call, mailer, state } = ctx;
		expect((await call('POST', '/v1/auth/merchant/signup', { body: { ...MERCHANT_USER, merchantName: 'Shop' } })).status).toBe(
			202,
		);
		const verified = await call('POST', '/v1/auth/merchant/verify-email', {
			body: { token: mailer.token(MERCHANT_USER.email, 'verify_email') },
		});
		expect(verified.status, verified.text).toBe(201);
		state.merchantId = verified.json.merchantId;
		state.merchant = verified.cookie;
		const website = await call('POST', `/v1/merchants/${state.merchantId}/websites`, {
			cookie: state.merchant,
			body: { domain: 'shop.example.com' },
		});
		expect(website.status, website.text).toBe(201);
		state.websiteId = website.json.website.websiteId;
		const credits = await call('POST', `/v1/admin/merchants/${state.merchantId}/credits`, {
			cookie: state.staff,
			body: { amountMillicredits: 100_000, reference: 'e2e-pdp-topup', note: 'end-to-end test credits' },
		});
		expect(credits.status, credits.text).toBe(201);
		const subscribed = await call('POST', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/subscriptions`, {
			cookie: state.merchant,
			body: { appId: state.appId, planCode: 'standard' },
		});
		expect(subscribed.status, subscribed.text).toBe(201);
		expect(subscribed.json.subscription).toMatchObject({ status: 'active', planCode: 'standard', productSlug: 'pdp' });
		state.subscriptionId = subscribed.json.subscription.subscriptionId;
		state.subscribedAt = ctx.clock.now();
	});

	it('compiles the website bundle with the plan’s elements inside the website budget', async () => {
		const { call, state, pack } = ctx;
		const site = `/v1/merchants/${state.merchantId}/websites/${state.websiteId}`;
		const compiled = await call('POST', `${site}/delivery/compile`, { cookie: state.merchant });
		expect(compiled.status, compiled.text).toBe(200);
		expect(compiled.json.artefact.elements.map((/** @type {any} */ e) => e.key).sort()).toEqual([...DEFAULT_ELEMENTS].sort());
		state.version = compiled.json.version;

		const manifest = await call('GET', `/w/${state.websiteId}/${state.version}/manifest.json`);
		expect(manifest.status).toBe(200);
		expect(manifest.json.budget.totalKb).toBeLessThanOrEqual(manifest.json.budget.limitKb);
		const declared = pack.manifest.elements
			.filter((/** @type {any} */ e) => DEFAULT_ELEMENTS.includes(e.key))
			.reduce((/** @type {number} */ sum, /** @type {any} */ e) => sum + e.budget.js, 0);
		expect(manifest.json.budget.elementsKb).toBe(declared);
		// the shared chunks count once, against the pack's budget.shared
		expect(manifest.json.budget.sharedKb).toBe(pack.manifest.budget.shared);
		expect(manifest.json.budget.shared[0]).toMatchObject({ slug: 'pdp', declaredKb: pack.manifest.budget.shared });
		expect(manifest.json.budget.shared[0].measuredKb).toBeLessThanOrEqual(pack.manifest.budget.shared);
		for (const element of manifest.json.elements) {
			expect(element).toMatchObject({ slug: 'pdp', kind: 'pack', delivery: 'pack' });
			expect(element.modules).toHaveLength(2);
		}

		const loader = await call('GET', `/w/${state.websiteId}/loader.js`);
		expect(loader.status).toBe(200);
		for (const key of DEFAULT_ELEMENTS) expect(loader.text).toContain(`"key":"${key}"`);
		expect(loader.text).toContain(`packs/${state.appId}/1/headless/gallery.js`);
		expect(loader.text).toContain('"gallery.alt":"{title}, image {index} of {total}"');
		// strings are sliced per element from strings/en.json
		expect(loader.text).not.toContain('"faq.title"');
		expect(loader.text).toContain('"product":"pdp"');
		expect(loader.text).not.toContain('"key":"related"');

		// the pack modules (entries and shared chunks) are served immutably, byte for byte
		for (const asset of pack.assets.filter((/** @type {any} */ a) => a.path.endsWith('.js'))) {
			const served = await call('GET', `/w/packs/${state.appId}/1/${asset.path}`);
			expect(served.status, asset.path).toBe(200);
			expect(served.bytes.equals(asset.bytes)).toBe(true);
			expect(served.headers.get('cache-control')).toContain('immutable');
		}
	});

	it('adds an embed add-on and refuses a bundle over the website budget, keeping the live alias', async () => {
		const { call, state, pack } = ctx;
		const site = `/v1/merchants/${state.merchantId}/websites/${state.websiteId}`;
		/** @param {string} key */
		const enable = async (key) => {
			const switched = await call(
				'PUT',
				`/v1/merchants/${state.merchantId}/subscriptions/${state.subscriptionId}/elements/${key}`,
				{
					cookie: state.merchant,
					body: { enabled: true },
				},
			);
			expect(switched.status, `${key}: ${switched.text}`).toBe(200);
		};
		await enable('reviews_block');
		const withEmbed = await call('POST', `${site}/delivery/compile`, { cookie: state.merchant });
		expect(withEmbed.status, withEmbed.text).toBe(200);
		expect(withEmbed.json.artefact.elements.map((/** @type {any} */ e) => e.key)).toContain('reviews_block');
		const live = withEmbed.json.version;

		for (const element of pack.manifest.elements)
			if (![...DEFAULT_ELEMENTS, 'reviews_block'].includes(element.key)) await enable(element.key);
		const everything = await call('POST', `${site}/delivery/compile`, { cookie: state.merchant });
		expect(everything.status).toBe(422);
		expect(everything.json.type).toMatch(/delivery_budget_exceeded$/);
		expect(everything.json.errors.every((/** @type {any} */ e) => e.code === 'budget')).toBe(true);
		const alias = await call('GET', `/w/${state.websiteId}/loader.js`);
		expect(alias.headers.get('etag')).toBe(`"${live}"`);
	});

	it('settles complete hours at the switched-on elements’ hourly prices', async () => {
		const { call, clock, state } = ctx;
		const hour0 = Math.floor(state.subscribedAt / HOUR) * HOUR;
		clock.advance(2 * HOUR);
		// no cron: reading the statement settles the merchant's complete hours first
		const iso = (/** @type {number} */ ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
		const statement = await call(
			'GET',
			`/v1/merchants/${state.merchantId}/statement?from=${encodeURIComponent(iso(hour0 - HOUR))}&to=${encodeURIComponent(iso(clock.now() + HOUR))}`,
			{ cookie: state.merchant },
		);
		expect(statement.status, statement.text).toBe(200);
		const second = statement.json.entries.find(
			(/** @type {any} */ entry) =>
				entry.type === 'settlement' && entry.periodKey === `${state.subscriptionId}:${iso(hour0 + HOUR)}`,
		);
		// every element on: gallery 100 + related 100 + faq 100 + sticky_buy_bar 100 + hosted_page 300 millicredits per hour
		expect(second?.amountMillicredits, statement.text).toBe(-700);
	});
});
