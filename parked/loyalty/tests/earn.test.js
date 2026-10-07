import { describe, expect, it } from 'vitest';
import {
	capToPeriod,
	evaluateEarn,
	formulaPoints,
	lineTotal,
	orderFacts,
	readPath,
	roundPoints,
	triggerMatches,
} from '../core/earn.js';
import { checkCondition, compileCondition, conditionMatches, RULE_ROOTS } from '../core/rules.js';

const now = Date.parse('2026-10-01T10:00:00Z');
const order = {
	orderId: 'ord_1',
	customerId: 'cus_1',
	currency: 'USD',
	lines: [
		{ itemId: 'itm_a', sku: 'A', quantity: 2, unitAmount: 2500 },
		{ itemId: 'itm_gift', sku: 'GIFT', quantity: 1, unitAmount: 5000, totalAmount: 5000 },
	],
	amounts: { subtotal: 10000, discount: 1000, shipping: 500, tax: 800, total: 10300 },
};
const percent = (overrides = {}) => ({
	id: 'purchase',
	trigger: 'order.completed@1',
	when: '',
	formula: { kind: 'percent', percent: 1 },
	...overrides,
});
const run = (/** @type {any} */ rules, extra = {}) =>
	evaluateEarn({
		rules,
		type: 'order.completed@1',
		context: {
			event: { type: 'order.completed@1', data: {} },
			customer: { id: 'cus_1', orders: 0 },
			tier: { key: null, multiplier: 1 },
		},
		now,
		timeZone: 'UTC',
		orderFactsFor: (rule) => orderFacts(order, rule.exclusions),
		...extra,
	});

describe('order facts and exclusions', () => {
	it('computes line totals and eligible amounts', () => {
		expect(lineTotal({ quantity: 3, unitAmount: 100 })).toBe(300);
		expect(lineTotal({ quantity: 3, unitAmount: 100, totalAmount: 250 })).toBe(250);
		const all = orderFacts(order);
		expect(all).toMatchObject({ total: 10300, subtotal: 10000, units: 3, eligibleUnits: 3, eligibleAmount: 9000 });
		const excluded = orderFacts(order, { skus: ['GIFT'] });
		// half the merchandise is excluded → half the discount is subtracted
		expect(excluded).toMatchObject({ eligibleAmount: 4500, eligibleUnits: 2 });
		expect(
			orderFacts(order, { item_ids: ['itm_gift'], subtract_discounts: false, include_shipping: true, include_tax: true })
				.eligibleAmount,
		).toBe(6300);
		expect(excluded.lines.map((line) => line.excluded)).toEqual([false, true]);
	});

	it('falls back to the subtotal for orders without lines', () => {
		expect(orderFacts({ orderId: 'o', amounts: { subtotal: 4000, total: 4200, discount: 500 } })).toMatchObject({
			eligibleAmount: 3500,
			units: 0,
		});
		expect(orderFacts({ orderId: 'o' })).toMatchObject({ eligibleAmount: 0, total: 0 });
	});

	it('reads context paths safely', () => {
		expect(readPath({ a: { b: 2 } }, 'a.b')).toBe(2);
		expect(readPath({ a: null }, 'a.b')).toBeNull();
		expect(readPath({ a: { b: 2 } }, 'a.toString')).toBeNull();
	});
});

describe('formulas, rounding and triggers', () => {
	it('fixed, percent (ibrahimMobiles pointsEarnedFor) and per unit', () => {
		const context = { order: orderFacts(order), event: { data: { value: 1999 } } };
		expect(formulaPoints({ kind: 'fixed', points: 50 }, context)).toBe(50);
		expect(formulaPoints({ kind: 'fixed', points: -5 }, context)).toBe(0);
		expect(formulaPoints({ kind: 'percent', percent: 1 }, context)).toBe(90);
		expect(formulaPoints({ kind: 'percent', percent: 2.5, field: 'event.data.value' }, context)).toBeCloseTo(49.975);
		expect(formulaPoints({ kind: 'percent', percent: 5, field: 'event.data.missing' }, context)).toBe(0);
		expect(formulaPoints({ kind: 'per_unit', points: 10, per: 2 }, context)).toBe(10);
		expect(formulaPoints({ kind: 'per_unit', points: 10 }, context)).toBe(30);
		expect(formulaPoints({ kind: 'per_unit', points: 10, field: 'event.data.none' }, context)).toBe(0);
		// ported cases: floor so partial points are never granted
		const pts = (/** @type {any} */ amount, /** @type {any} */ rate) =>
			roundPoints(formulaPoints({ kind: 'percent', percent: rate, field: 'v' }, { v: amount }), 'floor');
		expect(pts(10_000, 1)).toBe(100);
		expect(pts(199, 1)).toBe(1);
		expect(pts(99, 1)).toBe(0);
		expect(pts(1_050, 2.5)).toBe(26);
		expect(pts(0, 5)).toBe(0);
		expect(pts(-500, 5)).toBe(0);
		expect(pts(10_000, -2)).toBe(0);
	});

	it('rounds after multipliers, tolerating float noise', () => {
		expect(roundPoints(26.25, 'floor')).toBe(26);
		expect(roundPoints(26.5, 'round')).toBe(27);
		expect(roundPoints(26.01, 'ceil')).toBe(27);
		expect(roundPoints(0.1 * 3 * 10, 'floor')).toBe(3);
		expect(roundPoints(Number.NaN, 'ceil')).toBe(0);
	});

	it('matches triggers with or without a version', () => {
		expect(triggerMatches('order.completed@1', 'order.completed@1')).toBe(true);
		expect(triggerMatches('order.completed@2', 'order.completed@1')).toBe(false);
		expect(triggerMatches('custom.review', 'custom.review@3')).toBe(true);
	});

	it('caps to a period allowance', () => {
		expect(capToPeriod(50, { cap: 0, used: 1000 })).toBe(50);
		expect(capToPeriod(50, { cap: 100, used: 80 })).toBe(20);
		expect(capToPeriod(50, { cap: 100, used: 120 })).toBe(0);
	});
});

describe('evaluateEarn', () => {
	it('adds the points of every matching rule, applies the tier multiplier and reports cap usage', () => {
		const result = run(
			[
				percent(),
				{ id: 'bonus', trigger: 'order.completed@1', formula: { kind: 'fixed', points: 10 }, apply_tier_multiplier: false },
			],
			{
				multiplier: 1.5,
			},
		);
		expect(result.earnings).toEqual([
			{ ruleId: 'purchase', base: 90, points: 135, capped: false },
			{ ruleId: 'bonus', base: 10, points: 10, capped: false },
		]);
		expect(result.total).toBe(145);
		expect(result.usage).toEqual({ purchase: { key: '2026-10', points: 135 }, bonus: { key: '2026-10', points: 10 } });
	});

	it('skips disabled rules, other triggers and failing conditions (errors never match)', () => {
		const result = run([
			percent({ enabled: false }),
			percent({ id: 'placed', trigger: 'order.placed@1' }),
			percent({ id: 'big', when: 'order.total >= 20000' }),
			percent({ id: 'broken', when: 'order.total >=' }),
			percent({ id: 'first', when: 'customer.orders == 0 and order.currency == "USD"' }),
		]);
		expect(result.earnings.map((e) => e.ruleId)).toEqual(['first']);
		expect(result.diagnostics.map((d) => d.ruleId)).toEqual(['broken']);
	});

	it('caps per event, per period (across calls) and by the per-transaction maximum', () => {
		const capped = run([percent({ caps: { per_event: 50 } })]);
		expect(capped.earnings[0]).toMatchObject({ points: 50, capped: true });
		const periodRule = percent({ caps: { per_period: 120, period: 'month' } });
		const first = run([periodRule]);
		expect(first.total).toBe(90);
		const second = run([periodRule], { usage: first.usage });
		expect(second.earnings[0]).toMatchObject({ points: 30, capped: true });
		const third = run([periodRule], { usage: second.usage });
		expect(third.total).toBe(0);
		expect(third.earnings).toEqual([{ ruleId: 'purchase', base: 90, points: 0, capped: true }]);
		// a new month resets the allowance
		const nextMonth = run([periodRule], { usage: second.usage, now: Date.parse('2026-11-01T00:00:00Z') });
		expect(nextMonth.total).toBe(90);
		expect(run([percent(), percent({ id: 'again' })], { maxPoints: 100 }).earnings.map((e) => e.points)).toEqual([90, 10]);
	});

	it('resets day caps on the website’s local midnight', () => {
		const dayRule = percent({ caps: { per_period: 100, period: 'day' } });
		const evening = Date.parse('2026-10-01T18:30:00Z'); // 23:30 in Karachi
		const first = run([dayRule], { now: evening, timeZone: 'Asia/Karachi' });
		const sameUtcDay = run([dayRule], {
			usage: first.usage,
			now: Date.parse('2026-10-01T19:30:00Z'),
			timeZone: 'Asia/Karachi',
		});
		expect(sameUtcDay.total).toBe(90); // already 2 Oct in Karachi → a fresh allowance
		const utc = run([dayRule], { usage: run([dayRule], { now: evening }).usage, now: Date.parse('2026-10-01T19:30:00Z') });
		expect(utc.total).toBe(10); // still 1 Oct in UTC
	});

	it('works without an order (custom events) and with rounding modes', () => {
		const result = evaluateEarn({
			rules: [
				{
					id: 'review',
					trigger: 'custom.review_written@1',
					when: 'event.data.rating >= 4',
					formula: { kind: 'percent', percent: 33, field: 'event.data.words' },
				},
			],
			type: 'custom.review_written@1',
			context: { event: { type: 'custom.review_written@1', data: { rating: 5, words: 10 } } },
			now,
			timeZone: 'UTC',
			rounding: 'ceil',
		});
		expect(result.total).toBe(4);
	});
});

describe('rules@1 conditions', () => {
	it('compiles once, checks with positions and roots, and evaluates in the zone', () => {
		expect(compileCondition('')).toEqual({ ok: true, program: null });
		expect(compileCondition(undefined)).toEqual({ ok: true, program: null });
		const first = compileCondition('order.total > 1');
		expect(compileCondition('order.total > 1')).toBe(first);
		const checked = checkCondition('order.total >= 5000 and shopper.vip');
		expect(checked.ok).toBe(true);
		expect(checked.warnings[0]).toMatchObject({ code: 'unknown_identifier' });
		expect(checked.paths).toEqual(['order.total', 'shopper.vip']);
		expect(checkCondition('order.total >=').errors[0]).toMatchObject({ line: 1 });
		expect(checkCondition('   ')).toMatchObject({ ok: true, paths: [] });
		expect(RULE_ROOTS).toContain('order');
		expect(
			conditionMatches(
				"between(now, '09:00', '17:00')",
				{},
				{ now: Date.parse('2026-10-01T05:00:00Z'), timeZone: 'Asia/Karachi' },
			).matched,
		).toBe(true);
		expect(
			conditionMatches("between(now, '09:00', '17:00')", {}, { now: Date.parse('2026-10-01T05:00:00Z'), timeZone: 'UTC' })
				.matched,
		).toBe(false);
		// an evaluation error never matches
		expect(conditionMatches('order.total > 1', { order: { total: 5 } }, { now: 0, timeZone: 'Mars/Olympus' })).toEqual({
			matched: false,
			error: 'invalid_option',
		});
	});

	it('keeps a bounded cache', () => {
		for (let i = 0; i < 510; i += 1) compileCondition(`order.total > ${i}`);
		expect(compileCondition('order.total > 509').ok).toBe(true);
	});
});
