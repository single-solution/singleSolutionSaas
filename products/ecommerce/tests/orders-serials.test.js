/**
 * Serial numbers and warranty of PLAN 0.8.10 E11 and E12 through the API: categories that require serials, typed
 * serials at packing or later with the IMEI check, needed before dispatch and shown to shoppers; registered serials as
 * before; the warranty each line keeps from placement (variant, product, grade, setting), used by claims and printed on
 * invoices.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isImei, isSerialized, missingSerials, serialCheckFailure, serialPlan } from '../core/orders.js';
import { COLLECTIONS } from '../core/model.js';
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

/** Place a cash order of `lines` as a signed-in shopper. @param {Array<{ productId: string, variantId?: string, quantity?: number }>} lines */
const place = async (lines) => {
	ip += 1;
	const token = await shop.signIn({ id: `usr_serial${String(ip).padStart(6, '0')}` });
	const answer = await shop.call('POST', '/v1/shop/orders', {
		token: shop.browser,
		origin: ORIGIN,
		body: {
			lines: lines.map((line) => ({ quantity: 1, ...line })),
			payment: 'cod',
			address: { name: 'Sara', phone: '+15550001111', line1: '1 Main Street', city: 'Springfield', country: 'US' },
		},
		headers: { 'x-forwarded-for': `10.9.0.${ip}`, 'ss-sign-in': token, 'idempotency-key': `serial-${ip}` },
	});
	if (answer.status !== 201) throw new Error(`place: ${answer.status} ${answer.text}`);
	return { order: answer.json.order ?? answer.json, token };
};

/** @param {string} id @param {string} to @param {Record<string, unknown>} [extra] */
const move = (id, to, extra = {}) => shop.api('POST', `/v1/orders/${id}/move`, { to, ...extra });

beforeAll(async () => {
	shop = await readyShop({ features: ALL.filter((feature) => feature !== 'multi_location') });
	await shop.list('grades', [{ key: 'used', label: 'Used', warrantyDays: 30 }]);
	await shop.setting('returns', 'warrantyDays', 7);
	ids.phones = await api('POST', '/v1/categories', { name: 'Phones', requiresSerial: true });
	ids.android = await api('POST', '/v1/categories', { name: 'Android', parentId: ids.phones.id });
	ids.cases = await api('POST', '/v1/categories', { name: 'Cases' });
	ids.phone = await api('POST', '/v1/products', {
		name: 'Phone',
		status: 'active',
		categoryIds: [ids.android.id],
		serialized: null,
		options: [{ name: 'Colour', values: ['Black', 'Blue'] }],
		variants: [
			{ options: { Colour: 'Black' }, price: 1000, stock: 9, warrantyDays: 365 },
			{ options: { Colour: 'Blue' }, price: 1000, stock: 9, grade: 'used' },
		],
	});
	ids.case = await api('POST', '/v1/products', {
		name: 'Case',
		status: 'active',
		categoryIds: [ids.cases.id],
		price: 100,
		stock: 9,
		warrantyDays: 14,
	});
});
afterAll(async () => shop.product.close());

describe('E11 serial capture', () => {
	it('checks IMEIs, plans typed serials and follows category rules', () => {
		expect(isImei('490154203237518')).toBe(true);
		expect(isImei('490154203237519')).toBe(false);
		expect(isImei('49015420323751')).toBe(false);
		expect(serialCheckFailure({ l: ['490154203237518'] }, 'imei')).toBeNull();
		expect(serialCheckFailure({ l: ['ABC 123'] }, 'imei')).toMatchObject({ field: 'serials/l' });
		expect(serialCheckFailure({ l: ['ABC 123'] }, 'none')).toBeNull();
		const categories = new Map([
			['a', { path: [], requiresSerial: true }],
			['b', { path: ['a'], requiresSerial: null }],
			['c', { path: ['a'], requiresSerial: false }],
		]);
		expect(isSerialized({ serialized: null, categoryIds: ['b'] }, categories)).toBe(true);
		expect(isSerialized({ serialized: null, categoryIds: ['c'] }, categories)).toBe(false);
		expect(isSerialized({ serialized: null, categoryIds: ['x'] }, categories)).toBe(false);
		expect(isSerialized({ serialized: false, categoryIds: ['a'] }, categories)).toBe(false);
		const order = /** @type {any} */ ({
			lines: [
				{ id: 'l1', kind: 'physical', productId: 'p', variantId: 'v', name: 'P', quantity: 2, serials: [] },
				{ id: 'l2', kind: 'physical', productId: 'q', variantId: 'w', name: 'Q', quantity: 1, serials: [] },
			],
		});
		const serialized = new Set(['p']);
		expect(serialPlan(order, serialized, {}, { mode: 'typed' })).toMatchObject({
			ok: true,
			value: [{ lineId: 'l1', serials: [] }],
		});
		expect(serialPlan(order, serialized, {}, { mode: 'registered' }).ok).toBe(false);
		expect(serialPlan(order, serialized, { l1: ['a'] }, { mode: 'typed' }).ok).toBe(false);
		expect(serialPlan(order, serialized, { l2: ['a'] }, { mode: 'typed' }).ok).toBe(false);
		expect(serialPlan(order, serialized, { l1: ['a', 'b'] }, { mode: 'typed', only: true }).ok).toBe(true);
		expect(missingSerials(order, serialized).map((line) => line.id)).toEqual(['l1']);
	});

	it('takes typed serials at packing or later, needs them before dispatch and shows them to the shopper', async () => {
		await shop.setting('grades_serials', 'serialMode', 'typed');
		await shop.setting('grades_serials', 'serialCheck', 'imei');
		const { order, token } = await place([{ productId: ids.phone.id, variantId: ids.phone.variants[0].id }]);
		const line = order.lines[0];
		expect((await shop.api('PATCH', `/v1/orders/${order.id}`, { serials: { [line.id]: ['490154203237518'] } })).status).toBe(
			422,
		);
		expect((await move(order.id, 'confirmed')).status).toBe(200);
		expect((await move(order.id, 'packed')).status).toBe(200);
		const shipment = { courier: 'post', trackingNumber: 'T-1' };
		await shop.list('couriers', [{ key: 'post', name: 'Post', trackingUrl: 'https://post.example/track/{tracking}' }]);
		const early = await move(order.id, 'dispatched', { shipment });
		expect(early.status).toBe(422);
		expect(early.json.detail).toContain('Type the serial numbers of Phone');
		expect((await shop.api('PATCH', `/v1/orders/${order.id}`, { serials: { [line.id]: ['12345'] } })).status).toBe(422);
		expect(
			(await shop.api('PATCH', `/v1/orders/${order.id}`, { serials: { [line.id]: ['490154203237518', '356938035643809'] } }))
				.status,
		).toBe(422);
		const typed = await api('PATCH', `/v1/orders/${order.id}`, { serials: { [line.id]: ['490154203237518'] } });
		expect(typed.lines[0].serialized).toBe(true);
		expect(typed.lines[0].serials).toEqual(['490154203237518']);
		expect(typed.history.at(-1)).toMatchObject({ note: 'Serial numbers typed', code: 'serials_typed', byKind: 'server' });
		const recorded = await (
			await shop.db()
		)
			.collection(COLLECTIONS.serials)
			.findOne({ websiteId: shop.websiteId, serial: '490154203237518' });
		expect(recorded).toMatchObject({ status: 'sold', orderId: order.id, typed: true });
		expect((await move(order.id, 'dispatched', { shipment })).status).toBe(200);
		// staff may still correct them after dispatch; another order cannot take the same number
		const fixed = await api('PATCH', `/v1/orders/${order.id}`, { serials: { [line.id]: ['356938035643809'] } });
		expect(fixed.lines[0].serials).toEqual(['356938035643809']);
		expect(
			await (
				await shop.db()
			)
				.collection(COLLECTIONS.serials)
				.countDocuments({ websiteId: shop.websiteId, serial: '490154203237518' }),
		).toBe(0);
		const other = await place([{ productId: ids.phone.id, variantId: ids.phone.variants[0].id }]);
		await move(other.order.id, 'confirmed');
		const clash = await move(other.order.id, 'packed', { serials: { [other.order.lines[0].id]: ['356938035643809'] } });
		expect(clash.status).toBe(422);
		const view = await shop.call('GET', `/v1/shop/orders/${order.id}`, {
			token: shop.browser,
			origin: ORIGIN,
			headers: { 'ss-sign-in': token, 'x-forwarded-for': '10.9.1.1' },
		});
		expect(view.json.lines[0]).toMatchObject({ serials: ['356938035643809'], warrantyDays: 365 });
		// a cancel deletes typed serials of the other order (they never were in stock)
		await move(other.order.id, 'packed', { serials: { [other.order.lines[0].id]: ['353918057895366'] } });
		expect((await move(other.order.id, 'cancelled')).status).toBe(200);
		expect(
			await (
				await shop.db()
			)
				.collection(COLLECTIONS.serials)
				.countDocuments({ websiteId: shop.websiteId, serial: '353918057895366' }),
		).toBe(0);
	});

	it('keeps registered serials as before and refuses typing them', async () => {
		await shop.setting('grades_serials', 'serialMode', 'registered');
		await shop.setting('grades_serials', 'serialCheck', 'none');
		await api('POST', '/v1/serials', { productId: ids.phone.id, variantId: ids.phone.variants[1].id, serials: ['REG 1'] });
		const { order } = await place([{ productId: ids.phone.id, variantId: ids.phone.variants[1].id }]);
		await move(order.id, 'confirmed');
		expect((await move(order.id, 'packed')).status).toBe(422);
		const packed = await move(order.id, 'packed', { serials: { [order.lines[0].id]: ['REG 1'] } });
		expect(packed.json.lines[0].serials).toEqual(['REG 1']);
		expect((await shop.api('PATCH', `/v1/orders/${order.id}`, { serials: { [order.lines[0].id]: ['REG 1'] } })).status).toBe(
			422,
		);
		const plain = await place([{ productId: ids.case.id }]);
		await move(plain.order.id, 'confirmed');
		expect((await move(plain.order.id, 'packed')).status).toBe(200);
	});
});

describe('E12 warranty per variant', () => {
	it('keeps the warranty on each line from placement and prints it', async () => {
		const { order } = await place([
			{ productId: ids.phone.id, variantId: ids.phone.variants[0].id },
			{ productId: ids.phone.id, variantId: ids.phone.variants[1].id },
			{ productId: ids.case.id },
		]);
		expect(order.lines.map((/** @type {any} */ line) => line.warrantyDays)).toEqual([365, 30, 14]);
		const record = await (await shop.db()).collection(COLLECTIONS.orders).findOne({ websiteId: shop.websiteId, id: order.id });
		expect(record?.lines.map((/** @type {any} */ line) => line.warrantyDays)).toEqual([365, 30, 14]);
		// a later change of the product does not change the order
		await api('PATCH', `/v1/products/${ids.case.id}`, { warrantyDays: null });
		const invoice = await shop.api('GET', `/v1/orders/${order.id}/invoice`);
		expect(invoice.text).toContain('Warranty: 365 days');
		expect(invoice.text).toContain('Warranty: 14 days');
		const next = await place([{ productId: ids.case.id }]);
		expect(next.order.lines[0].warrantyDays).toBe(7);
	});
});
