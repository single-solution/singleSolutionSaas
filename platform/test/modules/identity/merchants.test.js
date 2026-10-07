import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { C } from '../../../src/modules/identity/schema.js';
import { boot, PASSWORD, setupMongo, teardownMongo } from './boot.js';

vi.setConfig({ testTimeout: 60_000 });
beforeAll(setupMongo, 120_000);
afterAll(teardownMongo, 60_000);

/** @param {{ json: any }} res */
const codeOf = (res) =>
	String(res.json?.type ?? '')
		.split('/')
		.pop();

describe('merchants (PLAN 0.2 Merchants, 0.5.9)', () => {
	it('admins create merchants with the fields of PLAN 0.2; the login e-mail is unique across the Portal', async () => {
		const h = await boot();
		const o = await h.owner();
		const created = await o.client.post('/v1/admin/merchants', {
			name: 'Shop & Co',
			ownerName: 'Sam Seller',
			email: 'Sam@Shop.test',
			phone: '+92 300 1234567',
			address: 'Main Road 1, Lahore',
			country: 'pk',
		});
		expect(created.status).toBe(201);
		expect(created.json.merchant).toMatchObject({
			name: 'Shop & Co',
			ownerName: 'Sam Seller',
			email: 'sam@shop.test',
			phone: '+92 300 1234567',
			address: 'Main Road 1, Lahore',
			country: 'PK',
			status: 'active',
			setupPending: true,
			twoStep: { enabled: false, recoveryCodesLeft: 0 },
		});
		expect(created.json.setup).toMatchObject({ mailed: true, link: null, expiresAt: expect.any(String) });
		expect(h.mailer.sent.at(-1)).toMatchObject({
			to: 'sam@shop.test',
			template: 'merchant_setup',
			data: { merchantName: 'Shop & Co' },
		});
		// optional fields may be left out; required ones may not; lengths and the country are checked
		expect(
			(await o.client.post('/v1/admin/merchants', { name: 'B', ownerName: 'B', email: 'b@shop.test' })).json.merchant,
		).toMatchObject({ phone: null, address: null, country: null });
		const bad = await o.client.post('/v1/admin/merchants', { name: '', email: 'nope', country: 'XX', phone: 'x'.repeat(41) });
		expect(bad.json.errors.map((/** @type {any} */ e) => e.path).sort()).toEqual([
			'/country',
			'/email',
			'/name',
			'/ownerName',
			'/phone',
		]);
		expect(codeOf(await o.client.post('/v1/admin/merchants', { name: 'C', ownerName: 'C', email: 'sam@shop.test' }))).toBe(
			'email_taken',
		);
		expect(codeOf(await o.client.post('/v1/admin/merchants', { name: 'C', ownerName: 'C', email: 'owner@portal.test' }))).toBe(
			'email_taken',
		);
		const entry = (await h.activity('merchant.created'))[0];
		expect(JSON.stringify(entry)).not.toMatch(/sam@shop\.test|Sam Seller|Lahore|1234567/);
	});

	it('without e-mail sending the setup link is skipped and can be copied (shown once, logged)', async () => {
		const h = await boot({ mail: false });
		const o = await h.owner();
		const created = await o.client.post('/v1/admin/merchants', { name: 'Shop', ownerName: 'Sam', email: 'sam@shop.test' });
		expect(created.json.setup).toMatchObject({ mailed: false, link: null });
		const copied = await o.client.post(`/v1/admin/merchants/${created.json.merchant.merchantId}/setup-link`, { copy: true });
		expect(copied.json.link).toMatch(/^https:\/\/portal\.test\/set-password#token=/);
		expect(await h.activity('merchant.setup_link_copied')).toHaveLength(1);
		const token = decodeURIComponent(copied.json.link.split('#token=')[1]);
		expect((await h.client().post('/v1/auth/set-password', { token, password: PASSWORD })).json.console).toBe('merchant');
	});

	it('Details: admins edit the fields, the login e-mail only until the password is set', async () => {
		const h = await boot();
		const o = await h.owner();
		const created = await o.client.post('/v1/admin/merchants', { name: 'Shop', ownerName: 'Sam', email: 'sam@shop.test' });
		const id = created.json.merchant.merchantId;
		const fixed = await o.client.patch(`/v1/admin/merchants/${id}`, { email: 'samuel@shop.test', name: 'Shop Ltd' });
		expect(fixed.json).toMatchObject({ email: 'samuel@shop.test', name: 'Shop Ltd' });
		expect(await h.db.collection(C.logins).findOne({ _id: /** @type {any} */ ('sam@shop.test') })).toBeNull();
		const token = h.mailer.token('sam@shop.test', 'merchant_setup');
		// correcting the e-mail cancelled the first link
		expect((await h.client().post('/v1/auth/set-password', { token, password: PASSWORD })).status).toBe(400);
		await o.client.post(`/v1/admin/merchants/${id}/setup-link`, {});
		await h
			.client()
			.post('/v1/auth/set-password', { token: h.mailer.token('samuel@shop.test', 'merchant_setup'), password: PASSWORD });
		expect((await o.client.patch(`/v1/admin/merchants/${id}`, { email: 'other@shop.test' })).status).toBe(409);
		expect(
			(await o.client.patch(`/v1/admin/merchants/${id}`, { phone: '+44 20 1234 5678', address: null })).json,
		).toMatchObject({
			phone: '+44 20 1234 5678',
			address: null,
		});
		expect((await o.client.patch(`/v1/admin/merchants/${id}`, {})).status).toBe(422);
		const finance = await h.admin('finance');
		expect((await finance.client.get(`/v1/admin/merchants/${id}`)).json.name).toBe('Shop Ltd');
		expect((await finance.client.patch(`/v1/admin/merchants/${id}`, { name: 'X' })).status).toBe(403);
	});

	it('lists merchants: search by name, owner e-mail or a website domain; filter by status; paged', async () => {
		const h = await boot();
		const a = await h.merchantWithWebsite('alpha@one.test', 'shop.alpha.test');
		const o = (await h.owner()).client;
		await o.patch(`/v1/admin/merchants/${a.merchantId}`, { name: 'Ålpha Traders' });
		const b = await h.merchant('beta@two.test');
		await o.patch(`/v1/admin/merchants/${b.merchantId}`, { name: 'Beta Goods' });
		await o.post(`/v1/admin/merchants/${b.merchantId}/suspend`, { reason: 'chargeback' });
		/** @param {string} q */
		const names = async (q) => (await o.get(`/v1/admin/merchants${q}`)).json.items.map((/** @type {any} */ m) => m.name);
		expect(await names('?q=alpha')).toEqual(['Ålpha Traders']);
		expect(await names('?q=beta%40')).toEqual(['Beta Goods']);
		expect(await names('?q=shop.alpha')).toEqual(['Ålpha Traders']);
		expect(await names('?status=suspended')).toEqual(['Beta Goods']);
		expect((await o.get('/v1/admin/merchants?status=deleted')).status).toBe(422);
		const page = await o.get('/v1/admin/merchants?limit=1');
		expect(page.json.items).toHaveLength(1);
		expect((await o.get(`/v1/admin/merchants?limit=1&cursor=${page.json.nextCursor}`)).json.items).toHaveLength(1);
	});

	it('bulk actions: Suspend / Resume with one reason, Resend setup link for merchants without a password', async () => {
		const h = await boot();
		const o = (await h.owner()).client;
		const a = await h.merchant('a@shop.test');
		const pending = (await o.post('/v1/admin/merchants', { name: 'P', ownerName: 'P', email: 'p@shop.test' })).json.merchant
			.merchantId;
		expect((await o.post('/v1/admin/merchants/bulk', { action: 'suspend', merchantIds: [a.merchantId] })).status).toBe(422);
		const suspended = await o.post('/v1/admin/merchants/bulk', {
			action: 'suspend',
			merchantIds: [a.merchantId, pending],
			reason: 'audit',
		});
		expect(suspended.json.results).toEqual([
			{ merchantId: a.merchantId, ok: true },
			{ merchantId: pending, ok: true },
		]);
		await o.post('/v1/admin/merchants/bulk', { action: 'resume', merchantIds: [a.merchantId, pending] });
		const resent = await o.post('/v1/admin/merchants/bulk', {
			action: 'resend_setup_link',
			merchantIds: [a.merchantId, pending],
		});
		expect(resent.json.results).toEqual([
			{ merchantId: a.merchantId, ok: false, detail: expect.stringContaining('password is already set') },
			{ merchantId: pending, ok: true },
		]);
		const finance = await h.admin('finance');
		expect((await finance.client.post('/v1/admin/merchants/bulk', { action: 'resume', merchantIds: [pending] })).status).toBe(
			403,
		);
	});

	it('suspension reason is internal: admins see it, the merchant does not; Activity has it', async () => {
		const h = await boot();
		const m = await h.merchant('sam@shop.test');
		await m.admin.post(`/v1/admin/merchants/${m.merchantId}/suspend`, { reason: 'fraud check' });
		expect((await m.admin.get(`/v1/admin/merchants/${m.merchantId}`)).json.suspension.reason).toBe('fraud check');
		expect((await h.activity('merchant.suspended'))[0]?.reason).toBe('fraud check');
		expect((await m.admin.post(`/v1/admin/merchants/${m.merchantId}/suspend`, {})).status).toBe(422);
		await m.admin.post(`/v1/admin/merchants/${m.merchantId}/resume`, {});
		const own = await (await h.signIn('sam@shop.test')).get(`/v1/merchants/${m.merchantId}`);
		expect(own.json).not.toHaveProperty('suspension');
		const activity = await (await h.signIn('sam@shop.test')).get(`/v1/merchants/${m.merchantId}/activity`);
		const suspendedEntry = activity.json.items.find((/** @type {any} */ e) => e.action === 'merchant.suspended');
		expect(suspendedEntry).not.toHaveProperty('reason');
		expect(suspendedEntry.actor).toEqual({ type: 'admin', id: null, name: 'Single Solution' });
	});

	it('delete (Owner, typed name, no websites): login and personal details erased, e-mail free, records kept', async () => {
		const h = await boot();
		const m = await h.merchantWithWebsite('sam@shop.test');
		const support = await h.admin('support');
		expect((await support.client.del(`/v1/admin/merchants/${m.merchantId}`, { confirm: 'Shop' })).status).toBe(403);
		expect((await m.admin.del(`/v1/admin/merchants/${m.merchantId}`, { confirm: 'Shop' })).status).toBe(409);
		await m.admin.del(`/v1/merchants/${m.merchantId}/websites/${m.websiteId}`, { confirm: m.domain });
		expect((await m.admin.del(`/v1/admin/merchants/${m.merchantId}`, { confirm: 'shop' })).status).toBe(422);
		expect((await m.admin.del(`/v1/admin/merchants/${m.merchantId}`, { confirm: 'Shop' })).status).toBe(204);
		expect((await m.client.get('/v1/me')).status).toBe(401);
		const stored = await h.db.collection(C.merchants).findOne({ _id: /** @type {any} */ (m.merchantId) });
		expect(stored).toMatchObject({ name: 'Shop', status: 'deleted', ownerName: null, email: null, passwordHash: null });
		expect(await h.db.collection(C.logins).findOne({ _id: /** @type {any} */ ('sam@shop.test') })).toBeNull();
		expect((await m.admin.get(`/v1/admin/merchants/${m.merchantId}`)).status).toBe(404);
		expect((await m.admin.get('/v1/admin/merchants')).json.items).toEqual([]);
		// Activity keeps the entries under the business name, marked Deleted, without personal details
		const activity = await m.admin.get(`/v1/admin/activity?merchantId=${m.merchantId}`);
		expect(activity.json.items.length).toBeGreaterThan(2);
		expect(activity.json.items.find((/** @type {any} */ e) => e.action === 'merchant.deleted')).toMatchObject({
			merchantName: 'Shop',
			merchantDeleted: true,
		});
		const byMerchant = activity.json.items.find((/** @type {any} */ e) => e.actor.type === 'merchant');
		expect(byMerchant.actor.name).toBe('Deleted merchant');
		expect(JSON.stringify(activity.json)).not.toContain('sam@shop.test');
		// the e-mail is free for a new login
		expect((await m.admin.post('/v1/admin/merchants', { name: 'New', ownerName: 'N', email: 'sam@shop.test' })).status).toBe(
			201,
		);
	});
});
