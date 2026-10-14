/**
 * Item types (PLAN 0.8.10 dynamic model §1, phase 4): the `item_types` list check, the built-in types (today's behavior:
 * every element the features allow, no numbered units), which type a product has (its own, its category's, the
 * built-in one of its kind), the elements that work while their features are on, and what saving the list would break.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILT_IN_TYPES, checkItemTypes, elementsOf, typeChangeProblems, typeOf, typeTakes } from '../core/item-types.js';
import { checkGrades, gradeForType, gradeTypes } from '../core/grades.js';
import { readyShop } from './helpers.js';

/** @param {unknown} value @returns {any[]} */
const types = (value) => {
	const checked = checkItemTypes(value);
	if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
	return checked.value;
};
/** @param {unknown} value */
const problems = (value) => {
	const checked = checkItemTypes(value);
	return checked.ok ? [] : checked.errors.map((error) => error.path);
};

const PHONE = {
	key: 'used_phone',
	name: 'Used phone',
	kind: 'physical',
	elements: {
		variants: true,
		grades: true,
		parcel: true,
		warranty: true,
		units: { fieldIds: ['att_imei'], capture: 'packing', requiredBefore: 'shipped' },
	},
	fieldIds: ['att_battery'],
};

/** Every feature on. */
const ALL_ON = () => true;

describe('the item types list', () => {
	it('keeps a type with its elements, the elements left out off, and its fields', () => {
		const [phone] = types([PHONE]);
		expect(phone).toEqual({
			key: 'used_phone',
			name: 'Used phone',
			kind: 'physical',
			active: true,
			elements: {
				variants: true,
				grades: true,
				units: { fieldIds: ['att_imei'], capture: 'packing', requiredBefore: 'shipped' },
				chart: false,
				parcel: true,
				warranty: true,
				downloads: false,
				licenceKeys: false,
				slots: false,
			},
			fieldIds: ['att_battery'],
		});
		// units picked from stock are needed when packing; typed ones by default before dispatch
		expect(types([{ key: 'a', name: 'A', elements: { units: {} } }])[0].elements.units).toEqual({
			fieldIds: [],
			capture: 'stock',
			requiredBefore: 'packed',
		});
		expect(types([{ key: 'a', name: 'A', elements: { units: { capture: 'packing' } } }])[0].elements.units).toMatchObject({
			requiredBefore: 'shipped',
		});
		expect(
			types([{ key: 'a', name: 'A', elements: { units: { capture: 'packing', requiredBefore: null } } }])[0].elements.units,
		).toMatchObject({ requiredBefore: null });
		expect(types([])).toEqual([]);
	});

	it('refuses wrong keys, names, kinds, elements of another kind and too many fields, with their paths', () => {
		expect(checkItemTypes({}).ok).toBe(false);
		expect(checkItemTypes(Array.from({ length: 51 }, (_, n) => ({ key: `t${n}`, name: 'T' }))).ok).toBe(false);
		expect(problems([{ key: 'Bad key', name: '' }])).toEqual(['/value/0/name', '/value/0/key']);
		expect(problems([{ key: 'physical', name: 'P' }])).toEqual(['/value/0/key']);
		expect(problems([PHONE, PHONE])).toEqual(['/value/1/key']);
		expect(problems([{ key: 'a', name: 'A', kind: 'booking' }])).toEqual(['/value/0/kind']);
		expect(problems([{ key: 'a', name: 'A', active: 'yes' }])).toEqual(['/value/0/active']);
		expect(problems([{ key: 'a', name: 'A', kind: 'digital', elements: { slots: true, units: {}, downloads: true } }])).toEqual(
			['/value/0/elements/units', '/value/0/elements/slots'],
		);
		expect(problems([{ key: 'a', name: 'A', kind: 'service', elements: { parcel: true, licenceKeys: true } }])).toEqual([
			'/value/0/elements/parcel',
			'/value/0/elements/licenceKeys',
		]);
		expect(problems([{ key: 'a', name: 'A', elements: { colours: true, chart: 'yes' } }])).toEqual([
			'/value/0/elements/colours',
			'/value/0/elements/chart',
		]);
		expect(
			problems([{ key: 'a', name: 'A', elements: { units: { fieldIds: ['x', 'y', 'z', 'w'], capture: 'later' } } }]),
		).toEqual(['/value/0/elements/units/fieldIds', '/value/0/elements/units/capture']);
		expect(problems([{ key: 'a', name: 'A', elements: { units: { capture: 'stock', requiredBefore: 'shipped' } } }])).toEqual([
			'/value/0/elements/units/requiredBefore',
		]);
		expect(problems([{ key: 'a', name: 'A', elements: { units: 'yes' } }])).toEqual(['/value/0/elements/units']);
		expect(problems([{ key: 'a', name: 'A', fieldIds: Array.from({ length: 41 }, (_, n) => `att_${n}`) }])).toEqual([
			'/value/0/fieldIds',
		]);
		expect(problems([{ key: 'a', name: 'A', fieldIds: ['att_1', 'att_1'] }])).toEqual(['/value/0/fieldIds']);
		expect(problems(['x'])).toEqual(['/value/0']);
	});
});

describe('the type of a product', () => {
	const merchant = types([
		PHONE,
		{ key: 'ebook', name: 'E-book', kind: 'digital', elements: { downloads: true } },
		{ key: 'old', name: 'Old', active: false },
	]);
	const categories = new Map([
		['cat_phones', { path: [], typeKey: 'used_phone' }],
		['cat_android', { path: ['cat_phones'], typeKey: null }],
		['cat_books', { path: [], typeKey: 'ebook' }],
		['cat_gone', { path: ['cat_phones'], typeKey: 'deleted_type' }],
		['cat_plain', { path: ['cat_phones'], typeKey: 'physical' }],
	]);

	it('is its own, else its first category’s or the nearest above, else the built-in one of its kind', () => {
		expect(typeOf({ kind: 'physical', typeKey: null, categoryIds: [] }, merchant, categories)).toBe(BUILT_IN_TYPES.physical);
		expect(typeOf({ kind: 'physical', typeKey: null, categoryIds: ['cat_android'] }, merchant, categories).key).toBe(
			'used_phone',
		);
		// a key no type has any more is passed over; a category may name a built-in type
		expect(typeOf({ kind: 'physical', typeKey: null, categoryIds: ['cat_gone'] }, merchant, categories).key).toBe('used_phone');
		expect(typeOf({ kind: 'physical', typeKey: null, categoryIds: ['cat_plain'] }, merchant, categories).key).toBe('physical');
		expect(typeOf({ kind: 'physical', typeKey: 'old', categoryIds: ['cat_phones'] }, merchant, categories).key).toBe('old');
		// only the first category counts, and a type of another kind never applies
		expect(typeOf({ kind: 'physical', typeKey: null, categoryIds: ['cat_books', 'cat_phones'] }, merchant, categories)).toBe(
			BUILT_IN_TYPES.physical,
		);
		expect(typeOf({ kind: 'digital', typeKey: 'used_phone', categoryIds: [] }, merchant, categories)).toBe(
			BUILT_IN_TYPES.digital,
		);
		expect(typeOf({ kind: 'service', typeKey: null, categoryIds: ['cat_unknown'] }, merchant, categories)).toBe(
			BUILT_IN_TYPES.service,
		);
	});

	it('built-in types have every element their kind takes but numbered units, and every field', () => {
		expect(elementsOf(BUILT_IN_TYPES.physical, ALL_ON)).toEqual({
			variants: true,
			grades: true,
			units: null,
			chart: true,
			parcel: true,
			warranty: true,
			downloads: false,
			licenceKeys: false,
			slots: false,
		});
		expect(elementsOf(BUILT_IN_TYPES.digital, ALL_ON)).toMatchObject({ parcel: false, downloads: true, licenceKeys: true });
		expect(elementsOf(BUILT_IN_TYPES.service, ALL_ON)).toMatchObject({ parcel: false, slots: true, downloads: false });
		expect(typeTakes(BUILT_IN_TYPES.physical, 'att_any')).toBe(true);
		expect(typeTakes(/** @type {any} */ (merchant[0]), 'att_battery')).toBe(true);
		expect(typeTakes(/** @type {any} */ (merchant[0]), 'att_other')).toBe(false);
	});

	it('works an element only while its feature is on', () => {
		const none = () => false;
		expect(Object.values(elementsOf(BUILT_IN_TYPES.physical, none)).every((on) => on === false || on === null)).toBe(true);
		const grades = (/** @type {string} */ feature) => feature === 'grades_serials';
		expect(elementsOf(/** @type {any} */ (merchant[0]), grades)).toMatchObject({
			grades: true,
			units: { capture: 'packing' },
			variants: false,
			parcel: false,
		});
	});
});

describe('saving the item types list', () => {
	const fields = new Map([
		['att_battery', { on: 'product', multiple: false }],
		['att_color', { on: 'variant', multiple: false }],
		['att_imei', { on: 'unit', multiple: true }],
		['att_esn', { on: 'unit', multiple: true }],
		['att_note', { on: 'order', multiple: false }],
	]);
	const none = { fields, named: new Set(), stocked: new Set() };
	const [phone] = types([PHONE]);

	it('refuses fields of the wrong kind and two unit fields with two values', () => {
		expect(typeChangeProblems([], [phone], none)).toEqual([]);
		const wrong = types([
			{
				...PHONE,
				fieldIds: ['att_battery', 'att_note', 'att_missing'],
				elements: { units: { fieldIds: ['att_imei', 'att_esn', 'att_color'] } },
			},
		]);
		expect(typeChangeProblems([], wrong, none).map((problem) => problem.path)).toEqual([
			'/value/0/fieldIds/1',
			'/value/0/fieldIds/2',
			'/value/0/elements/units/fieldIds/2',
			'/value/0/elements/units/fieldIds',
		]);
	});

	it('keeps a used type and its kind, and the units of a type with units in stock', () => {
		const used = { fields, named: new Set(['used_phone']), stocked: new Set(['used_phone']) };
		expect(typeChangeProblems([phone], [], used)).toEqual([
			{ path: '/value', message: 'Used phone: products or categories use this type; give them another type first.' },
		]);
		expect(typeChangeProblems([phone], [], none)).toEqual([]);
		const digital = types([{ ...PHONE, kind: 'digital', elements: {} }]);
		expect(typeChangeProblems([phone], digital, used).map((problem) => problem.path)).toEqual([
			'/value/0/kind',
			'/value/0/elements/units',
		]);
		const otherFields = types([{ ...PHONE, elements: { units: { fieldIds: ['att_esn'] } } }]);
		expect(typeChangeProblems([phone], otherFields, used).map((problem) => problem.path)).toEqual(['/value/0/elements/units']);
		// when and before what the numbers are given may change
		const stock = types([{ ...PHONE, elements: { units: { fieldIds: ['att_imei'], capture: 'stock' } } }]);
		expect(typeChangeProblems([phone], stock, used)).toEqual([]);
		// units switched on for a type without them, or off with none in stock
		expect(typeChangeProblems(stock, types([{ ...PHONE, elements: {} }]), none)).toEqual([]);
	});
});

describe('grades per item type (owner 2026-10-14 Q4)', () => {
	it('keeps the types a grade is for, each grade key’s types together, and tells which grades a type takes', () => {
		const checked = checkGrades([
			{ key: 'mint', label: 'Mint', condition: 'used', typeKeys: ['used_phone', 'used_phone', 'laptop'] },
			{ key: 'mint', label: 'Mint dress', categoryId: 'cat_dresses', typeKeys: ['dress'] },
			{ key: 'new', label: 'New', condition: 'new' },
			{ key: 'fair', label: 'Fair', categoryId: 'cat_a' },
			{ key: 'fair', label: 'Fair B', categoryId: 'cat_b', typeKeys: ['dress'] },
		]);
		expect(checked.ok).toBe(true);
		const list = checked.ok ? checked.value : [];
		expect(list[0]?.typeKeys).toEqual(['used_phone', 'laptop']);
		expect(list[2]?.typeKeys).toEqual([]);
		const types = gradeTypes(list);
		expect(types).toEqual(
			new Map([
				['mint', ['used_phone', 'laptop', 'dress']],
				['new', []],
				['fair', []],
			]),
		);
		expect(gradeForType(types.get('mint') ?? [], 'laptop')).toBe(true);
		expect(gradeForType(types.get('mint') ?? [], 'physical')).toBe(false);
		expect(gradeForType(types.get('new') ?? [], 'physical')).toBe(true);
		expect(checkGrades([{ key: 'a', label: 'A', typeKeys: ['Bad Key'] }])).toMatchObject({ ok: false });
		expect(checkGrades([{ key: 'a', label: 'A', typeKeys: 'used_phone' }])).toMatchObject({ ok: false });
	});
});

describe('the item types list through the API', () => {
	/** @type {Awaited<ReturnType<typeof readyShop>>} */
	let shop;
	beforeAll(async () => {
		shop = await readyShop();
	});
	afterAll(async () => shop.product.close());

	it('is saved in the dashboard and by the server token, its fields checked against the shop’s, in Recent changes', async () => {
		const path = `/v1/dashboard/websites/${shop.websiteId}/lists/item_types`;
		const cookie = await shop.adminSession();
		expect((await shop.dashboard(cookie, 'GET', path)).json.value).toEqual([]);
		const battery = (await shop.api('POST', '/v1/attributes', { name: 'Battery', type: 'number' })).json;
		const imei = (await shop.api('POST', '/v1/attributes', { name: 'IMEI', on: 'unit', multiple: true })).json;
		const wrong = await shop.dashboard(cookie, 'PUT', path, {
			value: [{ ...PHONE, fieldIds: [imei.id], elements: { units: { fieldIds: [battery.id] } } }],
		});
		expect(wrong.status).toBe(422);
		expect(wrong.json.errors.map((/** @type {any} */ error) => error.path)).toEqual([
			'/value/0/fieldIds/0',
			'/value/0/elements/units/fieldIds/0',
		]);
		const value = [{ ...PHONE, fieldIds: [battery.id], elements: { ...PHONE.elements, units: { fieldIds: [imei.id] } } }];
		expect(await shop.list('item_types', value)).toMatchObject([{ key: 'used_phone', fieldIds: [battery.id] }]);
		const overview = await shop.dashboard(cookie, 'GET', `/v1/dashboard/websites/${shop.websiteId}/overview`);
		expect(JSON.stringify(overview.json)).toContain('Item types: changed');
		// the merchant's server reads and saves it too
		expect((await shop.api('GET', '/v1/lists/item_types')).json.value[0].key).toBe('used_phone');
		expect((await shop.api('PUT', '/v1/lists/item_types', { value: [{ key: 'x' }] })).status).toBe(422);
		// a category that names the type keeps it
		await shop.api('POST', '/v1/categories', { name: 'Phones', typeKey: 'used_phone' });
		const removed = await shop.dashboard(cookie, 'PUT', path, { value: [] });
		expect(removed.status).toBe(422);
		expect(removed.json.errors[0].message).toContain('products or categories use this type');
	});
});
