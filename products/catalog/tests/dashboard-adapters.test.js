/** Dashboard resolution (sign-in, demo, pick website, not subscribed, live data) and the adapters (tokens, registry, platform). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { generateSigningKey, hashRegistrationToken } from '@ss/protocol';
import { demoDashboard, dashboardActor, resolveDashboard, statusLabel, stubContext } from '../api/dashboard.js';
import { sessionView } from '../api/session.js';
import { createPlatform } from '../adapters/platform.js';
import { createSiteRegistry } from '../adapters/registry.js';
import { createFeedTokens, etagOf, feedSecret, newId, stableId } from '../adapters/tokens.js';
import { cronAuthorized, runSweep } from '../jobs/sweep.js';
import { MERCHANT, ROOT, T0, WEBSITE, WEBSITE_2, createHarness, mongoUri } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;

beforeAll(async () => {
	h = await createHarness();
	await h.call('POST', '/v1/items', { body: { title: 'Dash item', status: 'active', price: 1200, cost: 600, quantity: 1 } });
}, 60_000);

afterAll(async () => {
	await h?.close();
});

describe('dashboard', () => {
	it('resolves sessions to states and serves live data', async () => {
		const { catalog } = h;
		expect(await resolveDashboard({ catalog, sessionId: undefined })).toEqual({ state: 'signin' });
		expect((await resolveDashboard({ catalog, sessionId: 'ses_nope' })).state).toBe('signin');
		const merchant = await h.session('merchant');
		const ready = await resolveDashboard({ catalog, sessionId: merchant, website: WEBSITE });
		expect(ready.state).toBe('ready');
		if (ready.state !== 'ready') throw new Error('not ready');
		expect(ready.portalLink).toContain(`/websites/${WEBSITE}/subscriptions/`);
		expect(ready.data).toMatchObject({ demo: false, canWrite: true, websiteId: WEBSITE });
		const stats = await ready.data.stats();
		expect(stats.items.total).toBe(1);
		const page = await ready.data.items({ status: 'active' });
		expect(page.items[0]).toMatchObject({ title: 'Dash item', variants: [{ cost: 600 }] });
		expect((await ready.data.items({ cursor: 'not-a-cursor' })).items).toEqual([]);
		expect(await ready.data.item(String(page.items[0]?.id))).toMatchObject({ title: 'Dash item' });
		expect(await ready.data.item('bad id')).toBeNull();
		expect((await ready.data.feeds()).length).toBe(1);
		const unscoped = await h.session('merchant', { scope: { merchantId: MERCHANT } });
		expect((await resolveDashboard({ catalog, sessionId: unscoped })).state).toBe('pick_website');
		const other = await h.session('merchant', { scope: { merchantId: MERCHANT, websiteIds: [WEBSITE_2] } });
		expect((await resolveDashboard({ catalog, sessionId: other })).state).toBe('not_subscribed');
		const demo = await h.session('demo');
		const sandbox = await resolveDashboard({ catalog, sessionId: demo, now: T0 });
		expect(sandbox.state === 'ready' && sandbox.data.demo).toBe(true);
	});

	it('builds sandbox data with the real core (read-only)', async () => {
		const data = demoDashboard({ now: T0 });
		expect(data).toMatchObject({ demo: true, canWrite: false, websiteId: null });
		const stats = await data.stats();
		expect(stats.items).toMatchObject({ total: 4, outOfStock: 2, lowStock: 1 });
		expect((await data.items({ status: 'draft' })).items).toHaveLength(1);
		expect((await data.items({})).items).toHaveLength(4);
		expect(await data.item('itm_demo0')).toMatchObject({ title: 'Linen shirt', currency: 'EUR' });
		expect(await data.item('nope')).toBeNull();
		expect(await data.feeds()).toEqual([]);
		expect(statusLabel(data.settings, 'active')).toBe('Active');
	});

	it('names actors and parses the element stub context', () => {
		expect(dashboardActor({ kind: 'merchant', role: 'merchant', user: { id: 'usr_1' } })).toEqual({
			type: 'merchant',
			id: 'usr_1',
		});
		expect(dashboardActor({ kind: 'admin', role: 'platform_admin', subject: 'stf_1' })).toEqual({ type: 'staff', id: 'stf_1' });
		expect(dashboardActor({ kind: 'impersonate', role: 'impersonate', scope: { actor: 'stf_2' } })).toEqual({
			type: 'staff',
			id: 'stf_2',
		});
		expect(dashboardActor({ kind: 'merchant', role: 'merchant' })).toEqual({ type: 'merchant', id: 'unknown' });
		expect(sessionView({ kind: 'demo', role: 'demo' })).toEqual({
			kind: 'demo',
			role: 'demo',
			scope: {},
			user: null,
			actor: null,
		});
		expect(stubContext(JSON.stringify({ itemId: 'itm_1', pageType: 'product' }))).toEqual({
			itemId: 'itm_1',
			pageType: 'product',
		});
		expect(stubContext('[1]')).toEqual({ itemId: null, pageType: null });
		expect(stubContext(undefined)).toEqual({ itemId: null, pageType: null });
		expect(stubContext('x'.repeat(3000))).toEqual({ itemId: null, pageType: null });
	});
});

describe('adapters', () => {
	it('issues and verifies feed tokens; derives secrets; ids and ETags', () => {
		const tokens = createFeedTokens({ secret: Buffer.alloc(32, 1) });
		const token = tokens.issue({ websiteId: 'web_1', feedKey: 'shopping', version: 3 });
		expect(tokens.verify(token)).toEqual({ websiteId: 'web_1', feedKey: 'shopping', version: 3 });
		expect(tokens.verify(`${token}x`)).toBeNull();
		expect(tokens.verify(token.replace('fd1', 'fd2'))).toBeNull();
		expect(tokens.verify(`${token}.extra`)).toBeNull();
		expect(tokens.verify(42)).toBeNull();
		expect(createFeedTokens({ secret: Buffer.alloc(32, 2) }).verify(token)).toBeNull();
		const forged = createFeedTokens({ secret: Buffer.alloc(32, 1) });
		const [, , signature] = token.split('.');
		expect(forged.verify(`fd1.${Buffer.from('not json').toString('base64url')}.${signature}`)).toBeNull();
		expect(feedSecret({ secret: 's'.repeat(32) }).toString()).toBe('s'.repeat(32));
		expect(feedSecret({ signingKey: JSON.stringify({ d: Buffer.alloc(32, 3).toString('base64url') }) })).toHaveLength(32);
		expect(() => feedSecret({ signingKey: {} })).toThrow(/CATALOG_FEED_SECRET/);
		expect(stableId('a')).toHaveLength(26);
		expect(stableId('a')).toBe(stableId('a'));
		expect(newId('itm')).toMatch(/^itm_[0-9a-z]{26}$/);
		expect(etagOf('x')).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
	});

	it('remembers websites in memory or in the control database', async () => {
		const memory = createSiteRegistry();
		await memory.remember('web_b');
		await memory.remember('web_a');
		await memory.remember('web_a');
		expect(await memory.list()).toEqual(['web_a', 'web_b']);
		const client = await new MongoClient(mongoUri(`registry_${Date.now()}`)).connect();
		const collection = client.db().collection('ss_catalog_sites');
		const stored = createSiteRegistry({ collection });
		await stored.remember('web_c');
		expect(await createSiteRegistry({ collection }).list()).toEqual(['web_c']);
		const failing = createSiteRegistry({
			collection: /** @type {any} */ ({
				updateOne: async () => Promise.reject(new Error('down')),
				find: () => ({ toArray: async () => [] }),
			}),
		});
		await failing.remember('web_d');
		expect(await failing.list()).toEqual([]);
		await client.db().dropDatabase();
		await client.close();
	});

	it('builds the platform from the environment (control database optional) and refuses missing variables', async () => {
		await expect(createPlatform({ env: {}, root: ROOT })).rejects.toThrow(
			/SS_PORTAL_URL, SS_APP_SIGNING_KEY, SS_REGISTRATION_TOKEN_HASH/,
		);
		const { privateJwk } = await generateSigningKey({ kid: 'catalog-platform-1' });
		const app = await createPlatform({
			env: {
				SS_PORTAL_URL: 'https://portal.test',
				SS_APP_SIGNING_KEY: JSON.stringify(privateJwk),
				SS_REGISTRATION_TOKEN_HASH: hashRegistrationToken('rt_catalog_platform_test_000000'),
				SS_PRODUCT_DB_URI: mongoUri(`control_${Date.now()}`),
				CRON_SECRET: 'short',
				CATALOG_FEED_SECRET: 'f'.repeat(40),
			},
			root: ROOT,
		});
		expect(app.cronSecret).toBeNull();
		await app.registry.remember('web_x');
		expect(await app.registry.list()).toEqual(['web_x']);
		expect(app.product.manifest.elements[0].features.properties.max_items).toBeTruthy();
		await app.close();
	});

	it('runs the sweep per website, isolating failures, and checks the cron secret in constant time', async () => {
		const result = await runSweep({
			websiteIds: ['a', 'b', 'c'],
			siteFor: async (id) => (id === 'c' ? null : { id }),
			run: async (site) => {
				if (site.id === 'b') throw new Error('boom');
				return { n: 1 };
			},
		});
		expect(result).toEqual({
			websites: 2,
			results: [
				{ websiteId: 'a', n: 1 },
				{ websiteId: 'b', error: 'failed' },
			],
		});
		expect(cronAuthorized('Bearer abc', 'abc')).toBe(true);
		expect(cronAuthorized('Bearer abd', 'abc')).toBe(false);
		expect(cronAuthorized(null, 'abc')).toBe(false);
		expect(cronAuthorized('Bearer abc', null)).toBe(false);
	});
});
