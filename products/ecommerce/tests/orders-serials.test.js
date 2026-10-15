/**
 * Units (serial numbers, PLAN 0.8.10 E11 and dynamic model §1–§2) and warranty (E12) through the API: the item type of a
 * category numbers its products' units; typed units at packing or later, checked against the type's unit fields (an IMEI
 * as one merchant's field: 15 digits, Luhn, up to two per unit), needed before dispatch, shown to shoppers and printed as
 * the fields say; units added to stock checked the same way (no number names two units), only for items whose type
 * numbers them; units in stock picked at packing; the warranty each line keeps from placement (variant, product, grade,
 * setting), used by claims and printed on invoices.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { missingSerials, serialPlan } from '../core/orders.js';
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

/**
 * The shop's item types: phones number their units by the IMEI and bin tag fields, typed at packing or later (needed
 * before dispatch) or picked from stock; chargers by a plain serial number from stock.
 * @param {'packing' | 'stock'} capture
 */
const saveTypes = (capture) =>
	shop.list('item_types', [
		{
			key: 'phone',
			name: 'Phone',
			kind: 'physical',
			elements: { variants: true, grades: true, warranty: true, units: { fieldIds: [ids.imei.id, ids.tag.id], capture } },
		},
		{ key: 'charger', name: 'Charger', kind: 'physical', elements: { warranty: true, units: { capture: 'stock' } } },
	]);

beforeAll(async () => {
	shop = await readyShop({ features: ALL.filter((feature) => feature !== 'multi_location') });
	await shop.list('grades', [{ key: 'used', label: 'Used', warrantyTime: { amount: 30, unit: /** @type {const} */ ('days') } }]);
	await shop.setting('returns', 'warrantyTime', 7);
	// the IMEI is one merchant's unit field: digits, 15 long, Luhn, two per dual-SIM phone; shown to shoppers and on invoices
	ids.imei = await api('POST', '/v1/attributes', {
		name: 'IMEI',
		on: 'unit',
		multiple: true,
		required: true,
		format: { chars: 'digits', minLength: 15, maxLength: 15, checkDigit: 'luhn', ignoreSpaces: true },
		show: { shopper: true, invoice: true },
	});
	// a staff-only unit field: never shown to shoppers nor printed (after the IMEI in the type: a unit is named by its
	// IMEI, and a number alone is an IMEI)
	ids.tag = await api('POST', '/v1/attributes', {
		name: 'Bin tag',
		on: 'unit',
		format: { chars: 'letters_digits_dash', mask: 'AA-999', upperCase: true },
	});
	await saveTypes('packing');
	ids.phones = await api('POST', '/v1/categories', { name: 'Phones', typeKey: 'phone' });
	ids.android = await api('POST', '/v1/categories', { name: 'Android', parentId: ids.phones.id });
	ids.cases = await api('POST', '/v1/categories', { name: 'Cases' });
	ids.phone = await api('POST', '/v1/products', {
		name: 'Phone',
		status: 'active',
		categoryIds: [ids.android.id],
		options: [{ name: 'Color', values: ['Black', 'Blue'] }],
		variants: [
			{
				options: { Color: 'Black' },
				price: 1000,
				stock: 9,
				warrantyTime: { amount: 365, unit: /** @type {const} */ ('days') },
			},
			{ options: { Color: 'Blue' }, price: 1000, stock: 9, grade: 'used' },
		],
	});
	ids.case = await api('POST', '/v1/products', {
		name: 'Case',
		status: 'active',
		categoryIds: [ids.cases.id],
		price: 100,
		stock: 9,
		warrantyTime: { amount: 14, unit: /** @type {const} */ ('days') },
	});
	ids.charger = await api('POST', '/v1/products', {
		name: 'Charger',
		status: 'active',
		typeKey: 'charger',
		price: 50,
		stock: 9,
	});
});
afterAll(async () => shop.product.close());

describe('E11 serial capture', () => {
	it('plans units as each line’s item type says: picked from stock at packing, typed by the stage they are needed', () => {
		const order = /** @type {any} */ ({
			lines: [
				{ id: 'l1', kind: 'physical', productId: 'p', variantId: 'v', name: 'P', quantity: 2, serials: [] },
				{ id: 'l2', kind: 'physical', productId: 'q', variantId: 'w', name: 'Q', quantity: 1, serials: [] },
			],
		});
		const typed = new Map([['p', /** @type {const} */ ({ capture: 'packing', requiredBefore: 'shipped' })]]);
		expect(serialPlan(order, typed, {}, { stage: 'packed' })).toMatchObject({
			ok: true,
			value: [{ lineId: 'l1', serials: [], capture: 'packing' }],
		});
		const stocked = new Map([['p', /** @type {const} */ ({ capture: 'stock', requiredBefore: 'packed' })]]);
		expect(serialPlan(order, stocked, {}, { stage: 'packed' }).ok).toBe(false);
		expect(serialPlan(order, typed, {}, { stage: 'shipped' }).ok).toBe(false);
		expect(serialPlan(order, typed, { l1: ['a'] }, { stage: 'packed' }).ok).toBe(false);
		expect(serialPlan(order, typed, { l2: ['a'] }, { stage: 'packed' }).ok).toBe(false);
		expect(serialPlan(order, typed, { l1: ['a', 'b'] }, { stage: 'packed', only: true }).ok).toBe(true);
		expect(missingSerials(order, typed, 'packed')).toEqual([]);
		expect(missingSerials(order, typed, 'shipped').map((line) => line.id)).toEqual(['l1']);
		expect(missingSerials(order, typed, 'delivered').map((line) => line.id)).toEqual(['l1']);
		// numbers never needed: a line may go out without them
		const optional = new Map([['p', /** @type {const} */ ({ capture: 'packing', requiredBefore: null })]]);
		expect(serialPlan(order, optional, {}, { stage: 'delivered' }).ok).toBe(true);
		expect(missingSerials(order, optional, 'delivered')).toEqual([]);
	});

	it('takes typed units at packing or later in their fields’ formats, needs them before dispatch and shows what the fields say', async () => {
		const { order, token } = await place([{ productId: ids.phone.id, variantId: ids.phone.variants[0].id }]);
		const line = order.lines[0];
		// not before packing
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
		/** @param {unknown[]} units */
		const typeUnits = (units) => shop.api('PATCH', `/v1/orders/${order.id}`, { serials: { [line.id]: units } });
		// the IMEI's format: a wrong check digit, too short, and a bin tag off its pattern are refused, naming the value
		const wrong = await typeUnits([{ values: { [ids.imei.id]: ['490154203237519'] } }]);
		expect(wrong.status).toBe(422);
		expect(wrong.json.errors[0]).toMatchObject({
			path: `/serials/${line.id}/0/values/${ids.imei.id}`,
			message: '490154203237519 does not match the format of IMEI.',
		});
		expect((await typeUnits(['12345'])).status).toBe(422);
		expect((await typeUnits([{ values: { [ids.imei.id]: '490154203237518', [ids.tag.id]: 'A-12' } }])).status).toBe(422);
		// one number per unit; the IMEI is required
		expect((await typeUnits(['490154203237518', '356938035643809'])).status).toBe(422);
		expect((await typeUnits([{ values: { [ids.tag.id]: 'ab-123' } }])).status).toBe(422);
		// a dual-SIM phone: two IMEIs of one unit, kept without spaces, and its bin tag upper-cased
		const typed = await api('PATCH', `/v1/orders/${order.id}`, {
			serials: {
				[line.id]: [{ values: { [ids.imei.id]: ['4901 5420 3237 518', '356938035643809'], [ids.tag.id]: 'ab-123' } }],
			},
		});
		expect(typed.lines[0]).toMatchObject({
			unitCapture: 'packing',
			unitsRequiredBefore: 'shipped',
			serials: ['490154203237518'],
			unitFields: [
				{ id: ids.imei.id, name: 'IMEI', maxValues: 2, required: true },
				{ id: ids.tag.id, name: 'Bin tag', maxValues: 1, required: false },
			],
			units: [
				{
					serial: '490154203237518',
					values: { [ids.imei.id]: ['490154203237518', '356938035643809'], [ids.tag.id]: ['AB-123'] },
				},
			],
		});
		expect(typed.history.at(-1)).toMatchObject({ note: 'Serial numbers typed', code: 'serials_typed', byKind: 'server' });
		const data = await shop.db();
		const recorded = await data
			.collection(COLLECTIONS.serials)
			.findOne({ websiteId: shop.websiteId, serial: '490154203237518' });
		expect(recorded).toMatchObject({
			status: 'sold',
			orderId: order.id,
			typed: true,
			keys: expect.arrayContaining(['num:356938035643809', 'num:AB-123', 'num:490154203237518']),
		});
		expect((await move(order.id, 'dispatched', { shipment })).status).toBe(200);
		// what shoppers see: the IMEI shown to them, never the staff's bin tag
		const view = await shop.call('GET', `/v1/shop/orders/${order.id}`, {
			token: shop.browser,
			origin: ORIGIN,
			headers: { 'ss-sign-in': token, 'x-forwarded-for': '10.9.1.1' },
		});
		expect(view.json.lines[0]).toMatchObject({
			serials: [],
			unitValues: [{ name: 'IMEI', values: ['490154203237518', '356938035643809'] }],
			warrantyTime: { amount: 365, unit: /** @type {const} */ ('days') },
		});
		expect(view.text).not.toContain('AB-123');
		// the invoice prints the IMEI (show.invoice), the packing slip does not; the bin tag is never printed
		const invoice = (await shop.api('GET', `/v1/orders/${order.id}/invoice`)).text;
		expect(invoice).toContain('IMEI: 490154203237518, 356938035643809');
		expect(invoice).not.toContain('AB-123');
		expect((await shop.api('GET', `/v1/orders/${order.id}/packing-slip`)).text).not.toContain('490154203237518');
		// staff may still correct them after dispatch; the old numbers are forgotten
		const fixed = await api('PATCH', `/v1/orders/${order.id}`, {
			serials: { [line.id]: [{ values: { [ids.imei.id]: ['356938035643809'] } }] },
		});
		expect(fixed.lines[0].serials).toEqual(['356938035643809']);
		expect(
			await data.collection(COLLECTIONS.serials).countDocuments({ websiteId: shop.websiteId, serial: '490154203237518' }),
		).toBe(0);
		// another order cannot take a number of a unit already recorded, not even as its second IMEI
		const other = await place([{ productId: ids.phone.id, variantId: ids.phone.variants[0].id }]);
		const otherLine = other.order.lines[0].id;
		await move(other.order.id, 'confirmed');
		const clash = await move(other.order.id, 'packed', {
			serials: { [otherLine]: [{ values: { [ids.imei.id]: ['352099001761481', '356938035643809'] } }] },
		});
		expect(clash.status).toBe(422);
		expect(clash.json.detail).toContain('already recorded');
		// two units of one request may not share a number
		const twice = await move(other.order.id, 'packed', {
			serials: { [otherLine]: [{ values: { [ids.imei.id]: ['352099001761481', '352099001761481'] } }] },
		});
		expect(twice.status).toBe(422);
		// a cancel deletes typed units of the other order (they never were in stock)
		await move(other.order.id, 'packed', { serials: { [otherLine]: ['352099001761481'] } });
		expect((await move(other.order.id, 'cancelled')).status).toBe(200);
		expect(
			await data.collection(COLLECTIONS.serials).countDocuments({ websiteId: shop.websiteId, serial: '352099001761481' }),
		).toBe(0);
	});

	it('checks units added to stock against their unit fields, and picks units in stock at packing', async () => {
		await saveTypes('stock');
		const black = { productId: ids.phone.id, variantId: ids.phone.variants[1].id };
		/** @param {unknown[]} serials */
		const add = (serials) => shop.api('POST', '/v1/serials', { ...black, serials });
		// stock-added units follow the same formats as typed ones (this was not checked before)
		const refused = await add(['861234045678905', { values: { [ids.imei.id]: ['861234045678904'], [ids.tag.id]: '1' } }]);
		expect(refused.status).toBe(422);
		expect(refused.json.errors.map((/** @type {any} */ error) => error.path)).toEqual([
			`/serials/0/values/${ids.imei.id}`,
			`/serials/1/values/${ids.tag.id}`,
		]);
		expect((await add(['012345678901237', '012345678901237'])).status).toBe(422);
		const added = await add(['861234045678904', { values: { [ids.imei.id]: ['357805023984942', '012345678901237'] } }]);
		expect(added.status).toBe(201);
		expect(added.json.items.map((/** @type {any} */ unit) => [unit.serial, unit.values[ids.imei.id]])).toEqual([
			['861234045678904', ['861234045678904']],
			['357805023984942', ['357805023984942', '012345678901237']],
		]);
		// a number of a unit already recorded, even its second IMEI, is refused
		const again = await add(['012345678901237']);
		expect(again.status).toBe(409);
		expect(again.json.detail).toContain('357805023984942');
		// a charger's type numbers its units without unit fields: a plain serial number; a case's type numbers none
		expect(
			(
				await shop.api('POST', '/v1/serials', {
					productId: ids.charger.id,
					variantId: ids.charger.variants[0].id,
					serials: ['CHARGER 1'],
				})
			).status,
		).toBe(201);
		const unnumbered = await shop.api('POST', '/v1/serials', {
			productId: ids.case.id,
			variantId: ids.case.variants[0].id,
			serials: ['CASE 1'],
		});
		expect(unnumbered.status).toBe(422);
		expect(unnumbered.json.errors[0]).toMatchObject({ path: '/productId' });
		const { order } = await place([black]);
		await move(order.id, 'confirmed');
		expect((await move(order.id, 'packed')).status).toBe(422);
		// units in stock are picked by their serial numbers
		expect((await move(order.id, 'packed', { serials: { [order.lines[0].id]: [{ values: {} }] } })).status).toBe(422);
		const packed = await move(order.id, 'packed', { serials: { [order.lines[0].id]: ['357805023984942'] } });
		expect(packed.json.lines[0].serials).toEqual(['357805023984942']);
		expect(packed.json.lines[0].units[0].values[ids.imei.id]).toEqual(['357805023984942', '012345678901237']);
		expect(
			(await shop.api('PATCH', `/v1/orders/${order.id}`, { serials: { [order.lines[0].id]: ['357805023984942'] } })).status,
		).toBe(422);
		const plain = await place([{ productId: ids.case.id }]);
		await move(plain.order.id, 'confirmed');
		expect((await move(plain.order.id, 'packed')).status).toBe(200);
	});
});

describe('units moved in by an import', () => {
	it('checks imported units against the unit fields and keeps them as the shop does', async () => {
		const send = async (/** @type {unknown[]} */ records) => {
			const answer = await shop.api('POST', '/v1/import/serials', records.map((record) => JSON.stringify(record)).join('\n'), {
				'content-type': 'application/x-ndjson',
			});
			expect(answer.status).toBe(200);
			return answer.json;
		};
		const unit = {
			productId: ids.phone.id,
			variantId: ids.phone.variants[0].id,
			status: 'in_stock',
			orderId: null,
			lineId: null,
			locationId: null,
		};
		const result = await send([
			{ ...unit, id: 'ser_imported00000000000001', values: { [ids.imei.id]: ['013372003016466'] } },
			{ ...unit, id: 'ser_imported00000000000002', serial: '012345678901237' },
			{ ...unit, id: 'ser_imported00000000000003', values: { [ids.imei.id]: ['4901 5420 3237 518'] } },
			{ ...unit, id: 'ser_imported00000000000004', serial: 'X', values: { [ids.imei.id]: ['352099001761481'] } },
			{ ...unit, id: 'ser_imported00000000000005', values: { [ids.imei.id]: ['352099001761481', '861234045678904'] } },
		]);
		expect(result.inserted).toBe(1);
		expect(result.failed.map((/** @type {any} */ row) => [row.id, row.errors[0].message])).toEqual([
			['ser_imported00000000000001', '013372003016466 does not match the format of IMEI.'],
			// numbers other units of the shop already have (units added to stock above), even as a second IMEI
			[
				'ser_imported00000000000002',
				expect.stringMatching(/^Another unit \(ser_\w+\) already has the number 012345678901237\.$/),
			],
			['ser_imported00000000000004', "The unit's serial is 352099001761481, the first value of its unit fields."],
			['ser_imported00000000000005', expect.stringContaining('already has the number 861234045678904')],
		]);
		// kept as the shop keeps a unit: its IMEI without spaces names it
		const kept = await (
			await shop.db()
		)
			.collection(COLLECTIONS.serials)
			.findOne({ websiteId: shop.websiteId, id: 'ser_imported00000000000003' });
		expect(kept).toMatchObject({
			serial: '490154203237518',
			values: { [ids.imei.id]: ['490154203237518'] },
			keys: ['num:490154203237518'],
		});
	});
});

describe('E12 warranty per variant', () => {
	it('keeps the warranty on each line from placement and prints it', async () => {
		const { order } = await place([
			{ productId: ids.phone.id, variantId: ids.phone.variants[0].id },
			{ productId: ids.phone.id, variantId: ids.phone.variants[1].id },
			{ productId: ids.case.id },
		]);
		const days = (/** @type {number} */ amount) => ({ amount, unit: 'days' });
		expect(order.lines.map((/** @type {any} */ line) => line.warrantyTime)).toEqual([days(365), days(30), days(14)]);
		const record = await (await shop.db()).collection(COLLECTIONS.orders).findOne({ websiteId: shop.websiteId, id: order.id });
		expect(record?.lines.map((/** @type {any} */ line) => line.warrantyTime)).toEqual([days(365), days(30), days(14)]);
		// a later change of the product does not change the order
		await api('PATCH', `/v1/products/${ids.case.id}`, { warrantyTime: null });
		const invoice = await shop.api('GET', `/v1/orders/${order.id}/invoice`);
		expect(invoice.text).toContain('Warranty: 365 days');
		expect(invoice.text).toContain('Warranty: 14 days');
		const next = await place([{ productId: ids.case.id }]);
		expect(next.order.lines[0].warrantyTime).toEqual(days(7));
	});
});
