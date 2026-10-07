/**
 * Pack delivery against the REAL Portal (`@ss/platform/testing`: `createPortal` with the production modules,
 * delivery included), in process, on the test run's MongoMemoryReplSet. An element pack has no server, so instead
 * of a product handshake staff upload the Product Detail Page pack (Admin → Apps → Upload pack version):
 *
 *   first admin from the sign-in page (password, then TOTP) → build the pack (`@ss/product-pdp/pack`: `ss pack build`,
 *   minified entries + shared chunks) → `POST /v1/admin/packs` with the `ss-pack-bundle@1` descriptor → `PUT` every
 *   missing asset (bytes checked against the descriptor's hashes; the version becomes current with the last one) →
 *   Active → merchant signs up, adds a website, receives credits and subscribes (standard plan: gallery, price block,
 *   structured data on) → the website bundle compiles with exactly those elements, serving the pack modules
 *   immutably → an add-on (reviews block) joins the bundle, then every element → the billing is read (usage is never charged, PLAN 0.5.3).
 */
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
	createDeliveryModule,
	createIdentityModule,
	createIntegrationModule,
	createPortal,
	loadConfig,
	testSystemState,
	systemModule,
	totpCode,
} from '@ss/platform/testing';
import { buildPack, descriptorOf } from '@ss/product-pdp/pack';
import { createClock, mongoUri, LONG_SESSIONS, PORTAL_ENCRYPTION_KEY } from './helpers.js';

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
	const config = loadConfig(
		{
			NODE_ENV: 'test',
			MONGODB_URI: mongoUri('unused'),
			PORTAL_URL,
			ENCRYPTION_KEY: PORTAL_ENCRYPTION_KEY,
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

	it('uploads the pack built by `ss pack build` (descriptor, then every asset) and activates it', async () => {
		const { call, state, pack } = ctx;
		const descriptor = descriptorOf(pack);
		const uploaded = await call('POST', '/v1/admin/packs', { cookie: state.staff, body: { descriptor } });
		expect(uploaded.status, uploaded.text).toBe(201);
		expect(uploaded.json).toMatchObject({ slug: 'pdp', kind: 'pack', version: 1, status: 'uploading', changed: true });
		expect([...uploaded.json.missing].sort()).toEqual(pack.assets.map((/** @type {any} */ a) => a.path).sort());
		state.appId = uploaded.json.appId;
		// staff only
		expect((await call('POST', '/v1/admin/packs', { body: { descriptor } })).status).toBe(401);

		const [first] = pack.assets;
		// a tampered asset is refused against the descriptor's hash; no session, no upload
		const tampered = await call('PUT', `${uploaded.json.uploadPath}${first.path}`, {
			cookie: state.staff,
			raw: Buffer.concat([first.bytes, Buffer.from(' ')]),
			headers: { 'content-type': first.contentType },
		});
		expect(tampered.status).toBe(422);
		expect(
			(
				await call('PUT', `${uploaded.json.uploadPath}${first.path}`, {
					raw: first.bytes,
					headers: { 'content-type': first.contentType },
				})
			).status,
		).toBe(401);
		for (const path of uploaded.json.missing) {
			const asset = /** @type {any} */ (pack.assets.find((/** @type {any} */ a) => a.path === path));
			const put = await call('PUT', `${uploaded.json.uploadPath}${path}`, {
				cookie: state.staff,
				raw: asset.bytes,
				headers: { 'content-type': asset.contentType },
			});
			expect(put.status, `${path}: ${put.text}`).toBe(200);
		}
		// the last asset made version 1 current; the same build again is no change
		const app = await call('GET', `/v1/admin/apps/${state.appId}`, { cookie: state.staff });
		expect(app.json).toMatchObject({ slug: 'pdp', kind: 'pack', status: 'inactive', currentVersion: 1 });
		const again = await call('POST', '/v1/admin/packs', { cookie: state.staff, body: { descriptor } });
		expect(again.json).toMatchObject({ appId: state.appId, version: 1, status: 'ready', missing: [], changed: false });

		// Active/Inactive switch: merchants see and subscribe to active apps only
		expect((await call('GET', '/v1/catalog/products')).json.items.some((/** @type {any} */ i) => i.slug === 'pdp')).toBe(false);
		const activated = await call('POST', `/v1/admin/apps/${state.appId}/status`, {
			cookie: state.staff,
			body: { status: 'active' },
		});
		expect(activated.json.status, activated.text).toBe('active');
		const catalog = await call('GET', '/v1/catalog/products');
		const listed = catalog.json.items.find((/** @type {any} */ item) => item.slug === 'pdp');
		expect(listed).toMatchObject({ appId: state.appId });
		expect(listed.elements.map((/** @type {any} */ element) => element.key)).toEqual(
			pack.manifest.elements.map((/** @type {any} */ element) => element.key),
		);
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
		expect(website.status, website.text).toBe(201);
		state.websiteId = website.json.website.websiteId;
		const credits = await call('POST', `/v1/admin/merchants/${state.merchantId}/receipts`, {
			cookie: state.staff,
			body: { credits: 100, amountPaid: 'PKR 10,000', method: 'Bank transfer', reference: 'e2e-pdp-topup' },
		});
		expect(credits.status, credits.text).toBe(201);
		const subscribed = await call('POST', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/subscriptions`, {
			cookie: state.staff,
			body: { appId: state.appId, planCode: 'standard' },
		});
		expect(subscribed.status, subscribed.text).toBe(201);
		expect(subscribed.json.subscription).toMatchObject({ status: 'active', planCode: 'standard', productSlug: 'pdp' });
		state.subscriptionId = subscribed.json.subscription.subscriptionId;
		state.subscribedAt = ctx.clock.now();
	});

	it('compiles the website bundle with the plan’s elements', async () => {
		const { call, state, pack } = ctx;
		const site = `/v1/merchants/${state.merchantId}/websites/${state.websiteId}`;
		const compiled = await call('POST', `${site}/delivery/compile`, { cookie: state.merchant });
		expect(compiled.status, compiled.text).toBe(200);
		expect(compiled.json.artefact.elements.map((/** @type {any} */ e) => e.key).sort()).toEqual([...DEFAULT_ELEMENTS].sort());
		state.version = compiled.json.version;

		const manifest = await call('GET', `/w/${state.websiteId}/${state.version}/manifest.json`);
		expect(manifest.status).toBe(200);
		for (const element of manifest.json.elements) {
			expect(element).toMatchObject({ slug: 'pdp', kind: 'pack' });
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

	it('adds an embed add-on, then every element, each in a new live bundle', async () => {
		const { call, state, pack } = ctx;
		const site = `/v1/merchants/${state.merchantId}/websites/${state.websiteId}`;
		/** @param {string} key */
		const enable = async (key) => {
			const switched = await call(
				'PUT',
				`/v1/merchants/${state.merchantId}/subscriptions/${state.subscriptionId}/elements/${key}`,
				{
					cookie: state.staff,
					body: { enabled: true },
				},
			);
			expect(switched.status, `${key}: ${switched.text}`).toBe(200);
		};
		await enable('reviews_block');
		const withEmbed = await call('POST', `${site}/delivery/compile`, { cookie: state.merchant });
		expect(withEmbed.status, withEmbed.text).toBe(200);
		expect(withEmbed.json.artefact.elements.map((/** @type {any} */ e) => e.key)).toContain('reviews_block');

		for (const element of pack.manifest.elements)
			if (![...DEFAULT_ELEMENTS, 'reviews_block'].includes(element.key)) await enable(element.key);
		const everything = await call('POST', `${site}/delivery/compile`, { cookie: state.merchant });
		expect(everything.status, everything.text).toBe(200);
		expect(everything.json.artefact.elements.map((/** @type {any} */ e) => e.key).sort()).toEqual(
			pack.manifest.elements.map((/** @type {any} */ e) => e.key).sort(),
		);
		expect(everything.json.version).not.toBe(withEmbed.json.version);
		const alias = await call('GET', `/w/${state.websiteId}/loader.js`);
		expect(alias.headers.get('etag')).toBe(`"${everything.json.version}"`);
	});

	it('shows the billing: usage records are never charged', async () => {
		const { call, clock, state } = ctx;
		// charges follow the price-list and switch histories only (PLAN 0.5.3; reports fill them in 0.12 step 5)
		clock.set(clock.now() + 2 * HOUR);
		const billing = await call('GET', `/v1/merchants/${state.merchantId}/billing`, { cookie: state.merchant });
		expect(billing.status, JSON.stringify(billing.json)).toBe(200);
		expect(billing.json).toMatchObject({ status: 'active', balance: 100_000, spentThisMonth: 0 });
		const usage = await call('GET', `/v1/merchants/${state.merchantId}/usage`, { cookie: state.merchant });
		expect(usage.json.rows).toEqual([]);
	});
});
