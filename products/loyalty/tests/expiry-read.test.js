/**
 * No timers: points past their expiry are never shown or spendable (expire on read, booked on access), and a member's
 * due tier review and expiry notice happen when a request reads that member. Nothing is registered to run later.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memberAsOf } from '../core/views.js';
import { createHarness, T0, WEBSITE } from './harness.js';

const DAY = 24 * 3_600_000;

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
beforeAll(async () => {
	h = await createHarness({
		config: {
			redeem: { min_points: 10, max_share_percent: 50 },
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

const earn = (/** @type {string} */ customerId, /** @type {number} */ points) =>
	h.call('POST', '/v1/earnings', { body: { customerId, points } });
/** @param {string} customerId */
const stored = async (customerId) => h.collection('members').findOne({ customerId });
/** @param {number} ms */
const later = async (ms) => {
	h.clock.advance(ms);
	await h.entitle();
};

describe('expire on read', () => {
	it('expires lapsed lots before any other movement of the member', async () => {
		await earn('cus_lapse', 300);
		await later(200 * DAY);
		expect((await stored('cus_lapse'))?.balance).toBe(300);
		await earn('cus_lapse', 40);
		expect((await stored('cus_lapse'))?.balance).toBe(40);
		const history = (await h.call('GET', '/v1/members/cus_lapse/history')).json.items;
		// the expiry and the new earning share a timestamp (listed in id order); the balances show which came first
		expect(history.map((/** @type {any} */ tx) => [tx.kind, tx.points, tx.balanceAfter])).toEqual(
			expect.arrayContaining([
				['expire', -300, 0],
				['earn', 40, 40],
			]),
		);
		expect(history.at(-1)).toMatchObject({ kind: 'earn', points: 300 });
		expect(history).toHaveLength(3);
	});

	it('refuses to spend lapsed points and books the expiry on access', async () => {
		await earn('cus_spend', 300);
		await later(200 * DAY);
		expect((await stored('cus_spend'))?.balance).toBe(300);
		const listed = (await h.call('GET', '/v1/members?q=cus_spend')).json.items;
		expect(listed[0].balance).toBe(0);
		expect((await stored('cus_spend'))?.balance).toBe(300);
		const quote = await h.call('POST', '/v1/redemptions:quote', {
			body: { customerId: 'cus_spend', amount: 1000, currency: 'USD' },
			idempotencyKey: null,
		});
		expect(quote.json).toMatchObject({ allowed: false, maxPoints: 0 });
		expect((await stored('cus_spend'))?.balance).toBe(0);
		const spend = await h.call('POST', '/v1/redemptions', {
			body: { customerId: 'cus_spend', points: 100, amount: 1000, currency: 'USD' },
		});
		expect(spend.status).toBeGreaterThanOrEqual(400);
		const history = (await h.call('GET', '/v1/members/cus_spend/history')).json.items;
		expect(history[0]).toMatchObject({ kind: 'expire', points: -300 });
		expect(history.filter((/** @type {any} */ tx) => tx.kind === 'expire')).toHaveLength(1);
	});

	it('keeps a member unchanged without an expiry policy or lapsed lots', () => {
		const member = /** @type {any} */ ({
			customerId: 'c',
			balance: 5,
			debt: 0,
			lots: [{ id: 'l', points: 5, remaining: 5, earnedAt: new Date(T0).toISOString() }],
		});
		expect(memberAsOf(member, { now: T0 })).toBe(member);
		expect(memberAsOf(member, { now: T0, expiry: { months: 6 } })).toBe(member);
		expect(memberAsOf(member, { now: T0 + 400 * DAY, expiry: { months: 6 } })).toMatchObject({ balance: 0, lots: [] });
	});
});

describe('due work happens on read, for that member only', () => {
	const notices = (/** @type {string} */ customerId) =>
		h.published('loyalty.expiring@1').filter((/** @type {any} */ event) => event.data.customerId === customerId);

	it('publishes the expiry notice once when the member is read inside the notice window', async () => {
		await earn('cus_notice', 80);
		await earn('cus_other', 80);
		await later(160 * DAY); // expires in ~20 days, inside the 30-day notice window
		expect(notices('cus_notice')).toHaveLength(0);
		await h.call('GET', '/v1/members/cus_notice');
		await h.call('GET', '/v1/members/cus_notice');
		expect(notices('cus_notice')).toHaveLength(1);
		expect(notices('cus_notice')[0]?.data).toMatchObject({ points: 80, balance: 80 });
		expect(notices('cus_other')).toHaveLength(0); // nobody else is scanned
		expect((await stored('cus_notice'))?.lots[0]?.noticeFor).toBe(notices('cus_notice')[0]?.data.expiresOn);
	});

	it('applies a due tier review when the member is read', async () => {
		await earn('cus_tier', 500);
		expect((await stored('cus_tier'))?.tier?.key).toBe('vip');
		await later(40 * DAY); // review date passed, the 1-month window metric dropped
		expect((await stored('cus_tier'))?.tier?.key).toBe('vip');
		const member = (await h.call('GET', '/v1/members/cus_tier')).json;
		expect(member.tier).toMatchObject({ key: 'member' });
		expect((await stored('cus_tier'))?.tier?.key).toBe('member');
		expect(h.published('loyalty.tier_changed@1').some((/** @type {any} */ e) => e.data.customerId === 'cus_tier')).toBe(true);
	});

	it('registers no background task', () => {
		expect(h.loyalty.product.background).not.toHaveProperty('every');
		expect(/** @type {any} */ (h.loyalty).tasks).toBeUndefined();
	});

	it('stops a merchant-started run at its deadline (continued by the next run)', async () => {
		await earn('cus_deadline', 50);
		await later(200 * DAY);
		const site = await h.loyalty.siteFor(WEBSITE);
		if (!site) throw new Error('no site');
		const stats = await h.loyalty.service.runExpiry(site, { deadline: 0 });
		expect(stats.expired).toBeGreaterThanOrEqual(50);
		expect((await stored('cus_deadline'))?.balance).toBe(0);
	});
});
