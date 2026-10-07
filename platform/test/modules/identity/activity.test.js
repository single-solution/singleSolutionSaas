import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { boot, setupMongo, teardownMongo } from './boot.js';

vi.setConfig({ testTimeout: 60_000 });
beforeAll(setupMongo, 120_000);
afterAll(teardownMongo, 60_000);

const DAY = 86_400_000;

describe('Activity (PLAN 0.5.12, 0.8.2)', () => {
	it('lists every people-and-access event, newest first, filterable by merchant, admin and UTC day', async () => {
		const h = await boot();
		const o = await h.owner();
		const a = await h.merchant('a@shop.test');
		h.clock.advance(DAY);
		const support = await h.admin('support');
		const b = await h.merchant('b@shop.test');
		await support.client.post(`/v1/admin/merchants/${b.merchantId}/suspend`, { reason: 'check' });
		/** @param {string} q */
		const actions = async (q) =>
			(await o.client.get(`/v1/admin/activity${q}`)).json.items.map((/** @type {any} */ e) => e.action);

		expect(await actions(`?merchantId=${b.merchantId}`)).toEqual(
			expect.arrayContaining(['merchant.suspended', 'merchant.created', 'merchant.setup_link_sent']),
		);
		expect(await actions(`?merchantId=${b.merchantId}`)).not.toContain('admin.invited');
		expect(await actions(`?adminId=${support.adminId}`)).toEqual(
			expect.arrayContaining(['merchant.suspended', 'login.signed_in']),
		);
		expect(await actions(`?adminId=${support.adminId}`)).not.toContain('merchant.created');
		const day1 = new Date(h.clock.now() - DAY).toISOString().slice(0, 10);
		const day2 = new Date(h.clock.now()).toISOString().slice(0, 10);
		const first = await actions(`?from=${day1}&to=${day1}`);
		expect(first).toContain('admin.created');
		expect(first).not.toContain('merchant.suspended');
		expect(await actions(`?from=${day2}`)).toContain('merchant.suspended');
		expect((await o.client.get('/v1/admin/activity?merchantId=bad')).status).toBe(422);
		expect((await o.client.get('/v1/admin/activity?from=2026-13-01')).status).toBe(422);

		// entries name the admin and the merchant; the reason is there for admins
		const page = (await o.client.get(`/v1/admin/activity?merchantId=${b.merchantId}`)).json;
		const suspended = page.items.find((/** @type {any} */ e) => e.action === 'merchant.suspended');
		expect(suspended).toMatchObject({
			actor: { type: 'admin', id: support.adminId, name: 'support admin' },
			merchantName: 'Shop',
			merchantDeleted: false,
			reason: 'check',
		});
		// paged
		const one = await o.client.get('/v1/admin/activity?limit=1');
		expect(one.json.items).toHaveLength(1);
		expect((await o.client.get(`/v1/admin/activity?limit=1&cursor=${one.json.nextCursor}`)).json.items).toHaveLength(1);

		// a merchant sees its own entries only, admins under the Branding name
		const own = (await (await h.signIn('a@shop.test')).get(`/v1/merchants/${a.merchantId}/activity`)).json.items;
		expect(own.length).toBeGreaterThan(0);
		expect(own.every((/** @type {any} */ e) => e.merchantId === a.merchantId)).toBe(true);
		expect(own.find((/** @type {any} */ e) => e.actor.type === 'admin')?.actor).toEqual({
			type: 'admin',
			id: null,
			name: 'Single Solution',
		});
		// My account: the admin's own activity
		const mine = (await support.client.get('/v1/me/activity')).json.items;
		expect(mine.every((/** @type {any} */ e) => e.actor.id === support.adminId)).toBe(true);
		expect((await a.client.get('/v1/me/activity')).status).toBe(401);
		// admins read any merchant's activity through the merchant path too
		expect((await support.client.get(`/v1/merchants/${a.merchantId}/activity`)).status).toBe(200);
	});
});
