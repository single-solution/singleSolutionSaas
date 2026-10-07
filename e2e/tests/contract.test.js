/**
 * PLAN 0.4.12 rows 4–7 and notices: the websites list (the admin switcher), revocations, the directory and the status
 * response as the product receives them, and notices kept while the product cannot be reached and delivered right after
 * its next call to the Portal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRODUCT_URL, codeOf, startSystem } from './helpers.js';

/** @type {import('./helpers.js').System} */
let sys;
/** @type {Awaited<ReturnType<import('./helpers.js').System['merchant']>>} */
let a;
/** @type {Awaited<ReturnType<import('./helpers.js').System['merchant']>>} */
let b;
beforeAll(async () => {
	sys = await startSystem();
	await sys.connect();
	a = await sys.merchant('a@shop.test', ['a1.example.com', 'a2.example.com']);
	b = await sys.merchant('b@shop.test', ['b1.example.com']);
	for (const [who, websiteId] of /** @type {const} */ ([
		[a, a.websiteIds[0]],
		[a, a.websiteIds[1]],
		[b, b.websiteIds[0]],
	]))
		await sys.addProduct(who.merchantId, websiteId ?? '');
});
afterAll(async () => {
	await sys?.stop();
});

describe('the product side of the contract', () => {
	it('the websites list feeds the admin switcher: every website with the product, by merchant, removed excluded', async () => {
		const owner = await sys.owner();
		const [a1 = '', a2 = ''] = a.websiteIds;
		const [b1 = ''] = b.websiteIds;
		await owner.del(`/v1/merchants/${a.merchantId}/websites/${a2}/products/notes`);
		await owner.post(`/v1/admin/merchants/${b.merchantId}/suspend`, { reason: 'Checks' });

		const page = await sys.productApi('GET', '/v1/product/websites');
		expect(page.status).toBe(200);
		expect(page.json.cursor).toBeNull();
		expect(page.json.items).toHaveLength(2);
		expect(page.json.items).toEqual(
			expect.arrayContaining([
				{
					websiteId: a1,
					domain: 'a1.example.com',
					merchantId: a.merchantId,
					merchantName: 'Shop a@shop.test',
					status: 'active',
				},
				{
					websiteId: b1,
					domain: 'b1.example.com',
					merchantId: b.merchantId,
					merchantName: 'Shop b@shop.test',
					status: 'suspended',
				},
			]),
		);
		const cookie = await sys.adminSession(owner, a1);
		const { json } = await sys.dashboard(cookie, 'GET', '/v1/dashboard/session');
		expect(json.switcher).toHaveLength(2);
		expect(json.switcher).toEqual(
			expect.arrayContaining([
				{
					merchantId: a.merchantId,
					merchantName: 'Shop a@shop.test',
					websites: [{ websiteId: a1, domain: 'a1.example.com', status: 'active' }],
				},
				{
					merchantId: b.merchantId,
					merchantName: 'Shop b@shop.test',
					websites: [{ websiteId: b1, domain: 'b1.example.com', status: 'suspended' }],
				},
			]),
		);
		await owner.post(`/v1/admin/merchants/${b.merchantId}/resume`, {});
	});

	it('the status response answers removed products, and 404 for a website that never had the product', async () => {
		const [, a2 = ''] = a.websiteIds;
		const removed = await sys.productApi('GET', `/v1/product/websites/${a2}/status`);
		expect(removed.json).toMatchObject({ websiteId: a2, status: 'removed', graceEndsAt: null, todayMillicredits: 0 });
		const other = await sys.addWebsite(a.merchantId, 'a3.example.com');
		const never = await sys.productApi('GET', `/v1/product/websites/${other}/status`);
		expect([never.status, codeOf(never)]).toEqual([404, 'website_not_found']);
		// a call without the product's signature is refused
		const unsigned = await sys.api.call('GET', `/v1/product/websites/${a2}/status`);
		expect(unsigned.status).toBe(401);
	});

	it('revocations list regenerated token ids after a cursor', async () => {
		const owner = await sys.owner();
		const [a1 = ''] = a.websiteIds;
		const first = await sys.productApi('GET', '/v1/product/revocations');
		expect(first.json).toEqual({ tokenIds: [], cursor: expect.anything() });
		const base = `/v1/merchants/${a.merchantId}/websites/${a1}/tokens/notes/regenerate`;
		await owner.post(base, { kind: 'server' });
		await owner.post(base, { kind: 'browser' });
		// a cursor trails the clock by 30 seconds (late writes are never skipped; products merge ids as a set)
		sys.clock.advance(60_000);
		const next = await sys.productApi('GET', `/v1/product/revocations?since=${encodeURIComponent(first.json.cursor ?? '')}`);
		expect(next.json.tokenIds).toHaveLength(2);
		const after = await sys.productApi('GET', `/v1/product/revocations?since=${encodeURIComponent(next.json.cursor)}`);
		expect(after.json.tokenIds).toEqual([]);
	});

	it('the directory answers where a connected product lives', async () => {
		expect((await sys.productApi('GET', '/v1/product/directory/notes')).json).toEqual({ baseUrl: PRODUCT_URL });
		const missing = await sys.productApi('GET', '/v1/product/directory/chat');
		expect(missing.status).toBe(404);
	});
});

describe('notices', () => {
	it('a notice the product cannot take is kept and delivered right after its next call to the Portal', async () => {
		const owner = await sys.owner();
		const [a1 = ''] = a.websiteIds;
		const merchantCookie = await sys.merchantSession(a, a1);
		const cookie = await sys.adminSession(owner, a1);
		await sys.connectDatabase(cookie, a1);
		await sys.switchFeatures(cookie, a1, ['notes']);
		const { server } = await sys.tokens(a.merchantId, a1);
		expect((await sys.call('GET', '/v1/notes', { token: server })).status).toBe(200);

		sys.setReachable(false);
		await owner.post(`/v1/admin/merchants/${a.merchantId}/suspend`, { reason: 'Checks' });
		const waiting = await sys.waitingNotices();
		expect(waiting.map((n) => n.type).sort()).toEqual(['sessions.revoked', 'status.changed']);
		expect(sys.entries.some((e) => e.message === 'notice not delivered')).toBe(true);
		sys.setReachable(true);

		// the product has not heard yet: its cached status still says active
		expect((await sys.call('GET', '/v1/notes', { token: server })).status).toBe(200);
		expect((await sys.dashboard(merchantCookie, 'GET', '/v1/dashboard/session')).status).toBe(200);
		// its next call to the Portal (the switcher's websites list) brings them
		expect((await sys.dashboard(cookie, 'GET', '/v1/dashboard/session')).status).toBe(200);
		expect(await sys.waitingNotices()).toEqual([]);
		const refused = await sys.call('GET', '/v1/notes', { token: server });
		expect([refused.status, refused.json.reason]).toEqual([403, 'suspended']);
		expect((await sys.dashboard(merchantCookie, 'GET', '/v1/dashboard/session')).status).toBe(401);
	});
});
