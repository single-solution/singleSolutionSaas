/**
 * Quantity rules (E4): an item type's least, most and step quantity for items counted in pieces, the system ceilings
 * (100,000 of one item, 500 lines) the `checkout` settings lower, and the limits a cart line and a product page carry.
 */
import { describe, expect, it } from 'vitest';
import { MAX_LINES, MAX_QUANTITY, checkCart, resolveLines } from '../core/checkout.js';
import { BUILT_IN_TYPES, checkItemTypes, elementsOf } from '../core/item-types.js';
import { CART_MAX_LINES, CART_MAX_QUANTITY } from '../core/limits.js';
import { checkQuantityRule, limitsOf, quantityProblem } from '../core/measure.js';
import checkoutSettings from '../schemas/checkout.settings.json' with { type: 'json' };

/** @returns {any} */
const item = (over = {}) => ({
	id: 'prd_case',
	slug: 'case',
	name: 'Case',
	kind: 'physical',
	status: 'active',
	categoryIds: [],
	brandId: null,
	media: [],
	variants: [{ id: 'var_1', sku: '', options: {}, price: 100, cost: null, stock: 1_000_000, active: true, grade: null }],
	trackStock: false,
	digital: null,
	booking: null,
	...over,
});

const CASES = { step: 6, min: 12, max: 600 };

/** @param {number} quantity @param {Record<string, unknown>} [over] */
const line = (quantity, over = {}) =>
	resolveLines(
		[{ productId: 'prd_case', variantId: null, quantity, slot: null }],
		/** @type {any} */ ({
			products: new Map([['prd_case', item()]]),
			ancestors: (/** @type {string[]} */ ids) => ids,
			gradeLabel: (/** @type {string} */ key) => key,
			features: { digital: true, bookings: true, measured: true },
			slots: () => false,
			licenses: new Map(),
			slotOf: () => null,
			booked: new Set(),
			quantityOf: () => CASES,
			maxQuantity: 99,
			...over,
		}),
	)[0];

describe('quantity rules', () => {
	it('has a high ceiling for an item type’s most, and fixed usual limits (99 pieces, 50 lines)', () => {
		expect(MAX_QUANTITY).toBe(100_000);
		expect(CART_MAX_QUANTITY).toBe(99);
		expect(MAX_LINES).toBe(CART_MAX_LINES);
		expect(CART_MAX_LINES).toBe(50);
		const cart = (/** @type {number} */ count) => ({
			lines: Array.from({ length: count }, (_, i) => ({ productId: `prd_${i}` })),
		});
		expect(checkCart(cart(50)).ok).toBe(true);
		expect(checkCart(cart(51))).toMatchObject({ ok: false, field: 'lines' });
		// no setting offers them
		const props = /** @type {any} */ (checkoutSettings).properties;
		expect([props.maxQuantity, props.maxLines]).toEqual([undefined, undefined]);
	});

	it('checks a rule in whole pieces', () => {
		expect(checkQuantityRule(null)).toEqual({ ok: true, value: null });
		expect(checkQuantityRule({ step: 6 })).toEqual({ ok: true, value: { step: 6, min: 6, max: null } });
		expect(checkQuantityRule(CASES)).toEqual({ ok: true, value: CASES });
		expect(checkQuantityRule({ step: 6, min: 10 }).ok).toBe(false);
		expect(checkQuantityRule({ step: 6, min: 12, max: 13 }).ok).toBe(false);
		expect(checkQuantityRule({ step: 0 }).ok).toBe(false);
		expect(checkQuantityRule({ step: 1, max: 100_001 }).ok).toBe(false);
		expect(checkQuantityRule({ step: 1, extra: 1 }).ok).toBe(false);
	});

	it('gives the limits of a line', () => {
		expect(limitsOf(null, null, 99)).toEqual({ step: 1, min: 1, max: 99 });
		// an item type's own most wins, up to the ceiling; without one the usual most applies
		expect(limitsOf(null, CASES, 99)).toEqual({ step: 6, min: 12, max: 600 });
		expect(limitsOf(null, CASES, 1000)).toEqual({ step: 6, min: 12, max: 600 });
		expect(limitsOf(null, { step: 6, min: 12, max: null }, 99)).toEqual({ step: 6, min: 12, max: 99 });
		expect(limitsOf({ step: 500, min: 1000, max: null }, null, 99)).toEqual({ step: 500, min: 1000, max: 1_000_000_000 });
		expect(quantityProblem(18, { step: 6, min: 12, max: 600 })).toBeNull();
		expect(quantityProblem(6, { step: 6, min: 12, max: 600 })).toBe('quantity_min');
		expect(quantityProblem(13, { step: 6, min: 12, max: 600 })).toBe('quantity_step');
		expect(quantityProblem(606, { step: 6, min: 12, max: 600 })).toBe('quantity_max');
	});

	it('is an element of item types', () => {
		const checked = checkItemTypes([{ key: 'cases', name: 'Cases', kind: 'physical', elements: { quantity: CASES } }]);
		expect(checked.ok && checked.value[0]?.elements.quantity).toEqual(CASES);
		const bad = checkItemTypes([{ key: 'cases', name: 'Cases', elements: { quantity: { step: 6, min: 7 } } }]);
		expect(bad.ok).toBe(false);
		const both = checkItemTypes([
			{ key: 'cloth', name: 'Cloth', elements: { quantity: CASES, measure: { unit: 'm', decimals: 1 } } },
		]);
		expect(both.ok).toBe(false);
		expect(BUILT_IN_TYPES.physical.elements.quantity).toBeNull();
		if (checked.ok) {
			const type = /** @type {any} */ (checked.value[0]);
			expect(elementsOf(type, (feature) => feature === 'checkout').quantity).toEqual(CASES);
			expect(elementsOf(type, () => false).quantity).toBeNull();
		}
	});

	it('holds cart lines to the rule and gives their limits', () => {
		expect(line(18)?.problems).toEqual([]);
		expect(line(18)?.limits).toEqual({ step: 6, min: 12, max: 600 });
		expect(line(6)?.problems.map((p) => p.code)).toEqual(['quantity_min']);
		expect(line(20)?.problems.map((p) => p.code)).toEqual(['quantity_step']);
		expect(line(120, { maxQuantity: 1000 })?.problems).toEqual([]);
		expect(line(606, { maxQuantity: 1000 })?.problems.map((p) => p.code)).toEqual(['quantity_max']);
		// the item type names 600: 102 is fine; without a most of its own the usual 99 holds, as too many
		expect(line(102)?.problems).toEqual([]);
		expect(line(102, { quantityOf: () => ({ step: 6, min: 12, max: null }) })?.problems.map((p) => p.code)).toEqual([
			'too_many',
		]);
		// without a rule: any number of pieces from 1 up to the shop's most
		expect(line(5_000, { quantityOf: () => null, maxQuantity: 10_000 })?.problems).toEqual([]);
		expect(line(5_000, { quantityOf: () => null, maxQuantity: 10_000 })?.limits).toEqual({ step: 1, min: 1, max: 10_000 });
	});
});
