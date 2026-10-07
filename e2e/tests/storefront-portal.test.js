/**
 * Pack delivery against the REAL Portal (`@ss/platform/testing`: `createPortal` with the production modules incl.
 * delivery), in process, on the test run's MongoMemoryReplSet. Storefront Blocks is an element pack (no backend), so
 * instead of a product server this test drives the delivery plane end to end:
 *
 *   first admin from the sign-in page (password, then TOTP) → upload the `ss pack build` output (Admin → Apps → Upload
 *   pack version: the `ss-pack-bundle@1` descriptor, then every missing asset, bytes = the descriptor's sha256/size) →
 *   Active → listed in the catalog with its 13 elements → merchant signs up, adds a website, gets credits, subscribes
 *   (pro) → compile the website bundle → the immutable loader holds the plan's default elements, the pack modules are
 *   served byte for byte → the compiled loader runs in a page (JSDOM) and mounts the real grid, filters and theme from
 *   the served modules → switching on every add-on compiles a new live bundle → hourly settlement charges the
 *   subscription's priced elements.
 * System test (the `e2e/` workspace): it runs the Portal (`@ss/platform/testing`) and the pack (`@ss/product-storefront/pack`).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
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
import { buildPack, descriptorOf } from '@ss/product-storefront/pack';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClock, mongoUri, LONG_SESSIONS, PORTAL_ENCRYPTION_KEY } from './helpers.js';

/** jsdom ships no type declarations (the same typed require as the Portal's delivery tests). */
/** @type {{ JSDOM: new (html?: string, options?: Record<string, unknown>) => { window: any } }} */
const { JSDOM } = createRequire(import.meta.url)('jsdom');

const HOUR = 3_600_000;
const PORTAL_URL = 'http://127.0.0.1:4999';
const STAFF = { email: 'root@portal.test', password: 'staff password 123!' };
const MERCHANT_USER = { email: 'owner@shop.example.com', password: 'merchant password 123!' };
const SHOP = 'https://shop.example.com';

/** Relative module specifiers of static imports, re-exports and literal dynamic imports (esbuild output). */
const IMPORT =
	/(?:\bimport|\bexport)\s*(?:[\w$*{}\s,]*?\bfrom\s*)?["'](\.{1,2}\/[^"'\s]+)["']|\bimport\s*\(\s*["'](\.{1,2}\/[^"'\s]+)["']\s*\)/g;

/**
 * Relative import specifiers of a served module (`import{a}from"./chunks/x.js"`, `import"./y.js"`, `import("./z.js")`).
 * @param {string} text
 * @returns {string[]}
 */
const relativeImports = (text) => [...text.matchAll(IMPORT)].map((match) => String(match[1] ?? match[2]));

/** In-memory mailer (identity e-mails). */
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
	const clock = createClock(Date.now());
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
	const portalDb = mongo.db(`e2e_portal_${randomBytes(4).toString('hex')}`);
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
			createCatalogModule(),
			createIdentityModule({ mailer }),
			configModule,
			createConnectorsModule(),
			commerceModule,
			createDeliveryModule(),
		],
	});
	await portal.ensureIndexes();

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
				...(raw ? { body: /** @type {any} */ (raw) } : body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		const bytes = Buffer.from(await response.arrayBuffer());
		const text = bytes.toString('utf8');
		const setCookie = response.headers
			.getSetCookie()
			.map((value) => value.split(';')[0])
			.find((pair) => /=.+/.test(pair ?? ''));
		const json = (response.headers.get('content-type') ?? '').includes('json') && text ? JSON.parse(text) : null;
		return { status: response.status, headers: response.headers, bytes, text, json, cookie: setCookie ?? null };
	};
	ctx = { clock, portal, portalDb, mongo, mailer, call, state: {} };
}, 120_000);

afterAll(async () => {
	if (!ctx) return;
	await ctx.portalDb.dropDatabase().catch(() => undefined);
	await ctx.mongo.close();
	await closeMongoClients();
});

describe('Storefront Blocks delivered by the real Portal', () => {
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

	it('uploads the pack (descriptor, then every asset) and lists it after activation', async () => {
		const { call, state } = ctx;
		// `ss pack build`: minified entries + shared chunks + strings/en.json, hashed into the descriptor (F.18)
		const pack = await buildPack();
		const { manifest, assets } = pack;
		const uploaded = await call('POST', '/v1/admin/packs', { cookie: state.staff, body: { descriptor: descriptorOf(pack) } });
		expect(uploaded.status, JSON.stringify(uploaded.json)).toBe(201);
		expect(uploaded.json).toMatchObject({ slug: 'storefront', kind: 'pack', version: 1, status: 'uploading' });
		expect(uploaded.json.missing).toHaveLength(assets.length);
		state.appId = uploaded.json.appId;
		state.assets = assets;
		// a tampered asset is refused: the bytes must equal the descriptor
		const grid = /** @type {any} */ (assets.find((a) => a.path === 'ui/grid.js'));
		const tampered = await call('PUT', `${uploaded.json.uploadPath}${grid.path}`, {
			cookie: state.staff,
			raw: Buffer.concat([grid.bytes, Buffer.from('\n')]),
			headers: { 'content-type': 'text/javascript' },
		});
		expect(tampered.status).toBe(422);
		for (const path of uploaded.json.missing) {
			const asset = /** @type {any} */ (assets.find((a) => a.path === path));
			const put = await call('PUT', `${uploaded.json.uploadPath}${path}`, {
				cookie: state.staff,
				raw: asset.bytes,
				headers: { 'content-type': asset.contentType },
			});
			expect(put.status, `${path}: ${put.text}`).toBe(200);
		}
		// the last asset made version 1 current; Active/Inactive switch: merchants see active apps only
		const app = await call('GET', `/v1/admin/apps/${state.appId}`, { cookie: state.staff });
		expect(app.json).toMatchObject({ kind: 'pack', status: 'inactive', currentVersion: 1 });
		const activated = await call('POST', `/v1/admin/apps/${state.appId}/status`, {
			cookie: state.staff,
			body: { status: 'active' },
		});
		expect(activated.json.status).toBe('active');
		const catalog = await call('GET', '/v1/catalog/products?kind=pack');
		const listed = catalog.json.items.find((/** @type {any} */ item) => item.slug === 'storefront');
		expect(listed.elements.map((/** @type {any} */ e) => e.key)).toEqual(
			manifest.elements.map((/** @type {any} */ e) => e.key),
		);
	});

	it('lets a merchant sign up, add a website, receive credits and subscribe (pro)', async () => {
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
		const credits = await call('POST', `/v1/admin/merchants/${state.merchantId}/credits`, {
			cookie: state.staff,
			body: { amountMillicredits: 100_000, reference: 'e2e-topup-1', note: 'end-to-end test credits' },
		});
		expect(credits.status, JSON.stringify(credits.json)).toBe(201);
		const subscribed = await call('POST', `/v1/merchants/${state.merchantId}/websites/${state.websiteId}/subscriptions`, {
			cookie: state.staff,
			body: { appId: state.appId, planCode: 'pro' },
		});
		expect(subscribed.status, JSON.stringify(subscribed.json)).toBe(201);
		expect(subscribed.json.subscription).toMatchObject({ status: 'active', planCode: 'pro', productSlug: 'storefront' });
		state.subscriptionId = subscribed.json.subscription.subscriptionId;
		state.subscribedAt = ctx.clock.now();
	});

	it('compiles the website bundle with the plan’s elements and serves the modules', async () => {
		const { call, state } = ctx;
		const site = `/v1/merchants/${state.merchantId}/websites/${state.websiteId}`;
		const compiled = await call('POST', `${site}/delivery/compile`, { cookie: state.merchant });
		expect(compiled.status, JSON.stringify(compiled.json)).toBe(200);
		state.version = compiled.json.version;
		expect(compiled.json.artefact.elements.map((/** @type {any} */ e) => e.key).sort()).toEqual(
			['filters', 'grid', 'hero', 'notice_bar', 'theme'].sort(),
		);
		const loader = await call('GET', `/w/${state.websiteId}/loader.js`);
		expect(loader.status).toBe(200);
		expect(loader.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=600');
		expect(loader.text).toContain(`packs/${state.appId}/1/headless/grid.js`);
		expect(loader.text).toContain('"product":"storefront"');
		expect(loader.text).toContain('[data-ss-slot=\\"grid\\"]');
		state.loader = loader.text;
		const artefact = await call('GET', `/w/${state.websiteId}/${state.version}/manifest.json`);
		expect(artefact.status).toBe(200);
		const bundle = JSON.parse(artefact.text);
		expect(bundle.format).toBe('ss-website-bundle@1');
		expect(bundle.elements.every((/** @type {any} */ e) => e.kind === 'pack' && e.slug === 'storefront')).toBe(true);
		// the pack reads Catalog, Search and Deals (manifest.reads); none is subscribed here, so no client is passed
		expect(bundle.warnings.map((/** @type {any} */ w) => w.code)).toEqual(['reads_inactive']);
		for (const path of ['headless/grid.js', 'ui/grid.js', 'strings/en.json']) {
			const served = await call('GET', `/w/packs/${state.appId}/1/${path}`);
			expect(served.status, path).toBe(200);
			expect(served.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
			expect(served.bytes.equals(state.assets.find((/** @type {any} */ a) => a.path === path).bytes), path).toBe(true);
		}
	});

	it('runs the compiled loader in a page: the served grid, filters and theme mount and work', async () => {
		const { call, state } = ctx;
		const items = [
			{ id: 'a1', title: 'Desk lamp', url: '/items/desk-lamp', price: 4500, currency: 'EUR', brand: 'Lumo' },
			{ id: 'a2', title: 'Armchair', url: '/items/armchair', price: 30000, currency: 'EUR', brand: 'Sitwell' },
			{ id: 'a3', title: 'Floor lamp', url: '/items/floor-lamp', price: 12000, currency: 'EUR', brand: 'Lumo' },
		];
		const modules = await mkdtemp(path.join(tmpdir(), 'ss-e2e-storefront-'));
		/** @type {Set<string>} */
		const mirrored = new Set();
		const dom = new JSDOM(
			`<!doctype html><html lang="en"><head></head><body><div data-ss-slot="filters"></div><div data-ss-slot="grid"></div><script type="application/json" id="ss-items">${JSON.stringify(items)}</script></body></html>`,
			{ url: `${SHOP}/collections/all?brand=Lumo`, runScripts: 'outside-only', pretendToBeVisual: true },
		);
		const win = /** @type {any} */ (dom.window);
		win.fetch = async () =>
			new Response(JSON.stringify({ results: [] }), { status: 202, headers: { 'content-type': 'application/json' } });
		const options = {
			window: win,
			storage: null,
			fetch: win.fetch,
			// the served modules import their shared chunks relatively: mirror them (as served) in a folder and import there
			importModule: async (/** @type {string} */ url) => {
				/** @param {string} pathname */
				const mirror = async (pathname) => {
					const target = path.join(modules, pathname);
					if (mirrored.has(target)) return target;
					mirrored.add(target);
					const served = await call('GET', pathname);
					expect(served.status, pathname).toBe(200);
					await mkdir(path.dirname(target), { recursive: true });
					await writeFile(target, served.bytes);
					for (const specifier of relativeImports(served.text))
						await mirror(path.posix.join(path.posix.dirname(pathname), specifier));
					return target;
				};
				return import(pathToFileURL(await mirror(new URL(url).pathname)).href);
			},
		};
		// the loader ends with `__ssr.start(<data>);})();`: pass the test's options (module import, fetch) as well
		const start = state.loader.lastIndexOf('__ssr.start(');
		const close = state.loader.indexOf(');\n})();', start);
		expect(start).toBeGreaterThan(0);
		expect(close).toBeGreaterThan(start);
		// One realm, as in a browser: the runtime and the served modules run in this realm against the page's window.
		new Function('__ssOptions', `${state.loader.slice(0, close)},__ssOptions${state.loader.slice(close)}`)(options);
		const doc = win.document;
		const until = async (/** @type {() => boolean} */ ready) => {
			for (let i = 0; i < 100 && !ready(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
			return ready();
		};
		expect(await until(() => doc.querySelectorAll('.ss-grid__list li').length === 2)).toBe(true);
		expect([...doc.querySelectorAll('.ss-card__link')].map((/** @type {any} */ a) => a.textContent)).toEqual([
			'Desk lamp',
			'Floor lamp',
		]);
		expect(doc.querySelector('.ss-grid').getAttribute('aria-label')).toBe('Items');
		expect(await until(() => doc.querySelector('.ss-filters fieldset') !== null)).toBe(true);
		expect(doc.querySelector('input[data-k="brand:Lumo"]').checked).toBe(true);
		// the theme element wrote the design tokens on the page root
		expect(await until(() => doc.documentElement.style.getPropertyValue('--ss-color-primary') !== '')).toBe(true);
		// filters → URL → grid, across two independently mounted elements
		doc.querySelector('input[data-k="brand:Lumo"]').click();
		expect(await until(() => doc.querySelectorAll('.ss-grid__list li').length === 3)).toBe(true);
		expect(win.location.search).toBe('');
		dom.window.close();
		await rm(modules, { recursive: true, force: true });
	});

	it('switches on every add-on into a new live bundle, and off again', async () => {
		const { call, state } = ctx;
		for (const key of [
			'cards',
			'trending_band',
			'search_overlay',
			'category_cards',
			'brand_cards',
			'deals_page',
			'mobile_tab_bar',
		]) {
			const switched = await call(
				'PUT',
				`/v1/merchants/${state.merchantId}/subscriptions/${state.subscriptionId}/elements/${key}`,
				{
					cookie: state.staff,
					body: { enabled: true },
				},
			);
			expect(switched.status, `${key}: ${switched.text}`).toBe(200);
		}
		const site = `/v1/merchants/${state.merchantId}/websites/${state.websiteId}`;
		const everything = await call('POST', `${site}/delivery/compile`, { cookie: state.merchant });
		expect(everything.status, everything.text).toBe(200);
		expect(everything.json.artefact.elements.map((/** @type {any} */ e) => e.key)).toEqual(
			expect.arrayContaining(['grid', 'cards', 'trending_band', 'search_overlay', 'deals_page', 'mobile_tab_bar']),
		);
		const live = await call('GET', `/w/${state.websiteId}/loader.js`);
		expect(live.headers.get('etag')).toBe(`"${everything.json.version}"`);
		// switching the extras off again compiles
		for (const key of [
			'trending_band',
			'category_cards',
			'brand_cards',
			'deals_page',
			'mobile_tab_bar',
			'search_overlay',
			'cards',
		])
			await call('PUT', `/v1/merchants/${state.merchantId}/subscriptions/${state.subscriptionId}/elements/${key}`, {
				cookie: state.staff,
				body: { enabled: false },
			});
		expect((await call('POST', `${site}/delivery/compile`, { cookie: state.merchant })).status).toBe(200);
	});

	it('settles complete hours: the priced elements are charged in credits', async () => {
		const { call, state, clock } = ctx;
		const hour0 = Math.floor(state.subscribedAt / HOUR) * HOUR;
		// two complete hours after the subscription's hour, past the settlement lag (2 min): independent of the minute
		clock.advance(hour0 + 2 * HOUR + 5 * 60_000 - clock.now());
		// no cron: reading the statement settles the merchant's complete hours first
		const from = encodeURIComponent(new Date(hour0 - HOUR).toISOString());
		const to = encodeURIComponent(new Date(clock.now() + HOUR).toISOString());
		const statement = await call('GET', `/v1/merchants/${state.merchantId}/statement?from=${from}&to=${to}`, {
			cookie: state.merchant,
		});
		expect(statement.status, JSON.stringify(statement.json)).toBe(200);
		const settlements = statement.json.entries.filter(
			(/** @type {any} */ entry) => entry.type === 'settlement' && entry.subscriptionId === state.subscriptionId,
		);
		const iso = (/** @type {number} */ ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
		const second = settlements.find(
			(/** @type {any} */ entry) => entry.periodKey === `${state.subscriptionId}:${iso(hour0 + HOUR)}`,
		);
		// pro switched on: grid 200 + filters 150 + hero 100 millicredits per hour (theme and notice bar are free)
		expect(second?.amountMillicredits, JSON.stringify(settlements)).toBe(-450);
	});
});
