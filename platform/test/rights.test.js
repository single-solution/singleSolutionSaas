/**
 * The rights table of PLAN 0.2, enforced by the API: one test per row and per role column (Owner, Support, Finance,
 * Merchant), asserting allowed or refused, plus 401 for a caller who is not signed in; merchant tests also assert
 * that another merchant's records are refused.
 *
 * "Allowed" means the request passed the rights check (any answer but 401 and 403: a refusal for an invalid body or an
 * unknown id comes after the check). "Refused" is 403, except on admin-only routes, which a merchant session does not
 * authenticate at all (401).
 *
 * Rows are tested where their Portal route lives: identity and system with the real modules; products on websites and
 * money with the commerce harness; dashboards and Products with the real modules and a fake product. The rows each
 * product enforces on its own server (`PRODUCT_ENFORCED_ROWS`) are tested on the Portal's part of them: the feature
 * report accepts only a current Owner or Support admin, and launches carry the role a product checks (Finance is never
 * launched; Defaults and Prices open only for Owners, with no website).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { manifest as notesManifest } from '@ss/contracts/testing';
import { closeMongoClients } from '../src/infra/db.js';
import { PRODUCT_ENFORCED_ROWS } from '../src/infra/rbac.js';
import { startMongo } from './helpers.js';
import { boot as bootIdentity, setupMongo, teardownMongo } from './modules/identity/boot.js';
import { FINANCE_ADMIN, M1, M2, OWNER_ADMIN, PRODUCT, SUPPORT_ADMIN, W1, W2, bootCommerce } from './modules/commerce/fixtures.js';
import { bootPortal } from './modules/catalog/boot.js';

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
		const site = `/v1/merchants/${m.merchantId}/websites/${m.websiteId}`;
		return { h, owner, support, finance, merchant: m.client, other: other.client, m, otherM: other, pending, anonymous, site };
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
				owner: async (as) => expect((await as.owner.get(`${as.site}/tokens`)).status).toBe(200),
				support: async (as) =>
					expect(allowed(await as.support.post(`${as.site}/tokens/notes/regenerate`, { kind: 'server' }))).toBe(true),
				finance: async (as) => {
					expect((await as.finance.get(`${as.site}/tokens`)).status).toBe(403);
					expect((await as.finance.post(`${as.site}/tokens/notes/reveal`, {})).status).toBe(403);
				},
				merchant: async (as) => {
					expect((await as.merchant.get(`${as.site}/tokens`)).status).toBe(200);
					expect(allowed(await as.merchant.post(`${as.site}/tokens/notes/reveal`, {}))).toBe(true);
					expect(
						(await as.merchant.get(`/v1/merchants/${as.otherM.merchantId}/websites/${as.otherM.websiteId}/tokens`)).status,
					).toBe(403);
				},
			},
			anonymous: (as) => as.anonymous.get(`${as.site}/tokens`),
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
// commerce (products on websites, money, and the Portal's part of switching features)

describe('rights: products on websites, switching features, credits, receipts and charges', () => {
	section(async () => {
		const h = await bootCommerce({ mongo, dbName: 'rights_commerce' });
		await h.credit(M1, 100_000);
		await h.prices(PRODUCT, 1, { codes: 1000, box: 500 });
		await h.service.addProduct({
			merchantId: M1,
			websiteId: W1,
			productId: PRODUCT,
			actor: /** @type {any} */ ({ type: 'admin', id: OWNER_ADMIN, role: 'owner', name: 'Olivia' }),
		});
		const product = await h.productAuth(PRODUCT);
		const owner = await h.login({ kind: 'admin', subject: 'adm_owner' });
		const support = await h.login({ kind: 'admin', subject: 'adm_support' });
		const finance = await h.login({ kind: 'admin', subject: 'adm_finance' });
		const merchant = await h.login({ kind: 'merchant', subject: M1 });
		const other = await h.login({ kind: 'merchant', subject: M2 });
		let n = 0;
		let version = 0;
		/** @param {Record<string, string>} who @param {string} method @param {string} path @param {unknown} [body] */
		const as = (who, method, path, body) =>
			h.call(method, path, {
				headers: { ...who, ...(method === 'POST' ? { 'idempotency-key': `r-${(n += 1)}` } : {}) },
				body,
			});
		/** A feature report naming an admin (or a merchant id). @param {string} adminId */
		const report = async (adminId) =>
			h.call('PUT', `/v1/product/websites/${W1}/features`, {
				headers: await product(),
				body: { version: (version += 1), on: ['codes'], adminId, adminName: 'x' },
			});
		return { h, owner, support, finance, merchant, other, as, report };
	}, [
		{
			name: 'Add and remove products on websites (Finance: view; merchant: views own)',
			columns: {
				owner: async (x) =>
					expect(
						(await x.as(x.owner, 'POST', `/v1/merchants/${M1}/websites/${W2}/products`, { productId: PRODUCT })).status,
					).toBe(201),
				support: async (x) =>
					expect(allowed(await x.as(x.support, 'DELETE', `/v1/merchants/${M1}/websites/${W2}/products/${PRODUCT}`))).toBe(
						true,
					),
				finance: async (x) => {
					expect(
						(await x.as(x.finance, 'POST', `/v1/merchants/${M1}/websites/${W1}/products`, { productId: PRODUCT })).status,
					).toBe(403);
					expect((await x.as(x.finance, 'GET', `/v1/merchants/${M1}/websites/${W1}/products`)).status).toBe(200);
				},
				merchant: async (x) => {
					expect(
						(await x.as(x.merchant, 'POST', `/v1/merchants/${M1}/websites/${W1}/products`, { productId: PRODUCT })).status,
					).toBe(403);
					expect((await x.as(x.merchant, 'DELETE', `/v1/merchants/${M1}/websites/${W1}/products/${PRODUCT}`)).status).toBe(
						403,
					);
					expect((await x.as(x.merchant, 'GET', `/v1/merchants/${M1}/websites/${W1}/products`)).status).toBe(200);
					expect((await x.as(x.other, 'GET', `/v1/merchants/${M1}/websites/${W1}/products`)).status).toBe(403);
				},
			},
			anonymous: (x) => x.h.call('GET', `/v1/merchants/${M1}/websites/${W1}/products`),
		},
		{
			name: 'Switch features on and off (product-enforced; the Portal accepts reports of Owner and Support only)',
			columns: {
				owner: async (x) => expect((await x.report(OWNER_ADMIN)).status).toBe(200),
				support: async (x) => expect((await x.report(SUPPORT_ADMIN)).status).toBe(200),
				finance: async (x) => expect((await x.report(FINANCE_ADMIN)).status).toBe(403),
				merchant: async (x) => {
					expect((await x.report(M1)).status).toBe(422); // a merchant is never an admin
					expect(
						(
							await x.as(x.merchant, 'PUT', `/v1/product/websites/${W1}/features`, {
								version: 99,
								on: [],
								adminId: M1,
								adminName: 'm',
							})
						).status,
					).toBe(401); // a session never reaches product routes
				},
			},
			anonymous: (x) =>
				x.h.call('PUT', `/v1/product/websites/${W1}/features`, {
					body: { version: 100, on: [], adminId: OWNER_ADMIN, adminName: 'x' },
				}),
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
// catalog (dashboards and Products) with the real modules and a fake product

describe('rights: product dashboards, Products, settings, defaults and prices', () => {
	/** @type {Awaited<ReturnType<typeof bootPortal>> | null} */
	let portal = null;
	afterAll(async () => {
		await portal?.close();
	});
	section(async () => {
		const t = await bootPortal({ db: mongo.db('rights_catalog') });
		portal = t;
		const owner = await t.owner();
		const product = await t.connect(notesManifest());
		const m = await t.merchant('m@shop.test', ['shop.example.com']);
		const other = await t.merchant('o@shop.test', ['other.example.com']);
		const websiteId = String(m.websiteIds[0]);
		await owner.post(`/v1/merchants/${m.merchantId}/websites/${websiteId}/products`, { productId: 'notes' });
		await owner.post(`/v1/merchants/${other.merchantId}/websites/${other.websiteIds[0]}/products`, { productId: 'notes' });
		const support = (await t.admin('support')).client;
		const finance = (await t.admin('finance')).client;
		/** @param {any} client @param {unknown} body */
		const open = (client, body) => client.post('/v1/admin/products/notes/launch', body);
		const merchantOpen = (/** @type {any} */ client, /** @type {{ merchantId: string, websiteIds: string[] }} */ who) =>
			client.post(`/v1/merchants/${who.merchantId}/websites/${who.websiteIds[0]}/products/notes/launch`, {});
		/** The role a launch carries (what the product checks). @param {{ json: any }} res */
		const roleOf = async (res) => {
			const claims = await t.verify(res.json.url, 'notes');
			return claims.kind === 'admin' ? claims.admin?.role : claims.kind;
		};
		return { t, product, m, other, websiteId, owner, support, finance, merchant: m.client, open, merchantOpen, roleOf };
	}, [
		{
			name: 'Open a product dashboard for a website (Finance: refused; merchant: own websites)',
			columns: {
				owner: async (x) => expect((await x.open(x.owner, { websiteId: x.websiteId })).status).toBe(200),
				support: async (x) => expect((await x.open(x.support, { websiteId: x.websiteId })).status).toBe(200),
				finance: async (x) => expect((await x.open(x.finance, { websiteId: x.websiteId })).status).toBe(403),
				merchant: async (x) => {
					expect((await x.merchantOpen(x.merchant, x.m)).status).toBe(200);
					expect((await x.merchantOpen(x.merchant, x.other)).status).toBe(403);
				},
			},
			anonymous: (x) => x.t.api.call('POST', '/v1/admin/products/notes/launch', { body: { websiteId: x.websiteId } }),
		},
		{
			name: 'Products: connect, reconnect, set active/inactive, Open as admin with no website',
			columns: {
				owner: async (x) => {
					expect((await x.owner.post('/v1/admin/products/notes/status', { status: 'active' })).status).toBe(200);
					expect((await x.open(x.owner, {})).status).toBe(200);
					expect(allowed(await x.owner.post('/v1/admin/products/notes/reconnect', { secret: 'short' }))).toBe(true);
				},
				support: async (x) => {
					expect((await x.support.post('/v1/admin/products/notes/status', { status: 'active' })).status).toBe(403);
					expect((await x.open(x.support, {})).status).toBe(403);
					expect((await x.support.post('/v1/admin/products', { url: 'https://x.test', secret: 'x' })).status).toBe(403);
				},
				finance: async (x) => {
					expect((await x.finance.post('/v1/admin/products', { url: 'https://x.test', secret: 'x' })).status).toBe(403);
					expect((await x.finance.get('/v1/admin/products')).status).toBe(403);
				},
				merchant: async (x) =>
					expect((await x.merchant.post('/v1/admin/products/notes/status', { status: 'inactive' })).status).toBe(401),
			},
			anonymous: (x) => x.t.api.call('POST', '/v1/admin/products/notes/status', { body: { status: 'active' } }),
		},
		{
			name: 'Edit settings, widget texts, theme and connections (product-enforced; launches carry who it is)',
			columns: {
				owner: async (x) => expect(await x.roleOf(await x.open(x.owner, { websiteId: x.websiteId }))).toBe('owner'),
				support: async (x) => expect(await x.roleOf(await x.open(x.support, { websiteId: x.websiteId }))).toBe('support'),
				finance: async (x) => expect((await x.open(x.finance, { websiteId: x.websiteId })).status).toBe(403),
				merchant: async (x) => expect(await x.roleOf(await x.merchantOpen(x.merchant, x.m))).toBe('merchant'),
			},
			anonymous: (x) =>
				x.t.api.call('POST', `/v1/merchants/${x.m.merchantId}/websites/${x.websiteId}/products/notes/launch`, {}),
		},
		{
			name: 'Edit global defaults and prices (product-enforced; Defaults open only for Owners, with no website)',
			columns: {
				owner: async (x) => expect(await x.roleOf(await x.open(x.owner, {}))).toBe('owner'),
				support: async (x) => expect((await x.open(x.support, {})).status).toBe(403),
				finance: async (x) => expect((await x.open(x.finance, {})).status).toBe(403),
				merchant: async (x) => expect((await x.merchant.post('/v1/admin/products/notes/launch', {})).status).toBe(401),
			},
			anonymous: (x) => x.t.api.call('POST', '/v1/admin/products/notes/launch', { body: {} }),
		},
	]);

	it('names the rows each product enforces on its own server', () => {
		expect(PRODUCT_ENFORCED_ROWS).toEqual([
			'Switch features on and off',
			'Edit settings, widget texts, theme and connections',
			'Edit global defaults and prices',
		]);
	});
});
