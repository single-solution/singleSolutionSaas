/** Dashboard resolution (sign-in, pick website, not subscribed, live) and the data the pages render. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dashboardActor, resolveDashboard } from '../api/dashboard.js';
import { sessionView } from '../api/session.js';
import { createTranslator } from '../headless/strings.js';
import { WEBSITE, createHarness } from './harness.js';

describe('dashboard', () => {
	/** @type {Awaited<ReturnType<typeof createHarness>>} */
	let h;
	beforeAll(async () => {
		h = await createHarness({
			config: {
				sources: { crawl_sources: [{ key: 'map', kind: 'sitemap', url: 'https://shop.example.com/s.xml', type: 'page' }] },
			},
		});
		await h.index([{ id: 'p1', type: 'page', fields: { title: 'Returns policy' } }]);
		await h.call('GET', '/v1/search?q=returns');
	});
	afterAll(async () => h.close());

	it('resolves every session state', async () => {
		expect(await resolveDashboard({ searchApp: h.search, sessionId: undefined })).toEqual({ state: 'signin' });
		expect(await resolveDashboard({ searchApp: h.search, sessionId: 'ses_unknown' })).toEqual({ state: 'signin' });
		const nobody = await resolveDashboard({
			searchApp: h.search,
			sessionId: await h.session('merchant', { scope: { merchantId: 'mer_x' } }),
		});
		expect(nobody.state).toBe('pick_website');
		await h.entitle({ elements: { index: false } });
		const off = await resolveDashboard({ searchApp: h.search, sessionId: await h.session('merchant') });
		expect(off.state).toBe('not_subscribed');
		await h.entitle();
	});

	it('serves live data: status, documents, test search, sources and analytics', async () => {
		const context = await resolveDashboard({ searchApp: h.search, sessionId: await h.session('merchant'), website: WEBSITE });
		if (context.state !== 'ready') throw new Error(context.state);
		expect(context.portalLink).toContain(`/websites/${WEBSITE}/subscriptions/`);
		expect(context.data.canWrite).toBe(true);
		const status = await context.data.status();
		expect(status.documents).toMatchObject({ total: 1, byType: { page: 1, item: 0 } });
		expect((await context.data.documents({})).items.map((d) => d.id)).toEqual(['p1']);
		const result = await context.data.search('return');
		expect(result?.items[0]).toMatchObject({ id: 'p1' });
		expect((await context.data.sources()).items[0].key).toBe('map');
		expect((await context.data.analytics(7))?.totals.searches).toBe(1);
		await h.entitle({ elements: { analytics: false } });
		const without = await resolveDashboard({ searchApp: h.search, sessionId: await h.session('merchant') });
		expect(without.state === 'ready' && (await without.data.analytics(7))).toBeNull();
		await h.entitle();
	});

	it('names the audited actor and translates', () => {
		expect(dashboardActor({ kind: 'merchant', role: 'merchant', user: { id: 'usr_1' } })).toEqual({
			type: 'merchant',
			id: 'usr_1',
		});
		expect(dashboardActor({ kind: 'admin', role: 'platform_admin', subject: 'stf_1' })).toEqual({ type: 'staff', id: 'stf_1' });
		expect(dashboardActor({ kind: 'x', role: 'y' })).toEqual({ type: 'merchant', id: 'unknown' });
		expect(sessionView({ kind: 'admin', role: 'platform_admin' })).toEqual({
			kind: 'admin',
			role: 'platform_admin',
			scope: {},
			user: null,
		});
		expect(createTranslator({ a: 'Hi {name} {x}' })('a', { name: 'Ada' })).toBe('Hi Ada {x}');
		expect(createTranslator({})('missing')).toBe('missing');
	});
});
