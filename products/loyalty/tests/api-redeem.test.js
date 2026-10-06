/**
 * Redemption (quote / redeem / release / confirm), wallet tokens and the wallet view, adjustments (audited),
 * referrals (attribution, rewards, fraud caps), expiry (FIFO, notices, on read and on demand) and tier reviews, the dashboard API and
 * data export / anonymisation — through app-kit's request handler with a real MongoDB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@ss/contracts';
import { demoDashboard, resolveDashboard } from '../api/dashboard.js';
import { createHarness, MERCHANT, WEBSITE } from './harness.js';

const DAY = 24 * 3_600_000;
const ORIGIN = { origin: 'https://shop.example.com' };

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
beforeAll(async () => {
	h = await createHarness({
		config: {
			redeem: { min_points: 10, max_share_percent: 50 },
			referrals: { min_order_amount: 1000, max_rewards_per_month: 1 },
			expiry: { months: 6, notice_days: 30 },
			tiers: {
				tiers: [
					{ key: 'member', name: 'Member', threshold: 0, multiplier: 1 },
					{ key: 'vip', name: 'VIP', threshold: 400, multiplier: 1 },
				],
				window_months: 1,
				downgrade: 'end_of_period',
			},
		},
	});
});
afterAll(async () => h?.close());

const earn = (/** @type {any} */ customerId, /** @type {any} */ points) =>
	h.call('POST', '/v1/earnings', { body: { customerId, points } });
const balance = async (/** @type {any} */ customerId) => (await h.call('GET', `/v1/members/${customerId}/balance`)).json.balance;

describe('redemption at checkout', () => {
	it('quotes, redeems idempotently, releases once (points back into their lots) and confirms', async () => {
		await earn('cus_red', 300);
		const quote = await h.call('POST', '/v1/redemptions:quote', {
			body: { customerId: 'cus_red', amount: 400, currency: 'USD' },
			idempotencyKey: null,
		});
		expect(quote.json).toMatchObject({ allowed: true, maxPoints: 200, maxValue: 200, capValue: 200, minPoints: 10 });
		const body = { customerId: 'cus_red', points: 150, amount: 400, currency: 'USD', reference: 'cart_1' };
		const redeemed = await h.call('POST', '/v1/redemptions', { body, idempotencyKey: 'redeem-1' });
		expect(redeemed.status).toBe(201);
		expect(redeemed.json).toMatchObject({
			status: 'applied',
			points: 150,
			valueAmount: 150,
			balanceAfter: 150,
			reference: 'cart_1',
		});
		expect((await h.call('POST', '/v1/redemptions', { body, idempotencyKey: 'redeem-1' })).json).toEqual(redeemed.json);
		expect((await h.call('POST', '/v1/redemptions', { body, idempotencyKey: 'redeem-2' })).json.id).toBe(redeemed.json.id); // same reference
		expect(await balance('cus_red')).toBe(150);
		expect(h.published('loyalty.redeemed@1').find((e) => e.data.redemptionId === redeemed.json.id)?.data).toMatchObject({
			points: 150,
			valueAmount: 150,
			currency: 'USD',
		});
		const id = redeemed.json.id;
		expect((await h.call('GET', `/v1/redemptions/${id}`)).json.status).toBe('applied');
		const released = await h.call('POST', `/v1/redemptions/${id}/release`);
		expect(released.json).toMatchObject({ status: 'released' });
		expect((await h.call('POST', `/v1/redemptions/${id}/release`)).json.status).toBe('released');
		expect(await balance('cus_red')).toBe(300);
		const member = await h.collection('members').findOne({ websiteId: WEBSITE, customerId: 'cus_red' });
		expect(member?.lots).toHaveLength(1); // restored into the original lot, original date
		expect((await h.call('POST', `/v1/redemptions/${id}/confirm`, { body: { orderId: 'ord_x' } })).status).toBe(409);
		expect((await h.call('GET', '/v1/redemptions/red_missing')).status).toBe(404);
		expect((await h.call('POST', '/v1/redemptions/red_missing/release')).status).toBe(404);
		expect((await h.call('POST', '/v1/redemptions/red_missing/confirm', { body: { orderId: 'o' } })).status).toBe(404);
	});

	it('refuses redemptions outside the bounds with stable problem codes', async () => {
		await earn('cus_bounds', 100);
		const code = async (/** @type {any} */ body) =>
			(await h.call('POST', '/v1/redemptions', { body: { customerId: 'cus_bounds', currency: 'USD', ...body } })).json.type
				.split('/')
				.pop();
		expect(await code({ points: 5, amount: 1000 })).toBe('below_minimum');
		expect(await code({ points: 90, amount: 100 })).toBe('above_maximum');
		expect(await code({ points: 150, amount: 10_000 })).toBe('insufficient_points');
		expect(await code({ points: 10, amount: 0 })).toBe('amount_required');
		await h.entitle({ config: { redeem: { min_points: 10, allow_with_offers: false } } });
		expect(await code({ points: 10, amount: 1000, discount: 100 })).toBe('offers_not_allowed');
		await h.entitle();
		expect((await h.call('POST', '/v1/redemptions', { body: { customerId: 'cus_bounds' } })).status).toBe(422);
		expect(
			(await h.call('POST', '/v1/redemptions:quote', { body: { customerId: 'cus_bounds' }, idempotencyKey: null })).status,
		).toBe(422);
		await h.entitle({ elements: { redeem: false } });
		expect(
			(
				await h.call('POST', '/v1/redemptions:quote', {
					body: { customerId: 'cus_bounds', amount: 1, currency: 'USD' },
					idempotencyKey: null,
				})
			).status,
		).toBe(403);
		await h.entitle();
	});

	it('gives redeemed points back when the order is cancelled (once, even with a later release)', async () => {
		const { orderId } = await h.order({ customerId: 'cus_cancel', total: 20_000 }); // 200 points
		const redemption = (
			await h.call('POST', '/v1/redemptions', {
				body: { customerId: 'cus_cancel', points: 50, amount: 1000, currency: 'USD' },
			})
		).json;
		expect((await h.call('POST', `/v1/redemptions/${redemption.id}/confirm`, { body: { orderId } })).json.orderId).toBe(
			orderId,
		);
		expect((await h.call('POST', `/v1/redemptions/${redemption.id}/confirm`, { body: { orderId: 'other' } })).status).toBe(409);
		await h.deliver('order.cancelled@1', { orderId });
		expect((await h.call('GET', `/v1/redemptions/${redemption.id}`)).json.status).toBe('refunded');
		expect((await h.call('POST', `/v1/redemptions/${redemption.id}/release`)).status).toBe(409);
		expect(await balance('cus_cancel')).toBe(0); // 200 − 50 + 50 − 200
	});
});

describe('wallet', () => {
	it('mints wallet tokens (sk_) and serves the wallet to pk_ + SS-Identity', async () => {
		await earn('cus_wallet', 420);
		const issued = await h.call('POST', '/v1/wallet-tokens', { body: { customerId: 'cus_wallet' } });
		expect(issued.status).toBe(201);
		expect(issued.json.expiresAt).toBe(new Date(h.clock.now() + 60 * 60_000).toISOString());
		const wallet = await h.call('GET', '/v1/wallet?limit=1', {
			key: h.pk,
			headers: { ...ORIGIN, 'ss-identity': issued.json.token },
		});
		expect(wallet.status).toBe(200);
		expect(wallet.json).toMatchObject({
			customerId: 'cus_wallet',
			balance: 420,
			tier: { key: 'vip' },
			display: { showHistory: true },
			history: { items: [{ points: 420 }] },
		});
		expect((await h.call('GET', '/v1/wallet', { key: h.pk, headers: ORIGIN })).json.type).toMatch(/identity_required$/);
		expect(
			(await h.call('GET', '/v1/wallet', { key: h.pk, headers: { ...ORIGIN, 'ss-identity': `${issued.json.token}x` } }))
				.status,
		).toBe(401);
		expect((await h.call('GET', '/v1/wallet?customerId=cus_wallet')).json.balance).toBe(420);
		expect((await h.call('GET', '/v1/wallet')).status).toBe(422);
		expect((await h.call('GET', '/v1/wallet?customerId=cus_unknown')).json).toMatchObject({
			balance: 0,
			history: { items: [] },
		});
		expect(
			(await h.call('POST', '/v1/wallet-tokens', { body: { customerId: 'cus_wallet' }, key: h.pk, headers: ORIGIN })).status,
		).toBe(403);
		expect((await h.call('POST', '/v1/wallet-tokens', { body: {} })).status).toBe(422);
		await h.entitle({ config: { wallet: { show_history: false } } });
		expect((await h.call('GET', '/v1/wallet?customerId=cus_wallet')).json.history.items).toEqual([]);
		await h.entitle();
	});
});

describe('adjustments', () => {
	it('credits and debits with reasons, audited in the merchant database', async () => {
		const credit = await h.call('POST', '/v1/adjustments', {
			body: { customerId: 'cus_adj', points: 40, reason: 'goodwill', note: 'late delivery' },
		});
		expect(credit.json).toMatchObject({ kind: 'adjust', points: 40, reason: 'goodwill', note: 'late delivery' });
		expect(
			(
				await h.call('POST', '/v1/adjustments', {
					body: { customerId: 'cus_adj', points: -50, reason: 'correction', note: 'x' },
				})
			).json.type,
		).toMatch(/insufficient_points$/);
		expect(
			(await h.call('POST', '/v1/adjustments', { body: { customerId: 'cus_adj', points: 5, reason: 'bribe', note: 'x' } }))
				.status,
		).toBe(422);
		expect(
			(await h.call('POST', '/v1/adjustments', { body: { customerId: 'cus_adj', points: 5, reason: 'goodwill' } })).status,
		).toBe(422);
		const list = await h.call('GET', '/v1/adjustments?customerId=cus_adj');
		expect(list.json.items).toHaveLength(1);
		const audit = await h.db
			.collection('ss_loyalty_audit')
			.find({ websiteId: WEBSITE, action: 'loyalty.adjustment' })
			.toArray();
		expect(audit.some((entry) => entry.target?.customerId === 'cus_adj')).toBe(true);
	});
});

describe('referrals', () => {
	it('creates one code per member, attributes referees and rewards both sides on the first qualifying order', async () => {
		const code = (await h.call('POST', '/v1/referral-codes', { body: { customerId: 'cus_referrer' } })).json.code;
		expect(code).toMatch(/^REF[A-Z2-9]{8}$/);
		expect((await h.call('POST', '/v1/referral-codes', { body: { customerId: 'cus_referrer' } })).json.code).toBe(code);
		const attributed = await h.call('POST', '/v1/referrals', { body: { code: code.toLowerCase(), customerId: 'cus_friend' } });
		expect(attributed.status).toBe(201);
		expect(attributed.json).toMatchObject({ status: 'pending', referrerId: 'cus_referrer' });
		const reason = async (/** @type {any} */ body) => {
			const response = await h.call('POST', '/v1/referrals', { body });
			return response.json.type?.split('/').pop() ?? `${response.status} ${JSON.stringify(response.json)}`;
		};
		expect(await reason({ code, customerId: 'cus_friend' })).toBe('already_referred');
		expect(await reason({ code, customerId: 'cus_referrer' })).toBe('self_referral');
		expect(await reason({ code: 'REFNOPE1234', customerId: 'cus_x' })).toBe('unknown_code');
		await h.order({ customerId: 'cus_friend', total: 500 }); // below the minimum: still pending
		expect((await h.call('GET', '/v1/referrals/cus_friend')).json.status).toBe('pending');
		await h.order({ customerId: 'cus_friend', total: 2000 });
		expect((await h.call('GET', '/v1/referrals/cus_friend')).json).toMatchObject({ status: 'rewarded' });
		expect(await balance('cus_friend')).toBe(5 + 20 + 250);
		expect(await balance('cus_referrer')).toBe(500);
		// a second referee in the same month hits the referrer's monthly fraud cap (1): referee only
		await h.deliver('customer.created@1', { customerId: 'cus_friend2', source: `referral:${code}` });
		expect((await h.call('GET', '/v1/referrals/cus_friend2')).json.status).toBe('pending');
		await h.order({ customerId: 'cus_friend2', total: 3000 });
		expect((await h.call('GET', '/v1/referrals/cus_friend2')).json).toMatchObject({
			status: 'capped',
			reason: 'referrer_cap_reached',
		});
		expect(await balance('cus_referrer')).toBe(500);
		expect(await balance('cus_friend2')).toBe(30 + 250);
		expect(await reason({ code, customerId: 'cus_friend2' })).toBe('already_referred');
		// customers with orders cannot be referred
		expect(await reason({ code, customerId: 'cus_cancel' })).toBe('not_a_new_customer');
		expect((await h.call('GET', '/v1/referrals/cus_nobody')).status).toBe(404);
		expect((await h.call('POST', '/v1/referrals', { body: { code: '?', customerId: 'c' } })).status).toBe(422);
		expect((await h.call('POST', '/v1/referral-codes', { body: { customerId: '' } })).status).toBe(422);
	});

	it('expires referrals outside the attribution window', async () => {
		const code = (await h.call('POST', '/v1/referral-codes', { body: { customerId: 'cus_slow' } })).json.code;
		await h.call('POST', '/v1/referrals', { body: { code, customerId: 'cus_late' } });
		h.clock.advance(31 * DAY);
		await h.entitle();
		await h.order({ customerId: 'cus_late', total: 5000 });
		expect((await h.call('GET', '/v1/referrals/cus_late')).json).toMatchObject({
			status: 'expired',
			reason: 'attribution_expired',
		});
		expect(await balance('cus_slow')).toBe(0);
	});

	it('is refused when the element is off', async () => {
		await h.entitle({ elements: { referrals: false } });
		expect((await h.call('POST', '/v1/referral-codes', { body: { customerId: 'cus_referrer' } })).status).toBe(403);
		await h.deliver('customer.created@1', { customerId: 'cus_ref_off', source: 'referral:REFXXXXXXXX' });
		await h.entitle();
		expect((await h.call('GET', '/v1/referrals/cus_ref_off')).status).toBe(404);
	});
});

describe('expiry and tier reviews', () => {
	it('expires FIFO lots, notices once per expiry day, and reviews tiers (POST /v1/expiry:run, and on read)', async () => {
		await earn('cus_exp', 500); // vip (window 1 month)
		h.clock.advance(20 * DAY);
		await h.entitle();
		await earn('cus_exp', 50);
		h.clock.advance(140 * DAY); // first lot expires in ~20 days → notice
		await h.entitle();
		const noticeRun = await h.call('POST', '/v1/expiry:run');
		expect(noticeRun.json.notices).toBeGreaterThanOrEqual(1);
		expect(await balance('cus_exp')).toBe(550);
		expect((await h.call('POST', '/v1/expiry:run')).json).toMatchObject({ expired: 0, notices: 0 });
		const notice = h.published('loyalty.expiring@1').find((event) => event.data.customerId === 'cus_exp');
		expect(notice?.data).toMatchObject({ points: 500, balance: 550 });
		h.clock.advance(30 * DAY);
		await h.entitle();
		expect(await balance('cus_exp')).toBe(50);
		const member = (await h.call('GET', '/v1/members/cus_exp')).json;
		expect(member.tier).toMatchObject({ key: 'member' }); // review date passed and the window metric dropped: on read
		const history = (await h.call('GET', '/v1/members/cus_exp/history')).json.items;
		expect(history[0]).toMatchObject({ kind: 'expire', points: -500 });
		expect((await h.call('POST', '/v1/expiry:run')).status).toBe(200); // other members' lapsed points
		expect((await h.call('POST', '/v1/expiry:run')).json.expired).toBe(0);
	});
});

describe('dashboard (SSO)', () => {
	const launch = async (/** @type {any} */ kind, extra = {}) => {
		const { token } = await h.portal.issueLaunch({
			kind,
			subject: 'usr_merchant',
			user: { id: 'usr_merchant' },
			scope: kind === 'demo' ? {} : { merchantId: MERCHANT, websiteId: WEBSITE },
			...extra,
		});
		const sso = await h.handle(new Request(`https://loyalty.example.com/sso?launch=${encodeURIComponent(token)}`));
		const session = /ss_session=(ses_[^;]+)/.exec(sso.headers.get('set-cookie') ?? '')?.[1];
		if (!session) throw new Error(`no session (${sso.status})`);
		return session;
	};

	it('serves overview KPIs and audited adjustments to merchant sessions, read-only to demo', async () => {
		const session = await launch('merchant');
		const bearer = { key: session };
		const overview = await h.call('GET', '/v1/dashboard/overview', bearer);
		expect(overview.status).toBe(200);
		expect(overview.json.members).toBeGreaterThan(5);
		const adjusted = await h.call('POST', '/v1/dashboard/adjustments', {
			...bearer,
			body: { customerId: 'cus_dash', points: 15, reason: 'goodwill', note: 'from the dashboard' },
		});
		expect(adjusted.status).toBe(201);
		const audit = await h.db.collection('ss_loyalty_audit').findOne({ websiteId: WEBSITE, 'target.customerId': 'cus_dash' });
		expect(audit?.actor).toMatchObject({ type: 'merchant', id: 'usr_merchant' });
		expect((await h.call('POST', '/v1/dashboard/adjustments', { ...bearer, body: { customerId: 'cus_dash' } })).status).toBe(
			422,
		);
		expect(
			(
				await h.call('POST', '/v1/dashboard/rules:check', {
					...bearer,
					body: { source: 'order.total >' },
					idempotencyKey: null,
				})
			).json.ok,
		).toBe(false);
		expect((await h.call('POST', '/v1/dashboard/rules:check', { ...bearer, body: {}, idempotencyKey: null })).status).toBe(422);
		const demo = await launch('demo');
		expect(
			(
				await h.call('POST', '/v1/dashboard/adjustments', {
					key: demo,
					body: { customerId: 'cus_dash', points: 1, reason: 'goodwill', note: 'n' },
				})
			).status,
		).toBe(403);
		expect((await h.call('GET', '/v1/session', { key: session })).json).toMatchObject({ kind: 'merchant', role: 'merchant' });
	});

	it('resolves what the pages show for every session state', async () => {
		const loyalty = h.loyalty;
		expect(await resolveDashboard({ loyalty, sessionId: null })).toEqual({ state: 'signin' });
		expect(await resolveDashboard({ loyalty, sessionId: 'ses_unknown' })).toEqual({ state: 'signin' });
		const live = await resolveDashboard({ loyalty, sessionId: await launch('merchant') });
		expect(live.state).toBe('ready');
		if (live.state !== 'ready') throw new Error('not ready');
		expect(live.portalLink).toBe(`https://portal.test/websites/${WEBSITE}/subscriptions/sub_0123456789abcdefghjkmnpq`);
		expect(live.data).toMatchObject({ demo: false, canWrite: true, websiteId: WEBSITE });
		expect((await live.data.overview()).members).toBeGreaterThan(0);
		expect((await live.data.members({ q: 'cus_dash' })).map((m) => m.customerId)).toEqual(['cus_dash']);
		expect((await live.data.member('cus_dash'))?.history[0]).toMatchObject({ kind: 'adjust', points: 15 });
		expect(await live.data.member('cus_none')).toBeNull();
		const admin = await launch('admin', { scope: { merchantId: MERCHANT }, actor: 'stf_1' });
		expect((await resolveDashboard({ loyalty, sessionId: admin })).state).toBe('pick_website');
		await h.entitle({ elements: { earn_rules: false } });
		expect((await resolveDashboard({ loyalty, sessionId: await launch('merchant') })).state).toBe('not_subscribed');
		await h.entitle();
		const demo = await resolveDashboard({ loyalty, sessionId: await launch('demo') });
		expect(demo.state === 'ready' && demo.data.demo).toBe(true);
	});

	it('builds sandbox data with the real core for demo launches', async () => {
		const demo = demoDashboard({ now: h.clock.now() });
		expect(demo).toMatchObject({ demo: true, canWrite: false, websiteId: null });
		const overview = await demo.overview();
		expect(overview.members).toBe(4);
		expect(overview.outstandingPoints).toBeGreaterThan(0);
		expect((await demo.members({ q: 'cus_demo_a' })).map((m) => m.customerId)).toEqual(['cus_demo_ava']);
		expect((await demo.members({})).length).toBe(4);
		expect((await demo.member('cus_demo_chloe'))?.member.tier?.key).toBe('gold');
		expect(await demo.member('nobody')).toBeNull();
	});

	it('runs the website expiry from the dashboard button (merchant only)', async () => {
		await earn('cus_btn_exp', 70);
		h.clock.advance(200 * DAY);
		await h.entitle();
		const session = await launch('merchant');
		const run = await h.call('POST', '/v1/dashboard/expiry:run', { key: session, idempotencyKey: null });
		expect(run.status).toBe(200);
		expect(run.json.expired).toBeGreaterThanOrEqual(70);
		expect((await h.collection('members').findOne({ customerId: 'cus_btn_exp' }))?.balance).toBe(0);
		expect((await h.call('POST', '/v1/dashboard/expiry:run', { key: await launch('demo'), idempotencyKey: null })).status).toBe(
			403,
		);
		const admin = await launch('admin', { scope: { merchantId: MERCHANT }, actor: 'stf_2' });
		expect((await h.call('POST', '/v1/dashboard/expiry:run', { key: admin, idempotencyKey: null })).status).toBe(400);
	});
});

describe('data export and anonymisation (Portal-signed)', () => {
	it('exports a subject and anonymises their personal fields', async () => {
		const rawBody = JSON.stringify({ websiteId: WEBSITE, subject: { customerId: 'cus_adj' }, requestId: createId('req') });
		for (const operation of ['export', 'anonymize']) {
			const signed = await h.portal.signRequest({ method: 'POST', path: `/v1/data:${operation}`, body: rawBody });
			const response = await h.handle(
				new Request(`https://loyalty.example.com/v1/data:${operation}`, {
					method: 'POST',
					headers: { ...signed.headers, 'idempotency-key': createId('idk') },
					body: rawBody,
				}),
			);
			expect(response.status).toBe(200);
		}
		const tx = await h.collection('transactions').findOne({ websiteId: WEBSITE, customerId: 'cus_adj', kind: 'adjust' });
		expect(tx?.note).toBeNull();
	});
});
