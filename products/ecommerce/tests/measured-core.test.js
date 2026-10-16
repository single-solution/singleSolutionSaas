/**
 * Measured quantities, pure (PLAN 0.8.10 dynamic model §4, phase 7): `lineGross` (exact, half up, whole units, the
 * largest amount), thousandths from decimal texts and back, steps and limits, the `measure` element of item types and
 * what may not change while items have stock, cart lines (steps, least, most, the most of one item in pieces, stock in
 * thousandths, the feature off), pricing (points and tax on measured lines), deals (one piece, a percent of what the
 * line comes to, a fixed amount per unit, minimum quantities, locks), coupons, no bundles, claims by step and their
 * value, analytics items, reports' return rates and feeds (unit pricing only for a unit tied to a standard measure).
 * The unit is the merchant's own label: these tests sell by a made-up "bolt" as well as by the meter.
 */
import { describe, expect, it } from 'vitest';
import { checkCart, priceLines, resolveLines } from '../core/checkout.js';
import { feedRows, googleItem } from '../core/feeds.js';
import { growthItem } from '../core/growth-events.js';
import { BUILT_IN_TYPES, checkItemTypes, elementsOf, typeChangeProblems } from '../core/item-types.js';
import {
	MAX_MEASURED,
	STANDARD_UNITS,
	checkMeasure,
	feedMeasureOf,
	grossFits,
	levelOf,
	lineGross,
	quantityProblem,
	measureView,
	piecesOf,
	placedGross,
	quantityLabel,
	quantityText,
	sameMeaning,
	toThousandths,
} from '../core/measure.js';
import { MAX_AMOUNT } from '@ss/contracts/format';
import { applyPromotions } from '../core/promotions.js';
import { returnRateRows } from '../core/reports.js';
import { claimValue, planClaim } from '../core/returns.js';

/** Fabric by the merchant's "m": steps of 0.5, at least 1, at most 20, no standard measure. */
const FABRIC = Object.freeze({
	unit: 'm',
	decimals: 1,
	step: 500,
	min: 1000,
	max: 20_000,
	standard: /** @type {import('../core/measure.js').StandardMeasure | null} */ (null),
});

describe('lineGross', () => {
	it('multiplies pieces exactly and measured quantities in thousandths, rounding half up', () => {
		expect(lineGross(1000, 3, false)).toBe(3000);
		expect(lineGross(1000, 3, false, 100)).toBe(3000);
		expect(lineGross(1000, 2500, true)).toBe(2500);
		expect(lineGross(333, 500, true)).toBe(167);
		expect(lineGross(1, 499, true)).toBe(0);
		expect(lineGross(1, 500, true)).toBe(1);
		expect(lineGross(0, 2500, true)).toBe(0);
	});

	it('rounds a measured line to whole units the same way (E25)', () => {
		expect(lineGross(15_000, 333, true, 100)).toBe(5000);
		expect(lineGross(15_000, 330, true, 100)).toBe(5000);
		expect(lineGross(15_000, 329, true, 100)).toBe(4900);
	});

	it('stays exact up to the largest amount and refuses more, never rounding it away', () => {
		expect(lineGross(MAX_AMOUNT, 1000, true)).toBe(MAX_AMOUNT);
		expect(lineGross(MAX_AMOUNT, 1, false)).toBe(MAX_AMOUNT);
		expect(() => lineGross(MAX_AMOUNT, 1001, true)).toThrow(RangeError);
		expect(() => lineGross(MAX_AMOUNT, MAX_MEASURED, true)).toThrow(RangeError);
		expect(() => lineGross(MAX_AMOUNT, 2, false)).toThrow(RangeError);
		expect(grossFits(MAX_AMOUNT, 1000, true)).toBe(true);
		expect(grossFits(MAX_AMOUNT, 1001, true)).toBe(false);
		// 999,999,999,999 × 1.0005 m: 1,000,499,999,999.4995 rounds to more than the largest amount
		expect(grossFits(999_999_999_999, 1000, true)).toBe(true);
		expect(grossFits(999_999_999_999, 1001, true)).toBe(false);
	});

	it('tells what a placed line came to from what it was priced at', () => {
		const line = { unitPrice: 333, quantity: 500, total: 150, discount: 17, tax: 0, measure: { unit: 'm' } };
		expect(placedGross(line, true)).toBe(167);
		expect(placedGross({ ...line, total: 165, tax: 15 }, false)).toBe(167);
		expect(placedGross({ ...line, measure: undefined, quantity: 2, total: 0 }, true)).toBe(666);
	});
});

describe('thousandths', () => {
	it.each([
		['2.5', 2500],
		['0.75', 750],
		['3', 3000],
		[' 2.5 ', 2500],
		['0.001', 1],
		['1.2500', 1250],
		[2.5, 2500],
		['1000000', MAX_MEASURED],
	])('reads %j as %d', (text, value) => expect(toThousandths(text)).toBe(value));

	it.each([['1.2501'], ['0'], ['0.0001'], ['-1'], ['abc'], ['1e3'], ['1,5'], [''], [null], [Number.NaN], ['1000000.001']])(
		'refuses %j',
		(text) => expect(toThousandths(text)).toBeNull(),
	);

	it('writes them back as units, and pieces as they are', () => {
		expect([2500, 750, 3000, 1, 20_000].map((value) => quantityText(value, FABRIC))).toEqual([
			'2.5',
			'0.75',
			'3',
			'0.001',
			'20',
		]);
		expect(quantityText(3)).toBe('3');
		expect(quantityLabel(2500, FABRIC)).toBe('2.5 m');
		expect(quantityLabel(2, null)).toBe('2');
		expect(measureView(2500, FABRIC)).toEqual({ unit: 'm', quantityText: '2.5' });
		expect(measureView(2, null)).toBeNull();
	});

	it('counts a measured line as one piece and compares stock levels in units', () => {
		expect(piecesOf({ quantity: 2500, measure: FABRIC })).toBe(1);
		expect(piecesOf({ quantity: 4 })).toBe(4);
		expect(levelOf(5, FABRIC)).toBe(5000);
		expect(levelOf(5, null)).toBe(5);
		// unit pricing only for a unit tied to a standard measure, never guessed from the label
		expect(feedMeasureOf(FABRIC)).toBeNull();
		expect(feedMeasureOf({ standard: { code: 'MTR', amount: 1 } })).toBe('1 m');
		expect(feedMeasureOf({ standard: { code: 'GRM', amount: 11.664 } })).toBe('11.664 g');
		expect(feedMeasureOf({ standard: { code: 'C62', amount: 12 } })).toBe('12 ct');
		expect(feedMeasureOf({ standard: { code: 'MMT', amount: 5 } })).toBe('0.5 cm');
		expect(feedMeasureOf({ standard: { code: 'FTK', amount: 1 } })).toBe('1 sqft');
		expect(STANDARD_UNITS).toMatchObject({ MTR: { feed: 'm' }, KGM: { feed: 'kg' }, LBR: { feed: 'lb' } });
	});
});

describe('steps and limits', () => {
	it('takes a quantity that is a multiple of the step between the least and the most', () => {
		expect(quantityProblem(1000, FABRIC)).toBeNull();
		expect(quantityProblem(2500, FABRIC)).toBeNull();
		expect(quantityProblem(20_000, FABRIC)).toBeNull();
		expect(quantityProblem(500, FABRIC)).toBe('quantity_min');
		expect(quantityProblem(2600, FABRIC)).toBe('quantity_step');
		expect(quantityProblem(20_500, FABRIC)).toBe('quantity_max');
		expect(quantityProblem(1_000_000, { ...FABRIC, max: null })).toBeNull();
	});

	it('checks a measure element of any unit label, with its defaults', () => {
		expect(checkMeasure(null)).toEqual({ ok: true, value: null });
		// the merchant's own unit, in any language
		expect(checkMeasure({ unit: '  sq   ft ' })).toEqual({
			ok: true,
			value: { unit: 'sq ft', decimals: 1, step: 100, min: 100, max: null, standard: null },
		});
		expect(checkMeasure({ unit: 'tola', decimals: 0 })).toMatchObject({ ok: true, value: { step: 1000, min: 1000 } });
		expect(checkMeasure({ unit: 'قيراط', decimals: 3 })).toMatchObject({ ok: true, value: { unit: 'قيراط', step: 1 } });
		expect(checkMeasure(FABRIC)).toEqual({ ok: true, value: FABRIC });
		expect(checkMeasure({ ...FABRIC, standard: { code: 'MTR', amount: 1 } })).toMatchObject({
			ok: true,
			value: { standard: { code: 'MTR', amount: 1 } },
		});
		/** @param {unknown} raw */
		const paths = (raw) => {
			const checked = checkMeasure(raw);
			return checked.ok ? [] : checked.errors.map((error) => error.path);
		};
		expect(paths({ unit: '' })).toEqual(['/unit']);
		expect(paths({ unit: 'x'.repeat(21) })).toEqual(['/unit']);
		expect(paths({ unit: 'a\nb' })).toEqual(['/unit']);
		expect(paths({ unit: 'm', decimals: 4 })).toEqual(['/decimals']);
		// with no decimals a step is whole units
		expect(paths({ unit: 'hour', decimals: 0, step: 500 })).toEqual(['/step']);
		expect(paths({ ...FABRIC, standard: { code: 'XYZ', amount: 1 } })).toEqual(['/standard/code']);
		expect(paths({ ...FABRIC, standard: { code: 'MTR', amount: 0 } })).toEqual(['/standard/amount']);
		expect(paths({ ...FABRIC, standard: { code: 'MTR', amount: 1.0000001 } })).toEqual(['/standard/amount']);
		expect(paths({ ...FABRIC, step: 0 })).toContain('/step');
		expect(paths({ ...FABRIC, step: 1.5 })).toContain('/step');
		expect(paths({ ...FABRIC, min: 1200 })).toEqual(['/min']);
		expect(paths({ ...FABRIC, max: 500 })).toEqual(['/max']);
		expect(paths({ ...FABRIC, max: 20_100 })).toEqual(['/max']);
		expect(paths({ ...FABRIC, price: 1 })).toEqual(['/price']);
		expect(paths('2.5 m')).toEqual(['']);
	});

	it('gives quantities another meaning only with another unit', () => {
		const looser = { ...FABRIC, decimals: 2, step: 100, min: 100, max: null, standard: { code: 'MTR', amount: 1 } };
		expect(sameMeaning(FABRIC, looser)).toBe(true);
		expect(sameMeaning(FABRIC, { ...FABRIC, unit: 'cm' })).toBe(false);
		expect(sameMeaning(FABRIC, null)).toBe(false);
		expect(sameMeaning(null, undefined)).toBe(true);
	});
});

describe('the measure element of item types', () => {
	const fabric = { key: 'fabric', name: 'Fabric', kind: 'physical', elements: { variants: true, measure: FABRIC } };

	it('keeps a physical type’s measure; built-in types have none', () => {
		const checked = checkItemTypes([fabric, { key: 'box', name: 'Box', kind: 'physical', elements: {} }]);
		expect(checked).toMatchObject({ ok: true, value: [{ elements: { measure: FABRIC } }, { elements: { measure: null } }] });
		expect(BUILT_IN_TYPES.physical.elements.measure).toBeNull();
	});

	it('refuses a measure on digital goods and services, with numbered units, or badly given', () => {
		const paths = (/** @type {unknown[]} */ list) => {
			const checked = checkItemTypes(list);
			return checked.ok ? [] : checked.errors.map((error) => error.path);
		};
		expect(paths([{ ...fabric, kind: 'digital' }])).toEqual(['/value/0/elements/measure']);
		expect(paths([{ ...fabric, kind: 'service' }])).toEqual(['/value/0/elements/measure']);
		expect(paths([{ ...fabric, elements: { measure: FABRIC, units: { capture: 'packing' } } }])).toEqual([
			'/value/0/elements/measure',
		]);
		expect(paths([{ ...fabric, elements: { measure: { ...FABRIC, unit: '' } } }])).toEqual(['/value/0/elements/measure/unit']);
	});

	it('works only while Sell in any unit is on', () => {
		const checked = checkItemTypes([fabric]);
		if (!checked.ok) throw new Error('checked');
		const [type] = checked.value;
		if (!type) throw new Error('type');
		expect(elementsOf(type, () => true).measure).toEqual(FABRIC);
		expect(elementsOf(type, (feature) => feature !== 'measured_sales').measure).toBeNull();
	});

	it('keeps the unit of a type whose items have stock', () => {
		const checked = checkItemTypes([fabric]);
		if (!checked.ok) throw new Error('checked');
		const saved = checked.value;
		/** @param {Record<string, unknown>} elements @param {string[]} withStock */
		const problems = (elements, withStock) => {
			const next = checkItemTypes([{ ...fabric, elements }]);
			if (!next.ok) throw new Error('next');
			return typeChangeProblems(saved, next.value, {
				fields: new Map(),
				named: new Set(['fabric']),
				stocked: new Set(),
				withStock: new Set(withStock),
			}).map((problem) => problem.path);
		};
		expect(problems({ measure: { ...FABRIC, unit: 'cm' } }, ['fabric'])).toEqual(['/value/0/elements/measure']);
		expect(problems({}, ['fabric'])).toEqual(['/value/0/elements/measure']);
		expect(problems({ measure: { ...FABRIC, unit: 'cm' } }, [])).toEqual([]);
		expect(problems({ measure: { ...FABRIC, step: 100, min: 100, max: null } }, ['fabric'])).toEqual([]);
	});
});

/** @returns {any} */
const variant = (over = {}) => ({
	id: 'var_1',
	sku: 'F1',
	options: {},
	price: 1000,
	compareAtPrice: null,
	cost: 400,
	stock: 10_000,
	locations: {},
	grade: null,
	active: true,
	...over,
});

/** @returns {any} */
const product = (over = {}) => ({
	id: 'prd_fabric',
	slug: 'linen',
	name: 'Linen',
	kind: 'physical',
	status: 'active',
	categoryIds: ['cat_fabric'],
	brandId: null,
	media: [],
	variants: [variant()],
	trackStock: true,
	digital: null,
	booking: null,
	...over,
});

/** @param {any[]} products @param {Record<string, unknown>} [over] */
const context = (products, over = {}) => ({
	products: new Map(products.map((p) => [p.id, p])),
	ancestors: (/** @type {string[]} */ ids) => ids,
	gradeLabel: (/** @type {string} */ key) => key,
	features: { digital: true, bookings: true, measured: true },
	slots: () => false,
	licences: new Map(),
	slotOf: () => null,
	booked: new Set(),
	measureOf: (/** @type {any} */ item) => (item.id === 'prd_fabric' ? FABRIC : null),
	...over,
});

/** @param {Array<[string, number]>} wanted product id and quantity @param {Record<string, unknown>} [over] @param {any[]} [products] */
const resolve = (
	wanted,
	over = {},
	products = [product(), product({ id: 'prd_box', name: 'Box', variants: [variant({ id: 'var_box' })] })],
) =>
	resolveLines(
		wanted.map(([productId, quantity]) => ({ productId, variantId: null, quantity, slot: null })),
		/** @type {any} */ (context(products, over)),
	);

describe('cart lines', () => {
	it('takes quantities in thousandths up to a million units; the most of one item is checked on the line', () => {
		expect(checkCart({ lines: [{ productId: 'prd_fabric', quantity: 2500 }] })).toMatchObject({ ok: true });
		expect(checkCart({ lines: [{ productId: 'prd_fabric', quantity: MAX_MEASURED + 1 }] })).toMatchObject({
			ok: false,
			field: 'lines/0/quantity',
		});
		expect(checkCart({ lines: [{ productId: 'prd_fabric', quantity: 2.5 }] })).toMatchObject({ ok: false });
	});

	it('checks a measured line’s steps, least and most, and keeps its measure', () => {
		const [ok] = resolve([['prd_fabric', 2500]]);
		expect(ok).toMatchObject({ quantity: 2500, measure: FABRIC, priced: true, problems: [] });
		expect(resolve([['prd_fabric', 2600]])[0]?.problems.map((p) => p.code)).toEqual(['quantity_step']);
		expect(resolve([['prd_fabric', 500]])[0]?.problems.map((p) => p.code)).toEqual(['quantity_min']);
		expect(resolve([['prd_fabric', 20_500]])[0]?.problems.map((p) => p.code)).toEqual(['quantity_max', 'not_enough_stock']);
		expect(resolve([['prd_box', 2]])[0]).toMatchObject({ measure: null, problems: [] });
	});

	it('counts a measured line as one piece of the most of one item, and pieces as they are', () => {
		expect(resolve([['prd_fabric', 9000]], { maxQuantity: 3 })[0]?.problems).toEqual([]);
		expect(resolve([['prd_box', 4]], { maxQuantity: 3 })[0]?.problems).toEqual([
			{ code: 'too_many', message: 'At most 3 of one item.' },
		]);
	});

	it('compares stock in thousandths, merging lines of one variant', () => {
		const lines = resolve([['prd_fabric', 2500]], {}, [product({ variants: [variant({ stock: 2000 })] })]);
		expect(lines[0]?.problems.map((p) => p.code)).toEqual(['not_enough_stock']);
		const merged = resolveLines(
			[
				{ productId: 'prd_fabric', variantId: null, quantity: 6000, slot: null },
				{ productId: 'prd_fabric', variantId: 'var_1', quantity: 4250, slot: null },
			],
			/** @type {any} */ (context([product()])),
		);
		expect(merged).toHaveLength(1);
		expect(merged[0]).toMatchObject({ quantity: 10_250 });
		expect(merged[0]?.problems.map((p) => p.code)).toEqual(['quantity_step', 'not_enough_stock']);
	});

	it('does not sell measured items while Measured sales is off, and never prices a line above the largest amount', () => {
		const off = resolve([['prd_fabric', 2500]], { features: { digital: true, bookings: true, measured: false } });
		expect(off[0]).toMatchObject({ priced: false, problems: [{ code: 'unavailable' }] });
		const huge = resolve([['prd_fabric', 2000]], {}, [product({ variants: [variant({ price: MAX_AMOUNT })] })]);
		expect(huge[0]).toMatchObject({ priced: false });
		expect(huge[0]?.problems.map((p) => p.code)).toContain('too_large');
	});
});

describe('pricing measured lines', () => {
	it('prices what the line comes to, spreads points and adds tax on top', () => {
		const lines = resolve(
			[
				['prd_fabric', 1500],
				['prd_box', 2],
			],
			{},
			[product({ variants: [variant({ price: 333 })] }), product({ id: 'prd_box', variants: [variant({ id: 'var_box' })] })],
		);
		const priced = priceLines({
			lines,
			promotions: null,
			delivery: 0,
			pointsValue: 250,
			taxRules: [
				{ name: 'Tax', percent: 10, categoryIds: [], regions: [{ country: 'US', region: '', city: '', postcode: '' }] },
			],
			region: { country: 'US', region: '', city: '', area: '', postalCode: '' },
			taxIncluded: false,
		});
		// 1.5 m × 3.33 = 4.995 → 5.00
		expect(priced.lines.map((line) => [line.gross, line.points, line.tax, line.total])).toEqual([
			[500, 50, 45, 495],
			[2000, 200, 180, 1980],
		]);
		expect(priced.totals).toMatchObject({ subtotal: 2500, discount: 250, tax: 225, total: 2475 });
	});

	it('rounds a measured line to whole units with the Format’s wholeUnits', () => {
		const lines = resolve([['prd_fabric', 1000]], { unit: 100 }, [product({ variants: [variant({ price: 15_015 })] })]);
		const priced = priceLines({
			lines,
			promotions: null,
			delivery: 0,
			pointsValue: 0,
			taxRules: [],
			region: null,
			taxIncluded: true,
			unit: 100,
		});
		expect(priced.totals.subtotal).toBe(15_000);
	});
});

/** @param {Partial<import('../core/model.js').DealRecord>} [o] @returns {import('../core/model.js').DealRecord} */
const deal = (o = {}) => ({
	id: 'deal_1',
	name: 'Deal',
	description: '',
	type: 'percent',
	value: 10,
	scope: { productIds: [], categoryIds: [], brandIds: [] },
	startsAt: null,
	endsAt: null,
	limit: null,
	used: 0,
	priority: 0,
	active: true,
	slug: '',
	badgeLabel: '',
	discountLabel: '',
	color: '',
	banner: null,
	content: '',
	seo: { title: '', description: '' },
	sort: 0,
	conditions: null,
	target: 'items',
	days: [],
	timeFrom: '',
	timeTo: '',
	allowPoints: true,
	...o,
});

/** A measured pricing line: 1,000 per meter. @param {Record<string, unknown>} [o] @returns {any} */
const fabricLine = (o = {}) => ({
	key: 'prd_fabric|var_1',
	productId: 'prd_fabric',
	variantId: 'var_1',
	categoryIds: [],
	brandId: null,
	unitPrice: 1000,
	quantity: 2500,
	measure: FABRIC,
	...o,
});

/** @param {Partial<Parameters<typeof applyPromotions>[0]>} o */
const promote = (o) =>
	applyPromotions({
		lines: [],
		deals: [],
		bundles: [],
		coupon: null,
		couponCode: '',
		customer: { orderCount: 0, couponUses: 0 },
		now: Date.parse('2026-10-15T10:00:00Z'),
		...o,
	});

describe('offers on measured lines', () => {
	it('takes a percent off what the line comes to and a fixed amount off each unit', () => {
		expect(promote({ lines: [fabricLine()], deals: [deal()] }).lines[0]).toMatchObject({ dealDiscount: 250, perUnit: 100 });
		expect(promote({ lines: [fabricLine()], deals: [deal({ type: 'fixed', value: 100 })] }).lines[0]?.dealDiscount).toBe(250);
		// 0.333 m: 1.00 off each meter takes 0.33 (rounded down)
		expect(
			promote({ lines: [fabricLine({ quantity: 333 })], deals: [deal({ type: 'fixed', value: 100 })] }).lines[0]?.dealDiscount,
		).toBe(33);
		// never more than the line
		expect(promote({ lines: [fabricLine()], deals: [deal({ type: 'fixed', value: 5000 })] }).lines[0]?.dealDiscount).toBe(2500);
	});

	it('rounds once per line in whole units, or once per order with total_half_up', () => {
		const whole = promote({
			lines: [fabricLine({ unitPrice: 15_000, quantity: 333 })],
			deals: [deal({ type: 'fixed', value: 1000 })],
			unit: 100,
		});
		expect(whole.lines[0]?.dealDiscount).toBe(300);
		const exact = promote({
			lines: [fabricLine({ quantity: 333 })],
			deals: [deal({ value: 15 })],
			rules: {
				.../** @type {any} */ ({}),
				rounding: 'total_half_up',
				lineChoice: 'best',
				cartOffer: 'per_line_best',
				cartThresholdBase: 'before_item_deals',
				pointsBlockedBy: 'any_deal',
			},
		});
		// 15 % of 3.33 = 0.4995 → 0.50 once
		expect(exact.lines[0]?.dealDiscount).toBe(50);
	});

	it('counts a measured line as one piece for a deal’s minimum quantity and its cart total as what it comes to', () => {
		const conditions = {
			match: /** @type {const} */ ('all'),
			rules: [],
			groups: [],
			priceRange: null,
			minQuantity: 2,
			cartTotal: 0,
			paymentMethods: [],
		};
		expect(promote({ lines: [fabricLine()], deals: [deal({ conditions })] }).lines[0]?.dealDiscount).toBe(0);
		const total = { ...conditions, minQuantity: 0, cartTotal: 2500 };
		expect(promote({ lines: [fabricLine()], deals: [deal({ conditions: total })] }).lines[0]?.dealDiscount).toBe(250);
		expect(
			promote({ lines: [fabricLine({ quantity: 2000 })], deals: [deal({ conditions: total })] }).lines[0]?.dealDiscount,
		).toBe(0);
	});

	it('keeps a lock’s saving per unit for the measured quantity', () => {
		const locked = promote({ lines: [fabricLine({ lock: { dealId: 'deal_1', perUnit: 150 } })], deals: [deal()] });
		expect(locked.lines[0]).toMatchObject({ dealDiscount: 375, locked: true });
	});

	it('never puts measured items in a bundle or a buy X get Y', () => {
		const box = {
			...fabricLine({ key: 'prd_box|var_box', productId: 'prd_box', variantId: 'var_box', quantity: 1 }),
			measure: undefined,
		};
		const set = {
			id: 'bnd_1',
			name: 'Set',
			type: /** @type {const} */ ('bundle'),
			items: [
				{ productId: 'prd_fabric', quantity: 1 },
				{ productId: 'prd_box', quantity: 1 },
			],
			price: 500,
			buy: 0,
			get: 0,
			scope: { productIds: [], categoryIds: [], brandIds: [] },
			getScope: { productIds: [], categoryIds: [], brandIds: [] },
			value: 0,
			startsAt: null,
			endsAt: null,
			limit: null,
			used: 0,
			active: true,
		};
		expect(promote({ lines: [fabricLine(), box], bundles: [set] }).bundleIds).toEqual([]);
		const free = { ...set, type: /** @type {const} */ ('buy_x_get_y'), items: [], price: null, buy: 1, get: 1, value: 100 };
		expect(promote({ lines: [fabricLine()], bundles: [free] }).bundleIds).toEqual([]);
	});

	it('lets a coupon take a percent of what the measured line comes to', () => {
		const coupon = {
			id: 'cpn_1',
			code: 'SAVE10',
			type: /** @type {const} */ ('percent'),
			value: 10,
			maxDiscount: null,
			minSubtotal: 2500,
			scope: { productIds: [], categoryIds: [], brandIds: [] },
			startsAt: null,
			endsAt: null,
			limit: null,
			used: 0,
			perCustomer: null,
			firstOrderOnly: false,
			active: true,
		};
		const result = promote({ lines: [fabricLine()], coupon, couponCode: 'SAVE10' });
		expect(result.lines[0]?.couponDiscount).toBe(250);
		expect(promote({ lines: [fabricLine({ quantity: 2000 })], coupon, couponCode: 'SAVE10' }).couponProblem?.code).toBe(
			'coupon_min_subtotal',
		);
	});
});

describe('claims, analytics, reports and feeds of measured lines', () => {
	const line = /** @type {any} */ ({
		id: 'oln_1',
		quantity: 2500,
		total: 2500,
		measure: { unit: 'bolt', decimals: 1, step: 500 },
	});
	/** @param {number} claimable */
	const returnable = (claimable) =>
		/** @type {any} */ ([{ line, claimable, freeSerials: [], return: { open: true }, warranty: { open: true } }]);

	it('claims a measured line in its steps, or all that is left of it', () => {
		expect(planClaim('return', [{ lineId: 'oln_1', quantity: 1000 }], returnable(2500))).toMatchObject({
			ok: true,
			lines: [{ lineId: 'oln_1', quantity: 1000, serials: [] }],
		});
		expect(planClaim('return', [{ lineId: 'oln_1', quantity: 1250 }], returnable(2500))).toEqual({
			ok: false,
			lineId: 'oln_1',
			reason: 'step',
		});
		expect(planClaim('return', [{ lineId: 'oln_1', quantity: 2300 }], returnable(2300))).toMatchObject({ ok: true });
		expect(planClaim('return', [{ lineId: 'oln_1', quantity: 3000 }], returnable(2500))).toMatchObject({ reason: 'quantity' });
	});

	it('values a claim exactly in proportion to what the line was paid', () => {
		expect(claimValue({ lines: [line] }, { lines: [{ lineId: 'oln_1', quantity: 1000, serials: [] }] })).toBe(1000);
		const large = { ...line, total: 999_999_999_999, quantity: 999_999_999 };
		expect(claimValue({ lines: [large] }, { lines: [{ lineId: 'oln_1', quantity: 333_333_333, serials: [] }] })).toBe(
			333_333_333_333,
		);
	});

	it('sends a measured line to analytics as one item at what it comes to', () => {
		expect(growthItem({ productId: 'prd_fabric', unitPrice: 1000, quantity: 2500, measure: { unit: 'm' } })).toEqual({
			id: 'prd_fabric',
			variantId: null,
			name: '',
			price: 2500,
			quantity: 1,
		});
		expect(
			growthItem({ productId: 'prd_fabric', unitPrice: 1000, quantity: 2500, measure: { unit: 'm' }, gross: 2400 }).price,
		).toBe(2400);
		expect(growthItem({ productId: 'prd_box', unitPrice: 1000, quantity: 2 })).toMatchObject({ price: 1000, quantity: 2 });
	});

	it('counts a measured claim as one piece in return rates', () => {
		const rows = returnRateRows(
			[{ _id: 'prd_fabric', name: 'Linen', units: 2 }],
			[{ orderId: 'ord_1', lines: [{ lineId: 'oln_1', quantity: 1000 }] }],
			new Map([['oln_1', { productId: 'prd_fabric', name: 'Linen', measure: { unit: 'm' } }]]),
		);
		expect(rows[0]).toMatchObject({ sold: 2, claimed: 1, rate: 0.5 });
	});

	it('sends the standard measure a feed item’s price is for, and no unit price for a unit without one', () => {
		/** @param {import('../core/measure.js').Measure | null} measure */
		const rowsOf = (measure) =>
			feedRows(product(), {
				link: 'https://shop.example/p/linen',
				image: '',
				brand: '',
				productType: '',
				currency: 'USD',
				condition: () => 'new',
				shown: (/** @type {any} */ v) => ({ price: v.price, was: null, deal: null, savings: 0, sale: null }),
				now: Date.parse('2026-10-15T10:00:00Z'),
				skuAs: 'none',
				includeOutOfStock: true,
				measure,
			});
		const unmapped = rowsOf(FABRIC);
		expect(unmapped[0]?.unitPricing).toBe('');
		expect(googleItem(/** @type {any} */ (unmapped[0]))).not.toContain('unit_pricing');
		const rows = feedRows(product(), {
			link: 'https://shop.example/p/linen',
			image: '',
			brand: '',
			productType: '',
			currency: 'USD',
			condition: () => 'new',
			shown: (/** @type {any} */ v) => ({ price: v.price, was: null, deal: null, savings: 0, sale: null }),
			now: Date.parse('2026-10-15T10:00:00Z'),
			skuAs: 'none',
			includeOutOfStock: true,
			measure: { ...FABRIC, standard: { code: 'MTR', amount: 1 } },
		});
		expect(rows[0]?.unitPricing).toBe('1 m');
		expect(rowsOf({ ...FABRIC, unit: 'tola', standard: { code: 'GRM', amount: 11.664 } })[0]?.unitPricing).toBe('11.664 g');
		const xml = googleItem(/** @type {any} */ (rows[0]));
		expect(xml).toContain('<g:unit_pricing_measure>1 m</g:unit_pricing_measure>');
		expect(xml).toContain('<g:unit_pricing_base_measure>1 m</g:unit_pricing_base_measure>');
		const plain = feedRows(product(), {
			.../** @type {any} */ ({}),
			link: 'x',
			image: '',
			brand: '',
			productType: '',
			currency: 'USD',
			condition: () => 'new',
			shown: (/** @type {any} */ v) => ({ price: v.price, was: null, deal: null, savings: 0, sale: null }),
			now: 0,
			skuAs: 'none',
			includeOutOfStock: true,
		});
		expect(googleItem(/** @type {any} */ (plain[0]))).not.toContain('unit_pricing');
	});
});
