/**
 * Mode C API and event consumption through app-kit's request handler, against the fake Portal and a real MongoDB
 * (MongoMemoryReplSet): earning on orders and custom events, idempotency, caps, tiers, reversal, members, pagination,
 * concurrency and exactly-once repair.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, WEBSITE, WEBSITE_2 } from './harness.js';

const RULES = [
	{
		id: 'purchase',
		name: 'Points on completed orders',
		trigger: 'order.completed@1',
		when: '',
		formula: { kind: 'percent', percent: 1 },
		caps: { per_period: 0, period: 'month' },
		exclusions: { skus: ['GIFT'] },
		apply_tier_multiplier: true,
		enabled: true,
	},
	{ id: 'welcome', trigger: 'customer.created@1', formula: { kind: 'fixed', points: 50 } },
	{
		id: 'first_order',
		trigger: 'order.placed@1',
		when: 'customer.orders == 0 and order.total >= 5000',
		formula: { kind: 'fixed', points: 20 },
		apply_tier_multiplier: false,
	},
	{
		id: 'reviews',
		trigger: 'custom.review_written@1',
		when: 'event.data.rating >= 4',
		formula: { kind: 'fixed', points: 30 },
		caps: { per_period: 60, period: 'day' },
	},
];

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
beforeAll(async () => {
	h = await createHarness({
		config: {
			earn_rules: { rules: RULES, time_zone: 'Asia/Karachi' },
			tiers: {
				tiers: [
					{ key: 'bronze', name: 'Bronze', threshold: 0, multiplier: 1 },
					{ key: 'silver', name: 'Silver', threshold: 300, multiplier: 2 },
				],
				window_months: 12,
				downgrade: 'immediate',
			},
		},
	});
});
afterAll(async () => h?.close());

const balance = async (/** @type {any} */ customerId) => (await h.call('GET', `/v1/members/${customerId}/balance`)).json.balance;

describe('earning from orders (Event Hub deliveries)', () => {
	it('earns on placement (first-order bonus) and completion, exactly once, with exclusions', async () => {
		const { orderId } = await h.order({
			customerId: 'cus_order',
			total: 12_000,
			lines: [
				{ itemId: 'itm_1', sku: 'SKU-1', quantity: 2, unitAmount: 5000 },
				{ itemId: 'itm_gift', sku: 'GIFT', quantity: 1, unitAmount: 2000 },
			],
		});
		// 20 (first order on placement) + 1 % of 10 000 eligible (gift excluded) = 120
		expect(await balance('cus_order')).toBe(120);
		const member = (await h.call('GET', '/v1/members/cus_order')).json;
		expect(member).toMatchObject({ orders: 1, lifetime: { earned: 120, spend: 12_000 }, tier: { key: 'bronze' } });
		// the same deliveries again (Event Hub retries) and a re-signed duplicate change nothing
		await h.deliver('order.completed@1', { orderId });
		await h.deliver('order.placed@1', {
			orderId,
			customerId: 'cus_order',
			currency: 'USD',
			lines: [{ itemId: 'i', quantity: 1, unitAmount: 1 }],
			amounts: { subtotal: 1, total: 1 },
		});
		expect(await balance('cus_order')).toBe(120);
		const history = (await h.call('GET', '/v1/members/cus_order/history')).json;
		expect(
			history.items
				.map((/** @type {any} */ tx) => [tx.kind, tx.points, tx.ruleIds])
				.sort((/** @type {any} */ a, /** @type {any} */ b) => a[1] - b[1]),
		).toEqual([
			['earn', 20, ['first_order']],
			['earn', 100, ['purchase']],
		]);
		const earned = h.published('loyalty.earned@1').filter((event) => event.data.customerId === 'cus_order');
		expect(earned.map((event) => event.data.points)).toEqual([20, 100]);
		expect(earned[0]).toMatchObject({ websiteId: WEBSITE, actor: { type: 'product' } });
	});

	it('handles a completion that arrives before the placement', async () => {
		await h.deliver('order.completed@1', { orderId: 'ord_early' });
		expect((await h.call('GET', '/v1/members/cus_early')).status).toBe(404);
		await h.deliver('order.placed@1', {
			orderId: 'ord_early',
			customerId: 'cus_early',
			currency: 'USD',
			lines: [{ itemId: 'i', quantity: 1, unitAmount: 3000 }],
			amounts: { subtotal: 3000, total: 3000 },
		});
		expect(await balance('cus_early')).toBe(30);
	});

	it('ignores orders without a customer and completions of unknown orders', async () => {
		await h.order({ customerId: undefined });
		const unknown = await h.deliver('order.completed@1', { orderId: 'ord_nobody' });
		expect(unknown.status).toBe(200);
	});

	it('applies the tier multiplier once a member upgrades, and publishes tier changes', async () => {
		await h.order({ customerId: 'cus_tier', total: 30_000 }); // 20 + 300 → silver (threshold 300)
		expect(await balance('cus_tier')).toBe(320);
		const changes = h.published('loyalty.tier_changed@1').filter((event) => event.data.customerId === 'cus_tier');
		expect(changes.map((event) => [event.data.from, event.data.to, event.data.direction])).toEqual([
			[null, 'bronze', 'up'],
			['bronze', 'silver', 'up'],
		]);
		await h.order({ customerId: 'cus_tier', total: 10_000 }); // 1 % × 2 = 200 (no first-order bonus)
		expect(await balance('cus_tier')).toBe(520);
		const tiers = (await h.call('GET', '/v1/tiers')).json;
		expect(tiers.items.map((/** @type {any} */ tier) => tier.key)).toEqual(['bronze', 'silver']);
	});

	it('welcomes new customers once (customer.created@1)', async () => {
		await h.deliver('customer.created@1', { customerId: 'cus_new' });
		await h.deliver('customer.created@1', { customerId: 'cus_new' });
		expect(await balance('cus_new')).toBe(50);
	});
});

describe('reversal', () => {
	it('reverses everything on cancellation, preferring the order’s own lot', async () => {
		const { orderId } = await h.order({ customerId: 'cus_cancel', total: 20_000 });
		expect(await balance('cus_cancel')).toBe(220);
		await h.deliver('order.cancelled@1', { orderId, reason: 'customer request' });
		await h.deliver('order.cancelled@1', { orderId });
		expect(await balance('cus_cancel')).toBe(0);
		const member = (await h.call('GET', '/v1/members/cus_cancel')).json;
		expect(member.lifetime).toMatchObject({ earned: 0, spend: 0 });
	});

	it('reverses partial refunds proportionally and converges on the earned total', async () => {
		const { orderId } = await h.order({ customerId: 'cus_refund', total: 10_000 });
		expect(await balance('cus_refund')).toBe(120);
		await h.deliver('order.refunded@1', { orderId, amount: { amount: 5000, currency: 'USD' } });
		expect(await balance('cus_refund')).toBe(60);
		const second = await h.deliver('order.refunded@1', { orderId, amount: { amount: 5000, currency: 'USD' } });
		await h.deliver('order.refunded@1', { orderId, amount: { amount: 5000, currency: 'USD' } }, { id: second.id });
		expect(await balance('cus_refund')).toBe(0);
		await h.deliver('order.refunded@1', { orderId, amount: { amount: 1000, currency: 'USD' } });
		expect(await balance('cus_refund')).toBe(0);
	});

	it('caps at the balance by default, or goes negative when configured', async () => {
		const spend = async (/** @type {any} */ customerId) => {
			const redeemed = await h.call('POST', '/v1/adjustments', {
				body: { customerId, points: -100, reason: 'correction', note: 'spent' },
			});
			expect(redeemed.status).toBe(201);
		};
		const capped = await h.order({ customerId: 'cus_capped', total: 10_000 });
		await spend('cus_capped');
		await h.deliver('order.cancelled@1', { orderId: capped.orderId });
		expect(await balance('cus_capped')).toBe(0);

		await h.entitle({ config: { reversal: { negative_balance: 'allow_negative' } } });
		const negative = await h.order({ customerId: 'cus_negative', total: 10_000 });
		await spend('cus_negative');
		await h.deliver('order.cancelled@1', { orderId: negative.orderId });
		expect(await balance('cus_negative')).toBe(-100);
		// later earnings repay the debt first
		await h.call('POST', '/v1/earnings', { body: { customerId: 'cus_negative', points: 150 } });
		expect(await balance('cus_negative')).toBe(50);
		await h.entitle();
	});

	it('does nothing when the reversal element is off', async () => {
		await h.entitle({ elements: { reversal: false } });
		const { orderId } = await h.order({ customerId: 'cus_keep', total: 10_000 });
		await h.deliver('order.cancelled@1', { orderId });
		expect(await balance('cus_keep')).toBe(120);
		await h.entitle();
	});
});

describe('manual earns, activities and rules', () => {
	it('POST /v1/earnings refuses a repeated Idempotency-Key, dedupes on reference and is validated', async () => {
		const first = await h.call('POST', '/v1/earnings', {
			body: { customerId: 'cus_api', points: 25, reason: 'welcome' },
			idempotencyKey: 'k-1',
		});
		expect(first.status).toBe(201);
		expect(first.json).toMatchObject({ kind: 'earn', points: 25, balanceAfter: 25, reason: 'welcome' });
		const replay = await h.call('POST', '/v1/earnings', {
			body: { customerId: 'cus_api', points: 25, reason: 'welcome' },
			idempotencyKey: 'k-1',
		});
		expect(replay.status).toBe(409);
		expect(replay.json.type).toMatch(/duplicate_request$/);
		await h.call('POST', '/v1/earnings', { body: { customerId: 'cus_api', points: 10, reference: 'import-7' } });
		const again = await h.call('POST', '/v1/earnings', { body: { customerId: 'cus_api', points: 10, reference: 'import-7' } });
		expect(again.status).toBe(201);
		expect(await balance('cus_api')).toBe(35);
		const invalid = await h.call('POST', '/v1/earnings', { body: { customerId: 'cus api', points: 0 } });
		expect(invalid.status).toBe(422);
		expect(invalid.json.errors.map((/** @type {any} */ e) => e.path)).toEqual(['/customerId', '/points']);
		expect(
			(await h.call('POST', '/v1/earnings', { body: { customerId: 'cus_api', points: 1 }, idempotencyKey: null })).status,
		).toBe(201);
		expect(
			(
				await h.call('POST', '/v1/earnings', {
					body: { customerId: 'cus_api', points: 1 },
					key: h.pk,
					headers: { origin: 'https://shop.example.com' },
				})
			).status,
		).toBe(403);
	});

	it('POST /v1/activities earns from custom events with day caps in the website zone', async () => {
		const review = (/** @type {any} */ id, rating = 5) =>
			h.call('POST', '/v1/activities', {
				body: { id, type: 'custom.review_written@1', customerId: 'cus_reviews', data: { rating } },
			});
		expect((await review('r1')).json).toMatchObject({ earned: 30 });
		expect((await review('r1')).json).toMatchObject({ earned: 30 }); // same id → same transaction
		expect((await review('r2')).json.earned).toBe(30);
		expect((await review('r3')).json).toEqual({ earned: 0, transaction: null }); // cap 60 per local day
		expect((await review('r4', 2)).json.earned).toBe(0);
		h.clock.advance(24 * 3_600_000);
		await h.entitle();
		expect((await review('r5')).json.earned).toBe(30);
		expect(await balance('cus_reviews')).toBe(90);
		expect((await h.call('POST', '/v1/activities', { body: { type: 'order.completed@1', customerId: 'c' } })).status).toBe(422);
	});

	it('lists and checks rules', async () => {
		await h.entitle({
			config: {
				earn_rules: {
					rules: [
						...RULES,
						{ id: 'broken', trigger: 'order.completed@1', when: 'order.total >', formula: { kind: 'fixed', points: 1 } },
					],
					time_zone: 'Asia/Karachi',
				},
			},
		});
		const rules = (await h.call('GET', '/v1/rules')).json;
		expect(rules.timeZone).toBe('Asia/Karachi');
		expect(rules.items.find((/** @type {any} */ rule) => rule.id === 'broken')).toMatchObject({
			valid: false,
			error: { code: 'syntax' },
		});
		const check = await h.call('POST', '/v1/rules:check', {
			body: { source: 'order.total >= 5000 and shopper.vip' },
			idempotencyKey: null,
		});
		expect(check.json).toMatchObject({ ok: true, warnings: [{ code: 'unknown_identifier' }] });
		expect((await h.call('POST', '/v1/rules:check', { body: {}, idempotencyKey: null })).status).toBe(422);
		await h.entitle();
	});
});

describe('members, history and pagination', () => {
	it('lists members by prefix with cursors and pages earnings', async () => {
		for (const id of ['cus_page_a', 'cus_page_b', 'cus_page_c'])
			await h.call('POST', '/v1/earnings', { body: { customerId: id, points: 5 } });
		const first = await h.call('GET', '/v1/members?q=cus_page_&limit=2');
		expect(first.json.items.map((/** @type {any} */ m) => m.customerId)).toEqual(['cus_page_a', 'cus_page_b']);
		expect(first.headers.get('link')).toContain('rel="next"');
		const second = await h.call('GET', `/v1/members?q=cus_page_&limit=2&cursor=${encodeURIComponent(first.json.nextCursor)}`);
		expect(second.json).toMatchObject({ items: [{ customerId: 'cus_page_c' }], hasMore: false });
		const earnings = await h.call('GET', '/v1/earnings?limit=1');
		const next = await h.call('GET', `/v1/earnings?limit=1&cursor=${encodeURIComponent(earnings.json.nextCursor)}`);
		expect(next.json.items[0].id).not.toBe(earnings.json.items[0].id);
		expect((await h.call('GET', '/v1/earnings?customerId=cus_page_a')).json.items).toHaveLength(1);
		expect((await h.call('GET', '/v1/members/cus_nobody')).status).toBe(404);
		expect((await h.call('GET', '/v1/members/cus_nobody/balance')).json).toMatchObject({ balance: 0, tier: null });
	});

	it('pk_ keys see earnings only for the customer of a wallet token', async () => {
		const origin = { origin: 'https://shop.example.com' };
		const anonymous = await h.call('GET', '/v1/earnings', { key: h.pk, headers: origin });
		expect(anonymous.json, JSON.stringify(anonymous.json)).toMatchObject({ items: [] });
		const token = (await h.call('POST', '/v1/wallet-tokens', { body: { customerId: 'cus_page_a' } })).json.token;
		const own = await h.call('GET', '/v1/earnings', { key: h.pk, headers: { ...origin, 'ss-identity': token } });
		expect(own.json.items.map((/** @type {any} */ tx) => tx.customerId)).toEqual(['cus_page_a']);
	});

	it('keeps websites apart in the same merchant database', async () => {
		await h.entitle({ websiteId: WEBSITE_2 });
		const other = await h.key('sk', WEBSITE_2);
		await h.call('POST', '/v1/earnings', { key: other, body: { customerId: 'cus_shared', points: 7 } });
		await h.call('POST', '/v1/earnings', { body: { customerId: 'cus_shared', points: 3 } });
		expect((await h.call('GET', '/v1/members/cus_shared/balance', { key: other })).json.balance).toBe(7);
		expect(await balance('cus_shared')).toBe(3);
		expect(await h.collection('members').countDocuments({ customerId: 'cus_shared' })).toBe(2);
	});
});

describe('consistency', () => {
	it('serialises concurrent movements of one member (optimistic versions)', async () => {
		await h.call('POST', '/v1/earnings', { body: { customerId: 'cus_busy', points: 1 } });
		await Promise.all(
			Array.from({ length: 6 }, (_, i) =>
				h.call('POST', '/v1/earnings', { body: { customerId: 'cus_busy', points: 10 + i } }),
			),
		);
		expect(await balance('cus_busy')).toBe(1 + 10 + 11 + 12 + 13 + 14 + 15);
		const doc = await h.collection('members').findOne({ websiteId: WEBSITE, customerId: 'cus_busy' });
		expect(doc?.version).toBe(7);
		expect(await h.collection('transactions').countDocuments({ websiteId: WEBSITE, customerId: 'cus_busy' })).toBe(7);
	});

	it('repairs a ledger entry lost after the member moved (journal), without moving points twice', async () => {
		const { orderId } = await h.order({ customerId: 'cus_repair', total: 10_000, completed: false });
		const completed = await h.deliver('order.completed@1', { orderId });
		const lost = await h
			.collection('transactions')
			.findOneAndDelete({ websiteId: WEBSITE, customerId: 'cus_repair', 'source.type': 'order.completed@1' });
		expect(lost).not.toBeNull();
		// the Event Hub retries the same delivery: app-kit forgets ids whose handler failed, so simulate the retry with a new id
		await h.deliver('order.completed@1', { orderId }, { id: `${completed.id}x` });
		expect(await balance('cus_repair')).toBe(120);
		expect(await h.collection('transactions').countDocuments({ websiteId: WEBSITE, customerId: 'cus_repair' })).toBe(2);
	});

	it('meters one point_transaction per stored movement (exactly once at the Portal)', async () => {
		const before = h.portal.usage.size;
		await h.call('POST', '/v1/earnings', { body: { customerId: 'cus_meter', points: 5 } });
		await h.loyalty.product.usage.flush();
		await h.loyalty.product.usage.flush();
		expect(h.portal.usage.size).toBeGreaterThan(before);
		const records = [...h.portal.usage.values()].filter((record) => record.unit === 'point_transaction');
		expect(new Set(records.map((record) => record.idempotencyKey)).size).toBe(records.length);
	});

	it('answers 403 for disabled elements and ignores events of websites without the base element', async () => {
		await h.entitle({ elements: { earn_rules: false } });
		expect((await h.call('GET', '/v1/earnings')).status).toBe(403);
		const { orderId } = await h.order({ customerId: 'cus_off', total: 10_000 });
		expect(orderId).toBeTruthy();
		await h.entitle();
		expect((await h.call('GET', '/v1/members/cus_off')).status).toBe(404);
	});
});
