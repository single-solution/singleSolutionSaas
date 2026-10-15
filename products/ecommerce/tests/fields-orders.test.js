/**
 * Order and customer fields through the API (PLAN 0.8.10 dynamic model §2): the checkout asks the shopper the order
 * fields shown to shoppers (the quote names them; required ones must be given; values in their fields' rules); the
 * shopper sees only those; staff fill the others and the stage a field is required by is needed before a move into it;
 * customer fields kept by staff; invoices and packing slips print each field where its `show` says.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL, ORIGIN, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {Record<string, any>} */
const ids = {};
let ip = 0;

/** @param {string} method @param {string} path @param {unknown} [body] */
const api = async (method, path, body) => {
	const answer = await shop.api(method, path, body);
	if (answer.status >= 300) throw new Error(`${method} ${path}: ${answer.status} ${answer.text}`);
	return answer.json;
};

/**
 * Place a cash order as a signed-in shopper, with the fields given.
 * @param {Record<string, unknown> | undefined} fields
 */
const place = async (fields) => {
	ip += 1;
	const token = await shop.signIn({ id: `usr_fields${String(ip).padStart(6, '0')}` });
	const answer = await shop.call('POST', '/v1/shop/orders', {
		token: shop.browser,
		origin: ORIGIN,
		body: {
			lines: [{ productId: ids.mug.id, quantity: 1 }],
			payment: 'cod',
			address: { name: 'Sam Lee', phone: '+12025550143', line1: '1 Main Street', city: 'Springfield', country: 'US' },
			...(fields ? { fields } : {}),
		},
		headers: { 'x-forwarded-for': `10.8.0.${ip}`, 'ss-sign-in': token, 'idempotency-key': `fields-${ip}` },
	});
	return { answer, token };
};

beforeAll(async () => {
	shop = await readyShop({ features: ALL.filter((feature) => feature !== 'multi_location') });
	ids.mug = await api('POST', '/v1/products', { name: 'Mug', status: 'active', price: 1200, stock: 20 });
	ids.gift = await api('POST', '/v1/attributes', {
		name: 'Gift message',
		on: 'order',
		required: true,
		requiredAt: 'checkout',
		format: { maxLength: 40 },
		show: { shopper: true },
	});
	ids.vat = await api('POST', '/v1/attributes', {
		name: 'VAT number',
		on: 'order',
		sort: 1,
		format: { chars: 'letters_digits', minLength: 4, maxLength: 14, ignoreSpaces: true, upperCase: true },
		show: { shopper: true, invoice: true },
	});
	ids.box = await api('POST', '/v1/attributes', {
		name: 'Box size',
		on: 'order',
		sort: 2,
		type: 'choice',
		choices: ['S', 'M', 'L'],
		required: true,
		requiredAt: 'packed',
		show: { packingSlip: true },
	});
	ids.taxId = await api('POST', '/v1/attributes', { name: 'Tax ID', on: 'customer', show: { invoice: true } });
	ids.manager = await api('POST', '/v1/attributes', { name: 'Account manager', on: 'customer', sort: 1 });
});
afterAll(async () => shop.product.close());

describe('order fields', () => {
	it('asks the shopper the fields shown to them, checks them and shows them only those', async () => {
		const quote = await shop.call('POST', '/v1/shop/cart/quote', {
			token: shop.browser,
			origin: ORIGIN,
			body: { lines: [{ productId: ids.mug.id, quantity: 1 }] },
		});
		expect(quote.json.fields.map((/** @type {any} */ field) => [field.name, field.required])).toEqual([
			['Gift message', true],
			['VAT number', false],
		]);
		// the required gift message, a VAT number off its format, a staff-only field and an unknown one are refused
		const missing = await place(undefined);
		expect(missing.answer.status).toBe(422);
		expect(missing.answer.json.errors[0]).toMatchObject({ path: `/fields/${ids.gift.id}`, message: 'Give Gift message.' });
		const wrong = await place({ [ids.gift.id]: 'Happy birthday', [ids.vat.id]: 'AB-12' });
		expect(wrong.answer.json.errors[0]).toMatchObject({
			path: `/fields/${ids.vat.id}`,
			message: 'AB-12 does not match the format of VAT number.',
		});
		expect((await place({ [ids.gift.id]: 'Hi', [ids.box.id]: 'M' })).answer.status).toBe(422);
		expect((await place({ [ids.gift.id]: 'x'.repeat(41) })).answer.status).toBe(422);
		const { answer, token } = await place({ [ids.gift.id]: 'Happy birthday', [ids.vat.id]: 'gb 1234 5678' });
		expect(answer.status).toBe(201);
		ids.order = answer.json.order ?? answer.json;
		const view = await shop.call('GET', `/v1/shop/orders/${ids.order.id}`, {
			token: shop.browser,
			origin: ORIGIN,
			headers: { 'ss-sign-in': token, 'x-forwarded-for': '10.8.1.1' },
		});
		expect(view.json.fields).toEqual([
			{ name: 'Gift message', value: 'Happy birthday' },
			{ name: 'VAT number', value: 'GB12345678' },
		]);
	});

	it('carries the order’s fields in its messages as field_<slug> (E28)', async () => {
		await shop.flush();
		const placed = shop
			.messages()
			.filter((message) => message.template === 'ecommerce.order_placed' && message.values.number === ids.order.number);
		expect(placed.length).toBeGreaterThan(0);
		expect(placed[0]?.values).toMatchObject({ field_gift_message: 'Happy birthday', field_vat_number: 'GB12345678' });
		expect(placed[0]?.values).not.toHaveProperty('field_box_size');
	});

	it('lets staff fill the others, needs the stage’s fields before the move, and prints each where it shows', async () => {
		const order = ids.order;
		const detail = await api('GET', `/v1/orders/${order.id}`);
		expect(detail.fields).toEqual({ [ids.gift.id]: 'Happy birthday', [ids.vat.id]: 'GB12345678' });
		expect(detail.orderFields.map((/** @type {any} */ field) => [field.name, field.requiredAt, field.shopper])).toEqual([
			['Gift message', 'checkout', true],
			['VAT number', null, true],
			['Box size', 'packed', false],
		]);
		expect((await shop.api('POST', `/v1/orders/${order.id}/move`, { to: 'confirmed' })).status).toBe(200);
		const early = await shop.api('POST', `/v1/orders/${order.id}/move`, { to: 'packed' });
		expect(early.status).toBe(422);
		expect(early.json.errors[0]).toMatchObject({ path: `/fields/${ids.box.id}`, message: 'Give Box size before this move.' });
		expect((await shop.api('PATCH', `/v1/orders/${order.id}`, { fields: { [ids.box.id]: 'XL' } })).status).toBe(422);
		expect((await shop.api('PATCH', `/v1/orders/${order.id}`, { fields: { att_unknown: 'x' } })).status).toBe(422);
		const filled = await api('PATCH', `/v1/orders/${order.id}`, { fields: { [ids.box.id]: 'M', [ids.vat.id]: null } });
		expect(filled.fields).toEqual({ [ids.gift.id]: 'Happy birthday', [ids.box.id]: 'M' });
		await api('PATCH', `/v1/orders/${order.id}`, { fields: { [ids.vat.id]: 'GB12345678' } });
		expect((await shop.api('POST', `/v1/orders/${order.id}/move`, { to: 'packed' })).status).toBe(200);
		// the customer's fields, kept by staff
		const customerId = detail.customer.customerId;
		expect((await shop.api('PATCH', `/v1/customers/${customerId}`, { fields: { [ids.taxId.id]: ['a'] } })).status).toBe(422);
		const customer = await api('PATCH', `/v1/customers/${customerId}`, {
			fields: { [ids.taxId.id]: 'TX-9', [ids.manager.id]: 'Alex Morgan' },
		});
		expect(customer.fields).toEqual({ [ids.taxId.id]: 'TX-9', [ids.manager.id]: 'Alex Morgan' });
		expect(customer.customerFields.map((/** @type {any} */ field) => field.name)).toEqual(['Tax ID', 'Account manager']);
		// the invoice prints the VAT number and the Tax ID; the packing slip the box size; nothing staff-only
		const invoice = (await shop.api('GET', `/v1/orders/${order.id}/invoice`)).text;
		expect(invoice).toContain('VAT number: GB12345678');
		expect(invoice).toContain('Tax ID: TX-9');
		expect(invoice).not.toContain('Box size');
		expect(invoice).not.toContain('Alex Morgan');
		expect(invoice).not.toContain('Gift message');
		const slip = (await shop.api('GET', `/v1/orders/${order.id}/packing-slip`)).text;
		expect(slip).toContain('Box size: M');
		expect(slip).not.toContain('GB12345678');
		// a person who asks to be forgotten takes their order fields with them (they may name them)
		await shop.api('POST', '/v1/data-rights/delete', { user: { id: detail.customer.userId } });
		expect((await api('GET', `/v1/orders/${order.id}`)).fields).toEqual({});
	});
});
