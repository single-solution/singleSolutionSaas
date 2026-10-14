/**
 * Item types through the API (PLAN 0.8.10 dynamic model §1, phase 4): a product's type (its own, its category's, the
 * built-in one of its kind) and its kind; values of parts a type does not have refused at their paths; fields a type
 * does not name; a type change refused while units are in stock (the product's, a category's, the list's); answers with
 * `type`; services with and without booked slots; a type without a measurement table shows none; and units numbered as
 * each line's type says through the order moves (typed at packing or with the move that needs them, picked from stock).
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

/** The paths of a refusal. @param {{ status: number, json: any }} answer */
const pathsOf = (answer) => {
	expect(answer.status).toBe(422);
	return answer.json.errors.map((/** @type {any} */ error) => error.path);
};

/** @param {string} method @param {string} path @param {unknown} [body] */
const shopper = (method, path, body) =>
	shop.call(method, path, { token: shop.browser, origin: ORIGIN, ...(body === undefined ? {} : { body }) });

/** Place a cash order of `lines` as a signed-in shopper. @param {Array<Record<string, unknown>>} lines */
const place = async (lines) => {
	ip += 1;
	const token = await shop.signIn({ id: `usr_types${String(ip).padStart(7, '0')}` });
	const answer = await shop.call('POST', '/v1/shop/orders', {
		token: shop.browser,
		origin: ORIGIN,
		body: {
			lines: lines.map((line) => ({ quantity: 1, ...line })),
			payment: 'cod',
			address: { name: 'Alex Morgan', phone: '+12025550143', line1: '1 Main Street', city: 'New York', country: 'US' },
		},
		headers: { 'x-forwarded-for': `10.7.0.${ip}`, 'ss-sign-in': token, 'idempotency-key': `types-${ip}` },
	});
	if (answer.status !== 201) throw new Error(`place: ${answer.status} ${answer.text}`);
	return answer.json.order;
};

/** @param {string} id @param {string} to @param {Record<string, unknown>} [extra] */
const move = (id, to, extra = {}) => shop.api('POST', `/v1/orders/${id}/move`, { to, ...extra });

/** The item types of the shop. @param {Record<string, unknown>} [phoneUnits] the phones' units */
const saveTypes = (phoneUnits = {}) =>
	shop.list('item_types', [
		{
			key: 'used_phone',
			name: 'Used phone',
			kind: 'physical',
			elements: {
				variants: true,
				grades: true,
				parcel: true,
				warranty: true,
				units: { fieldIds: [ids.imei.id], capture: 'packing', requiredBefore: 'shipped', ...phoneUnits },
			},
			fieldIds: [ids.battery.id, ids.color.id],
		},
		{ key: 'gift_card', name: 'Gift card', kind: 'digital', elements: { licenceKeys: true } },
		{ key: 'repair', name: 'Repair', kind: 'service', elements: { warranty: true } },
		{ key: 'session', name: 'Session', kind: 'service', elements: { slots: true } },
		{ key: 'plain_box', name: 'Plain box', kind: 'physical', elements: {} },
		{ key: 'counted', name: 'Counted', kind: 'physical', elements: { units: { capture: 'stock' } } },
	]);

beforeAll(async () => {
	shop = await readyShop({ features: ALL.filter((feature) => feature !== 'multi_location') });
	// grade a is for every type; mint only for used phones (a grade set per item type)
	await shop.list('grades', [
		{ key: 'a', label: 'A' },
		{ key: 'mint', label: 'Mint', typeKeys: ['used_phone'] },
	]);
	await shop.list(
		'booking_hours',
		[0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, from: '09:00', to: '17:00' })),
	);
	await shop.list('couriers', [{ key: 'post', name: 'Post', trackingUrl: 'https://post.example/track/{tracking}' }]);
	ids.battery = await api('POST', '/v1/attributes', { name: 'Battery health', type: 'number' });
	ids.note = await api('POST', '/v1/attributes', { name: 'Note' });
	ids.color = await api('POST', '/v1/attributes', {
		name: 'Color',
		on: 'variant',
		type: 'choice',
		choices: [{ value: 'black', label: 'Black' }],
	});
	ids.imei = await api('POST', '/v1/attributes', {
		name: 'IMEI',
		on: 'unit',
		format: { chars: 'digits', minLength: 15, maxLength: 15, checkDigit: 'luhn' },
	});
	await saveTypes();
	ids.chart = await api('POST', '/v1/size-charts', {
		name: 'Boxes',
		unit: 'cm',
		columns: [{ key: 'width', label: 'Width' }],
		rows: [{ size: 'M', values: { width: '30' } }],
	});
	ids.phones = await api('POST', '/v1/categories', { name: 'Phones', typeKey: 'used_phone', sizeChartId: ids.chart.id });
	ids.android = await api('POST', '/v1/categories', { name: 'Android', parentId: ids.phones.id });
	ids.other = await api('POST', '/v1/categories', { name: 'Other' });
});
afterAll(async () => shop.product.close());

describe('the type of a product', () => {
	it('is its own, else its category’s or the one above it, else the built-in one of its kind, and gives the kind', async () => {
		const phone = await api('POST', '/v1/products', { name: 'Phone', price: 100, categoryIds: [ids.android.id] });
		expect(phone).toMatchObject({ kind: 'physical', typeKey: null, type: { key: 'used_phone', kind: 'physical' } });
		// a type of another kind never applies: the category's physical type is not a digital product's
		const ebook = await api('POST', '/v1/products', {
			name: 'Manual',
			kind: 'digital',
			price: 100,
			categoryIds: [ids.phones.id],
		});
		expect(ebook).toMatchObject({ kind: 'digital', type: { key: 'digital', kind: 'digital' } });
		// naming a type gives its kind; a kind given must be the type's
		const card = await api('POST', '/v1/products', { name: 'Gift card', typeKey: 'gift_card', price: 100 });
		expect(card).toMatchObject({ kind: 'digital', typeKey: 'gift_card', type: { key: 'gift_card', kind: 'digital' } });
		expect(
			pathsOf(await shop.api('POST', '/v1/products', { name: 'X', kind: 'physical', typeKey: 'gift_card', price: 1 })),
		).toEqual(['/typeKey']);
		expect(pathsOf(await shop.api('PATCH', `/v1/products/${card.id}`, { kind: 'physical' }))).toEqual(['/typeKey']);
		expect(pathsOf(await shop.api('POST', '/v1/products', { name: 'X', typeKey: 'nope', price: 1 }))).toEqual(['/typeKey']);
		// a built-in type named by a product overrides its category's
		const plain = await api('POST', '/v1/products', {
			name: 'Charger',
			typeKey: 'physical',
			price: 100,
			categoryIds: [ids.phones.id],
		});
		expect(plain.type).toEqual({ key: 'physical', kind: 'physical' });
		// a type no longer offered stays on what has it, but is not given to more
		await shop.list(
			'item_types',
			(await api('GET', '/v1/lists/item_types')).value.map((/** @type {any} */ type) =>
				type.key === 'gift_card' ? { ...type, active: false } : type,
			),
		);
		expect(pathsOf(await shop.api('POST', '/v1/products', { name: 'X', typeKey: 'gift_card', price: 1 }))).toEqual([
			'/typeKey',
		]);
		expect((await shop.api('PATCH', `/v1/products/${card.id}`, { typeKey: 'gift_card', name: 'Card' })).status).toBe(200);
		await saveTypes();
		// the staff list shows the own type key
		const row = (await api('GET', `/v1/products?q=Charger`)).items[0];
		expect(row).toMatchObject({ typeKey: 'physical' });
	});

	it('refuses values of the parts its type does not have, each at its path', async () => {
		const box = { name: 'Box', typeKey: 'plain_box' };
		expect(
			pathsOf(
				await shop.api('POST', '/v1/products', {
					...box,
					price: 1,
					grade: 'a',
					hideSizeGuide: true,
					parcel: { weightG: 500 },
					warrantyDays: 30,
				}),
			),
		).toEqual(['/grade', '/hideSizeGuide', '/parcel', '/warrantyDays']);
		expect(
			pathsOf(
				await shop.api('POST', '/v1/products', {
					...box,
					options: [{ name: 'Size', values: ['S', 'M'] }],
					variants: [
						{ options: { Size: 'S' }, price: 1, attributes: { [ids.color.id]: 'black' } },
						{ options: { Size: 'M' }, price: 1 },
					],
				}),
			),
		).toEqual(['/variants', '/options', '/variants/0/attributes']);
		// a phone takes the fields its type names, and no other
		expect(
			pathsOf(
				await shop.api('POST', '/v1/products', {
					name: 'Phone',
					typeKey: 'used_phone',
					price: 1,
					specs: { [ids.battery.id]: 90, [ids.note.id]: 'Scratched' },
				}),
			),
		).toEqual([`/specs/${ids.note.id}`]);
		// a gift card has license keys, not downloads; a repair has no booked slots
		expect(
			pathsOf(
				await shop.api('POST', '/v1/products', {
					name: 'Card',
					typeKey: 'gift_card',
					price: 1,
					digital: { downloadLimit: 3, licenceKeys: true },
				}),
			),
		).toEqual(['/digital/downloadLimit']);
		const card = await api('POST', '/v1/products', { name: 'Card', typeKey: 'gift_card', price: 1 });
		expect((await api('POST', `/v1/products/${card.id}/licences`, { keys: ['KEY-1'] })).added).toBe(1);
		const file = await shop.api('POST', `/v1/products/${card.id}/files`, {
			name: 'card.pdf',
			type: 'application/pdf',
			size: 10,
		});
		expect(pathsOf(file)).toEqual(['/id']);
		expect(
			pathsOf(
				await shop.api('POST', '/v1/products', {
					name: 'Fix',
					typeKey: 'repair',
					price: 1,
					booking: { durationMinutes: 30 },
				}),
			),
		).toEqual(['/booking']);
		// what the type has is kept: a phone's package, grade and warranty
		const phone = await api('POST', '/v1/products', {
			name: 'Phone',
			typeKey: 'used_phone',
			price: 1,
			grade: 'a',
			warrantyDays: 90,
			parcel: { weightG: 180, lengthMm: 160, widthMm: 80, heightMm: 10 },
			specs: { [ids.battery.id]: 90 },
		});
		expect(phone.warrantyDays).toBe(90);
		expect(phone.variants[0]).toMatchObject({
			grade: 'a',
			parcel: { weightG: 180, lengthMm: 160, widthMm: 80, heightMm: 10 },
		});
		expect(pathsOf(await shop.api('PATCH', `/v1/products/${phone.id}`, { parcel: { weightG: 0, lengthMm: 10 } }))).toEqual([
			'/parcel/weightG',
			'/parcel/lengthMm',
		]);
		const cleared = await api('PATCH', `/v1/products/${phone.id}`, { parcel: null });
		expect(cleared.variants[0]).not.toHaveProperty('parcel');
		// the grades of its type: mint is a used phone's, not a plain item's
		expect((await api('PATCH', `/v1/products/${phone.id}`, { grade: 'mint' })).variants[0].grade).toBe('mint');
		const plain = await shop.api('POST', '/v1/products', { name: 'Lamp', price: 1, grade: 'mint' });
		expect(pathsOf(plain)).toEqual(['/grade']);
		expect(plain.json.errors[0].message).toBe('This grade is not for this item type: pick one of its grades.');
	});
});

describe('services', () => {
	it('are booked in slots when their type says so, else sold without a time', async () => {
		const fix = await api('POST', '/v1/products', { name: 'Screen repair', typeKey: 'repair', price: 5000, status: 'active' });
		expect(fix).toMatchObject({ kind: 'service', booking: null, trackStock: false });
		const quote = await shopper('POST', '/v1/shop/cart/quote', { lines: [{ productId: fix.id, quantity: 2 }] });
		expect(quote.json).toMatchObject({ ready: true, delivery: { method: 'none' }, lines: [{ quantity: 2, slot: null }] });
		expect((await shopper('GET', `/v1/shop/slots?productId=${fix.id}`)).status).toBe(404);
		const page = await shopper('GET', `/v1/shop/products/${fix.slug}`);
		expect(page.json).toMatchObject({ kind: 'service', type: { key: 'repair', kind: 'service' }, booking: null });
		// a session is booked: a slot is needed, one per slot
		const session = await api('POST', '/v1/products', {
			name: 'Session',
			typeKey: 'session',
			price: 5000,
			status: 'active',
			booking: { durationMinutes: 60 },
		});
		const needed = await shopper('POST', '/v1/shop/cart/quote', { lines: [{ productId: session.id, quantity: 1 }] });
		expect(needed.json.lines[0].problems[0].code).toBe('slot_required');
		expect((await shopper('GET', `/v1/shop/products/${session.slug}`)).json.booking).toEqual({ durationMinutes: 60 });
		expect((await shopper('GET', `/v1/shop/slots?productId=${session.id}`)).status).toBe(200);
	});
});

describe('the parts a type has on its pages', () => {
	it('shows a size chart only for items whose type has one', async () => {
		const phone = await api('POST', '/v1/products', {
			name: 'Boxed phone',
			price: 100,
			status: 'active',
			typeKey: 'physical',
			categoryIds: [ids.phones.id],
		});
		expect((await shopper('GET', `/v1/shop/products/${phone.slug}`)).json.sizeChart).toMatchObject({ name: 'Boxes' });
		const used = await api('PATCH', `/v1/products/${phone.id}`, { typeKey: 'used_phone' });
		const page = (await shopper('GET', `/v1/shop/products/${used.slug}`)).json;
		expect(page).toMatchObject({ type: { key: 'used_phone', kind: 'physical' }, sizeChart: null });
	});
});

describe('packages', () => {
	it('go out as the feeds’ shipping weight', async () => {
		await shop.setting('feeds', 'items', 'all');
		await api('POST', '/v1/products', {
			name: 'Boxed lamp',
			status: 'active',
			typeKey: 'physical',
			price: 2500,
			stock: 1,
			parcel: { weightG: 1200, lengthMm: 300, widthMm: 200, heightMm: 200 },
		});
		const feed = (await shop.api('GET', '/v1/feeds/products.xml')).text;
		expect(feed).toContain('<g:shipping_weight>1200 g</g:shipping_weight>');
		expect((await shop.api('GET', '/v1/feeds/products.csv')).text).toContain(',1200 g,');
	});
});

describe('a type change while units are in stock', () => {
	it('is refused for the product, its category and the list, and allowed once the units are gone', async () => {
		const phone = await api('POST', '/v1/products', {
			name: 'Stocked phone',
			price: 100,
			categoryIds: [ids.android.id],
		});
		const variantId = phone.variants[0].id;
		const added = await api('POST', '/v1/serials', { productId: phone.id, variantId, serials: ['490154203237518'] });
		expect((await shop.api('PATCH', `/v1/products/${phone.id}`, { typeKey: 'plain_box' })).status).toBe(409);
		expect((await shop.api('PATCH', `/v1/products/${phone.id}`, { categoryIds: [ids.other.id] })).status).toBe(409);
		expect((await shop.api('PATCH', `/v1/categories/${ids.android.id}`, { typeKey: 'plain_box' })).status).toBe(409);
		expect((await shop.api('PATCH', `/v1/categories/${ids.android.id}`, { parentId: null })).status).toBe(409);
		expect((await shop.api('PATCH', `/v1/categories/${ids.phones.id}`, { typeKey: null })).status).toBe(409);
		// a change that keeps its type is fine
		expect((await shop.api('PATCH', `/v1/categories/${ids.android.id}`, { typeKey: 'used_phone' })).status).toBe(200);
		const list = shop.dashboard(await shop.adminSession(), 'PUT', `/v1/dashboard/websites/${shop.websiteId}/lists/item_types`, {
			value: (await api('GET', '/v1/lists/item_types')).value.map((/** @type {any} */ type) =>
				type.key === 'used_phone' ? { ...type, elements: { ...type.elements, units: null } } : type,
			),
		});
		expect((await list).json.errors[0]).toMatchObject({ path: '/value/0/elements/units' });
		// a product whose type numbers no units takes none
		const box = await api('POST', '/v1/products', { name: 'Box', typeKey: 'plain_box', price: 1 });
		expect(
			pathsOf(await shop.api('POST', '/v1/serials', { productId: box.id, variantId: box.variants[0].id, serials: ['X1'] })),
		).toEqual(['/productId']);
		await api('DELETE', `/v1/serials/${added.items[0].id}`);
		expect((await shop.api('PATCH', `/v1/products/${phone.id}`, { typeKey: 'plain_box' })).status).toBe(200);
		await api('PATCH', `/v1/categories/${ids.android.id}`, { typeKey: null });
	});
});

describe('units through the order moves', () => {
	it('takes typed numbers with the move that needs them, also skipping packing, and picks stocked ones', async () => {
		const phone = await api('POST', '/v1/products', {
			name: 'Pickup phone',
			price: 100,
			stock: 5,
			status: 'active',
			typeKey: 'used_phone',
		});
		// confirmed → delivered (pay at pickup): the IMEI the type needs before the goods go out comes with the move
		const pickup = await place([{ productId: phone.id }]);
		await move(pickup.id, 'confirmed');
		const missing = await move(pickup.id, 'delivered');
		expect(missing.status).toBe(422);
		expect(missing.json.detail).toBe('Type the serial numbers of Pickup phone first.');
		const delivered = await move(pickup.id, 'delivered', { serials: { [pickup.lines[0].id]: ['490154203237518'] } });
		expect(delivered.status).toBe(200);
		expect(delivered.json.lines[0]).toMatchObject({
			serials: ['490154203237518'],
			unitCapture: 'packing',
			unitsRequiredBefore: 'shipped',
		});
		expect(delivered.json.facts.units).toBe('captured');
		// needed before packing: typed with the packing move
		await saveTypes({ requiredBefore: 'packed' });
		const packing = await place([{ productId: phone.id }]);
		await move(packing.id, 'confirmed');
		expect((await move(packing.id, 'packed')).status).toBe(422);
		expect(
			(await move(packing.id, 'packed', { serials: { [packing.lines[0].id]: ['356938035643809'] } })).json.lines[0].serials,
		).toEqual(['356938035643809']);
		// never needed: it ships without them
		await saveTypes({ requiredBefore: null });
		const optional = await place([{ productId: phone.id }]);
		await move(optional.id, 'confirmed');
		await move(optional.id, 'packed');
		const shipped = await move(optional.id, 'dispatched', { shipment: { courier: 'post', trackingNumber: 'T-9' } });
		expect(shipped.status).toBe(200);
		await saveTypes();
		// counted items are picked from stock when packing, never typed later
		const counted = await api('POST', '/v1/products', {
			name: 'Counted',
			price: 10,
			stock: 5,
			status: 'active',
			typeKey: 'counted',
		});
		await api('POST', '/v1/serials', { productId: counted.id, variantId: counted.variants[0].id, serials: ['C-1'] });
		const stocked = await place([{ productId: counted.id }]);
		await move(stocked.id, 'confirmed');
		expect((await move(stocked.id, 'packed')).status).toBe(422);
		const packed = await move(stocked.id, 'packed', { serials: { [stocked.lines[0].id]: ['C-1'] } });
		expect(packed.json.lines[0]).toMatchObject({ serials: ['C-1'], unitCapture: 'stock', unitsRequiredBefore: 'packed' });
		const later = await shop.api('PATCH', `/v1/orders/${stocked.id}`, { serials: { [stocked.lines[0].id]: ['C-2'] } });
		expect(later.status).toBe(422);
		expect(later.json.errors[0]).toMatchObject({ path: `/serials/${stocked.lines[0].id}` });
	});
});
