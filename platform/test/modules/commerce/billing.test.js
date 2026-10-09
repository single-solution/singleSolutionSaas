import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeMongoClients } from '../../../src/infra/db.js';
import { T0, createClock, startMongo } from '../../helpers.js';
import { HOUR, M1, M2, PRODUCT, PRODUCT2, STAFF, W1, W2, bootCommerce } from './fixtures.js';

// Mongo-backed tests share the machine with other suites: allow for slow replica-set start-up and I/O.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
beforeAll(async () => {
	mongo = await startMongo();
}, 120_000);
afterAll(async () => {
	await closeMongoClients();
	await mongo?.stop();
});

const MIN = 60_000;
const DAY = 24 * HOUR;

/**
 * Codes 1 credit/h and Box 0.5 credit/h on PRODUCT; W1 added with Codes on.
 * @param {Awaited<ReturnType<typeof bootCommerce>>} h
 */
const setUp = async (h) => {
	await h.prices(PRODUCT, 1, { codes: 1000, box: 500 });
	await h.service.recordProductAdded({ merchantId: M1, websiteId: W1, productId: PRODUCT });
	await h.service.recordSwitches({ merchantId: M1, websiteId: W1, productId: PRODUCT, on: ['codes'] });
};

describe('credits and billing (PLAN 0.5)', () => {
	it('charges hours from the histories, writes day charges once, shows usage and warns on low balance', async () => {
		const clock = createClock(T0); // 10:00
		const h = await bootCommerce({ mongo, dbName: 'cm_bill_usage', clock });
		await h.credit(M1, 90_000);
		await setUp(h);
		clock.set(T0 + 30 * MIN);
		await h.service.recordSwitches({ merchantId: M1, websiteId: W1, productId: PRODUCT, on: ['codes', 'box'] });
		// a renamed feature keeps its last name; a removed one keeps the name from the last list that had it
		clock.set(T0 + 14 * HOUR); // next day 00:00
		await h.service.recordPriceList({
			productId: PRODUCT,
			prices: {
				version: 2,
				features: [{ key: 'codes', name: 'Coupon codes', description: 'Codes.', dependsOn: [], millicreditsPerHour: 1000 }],
			},
		});
		clock.set(T0 + 14 * HOUR + 30 * MIN);
		const summary = await h.service.billingSummary(M1);
		// day 1: codes 14 h, box 14 h (from 10:30) = 21 credits; today: codes 1 credit (box is no longer priced)
		expect(summary).toMatchObject({
			status: 'low_balance',
			balance: 90_000 - 21_000 - 1000,
			dailySpend: 24_000,
			daysLeft: 2,
			lowBalance: true,
			graceEnd: null,
			stoppedAt: null,
			spentThisMonth: 22_000,
			products: [
				{
					websiteId: W1,
					productId: PRODUCT,
					status: 'active',
					featuresOn: ['box', 'codes'],
					hourlyCost: 1000,
					dailyCost: 24_000,
				},
			],
		});
		expect(h.mails.filter((m) => m.template === 'low_balance').map((m) => m.to)).toEqual([
			`owner@${M1}.example`,
			'finance@portal.example',
		]);
		expect(h.mails.find((m) => m.template === 'low_balance')?.data).toMatchObject({
			balance: '68 credits',
			daysLeft: '2 days',
		});
		// a second check writes nothing new and sends no second e-mail
		await h.service.check(M1);
		const days = await h.db.collection('commerce_ledger').find({ merchantId: M1, type: 'day_charge' }).toArray();
		expect(days).toMatchObject([
			{
				day: '2026-10-01',
				amount: -21_000,
				entryKey: `day:${W1}:${PRODUCT}:2026-10-01`,
				details: {
					lines: [
						{ feature: 'box', hours: 14, amount: 7000 },
						{ feature: 'codes', hours: 14, amount: 14_000 },
					],
				},
			},
		]);
		expect(h.mails.filter((m) => m.template === 'low_balance')).toHaveLength(2);

		const usage = await h.service.usage(M1, { from: '2026-10-01', to: '2026-10-02' });
		expect(usage.total).toBe(22_000);
		expect(usage.days).toEqual([
			{ day: '2026-10-01', amount: 21_000 },
			{ day: '2026-10-02', amount: 1000 },
		]);
		expect(usage.rows.map((r) => `${r.day} ${r.domain} ${r.product} ${r.featureName} ${r.hours} ${r.amount}`)).toEqual([
			'2026-10-01 shop.example.com Ecommerce Apply box 14 7000',
			'2026-10-01 shop.example.com Ecommerce Coupon codes 14 14000',
			'2026-10-02 shop.example.com Ecommerce Apply box 1 0',
			'2026-10-02 shop.example.com Ecommerce Coupon codes 1 1000',
		]);
		expect((await h.service.usage(M1, { from: '2026-09-01', to: '2026-09-02', websiteId: W2 })).rows).toEqual([]);
		expect(await h.service.dayChargesOf(M1)).toMatchObject([
			{ day: '2026-10-01', domain: 'shop.example.com', credits: 21_000 },
		]);

		// Credits and billing lists
		expect(await h.service.charges({ from: '2026-10-01', to: '2026-10-31', by: 'day' })).toMatchObject({
			rows: [{ key: '2026-10-01', label: '2026-10-01', credits: 21_000 }],
		});
		expect((await h.service.charges({ from: '2026-10-01', to: '2026-10-31', by: 'merchant' })).rows).toEqual([
			{ key: M1, label: 'One', credits: 21_000 },
		]);
		expect((await h.service.charges({ from: '2026-10-01', to: '2026-10-31', by: 'product' })).rows).toEqual([
			{ key: PRODUCT, label: 'Ecommerce', credits: 21_000 },
		]);
		expect(await h.service.attention()).toMatchObject([{ merchantId: M1, merchantName: 'One', status: 'low_balance' }]);
		expect(await h.service.allReceipts({ from: '2026-10-01', to: '2026-10-02', merchantId: M1 })).toMatchObject([
			{ merchantId: M1, merchantName: 'One', credits: 90_000, amountPaid: 'PKR 1,000' },
		]);
		expect(await h.service.billingSummaries([M2])).toMatchObject([{ merchantId: M2, status: 'active', balance: 0 }]);
	});

	it('runs grace, debt and stop, and restarts only when a receipt brings the balance above 0', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_bill_grace', clock });
		await h.credit(M1, 2000);
		await setUp(h);
		clock.set(T0 + HOUR + 30 * MIN); // 11:30: 10:00 and 11:00 charged → 0 at 11:00 → grace for 3 days
		const grace = await h.service.billingSummary(M1);
		expect(grace).toMatchObject({ status: 'grace', balance: 0, graceEnd: '2026-10-04T11:00:00.000Z', daysLeft: 0 });
		expect(grace.products[0]?.status).toBe('grace');
		const graceMail = h.mails.find((m) => m.template === 'grace_started');
		expect(graceMail?.data.stopAt).toBe('2026-10-04 11:00 UTC');
		// a Settings change applies only to grace periods that start later
		h.ctx.config.settings.billing.graceDays = 1;
		clock.set(T0 + 3 * DAY + 2 * HOUR); // 12:00, three days later
		const stopped = await h.service.billingSummary(M1);
		expect(stopped).toMatchObject({ status: 'stopped', stoppedAt: '2026-10-04T11:00:00.000Z', balance: 2000 - 73_000 });
		expect(stopped.products[0]?.status).toBe('stopped');
		expect(h.mails.filter((m) => m.template === 'products_stopped')).toHaveLength(2);
		// a receipt that leaves the balance ≤ 0 changes nothing
		await h.credit(M1, 50_000);
		expect((await h.service.billingSummary(M1)).status).toBe('stopped');
		expect(h.mails.filter((m) => m.template === 'credits_added').map((m) => m.to)).toEqual([
			`owner@${M1}.example`,
			`owner@${M1}.example`,
		]);
		// one that brings it above 0 restarts at once (the debt is paid first)
		clock.set(T0 + 3 * DAY + 2 * HOUR + 15 * MIN);
		const { summary } = await h.credit(M1, 100_000);
		expect(summary).toMatchObject({
			status: 'active',
			balance: 2000 - 73_000 + 150_000 - 1000,
			graceEnd: null,
			stoppedAt: null,
		});
		const history = await h.db
			.collection('commerce_history')
			.find({ merchantId: M1, key: { $type: 'string' } })
			.sort({ at: 1 })
			.toArray();
		expect(history.map((e) => e.kind)).toEqual(['grace_started', 'stopped']);
		expect(await h.service.verifyChain(M1)).toMatchObject({ ok: true });
		h.ctx.config.settings.billing.graceDays = 3;
	});

	it('charges nothing while suspended or removed, and never for a product never added', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_bill_status', clock });
		await h.credit(M1, 100_000);
		await setUp(h);
		await h.service.recordSwitches({ merchantId: M1, websiteId: W2, productId: PRODUCT2, on: ['bar'] });
		clock.set(T0 + 10 * MIN);
		await h.service.onMerchantStatus({ merchantId: M1, status: 'suspended' });
		h.world.merchants.set(M1, { .../** @type {any} */ (h.world.merchants.get(M1)), status: 'suspended' });
		clock.set(T0 + 5 * HOUR + 30 * MIN);
		const suspended = await h.service.billingSummary(M1);
		expect(suspended).toMatchObject({ status: 'suspended', balance: 99_000 });
		expect(suspended.products[0]?.status).toBe('suspended');
		await h.service.onMerchantStatus({ merchantId: M1, status: 'active' }); // 15:30: hour 15 charged
		h.world.merchants.set(M1, { .../** @type {any} */ (h.world.merchants.get(M1)), status: 'active' });
		clock.set(T0 + 5 * HOUR + 40 * MIN);
		await h.service.recordProductRemoved({ merchantId: M1, websiteId: W1, productId: PRODUCT });
		clock.set(T0 + 9 * HOUR);
		const removed = await h.service.billingSummary(M1);
		expect(removed).toMatchObject({ status: 'active', balance: 98_000, dailySpend: 0, daysLeft: null, products: [] });
		await expect(
			h.service.recordPriceList({ productId: PRODUCT, prices: { version: 3, features: [{ key: 'Bad', name: 'x' }] } }),
		).rejects.toMatchObject({
			code: 'validation_failed',
		});
		await expect(
			h.service.recordSwitches({ merchantId: M1, websiteId: W1, productId: PRODUCT, on: ['Bad key'] }),
		).rejects.toMatchObject({
			code: 'validation_failed',
		});
		await expect(
			h.service.addReceipt({
				merchantId: 'mer_zzzzzzzzzzzzzzzzzzzzzzzzzz',
				amount: 1000,
				amountPaid: 'x',
				method: 'y',
				reference: null,
				actor: STAFF,
			}),
		).rejects.toMatchObject({ code: 'not_found' });
	});
});
