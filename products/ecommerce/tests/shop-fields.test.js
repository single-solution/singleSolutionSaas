/**
 * The shop's fields for shoppers (`GET /v1/shop/attributes`): the product and variant fields a shopper meets (labels,
 * units, choices, where they show) are a public shop read, open to the browser and to the merchant's server with no
 * staff sign-in. The staff's own list (`GET /v1/attributes`, with every field and its rules) stays a staff route.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {Record<string, any>} */
const ids = {};

const VISITOR = { 'ss-visitor-ip': '203.0.113.7' };

/** @param {string} method @param {string} path @param {unknown} [body] */
const api = async (method, path, body) => {
	const answer = await shop.api(method, path, body);
	if (answer.status >= 300) throw new Error(`${method} ${path}: ${answer.status} ${answer.text}`);
	return answer.json;
};
/** @param {{ json: any }} response */
const typeOf = (response) =>
	String(response.json?.type ?? '')
		.split('/')
		.pop();

beforeAll(async () => {
	shop = await readyShop({ features: ALL.filter((feature) => feature !== 'multi_location') });
	const phones = await api('POST', '/v1/categories', { name: 'Phones' });
	const secret = await api('POST', '/v1/categories', { name: 'Archive', status: 'hidden' });
	Object.assign(ids, { phones, secret });
	ids.color = await api('POST', '/v1/attributes', {
		name: 'Color',
		on: 'variant',
		type: 'choice',
		choices: ['Black', 'Blue'],
		show: { filter: true, card: 'chips' },
		sort: 2,
	});
	ids.ram = await api('POST', '/v1/attributes', {
		name: 'RAM',
		on: 'product',
		type: 'number',
		unit: 'GB',
		show: { filter: true },
		categoryIds: [phones.id],
		sort: 1,
		required: true,
	});
	ids.note = await api('POST', '/v1/attributes', { name: 'Note', on: 'product', type: 'text', sort: 3 });
	// nothing a shopper looks at: the staff's alone
	ids.cost = await api('POST', '/v1/attributes', {
		name: 'Supplier code',
		on: 'product',
		type: 'text',
		show: { page: false, chat: false },
		sort: 4,
	});
	ids.off = await api('POST', '/v1/attributes', { name: 'Retired', on: 'product', type: 'text', active: false, sort: 5 });
	ids.gift = await api('POST', '/v1/attributes', { name: 'Gift note', on: 'order', type: 'text', sort: 6 });
	ids.birthday = await api('POST', '/v1/attributes', { name: 'Birthday', on: 'customer', type: 'date', sort: 7 });
	ids.archived = await api('POST', '/v1/attributes', {
		name: 'Archive code',
		on: 'product',
		type: 'text',
		categoryIds: [secret.id],
		sort: 8,
	});
});
afterAll(async () => {
	await shop.product.close();
});

describe('GET /v1/shop/attributes', () => {
	it('lists the product and variant fields a shopper meets, in the shop’s order, with only what a shopper needs', async () => {
		const answer = await shop.visitor('GET', '/v1/shop/attributes');
		expect(answer.status).toBe(200);
		expect(answer.json.items.map((/** @type {any} */ field) => field.name)).toEqual(['RAM', 'Color', 'Note']);
		const [ram, color] = answer.json.items;
		expect(ram).toEqual({
			id: ids.ram.id,
			slug: ids.ram.slug,
			name: 'RAM',
			on: 'product',
			type: 'number',
			unit: 'GB',
			choices: [],
			multiple: false,
			categoryId: ids.ram.categoryId,
			categoryIds: [ids.phones.id],
			sort: 1,
			show: { page: true, card: 'none', filter: true, compare: expect.any(Boolean) },
		});
		expect(color).toMatchObject({
			on: 'variant',
			type: 'choice',
			choices: [
				{ value: 'Black', label: 'Black' },
				{ value: 'Blue', label: 'Blue' },
			],
			categoryIds: [],
			show: { card: 'chips', filter: true },
		});
		// the staff's rules, internal text and stamps never leave
		const text = JSON.stringify(answer.json);
		for (const private_ of [
			'required',
			'requiredAt',
			'format',
			'visibility',
			'seo',
			'createdAt',
			'updatedAt',
			'Supplier code',
		]) {
			expect(text, private_).not.toContain(private_);
		}
	});

	it('leaves out inactive fields, order and customer fields, staff-only fields and fields of hidden categories', async () => {
		const names = (await shop.visitor('GET', '/v1/shop/attributes')).json.items.map((/** @type {any} */ field) => field.name);
		for (const left of ['Supplier code', 'Retired', 'Gift note', 'Birthday', 'Archive code']) expect(names).not.toContain(left);
	});

	it('answers the merchant’s server with its token alone, no staff sign-in', async () => {
		const server = await shop.call('GET', '/v1/shop/attributes', { token: shop.server, headers: VISITOR });
		expect(server.status).toBe(200);
		expect(server.json.items.map((/** @type {any} */ field) => field.name)).toEqual(['RAM', 'Color', 'Note']);
		const bare = await shop.call('GET', '/v1/shop/attributes', { token: shop.server, bare: true });
		expect(bare.status).toBe(200);
	});

	it('is a conditional read like the other shop answers', async () => {
		const first = await shop.api('GET', '/v1/shop/attributes');
		const etag = first.headers.get('etag');
		expect(etag).toMatch(/^"[\w-]{20,}"$/);
		const again = await shop.api('GET', '/v1/shop/attributes', undefined, { 'if-none-match': String(etag) });
		expect(again.status).toBe(304);
	});

	it('shows the change when a field changes', async () => {
		await api('PATCH', `/v1/attributes/${ids.note.id}`, { name: 'Remark' });
		const names = (await shop.visitor('GET', '/v1/shop/attributes')).json.items.map((/** @type {any} */ field) => field.name);
		expect(names).toEqual(['RAM', 'Color', 'Remark']);
	});
});

describe('the staff’s list of fields stays a staff route', () => {
	it('the server token alone cannot read or change them: 403 needs_signed_in_staff', async () => {
		for (const [method, path, body] of /** @type {Array<[string, string, unknown]>} */ ([
			['GET', '/v1/attributes', undefined],
			['POST', '/v1/attributes', { name: 'X', on: 'product', type: 'text' }],
			['PATCH', `/v1/attributes/${ids.color.id}`, { name: 'Y' }],
			['DELETE', `/v1/attributes/${ids.color.id}`, undefined],
		])) {
			const refused = await shop.call(method, path, {
				token: shop.server,
				bare: true,
				...(body === undefined ? {} : { body }),
			});
			expect([method, path, refused.status, typeOf(refused)]).toEqual([method, path, 403, 'needs_signed_in_staff']);
		}
	});

	it('the staff member with catalog.edit still reads every field, rules included', async () => {
		const staff = await shop.call('GET', '/v1/attributes', { token: shop.server });
		expect(staff.status).toBe(200);
		expect(staff.json.items.map((/** @type {any} */ field) => field.name)).toContain('Supplier code');
	});
});

describe('landing pages', () => {
	it('the shop reads them through the SEO listing with the server token alone; the staff’s list stays closed', async () => {
		const acme = await api('POST', '/v1/brands', { name: 'Acme' });
		await api('POST', '/v1/landings', {
			categoryId: ids.phones.id,
			brandId: acme.id,
			h1: 'Acme phones',
			title: 'Buy Acme phones',
			description: 'The Acme range',
			indexable: 'yes',
		});
		await api('POST', '/v1/products', {
			name: 'Acme One',
			status: 'active',
			categoryIds: [ids.phones.id],
			brandId: acme.id,
			specs: { [ids.ram.id]: 4 },
			price: 1000,
			stock: 3,
		});
		const read = await shop.call('GET', `/v1/seo/listing?category=${ids.phones.slug}&brand=${acme.slug}`, {
			token: shop.server,
			bare: true,
		});
		expect(read.status).toBe(200);
		expect(read.json).toMatchObject({
			h1: 'Acme phones',
			title: expect.stringContaining('Buy Acme phones'),
			landing: { indexed: true },
		});
		const staffList = await shop.call('GET', '/v1/landings', { token: shop.server, bare: true });
		expect([staffList.status, typeOf(staffList)]).toEqual([403, 'needs_signed_in_staff']);
	});
});
