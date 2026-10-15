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
import { ADDRESS_LIMITS, checkAddressRegions, countryKey, placeKey, postcodeKey, regionsFor } from '../core/address.js';
import { checkZones, matchZone, zoneCities, zoneFee } from '../core/delivery.js';
import { canDownload, checkLicenceKeys, downloadLimitOf, fileKey, fileNameOf, safeFileName } from '../core/digital.js';
import { MAX_AMOUNT } from '../core/money.js';
import { checkTaxRules, taxOf, taxPercent } from '../core/taxes.js';

/** @returns {any} */
const variant = (over = {}) => ({
	id: 'var_1',
	sku: 'SKU1',
	options: { Color: 'Red', Size: 'M' },
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
	// services are booked in time slots unless a test says otherwise (their item type's `slots`)
	slots: (/** @type {any} */ product) => product.kind === 'service',
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
			{ productId: 'prd_1', variantId: null, quantity: 5, slot: null, dealId: null, lock: null },
			{
				productId: 'prd_2',
				variantId: 'var_2',
				quantity: 1,
				slot: Date.parse('2026-10-06T10:00:00Z'),
				dealId: null,
				lock: null,
			},
		]);
		expect(checked.value.coupon).toBe('SAVE10');
		expect(checked.value.delivery).toEqual({
			method: 'pickup',
			city: 'X',
			area: '',
			region: '',
			postalCode: '',
			country: '',
			locationId: 'loc_1',
		});
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
		[{ lines: [{ productId: 'p' }], delivery: { city: 'x'.repeat(101) } }, 'delivery/city'],
		[{ lines: [{ productId: 'p' }], delivery: { locationId: 'a b' } }, 'delivery/locationId'],
		[{ lines: [{ productId: 'p' }], payment: 'cheque' }, 'payment'],
	])('refuses %j', (body, field) => {
		const checked = checkCart(body);
		expect(checked.ok).toBe(false);
		if (!checked.ok) expect(checked.field).toBe(field);
	});

	/**
	 * A website's address rules.
	 * @param {Partial<import('../core/checkout.js').AddressRules>} [over]
	 * @returns {import('../core/checkout.js').AddressRules}
	 */
	const addressRules = (over = {}) => ({
		required: [],
		phoneRequired: true,
		phoneRules: { defaultCallingCode: '', trunkPrefix: '' },
		regions: [],
		homeCountry: '',
		...over,
	});

	it('checks addresses, with the phone as E.164 when the website can read it (K12), else as typed', () => {
		const rules = addressRules();
		const good = { name: 'Sara', phone: '+1 555 000 1111', line1: '1 Main St', city: 'Town', notes: 'Ring' };
		expect(checkAddress(good, rules)).toMatchObject({
			ok: true,
			value: { name: 'Sara', phone: '+15550001111', area: '', region: '', country: '' },
		});
		expect(checkAddress(null, rules)).toMatchObject({ ok: false, field: 'address' });
		expect(checkAddress({ ...good, name: '' }, rules)).toMatchObject({ ok: false, field: 'address/name' });
		expect(checkAddress({ ...good, line1: 'x'.repeat(201) }, rules)).toMatchObject({ ok: false, field: 'address/line1' });
		expect(checkAddress(good, addressRules({ required: ['postalCode'] }))).toMatchObject({
			ok: false,
			field: 'address/postalCode',
		});
		expect(checkAddress({ ...good, phone: 'call me' }, rules)).toMatchObject({ ok: false, field: 'address/phone' });
		// with no calling code a national number is kept as typed (the courier calls it)
		expect(checkAddress({ ...good, phone: '07700 900123' }, rules)).toMatchObject({
			ok: true,
			value: { phone: '07700 900123' },
		});
		const gb = addressRules({ phoneRules: { defaultCallingCode: '+44', trunkPrefix: '' } });
		for (const phone of ['447700900123', '+44 07700 900456', '07700900123', '07700-900123'])
			expect(checkAddress({ ...good, phone }, gb)).toMatchObject({ ok: true });
		expect(checkAddress({ ...good, phone: '+44 07700 900456' }, gb)).toMatchObject({ value: { phone: '+447700900456' } });
		expect(checkAddress({ ...good, phone: '447700900123' }, gb)).toMatchObject({ value: { phone: '+447700900123' } });
	});

	it('takes every address field up to its length in the one address table (checkout, widget, staff, imports)', () => {
		const rules = addressRules();
		const base = { name: 'Sara', phone: '+15550001111' };
		for (const [field, max] of Object.entries(ADDRESS_LIMITS)) {
			if (field === 'phone') continue;
			expect(checkAddress({ ...base, [field]: 'x'.repeat(max) }, rules), field).toMatchObject({ ok: true });
			expect(checkAddress({ ...base, [field]: 'x'.repeat(max + 1) }, rules), field).toMatchObject({
				ok: false,
				field: `address/${field}`,
			});
		}
		// a city or area of 100 characters, as staff edits and imports always took
		expect(ADDRESS_LIMITS).toMatchObject({ city: 100, area: 100, region: 100, phone: 40, postalCode: 20 });
		expect(
			checkCart({ lines: [{ productId: 'p' }], delivery: { city: 'x'.repeat(100), region: 'y'.repeat(100) } }),
		).toMatchObject({
			ok: true,
			value: { delivery: { city: 'x'.repeat(100), region: 'y'.repeat(100), postalCode: '' } },
		});
		expect(checkCart({ lines: [{ productId: 'p' }], delivery: { postalCode: '1'.repeat(21) } })).toMatchObject({
			ok: false,
			field: 'delivery/postalCode',
		});
	});

	it('needs a phone only while phoneRequired is on, and requires the region when the merchant does', () => {
		const good = { name: 'Sara', line1: '1 Main St', city: 'Town' };
		expect(checkAddress(good, addressRules())).toMatchObject({ ok: false, field: 'address/phone' });
		expect(checkAddress(good, addressRules({ phoneRequired: false }))).toMatchObject({ ok: true, value: { phone: '' } });
		expect(checkAddress(good, addressRules({ phoneRequired: false, required: ['region'] }))).toMatchObject({
			ok: false,
			field: 'address/region',
		});
	});

	it('takes a region of the address_regions list in a listed country, as the list spells it', () => {
		const regions = [{ country: 'US', names: ['California', 'New York'] }];
		const good = { name: 'Sara', phone: '+15550001111', line1: '1 Main St', city: 'Town' };
		// the country by code or English name; an address without a country is in the business.json country
		expect(checkAddress({ ...good, country: 'United States', region: ' new  york ' }, addressRules({ regions }))).toMatchObject(
			{
				ok: true,
				value: { region: 'New York' },
			},
		);
		expect(checkAddress({ ...good, region: 'california' }, addressRules({ regions, homeCountry: 'US' }))).toMatchObject({
			ok: true,
			value: { region: 'California' },
		});
		expect(checkAddress({ ...good, country: 'us', region: 'Ontario' }, addressRules({ regions }))).toMatchObject({
			ok: false,
			field: 'address/region',
		});
		// another country's region is free text; an empty region stays allowed unless required
		expect(checkAddress({ ...good, country: 'CA', region: 'Ontario' }, addressRules({ regions }))).toMatchObject({ ok: true });
		expect(checkAddress({ ...good, country: 'US' }, addressRules({ regions }))).toMatchObject({ ok: true });
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

	it('takes the total the shopper was shown (CK-14)', () => {
		expect(checkOrderExtras({ payment: 'cod', expectedTotal: 0 })).toMatchObject({ ok: true, value: { expectedTotal: 0 } });
		expect(checkOrderExtras({ payment: 'cod', expectedTotal: 465_200 })).toMatchObject({ value: { expectedTotal: 465_200 } });
		expect(checkOrderExtras({ payment: 'cod', expectedTotal: null })).not.toHaveProperty('value.expectedTotal');
		for (const bad of [-1, 1.5, '100', MAX_AMOUNT + 1])
			expect(checkOrderExtras({ payment: 'cod', expectedTotal: bad })).toMatchObject({ ok: false, field: 'expectedTotal' });
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
					productOf({ id: 'prd_book', kind: 'service', booking: { durationMinutes: 30 } }),
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

	it('checks booking slots and license keys', () => {
		const booking = productOf({ id: 'prd_book', kind: 'service', trackStock: false, booking: { durationMinutes: 60 } });
		const digital = productOf({
			id: 'prd_dig',
			kind: 'digital',
			trackStock: false,
			digital: { files: [], retired: [], licenceKeys: true, downloadLimit: 0 },
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

	it('sells a service whose item type books no slots without a time, several at once', () => {
		const service = productOf({ id: 'prd_fix', kind: 'service', trackStock: false, booking: null });
		const lines = resolveLines(
			[
				{ productId: 'prd_fix', variantId: null, quantity: 2, slot: null },
				{ productId: 'prd_fix', variantId: null, quantity: 1, slot: Date.parse('2026-10-06T10:00:00Z') },
			],
			context([service], { slots: () => false }),
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ kind: 'service', quantity: 3, booking: null, problems: [], priced: true });
		// Services and bookings off: no service is sold
		const off = resolveLines(
			[{ productId: 'prd_fix', variantId: null, quantity: 1, slot: null }],
			context([service], { slots: () => false, features: { digital: true, bookings: false } }),
		);
		expect(off[0]?.problems[0]?.code).toBe('unavailable');
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
			taxRules: [
				{ name: 'VAT', percent: 10, categoryIds: [], regions: [{ country: 'US', region: '', city: '', postcode: '' }] },
			],
			region: placeAt({ country: 'us', city: 'Town' }),
			taxIncluded: false,
		});
		expect(priced.lines.map((line) => [line.points, line.tax, line.total])).toEqual([
			[400, 160, 1760],
			[100, 40, 440],
		]);
		expect(priced.totals).toEqual({
			subtotal: 2500,
			discount: 500,
			roleDiscount: 0,
			delivery: 300,
			fee: 0,
			tax: 200,
			total: 2500,
			taxIncluded: false,
		});
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

	it('offers online, transfer, COD with its advance and pickup, in that order by default', () => {
		expect(paymentOptions(base)).toEqual([
			{ method: 'online', available: true, reason: null, advance: 0, fee: 0 },
			{ method: 'bank_transfer', available: true, reason: null, advance: 0, fee: 0 },
			{ method: 'cod', available: true, reason: null, advance: 100, fee: 0 },
			{ method: 'pickup', available: false, reason: 'needs_pickup', advance: 0, fee: 0 },
		]);
	});

	it('says why a method cannot be used', () => {
		const reasons = (/** @type {Partial<typeof base>} */ over) =>
			paymentOptions({ ...base, ...over }).map((option) => `${option.method}:${option.reason ?? 'ok'}`);
		expect(reasons({ deliveryMethod: 'pickup' })).toEqual(['online:ok', 'bank_transfer:ok', 'cod:needs_delivery', 'pickup:ok']);
		expect(reasons({ digital: true })).toEqual(['online:ok', 'bank_transfer:ok', 'cod:digital_items', 'pickup:needs_pickup']);
		expect(reasons({ deliveryMethod: 'pickup', digital: true }).at(-1)).toBe('pickup:digital_items');
		expect(reasons({ total: 6000 })[2]).toBe('cod:over_max');
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

	it('flags returned packages and decides', () => {
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

/**
 * A place.
 * @param {Partial<import('../core/address.js').Place>} [over]
 * @returns {import('../core/address.js').Place}
 */
const placeAt = (over = {}) => ({ country: '', region: '', city: '', area: '', postalCode: '', ...over });

describe('addresses', () => {
	it('compares places, postcodes and countries', () => {
		expect(placeKey('  New   York ')).toBe('new york');
		expect(placeKey(5)).toBe('');
		expect(postcodeKey(' sw1a 1aa ')).toBe('SW1A1AA');
		expect(countryKey('pk')).toBe('PK');
		expect(countryKey('Pakistan')).toBe('PK');
		expect(countryKey(' united  states ')).toBe('US');
		expect(countryKey('Atlantis')).toBe('atlantis');
		expect(countryKey('')).toBe('');
	});

	it('checks the address_regions list and finds a country’s regions', () => {
		const checked = checkAddressRegions([{ country: 'US', names: [' California ', 'california', 'Texas'] }]);
		expect(checked).toEqual({ ok: true, value: [{ country: 'US', names: ['California', 'Texas'] }] });
		if (!checked.ok) return;
		expect(regionsFor(checked.value, 'United States')).toEqual(['California', 'Texas']);
		expect(regionsFor(checked.value, 'CA')).toBeNull();
		expect(regionsFor(checked.value, '')).toBeNull();
		const errors = (/** @type {unknown} */ value) => {
			const found = checkAddressRegions(value);
			return found.ok ? '' : found.errors.join(' ');
		};
		expect(errors('x')).toContain('list');
		expect(errors([{ country: '', names: ['A'] }])).toContain('country');
		expect(errors([{ country: 'US', names: [] }])).toContain('region names');
		expect(errors([{ country: 'US', names: ['x'.repeat(101)] }])).toContain('1–100');
		expect(
			errors([
				{ country: 'US', names: ['A'] },
				{ country: 'United States', names: ['B'] },
			]),
		).toContain('twice');
	});
});

describe('delivery zones', () => {
	const zones = [
		{ key: 'everywhere', name: 'Everywhere', fee: 900 },
		{
			key: 'city',
			name: 'City',
			match: { cities: ['Springfield', ' springfield '] },
			fee: 300,
			freeOver: 5000,
			minDays: 1,
			maxDays: 2,
		},
		{ key: 'centre', name: 'Centre', match: { cities: ['Springfield'], areas: ['Downtown'] }, fee: 100 },
	];

	it('checks and matches the most specific zone', () => {
		const checked = checkZones(zones);
		expect(checked.ok).toBe(true);
		if (!checked.ok) return;
		expect(checked.value[1]?.match).toEqual({
			countries: [],
			regions: [],
			cities: ['Springfield'],
			areas: [],
			postcodes: [],
		});
		expect(matchZone(checked.value, placeAt({ city: 'SPRINGFIELD', area: 'downtown' }))?.key).toBe('centre');
		expect(matchZone(checked.value, placeAt({ city: 'Springfield' }))?.key).toBe('city');
		expect(matchZone(checked.value, placeAt({ city: 'Shelbyville' }))?.key).toBe('everywhere');
		expect(matchZone(checked.value.slice(1), placeAt())).toBeNull();
		expect(zoneFee({ fee: 300, freeOver: 5000 }, 5000)).toBe(0);
		expect(zoneFee({ fee: 300, freeOver: 0 }, 99_999)).toBe(300);
		expect(zoneCities(checked.value)).toEqual(['Springfield']);
	});

	it('wins by the longest postcode start, then area, city, region, country, then the catch-all', () => {
		const checked = checkZones([
			{ key: 'all', name: 'All', fee: 1 },
			{ key: 'gb', name: 'UK', match: { countries: ['United Kingdom'] }, fee: 2 },
			{ key: 'england', name: 'England', match: { countries: ['GB'], regions: ['England'] }, fee: 3 },
			{ key: 'london', name: 'London', match: { cities: ['London'] }, fee: 4 },
			{ key: 'soho', name: 'Soho', match: { cities: ['London'], areas: ['Soho'] }, fee: 5 },
			{ key: 'sw', name: 'SW', match: { postcodes: ['sw'] }, fee: 6 },
			{ key: 'sw1', name: 'SW1', match: { postcodes: ['SW1 '] }, fee: 7 },
			{ key: 'sw1_us', name: 'SW1 abroad', match: { countries: ['US'], postcodes: ['SW1A'] }, fee: 8 },
		]);
		expect(checked.ok).toBe(true);
		if (!checked.ok) return;
		const zone = (/** @type {Partial<import('../core/address.js').Place>} */ over) =>
			matchZone(checked.value, placeAt(over))?.key;
		// the postcodes compare upper-cased without spaces; the longest start the postcode has wins
		expect(zone({ country: 'GB', city: 'London', area: 'Soho', postalCode: 'sw1a 1aa' })).toBe('sw1');
		expect(zone({ country: 'GB', city: 'London', area: 'Soho', postalCode: 'SW9 1AA' })).toBe('sw');
		// a zone fits only when the address is in every kind of place it lists (SW1A abroad is in the US only)
		expect(zone({ country: 'US', postalCode: 'SW1A1AA' })).toBe('sw1_us');
		expect(zone({ country: 'GB', city: 'London', area: 'Soho', postalCode: 'W1D 3QF' })).toBe('soho');
		expect(zone({ country: 'GB', region: 'England', city: 'London', area: 'Camden' })).toBe('london');
		expect(zone({ country: 'gb', region: 'england', city: 'Leeds' })).toBe('england');
		expect(zone({ country: 'United Kingdom', region: 'Scotland' })).toBe('gb');
		expect(zone({ country: 'FR', city: 'Paris' })).toBe('all');
		// equals: the first in the list
		const twins = checkZones([
			{ key: 'first', name: 'A', match: { cities: ['Lyon'] }, fee: 1 },
			{ key: 'second', name: 'B', match: { cities: ['lyon'] }, fee: 2 },
		]);
		expect(twins.ok && matchZone(twins.value, placeAt({ city: 'LYON' }))?.key).toBe('first');
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
		[[{ key: 'zz', name: 'A', match: { cities: 'x' } }], 'cities'],
		[[{ key: 'zz', name: 'A', match: { areas: [''] } }], 'areas'],
		[[{ key: 'zz', name: 'A', match: { postcodes: ['1'.repeat(21)] } }], 'postcodes'],
		[[{ key: 'zz', name: 'A', match: { towns: ['x'] } }], 'match takes'],
		[[{ key: 'zz', name: 'A', match: 'x' }], 'match lists'],
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
		expect(checkTaxRules([{ name: 'VAT', percent: 7.5, regions: [{ country: ' GB ', postcode: 'sw1 a' }] }])).toEqual({
			ok: true,
			value: [
				{ name: 'VAT', percent: 7.5, categoryIds: [], regions: [{ country: 'GB', region: '', city: '', postcode: 'SW1A' }] },
			],
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
		expect(errors([{ name: 'T', percent: 1, regions: [{ country: 'US', region: 'x'.repeat(101) }] }])).toContain('country');
	});

	it('adds up the rules that apply, by country, region, city and postcode start', () => {
		const at = (/** @type {Partial<import('../core/address.js').Place>} */ over) => placeAt(over);
		const entry = (/** @type {Partial<import('../core/taxes.js').TaxRegion>} */ over) => ({
			country: '',
			region: '',
			city: '',
			postcode: '',
			...over,
		});
		const rules = [
			{ name: 'A', percent: 10, categoryIds: [], regions: [] },
			{ name: 'B', percent: 5, categoryIds: ['cat_1'], regions: [] },
			{ name: 'C', percent: 2, categoryIds: [], regions: [entry({ country: 'US', city: 'Town' })] },
			{ name: 'D', percent: 60, categoryIds: [], regions: [entry({ country: 'US' })] },
			{ name: 'E', percent: 7, categoryIds: [], regions: [entry({ country: 'United States', region: 'California' })] },
			{ name: 'F', percent: 1, categoryIds: [], regions: [entry({ country: 'US', postcode: '941' })] },
		];
		expect(taxPercent(rules, { categoryIds: ['cat_1'], region: at({ country: 'us', city: 'town' }) })).toBe(77);
		expect(
			taxPercent(rules, { categoryIds: [], region: at({ country: 'US', region: 'california', postalCode: '94105' }) }),
		).toBe(78);
		expect(taxPercent(rules, { categoryIds: [], region: at({ country: 'US', region: 'Texas', postalCode: '75001' }) })).toBe(
			70,
		);
		expect(taxPercent(rules, { categoryIds: [], region: at({ country: 'FR', city: 'Town' }) })).toBe(10);
		// no place: only the rules without regions; a place without a country: none of the regional rules
		expect(taxPercent(rules, { categoryIds: ['cat_1'], region: null })).toBe(15);
		expect(taxPercent(rules, { categoryIds: [], region: at({ city: 'Town' }) })).toBe(10);
		// at most 100
		expect(
			taxPercent([...rules, { name: 'G', percent: 50, categoryIds: [], regions: [] }], {
				categoryIds: [],
				region: at({ country: 'US' }),
			}),
		).toBe(100);
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
