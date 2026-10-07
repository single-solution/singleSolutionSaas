import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { formatMoney, minorDigits } from '../core/money.js';
import { NO_ROUNDING, priceOf, roundPrice } from '../core/pricing.js';
import { resolve } from '../core/resolve.js';
import { SAMPLES } from '../api/samples.js';
import { PHONE, compiled } from './helpers.js';

const phone = compiled(PHONE);

describe('priceOf', () => {
	it('prices a combination with option deltas (no rounding by default)', () => {
		const result = priceOf(phone, {
			selection: { storage: '256', color: 'pink', addons: ['case', 'charger'] },
			combination: { id: 'v3' },
			quantity: 2,
		});
		expect(result).toEqual({
			ok: true,
			price: {
				currency: 'EUR',
				quantity: 2,
				base: 60000,
				deltas: [
					{ kind: 'option', group: 'storage', option: '256', amount: 10000 },
					{ kind: 'option', group: 'addons', option: 'case', amount: 1500 },
					{ kind: 'option', group: 'addons', option: 'charger', amount: 2500 },
				],
				subtotal: 74000,
				unit: 74000,
				total: 148000,
				rounding: NO_ROUNDING,
			},
		});
	});

	it('applies range unit prices, amount and percent rules, rounding and price endings', () => {
		const plan = compiled(SAMPLES[2]);
		const team = priceOf(
			plan,
			{ selection: { plan: 'business', seats: 30, addons: ['sso'] }, combination: null },
			{ currency: 'USD' },
		);
		expect(team.ok && team.price).toMatchObject({
			currency: 'USD',
			base: 0,
			deltas: [
				{ kind: 'option', group: 'plan', option: 'business', amount: 5000 },
				{ kind: 'unit', group: 'seats', amount: 24000 },
				{ kind: 'option', group: 'addons', option: 'sso', amount: 3000 },
				{ kind: 'percent', rule: 'volume', amount: -3200 },
			],
			subtotal: 28800,
			unit: 28800,
		});
		const workstation = compiled(SAMPLES[1]);
		const result = priceOf(workstation, {
			selection: { memory: '32gb', storage: '1tb', extras: ['warranty', 'setup'] },
			combination: null,
		});
		// 89900 + 15000 + 10000 + 9900 + 4900 = 129700; −5 % = 123215; nearest 100 = 123200; ending 99 → 123199
		expect(result.ok && result.price).toMatchObject({
			subtotal: 123215,
			unit: 123199,
			rounding: { mode: 'nearest', increment: 100, ending: 99 },
		});
	});

	it('uses the element rounding when the configurator has none, and clamps at zero', () => {
		const schema = compiled({
			name: 'x',
			groups: [{ key: 'a', options: [{ key: '1', priceDelta: -5000 }, { key: '2' }] }],
			pricing: { base: 1234, rules: [{ id: 'bulk', when: 'quantity >= 10', amount: -100 }] },
		});
		expect(
			priceOf(schema, { selection: { a: '1' }, combination: null }).ok &&
				priceOf(schema, { selection: { a: '1' }, combination: null }),
		).toMatchObject({
			price: { subtotal: -3766, unit: 0, total: 0 },
		});
		const up = priceOf(
			schema,
			{ selection: { a: '2' }, combination: null, quantity: 10 },
			{ rounding: { mode: 'up', increment: 50, ending: 0 } },
		);
		expect(up.ok && up.price).toMatchObject({
			subtotal: 1134,
			unit: 1150,
			total: 11500,
			deltas: [{ kind: 'rule', rule: 'bulk', amount: -100 }],
		});
		const down = priceOf(
			schema,
			{ selection: { a: '2' }, combination: null },
			{ rounding: { mode: 'down', increment: 100, ending: 0 } },
		);
		expect(down.ok && down.price?.unit).toBe(1200);
	});

	it('returns no price for unpriced configurators and refuses amounts beyond safe integers', () => {
		expect(
			priceOf(compiled({ name: 'x', groups: [{ key: 'a', options: [{ key: '1' }] }] }), {
				selection: { a: '1' },
				combination: null,
			}),
		).toEqual({ ok: true, price: null });
		const huge = compiled({
			name: 'x',
			groups: [{ key: 'n', type: 'range', min: 0, max: 1_000_000_000, unitPrice: 10_000_000_000 }],
		});
		expect(priceOf(huge, { selection: { n: 1_000_000_000 }, combination: null })).toEqual({
			ok: false,
			code: 'price_out_of_range',
		});
		expect(priceOf(phone, { selection: {}, combination: { id: 'missing' } })).toMatchObject({ ok: true });
	});

	it('rounds half away from zero for percent rules and keeps every price an integer (property)', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 10_000_000 }),
				fc.integer({ min: -10_000, max: 100_000 }),
				fc.constantFrom('none', 'nearest', 'up', 'down'),
				fc.integer({ min: 1, max: 1000 }),
				fc.integer({ min: 1, max: 50 }),
				(base, percent, mode, increment, quantity) => {
					const schema = compiled({
						name: 'x',
						groups: [{ key: 'a', options: [{ key: '1' }] }],
						pricing: { base, rules: [{ id: 'p', percent }], rounding: { mode, increment } },
					});
					const result = priceOf(schema, { selection: { a: '1' }, combination: null, quantity });
					if (!result.ok || !result.price) throw new Error('priced');
					const { unit, total, subtotal } = result.price;
					expect(Number.isSafeInteger(unit) && Number.isSafeInteger(total)).toBe(true);
					expect(unit).toBeGreaterThanOrEqual(0);
					expect(total).toBe(unit * quantity);
					if (mode !== 'none') expect(unit % increment).toBe(0);
					if (mode === 'up') expect(unit).toBeGreaterThanOrEqual(Math.max(0, subtotal));
					if (mode === 'down') expect(unit).toBeLessThanOrEqual(Math.max(0, subtotal));
					if (mode === 'nearest') expect(Math.abs(unit - Math.max(0, subtotal))).toBeLessThanOrEqual(increment / 2);
				},
			),
			{ numRuns: 300 },
		);
		expect(roundPrice(1250, { mode: 'nearest', increment: 100, ending: 0 })).toBe(1300);
		expect(roundPrice(1249, { mode: 'nearest', increment: 100, ending: 0 })).toBe(1200);
		expect(roundPrice(40, { mode: 'down', increment: 100, ending: 99 })).toBe(0);
		expect(roundPrice(-5, { mode: 'none', increment: 1, ending: 0 })).toBe(0);
	});

	it('prices what the resolver returns', () => {
		const resolution = resolve(phone, { selection: { storage: '512' } });
		if (!resolution.ok) throw new Error('resolve');
		expect(priceOf(phone, resolution).ok && priceOf(phone, resolution)).toMatchObject({ price: { base: 75000, unit: 100000 } });
	});
});

describe('money display', () => {
	it('formats integer minor units with the currency’s own digits', () => {
		expect(minorDigits('EUR')).toBe(2);
		expect(minorDigits('JPY')).toBe(0);
		expect(minorDigits('KWD')).toBe(3);
		expect(minorDigits('nope')).toBe(2);
		expect(formatMoney(123456, 'EUR', 'en')).toBe('€1,234.56');
		expect(formatMoney(1234, 'JPY', 'en')).toBe('¥1,234');
		expect(formatMoney(1500, null, 'en')).toBe('1,500');
		expect(formatMoney(1500, 'EUR', 'not a locale!')).toBe('€15.00');
		expect(formatMoney(1500, 'XX1', 'en')).toBe('15.00 XX1');
	});
});
