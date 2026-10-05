import { afterEach, describe, expect, it } from 'vitest';
import { repositoriesFor } from '../adapters/db.js';
import { createPrivacyHandlers } from '../adapters/privacy.js';
import { demoDashboard, resolveDashboard } from '../api/dashboard.js';
import { respond, writerOf } from '../api/routes.js';
import { catalogFor } from '../api/service.js';
import { createHarness, item, MERCHANT, WEBSITE } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
afterEach(async () => {
	await h?.close();
});

describe('widget state (POST /v1/wishlist)', () => {
	it('gives a new visitor a guest token, renews it late in life and merges it on sign-in', async () => {
		h = await createHarness({
			config: { guest_merge: { guest_ttl_days: 10, storage: 'session', consent_category: 'functional' } },
		});
		const fresh = await h.call('POST', '/v1/wishlist', { body: {}, idempotencyKey: null });
		expect(fresh.status, fresh.text).toBe(200);
		expect(fresh.json).toMatchObject({
			owner: { kind: 'guest' },
			guest: { token: expect.stringMatching(/^wg1\./) },
			dropGuest: false,
			merged: 0,
			lists: [],
			settings: { guests: true, storage: 'session', consentCategory: 'functional', share: false, notify: false, maxLists: 5 },
		});
		const token = fresh.json.guest.token;
		await h.call('POST', '/v1/lists/default/items', { body: { ...item(), guest: token } });
		const again = await h.call('POST', '/v1/wishlist', { body: { guest: token } });
		expect(again.json).toMatchObject({ owner: { kind: 'guest' }, guest: null, lists: [{ itemCount: 1 }] });
		h.clock.advance(6 * 86_400_000);
		await h.entitle({ config: { guest_merge: { guest_ttl_days: 10, storage: 'session', consent_category: 'functional' } } });
		const renewed = await h.call('POST', '/v1/wishlist', { body: { guest: token } });
		expect(renewed.json.guest.token).not.toBe(token);
		const bad = await h.call('POST', '/v1/wishlist', { body: { guest: 'wg1.bad.token' } });
		expect(bad.json).toMatchObject({ owner: { kind: 'guest' }, dropGuest: true, lists: [] });
		const jane = await h.login('cus_jane');
		const signedIn = await h.call('POST', '/v1/wishlist', { identity: jane, body: { guest: renewed.json.guest.token } });
		expect(signedIn.json).toMatchObject({
			owner: { kind: 'customer' },
			guest: null,
			dropGuest: true,
			merged: 1,
			lists: [{ itemCount: 1, isDefault: true }],
			settings: { share: true, notify: true },
		});
		const forged = await h.call('POST', '/v1/wishlist', { identity: 'not.a.jwt', body: {} });
		expect(forged.status).toBe(401);
		const server = await h.call('POST', '/v1/wishlist', { key: h.sk, body: { customerId: 'cus_jane' } });
		expect(server.json).toMatchObject({ owner: { kind: 'customer' }, lists: [{ itemCount: 1 }] });
		expect((await h.call('POST', '/v1/wishlist', { key: h.sk, body: {} })).json).toMatchObject({ owner: null, guest: null });
	});

	it('without guest lists a visitor gets no token and the page asks to sign in', async () => {
		h = await createHarness({ elements: { guest_merge: false } });
		const state = await h.call('POST', '/v1/wishlist', { body: { guest: 'whatever' } });
		expect(state.json).toMatchObject({ owner: null, guest: null, lists: [], settings: { guests: false } });
		const jane = await h.login('cus_jane');
		expect((await h.call('POST', '/v1/wishlist', { identity: jane, body: { guest: 'old' } })).json).toMatchObject({
			owner: { kind: 'customer' },
			dropGuest: true,
			merged: 0,
		});
		await h.entitle({ elements: { widgets: false } });
		expect((await h.call('POST', '/v1/wishlist', { body: {} })).status).toBe(403);
	});

	it('names the default list in the website language (catalog fallback) and limits loads per IP', async () => {
		h = await createHarness({ website: { language: 'fr-CA' }, config: { widgets: { max_loads_per_minute: 1 } } });
		const jane = await h.login('cus_jane');
		const saved = await h.call('POST', '/v1/lists/default/items', { identity: jane, body: item() });
		expect(saved.json.list.name).toBe('Wishlist');
		expect(catalogFor({ en: { a: '1' }, fr: { a: '2' } }, 'fr-CA')).toEqual({ a: '2' });
		expect(catalogFor({}, 'de')).toEqual({});
		const headers = { 'x-forwarded-for': '198.51.100.1' };
		expect((await h.call('POST', '/v1/wishlist', { identity: jane, body: {}, headers })).status).toBe(200);
		expect((await h.call('POST', '/v1/wishlist', { identity: jane, body: {}, headers })).status).toBe(429);
	});
});

describe('dashboard', () => {
	it('shows counts, lists and signals for a merchant launch and sample data for a demo', async () => {
		h = await createHarness();
		const jane = await h.login('cus_jane');
		const saved = await h.call('POST', '/v1/lists/default/items', { identity: jane, body: item() });
		await h.call('PATCH', `/v1/lists/${saved.json.list.id}`, { identity: jane, body: { notify: true } });
		await h.call('POST', '/v1/shares', { identity: jane, body: { listId: saved.json.list.id } });
		const token = await h.guest();
		await h.call('POST', '/v1/lists/default/items', { body: { ...item(), guest: token } });
		await h.deliver('price.changed@1', { itemId: 'itm_1', price: { amount: 100, currency: 'EUR' } });

		/** @param {Record<string, unknown>} scope */
		const sessionFor = async (scope) => {
			const { token: launch } = await h.portal.issueLaunch(
				/** @type {any} */ ({ kind: 'merchant', subject: 'usr_1', user: { id: 'usr_1' }, scope }),
			);
			const exchanged = await h.wishlist.product.launch.exchange(launch);
			if (!exchanged.ok) throw new Error(exchanged.code);
			return exchanged.session.id;
		};
		const sessionId = await sessionFor({ merchantId: MERCHANT, websiteId: WEBSITE });
		const context = await resolveDashboard({ wishlist: h.wishlist, sessionId });
		expect(context.state).toBe('ready');
		if (context.state !== 'ready') return;
		const overview = await context.data.overview();
		expect(overview.stats).toEqual({ lists: 2, customerLists: 1, guestLists: 1, items: 2, optedIn: 1, shared: 1 });
		expect(overview.topItems).toEqual([{ itemId: 'itm_1', title: 'Linen shirt', saves: 2 }]);
		expect((await context.data.lists()).map((l) => l.owner.kind).sort()).toEqual(['customer', 'guest']);
		expect(await context.data.notifications()).toHaveLength(1);
		const viaApi = await h.call('GET', '/v1/dashboard/overview', { key: sessionId });
		expect(viaApi.json.stats.lists, viaApi.text).toBe(2);
		expect((await h.call('GET', '/v1/session', { key: sessionId })).json).toMatchObject({ kind: 'merchant' });
		const { token: demoLaunch } = await h.portal.issueLaunch(
			/** @type {any} */ ({ kind: 'demo', subject: 'usr_demo', user: { id: 'usr_demo' }, scope: {} }),
		);
		const demoSession = await h.wishlist.product.launch.exchange(demoLaunch);
		const demoContext = await resolveDashboard({
			wishlist: h.wishlist,
			sessionId: demoSession.ok ? demoSession.session.id : '',
		});
		expect(demoContext.state === 'ready' && demoContext.data.demo).toBe(true);

		expect(await resolveDashboard({ wishlist: h.wishlist, sessionId: null })).toEqual({ state: 'signin' });
		expect(await resolveDashboard({ wishlist: h.wishlist, sessionId: 'ses_missing' })).toEqual({ state: 'signin' });
		const other = await resolveDashboard({ wishlist: h.wishlist, sessionId, website: 'web_other' });
		expect(other.state).toBe('ready');
		const noSite = await sessionFor({ merchantId: MERCHANT });
		expect((await resolveDashboard({ wishlist: h.wishlist, sessionId: noSite })).state).toBe('pick_website');
		await h.entitle({ elements: { lists: false } });
		expect((await resolveDashboard({ wishlist: h.wishlist, sessionId })).state).toBe('not_subscribed');

		const demo = demoDashboard({ now: h.clock.now() });
		expect(demo.demo).toBe(true);
		expect((await demo.overview()).stats).toMatchObject({ lists: 3, guestLists: 1, optedIn: 1 });
		expect((await demo.overview()).topItems[0]).toMatchObject({ itemId: 'itm_demo_lamp', saves: 2 });
		expect(await demo.notifications()).toHaveLength(1);
		expect(await demo.lists()).toHaveLength(3);
	});
});

describe('privacy and helpers', () => {
	it('exports and deletes a customer’s lists and signals', async () => {
		h = await createHarness();
		const jane = await h.login('cus_jane');
		const saved = await h.call('POST', '/v1/lists/default/items', { identity: jane, body: item() });
		await h.call('PATCH', `/v1/lists/${saved.json.list.id}`, { identity: jane, body: { notify: true } });
		await h.deliver('price.changed@1', { itemId: 'itm_1', price: { amount: 100, currency: 'EUR' } });
		const privacy = createPrivacyHandlers({
			repoFor: repositoriesFor(h.wishlist.product, { now: h.clock.now }),
			now: h.clock.now,
		});
		const exported = await privacy.export({ websiteId: WEBSITE, subject: { customerId: 'cus_jane' } });
		expect(exported.collections.lists).toHaveLength(1);
		expect(exported.collections.notifications).toHaveLength(1);
		expect((await privacy.export({ websiteId: WEBSITE })).collections).toEqual({ lists: [], notifications: [] });
		expect(await privacy.anonymize({ websiteId: WEBSITE, subject: { subject: 'cus_jane' } })).toEqual({
			websiteId: WEBSITE,
			anonymized: { lists: 1, notifications: 1 },
		});
		expect(await privacy.anonymize({ websiteId: WEBSITE })).toEqual({
			websiteId: WEBSITE,
			anonymized: { lists: 0, notifications: 0 },
		});
		expect((await h.call('GET', '/v1/lists', { identity: jane })).json.items).toEqual([]);
	});

	it('maps outcomes to results and hashes rate-limit subjects', () => {
		expect(respond({ ok: true, body: { a: 1 } })).toMatchObject({ status: 200 });
		expect(respond({ ok: true, status: 201, body: {} }, () => null)).toMatchObject({ status: 201 });
		expect(respond({ ok: false, code: 'not_found' })).toMatchObject({ code: 'not_found' });
		const base = { websiteId: 'web_1', headers: new Headers({ 'x-real-ip': '192.0.2.1' }) };
		const ip = writerOf({ ...base, body: {} });
		expect(ip).not.toContain('192.0.2.1');
		expect(writerOf({ ...base, body: { guest: 'wg1.a.b' } })).not.toBe(ip);
		expect(writerOf({ ...base, identity: { subject: 'cus_1' } })).not.toBe(ip);
		expect(writerOf({ websiteId: 'web_1', headers: new Headers(), body: null })).toMatch(/^web_1\|/);
	});
});
