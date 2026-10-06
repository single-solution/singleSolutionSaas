/**
 * Free-tier hosting model (one daily cron): points past their expiry are never shown or spendable, whether or not a job
 * ran (expire on read, booked on access), and the throttled per-website expiry run registered with
 * `product.background.every` books them after requests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPIRY_EVERY_MS, expireWebsite } from '../api/routes.js';
import { memberAsOf } from '../core/views.js';
import { createHarness, T0, WEBSITE } from './harness.js';

const DAY = 24 * 3_600_000;

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
beforeAll(async () => {
	h = await createHarness({ config: { redeem: { min_points: 10, max_share_percent: 50 }, expiry: { months: 6 } } });
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
		expect(history.map((/** @type {any} */ tx) => [tx.kind, tx.points])).toEqual([
			['earn', 40],
			['expire', -300],
			['earn', 300],
		]);
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

describe('background expiry', () => {
	it('is registered per website and books lapsed points when triggered (throttled)', async () => {
		await earn('cus_bg', 120);
		await later(200 * DAY);
		expect(h.loyalty.tasks.expiry.name).toBe('expiry');
		expect(await h.loyalty.tasks.expiry.trigger({ websiteId: WEBSITE })).toBe(true);
		expect((await stored('cus_bg'))?.balance).toBe(0);
		expect(await h.loyalty.tasks.expiry.trigger({ websiteId: WEBSITE })).toBe(false);
		h.clock.advance(EXPIRY_EVERY_MS);
		expect(await h.loyalty.tasks.expiry.trigger({ websiteId: WEBSITE })).toBe(true);
	});

	it('does nothing without a website and stops at its deadline', async () => {
		expect(await expireWebsite(h.loyalty, { websiteId: null, deadline: Infinity })).toBeNull();
		await earn('cus_deadline', 50);
		await later(200 * DAY);
		const stats = await expireWebsite(h.loyalty, { websiteId: WEBSITE, deadline: 0 });
		expect(stats).toMatchObject({ expired: 50 });
		expect((await stored('cus_deadline'))?.balance).toBe(0);
	});
});
