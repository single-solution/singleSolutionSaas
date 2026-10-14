/**
 * Merchant fields (PLAN 0.8.10 dynamic model §2): the widened attribute check (where values live, types, ranges, dates,
 * several values, formats, required, where values show), value checks, the unit-field limits, and through the API:
 * required fields on products on sale, values of staff-only fields never leaving staff answers (product page, cards,
 * Chat, compare, structured data, feeds), structured data and feed targets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAttribute } from '../core/catalog-taxonomy.js';
import {
	FIELD_LIMITS,
	checkShow,
	checkValue,
	crowdedUnits,
	dayOf,
	fieldApplies,
	showDefaults,
	shownToShoppers,
	unitFieldsFor,
	valueProblem,
} from '../core/fields.js';
import { ALL, readyShop } from './helpers.js';

/** @typedef {import('../core/fields.js').ValueRules} ValueRules */

/** @param {unknown} body */
const paths = (body) => {
	const checked = checkAttribute(body, null);
	return checked.ok ? [] : checked.errors.map((error) => error.path);
};
/** @param {unknown} body @returns {any} */
const field = (body) => {
	const checked = checkAttribute(body, null);
	if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
	return checked.value;
};

describe('field definitions', () => {
	it('keeps where values live, the type and what the type takes', () => {
		expect(field({ name: 'Battery', type: 'number', min: 0, max: 100, decimals: 0, unit: '%' })).toMatchObject({
			on: 'product',
			type: 'number',
			min: 0,
			max: 100,
			decimals: 0,
			dates: 'any',
			format: null,
			maxValues: 1,
			show: showDefaults('product'),
		});
		expect(field({ name: 'Made', type: 'date', dates: 'past' })).toMatchObject({ dates: 'past', min: null, decimals: 0 });
		expect(field({ name: 'Tags', multiple: true })).toMatchObject({ multiple: true, maxValues: 20 });
		expect(field({ name: 'Tags', multiple: true, maxValues: 3 })).toMatchObject({ maxValues: 3 });
		expect(paths({ name: 'A', on: 'shelf' })).toEqual(['/on']);
		expect(paths({ name: 'A', type: 'boolean' })).toEqual(['/type']);
		expect(paths({ name: 'A', on: 'variant', type: 'yes_no' })).toEqual(['/type']);
		expect(paths({ name: 'A', on: 'unit', type: 'number' })).toEqual(['/type']);
		expect(paths({ name: 'A', type: 'date', unit: 'cm' })).toEqual(['/unit']);
		expect(paths({ name: 'A', type: 'text', min: 1 })).toEqual(['/min']);
		expect(paths({ name: 'A', type: 'number', min: 5, max: 1 })).toEqual(['/min']);
		expect(paths({ name: 'A', type: 'number', min: 'x', decimals: 4 })).toEqual(['/min', '/decimals']);
		expect(paths({ name: 'A', type: 'text', dates: 'past' })).toEqual(['/dates']);
		expect(paths({ name: 'A', type: 'number', multiple: true })).toEqual(['/multiple']);
		expect(paths({ name: 'A', multiple: true, maxValues: 1 })).toEqual(['/maxValues']);
		expect(paths({ name: 'A', maxValues: 21 })).toEqual(['/maxValues']);
		expect(paths({ name: 'A', type: 'number', format: { chars: 'digits' } })).toEqual(['/format']);
		expect(paths({ name: 'A', format: { chars: 'emoji' } })).toEqual(['/format/chars']);
	});

	it('holds a unit field to text with at most two values, and an order field to its stage', () => {
		const imei = field({
			name: 'IMEI',
			on: 'unit',
			multiple: true,
			required: true,
			format: { chars: 'digits', minLength: 15, maxLength: 15, checkDigit: 'luhn', ignoreSpaces: true },
			show: { shopper: true, invoice: true, packingSlip: true },
		});
		expect(imei).toMatchObject({
			on: 'unit',
			maxValues: 2,
			required: true,
			requiredAt: null,
			show: { shopper: true, invoice: true, packingSlip: true, page: false, chat: false },
		});
		expect(paths({ name: 'A', on: 'unit', multiple: true, maxValues: 3 })).toEqual(['/maxValues']);
		expect(
			field({ name: 'Gift note', on: 'order', required: true, requiredAt: 'checkout', show: { shopper: true } }),
		).toMatchObject({
			requiredAt: 'checkout',
		});
		expect(field({ name: 'Box', on: 'order', required: true, requiredAt: 'packed' })).toMatchObject({ requiredAt: 'packed' });
		expect(paths({ name: 'A', on: 'order', required: true })).toEqual(['/requiredAt']);
		expect(paths({ name: 'A', on: 'order', required: true, requiredAt: 'checkout' })).toEqual(['/requiredAt']);
		expect(paths({ name: 'A', on: 'order', requiredAt: 'lunch' })).toEqual(['/requiredAt']);
		expect(paths({ name: 'A', on: 'product', requiredAt: 'packed' })).toEqual(['/requiredAt']);
		// a required order field not required anymore keeps no stage
		expect(field({ name: 'A', on: 'order', requiredAt: 'packed' }).requiredAt).toBeNull();
		expect(paths({ name: 'A', on: 'customer', required: true })).toEqual(['/required']);
		expect(paths({ name: 'A', on: 'order', categoryIds: ['cat_1'] })).toEqual(['/categoryIds']);
		expect(paths({ name: 'A', on: 'customer', visibility: { when: 'grades', ids: ['a'] } })).toEqual(['/visibility']);
		expect(paths({ name: 'A', on: 'order', seo: { title: 'Glossary' } })).toEqual(['/seo']);
	});

	it('shows values only where they can go, staff-only when nowhere a shopper looks', () => {
		expect(checkShow(undefined, 'customer', null)).toEqual({ ok: true, value: showDefaults('customer') });
		expect(checkShow({ invoice: true }, 'customer', null)).toMatchObject({ ok: true, value: { invoice: true } });
		expect(checkShow({ page: true }, 'order', null)).toMatchObject({ ok: false, errors: [{ path: '/show/page' }] });
		expect(checkShow({ compare: true }, 'variant', null)).toMatchObject({ ok: false, errors: [{ path: '/show/compare' }] });
		// switching off a place a field cannot show is fine
		expect(checkShow({ page: false, card: 'none' }, 'order', null).ok).toBe(true);
		expect(checkShow({ feeds: 'gtin' }, 'product', null)).toMatchObject({ ok: false, errors: [{ path: '/show/feeds' }] });
		expect(checkShow({ shelf: true }, 'product', null)).toMatchObject({ ok: false, errors: [{ path: '/show/shelf' }] });
		expect(checkShow('page', 'product', null).ok).toBe(false);
		// the places given change, the rest stay
		const before = { ...showDefaults('product'), filter: true };
		expect(checkShow({ compare: true }, 'product', before)).toMatchObject({ ok: true, value: { filter: true, compare: true } });
		expect(shownToShoppers({ show: showDefaults('order') })).toBe(false);
		expect(shownToShoppers({ show: { ...showDefaults('order'), invoice: true } })).toBe(false);
		expect(shownToShoppers({ show: { ...showDefaults('order'), shopper: true } })).toBe(true);
		expect(shownToShoppers({ show: { ...showDefaults('product'), page: false, chat: false, feeds: 'color' } })).toBe(true);
		expect(shownToShoppers({ show: { ...showDefaults('product'), page: false, chat: false } })).toBe(false);
		// a changed place of the field keeps its values
		const order = field({ name: 'Ref', on: 'order', show: { invoice: true } });
		const changed = checkAttribute({ show: { shopper: true } }, /** @type {any} */ ({ id: 'att_1', ...order }));
		expect(changed).toMatchObject({ ok: true, value: { show: { invoice: true, shopper: true } } });
		// a field moved elsewhere starts from that place's defaults
		const moved = checkAttribute({ on: 'customer' }, /** @type {any} */ ({ id: 'att_1', ...field({ name: 'Ref' }) }));
		expect(moved).toMatchObject({ ok: true, value: { show: showDefaults('customer') } });
	});
});

describe('values', () => {
	/** @param {Partial<ValueRules>} rules @returns {ValueRules} */
	const rules = (rules) => ({
		name: 'F',
		type: 'text',
		choices: [],
		multiple: false,
		maxValues: 1,
		min: null,
		max: null,
		decimals: 2,
		dates: 'any',
		format: null,
		...rules,
	});

	it('checks numbers, dates, yes/no, choices and several values', () => {
		const percent = rules({ name: 'Battery', type: 'number', min: 0, max: 100, decimals: 1 });
		expect(checkValue(percent, 87.5)).toEqual({ ok: true, value: 87.5 });
		expect(checkValue(percent, 101)).toEqual({ ok: false, code: 'range' });
		expect(checkValue(percent, 87.55)).toEqual({ ok: false, code: 'decimals' });
		expect(checkValue(percent, '87')).toEqual({ ok: false, code: 'type', value: '87' });
		expect(checkValue(percent, Number.NaN)).toEqual({ ok: false, code: 'type' });
		expect(checkValue(percent, 2e12)).toEqual({ ok: false, code: 'type' });
		expect(valueProblem(percent, { code: 'range' })).toBe('Battery is from 0 to 100.');
		expect(valueProblem({ ...percent, max: null }, { code: 'range' })).toBe('Battery is at least 0.');
		expect(valueProblem({ ...percent, min: null }, { code: 'range' })).toBe('Battery is at most 100.');
		expect(valueProblem(percent, { code: 'decimals' })).toBe('Battery has at most 1 decimals.');
		const made = rules({ name: 'Made', type: 'date', dates: 'past' });
		expect(checkValue(made, '2026-10-14', { today: '2026-10-15' })).toEqual({ ok: true, value: '2026-10-14' });
		// a refused text names itself, so the message can say which
		expect(checkValue(made, '2026-10-16', { today: '2026-10-15' })).toEqual({ ok: false, code: 'date', value: '2026-10-16' });
		expect(checkValue({ ...made, dates: 'future' }, '2026-10-14', { today: '2026-10-15' })).toMatchObject({
			ok: false,
			code: 'date',
		});
		expect(checkValue(made, '2026-02-30')).toMatchObject({ ok: false, code: 'type' });
		expect(valueProblem(made, { code: 'date' })).toBe('Made is today or earlier.');
		expect(valueProblem({ ...made, dates: 'future' }, { code: 'date' })).toBe('Made is today or later.');
		expect(dayOf('2026-1-5')).toBeNull();
		expect(dayOf(20260105)).toBeNull();
		const yes = rules({ type: 'yes_no' });
		expect(checkValue(yes, false)).toEqual({ ok: true, value: false });
		expect(checkValue(yes, 'false')).toMatchObject({ ok: false, code: 'type' });
		expect(checkValue({ ...yes, multiple: true, maxValues: 2 }, [true])).toEqual({ ok: false, code: 'values' });
		const color = rules({
			name: 'Color',
			type: 'choice',
			choices: [{ value: 'red', label: 'Red' }],
			multiple: true,
			maxValues: 2,
		});
		expect(checkValue(color, ['red', 'own'], { extra: ['own'] })).toEqual({ ok: true, value: ['red', 'own'] });
		expect(checkValue(color, ['red', 'red'])).toEqual({ ok: false, code: 'values' });
		expect(checkValue(color, ['red', 'own', 'more'], { extra: ['own', 'more'] })).toEqual({ ok: false, code: 'values' });
		expect(checkValue(color, ['blue'])).toEqual({ ok: false, code: 'choice', value: 'blue' });
		expect(valueProblem(color, { code: 'values' })).toBe('Color takes 1 to 2 different values.');
		// text without control characters, on one line
		expect(checkValue(rules({}), ' a\tb\u0007 ')).toEqual({ ok: true, value: 'a b' });
		expect(checkValue(rules({}), 'x'.repeat(201))).toMatchObject({ ok: false, code: 'type' });
	});

	it('checks a text value against its format and names the value it refuses', () => {
		const imei = rules({
			name: 'IMEI',
			multiple: true,
			maxValues: 2,
			format: {
				chars: 'digits',
				minLength: 15,
				maxLength: 15,
				startsWith: [],
				mask: '',
				checkDigit: 'luhn',
				ignoreSpaces: true,
				upperCase: false,
			},
		});
		// two numbers of one dual-SIM unit, kept without spaces
		expect(checkValue(imei, ['4901 5420 3237 518', '356938035643809'])).toEqual({
			ok: true,
			value: ['490154203237518', '356938035643809'],
		});
		const wrong = checkValue(imei, ['490154203237518', '490154203237519']);
		expect(wrong).toEqual({ ok: false, code: 'check_digit', value: '490154203237519' });
		expect(valueProblem(imei, /** @type {any} */ (wrong))).toBe('490154203237519 does not match the format of IMEI.');
		expect(checkValue(imei, '123')).toEqual({ ok: false, code: 'length', value: '123' });
		expect(valueProblem(imei, { code: 'length' })).toBe('This value does not match the format of IMEI.');
	});
});

describe('unit fields per category', () => {
	const unit = (/** @type {string} */ id, /** @type {Record<string, unknown>} */ more = {}) => ({
		id,
		name: id,
		sort: 0,
		on: /** @type {const} */ ('unit'),
		active: true,
		multiple: false,
		categoryId: null,
		categoryIds: /** @type {string[]} */ ([]),
		...more,
	});
	const categories = [
		{ id: 'cat_phones', path: [] },
		{ id: 'cat_used', path: ['cat_phones'] },
		{ id: 'cat_cases', path: [] },
	];

	it('applies by category with those above it, in their order', () => {
		expect(fieldApplies({ categoryId: null, categoryIds: [] }, [])).toBe(true);
		expect(fieldApplies({ categoryId: null, categoryIds: ['cat_phones'] }, ['cat_used', 'cat_phones'])).toBe(true);
		expect(fieldApplies({ categoryId: 'cat_cases', categoryIds: [] }, ['cat_used', 'cat_phones'])).toBe(false);
		const fields = [
			unit('b', { sort: 2 }),
			unit('a', { sort: 1, categoryIds: ['cat_phones'] }),
			unit('off', { active: false }),
			{ ...unit('spec'), on: /** @type {any} */ ('product') },
		];
		expect(unitFieldsFor(fields, ['cat_used', 'cat_phones']).map((entry) => entry.id)).toEqual(['a', 'b']);
		expect(unitFieldsFor(fields, ['cat_cases']).map((entry) => entry.id)).toEqual(['b']);
	});

	it('finds the category where more than 3 apply, or two take two values', () => {
		const three = [unit('a'), unit('b'), unit('c', { categoryIds: ['cat_phones'] })];
		expect(crowdedUnits(three, categories)).toBeNull();
		expect(crowdedUnits([...three, unit('d', { categoryIds: ['cat_phones'] })], categories)).toBe('cat_phones');
		expect(crowdedUnits([...three, unit('d', { categoryIds: ['cat_cases'] })], categories)).toBeNull();
		expect(
			crowdedUnits(
				[...three, unit('d', { categoryIds: ['cat_cases'] }), unit('e', { categoryIds: ['cat_cases'] })],
				categories,
			),
		).toBe('cat_cases');
		expect(crowdedUnits([unit('a'), unit('b'), unit('c'), unit('d')], categories)).toBe('');
		expect(
			crowdedUnits([unit('a', { multiple: true }), unit('b', { multiple: true, categoryIds: ['cat_used'] })], categories),
		).toBe('cat_used');
		expect(FIELD_LIMITS.unitFields).toBe(3);
	});
});

describe('fields through the API', () => {
	/** @type {Awaited<ReturnType<typeof readyShop>>} */
	let shop;
	/** @type {Record<string, any>} */
	const ids = {};

	/** @param {string} method @param {string} path @param {unknown} [body] */
	const api = async (method, path, body) => {
		const answer = await shop.api(method, path, body);
		if (answer.status >= 300) throw new Error(`${method} ${path}: ${answer.status} ${answer.text}`);
		return answer.json;
	};

	beforeAll(async () => {
		shop = await readyShop({ features: ALL.filter((feature) => feature !== 'multi_location') });
		ids.phones = await api('POST', '/v1/categories', { name: 'Phones' });
		ids.cases = await api('POST', '/v1/categories', { name: 'Cases' });
		ids.battery = await api('POST', '/v1/attributes', {
			name: 'Battery health',
			type: 'number',
			min: 0,
			max: 100,
			decimals: 0,
			unit: '%',
			required: true,
			categoryIds: [ids.phones.id],
			show: { compare: true, jsonLd: 'additionalProperty', feeds: 'custom_label_1' },
		});
		ids.supplier = await api('POST', '/v1/attributes', {
			name: 'Supplier code',
			show: { page: false, chat: false, compare: true },
		});
		ids.color = await api('POST', '/v1/attributes', {
			name: 'Shade',
			on: 'variant',
			type: 'choice',
			choices: ['Black', 'Blue'],
			show: { card: 'chips', jsonLd: 'color', feeds: 'color' },
		});
		ids.bin = await api('POST', '/v1/attributes', { name: 'Bin', on: 'variant', show: { page: false, chat: false } });
	});
	afterAll(async () => shop.product.close());

	it('asks products on sale for their required fields, by category', async () => {
		const draft = await shop.api('POST', '/v1/products', { name: 'Phone X', price: 50000, categoryIds: [ids.phones.id] });
		expect(draft.status).toBe(201);
		const live = await shop.api('PATCH', `/v1/products/${draft.json.id}`, { status: 'active' });
		expect(live.status).toBe(422);
		expect(live.json.errors).toEqual([
			expect.objectContaining({
				path: `/specs/${ids.battery.id}`,
				message: 'Battery health is required on products on sale.',
			}),
		]);
		const out = await shop.api('PATCH', `/v1/products/${draft.json.id}`, { specs: { [ids.battery.id]: 101 } });
		expect(out.json.errors).toEqual([expect.objectContaining({ message: 'Battery health is from 0 to 100.' })]);
		// a case is not in the field's categories
		const unrelated = await shop.api('POST', '/v1/products', {
			name: 'Case',
			status: 'active',
			price: 900,
			categoryIds: [ids.cases.id],
		});
		expect(unrelated.status).toBe(201);
	});

	it('keeps staff-only values in staff answers; shoppers see only the fields shown to them', async () => {
		const phone = await api('POST', '/v1/products', {
			name: 'Phone Y',
			status: 'active',
			categoryIds: [ids.phones.id],
			specs: { [ids.battery.id]: 91, [ids.supplier.id]: 'SUP-7' },
			variants: [
				{ price: 40000, stock: 3, attributes: { [ids.color.id]: 'Black', [ids.bin.id]: 'B-12' } },
				{ price: 41000, stock: 2, attributes: { [ids.color.id]: 'Blue', [ids.bin.id]: 'B-13' } },
			],
		});
		ids.phone = phone;
		// staff see everything; the staff-only variant field makes no option
		expect(phone.specs).toEqual({ [ids.battery.id]: 91, [ids.supplier.id]: 'SUP-7' });
		expect(phone.options).toEqual([{ name: 'Shade', values: ['Black', 'Blue'] }]);
		expect(phone.variants[0].attributes).toEqual({ [ids.color.id]: 'Black', [ids.bin.id]: 'B-12' });
		const page = await shop.visitor('GET', `/v1/shop/products/${phone.id}`);
		expect(page.status).toBe(200);
		expect(page.text).not.toContain('SUP-7');
		expect(page.text).not.toContain('B-12');
		expect(page.json.specs.map((/** @type {any} */ spec) => spec.name)).toEqual(['Battery health']);
		expect(page.json.variants[0].attributes.map((/** @type {any} */ entry) => entry.name)).toEqual(['Shade']);
		const grid = await shop.visitor('GET', '/v1/shop/products?variants=1');
		expect(grid.text).not.toContain('B-12');
		const card = grid.json.items.find((/** @type {any} */ item) => item.id === phone.id);
		expect(card.variants[0].attributes).toEqual([{ slug: 'shade', name: 'Shade', label: 'Black' }]);
		const chat = await shop.api('GET', `/v1/chat/products/${phone.id}`);
		expect(chat.json.specs).toEqual([{ name: 'Battery health', value: 91, unit: '%' }]);
		// compare shows the supplier code (the merchant chose so) but never a variant field
		const compared = await shop.visitor('GET', `/v1/shop/compare?ids=${phone.id}`);
		expect(compared.json.rows.map((/** @type {any} */ row) => row.name)).toEqual(['Battery health', 'Supplier code']);
	});

	it('names fields in structured data and feeds where the merchant says', async () => {
		const seo = await shop.api('GET', `/v1/seo/products/${ids.phone.id}`);
		const [group] = JSON.parse(seo.json.jsonLd)['@graph'];
		expect(group).toMatchObject({
			'@type': 'ProductGroup',
			variesBy: ['https://schema.org/color'],
			additionalProperty: [{ '@type': 'PropertyValue', name: 'Battery health', value: '91 %' }],
		});
		expect(group.hasVariant.map((/** @type {any} */ variant) => variant.color)).toEqual(['Black', 'Blue']);
		expect(seo.text).not.toContain('SUP-7');
		await shop.setting('feeds', 'items', 'all');
		const feed = (await shop.api('GET', '/v1/feeds/products.xml')).text;
		expect(feed).toContain('<g:color>Black</g:color>');
		expect(feed).toContain('<g:custom_label_1>91 %</g:custom_label_1>');
		expect(feed).not.toContain('B-12');
	});

	it('limits unit fields per category and refuses changes records cannot take', async () => {
		for (const name of ['Serial', 'Service tag', 'Model code'])
			await api('POST', '/v1/attributes', { name, on: 'unit', categoryIds: [ids.phones.id] });
		const fourth = await shop.api('POST', '/v1/attributes', { name: 'Fourth', on: 'unit' });
		expect(fourth.status).toBe(422);
		expect(fourth.json.errors[0].path).toBe('/categoryIds');
		// cases have room
		expect(
			(await shop.api('POST', '/v1/attributes', { name: 'Case code', on: 'unit', categoryIds: [ids.cases.id] })).status,
		).toBe(201);
		// fewer values than a product holds
		const tags = await api('POST', '/v1/attributes', { name: 'Labels', multiple: true, maxValues: 3 });
		await api('PATCH', `/v1/products/${ids.phone.id}`, { specs: { ...ids.phone.specs, [tags.id]: ['a', 'b', 'c'] } });
		expect((await shop.api('PATCH', `/v1/attributes/${tags.id}`, { maxValues: 2 })).status).toBe(409);
		expect((await shop.api('PATCH', `/v1/attributes/${tags.id}`, { on: 'order' })).status).toBe(409);
		expect((await shop.api('DELETE', `/v1/attributes/${tags.id}`)).status).toBe(409);
	});
});
