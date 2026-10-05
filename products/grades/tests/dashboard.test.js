/** Dashboard data: session states, live data from the merchant database and the in-memory demo. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dashboardActor, demoDashboard, resolveDashboard } from '../api/dashboard.js';
import { sessionView } from '../api/session.js';
import { T0, WEBSITE, createHarness } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;

beforeAll(async () => {
	h = await createHarness();
}, 60_000);

afterAll(async () => {
	await h?.close();
});

describe('dashboard context', () => {
	it('asks to sign in without a session and shows the demo for demo launches', async () => {
		expect(await resolveDashboard({ grades: h.grades, sessionId: null })).toEqual({ state: 'signin' });
		expect(await resolveDashboard({ grades: h.grades, sessionId: 'ses_unknown' })).toEqual({ state: 'signin' });
		const demo = await resolveDashboard({ grades: h.grades, sessionId: await h.session('demo'), now: T0 });
		expect(demo.state).toBe('ready');
		if (demo.state !== 'ready') return;
		expect(demo.data).toMatchObject({ demo: true, canWrite: false, websiteId: null });
		expect(demo.portalLink).toBeNull();
	});

	it('resolves the website of a merchant session with live data and the Portal link', async () => {
		await h.call('POST', '/v1/units', { body: { itemId: 'itm_dash', serial: 'D-1', tier: 'good' } });
		const context = await resolveDashboard({ grades: h.grades, sessionId: await h.session('merchant'), website: 'web_other' });
		expect(context.state).toBe('ready');
		if (context.state !== 'ready') return;
		expect(context.data).toMatchObject({ demo: false, canWrite: true, websiteId: WEBSITE, mappingProblems: [] });
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

describe('demo data', () => {
	it('scores sample units with the real core and the default settings', async () => {
		const demo = demoDashboard({ now: T0 });
		const units = await demo.units();
		expect(units.map((unit) => [unit.serial, unit.tier, unit.score])).toEqual([
			['SN-DEMO-001', 'new', 100],
			['SN-DEMO-002', 'good', 71],
			['SN-DEMO-003', 'fair', 42],
		]);
		const overview = await demo.overview();
		expect(overview.inspections).toEqual({ draft: 0, completed: 3 });
		expect(overview.tiers.map((tier) => tier.units)).toEqual([1, 0, 1, 1]);
		expect((await demo.inspections())[2]).toMatchObject({ criticalFailed: true, status: 'completed' });
	});
});

describe('session helpers', () => {
	it('describes sessions and audited actors', () => {
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
	});
});
