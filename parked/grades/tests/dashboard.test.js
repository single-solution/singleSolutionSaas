/** Dashboard data: session states and live data from the merchant database. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dashboardActor, resolveDashboard } from '../api/dashboard.js';
import { sessionView } from '../api/session.js';
import { WEBSITE, createHarness } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;

beforeAll(async () => {
	h = await createHarness();
}, 60_000);

afterAll(async () => {
	await h?.close();
});

describe('dashboard context', () => {
	it('asks to sign in without a session', async () => {
		expect(await resolveDashboard({ grades: h.grades, sessionId: null })).toEqual({ state: 'signin' });
		expect(await resolveDashboard({ grades: h.grades, sessionId: 'ses_unknown' })).toEqual({ state: 'signin' });
	});

	it('resolves the website of a merchant session with live data and the Portal link', async () => {
		await h.call('POST', '/v1/units', { body: { itemId: 'itm_dash', serial: 'D-1', tier: 'good' } });
		const context = await resolveDashboard({ grades: h.grades, sessionId: await h.session('merchant'), website: 'web_other' });
		expect(context.state).toBe('ready');
		if (context.state !== 'ready') return;
		expect(context.data).toMatchObject({ canWrite: true, websiteId: WEBSITE, mappingProblems: [] });
		expect(context.portalLink).toMatch(/^https:\/\/portal\.test\/websites\/web_/);
		const units = await context.data.units();
		expect(units[0]).toMatchObject({ serial: 'D-1', tier: 'good' });
		expect(await context.data.inspections()).toEqual([]);
		const overview = await context.data.overview();
		expect(overview.tiers.find((tier) => tier.key === 'good')?.units).toBe(1);
	});

	it('asks for a website or a subscription when needed', async () => {
		const noWebsite = await resolveDashboard({
			grades: h.grades,
			sessionId: await h.session('merchant', { scope: { merchantId: 'mer_0123456789abcdefghjkmnpq' } }),
		});
		expect(noWebsite.state).toBe('pick_website');
		await h.entitle({ elements: { tiers: false } });
		const off = await resolveDashboard({ grades: h.grades, sessionId: await h.session('merchant') });
		expect(off.state).toBe('not_subscribed');
		await h.entitle();
	});
});

describe('session helpers', () => {
	it('describes sessions and audited actors', () => {
		expect(dashboardActor({ kind: 'merchant', role: 'merchant', user: { id: 'usr_1' } })).toEqual({
			type: 'merchant',
			id: 'usr_1',
		});
		expect(dashboardActor({ kind: 'admin', role: 'platform_admin', subject: 'stf_1' })).toEqual({ type: 'staff', id: 'stf_1' });
		expect(dashboardActor({ kind: 'merchant', role: 'merchant' })).toEqual({ type: 'merchant', id: 'unknown' });
		expect(sessionView({ kind: 'admin', role: 'platform_admin' })).toEqual({
			kind: 'admin',
			role: 'platform_admin',
			scope: {},
			user: null,
		});
	});
});
