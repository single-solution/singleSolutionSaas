/**
 * The rights table of PLAN 0.2, enforced by the API: one test per row and per role column (Owner, Support, Finance,
 * Merchant), asserting allowed or refused, plus 401 for a caller who is not signed in; merchant tests also assert
 * that another merchant's records are refused.
 *
 * "Allowed" means the request passed the rights check (any answer but 401 and 403: a refusal for an invalid body or an
 * unknown id comes after the check). "Refused" is 403, except on admin-only routes, which a merchant session does not
 * authenticate at all (401).
 *
 * Rows are tested where their Portal route lives today: identity and system with the real modules; products on
 * websites, features and money with the commerce harness; launches and products with the catalog harness; global
 * defaults with the config harness (the last three move into product dashboards at the switch, PLAN 0.12 step 5).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeMongoClients } from '../src/infra/db.js';
import { MERCHANT, PORTAL_URL, startMongo } from './helpers.js';
import { boot as bootIdentity, setupMongo, teardownMongo } from './modules/identity/boot.js';
import { APP, M1, M2, W1, bootCommerce } from './modules/commerce/fixtures.js';
import { bootPortal } from './modules/catalog/boot.js';
import { startFakeProduct } from './modules/catalog/fakes/product.js';
import { serviceManifest } from './modules/catalog/fixtures.js';
import { boot as bootConfig } from './modules/config/boot.js';
import { APP as CONFIG_APP } from './modules/config/fixtures.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

/** @typedef {{ status: number }} Res */
/** @typedef {'owner' | 'support' | 'finance' | 'merchant'} Column */

const COLUMNS = /** @type {const} */ (['owner', 'support', 'finance', 'merchant']);

/** @param {Res} res */
const allowed = (res) => res.status !== 401 && res.status !== 403;

/**
 * @typedef {object} Row
 * @property {string} name the row of the rights table
 * @property {Record<Column, (as: Record<string, any>) => Promise<void>>} columns one check per role column
 * @property {(as: Record<string, any>) => Promise<Res>} anonymous the row's route without a session
 */

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
beforeAll(async () => {
	mongo = await startMongo();
	await setupMongo();
}, 180_000);
afterAll(async () => {
	await teardownMongo();
	await closeMongoClients();
	await mongo?.stop();
});

/**
 * Run a table section: one `it` per row × column, plus the anonymous check.
 * @param {() => Promise<Record<string, any>>} setup
 * @param {Row[]} rows
 */
const section = (setup, rows) => {
	/** @type {Record<string, any>} */
	let as = {};
	beforeAll(async () => {
		as = await setup();
	}, 180_000);
	for (const row of rows)
		describe(row.name, () => {
			for (const column of COLUMNS) it(column, () => row.columns[column](as));
			it('not signed in → 401', async () => expect((await row.anonymous(as)).status).toBe(401));
		});
};

// ---------------------------------------------------------------------------------------------------------------
// identity and system (real modules)

describe('rights: people, merchants, websites, tokens, admins and Settings', () => {
	section(async () => {
		const h = await bootIdentity();
		const owner = (await h.owner()).client;
		const support = (await h.admin('support')).client;
		const finance = (await h.admin('finance')).client;
		const m = await h.merchantWithWebsite('m@shop.test', 'shop.example.com');
		const other = await h.merchantWithWebsite('other@shop.test', 'other.example.com');
		const pending = (await owner.post('/v1/admin/merchants', { name: 'P', ownerName: 'P', email: 'p@shop.test' })).json.merchant
			.merchantId;
		const anonymous = h.client();
		return { h, owner, support, finance, merchant: m.client, other: other.client, m, otherM: other, pending, anonymous };
	}, [
		{
			name: 'See Overview and Activity (merchant: own only)',
			columns: {
				owner: async (as) => {
					expect((await as.owner.get('/v1/admin/overview')).status).toBe(200);
					expect((await as.owner.get('/v1/admin/activity')).status).toBe(200);
				},
				support: async (as) => expect((await as.support.get('/v1/admin/activity')).status).toBe(200),
				finance: async (as) => expect((await as.finance.get('/v1/admin/overview')).status).toBe(200),
				merchant: async (as) => {
					expect((await as.merchant.get(`/v1/merchants/${as.m.merchantId}/activity`)).status).toBe(200);
					expect((await as.merchant.get(`/v1/merchants/${as.otherM.merchantId}/activity`)).status).toBe(403);
					expect((await as.merchant.get('/v1/admin/activity')).status).toBe(401);
				},
			},
			anonymous: (as) => as.anonymous.get('/v1/admin/overview'),
		},
		{
			name: 'Create merchants; edit merchant details (Finance: view; merchant: edits own in Account)',
			columns: {
				owner: async (as) => expect(allowed(await as.owner.post('/v1/admin/merchants', {}))).toBe(true),
				support: async (as) =>
					expect(allowed(await as.support.patch(`/v1/admin/merchants/${as.m.merchantId}`, { phone: '+1 555' }))).toBe(true),
				finance: async (as) => {
					expect((await as.finance.post('/v1/admin/merchants', {})).status).toBe(403);
					expect((await as.finance.patch(`/v1/admin/merchants/${as.m.merchantId}`, { phone: '+1 555' })).status).toBe(403);
					expect((await as.finance.get(`/v1/admin/merchants/${as.m.merchantId}`)).status).toBe(200);
				},
				merchant: async (as) => {
					expect((await as.merchant.patch('/v1/me', { address: 'Lahore' })).status).toBe(200);
					expect((await as.merchant.get(`/v1/merchants/${as.m.merchantId}`)).status).toBe(200);
					expect((await as.merchant.get(`/v1/merchants/${as.otherM.merchantId}`)).status).toBe(403);
					expect((await as.merchant.post('/v1/admin/merchants', {})).status).toBe(401);
				},
			},
			anonymous: (as) => as.anonymous.post('/v1/admin/merchants', {}),
		},
		{
			name: 'Suspend and resume merchants',
			columns: {
				owner: async (as) => expect(allowed(await as.owner.post(`/v1/admin/merchants/${as.pending}/suspend`, {}))).toBe(true),
				support: async (as) =>
					expect(allowed(await as.support.post(`/v1/admin/merchants/${as.pending}/resume`, {}))).toBe(true),
				finance: async (as) =>
					expect((await as.finance.post(`/v1/admin/merchants/${as.pending}/suspend`, {})).status).toBe(403),
				merchant: async (as) =>
					expect((await as.merchant.post(`/v1/admin/merchants/${as.m.merchantId}/resume`, {})).status).toBe(401),
			},
			anonymous: (as) => as.anonymous.post(`/v1/admin/merchants/${as.pending}/suspend`, {}),
		},
		{
			name: 'Resend or copy merchant setup links',
			columns: {
				owner: async (as) =>
					expect((await as.owner.post(`/v1/admin/merchants/${as.pending}/setup-link`, { copy: true })).status).toBe(200),
				support: async (as) =>
					expect((await as.support.post(`/v1/admin/merchants/${as.pending}/setup-link`, {})).status).toBe(200),
				finance: async (as) =>
					expect((await as.finance.post(`/v1/admin/merchants/${as.pending}/setup-link`, {})).status).toBe(403),
				merchant: async (as) =>
					expect((await as.merchant.post(`/v1/admin/merchants/${as.pending}/setup-link`, {})).status).toBe(401),
			},
			anonymous: (as) => as.anonymous.post(`/v1/admin/merchants/${as.pending}/setup-link`, {}),
		},
		{
			name: "Turn off another person's two-step",
			columns: {
				owner: async (as) =>
					expect(allowed(await as.owner.post(`/v1/admin/merchants/${as.m.merchantId}/two-step/off`, {}))).toBe(true),
				support: async (as) =>
					expect((await as.support.post(`/v1/admin/merchants/${as.m.merchantId}/two-step/off`, {})).status).toBe(403),
				finance: async (as) =>
					expect((await as.finance.post('/v1/admin/admins/adm_0000000000/two-step/off', {})).status).toBe(403),
				merchant: async (as) =>
					expect((await as.merchant.post(`/v1/admin/merchants/${as.otherM.merchantId}/two-step/off`, {})).status).toBe(401),
			},
			anonymous: (as) => as.anonymous.post(`/v1/admin/merchants/${as.m.merchantId}/two-step/off`, {}),
		},
		{
			name: 'Delete a merchant',
			columns: {
				owner: async (as) =>
					expect(allowed(await as.owner.del(`/v1/admin/merchants/${as.pending}`, { confirm: 'not the name' }))).toBe(true),
				support: async (as) =>
					expect((await as.support.del(`/v1/admin/merchants/${as.pending}`, { confirm: 'P' })).status).toBe(403),
				finance: async (as) =>
					expect((await as.finance.del(`/v1/admin/merchants/${as.pending}`, { confirm: 'P' })).status).toBe(403),
				merchant: async (as) =>
					expect((await as.merchant.del(`/v1/admin/merchants/${as.m.merchantId}`, { confirm: 'Shop' })).status).toBe(401),
			},
			anonymous: (as) => as.anonymous.del(`/v1/admin/merchants/${as.pending}`, { confirm: 'P' }),
		},
		{
			name: 'Add and remove websites (Finance: view; merchant: views own)',
			columns: {
				owner: async (as) =>
					expect(allowed(await as.owner.post(`/v1/merchants/${as.m.merchantId}/websites`, { domain: 'bad domain' }))).toBe(
						true,
					),
				support: async (as) =>
					expect(
						allowed(await as.support.del(`/v1/merchants/${as.m.merchantId}/websites/${as.m.websiteId}`, { confirm: 'x' })),
					).toBe(true),
				finance: async (as) => {
					expect((await as.finance.post(`/v1/merchants/${as.m.merchantId}/websites`, { domain: 'a.example' })).status).toBe(
						403,
					);
					expect((await as.finance.get(`/v1/merchants/${as.m.merchantId}/websites`)).status).toBe(200);
				},
				merchant: async (as) => {
					expect((await as.merchant.post(`/v1/merchants/${as.m.merchantId}/websites`, { domain: 'a.example' })).status).toBe(
						403,
					);
					expect(
						(await as.merchant.del(`/v1/merchants/${as.m.merchantId}/websites/${as.m.websiteId}`, { confirm: as.m.domain }))
							.status,
					).toBe(403);
					expect((await as.merchant.get(`/v1/merchants/${as.m.merchantId}/websites`)).status).toBe(200);
					expect((await as.merchant.get(`/v1/merchants/${as.otherM.merchantId}/websites`)).status).toBe(403);
				},
			},
			anonymous: (as) => as.anonymous.get(`/v1/merchants/${as.m.merchantId}/websites`),
		},
		{
			name: 'Reveal, copy and regenerate server tokens (merchant: own)',
			columns: {
				owner: async (as) =>
					expect((await as.owner.get(`/v1/merchants/${as.m.merchantId}/websites/${as.m.websiteId}/keys`)).status).toBe(200),
				support: async (as) =>
					expect(
						allowed(
							await as.support.post(`/v1/merchants/${as.m.merchantId}/websites/${as.m.websiteId}/keys`, { kind: 'x' }),
						),
					).toBe(true),
				finance: async (as) =>
					expect((await as.finance.get(`/v1/merchants/${as.m.merchantId}/websites/${as.m.websiteId}/keys`)).status).toBe(
						403,
					),
				merchant: async (as) => {
					expect((await as.merchant.get(`/v1/merchants/${as.m.merchantId}/websites/${as.m.websiteId}/keys`)).status).toBe(
						200,
					);
					expect(
						(await as.merchant.get(`/v1/merchants/${as.otherM.merchantId}/websites/${as.otherM.websiteId}/keys`)).status,
					).toBe(403);
				},
			},
			anonymous: (as) => as.anonymous.get(`/v1/merchants/${as.m.merchantId}/websites/${as.m.websiteId}/keys`),
		},
		{
			name: 'Edit settings, widget texts, theme and connections (merchant: own)',
			columns: {
				owner: async (as) =>
					expect(allowed(await as.owner.patch(`/v1/merchants/${as.m.merchantId}/websites/${as.m.websiteId}`, {}))).toBe(
						true,
					),
				support: async (as) =>
					expect(allowed(await as.support.patch(`/v1/merchants/${as.m.merchantId}/websites/${as.m.websiteId}`, {}))).toBe(
						true,
					),
				finance: async (as) =>
					expect((await as.finance.patch(`/v1/merchants/${as.m.merchantId}/websites/${as.m.websiteId}`, {})).status).toBe(
						403,
					),
				merchant: async (as) => {
					expect(allowed(await as.merchant.patch(`/v1/merchants/${as.m.merchantId}/websites/${as.m.websiteId}`, {}))).toBe(
						true,
					);
					expect(
						(await as.merchant.patch(`/v1/merchants/${as.otherM.merchantId}/websites/${as.otherM.websiteId}`, {})).status,
					).toBe(403);
				},
			},
			anonymous: (as) => as.anonymous.patch(`/v1/merchants/${as.m.merchantId}/websites/${as.m.websiteId}`, {}),
		},
		{
			name: 'Admins: invite, resend (or copy) invite, correct invite e-mail, change role, remove',
			columns: {
				owner: async (as) => expect((await as.owner.get('/v1/admin/admins')).status).toBe(200),
				support: async (as) => expect((await as.support.post('/v1/admin/admins', {})).status).toBe(403),
				finance: async (as) => expect((await as.finance.get('/v1/admin/admins')).status).toBe(403),
				merchant: async (as) => expect((await as.merchant.get('/v1/admin/admins')).status).toBe(401),
			},
			anonymous: (as) => as.anonymous.get('/v1/admin/admins'),
		},
		{
			name: 'Settings (e-mail, billing rules, branding, support contact, security)',
			columns: {
				owner: async (as) => expect((await as.owner.get('/v1/admin/settings')).status).toBe(200),
				support: async (as) => expect((await as.support.send('PUT', '/v1/admin/settings/branding', {})).status).toBe(403),
				finance: async (as) => expect((await as.finance.get('/v1/admin/settings')).status).toBe(403),
				merchant: async (as) => expect((await as.merchant.get('/v1/admin/settings')).status).toBe(401),
			},
			anonymous: (as) => as.anonymous.get('/v1/admin/settings'),
		},
	]);
});

// ---------------------------------------------------------------------------------------------------------------
// commerce (products on websites, features, money)

describe('rights: products on websites, features, credits, receipts and charges', () => {
	section(async () => {
		const h = await bootCommerce({ mongo, dbName: 'rights_commerce' });
		await h.credit(M1, 100_000);
		const owner = await h.login({ kind: 'admin', subject: 'adm_owner' });
		const support = await h.login({ kind: 'admin', subject: 'adm_support' });
		const finance = await h.login({ kind: 'admin', subject: 'adm_finance' });
		const merchant = await h.login({ kind: 'merchant', subject: M1 });
		const other = await h.login({ kind: 'merchant', subject: M2 });
		let n = 0;
		/** @param {Record<string, string>} who @param {string} method @param {string} path @param {unknown} [body] */
		const as = (who, method, path, body) =>
			h.call(method, path, {
				headers: { ...who, ...(method === 'POST' ? { 'idempotency-key': `r-${(n += 1)}` } : {}) },
				body,
			});
		const sub = await as(owner, 'POST', `/v1/merchants/${M1}/websites/${W1}/subscriptions`, {
			appId: APP,
			planCode: 'starter',
		});
		expect(sub.status).toBe(201);
		return { h, owner, support, finance, merchant, other, as, sub: sub.json.subscription.subscriptionId };
	}, [
		{
			name: 'Add and remove products on websites (Finance: view; merchant: views own)',
			columns: {
				owner: async (x) =>
					expect(
						allowed(await x.as(x.owner, 'POST', `/v1/merchants/${M1}/websites/${W1}/subscriptions`, { appId: 'nope' })),
					).toBe(true),
				support: async (x) =>
					expect(
						allowed(
							await x.as(x.support, 'POST', `/v1/merchants/${M1}/subscriptions/${x.sub}/pause`, { reason: 'bad Reason' }),
						),
					).toBe(true),
				finance: async (x) => {
					expect(
						(await x.as(x.finance, 'POST', `/v1/merchants/${M1}/websites/${W1}/subscriptions`, { appId: APP })).status,
					).toBe(403);
					expect((await x.as(x.finance, 'GET', `/v1/merchants/${M1}/subscriptions`)).status).toBe(200);
				},
				merchant: async (x) => {
					expect(
						(await x.as(x.merchant, 'POST', `/v1/merchants/${M1}/websites/${W1}/subscriptions`, { appId: APP })).status,
					).toBe(403);
					expect((await x.as(x.merchant, 'POST', `/v1/merchants/${M1}/subscriptions/${x.sub}/cancel`, {})).status).toBe(403);
					expect((await x.as(x.merchant, 'GET', `/v1/merchants/${M1}/subscriptions`)).status).toBe(200);
					expect((await x.as(x.other, 'GET', `/v1/merchants/${M1}/subscriptions`)).status).toBe(403);
				},
			},
			anonymous: (x) => x.h.call('GET', `/v1/merchants/${M1}/subscriptions`),
		},
		{
			name: 'Switch features on and off (merchant: sees them read-only)',
			columns: {
				owner: async (x) =>
					expect(
						(await x.as(x.owner, 'PUT', `/v1/merchants/${M1}/subscriptions/${x.sub}/elements/reports`, { enabled: true }))
							.status,
					).toBe(200),
				support: async (x) =>
					expect(
						(
							await x.as(x.support, 'PUT', `/v1/merchants/${M1}/subscriptions/${x.sub}/elements/reports`, {
								enabled: false,
							})
						).status,
					).toBe(200),
				finance: async (x) =>
					expect(
						(await x.as(x.finance, 'PUT', `/v1/merchants/${M1}/subscriptions/${x.sub}/elements/reports`, { enabled: true }))
							.status,
					).toBe(403),
				merchant: async (x) => {
					expect(
						(
							await x.as(x.merchant, 'PUT', `/v1/merchants/${M1}/subscriptions/${x.sub}/elements/reports`, {
								enabled: true,
							})
						).status,
					).toBe(403);
					expect((await x.as(x.merchant, 'GET', `/v1/merchants/${M1}/subscriptions/${x.sub}`)).status).toBe(200);
					expect((await x.as(x.other, 'GET', `/v1/merchants/${M1}/subscriptions/${x.sub}`)).status).toBe(403);
				},
			},
			anonymous: (x) =>
				x.h.call('PUT', `/v1/merchants/${M1}/subscriptions/${x.sub}/elements/reports`, { body: { enabled: true } }),
		},
		{
			name: 'Add credits',
			columns: {
				owner: async (x) => expect(allowed(await x.as(x.owner, 'POST', `/v1/admin/merchants/${M1}/receipts`, {}))).toBe(true),
				support: async (x) =>
					expect((await x.as(x.support, 'POST', `/v1/admin/merchants/${M1}/receipts`, {})).status).toBe(403),
				finance: async (x) =>
					expect(allowed(await x.as(x.finance, 'POST', `/v1/admin/merchants/${M1}/receipts`, {}))).toBe(true),
				merchant: async (x) =>
					expect((await x.as(x.merchant, 'POST', `/v1/admin/merchants/${M1}/receipts`, {})).status).toBe(401),
			},
			anonymous: (x) =>
				x.h.call('POST', `/v1/admin/merchants/${M1}/receipts`, { headers: { 'idempotency-key': 'anon' }, body: {} }),
		},
		{
			name: 'See receipts and charges (Support: view; merchant: own)',
			columns: {
				owner: async (x) => expect((await x.as(x.owner, 'GET', `/v1/admin/merchants/${M1}/day-charges`)).status).toBe(200),
				support: async (x) =>
					expect((await x.as(x.support, 'GET', `/v1/admin/merchants/${M1}/day-charges`)).status).toBe(200),
				finance: async (x) => expect((await x.as(x.finance, 'GET', `/v1/merchants/${M1}/usage`)).status).toBe(200),
				merchant: async (x) => {
					expect((await x.as(x.merchant, 'GET', `/v1/merchants/${M1}/usage`)).status).toBe(200);
					expect((await x.as(x.other, 'GET', `/v1/merchants/${M1}/usage`)).status).toBe(403);
					expect((await x.as(x.merchant, 'GET', `/v1/admin/merchants/${M1}/day-charges`)).status).toBe(401);
				},
			},
			anonymous: (x) => x.h.call('GET', `/v1/merchants/${M1}/usage`),
		},
	]);
});

// ---------------------------------------------------------------------------------------------------------------
// catalog (launches and products)

describe('rights: product dashboards and Products', () => {
	/** @type {Array<{ close: () => Promise<unknown> }>} */
	const products = [];
	afterAll(async () => {
		await Promise.all(products.map((p) => p.close()));
	});
	section(async () => {
		const t = await bootPortal({ db: mongo.db('rights_catalog') });
		const p = await startFakeProduct({ manifest: serviceManifest(), portalUrl: PORTAL_URL, now: t.clock.now });
		products.push(p);
		const registered = await t.register(p);
		expect(registered.status).toBe(201);
		const appId = registered.json.appId;
		await t.staff('POST', `/v1/admin/apps/${appId}/status`, { body: { status: 'active' } });
		return {
			t,
			appId,
			owner: await t.session({ role: 'owner' }),
			support: await t.session({ role: 'support' }),
			finance: await t.session({ role: 'finance' }),
			merchant: await t.session({ kind: 'merchant', merchantId: MERCHANT }),
		};
	}, [
		{
			name: 'Open a product dashboard for a website (Finance: refused; merchant: own websites)',
			columns: {
				owner: async (x) =>
					expect(
						(
							await x.t.call('POST', `/v1/admin/apps/${x.appId}/launch`, {
								cookie: x.owner,
								body: { merchantId: MERCHANT },
							})
						).status,
					).toBe(200),
				support: async (x) =>
					expect(
						(
							await x.t.call('POST', `/v1/admin/apps/${x.appId}/launch`, {
								cookie: x.support,
								body: { merchantId: MERCHANT },
							})
						).status,
					).toBe(200),
				finance: async (x) =>
					expect(
						(
							await x.t.call('POST', `/v1/admin/apps/${x.appId}/launch`, {
								cookie: x.finance,
								body: { merchantId: MERCHANT },
							})
						).status,
					).toBe(403),
				merchant: async (x) => {
					expect(
						(await x.t.call('POST', `/v1/merchants/${MERCHANT}/apps/${x.appId}/launch`, { cookie: x.merchant, body: {} }))
							.status,
					).toBe(200);
					expect(
						(
							await x.t.call('POST', `/v1/merchants/mer_1123456789abcdefghjkmnpq/apps/${x.appId}/launch`, {
								cookie: x.merchant,
								body: {},
							})
						).status,
					).toBe(403);
				},
			},
			anonymous: (x) => x.t.call('POST', `/v1/admin/apps/${x.appId}/launch`, { body: { merchantId: MERCHANT } }),
		},
		{
			name: 'Products: connect, reconnect, set active/inactive, Open as admin with no website',
			columns: {
				owner: async (x) => {
					expect(
						(await x.t.call('POST', `/v1/admin/apps/${x.appId}/status`, { cookie: x.owner, body: { status: 'active' } }))
							.status,
					).toBe(200);
					expect(
						(await x.t.call('POST', `/v1/admin/apps/${x.appId}/launch`, { cookie: x.owner, body: { all: true } })).status,
					).toBe(200);
				},
				support: async (x) => {
					expect(
						(await x.t.call('POST', `/v1/admin/apps/${x.appId}/status`, { cookie: x.support, body: { status: 'active' } }))
							.status,
					).toBe(403);
					expect(
						(await x.t.call('POST', `/v1/admin/apps/${x.appId}/launch`, { cookie: x.support, body: { all: true } })).status,
					).toBe(403);
				},
				finance: async (x) =>
					expect(
						(
							await x.t.call('POST', '/v1/admin/apps/connect', {
								cookie: x.finance,
								body: { url: 'https://x.test', secret: 'x' },
							})
						).status,
					).toBe(403),
				merchant: async (x) =>
					expect(
						(
							await x.t.call('POST', `/v1/admin/apps/${x.appId}/status`, {
								cookie: x.merchant,
								body: { status: 'inactive' },
							})
						).status,
					).toBe(401),
			},
			anonymous: (x) => x.t.call('POST', `/v1/admin/apps/${x.appId}/status`, { body: { status: 'active' } }),
		},
	]);
});

// ---------------------------------------------------------------------------------------------------------------
// config (global defaults until the switch)

describe('rights: global defaults and prices', () => {
	section(async () => {
		const app = await bootConfig({ db: mongo.db('rights_config') });
		return {
			app,
			owner: await app.login({ kind: 'admin', subject: 'adm_owner' }),
			support: await app.login({ kind: 'admin', subject: 'adm_support' }),
			finance: await app.login({ kind: 'admin', subject: 'adm_finance' }),
			merchant: await app.login({ kind: 'merchant', subject: 'mer_aaaaaaaaaaaaaaaaaaaaaaaaaa' }),
		};
	}, [
		{
			name: 'Edit global defaults and prices',
			columns: {
				owner: async (x) =>
					expect(
						allowed(await x.app.call('PATCH', `/v1/admin/config/platform/${CONFIG_APP}`, { cookie: x.owner, body: {} })),
					).toBe(true),
				support: async (x) =>
					expect(
						(await x.app.call('PATCH', `/v1/admin/config/platform/${CONFIG_APP}`, { cookie: x.support, body: {} })).status,
					).toBe(403),
				finance: async (x) =>
					expect(
						(await x.app.call('PATCH', `/v1/admin/config/platform/${CONFIG_APP}`, { cookie: x.finance, body: {} })).status,
					).toBe(403),
				merchant: async (x) =>
					expect(
						(await x.app.call('PATCH', `/v1/admin/config/platform/${CONFIG_APP}`, { cookie: x.merchant, body: {} })).status,
					).toBe(401),
			},
			anonymous: (x) => x.app.call('PATCH', `/v1/admin/config/platform/${CONFIG_APP}`, { body: {} }),
		},
	]);
});
