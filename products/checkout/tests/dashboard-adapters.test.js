import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIntegrations } from '../adapters/integrations.js';
import { createTestGateway } from '../adapters/payments.js';
import { createSiteRegistry } from '../adapters/registry.js';
import { isTransactionUnsupported, strip } from '../adapters/db.js';
import { maskKey, seal, sealingKey, unseal } from '../adapters/secrets.js';
import { demoDashboard, kpisOf, resolveDashboard } from '../api/dashboard.js';
import { fail, requesterOf } from '../api/routes.js';
import { sessionView } from '../api/session.js';
import { cronAuthorized, drain, runSweepJob } from '../jobs/sweep.js';
import { CONNECTED, MERCHANT, WEBSITE, checkoutBody, createHarness } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;

beforeAll(async () => {
	h = await createHarness({ config: CONNECTED });
	await h.item('itm_d', { variants: [{ variantId: 'v', price: 1000, available: 20 }] });
}, 60_000);
afterAll(async () => h?.close());

/** @param {any} kind */
const launch = async (kind) => {
	const { token } = await h.portal.issueLaunch({
		kind,
		subject: 'usr_merchant',
		user: { id: 'usr_merchant' },
		scope: kind === 'demo' ? {} : { merchantId: MERCHANT, websiteId: WEBSITE },
	});
	const sso = await h.handle(new Request(`https://checkout.example.com/sso?launch=${encodeURIComponent(token)}`));
	const session = /ss_session=(ses_[^;]+)/.exec(sso.headers.get('set-cookie') ?? '')?.[1];
	if (!session) throw new Error(`no session (${sso.status})`);
	return session;
};

describe('dashboard', () => {
	it('resolves the dashboard for every session state', async () => {
		const { application } = h;
		expect((await resolveDashboard({ application, sessionId: null })).state).toBe('signin');
		/** @param {any} value */
		const withSession = (value) => ({
			...application,
			product: { ...application.product, launch: { session: async () => value } },
		});
		const demo = await resolveDashboard({ application: withSession({ role: 'demo', kind: 'demo' }), sessionId: 's' });
		expect(demo.state === 'ready' && demo.data.demo).toBe(true);
		if (demo.state === 'ready') {
			expect((await demo.data.orders({ status: 'confirmed' })).length).toBe(1);
			expect(await demo.data.order('ord_demo_000002')).toMatchObject({ status: 'pending_payment' });
			expect(await demo.data.order('nope')).toBeNull();
			expect((await demo.data.overview()).open).toBe(2);
			expect((await demo.data.integrations()).key).toBeNull();
		}
		expect((await resolveDashboard({ application: withSession({ role: 'merchant', scope: {} }), sessionId: 's' })).state).toBe(
			'pick_website',
		);
		expect(
			(
				await resolveDashboard({
					application: withSession({ role: 'merchant', scope: { websiteId: 'web_unknownunknownunknownun' } }),
					sessionId: 's',
				})
			).state,
		).toBe('not_subscribed');
		const placed = await h.call('POST', '/v1/orders', { body: checkoutBody({ lines: [{ itemId: 'itm_d', quantity: 1 }] }) });
		const live = await resolveDashboard({
			application: withSession({ role: 'merchant', scope: { websiteIds: [WEBSITE] } }),
			sessionId: 's',
			website: WEBSITE,
		});
		if (live.state !== 'ready') throw new Error(live.state);
		expect(live.portalLink).toContain(`/websites/${WEBSITE}/subscriptions/`);
		expect((await live.data.overview()).orders).toBe(1);
		expect(await live.data.orders({})).toHaveLength(1);
		expect(await live.data.order(placed.json.id)).toMatchObject({ number: placed.json.number, proofs: [] });
		expect(await live.data.order('nope')).toBeNull();
		// expire on read: once the transfer hold passed the dashboard shows the order cancelled, before any sweep
		await h.collection('orders').updateOne({ id: placed.json.id }, { $set: { expiresAt: new Date(h.clock.now() - 1) } });
		expect(await live.data.order(placed.json.id)).toMatchObject({ status: 'cancelled' });
		expect((await live.data.orders({}))[0]).toMatchObject({ status: 'cancelled' });
		expect((await live.data.integrations()).coupons).toBe(true);
		expect(
			kpisOf([
				{ _id: { status: 'confirmed', currency: 'EUR' }, count: 2, total: 50 },
				{ _id: { status: 'cancelled', currency: 'EUR' }, count: 1, total: 9 },
				{ _id: { status: 'pending_payment', currency: 'USD' }, count: 1, total: 1 },
			]),
		).toEqual({
			orders: 4,
			open: 1,
			currencies: [
				{ currency: 'EUR', orders: 2, revenue: 50 },
				{ currency: 'USD', orders: 0, revenue: 0 },
			],
		});
		expect(demoDashboard({ now: 0 }).canWrite).toBe(false);
	});

	it('confirms, cancels, records payments and sets the integration key with a launch session; demo is read-only', async () => {
		const merchant = await launch('merchant');
		expect((await h.call('GET', '/v1/session', { key: merchant })).json).toMatchObject({
			kind: 'merchant',
			user: 'usr_merchant',
		});
		const cod = await h.call('POST', '/v1/orders', {
			body: checkoutBody({ lines: [{ itemId: 'itm_d', quantity: 1 }], paymentMethod: 'cod' }),
		});
		expect((await h.call('POST', `/v1/dashboard/orders/${cod.json.id}/confirm`, { key: merchant, body: {} })).json.status).toBe(
			'confirmed',
		);
		expect(
			(await h.call('POST', `/v1/dashboard/orders/${cod.json.id}/payments`, { key: merchant, body: { amount: 0 } })).status,
		).toBe(409);
		expect(
			(
				await h.call('POST', `/v1/dashboard/orders/${cod.json.id}/payments`, {
					key: merchant,
					body: { amount: cod.json.totals.total, reference: 'cash' },
				})
			).json.payment.status,
		).toBe('paid');
		expect((await h.call('POST', `/v1/dashboard/orders/${cod.json.id}/cancel`, { key: merchant, body: {} })).json.status).toBe(
			'cancelled',
		);
		expect((await h.call('POST', '/v1/dashboard/orders/ord_none/cancel', { key: merchant, body: {} })).status).toBe(404);
		expect((await h.call('GET', `/v1/dashboard/orders/${cod.json.id}/proofs/prf_none`, { key: merchant })).status).toBe(404);
		expect((await h.call('PUT', '/v1/dashboard/integration-key', { key: merchant, body: { key: 'bad' } })).status).toBe(422);
		expect(
			(await h.call('PUT', '/v1/dashboard/integration-key', { key: merchant, body: { key: 'sk_live_dashboard_key_0123' } }))
				.json.key,
		).toBe('sk_live_…0123');
		expect((await h.call('PUT', '/v1/dashboard/integration-key', { key: merchant, body: { key: '' } })).json.key).toBeNull();
		const audit = await h.db
			.collection('ss_checkout_audit')
			.findOne({ websiteId: WEBSITE, action: 'checkout.integration_key_removed' });
		expect(audit?.actor).toMatchObject({ type: 'merchant', id: 'usr_merchant' });
		const demo = await launch('demo');
		expect((await h.call('POST', `/v1/dashboard/orders/${cod.json.id}/confirm`, { key: demo, body: {} })).status).toBe(403);
		expect((await h.call('GET', `/v1/dashboard/orders/${cod.json.id}/proofs/p`, { key: demo })).status).toBe(400);
	});

	it('maps requesters and failures', () => {
		expect(requesterOf({ session: {} }).kind).toBe('session');
		expect(requesterOf({ website: { kind: 'sk' } }).kind).toBe('sk');
		expect(requesterOf({ website: { kind: 'pk' }, identity: { subject: 's', email: 'e' } })).toEqual({
			kind: 'pk',
			subject: 's',
			email: 'e',
			phone: null,
		});
		expect(requesterOf({ website: { kind: 'pk' } }).subject).toBeNull();
		expect(fail({ code: 'blocked', detail: 'x' })).toBeTruthy();
		expect(sessionView({ kind: 'impersonate', role: 'impersonate', scope: { actor: 'stf_1' } }).actor).toBe('stf_1');
	});
});

describe('adapters and jobs', () => {
	it('seals the integration key per website', () => {
		const key = sealingKey('secret material');
		const box = seal(key, 'web_a', 'sk_live_x');
		expect(unseal(key, 'web_a', box)).toBe('sk_live_x');
		expect(unseal(key, 'web_b', box)).toBeNull();
		expect(unseal(sealingKey('other'), 'web_a', box)).toBeNull();
		expect(unseal(key, 'web_a', { v: 2 })).toBeNull();
		expect(unseal(key, 'web_a', null)).toBeNull();
		expect(maskKey('sk_live_abcdefgh')).toBe('sk_live_…efgh');
		expect(maskKey('abcdefgh')).toBe('abc…efgh');
	});

	it('calls other products through the guarded send, never throwing', async () => {
		/** @type {any[]} */
		const seen = [];
		const integrations = createIntegrations({
			send: async (url, init) => {
				seen.push({ url, init });
				if (url.includes('/down')) throw new Error('network');
				if (url.includes('/text')) return { status: 200, body: Buffer.from('not json') };
				if (url.includes('/empty')) return { status: 204, body: Buffer.from('') };
				if (url.includes('/bad')) return { status: 500, body: Buffer.from('{}') };
				return { status: 409, body: Buffer.from(JSON.stringify({ type: 'https://x/problems/exhausted' })) };
			},
		});
		const c = { base: 'https://p.test/', key: 'sk_x' };
		expect(await integrations.call(null, 'GET', '/v1/x')).toEqual({ ok: false, reason: 'not_configured' });
		expect(await integrations.call(c, 'GET', '/down')).toEqual({ ok: false, reason: 'unreachable' });
		expect(await integrations.call(c, 'GET', '/text')).toEqual({ ok: true, status: 200, json: null });
		expect(await integrations.call(c, 'GET', '/empty')).toEqual({ ok: true, status: 204, json: null });
		expect(await integrations.call(c, 'GET', '/bad')).toMatchObject({ ok: false, code: 'http_500' });
		expect(await integrations.coupons.redeem(c, 'r/1', 'o', 'k')).toMatchObject({
			ok: false,
			reason: 'refused',
			code: 'exhausted',
		});
		await integrations.call(c, 'POST', '/v1/y', { body: {}, idempotencyKey: 'k', identity: 'tok' });
		expect(seen.at(-1).init.headers).toMatchObject({
			'idempotency-key': 'k',
			'ss-identity': 'tok',
			authorization: 'Bearer sk_x',
		});
		expect(seen.find((s) => s.url.includes('r%2F1'))).toBeTruthy();
		expect(seen.every((s) => s.init.redirect === 'error')).toBe(true);
	});

	it('ships a test payment adapter with verified webhooks', async () => {
		const ok = createTestGateway({ descriptor: { credentials: { mode: 'succeed', webhookSecret: 'w' } } });
		expect(await ok.createPayment({ amount: 1, currency: 'EUR', reference: 'r', idempotencyKey: 'k' })).toMatchObject({
			status: 'succeeded',
		});
		expect(await ok.capture({ id: 'p' })).toEqual({ id: 'p', status: 'succeeded' });
		expect(await ok.refund({ id: 'p' })).toEqual({ id: 'p', status: 'refunded' });
		const failing = createTestGateway({ descriptor: { credentials: { mode: 'fail' } } });
		expect((await failing.status({ id: 'p' })).status).toBe('failed');
		const action = createTestGateway({ descriptor: {} });
		expect(await action.createPayment({ amount: 1, currency: 'EUR', reference: 'r', idempotencyKey: 'k' })).not.toHaveProperty(
			'redirectUrl',
		);
		const raw = JSON.stringify({ paymentId: 'p', status: 'succeeded' });
		const sig = createHmac('sha256', 'w').update(raw).digest('hex');
		expect(await ok.verifyWebhook({ headers: { 'x-test-signature': sig }, rawBody: raw })).toEqual({
			ok: true,
			event: { paymentId: 'p', orderId: '', status: 'succeeded' },
		});
		expect((await ok.verifyWebhook({ headers: new Headers({ 'x-test-signature': 'x' }), rawBody: raw })).ok).toBe(false);
		const bad = createHmac('sha256', 'w').update('nope').digest('hex');
		expect((await ok.verifyWebhook({ headers: { 'x-test-signature': bad }, rawBody: 'nope' })).ok).toBe(false);
		expect((await action.verifyWebhook({ headers: {}, rawBody: raw })).ok).toBe(false);
	});

	it('keeps the site registry and runs the sweep job per website', async () => {
		/** @type {any[]} */
		const writes = [];
		const collection = {
			updateOne: async (/** @type {any} */ f) => {
				writes.push(f);
				if (f._id === 'web_fail') throw new Error('down');
			},
			find: () => ({ toArray: async () => [{ _id: 'web_db' }] }),
		};
		const registry = createSiteRegistry({ collection });
		await registry.remember('web_a');
		await registry.remember('web_a');
		await registry.remember('web_fail');
		expect(await registry.list()).toEqual(['web_a', 'web_db']);
		expect(await createSiteRegistry().list()).toEqual([]);
		/** @type {string[]} */
		const errors = [];
		const job = await runSweepJob({
			websiteIds: ['a', 'b', 'c'],
			siteFor: async (id) => (id === 'b' ? null : id),
			tasks: { expired: async (site) => (site === 'c' ? Promise.reject(new Error('x')) : 0) },
			onError: (id) => errors.push(id),
		});
		expect(job).toEqual({
			websites: 2,
			results: [
				{ websiteId: 'a', expired: 0 },
				{ websiteId: 'c', error: 'failed' },
			],
		});
		expect(errors).toEqual(['c']);
		// background runs: small pages, stopped by the page budget or the deadline
		/** @type {number[]} */
		const pages = [];
		const full = async (/** @type {string} */ _site, /** @type {{ limit: number }} */ { limit }) => {
			pages.push(limit);
			return limit;
		};
		expect(await drain(full, 'a', { deadline: 10, now: () => 0, limit: 5, pages: 3 })).toBe(15);
		expect(await drain(full, 'a', { deadline: 10, now: () => 10 })).toBe(0);
		expect(await drain(async () => 2, 'a', { deadline: 10, now: () => 0 })).toBe(2);
		expect(pages).toEqual([5, 5, 5]);
		expect(cronAuthorized('Bearer abc', 'abc')).toBe(true);
		expect(cronAuthorized('Bearer abd', 'abc')).toBe(false);
		expect(cronAuthorized(null, 'abc')).toBe(false);
		expect(isTransactionUnsupported({ codeName: 'IllegalOperation' })).toBe(true);
		expect(isTransactionUnsupported({ message: 'Transaction numbers are only allowed on a replica set member' })).toBe(true);
		expect(isTransactionUnsupported(new Error('other'))).toBe(false);
		expect(strip(null)).toBeNull();
	});
});
