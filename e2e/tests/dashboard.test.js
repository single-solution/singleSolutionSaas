/**
 * PLAN 0.4.3: opening the product dashboard from the Portal (merchant and admin launches, single use, Finance refused,
 * Open as admin with no website for Owners) and `sessions.revoked` ending dashboard sessions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, PRODUCT_URL, startSystem } from './helpers.js';

/** @type {import('./helpers.js').System} */
let sys;
/** @type {Awaited<ReturnType<import('./helpers.js').System['merchant']>>} */
let m;
let w1 = '';
let w2 = '';
let w3 = '';
beforeAll(async () => {
	sys = await startSystem();
	await sys.connect();
	m = await sys.merchant('dash@shop.test', ['one.example.com', 'two.example.com', 'three.example.com']);
	[w1 = '', w2 = '', w3 = ''] = m.websiteIds;
	await sys.addProduct(m.merchantId, w1);
	await sys.addProduct(m.merchantId, w2);
});
afterAll(async () => {
	await sys?.stop();
});

/** The dashboard session as the product shows it. @param {string} cookie */
const session = (cookie) => sys.dashboard(cookie, 'GET', '/v1/dashboard/session');

describe('opening the product dashboard', () => {
	it('a merchant launch opens the dashboard for its website, with only its websites that have the product', async () => {
		const launch = await m.client.post(`/v1/merchants/${m.merchantId}/websites/${w2}/products/notes/launch`);
		expect(launch.status).toBe(200);
		expect(launch.json.url).toMatch(new RegExp(`^${PRODUCT_URL}/sso\\?launch=`));
		expect(Date.parse(launch.json.expiresAt) - sys.clock.now()).toBeLessThanOrEqual(60_000);
		const opened = await sys.open(launch.json.url);
		expect(opened.status).toBe(303);
		expect(opened.location).toBe(`/dashboard?websiteId=${w2}`);
		const res = await session(opened.cookie);
		expect(res.json).toMatchObject({
			who: { kind: 'merchant', id: m.merchantId, name: `Shop ${m.email}` },
			portalUrl: 'https://portal.test',
			switcher: [{ merchantId: m.merchantId }],
		});
		const listed = res.json.switcher[0].websites.map((/** @type {{ websiteId: string }} */ site) => site.websiteId);
		expect(listed.sort()).toEqual([w1, w2].sort());
		// the server checks every request against that list
		const other = await sys.dashboard(opened.cookie, 'GET', `/v1/dashboard/websites/${w3}/overview`);
		expect(other.status).toBe(403);
		expect((await sys.dashboard(opened.cookie, 'GET', `/v1/dashboard/websites/${w1}/overview`)).status).toBe(200);
		// a website without the product has no launch
		const none = await m.client.post(`/v1/merchants/${m.merchantId}/websites/${w3}/products/notes/launch`);
		expect(none.status).toBe(404);
		expect((await sys.activity('product.dashboard_opened')).length).toBeGreaterThan(0);
	});

	it('a launch is single use', async () => {
		const launch = await m.client.post(`/v1/merchants/${m.merchantId}/websites/${w1}/products/notes/launch`);
		expect((await sys.open(launch.json.url)).status).toBe(303);
		const again = await sys.open(launch.json.url);
		expect([again.status, again.cookie]).toEqual([401, '']);
		// and short-lived
		const late = await m.client.post(`/v1/merchants/${m.merchantId}/websites/${w1}/products/notes/launch`);
		sys.clock.advance(2 * 60_000);
		expect((await sys.open(late.json.url)).status).toBe(401);
	});

	it('Owner and Support open as admin for a website; Defaults (no website) is for Owners; Finance never', async () => {
		const owner = await sys.owner();
		const support = await sys.admin('support');
		const finance = await sys.admin('finance');
		const ownerLaunch = await owner.post('/v1/admin/products/notes/launch', { websiteId: w1 });
		const opened = await sys.open(ownerLaunch.json.url);
		expect(opened.location).toBe(`/dashboard?websiteId=${w1}`);
		expect((await session(opened.cookie)).json.who).toMatchObject({ kind: 'admin', name: 'Olivia Owner', role: 'owner' });

		const defaults = await owner.post('/v1/admin/products/notes/launch', { websiteId: null });
		expect(defaults.status).toBe(200);
		const openedDefaults = await sys.open(defaults.json.url);
		expect(openedDefaults.location).toBe('/dashboard?view=defaults');
		expect((await sys.dashboard(openedDefaults.cookie, 'GET', '/v1/dashboard/defaults')).status).toBe(200);

		const supportLaunch = await support.client.post('/v1/admin/products/notes/launch', { websiteId: w2 });
		const supportCookie = (await sys.open(supportLaunch.json.url)).cookie;
		expect((await session(supportCookie)).json.who).toMatchObject({ kind: 'admin', id: support.adminId, role: 'support' });
		expect((await sys.dashboard(supportCookie, 'GET', '/v1/dashboard/prices')).status).toBe(403);
		expect((await support.client.post('/v1/admin/products/notes/launch', { websiteId: null })).status).toBe(403);

		expect((await finance.client.post('/v1/admin/products/notes/launch', { websiteId: w1 })).status).toBe(403);
		expect((await finance.client.post('/v1/admin/products/notes/launch', { websiteId: null })).status).toBe(403);
	});

	it('sessions.revoked ends dashboard sessions: password change, sign-out, role change, merchant suspended', async () => {
		const owner = await sys.owner();
		// a password change ends that person's dashboard sessions
		const support = await sys.admin('support');
		const supportCookie = await sys.adminSession(support.client, w1);
		expect((await session(supportCookie)).status).toBe(200);
		const changed = await support.client.post('/v1/me/password', {
			currentPassword: 'correct horse battery staple',
			newPassword: 'another long passphrase',
		});
		expect(changed.status).toBe(204);
		expect((await session(supportCookie)).status).toBe(401);

		// signing out of the Portal ends them too
		const other = await sys.admin('support');
		const otherCookie = await sys.adminSession(other.client, w1);
		expect((await other.client.post('/v1/auth/sign-out')).status).toBe(204);
		expect((await session(otherCookie)).status).toBe(401);

		// so does a role change
		const third = await sys.admin('support');
		const thirdCookie = await sys.adminSession(third.client, w1);
		await owner.patch(`/v1/admin/admins/${third.adminId}`, { role: 'owner' });
		expect((await session(thirdCookie)).status).toBe(401);

		// and a merchant's suspension (the merchant cannot open it again; an admin still can)
		const merchantCookie = await sys.merchantSession(m, w1);
		const ownerCookie = await sys.adminSession(owner, w1);
		await owner.post(`/v1/admin/merchants/${m.merchantId}/suspend`, { reason: 'Checks' });
		expect((await session(merchantCookie)).status).toBe(401);
		expect((await session(ownerCookie)).status).toBe(200);
		const signIn = await sys.api.call('POST', '/v1/auth/sign-in', { body: { email: m.email, password: PASSWORD } });
		expect(signIn.json?.status).not.toBe('ok');
		const admin = await sys.adminSession(owner, w1);
		expect((await sys.dashboard(admin, 'GET', `/v1/dashboard/websites/${w1}/overview`)).json.status.status).toBe('suspended');
		expect(await sys.waitingNotices()).toEqual([]);
	});
});
