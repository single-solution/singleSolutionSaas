/** Dashboard data: session states, live data from the merchant database and the in-memory demo. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dashboardActor, demoDashboard, resolveDashboard } from '../api/dashboard.js';
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
		expect(await resolveDashboard({ aftersales: h.aftersales, sessionId: null })).toEqual({ state: 'signin' });
		expect(await resolveDashboard({ aftersales: h.aftersales, sessionId: 'ses_unknown' })).toEqual({ state: 'signin' });
		const demo = await resolveDashboard({ aftersales: h.aftersales, sessionId: await h.session('demo'), now: T0 });
		expect(demo.state).toBe('ready');
		if (demo.state !== 'ready') return;
		expect(demo.data).toMatchObject({ demo: true, canWrite: false, websiteId: null });
		const overview = await demo.data.overview();
		expect(overview.byKind.open).toBeGreaterThan(0);
		expect(overview.byKind.rejected).toBe(1);
		expect(await demo.data.claims(['requested'])).toHaveLength(1);
		expect(await demo.data.claims(null)).toHaveLength(4);
		expect(await demo.data.serial('x')).toBeNull();
	});

	it('resolves the website of a merchant session with live data and the Portal link', async () => {
		const { orderId } = await h.order();
		await h.call('POST', '/v1/serials', { body: { serial: 'DASH-1', itemId: 'itm_1', variantId: 'var_1', orderId } });
		const context = await resolveDashboard({
			aftersales: h.aftersales,
			sessionId: await h.session('merchant'),
			website: 'web_other',
		});
		expect(context.state).toBe('ready');
		if (context.state !== 'ready') return;
		expect(context.data).toMatchObject({ demo: false, canWrite: true, websiteId: WEBSITE });
		expect(context.portalLink).toMatch(/^https:\/\/portal\.test\/websites\/web_/);
		expect(await context.data.claims(null)).toEqual([]);
		expect((await context.data.serial('DASH1'))?.orderId).toBe(orderId);
		expect(await context.data.serial('NONE-1')).toBeNull();
		expect((await context.data.overview()).byKind.open).toBe(0);
		await h.entitle({ elements: { claims: false } });
		expect((await resolveDashboard({ aftersales: h.aftersales, sessionId: await h.session('merchant') })).state).toBe(
			'not_subscribed',
		);
		await h.entitle();
	});

	it('asks to pick a website when the launch has none and names the audited actor', async () => {
		const { token } = await h.portal.issueLaunch({
			kind: 'merchant',
			subject: 'usr_x',
			user: { id: 'usr_x' },
			scope: { merchantId: 'mer_0123456789abcdefghjkmnpq' },
		});
		const sso = await h.handle(new Request(`https://aftersales.example.com/sso?launch=${encodeURIComponent(token)}`));
		const id = /ss_session=(ses_[^;]+)/.exec(sso.headers.get('set-cookie') ?? '')?.[1];
		expect((await resolveDashboard({ aftersales: h.aftersales, sessionId: id })).state).toBe('pick_website');
		expect(dashboardActor({ kind: 'impersonate', role: 'impersonate', scope: { actor: 'stf_1' } })).toEqual({
			type: 'staff',
			id: 'stf_1',
		});
		expect(dashboardActor({ kind: 'admin', role: 'platform_admin', subject: 'adm_1' })).toEqual({ type: 'staff', id: 'adm_1' });
		expect(dashboardActor({ kind: 'merchant', role: 'merchant' })).toEqual({ type: 'merchant', id: 'unknown' });
		expect(demoDashboard({ now: T0 }).settings.initialStatus).toBe('requested');
	});
});
