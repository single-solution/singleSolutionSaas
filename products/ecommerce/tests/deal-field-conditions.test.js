/**
 * Deal conditions on a merchant's field: `{ field: <field key>, values: [...] }` (the key is the field's slug or id)
 * reads as a rule on that field's values, written the way the products, categories, brands and grades rules are, and
 * is judged the same everywhere a deal is: the cart's quote, the product cards and `?deal=` listings. A field key
 * that names no field of products or variants is refused when the deal is saved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDealInput, conditionsHold } from '../core/deals.js';
import { readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
beforeAll(async () => {
	shop = await readyShop();
});
afterAll(async () => shop.product.close());

/** A deal body with the given conditions (10 % off, everything). @param {unknown} conditions */
const deal = (conditions) => ({ name: 'Field deal', type: 'percent', value: 10, conditions });

describe('the check', () => {
	it('reads a rule on a field key as a rule on that field’s values, and keeps the fixed names as they are', () => {
		const checked = checkDealInput(deal({ rules: [{ field: 'material', values: ['wool', 'wool', 'silk'] }] }));
		expect(checked.ok).toBe(true);
		expect(/** @type {any} */ (checked).value.conditions.rules).toEqual([
			{ field: 'attribute', op: 'in', values: ['wool', 'silk'], attributeId: 'material' },
		]);
		const same = checkDealInput(
			deal({ rules: [{ field: 'attribute', attributeId: 'material', op: 'not_in', values: ['wool'] }] }),
		);
		expect(/** @type {any} */ (same).value.conditions.rules[0]).toEqual({
			field: 'attribute',
			op: 'not_in',
			values: ['wool'],
			attributeId: 'material',
		});
		expect(
			/** @type {any} */ (checkDealInput(deal({ rules: [{ field: 'brands', values: ['brd_a'] }] }))).value.conditions.rules[0],
		).toMatchObject({
			field: 'brands',
		});
		// groups take the same rules
		const grouped = checkDealInput(deal({ groups: [{ match: 'any', rules: [{ field: 'size', op: 'in', values: ['L'] }] }] }));
		expect(/** @type {any} */ (grouped).value.conditions.groups[0].rules[0]).toMatchObject({
			field: 'attribute',
			attributeId: 'size',
		});
	});

	it('refuses a field key that cannot be one, or a rule with no values', () => {
		for (const field of ['has space', 'a/b', '', 'x'.repeat(65), 7]) {
			const checked = checkDealInput(deal({ rules: [{ field, values: ['x'] }] }));
			expect(checked.ok).toBe(false);
			expect(/** @type {any} */ (checked).field).toBe('conditions/rules/0/field');
		}
		expect(checkDealInput(deal({ rules: [{ field: 'material', values: [] }] })).ok).toBe(false);
	});

	it('holds for a line whose field has one of the values, and not_in for one that has none', () => {
		const conditions = /** @type {any} */ (
			checkDealInput(deal({ match: 'all', rules: [{ field: 'material', values: ['wool'] }] }))
		).value.conditions;
		const cart = { goods: 0, paymentMethod: null, weekday: 1, minutes: 600 };
		const line = (/** @type {Record<string, string[]>} */ attributes) => ({
			productId: 'prd_1',
			categoryIds: [],
			brandId: null,
			unitPrice: 1000,
			attributes,
		});
		expect(conditionsHold(conditions, line({ material: ['wool'] }), cart)).toBe(true);
		expect(conditionsHold(conditions, line({ material: ['cotton'] }), cart)).toBe(false);
		expect(conditionsHold(conditions, line({}), cart)).toBe(false);
	});
});

describe('through the API', () => {
	/** @type {{ field: any, wool: any, cotton: any }} */
	const made = { field: null, wool: null, cotton: null };

	beforeAll(async () => {
		made.field = (
			await shop.api('POST', '/v1/attributes', { name: 'Material', slug: 'material', type: 'text', on: 'product' })
		).json;
		made.wool = await shop.seedProduct({ name: 'Wool scarf', price: 5000, specs: { [made.field.id]: 'wool' } });
		made.cotton = await shop.seedProduct({ name: 'Cotton scarf', price: 5000, specs: { [made.field.id]: 'cotton' } });
	});

	it('keeps the rule on the field’s id, however the deal named it (slug or id)', async () => {
		expect(made.field.id).toBeTruthy();
		const bySlug = await shop.api('POST', '/v1/deals', deal({ rules: [{ field: 'material', values: ['wool'] }] }));
		expect(bySlug.status).toBe(201);
		expect(bySlug.json.conditions.rules).toEqual([
			{ field: 'attribute', op: 'in', values: ['wool'], attributeId: made.field.id },
		]);
		const byId = await shop.api('POST', '/v1/deals', {
			...deal({ rules: [{ field: made.field.id, op: 'not_in', values: ['wool'] }] }),
			name: 'Not wool',
		});
		expect(byId.status).toBe(201);
		expect(byId.json.conditions.rules[0]).toMatchObject({ field: 'attribute', attributeId: made.field.id, op: 'not_in' });
		// an edit sends the rules back as they were read
		const edited = await shop.api('PATCH', `/v1/deals/${bySlug.json.id}`, { conditions: bySlug.json.conditions });
		expect(edited.status).toBe(200);
	});

	it('refuses a field that does not exist, or that products do not carry', async () => {
		const unknown = await shop.api('POST', '/v1/deals', deal({ rules: [{ field: 'nothing', values: ['x'] }] }));
		expect(unknown.status).toBe(422);
		expect(JSON.stringify(unknown.json.errors)).toContain('conditions/rules/0/field');
		const customerField = (
			await shop.api('POST', '/v1/attributes', { name: 'Tier', slug: 'tier', type: 'text', on: 'customer' })
		).json;
		const wrong = await shop.api(
			'POST',
			'/v1/deals',
			deal({ groups: [{ rules: [{ field: customerField.slug, values: ['gold'] }] }] }),
		);
		expect(wrong.status).toBe(422);
		expect(JSON.stringify(wrong.json.errors)).toContain('conditions/groups/0/rules/0/field');
	});

	it('gives the deal to the lines whose field has the value, in the quote and on the cards', async () => {
		// only this deal is on
		for (const other of (await shop.api('GET', '/v1/deals')).json.items) await shop.api('DELETE', `/v1/deals/${other.id}`);
		const made2 = await shop.api('POST', '/v1/deals', {
			...deal({ rules: [{ field: 'material', values: ['wool'] }] }),
			name: 'Wool week',
			value: 20,
		});
		expect(made2.status).toBe(201);
		const quote = await shop.visitor('POST', '/v1/shop/cart/quote', {
			body: {
				lines: [
					{ productId: made.wool.id, quantity: 1 },
					{ productId: made.cotton.id, quantity: 1 },
				],
			},
		});
		expect(quote.status).toBe(200);
		const byProduct = new Map(quote.json.lines.map((/** @type {any} */ line) => [line.productId, line]));
		const woolLine = /** @type {any} */ (byProduct.get(made.wool.id));
		const cottonLine = /** @type {any} */ (byProduct.get(made.cotton.id));
		expect(woolLine.total).toBe(4000);
		expect(cottonLine.total).toBe(5000);
		const listed = await shop.visitor('GET', `/v1/shop/products?deal=${made2.json.id}`);
		expect(listed.json.items.map((/** @type {any} */ item) => item.id)).toEqual([made.wool.id]);
	});
});
