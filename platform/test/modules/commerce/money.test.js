import { describe, expect, it } from 'vitest';
import {
	DAY_MS,
	HOUR_MS,
	OPEN_PHASE,
	billingStateOf,
	creditsText,
	dayCharges,
	dayOf,
	daysLeftOf,
	floorDay,
	floorMonth,
	instantText,
	isLowBalance,
	merchantStatusOf,
	productStatusOf,
	replay,
	usageRows,
} from '../../../src/modules/commerce/core/money.js';

/** 2026-10-01T00:00:00Z */
const D0 = Date.UTC(2026, 9, 1);
const H = HOUR_MS;
const M = 60_000;
const W1 = 'web_1';
const W2 = 'web_2';
const A = 'coupons';

/** @param {number} at @param {Record<string, number>} prices */
const prices = (at, prices) => ({
	type: /** @type {const} */ ('prices'),
	at,
	productId: A,
	features: Object.entries(prices).map(([key, price]) => ({ key, name: key.toUpperCase(), price })),
});
/** @param {number} at @param {string} [websiteId] */
const added = (at, websiteId = W1) => ({ type: /** @type {const} */ ('added'), at, websiteId, productId: A });
/** @param {number} at @param {string} [websiteId] */
const removed = (at, websiteId = W1) => ({ type: /** @type {const} */ ('removed'), at, websiteId, productId: A });
/** @param {number} at @param {string[]} on @param {string} [websiteId] */
const switches = (at, on, websiteId = W1) => ({ type: /** @type {const} */ ('switches'), at, websiteId, productId: A, on });
/** @param {number} at @param {number} amount */
const receipt = (at, amount) => ({ type: /** @type {const} */ ('receipt'), at, amount });

/** @param {Partial<Parameters<typeof replay>[0]>} input */
const run = (input) =>
	replay({ from: D0, to: D0, balance: 0, events: [], graceDays: 3, ...input, phase: input.phase ?? OPEN_PHASE });

/** @param {ReturnType<typeof replay>} out */
const hours = (out) =>
	out.charges.map((c) => `${new Date(c.at).toISOString().slice(11, 16)} ${c.websiteId} ${c.feature} ${c.amount}`);

describe('money function: charging (PLAN 0.5.3)', () => {
	it('charges each switched-on feature once per clock hour, from the first instant, at the price then', () => {
		const out = run({
			to: D0 + 2 * H + 30 * M,
			balance: 100_000,
			events: [
				prices(0, { codes: 1000, box: 500 }),
				added(D0),
				switches(D0, ['codes']),
				switches(D0 + 20 * M, ['codes', 'box']),
			],
		});
		expect(hours(out)).toEqual([
			'00:00 web_1 codes 1000',
			'00:20 web_1 box 500',
			'01:00 web_1 box 500',
			'01:00 web_1 codes 1000',
			'02:00 web_1 box 500',
			'02:00 web_1 codes 1000',
		]);
		expect(out.balance).toBe(100_000 - 4500); // the current hour is in the balance at once
		expect(out.dailySpend).toBe(24 * 1500);
		expect(out.products).toEqual([{ websiteId: W1, productId: A, added: true, on: ['box', 'codes'], hourlyCost: 1500 }]);
	});

	it('never gives back a started hour and never charges it twice; the same feature on two websites is charged twice', () => {
		const out = run({
			to: D0 + H + 10 * M,
			balance: 100_000,
			events: [
				prices(0, { codes: 1000 }),
				added(D0),
				added(D0, W2),
				switches(D0 + 5 * M, ['codes']),
				switches(D0 + 5 * M, ['codes'], W2),
				switches(D0 + 10 * M, []),
				switches(D0 + 20 * M, ['codes']),
				removed(D0 + 30 * M, W2),
			],
		});
		expect(hours(out)).toEqual(['00:05 web_1 codes 1000', '00:05 web_2 codes 1000', '01:00 web_1 codes 1000']);
	});

	it('applies a price change to later hours and to features first switched on after it in the current hour', () => {
		const out = run({
			to: D0 + H,
			balance: 100_000,
			events: [
				prices(0, { codes: 1000, box: 500 }),
				added(D0),
				switches(D0, ['codes']),
				prices(D0 + 10 * M, { codes: 3000, box: 700 }),
				switches(D0 + 15 * M, ['codes', 'box']),
			],
		});
		expect(hours(out)).toEqual([
			'00:00 web_1 codes 1000',
			'00:15 web_1 box 700',
			'01:00 web_1 box 700',
			'01:00 web_1 codes 3000',
		]);
	});

	it('re-adding a removed product resets its switches; reports for a product never added change nothing', () => {
		const out = run({
			to: D0 + 3 * H,
			balance: 100_000,
			events: [
				prices(0, { codes: 1000 }),
				switches(0, ['codes'], W2),
				added(D0),
				switches(D0, ['codes']),
				removed(D0 + 30 * M),
				added(D0 + 2 * H + 30 * M),
			],
		});
		expect(hours(out)).toEqual(['00:00 web_1 codes 1000']);
		expect(out.products[0]).toMatchObject({ added: true, on: [], hourlyCost: 0 });
		expect(out.dailySpend).toBe(0);
	});

	it('charges nothing while suspended; a resume mid-hour charges that hour once', () => {
		const out = run({
			to: D0 + 2 * H + 45 * M,
			balance: 100_000,
			events: [
				prices(0, { codes: 1000 }),
				added(D0),
				switches(D0, ['codes']),
				{ type: 'suspended', at: D0 + 10 * M },
				{ type: 'resumed', at: D0 + 40 * M },
				{ type: 'suspended', at: D0 + H + 5 * M },
				{ type: 'resumed', at: D0 + 2 * H + 30 * M },
			],
		});
		expect(hours(out)).toEqual(['00:00 web_1 codes 1000', '01:00 web_1 codes 1000', '02:30 web_1 codes 1000']);
		expect(out.suspended).toBe(false);
	});

	it('rebuilds the state from events before `from` without charging them or counting their receipts', () => {
		const out = run({
			from: D0 + DAY_MS,
			to: D0 + DAY_MS,
			balance: 5000,
			events: [prices(0, { codes: 1000 }), added(D0), switches(D0, ['codes']), receipt(D0, 99_999)],
		});
		expect(hours(out)).toEqual(['00:00 web_1 codes 1000']);
		expect(out.balance).toBe(4000);
	});
});

describe('money function: grace, debt and stop (PLAN 0.5.6)', () => {
	const base = [prices(0, { codes: 1000 }), added(D0), switches(D0, ['codes'])];

	it('starts grace when the balance reaches 0 with spend, keeps charging (debt), and stops at the end', () => {
		const out = run({ to: D0 + 3 * DAY_MS + 2 * H, balance: 2000, events: base });
		const graceStart = D0 + H;
		const graceEnd = graceStart + 3 * DAY_MS;
		expect(out.transitions).toEqual([
			{ type: 'grace_started', at: graceStart, graceEnd },
			{ type: 'stopped', at: graceEnd },
		]);
		// hours 00:00 .. the hour before the end are charged: 3 days + 1 hour
		expect(out.charges).toHaveLength(3 * 24 + 1);
		expect(out.balance).toBe(2000 - (3 * 24 + 1) * 1000);
		expect(out.phase).toEqual({ graceStart: null, graceEnd: null, stoppedAt: graceEnd });
	});

	it('does not charge an hour starting at the end; a mid-hour end keeps the started hour', () => {
		const out = run({
			to: D0 + 4 * H,
			balance: 1000,
			graceDays: 0,
			events: [prices(0, { codes: 1000 }), added(D0 + 30 * M), switches(D0 + 30 * M, ['codes'])],
		});
		expect(out.transitions).toEqual([
			{ type: 'grace_started', at: D0 + 30 * M, graceEnd: D0 + 30 * M },
			{ type: 'stopped', at: D0 + 30 * M },
		]);
		expect(hours(out)).toEqual(['00:30 web_1 codes 1000']);
	});

	it('a receipt above 0 ends grace or a stop at once; one that leaves it ≤ 0 keeps the original end', () => {
		const graceEnd = D0 + H + 3 * DAY_MS;
		const inGrace = run({ to: D0 + 5 * H, balance: 2000, events: [...base, receipt(D0 + 2 * H + 10 * M, 1500)] });
		// -1000 + 1500 = 500 at 02:10 ends grace; the 03:00 charge brings it to -500: a new grace period
		expect(inGrace.transitions).toEqual([
			{ type: 'grace_started', at: D0 + H, graceEnd },
			{ type: 'restored', at: D0 + 2 * H + 10 * M },
			{ type: 'grace_started', at: D0 + 3 * H, graceEnd: D0 + 3 * H + 3 * DAY_MS },
		]);
		const small = run({ to: D0 + 5 * H, balance: 2000, events: [...base, receipt(D0 + 2 * H + 10 * M, 500)] });
		expect(small.transitions).toEqual([{ type: 'grace_started', at: D0 + H, graceEnd }]);
		const stopped = run({
			to: D0 + 3 * DAY_MS + 5 * H,
			balance: 2000,
			events: [...base, receipt(D0 + 3 * DAY_MS + 3 * H + 30 * M, 200_000)],
		});
		expect(stopped.transitions.map((t) => t.type)).toEqual(['grace_started', 'stopped', 'restored']);
		// the stopped hours are free; the restore instant charges its hour
		expect(stopped.charges.filter((c) => c.at >= graceEnd).map((c) => new Date(c.at).toISOString())).toEqual([
			new Date(D0 + 3 * DAY_MS + 3 * H + 30 * M).toISOString(),
			new Date(D0 + 3 * DAY_MS + 4 * H).toISOString(),
			new Date(D0 + 3 * DAY_MS + 5 * H).toISOString(),
		]);
		expect(stopped.phase).toEqual(OPEN_PHASE);
	});

	it('spend falling to 0 neither ends grace nor restarts a stop; a switch-on while stopped restarts nothing', () => {
		const out = run({
			to: D0 + 4 * DAY_MS,
			balance: 1000,
			events: [...base, switches(D0 + 2 * H, []), switches(D0 + 3 * DAY_MS + 5 * H, ['codes'])],
		});
		expect(out.transitions.map((t) => t.type)).toEqual(['grace_started', 'stopped']);
		expect(out.phase.stoppedAt).toBe(D0 + 3 * DAY_MS);
		expect(out.charges).toHaveLength(2);
	});

	it('a new grace period starts only after the balance was above 0; the stored end of a grace period is kept', () => {
		const out = run({
			to: D0 + 10 * H,
			balance: 0,
			graceDays: 1,
			graceEnds: { [String(D0)]: D0 + 2 * H },
			events: [...base, receipt(D0 + 5 * H, 3500)],
		});
		expect(out.transitions).toEqual([
			{ type: 'grace_started', at: D0, graceEnd: D0 + 2 * H },
			{ type: 'stopped', at: D0 + 2 * H },
			{ type: 'restored', at: D0 + 5 * H },
			{ type: 'grace_started', at: D0 + 6 * H, graceEnd: D0 + 6 * H + DAY_MS },
		]);
	});

	it('does not start grace while suspended (it starts on resume); suspension does not pause a running grace', () => {
		const out = run({
			to: D0 + 2 * DAY_MS,
			balance: 0,
			graceDays: 1,
			events: [
				prices(0, { codes: 1000 }),
				added(D0),
				{ type: 'suspended', at: D0 },
				switches(D0, ['codes']),
				{ type: 'resumed', at: D0 + 3 * H },
			],
		});
		expect(out.transitions[0]).toEqual({ type: 'grace_started', at: D0 + 3 * H, graceEnd: D0 + 3 * H + DAY_MS });
		const running = run({
			to: D0 + 2 * DAY_MS,
			balance: 0,
			graceDays: 1,
			events: [...base, { type: 'suspended', at: D0 + H }],
		});
		expect(running.transitions.map((t) => t.type)).toEqual(['grace_started', 'stopped']);
		expect(running.phase.stoppedAt).toBe(D0 + DAY_MS);
	});

	it('continues from a stored phase and snapshots the state just before the cut', () => {
		const out = run({
			from: D0,
			to: D0 + DAY_MS + 2 * H,
			cut: D0 + DAY_MS,
			balance: -5000,
			phase: { graceStart: D0 - H, graceEnd: D0 + DAY_MS + H, stoppedAt: null },
			events: [prices(0, { codes: 1000 }), added(0), switches(0, ['codes'])],
		});
		expect(out.snapshot).toEqual({
			balance: -5000 - 24 * 1000,
			phase: { graceStart: D0 - H, graceEnd: D0 + DAY_MS + H, stoppedAt: null },
		});
		expect(out.phase.stoppedAt).toBe(D0 + DAY_MS + H);
		const late = run({ from: D0, to: D0 - 1, cut: D0 + H, balance: 7 });
		expect(late.snapshot).toEqual({ balance: 7, phase: OPEN_PHASE });
	});
});

describe('statuses, low balance and days left (PLAN 0.5.4, 0.5.5)', () => {
	it('orders merchant and product statuses', () => {
		const phase = { ...OPEN_PHASE };
		expect(billingStateOf({ phase: { ...phase, stoppedAt: 1 }, balance: 5, dailySpend: 1, lowBalanceDays: 3 })).toBe('stopped');
		expect(billingStateOf({ phase: { ...phase, graceEnd: 1 }, balance: -5, dailySpend: 1, lowBalanceDays: 3 })).toBe('grace');
		expect(billingStateOf({ phase, balance: 2, dailySpend: 1, lowBalanceDays: 3 })).toBe('low_balance');
		expect(billingStateOf({ phase, balance: 3, dailySpend: 1, lowBalanceDays: 3 })).toBe('active');
		expect(merchantStatusOf({ suspended: true, billingState: 'stopped' })).toBe('suspended');
		expect(merchantStatusOf({ suspended: false, billingState: 'grace' })).toBe('grace');
		expect(productStatusOf({ added: false, merchantStatus: 'suspended' })).toBe('removed');
		expect(productStatusOf({ added: true, merchantStatus: 'low_balance' })).toBe('active');
		expect(productStatusOf({ added: true, merchantStatus: 'stopped' })).toBe('stopped');
	});

	it('low balance needs spend and a positive balance under the threshold (exact values); days left round down', () => {
		expect(isLowBalance({ balance: 1, dailySpend: 0, lowBalanceDays: 3 })).toBe(false);
		expect(isLowBalance({ balance: 0, dailySpend: 10, lowBalanceDays: 3 })).toBe(false);
		expect(isLowBalance({ balance: 29, dailySpend: 10, lowBalanceDays: 3 })).toBe(true);
		expect(isLowBalance({ balance: 30, dailySpend: 10, lowBalanceDays: 3 })).toBe(false);
		expect(daysLeftOf({ balance: 29, dailySpend: 10 })).toBe(2);
		expect(daysLeftOf({ balance: 9, dailySpend: 10 })).toBe(0);
		expect(daysLeftOf({ balance: -9, dailySpend: 10 })).toBe(0);
		expect(daysLeftOf({ balance: 9, dailySpend: 0 })).toBeNull();
	});
});

describe('usage rows, day charges and texts (PLAN 0.5.7, 0.5.11)', () => {
	it('groups charges per day × website × product × feature and leaves out days with 0 credits', () => {
		const out = run({
			to: D0 + DAY_MS + H,
			balance: 1_000_000,
			events: [
				prices(0, { codes: 1000, free: 0 }),
				added(D0 + 22 * H),
				switches(D0 + 22 * H, ['codes', 'free']),
				added(D0, W2),
				switches(D0, ['free'], W2),
			],
		});
		expect(usageRows(out.charges).filter((r) => r.day === '2026-10-01')).toEqual([
			{ day: '2026-10-01', websiteId: W1, productId: A, feature: 'codes', hours: 2, amount: 2000 },
			{ day: '2026-10-01', websiteId: W1, productId: A, feature: 'free', hours: 2, amount: 0 },
			{ day: '2026-10-01', websiteId: W2, productId: A, feature: 'free', hours: 24, amount: 0 },
		]);
		expect(dayCharges(out.charges.filter((c) => c.hour < D0 + DAY_MS))).toEqual([
			{
				day: '2026-10-01',
				websiteId: W1,
				productId: A,
				amount: 2000,
				lines: [
					{ feature: 'codes', hours: 2, amount: 2000 },
					{ feature: 'free', hours: 2, amount: 0 },
				],
			},
		]);
	});

	it('formats days, months, credits and instants', () => {
		expect(dayOf(D0 + 5 * H)).toBe('2026-10-01');
		expect(floorDay(D0 + 5 * H)).toBe(D0);
		expect(floorMonth(D0 + 9 * DAY_MS)).toBe(D0);
		expect(creditsText(1000)).toBe('1 credit');
		expect(creditsText(-12_345)).toBe('-12.345 credits');
		expect(creditsText(2500)).toBe('2.5 credits');
		expect(instantText(D0 + 14 * H + 30 * M)).toBe('2026-10-01 14:30 UTC');
	});
});
