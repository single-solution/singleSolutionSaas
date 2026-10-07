/**
 * distribution (share links, QR SVG, CSV export), reporting, the eligibility checker, the dashboard API and resolver,
 * and the event consumers' edge cases — through app-kit's request handler with a real MongoDB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDashboard } from '../api/dashboard.js';
import { createEventHandlers } from '../api/consumers.js';
import { cart, createHarness, MERCHANT, WEBSITE } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
/** @type {any} */
let shared;
beforeAll(async () => {
	h = await createHarness({ config: { distribution: { utm_source: 'coupons' } } });
	shared = await h.coupon({
		code: 'SHARE10',
		name: 'Share 10 %',
		action: { type: 'percent', percent: 10, target: 'order' },
	});
});
afterAll(async () => h?.close());

describe('distribution', () => {
	it('builds share links on the website’s domain with the auto-apply parameter', async () => {
		const link = await h.call('POST', '/v1/share-links', { body: { code: 'share10', path: '/sale', campaign: 'nl-42' } });
		expect(link.status).toBe(200);
		expect(link.json).toEqual({
			code: 'SHARE10',
			couponId: shared.id,
			url: 'https://shop.example.com/sale?coupon=SHARE10&utm_source=coupons&utm_campaign=nl-42',
			qr: '/v1/share-links/SHARE10/qr',
		});
		expect((await h.call('GET', '/v1/share-links/SHARE10')).json.url).toBe(
			'https://shop.example.com/?coupon=SHARE10&utm_source=coupons',
		);
		expect((await h.call('GET', '/v1/share-links/NOPE')).status).toBe(404);
		expect((await h.call('POST', '/v1/share-links', { body: { code: 'SHARE10', path: '//evil.example' } })).status).toBe(422);
	});

	it('renders the share link as a QR code (SVG made by the product)', async () => {
		const qr = await h.call('GET', '/v1/share-links/SHARE10/qr');
		expect(qr.status).toBe(200);
		expect(qr.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8');
		expect(qr.headers.get('x-content-type-options')).toBe('nosniff');
		expect(qr.text).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 (\d+) \1"/);
		expect(qr.text).toContain('fill="#000000"');
		expect(qr.text).toContain('<title>SHARE10</title>');
		expect((await h.call('GET', '/v1/share-links/NOPE/qr')).status).toBe(404);
	});

	it('exports a coupon’s codes as CSV', async () => {
		const bulk = await h.coupon({ count: 3, action: { type: 'percent', percent: 5 } });
		const csv = await h.call('GET', `/v1/exports/${bulk.id}`);
		expect(csv.status).toBe(200);
		expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
		expect(csv.headers.get('content-disposition')).toBe(`attachment; filename="coupon-${bulk.id}.csv"`);
		const lines = csv.text.trim().split('\r\n');
		expect(lines[0]).toBe('code,status,max_uses,taken,redeemed,link');
		expect(lines).toHaveLength(4);
		expect(lines[1]).toMatch(/^[A-Z0-9-]+,active,1,0,0,https:\/\/shop\.example\.com\/\?coupon=/);
		expect((await h.call('GET', '/v1/exports/cpn_missing')).status).toBe(404);
		await h.entitle({ config: { distribution: { max_export_rows: 2 } } });
		expect((await h.call('GET', `/v1/exports/${bulk.id}`)).text.trim().split('\r\n')).toHaveLength(3);
		await h.entitle({ elements: { distribution: false } });
		expect((await h.call('GET', `/v1/exports/${bulk.id}`)).status).toBe(403);
		await h.entitle();
	});
});

describe('reporting', () => {
	it('reports redemptions, discount and revenue per currency with top codes', async () => {
		await h.coupon({ code: 'REPORT', action: { type: 'fixed', amount: 1000 }, currency: 'EUR' });
		for (const orderId of ['ord_r1', 'ord_r2'])
			expect((await h.call('POST', '/v1/redemptions', { body: { codes: ['REPORT'], cart: cart(), orderId } })).status).toBe(
				201,
			);
		const undone = await h.call('POST', '/v1/redemptions', {
			body: { codes: ['SHARE10'], cart: cart({ currency: 'USD' }), orderId: 'ord_r3' },
		});
		await h.call('POST', `/v1/redemptions/${undone.json.id}/release`, {});
		await h.call('POST', '/v1/redemptions', {
			body: { codes: ['SHARE10'], cart: cart({ currency: 'USD' }), orderId: 'ord_r4' },
		});
		const report = await h.call('GET', '/v1/reports');
		expect(report.status).toBe(200);
		expect(report.json).toMatchObject({ redemptions: 3, orders: 3, released: 1 });
		expect(report.json.currencies).toEqual([
			{ currency: 'EUR', orders: 2, discount: 2000, revenue: 19_000, averageOrder: 9500, discountRate: 9.52 },
			{ currency: 'USD', orders: 1, discount: 1000, revenue: 9500, averageOrder: 9500, discountRate: 9.52 },
		]);
		expect(report.json.topCodes[0]).toMatchObject({ code: 'REPORT', redemptions: 2, discount: 2000, currency: 'EUR' });
		const empty = await h.call(
			'GET',
			`/v1/reports?from=${encodeURIComponent('2020-01-01T00:00:00Z')}&to=${encodeURIComponent('2020-02-01T00:00:00Z')}`,
		);
		expect(empty.json).toMatchObject({ redemptions: 0, currencies: [], topCodes: [] });
		expect((await h.call('GET', '/v1/reports?from=nonsense')).status).toBe(422);
		const long = await h.call('GET', `/v1/reports?from=${encodeURIComponent('2020-01-01T00:00:00Z')}`);
		expect(long.status).toBe(422);
		expect(long.json.errors[0]).toMatchObject({ code: 'window_too_long' });
	});
});

describe('eligibility checker', () => {
	it('diagnoses rules and evaluates conditions on a cart', async () => {
		const check = await h.call('POST', '/v1/eligibility:check', {
			body: {
				when: "cart.subtotal >= 5000 and not inSegment('wholesale')",
				conditions: [{ type: 'collections', operator: 'in', value: ['socks'] }],
				cart: cart(),
			},
			idempotencyKey: null,
		});
		expect(check.status).toBe(200);
		expect(check.json.rule).toMatchObject({ ok: true, paths: ['cart.subtotal'] });
		expect(check.json.evaluation).toEqual({ eligible: true, matchedLines: ['l1'], rule: true, ruleError: null });
		const only = await h.call('POST', '/v1/eligibility:check', { body: { when: 'cart.subtotal >=' }, idempotencyKey: null });
		expect(only.json.rule.ok).toBe(false);
		expect(only.json.evaluation).toBeNull();
		expect((await h.call('POST', '/v1/eligibility:check', { body: { conditions: 'x' }, idempotencyKey: null })).status).toBe(
			422,
		);
	});
});

describe('dashboard', () => {
	it('resolves sessions: sign in, pick a website, not subscribed, live data', async () => {
		const { coupons } = h;
		expect((await resolveDashboard({ coupons, sessionId: null })).state).toBe('signin');
		expect((await resolveDashboard({ coupons, sessionId: 'ses_missing' })).state).toBe('signin');
		const session = (/** @type {any} */ value) => ({
			...coupons,
			product: { ...coupons.product, launch: { session: async () => value } },
		});
		const pick = await resolveDashboard({
			coupons: session({ role: 'merchant', kind: 'merchant', scope: {} }),
			sessionId: 'ses_1',
		});
		expect(pick.state).toBe('pick_website');
		const other = await resolveDashboard({
			coupons: session({ role: 'merchant', kind: 'merchant', scope: { websiteId: 'web_9999999999999999999999999z' } }),
			sessionId: 'ses_1',
		});
		expect(other.state).toBe('not_subscribed');
		const live = await resolveDashboard({
			coupons: session({ role: 'merchant', kind: 'merchant', scope: { websiteIds: [WEBSITE] } }),
			sessionId: 'ses_1',
			website: WEBSITE,
		});
		if (live.state !== 'ready') throw new Error('expected a ready dashboard');
		expect(live.data).toMatchObject({ canWrite: true, websiteId: WEBSITE });
		expect(live.portalLink).toMatch(/\/websites\/web_0123456789abcdefghjkmnpq\/subscriptions\//);
		const overview = await live.data.overview();
		expect(overview.activeCoupons).toBeGreaterThanOrEqual(1);
		const list = await live.data.coupons({});
		expect(list.map((coupon) => coupon.id)).toContain(shared.id);
		const detail = await live.data.coupon(shared.id);
		expect(detail?.codes[0]?.code).toBe('SHARE10');
		expect(detail?.qr).toMatch(/^<svg/);
		expect(detail?.link).toBe('https://shop.example.com/?coupon=SHARE10&utm_source=coupons');
		expect(await live.data.coupon('cpn_missing')).toBeNull();
	});

	it('creates coupons (audited), exports codes and checks rules with merchant and staff (admin) launch sessions', async () => {
		const launch = async (/** @type {any} */ kind) => {
			const { token } = await h.portal.issueLaunch({
				kind,
				subject: 'usr_merchant',
				user: { id: 'usr_merchant' },
				scope: { merchantId: MERCHANT, websiteId: WEBSITE },
			});
			const sso = await h.handle(new Request(`https://coupons.example.com/sso?launch=${encodeURIComponent(token)}`));
			const session = /ss_session=(ses_[^;]+)/.exec(sso.headers.get('set-cookie') ?? '')?.[1];
			if (!session) throw new Error(`no session (${sso.status})`);
			return session;
		};
		const merchant = await launch('merchant');
		expect((await h.call('GET', '/v1/session', { key: merchant })).json).toMatchObject({
			kind: 'merchant',
			user: 'usr_merchant',
		});
		const created = await h.call('POST', '/v1/dashboard/coupons', {
			key: merchant,
			body: { name: 'From the dashboard', count: 2, action: { type: 'percent', percent: 15 } },
		});
		expect(created.status).toBe(201);
		expect(created.json.generated.count).toBe(2);
		const audit = await h.db.collection('ss_coupons_audit').findOne({ websiteId: WEBSITE, 'target.couponId': created.json.id });
		expect(audit?.actor).toMatchObject({ type: 'merchant', id: 'usr_merchant' });
		expect((await h.call('POST', '/v1/dashboard/coupons', { key: merchant, body: { name: '' } })).status).toBe(422);
		const csv = await h.call('GET', `/v1/dashboard/coupons/${created.json.id}/export`, { key: merchant });
		expect(csv.text.split('\r\n')[0]).toBe('code,status,max_uses,taken,redeemed,link');
		expect((await h.call('GET', '/v1/dashboard/coupons/cpn_missing/export', { key: merchant })).status).toBe(404);
		const check = await h.call('POST', '/v1/dashboard/eligibility:check', {
			key: merchant,
			body: { source: 'cart.subtotal > 1' },
		});
		expect(check.json.ok).toBe(true);
		expect((await h.call('POST', '/v1/dashboard/eligibility:check', { key: merchant, body: {} })).status).toBe(422);
		expect((await h.call('GET', '/v1/dashboard/overview', { key: merchant })).json.activeCoupons).toBeGreaterThan(0);
		const staff = await launch('admin');
		const byStaff = await h.call('POST', '/v1/dashboard/coupons', {
			key: staff,
			body: { name: 'By staff', action: { type: 'percent', percent: 5 } },
		});
		expect(byStaff.status).toBe(201);
		const staffAudit = await h.db
			.collection('ss_coupons_audit')
			.findOne({ websiteId: WEBSITE, 'target.couponId': byStaff.json.id });
		expect(staffAudit?.actor).toMatchObject({ type: 'staff', id: 'usr_merchant' });
	});
});

describe('consumers', () => {
	it('ignores events of websites without the api element and events without an order', async () => {
		/** @type {string[]} */
		const calls = [];
		const service = /** @type {any} */ ({
			orderCompleted: async () => calls.push('completed'),
			orderCancelled: async () => calls.push('cancelled'),
			orderRefunded: async () => calls.push('refunded'),
		});
		const handlers = createEventHandlers({
			service,
			siteFor: async (id) => (id === 'web_on' ? /** @type {any} */ ({}) : null),
		});
		await handlers['order.completed@1']?.({ websiteId: 'web_off', data: { orderId: 'o' } });
		await handlers['order.cancelled@1']?.({ websiteId: 'web_on', data: {} });
		await handlers['order.refunded@1']?.({ websiteId: 'web_on', data: { orderId: 'o' } });
		expect(calls).toEqual(['refunded']);
		await h.entitle({ elements: { api: false } });
		expect((await h.deliver('order.completed@1', { orderId: 'ord_x' })).status).toBe(200);
		await h.entitle();
	});
});
