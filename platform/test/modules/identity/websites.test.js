import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { boot, setupMongo, teardownMongo } from './boot.js';

vi.setConfig({ testTimeout: 60_000 });
beforeAll(setupMongo, 120_000);
afterAll(teardownMongo, 60_000);

/** @param {{ json: any }} res */
const codeOf = (res) =>
	String(res.json?.type ?? '')
		.split('/')
		.pop();

describe('websites (PLAN 0.2 Websites, 0.5.9)', () => {
	it('Owner and Support add exact, normalised domains; merchants and Finance only view', async () => {
		const h = await boot();
		const m = await h.merchant('o@example.com');
		const support = await h.admin('support');
		const finance = await h.admin('finance');
		const path = `/v1/merchants/${m.merchantId}/websites`;
		expect((await m.client.post(path, { domain: 'shop.example.com' })).status).toBe(403);
		expect((await finance.client.post(path, { domain: 'shop.example.com' })).status).toBe(403);
		const created = await support.client.post(path, { domain: 'HTTPS://user@Shop.Example.COM:443/path?q#f' });
		expect(created.status).toBe(201);
		const { website, twin } = created.json;
		expect(website).toMatchObject({ domain: 'shop.example.com', env: 'live', twinId: twin.websiteId, status: 'active' });
		expect(twin).toMatchObject({ domain: 'shop.example.com', env: 'test', twinId: website.websiteId });
		// shop.com and www.shop.com are two websites
		expect((await support.client.post(path, { domain: 'www.shop.example.com' })).status).toBe(201);
		expect((await support.client.post(path, { domain: 'Bücher.example' })).json.website.domain).toBe('xn--bcher-kva.example');
		for (const domain of ['127.0.0.1', 'localhost', 'intranet', '*.example.com', '[::1]', '', 42]) {
			const res = await support.client.post(path, { domain });
			expect(res.status, String(domain)).toBe(422);
		}
		expect((await support.client.post(path, { domain: 'a.example', extra: 1 })).status).toBe(422);

		expect((await m.client.get(path)).json.items).toHaveLength(6);
		expect((await finance.client.get(path)).json.items).toHaveLength(6);
		expect((await m.client.get(`${path}/${twin.websiteId}`)).json.env).toBe('test');
		expect(await h.service.websiteByDomain('SHOP.example.com.')).toMatchObject({ websiteId: website.websiteId });
		expect(await h.service.websiteByDomain('not a domain')).toBeNull();
		await expect(h.service.getWebsite('web_00000000000000000000000000')).rejects.toMatchObject({ code: 'not_found' });
		expect(await h.activity('website.added')).toHaveLength(3);
	});

	it('a domain belongs to at most one website platform-wide, also under concurrent claims', async () => {
		const h = await boot();
		const merchants = [];
		for (let i = 0; i < 4; i += 1) merchants.push(await h.merchant(`o${i}@example.com`));
		const o = await h.owner();
		const actor = { type: /** @type {const} */ ('admin'), id: o.adminId, role: /** @type {const} */ ('owner') };
		const results = await Promise.allSettled(
			merchants.map((m) => h.service.createWebsite({ merchantId: m.merchantId, domain: 'race.example.com', actor })),
		);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		const rejected = /** @type {PromiseRejectedResult[]} */ (results.filter((r) => r.status === 'rejected'));
		expect(rejected.map((r) => r.reason.code)).toEqual(Array(3).fill('domain_taken'));
		const loser = merchants.find((_, i) => results[i]?.status === 'rejected');
		const conflict = await o.client.post(`/v1/merchants/${loser?.merchantId}/websites`, { domain: 'Race.Example.com' });
		expect([conflict.status, codeOf(conflict)]).toEqual([409, 'domain_taken']);
	});

	it('refuses public suffixes when a predicate is configured', async () => {
		const h = await boot({ identity: { isPublicSuffix: (/** @type {string} */ d) => d === 'co.uk' } });
		const m = await h.merchant('o@example.com');
		expect((await m.admin.post(`/v1/merchants/${m.merchantId}/websites`, { domain: 'co.uk' })).status).toBe(422);
		expect((await m.admin.post(`/v1/merchants/${m.merchantId}/websites`, { domain: 'shop.co.uk' })).status).toBe(201);
	});

	it('removes a website only after its products are removed; tokens stop for good and the domain is free at once', async () => {
		const h = await boot();
		const a = await h.merchantWithWebsite('a@example.com', 'cool.example.com');
		const b = await h.merchant('b@example.com');
		const key = await a.client.post(`/v1/merchants/${a.merchantId}/websites/${a.twinId}/keys`, {
			kind: 'sk',
			scopes: ['events.write'],
		});
		expect(key.status).toBe(201);
		const site = `/v1/merchants/${a.merchantId}/websites/${a.websiteId}`;
		// a product on the website blocks the removal
		h.commerce.subscriptions.push({ appId: 'app_x', websiteId: a.websiteId, status: 'active' });
		const blocked = await a.admin.del(site, { confirm: 'cool.example.com' });
		expect([blocked.status, codeOf(blocked)]).toEqual([409, 'products_on_website']);
		h.commerce.subscriptions[0] = { appId: 'app_x', websiteId: a.websiteId, status: 'cancelled' };
		// typed confirmation with the domain; merchants cannot remove
		expect((await a.client.del(site, { confirm: 'cool.example.com' })).status).toBe(403);
		expect((await a.admin.del(site, { confirm: 'cool.example.org' })).status).toBe(422);
		const removed = await a.admin.del(site, { confirm: 'cool.example.com' });
		expect(removed.json.websiteIds.sort()).toEqual([a.websiteId, a.twinId].sort());
		expect((await a.client.get(`/v1/merchants/${a.merchantId}/websites`)).json.items).toEqual([]);
		expect(await h.service.websiteByDomain('cool.example.com')).toBeNull();
		// the tokens are revoked for good
		const whoami = await h.call('GET', '/v1/test/whoami', { headers: { authorization: `Bearer ${key.json.key}` } });
		expect(whoami.status).toBe(401);
		// the domain is free again at once, for any merchant; nothing is restored
		const again = await b.admin.post(`/v1/merchants/${b.merchantId}/websites`, { domain: 'cool.example.com' });
		expect(again.status).toBe(201);
		expect(again.json.website.websiteId).not.toBe(a.websiteId);
		const entry = (await h.activity('website.removed'))[0];
		expect(entry).toMatchObject({ merchantId: a.merchantId, before: { domain: 'cool.example.com' } });
		expect((await a.admin.del(site, { confirm: 'cool.example.com' })).status).toBe(404);
	});

	it('website settings: time zone, language, currency for the pair until the switch (F.16)', async () => {
		const h = await boot();
		const m = await h.merchantWithWebsite('settings@example.com');
		const path = `/v1/merchants/${m.merchantId}/websites/${m.websiteId}`;
		const bad = await m.client.send('PATCH', path, { timeZone: 'Mars/Base', language: '??', currency: 'EURO' });
		expect(bad.json.errors.map((/** @type {any} */ e) => e.path).sort()).toEqual(['/currency', '/language', '/timeZone']);
		const saved = await m.client.send('PATCH', path, { timeZone: 'europe/berlin', language: 'de-de', currency: 'eur' });
		expect(saved.json).toMatchObject({ timeZone: 'Europe/Berlin', language: 'de-DE', currency: 'EUR' });
		expect(await h.service.getWebsite(m.twinId)).toMatchObject({ timeZone: 'Europe/Berlin', currency: 'EUR' });
		expect(h.commerce.invalidated).toEqual(expect.arrayContaining([m.websiteId, m.twinId]));
		const finance = await h.admin('finance');
		expect((await finance.client.send('PATCH', path, { currency: null })).status).toBe(403);
		expect((await m.admin.send('PATCH', path, { currency: null })).json).toMatchObject({ currency: null });
	});
});
