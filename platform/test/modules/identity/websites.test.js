import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createKeyResolver, verifyToken } from '@ss/protocol';
import { PORTAL_URL, boot, setupMongo, teardownMongo } from './boot.js';

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
		const { website } = created.json;
		expect(website).toMatchObject({ domain: 'shop.example.com', status: 'active', merchantId: m.merchantId, removedAt: null });
		expect(Object.keys(created.json)).toEqual(['website']);
		// shop.com and www.shop.com are two websites
		expect((await support.client.post(path, { domain: 'www.shop.example.com' })).status).toBe(201);
		expect((await support.client.post(path, { domain: 'Bücher.example' })).json.website.domain).toBe('xn--bcher-kva.example');
		for (const domain of ['127.0.0.1', 'localhost', 'intranet', '*.example.com', '[::1]', '', 42]) {
			const res = await support.client.post(path, { domain });
			expect(res.status, String(domain)).toBe(422);
		}
		expect((await support.client.post(path, { domain: 'a.example', extra: 1 })).status).toBe(422);

		expect((await m.client.get(path)).json.items).toHaveLength(3);
		expect((await finance.client.get(path)).json.items).toHaveLength(3);
		expect((await m.client.get(`${path}/${website.websiteId}`)).json.domain).toBe('shop.example.com');
		await expect(h.service.getWebsite('web_00000000000000000000000000')).rejects.toMatchObject({ code: 'not_found' });
		expect((await h.service.websitesByIds([website.websiteId, 'web_00000000000000000000000000'])).size).toBe(1);
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

	it('removes a website only after its products are removed; its tokens are revoked, its products told, the domain freed', async () => {
		const h = await boot();
		const a = await h.merchantWithWebsite('a@example.com', 'cool.example.com');
		const b = await h.merchant('b@example.com');
		// the product the website had: its tokens exist
		await h.service.ensureTokens({ merchantId: a.merchantId, websiteId: a.websiteId, productId: 'notes' });
		expect(await h.service.ensureTokens({ merchantId: a.merchantId, websiteId: a.websiteId, productId: 'notes' })).toEqual({
			created: false,
		});
		const site = `/v1/merchants/${a.merchantId}/websites/${a.websiteId}`;
		// a product on the website blocks the removal
		h.commerce.products.push({ productId: 'notes', websiteId: a.websiteId, merchantId: a.merchantId });
		const blocked = await a.admin.del(site, { confirm: 'cool.example.com' });
		expect([blocked.status, codeOf(blocked)]).toEqual([409, 'products_on_website']);
		const install = await a.client.get(`${site}/tokens`);
		expect(install.json.items).toEqual([
			{
				productId: 'notes',
				name: 'Notes',
				widgetScriptUrl: 'https://notes.example.dev/widget.js',
				docsUrl: 'https://notes.example.dev/docs',
				browserToken: expect.any(String),
				serverToken: { canShow: true },
			},
		]);
		const browser = await verifyToken({
			token: install.json.items[0].browserToken,
			keyResolver: createKeyResolver({ jwks: h.portal.shared.keys.tokenJwks() }),
			issuer: PORTAL_URL,
			productId: 'notes',
			kind: 'browser',
		});
		h.commerce.products.splice(0);
		// typed confirmation with the domain; merchants cannot remove
		expect((await a.client.del(site, { confirm: 'cool.example.com' })).status).toBe(403);
		expect((await a.admin.del(site, { confirm: 'cool.example.org' })).status).toBe(422);
		h.catalog.setFailing(true); // a notice that cannot be queued never fails the removal
		const removed = await a.admin.del(site, { confirm: 'cool.example.com' });
		expect([removed.status, removed.json]).toEqual([200, { websiteId: a.websiteId }]);
		h.catalog.setFailing(false);
		expect(h.entries.some((e) => e.msg === 'notice not queued')).toBe(true);
		expect((await a.client.get(`/v1/merchants/${a.merchantId}/websites`)).json.items).toEqual([]);
		// both tokens are revoked for good
		const revocations = await h.call('GET', '/v1/product/revocations', {
			headers: { authorization: `Bearer ${await h.catalog.assertion(PORTAL_URL, h.clock.now)}` },
		});
		expect(revocations.json.tokenIds).toHaveLength(2);
		expect(revocations.json.tokenIds).toContain(browser.jti);
		// the domain is free again at once, for any merchant; nothing is restored
		const again = await b.admin.post(`/v1/merchants/${b.merchantId}/websites`, { domain: 'cool.example.com' });
		expect(again.status).toBe(201);
		expect(again.json.website.websiteId).not.toBe(a.websiteId);
		const entry = (await h.activity('website.removed'))[0];
		expect(entry).toMatchObject({ merchantId: a.merchantId, before: { domain: 'cool.example.com' } });
		expect((await a.admin.del(site, { confirm: 'cool.example.com' })).status).toBe(404);
		// with the catalog up, the products the website had are told
		const c = await h.merchantWithWebsite('c@example.com', 'told.example.com');
		await h.service.ensureTokens({ merchantId: c.merchantId, websiteId: c.websiteId, productId: 'notes' });
		await c.admin.del(`/v1/merchants/${c.merchantId}/websites/${c.websiteId}`, { confirm: 'told.example.com' });
		expect(h.catalog.notices).toContainEqual({ productId: 'notes', body: { type: 'website.deleted', websiteId: c.websiteId } });
	});
});
