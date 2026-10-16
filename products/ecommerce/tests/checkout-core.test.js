/**
 * Checkout's pure rules: cart and address checks, line resolution, pricing, payment methods, delivery zones, taxes,
 * COD safety, booking slots and digital goods.
 */
import { describe, expect, it } from 'vitest';
import { checkBookingSchedules, defaultSchedules, scheduleOf, instantOf, slotAt, slotsBetween } from '../core/bookings.js';
import {
	checkAddress,
	checkCart,
	checkOrderExtras,
	merchandiseOf,
	priceLines,
	promotionDiscounts,
	resolveLines,
} from '../core/checkout.js';
import { ADDRESS_LIMITS, checkAddressRegions, countryKey, placeKey, postcodeKey, regionsFor } from '../core/address.js';
import { checkZones, defaultZones, homeRate, matchZone, rateFee, rateFits, zoneCities } from '../core/delivery.js';
import { canDownload, checkLicenceKeys, downloadLimitOf, fileKey, fileNameOf, safeFileName } from '../core/digital.js';
import { MAX_AMOUNT, zonedParts } from '@ss/contracts/format';
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
			rate: null,
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
					{ productId: 'p', quantity: 600_000_000 },
					{ productId: 'p', quantity: 600_000_000 },
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
		[{ lines: [{ productId: 'p' }], payment: 'Cheque!' }, 'payment'],
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

	it('checks an address by its country: a country picked by code or name, its region and postal code (A1, E6)', () => {
		const rules = addressRules();
		const base = { name: 'Sara', phone: '+15550001111', line1: '1 Main St', city: 'Austin' };
		expect(checkAddress({ ...base, country: 'united kingdom', postalCode: 'sw1a  1aa' }, rules)).toMatchObject({
			ok: true,
			value: { country: 'GB', postalCode: 'SW1A 1AA' },
		});
		expect(checkAddress({ ...base, country: 'Atlantis' }, rules)).toMatchObject({ ok: false, field: 'address/country' });
		// the US requires a state and a ZIP code of its own shape
		expect(checkAddress({ ...base, country: 'us', postalCode: '78701' }, rules)).toMatchObject({
			ok: false,
			field: 'address/region',
		});
		expect(checkAddress({ ...base, country: 'US', region: 'TX', postalCode: '787' }, rules)).toMatchObject({
			ok: false,
			field: 'address/postalCode',
			message: 'address.postalCode is not a postal code of the United States.',
		});
		expect(checkAddress({ ...base, country: 'US', region: 'TX', postalCode: '78701' }, rules)).toMatchObject({
			ok: true,
			value: { country: 'US', region: 'TX' },
		});
		// an address without a country is in the business.json country
		expect(checkAddress(base, addressRules({ homeCountry: 'US' }))).toMatchObject({ ok: false, field: 'address/region' });
		// no postal code is asked where the country has none, even when the website requires one
		expect(checkAddress({ ...base, country: 'AE', region: 'Dubai' }, addressRules({ required: ['postalCode'] }))).toMatchObject(
			{ ok: true },
		);
	});

	it('takes every address field up to its length in the one address table (checkout, widget, staff, imports)', () => {
		const rules = addressRules();
		const base = { name: 'Sara', phone: '+15550001111' };
		for (const [field, max] of Object.entries(ADDRESS_LIMITS)) {
			// a phone is a number and a country a country
			if (field === 'phone' || field === 'country') continue;
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
		const good = { name: 'Sara', phone: '+15550001111', line1: '1 Main St', city: 'Town', postalCode: '10001' };
		// the country by code or English name; an address without a country is in the business.json country
		expect(checkAddress({ ...good, country: 'United States', region: ' new  york ' }, addressRules({ regions }))).toMatchObject(
			{
				ok: true,
				value: { region: 'New York', country: 'US' },
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
		// another country's region is free text; the US requires its state, other countries a region only when the
		// website does
		const ontario = { ...good, country: 'CA', region: 'Ontario', postalCode: 'K1A 0B1' };
		expect(checkAddress(ontario, addressRules({ regions }))).toMatchObject({ ok: true });
		expect(checkAddress({ ...good, country: 'US' }, addressRules({ regions }))).toMatchObject({
			ok: false,
			field: 'address/region',
		});
		expect(checkAddress({ ...good, country: 'FR', postalCode: '75002' }, addressRules({ regions }))).toMatchObject({
			ok: true,
		});
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
	/** One rate of a price. @param {number} price @param {Record<string, unknown>} [over] */
	const rate = (price, over = {}) => [{ key: 'standard', name: 'Standard', price, ...over }];
	const zones = [
		{ key: 'everywhere', name: 'Everywhere', rates: rate(900) },
		{
			key: 'city',
			name: 'City',
			match: { cities: ['Springfield', ' springfield '] },
			rates: rate(300, { freeOver: 5000, minDays: 1, maxDays: 2 }),
		},
		{ key: 'centre', name: 'Centre', match: { cities: ['Springfield'], areas: ['Downtown'] }, rates: rate(100) },
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
		expect(rateFee({ price: 300, freeOver: 5000 }, 5000)).toBe(0);
		expect(rateFee({ price: 300, freeOver: 0 }, 99_999)).toBe(300);
		expect(zoneCities(checked.value)).toEqual(['Springfield']);
	});

	it('keeps named rates per zone, each with its kind, days, condition and pickup locations (E5)', () => {
		const checked = checkZones([
			{
				key: 'home',
				name: 'Home',
				rates: [
					{ key: 'standard', name: ' Standard ', price: 500, freeOver: 10_000, minDays: 2, maxDays: 4 },
					{ key: 'express', name: 'Express', price: 1500, minDays: 1, condition: { by: 'weight', min: 0, max: 5000 } },
					{ key: 'bulky', name: 'Bulky', price: 4000, condition: { by: 'weight', min: 5001 } },
					{ key: 'small_orders', name: 'Small orders', price: 200, condition: { by: 'value', min: 0, max: 2000 } },
					{ key: 'pickup', name: 'Pickup', kind: 'pickup', locations: ['loc_1', 'loc_1'] },
				],
			},
		]);
		expect(checked.ok).toBe(true);
		if (!checked.ok) return;
		const [standard, express, bulky, small, pickup] = /** @type {any[]} */ (checked.value[0]?.rates ?? []);
		expect(standard).toEqual({
			key: 'standard',
			name: 'Standard',
			kind: 'delivery',
			price: 500,
			freeOver: 10_000,
			minDays: 2,
			maxDays: 4,
			condition: { by: 'none', min: 0, max: 0 },
			locations: [],
		});
		// one number of days is that many; none is not said
		expect([express.minDays, express.maxDays, bulky.minDays, bulky.maxDays]).toEqual([1, 1, null, null]);
		expect(pickup).toMatchObject({ kind: 'pickup', price: 0, locations: ['loc_1'] });
		// a condition fits from min to max, both included; max 0 = no upper end
		const cart = (/** @type {number} */ weightG, /** @type {number} */ value) => ({ weightG, value });
		expect(rateFits(express, cart(5000, 0))).toBe(true);
		expect(rateFits(express, cart(5001, 0))).toBe(false);
		expect(rateFits(bulky, cart(99_999_999, 0))).toBe(true);
		expect(rateFits(bulky, cart(5000, 0))).toBe(false);
		expect(rateFits(small, cart(0, 2000))).toBe(true);
		expect(rateFits(small, cart(0, 2001))).toBe(false);
		expect(rateFits(standard, cart(10 ** 9, 10 ** 9))).toBe(true);
	});

	it("seeds one zone for every place with today's free Standard rate and pickup", () => {
		const seeded = defaultZones();
		expect(checkZones(seeded)).toEqual({ ok: true, value: seeded });
		expect(seeded[0]?.rates.map((entry) => [entry.key, entry.name, entry.kind, entry.price])).toEqual([
			['standard', 'Standard', 'delivery', 0],
			['pickup', 'Pickup', 'pickup', 0],
		]);
		expect(matchZone(seeded, placeAt({ country: 'JP', city: 'Kyoto' }))?.key).toBe('everywhere');
	});

	it('tells search engines the first plain delivery rate of the business country', () => {
		const checked = checkZones([
			{ key: 'abroad', name: 'Abroad', rates: rate(3000) },
			{
				key: 'home',
				name: 'Home',
				match: { countries: ['DE'] },
				rates: [
					{ key: 'pickup', name: 'Pickup', kind: 'pickup' },
					{ key: 'light', name: 'Light', price: 300, condition: { by: 'weight', min: 0, max: 1000 } },
					{ key: 'standard', name: 'Standard', price: 500, minDays: 1, maxDays: 2 },
				],
			},
		]);
		if (!checked.ok) throw new Error(checked.errors.join(' '));
		expect(homeRate(checked.value, 'DE')?.key).toBe('standard');
		expect(homeRate(checked.value, 'FR')?.price).toBe(3000);
		expect(homeRate(checked.value.slice(1), 'FR')).toBeNull();
	});

	it('wins by the longest postcode start, then area, city, region, country, then the catch-all', () => {
		const checked = checkZones([
			{ key: 'all', name: 'All', rates: rate(1) },
			{ key: 'gb', name: 'UK', match: { countries: ['United Kingdom'] }, rates: rate(2) },
			{ key: 'england', name: 'England', match: { countries: ['GB'], regions: ['England'] }, rates: rate(3) },
			{ key: 'london', name: 'London', match: { cities: ['London'] }, rates: rate(4) },
			{ key: 'soho', name: 'Soho', match: { cities: ['London'], areas: ['Soho'] }, rates: rate(5) },
			{ key: 'sw', name: 'SW', match: { postcodes: ['sw'] }, rates: rate(6) },
			{ key: 'sw1', name: 'SW1', match: { postcodes: ['SW1 '] }, rates: rate(7) },
			{ key: 'sw1_us', name: 'SW1 abroad', match: { countries: ['US'], postcodes: ['SW1A'] }, rates: rate(8) },
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
			{ key: 'first', name: 'A', match: { cities: ['Lyon'] }, rates: rate(1) },
			{ key: 'second', name: 'B', match: { cities: ['lyon'] }, rates: rate(2) },
		]);
		expect(twins.ok && matchZone(twins.value, placeAt({ city: 'LYON' }))?.key).toBe('first');
	});

	const one = (/** @type {Record<string, unknown>} */ over) => [{ key: 'zz', name: 'A', rates: rate(0), ...over }];
	const withRate = (/** @type {Record<string, unknown>} */ over) => one({ rates: rate(0, over) });
	it.each([
		[{}, 'A list'],
		[Array.from({ length: 101 }, (_, i) => ({ key: `z${i}`, name: 'Z', rates: rate(0) })), 'At most'],
		[[{ key: 'X' }], 'Zone key'],
		[[...one({}), ...one({ name: 'B' })], 'twice'],
		[one({ name: '' }), 'name'],
		[one({ match: { cities: 'x' } }), 'cities'],
		[one({ match: { areas: [''] } }), 'areas'],
		[one({ match: { postcodes: ['1'.repeat(21)] } }), 'postcodes'],
		[one({ match: { towns: ['x'] } }), 'match takes'],
		[one({ match: 'x' }), 'match lists'],
		[one({ rates: [] }), 'rates is a list'],
		[one({ rates: undefined }), 'rates is a list'],
		[one({ rates: Array.from({ length: 21 }, (_, i) => ({ key: `r${i}`, name: 'R' })) }), 'rates is a list'],
		[one({ rates: [{ key: 'R', name: 'R' }] }), 'rate key'],
		[one({ rates: [...rate(0), ...rate(1)] }), 'listed twice'],
		[withRate({ name: '' }), 'needs a name'],
		[withRate({ kind: 'drone' }), 'the kind'],
		[withRate({ price: -1 }), 'price'],
		[withRate({ freeOver: 1.5 }), 'free over'],
		[withRate({ minDays: 3, maxDays: 1 }), 'days'],
		[withRate({ minDays: 400 }), 'days'],
		[withRate({ condition: 'heavy' }), 'condition is {'],
		[withRate({ condition: { by: 'size' } }), 'condition is by'],
		[withRate({ condition: { by: 'value', min: 500, max: 100 } }), 'whole min'],
		[withRate({ condition: { by: 'weight', min: 0, max: 1e10 } }), 'whole min'],
		[withRate({ locations: ['loc_1'] }), 'only a pickup rate'],
		[withRate({ kind: 'pickup', locations: 'loc_1' }), 'locations is a list'],
		[withRate({ kind: 'pickup', locations: ['bad id'] }), 'locations is a list'],
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
	/** Weekly hours only. @param {Array<{ day: number, start: string, end: string }>} weekly */
	const only = (weekly) => ({ weekly, exceptions: [] });

	it("checks schedules: weekly windows by ISO weekday and dated exceptions, in the shape of Chat's office hours (E30)", () => {
		const schedule = {
			key: 'downtown',
			name: ' Downtown ',
			weekly: [{ day: 7, start: '09:00', end: '24:00' }],
			exceptions: [
				{ date: '2026-12-25', name: 'Christmas' },
				{ date: '2026-12-24', name: 'Christmas Eve', hours: [{ start: '09:00', end: '12:00' }] },
			],
		};
		expect(checkBookingSchedules([schedule])).toEqual({
			ok: true,
			value: [
				{
					key: 'downtown',
					name: 'Downtown',
					weekly: [{ day: 7, start: '09:00', end: '24:00' }],
					// sorted by date; no hours = closed all day
					exceptions: [
						{ date: '2026-12-24', name: 'Christmas Eve', hours: [{ start: '09:00', end: '12:00' }] },
						{ date: '2026-12-25', name: 'Christmas', hours: [] },
					],
				},
			],
		});
		expect(checkBookingSchedules(defaultSchedules())).toEqual({ ok: true, value: defaultSchedules() });
		const errors = (/** @type {unknown} */ value) => {
			const checked = checkBookingSchedules(value);
			return checked.ok ? '' : checked.errors.join(' ');
		};
		/** One schedule with these parts. @param {Record<string, unknown>} over */
		const one = (over) => [{ key: 'main', name: 'Main', ...over }];
		expect(errors({})).toContain('list');
		expect(errors([])).toContain('list');
		expect(errors(Array.from({ length: 21 }, (_, i) => ({ key: `s${i}`, name: 'S' })))).toContain('list');
		expect(errors([{ key: 'X', name: 'x' }])).toContain('Schedule key');
		expect(errors([...one({}), ...one({})])).toContain('twice');
		expect(errors(one({ name: '' }))).toContain('name');
		expect(errors(one({ weekly: Array.from({ length: 71 }, () => ({ day: 1, start: '09:00', end: '10:00' })) }))).toContain(
			'at most 70',
		);
		expect(errors(one({ weekly: [{ day: 0, start: '09:00', end: '10:00' }] }))).toContain('1 (Monday)');
		expect(errors(one({ weekly: [{ day: 1, start: '9', end: '10:00' }] }))).toContain('HH:MM');
		expect(errors(one({ weekly: [{ day: 1, start: '10:00', end: '09:00' }] }))).toContain('later end');
		expect(errors(one({ weekly: [null] }))).toContain('1 (Monday)');
		expect(
			errors(
				one({
					weekly: [
						{ day: 1, start: '09:00', end: '12:00' },
						{ day: 1, start: '11:00', end: '13:00' },
					],
				}),
			),
		).toContain('overlap');
		expect(errors(one({ exceptions: [{ date: '2026-02-30' }] }))).toContain('real date');
		expect(errors(one({ exceptions: [{ date: '2026-02-03' }, { date: '2026-02-03' }] }))).toContain('once');
		expect(errors(one({ exceptions: [{ date: '2026-02-03', name: 'x'.repeat(81) }] }))).toContain('name');
		expect(errors(one({ exceptions: [{ date: '2026-02-03', hours: [{ start: '12:00', end: '11:00' }] }] }))).toContain(
			'later end',
		);
	});

	it('finds the schedule of a service: the one it names, else the first; none when it is gone', () => {
		const schedules = [
			{ key: 'main', name: 'Main', weekly: [], exceptions: [] },
			{ key: 'branch', name: 'Branch', weekly: [], exceptions: [] },
		];
		expect(scheduleOf(schedules, '')?.key).toBe('main');
		expect(scheduleOf(schedules, 'branch')?.key).toBe('branch');
		expect(scheduleOf(schedules, 'gone')).toBeNull();
		expect(scheduleOf([], '')).toBeNull();
	});

	it('lists slots in the business time zone', () => {
		const hours = only([
			{ day: 1, start: '09:00', end: '11:30' },
			{ day: 2, start: '09:00', end: '10:00' },
		]);
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
		expect(slotsBetween({ hours: only([]), durationMinutes: 60, from: monday, to: monday + 1, timeZone: 'UTC' })).toEqual([]);
		expect(slotAt({ hours, durationMinutes: 60, start: Date.parse('2026-10-05T10:00:00Z'), timeZone: 'UTC' })).not.toBeNull();
		expect(slotAt({ hours, durationMinutes: 60, start: Date.parse('2026-10-05T10:30:00Z'), timeZone: 'UTC' })).toBeNull();
		// Sunday is day 7
		const sunday = slotsBetween({
			hours: only([{ day: 7, start: '10:00', end: '11:00' }]),
			durationMinutes: 60,
			from: monday - 86_400_000,
			to: monday,
			timeZone: 'UTC',
		});
		expect(sunday.map((slot) => new Date(slot.start).toISOString())).toEqual(['2026-10-04T10:00:00.000Z']);
	});

	it("replaces a date's weekly hours with its exception: closed all day, or special hours (E30)", () => {
		const hours = {
			weekly: [
				{ day: 1, start: '09:00', end: '11:00' },
				{ day: 2, start: '09:00', end: '11:00' },
			],
			exceptions: [
				{ date: '2026-10-05', name: 'Holiday', hours: [] },
				{ date: '2026-10-06', name: 'Short day', hours: [{ start: '14:00', end: '15:00' }] },
				// a date with no weekly hours can open
				{ date: '2026-10-10', name: 'Open Saturday', hours: [{ start: '10:00', end: '11:00' }] },
			],
		};
		const monday = Date.parse('2026-10-05T00:00:00Z');
		const week = slotsBetween({ hours, durationMinutes: 60, from: monday, to: monday + 7 * 86_400_000, timeZone: 'UTC' });
		expect(week.map((slot) => new Date(slot.start).toISOString())).toEqual([
			'2026-10-06T14:00:00.000Z',
			'2026-10-10T10:00:00.000Z',
		]);
		// the dates are the business time zone's: 2026-10-05 in Tokyo starts at 15:00 UTC the day before
		const tokyo = slotsBetween({
			hours: { weekly: [], exceptions: [{ date: '2026-10-05', name: '', hours: [{ start: '00:00', end: '01:00' }] }] },
			durationMinutes: 60,
			from: monday - 86_400_000,
			to: monday + 86_400_000,
			timeZone: 'Asia/Tokyo',
		});
		expect(tokyo.map((slot) => new Date(slot.start).toISOString())).toEqual(['2026-10-04T15:00:00.000Z']);
	});

	it('converts wall-clock times', () => {
		const at = instantOf({ year: 2026, month: 3, day: 29 }, 120, 'Europe/Berlin');
		expect(zonedParts(at, 'Europe/Berlin')).toMatchObject({ hour: 3, minute: 0, weekday: 0 });
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
