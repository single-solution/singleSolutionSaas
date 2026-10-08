/**
 * Checkout's pure rules: cart and address checks, line resolution, pricing, payment methods, delivery zones, taxes,
 * COD safety, booking slots and digital goods.
 */
import { describe, expect, it } from 'vitest';
import { checkBookingHours, instantOf, slotAt, slotsBetween, wallClock } from '../core/bookings.js';
import {
	checkAddress,
	checkCart,
	checkOrderExtras,
	merchandiseOf,
	paymentOptions,
	priceLines,
	promotionDiscounts,
	resolveLines,
} from '../core/checkout.js';
import { codAdvance, codDecision, isRtoFlagged } from '../core/cod.js';
import { checkZones, matchZone, placeKey, zoneCities, zoneFee } from '../core/delivery.js';
import { canDownload, checkLicenceKeys, downloadLimitOf, fileKey, fileNameOf, safeFileName } from '../core/digital.js';
import { checkTaxRules, taxOf, taxPercent } from '../core/taxes.js';

/** @returns {any} */
const variant = (over = {}) => ({
	id: 'var_1',
	sku: 'SKU1',
	options: { Colour: 'Red', Size: 'M' },
	price: 1000,
	compareAtPrice: null,
	cost: 600,
	stock: 5,
	locations: {},
	grade: null,
	active: true,
	...over,
});

/** @returns {any} */
const productOf = (over = {}) => ({
	id: 'prd_1',
	slug: 'p',
	name: 'Phone',
	kind: 'physical',
	status: 'active',
	categoryIds: ['cat_child'],
	brandId: 'brd_1',
	media: [{ key: 'ecommerce/products/prd_1/a.jpg', type: 'image/jpeg', size: 1, alt: '' }],
	variants: [variant()],
	trackStock: true,
	digital: null,
	booking: null,
	...over,
});

/** @param {any[]} products @param {Partial<Parameters<typeof resolveLines>[1]>} [over] */
const context = (products, over = {}) => ({
	products: new Map(products.map((p) => [p.id, p])),
	ancestors: (/** @type {string[]} */ ids) => [...ids, 'cat_root'],
	gradeLabel: (/** @type {string} */ key) => `Grade ${key}`,
	features: { digital: true, bookings: true },
	licences: new Map(),
	slotOf: () => null,
	booked: new Set(),
	...over,
});

describe('cart checks', () => {
	it('accepts and merges lines', () => {
		const checked = checkCart({
			lines: [
				{ productId: 'prd_1', quantity: 2 },
				{ productId: 'prd_1', quantity: 3 },
				{ productId: 'prd_2', variantId: 'var_2', slot: '2026-10-06T10:00:00Z' },
			],
			coupon: ' save10 ',
			points: 5,
			delivery: { method: 'pickup', city: 'X', locationId: 'loc_1' },
			payment: 'cod',
		});
		expect(checked.ok).toBe(true);
		if (!checked.ok) return;
		expect(checked.value.lines).toEqual([
			{ productId: 'prd_1', variantId: null, quantity: 5, slot: null },
			{ productId: 'prd_2', variantId: 'var_2', quantity: 1, slot: Date.parse('2026-10-06T10:00:00Z') },
		]);
		expect(checked.value.coupon).toBe('SAVE10');
		expect(checked.value.delivery).toEqual({ method: 'pickup', city: 'X', area: '', country: '', locationId: 'loc_1' });
	});

	it.each([
		[{}, 'lines'],
		[{ lines: [] }, 'lines'],
		[{ lines: [1] }, 'lines/0/productId'],
		[{ lines: [{ productId: 'p', variantId: 5 }] }, 'lines/0/variantId'],
		[{ lines: [{ productId: 'p', quantity: 0 }] }, 'lines/0/quantity'],
		[{ lines: [{ productId: 'p', slot: 'never' }] }, 'lines/0/slot'],
		[
			{
				lines: [
					{ productId: 'p', quantity: 60 },
					{ productId: 'p', quantity: 60 },
				],
			},
			'lines/1/quantity',
		],
		[{ lines: [{ productId: 'p' }], coupon: 'x'.repeat(41) }, 'coupon'],
		[{ lines: [{ productId: 'p' }], coupon: 5 }, 'coupon'],
		[{ lines: [{ productId: 'p' }], points: -1 }, 'points'],
		[{ lines: [{ productId: 'p' }], delivery: { method: 'drone' } }, 'delivery/method'],
		[{ lines: [{ productId: 'p' }], delivery: { city: 'x'.repeat(81) } }, 'delivery'],
		[{ lines: [{ productId: 'p' }], delivery: { locationId: 'a b' } }, 'delivery/locationId'],
		[{ lines: [{ productId: 'p' }], payment: 'cheque' }, 'payment'],
	])('refuses %j', (body, field) => {
		const checked = checkCart(body);
		expect(checked.ok).toBe(false);
		if (!checked.ok) expect(checked.field).toBe(field);
	});

	it('checks addresses', () => {
		const good = { name: 'Sara', phone: '+1 555 000', line1: '1 Main St', city: 'Town', notes: 'Ring' };
		expect(checkAddress(good, [])).toMatchObject({ ok: true, value: { name: 'Sara', area: '', country: '' } });
		expect(checkAddress(null, [])).toMatchObject({ ok: false, field: 'address' });
		expect(checkAddress({ ...good, name: '' }, [])).toMatchObject({ ok: false, field: 'address/name' });
		expect(checkAddress({ ...good, line1: 'x'.repeat(201) }, [])).toMatchObject({ ok: false, field: 'address/line1' });
		expect(checkAddress(good, ['postalCode'])).toMatchObject({ ok: false, field: 'address/postalCode' });
		expect(checkAddress({ ...good, phone: 'call me' }, [])).toMatchObject({ ok: false, field: 'address/phone' });
	});

	it('checks what placing adds', () => {
		expect(checkOrderExtras({ payment: 'online', note: ' hi ', returnUrl: 'https://x' })).toEqual({
			ok: true,
			value: { payment: 'online', note: 'hi', returnUrl: 'https://x', address: undefined },
		});
		expect(checkOrderExtras(null)).toMatchObject({ ok: false, field: 'payment' });
		expect(checkOrderExtras({ payment: 'cod', note: 'x'.repeat(1001) })).toMatchObject({ ok: false, field: 'note' });
		expect(checkOrderExtras({ payment: 'cod', returnUrl: 5 })).toMatchObject({ ok: false, field: 'returnUrl' });
	});
});

describe('lines', () => {
	it('resolves a product, its only variant, grade and stock shortfalls', () => {
		const lines = resolveLines(
			[
				{ productId: 'prd_1', variantId: null, quantity: 3, slot: null },
				{ productId: 'prd_1', variantId: 'var_1', quantity: 3, slot: null },
			],
			context([productOf({ variants: [variant({ grade: 'a' })] })]),
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			key: 'prd_1|var_1',
			quantity: 6,
			variantName: 'Red / M',
			gradeLabel: 'Grade a',
			allCategoryIds: ['cat_child', 'cat_root'],
			priced: true,
			problems: [{ code: 'not_enough_stock' }],
		});
		const empty = resolveLines(
			[{ productId: 'prd_1', variantId: null, quantity: 1, slot: null }],
			context([productOf({ variants: [variant({ stock: 0 })] })]),
		);
		expect(empty[0]?.problems).toEqual([{ code: 'out_of_stock', message: 'This item is out of stock.' }]);
	});

	it('reports unknown, unsold and ambiguous items', () => {
		const lines = resolveLines(
			[
				{ productId: 'missing', variantId: null, quantity: 1, slot: null },
				{ productId: 'prd_draft', variantId: null, quantity: 1, slot: null },
				{ productId: 'prd_many', variantId: null, quantity: 1, slot: null },
				{ productId: 'prd_many', variantId: 'var_gone', quantity: 1, slot: null },
				{ productId: 'prd_dig', variantId: null, quantity: 1, slot: null },
				{ productId: 'prd_book', variantId: null, quantity: 1, slot: null },
			],
			context(
				[
					productOf({ id: 'prd_draft', status: 'draft' }),
					productOf({ id: 'prd_many', variants: [variant(), variant({ id: 'var_2' })] }),
					productOf({ id: 'prd_dig', kind: 'digital' }),
					productOf({ id: 'prd_book', kind: 'booking', booking: { durationMinutes: 30 } }),
				],
				{ features: { digital: false, bookings: false } },
			),
		);
		expect(lines.map((line) => line.problems[0]?.code)).toEqual([
			'unavailable',
			'unavailable',
			'choose_variant',
			'unavailable',
			'unavailable',
			'unavailable',
		]);
		expect(lines.every((line) => !line.priced)).toBe(true);
	});

	it('checks booking slots and licence keys', () => {
		const booking = productOf({ id: 'prd_book', kind: 'booking', trackStock: false, booking: { durationMinutes: 60 } });
		const digital = productOf({
			id: 'prd_dig',
			kind: 'digital',
			trackStock: false,
			digital: { files: [], licenceKeys: true, downloadLimit: 0 },
		});
		const start = Date.parse('2026-10-06T10:00:00Z');
		const lines = resolveLines(
			[
				{ productId: 'prd_book', variantId: null, quantity: 1, slot: null },
				{ productId: 'prd_book', variantId: null, quantity: 1, slot: start - 1 },
				{ productId: 'prd_book', variantId: null, quantity: 2, slot: start },
				{ productId: 'prd_book', variantId: null, quantity: 1, slot: start + 3_600_000 },
				{ productId: 'prd_dig', variantId: null, quantity: 3, slot: null },
			],
			context([booking, digital], {
				licences: new Map([['prd_dig', 2]]),
				slotOf: (_product, at) => (at % 3_600_000 === 0 ? { start: at, end: at + 3_600_000 } : null),
				booked: new Set([`prd_book|${start + 3_600_000}`]),
			}),
		);
		expect(lines.map((line) => line.problems.map((p) => p.code))).toEqual([
			['slot_required'],
			['slot_unavailable'],
			['one_per_slot'],
			['slot_taken'],
			['not_enough_stock'],
		]);
		expect(lines[2]?.booking).toEqual({ start, end: start + 3_600_000 });
		const none = resolveLines([{ productId: 'prd_dig', variantId: null, quantity: 1, slot: null }], context([digital]));
		expect(none[0]?.problems[0]?.code).toBe('out_of_stock');
	});
});

describe('pricing', () => {
	const lines = resolveLines(
		[
			{ productId: 'prd_1', variantId: null, quantity: 2, slot: null },
			{ productId: 'prd_2', variantId: null, quantity: 1, slot: null },
		],
		context([
			productOf(),
			productOf({ id: 'prd_2', categoryIds: ['cat_food'], variants: [variant({ id: 'var_9', price: 500 })] }),
		]),
	);
	const promotions = /** @type {any} */ ({
		lines: [{ key: 'prd_1|var_1', dealId: 'deal_1', dealDiscount: 200, bundleDiscount: 0, couponDiscount: 5000 }],
	});

	it('takes promotions off (never more than the line)', () => {
		expect(promotionDiscounts(lines, promotions)).toEqual([2000, 0]);
		expect(promotionDiscounts(lines, null)).toEqual([0, 0]);
		expect(merchandiseOf(lines, promotions)).toBe(500);
	});

	it('spreads points, adds taxes on top and totals', () => {
		const priced = priceLines({
			lines,
			promotions: null,
			delivery: 300,
			pointsValue: 500,
			taxRules: [{ name: 'VAT', percent: 10, categoryIds: [], regions: [{ country: 'US', city: '' }] }],
			region: { country: 'us', city: 'Town' },
			taxIncluded: false,
		});
		expect(priced.lines.map((line) => [line.points, line.tax, line.total])).toEqual([
			[400, 160, 1760],
			[100, 40, 440],
		]);
		expect(priced.totals).toEqual({ subtotal: 2500, discount: 500, delivery: 300, tax: 200, total: 2500, taxIncluded: false });
	});

	it('keeps tax inside prices that include it', () => {
		const priced = priceLines({
			lines,
			promotions,
			delivery: 0,
			pointsValue: 99_999,
			taxRules: [{ name: 'Food', percent: 25, categoryIds: ['cat_food'], regions: [] }],
			region: null,
			taxIncluded: true,
		});
		expect(priced.lines.map((line) => [line.discount, line.tax, line.total])).toEqual([
			[2000, 0, 0],
			[500, 0, 0],
		]);
		const full = priceLines({
			lines,
			promotions: null,
			delivery: 0,
			pointsValue: 0,
			taxRules: [{ name: 'Food', percent: 25, categoryIds: ['cat_food'], regions: [] }],
			region: null,
			taxIncluded: true,
		});
		expect(full.lines[1]).toMatchObject({ tax: 100, total: 500 });
		expect(full.totals.total).toBe(2500);
	});
});

describe('payment methods', () => {
	const cod = {
		on: true,
		settings: { maxOrderValue: 5000, advanceAmount: 0, advancePercent: 10, rtoThreshold: 2, rtoRequireAdvance: true },
	};
	const base = {
		offered: ['online', 'bank_transfer', 'pickup'],
		paymentsConnected: true,
		cod,
		pickupPossible: true,
		deliveryMethod: /** @type {'delivery' | 'pickup' | 'none'} */ ('delivery'),
		digital: false,
		total: 1000,
		rtoCount: 0,
	};

	it('offers COD with its advance, online, transfer and pickup', () => {
		expect(paymentOptions(base)).toEqual([
			{ method: 'cod', available: true, reason: null, advance: 100 },
			{ method: 'online', available: true, reason: null, advance: 0 },
			{ method: 'bank_transfer', available: true, reason: null, advance: 0 },
			{ method: 'pickup', available: false, reason: 'needs_pickup', advance: 0 },
		]);
	});

	it('says why a method cannot be used', () => {
		const reasons = (/** @type {Partial<typeof base>} */ over) =>
			paymentOptions({ ...base, ...over }).map((option) => `${option.method}:${option.reason ?? 'ok'}`);
		expect(reasons({ deliveryMethod: 'pickup' })).toEqual(['cod:needs_delivery', 'online:ok', 'bank_transfer:ok', 'pickup:ok']);
		expect(reasons({ digital: true })).toEqual(['cod:digital_items', 'online:ok', 'bank_transfer:ok', 'pickup:needs_pickup']);
		expect(reasons({ deliveryMethod: 'pickup', digital: true }).at(-1)).toBe('pickup:digital_items');
		expect(reasons({ total: 6000 })[0]).toBe('cod:over_max');
		expect(reasons({ paymentsConnected: false, rtoCount: 3 })).toEqual(['cod:advance_unavailable', 'pickup:needs_pickup']);
		expect(reasons({ cod: { ...cod, on: false }, pickupPossible: false, offered: [] })).toEqual([]);
	});
});

describe('COD safety', () => {
	it('computes the advance', () => {
		expect(codAdvance(0, { advanceAmount: 10, advancePercent: 0 })).toBe(0);
		expect(codAdvance(1000, { advanceAmount: 300, advancePercent: 50 })).toBe(300);
		expect(codAdvance(200, { advanceAmount: 300, advancePercent: 0 })).toBe(200);
		expect(codAdvance(1001, { advanceAmount: 0, advancePercent: 10 })).toBe(101);
		expect(codAdvance(1000, { advanceAmount: 0, advancePercent: 0 })).toBe(0);
	});

	it('flags returned parcels and decides', () => {
		expect(isRtoFlagged(2, 2)).toBe(true);
		expect(isRtoFlagged(5, 0)).toBe(false);
		const settings = { maxOrderValue: 0, advanceAmount: 0, advancePercent: 0, rtoThreshold: 1, rtoRequireAdvance: true };
		expect(codDecision({ total: 10, rtoCount: 1, canCollectAdvance: true }, settings)).toEqual({
			ok: false,
			reason: 'advance_unavailable',
			flagged: true,
		});
		expect(codDecision({ total: 10, rtoCount: 1, canCollectAdvance: true }, { ...settings, rtoRequireAdvance: false })).toEqual(
			{
				ok: true,
				advance: 0,
				flagged: true,
			},
		);
		expect(codDecision({ total: 1000, rtoCount: 0, canCollectAdvance: false }, { ...settings, advancePercent: 50 })).toEqual({
			ok: true,
			advance: 0,
			flagged: false,
		});
	});
});

describe('delivery zones', () => {
	const zones = [
		{ key: 'everywhere', name: 'Everywhere', fee: 900 },
		{ key: 'city', name: 'City', cities: ['Springfield', ' springfield '], fee: 300, freeOver: 5000, minDays: 1, maxDays: 2 },
		{ key: 'centre', name: 'Centre', cities: ['Springfield'], areas: ['Downtown'], fee: 100 },
	];

	it('checks and matches the most specific zone', () => {
		const checked = checkZones(zones);
		expect(checked.ok).toBe(true);
		if (!checked.ok) return;
		expect(checked.value[1]?.cities).toEqual(['Springfield']);
		expect(matchZone(checked.value, { city: 'SPRINGFIELD', area: 'downtown' })?.key).toBe('centre');
		expect(matchZone(checked.value, { city: 'Springfield' })?.key).toBe('city');
		expect(matchZone(checked.value, { city: 'Shelbyville' })?.key).toBe('everywhere');
		expect(matchZone(checked.value.slice(1), {})).toBeNull();
		expect(zoneFee({ fee: 300, freeOver: 5000 }, 5000)).toBe(0);
		expect(zoneFee({ fee: 300, freeOver: 0 }, 99_999)).toBe(300);
		expect(zoneCities(checked.value)).toEqual(['Springfield']);
		expect(placeKey(5)).toBe('');
	});

	it.each([
		[{}, 'A list'],
		[Array.from({ length: 101 }, (_, i) => ({ key: `z${i}`, name: 'Z' })), 'At most'],
		[[{ key: 'X' }], 'Zone key'],
		[
			[
				{ key: 'zz', name: 'A' },
				{ key: 'zz', name: 'B' },
			],
			'twice',
		],
		[[{ key: 'zz', name: '' }], 'name'],
		[[{ key: 'zz', name: 'A', cities: 'x' }], 'cities'],
		[[{ key: 'zz', name: 'A', areas: [''] }], 'areas'],
		[[{ key: 'zz', name: 'A', fee: -1 }], 'fee'],
		[[{ key: 'zz', name: 'A', freeOver: 1.5 }], 'free over'],
		[[{ key: 'zz', name: 'A', minDays: 3, maxDays: 1 }], 'days'],
	])('refuses %#', (value, message) => {
		const checked = checkZones(value);
		expect(checked.ok).toBe(false);
		if (!checked.ok) expect(checked.errors.join(' ')).toContain(message);
	});
});

describe('taxes', () => {
	it('checks rules', () => {
		expect(checkTaxRules([{ name: 'VAT', percent: 7.5 }])).toEqual({
			ok: true,
			value: [{ name: 'VAT', percent: 7.5, categoryIds: [], regions: [] }],
		});
		expect(checkTaxRules('x')).toMatchObject({ ok: false });
		const errors = (/** @type {unknown} */ value) => {
			const checked = checkTaxRules(value);
			return checked.ok ? '' : checked.errors.join(' ');
		};
		expect(errors(Array.from({ length: 51 }, () => ({ name: 'T', percent: 1 })))).toContain('At most');
		expect(errors([{ name: '', percent: 1 }])).toContain('name');
		expect(errors([{ name: 'T', percent: 1.23456 }])).toContain('percent');
		expect(errors([{ name: 'T', percent: 1, categoryIds: [5] }])).toContain('categories');
		expect(errors([{ name: 'T', percent: 1, regions: 'x' }])).toContain('regions');
		expect(errors([{ name: 'T', percent: 1, regions: [{ city: 'X' }] }])).toContain('country');
	});

	it('adds up the rules that apply', () => {
		const rules = [
			{ name: 'A', percent: 10, categoryIds: [], regions: [] },
			{ name: 'B', percent: 5, categoryIds: ['cat_1'], regions: [] },
			{ name: 'C', percent: 2, categoryIds: [], regions: [{ country: 'US', city: 'Town' }] },
			{ name: 'D', percent: 90, categoryIds: [], regions: [{ country: 'US', city: '' }] },
		];
		expect(taxPercent(rules, { categoryIds: ['cat_1'], region: { country: 'us', city: 'town' } })).toBe(100);
		expect(taxPercent(rules, { categoryIds: [], region: { country: 'FR', city: 'Town' } })).toBe(10);
		expect(taxPercent(rules, { categoryIds: ['cat_1'], region: null })).toBe(15);
		expect(taxOf(1100, 10, true)).toBe(100);
		expect(taxOf(1000, 10, false)).toBe(100);
		expect(taxOf(0, 10, false)).toBe(0);
	});
});

describe('bookings', () => {
	it('checks opening hours', () => {
		expect(checkBookingHours([{ day: 1, from: '09:00', to: '24:00' }])).toEqual({
			ok: true,
			value: [{ day: 1, from: '09:00', to: '24:00' }],
		});
		const errors = (/** @type {unknown} */ value) => {
			const checked = checkBookingHours(value);
			return checked.ok ? '' : checked.errors.join(' ');
		};
		expect(errors({})).toContain('list');
		expect(errors(Array.from({ length: 71 }, () => ({ day: 1, from: '09:00', to: '10:00' })))).toContain('At most');
		expect(errors([{ day: 7, from: '09:00', to: '10:00' }])).toContain('day');
		expect(errors([{ day: 1, from: '9', to: '10:00' }])).toContain('HH:MM');
		expect(errors([{ day: 1, from: '10:00', to: '09:00' }])).toContain('end after');
		expect(errors([null])).toContain('day');
		expect(
			errors([
				{ day: 1, from: '09:00', to: '12:00' },
				{ day: 1, from: '11:00', to: '13:00' },
			]),
		).toContain('overlaps');
	});

	it('lists slots in the business time zone', () => {
		const hours = [
			{ day: 1, from: '09:00', to: '11:30' },
			{ day: 2, from: '09:00', to: '10:00' },
		];
		const monday = Date.parse('2026-10-05T00:00:00Z');
		const utc = slotsBetween({ hours, durationMinutes: 60, from: monday, to: monday + 2 * 86_400_000, timeZone: 'UTC' });
		expect(utc.map((slot) => new Date(slot.start).toISOString())).toEqual([
			'2026-10-05T09:00:00.000Z',
			'2026-10-05T10:00:00.000Z',
			'2026-10-06T09:00:00.000Z',
		]);
		const york = slotsBetween({
			hours,
			durationMinutes: 60,
			from: monday,
			to: monday + 86_400_000 * 1.5,
			timeZone: 'America/New_York',
		});
		expect(new Date(/** @type {any} */ (york[0]).start).toISOString()).toBe('2026-10-05T13:00:00.000Z');
		expect(
			slotsBetween({ hours, durationMinutes: 60, from: monday, to: monday + 86_400_000, timeZone: 'Nowhere/Land' }),
		).toHaveLength(2);
		expect(slotsBetween({ hours: [], durationMinutes: 60, from: monday, to: monday + 1, timeZone: 'UTC' })).toEqual([]);
		expect(slotAt({ hours, durationMinutes: 60, start: Date.parse('2026-10-05T10:00:00Z'), timeZone: 'UTC' })).not.toBeNull();
		expect(slotAt({ hours, durationMinutes: 60, start: Date.parse('2026-10-05T10:30:00Z'), timeZone: 'UTC' })).toBeNull();
	});

	it('converts wall-clock times', () => {
		const at = instantOf({ year: 2026, month: 3, day: 29 }, 120, 'Europe/Berlin');
		expect(wallClock(at, 'Europe/Berlin')).toMatchObject({ hour: 3, minute: 0, weekday: 0 });
	});
});

describe('digital goods', () => {
	it('names files and keys', () => {
		expect(safeFileName(' My Book (v2).pdf ')).toBe('My-Book-v2-.pdf');
		expect(safeFileName('...')).toBeNull();
		expect(safeFileName(5)).toBeNull();
		expect(fileKey('prd_1', 'a.pdf')).toBe('ecommerce/digital/prd_1/a.pdf');
		expect(fileNameOf('ecommerce/digital/prd_1/a.pdf')).toBe('a.pdf');
		expect(checkLicenceKeys([' A ', 'A', 'B'])).toEqual({ ok: true, value: ['A', 'B'] });
		expect(checkLicenceKeys([])).toMatchObject({ ok: false });
		expect(checkLicenceKeys([''])).toMatchObject({ ok: false });
	});

	it('limits downloads', () => {
		expect(downloadLimitOf({ digital: { downloadLimit: 2 } }, 5)).toBe(2);
		expect(downloadLimitOf({ digital: null }, 5)).toBe(5);
		expect(canDownload({ paymentState: 'pending', downloads: 0, limit: 1 })).toEqual({ ok: false, reason: 'not_paid' });
		expect(canDownload({ paymentState: 'paid', downloads: 1, limit: 1 })).toEqual({ ok: false, reason: 'limit_reached' });
		expect(canDownload({ paymentState: 'partially_refunded', downloads: 9, limit: 0 })).toEqual({ ok: true });
	});
});
