/**
 * Selling in any unit through the API (PLAN 0.8.10 dynamic model §4, phase 7; feature `measured_sales`): linen sold by
 * the merchant's made-up unit "bolt" in steps of 0.5. The product, card and staff answers carry the measure; the cart
 * prices thousandths of the unit and refuses quantities off its steps; an order holds and gives back stock in
 * thousandths and prints `2.5 bolt`; the low-stock level counts units; deals take a fixed amount off each unit; bundles
 * refuse measured items; claims go by step; Chat quotes a decimal amount; feeds and structured data say nothing of the
 * unit until it is tied to a standard measure, then what the price is for; the unit cannot change while the items have
 * stock; and nothing measured is sold while the feature is off.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL, ORIGIN, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {Record<string, any>} */
const ids = {};
let ip = 0;

/** Linen by the merchant's own "bolt": steps of 0.5, at least 1, at most 20 (thousandths of a bolt), no standard measure. */
const FABRIC = Object.freeze({ unit: 'bolt', decimals: 1, step: 500, min: 1000, max: 20_000, standard: null });
/** Every feature but stock per location (stock is given as one number). */
const FEATURES = ALL.filter((feature) => feature !== 'multi_location');
const ADDRESS = {
	name: 'Alex Morgan',
	phone: '+12025550143',
	line1: '1 Main Street',
	city: 'New York',
	region: 'NY',
	postalCode: '10001',
	country: 'US',
};

/** @param {string} method @param {string} path @param {unknown} [body] */
const api = async (method, path, body) => {
	const answer = await shop.api(method, path, body);
	if (answer.status >= 300) throw new Error(`${method} ${path}: ${answer.status} ${answer.text}`);
	return answer.json;
};

/** @param {string} method @param {string} path @param {unknown} [body] */
const shopper = (method, path, body) =>
	shop.call(method, path, { token: shop.browser, origin: ORIGIN, ...(body === undefined ? {} : { body }) });

/** @param {Array<Record<string, unknown>>} lines */
const quote = async (lines) => (await shopper('POST', '/v1/shop/cart/quote', { lines })).json;

/** Place a cash order as a signed-in shopper. @param {Array<Record<string, unknown>>} lines */
const place = async (lines) => {
	ip += 1;
	const token = await shop.signIn({ id: `usr_measure${String(ip).padStart(5, '0')}` });
	const answer = await shop.call('POST', '/v1/shop/orders', {
		token: shop.browser,
		origin: ORIGIN,
		body: { lines, payment: 'cod', address: ADDRESS },
		headers: { 'x-forwarded-for': `10.9.0.${ip}`, 'ss-sign-in': token, 'idempotency-key': `measure-${ip}` },
	});
	return { answer, token };
};

/** The linen's stock (thousandths of a meter). */
const linenStock = async () => (await api('GET', `/v1/products/${ids.linen.id}`)).variants[0].stock;

/** @param {Array<Record<string, unknown>>} [types] */
const saveTypes = (
	types = [{ key: 'fabric', name: 'Fabric', kind: 'physical', elements: { variants: true, measure: FABRIC } }],
) => shop.list('item_types', types);

beforeAll(async () => {
	shop = await readyShop({ features: FEATURES });
	await saveTypes();
	ids.fabrics = await api('POST', '/v1/categories', { name: 'Fabrics', typeKey: 'fabric' });
	// 10.00 per bolt, 10 bolts in stock
	ids.linen = await api('POST', '/v1/products', {
		name: 'Linen',
		price: 1000,
		stock: 10_000,
		status: 'active',
		categoryIds: [ids.fabrics.id],
	});
	ids.box = await api('POST', '/v1/products', { name: 'Gift box', price: 500, stock: 10, status: 'active' });
});
afterAll(async () => shop.product.close());

describe('answers', () => {
	it('carry the measure on the product page, its card and the staff product', async () => {
		const page = (await shopper('GET', `/v1/shop/products/${ids.linen.id}`)).json;
		expect(page.measure).toEqual(FABRIC);
		expect(page.limits).toEqual({ step: 500, min: 1000, max: 20_000 });
		expect((await shopper('GET', `/v1/shop/products/${ids.box.id}`)).json.limits).toEqual({ step: 1, min: 1, max: 99 });
		const staff = await api('GET', `/v1/products/${ids.linen.id}`);
		expect(staff.type).toEqual({ key: 'fabric', kind: 'physical', measure: FABRIC });
		const cards = (await shopper('GET', '/v1/shop/products')).json.items;
		expect(cards.find((/** @type {any} */ card) => card.id === ids.linen.id).measure).toEqual(FABRIC);
		expect(cards.find((/** @type {any} */ card) => card.id === ids.box.id).measure).toBeNull();
	});
});

describe('the cart', () => {
	it('prices thousandths of the unit and checks the steps, the least and the most', async () => {
		const ok = await quote([{ productId: ids.linen.id, quantity: 2500 }]);
		expect(ok.lines[0]).toMatchObject({
			quantity: 2500,
			unitPrice: 1000,
			total: 2500,
			measure: { unit: 'bolt', quantityText: '2.5' },
		});
		expect(ok.ready).toBe(true);
		/** @param {number} quantity */
		const codes = async (quantity) =>
			(await quote([{ productId: ids.linen.id, quantity }])).lines[0].problems.map((/** @type {any} */ p) => p.code);
		expect(await codes(2600)).toEqual(['quantity_step']);
		expect(await codes(500)).toEqual(['quantity_min']);
		expect(await codes(20_500)).toEqual(['quantity_max', 'not_enough_stock']);
		// a measured line is one piece of the most of one item; pieces keep the checkout's limit
		const box = await quote([{ productId: ids.box.id, quantity: 100 }]);
		expect(box.lines[0].problems).toContainEqual({ code: 'too_many', message: 'At most 99 of one item.' });
		expect(box.lines[0].measure).toBeNull();
		expect(box.lines[0].limits).toEqual({ step: 1, min: 1, max: 99 });
		expect(ok.lines[0].limits).toEqual({ step: 500, min: 1000, max: 20_000 });
	});

	it("holds pieces to their item type's step, least and most (E4)", async () => {
		const cases = { key: 'cases', name: 'Cases', kind: 'physical', elements: { quantity: { step: 6, min: 12, max: 60 } } };
		await saveTypes([
			{ key: 'fabric', name: 'Fabric', kind: 'physical', elements: { variants: true, measure: FABRIC } },
			cases,
		]);
		const water = await api('POST', '/v1/products', {
			name: 'Water',
			price: 100,
			stock: 500,
			status: 'active',
			typeKey: 'cases',
		});
		expect((await shopper('GET', `/v1/shop/products/${water.id}`)).json.limits).toEqual({ step: 6, min: 12, max: 60 });
		// Chat's cards carry them too, so its Add to cart adds the least (pieces: no unit)
		const card = (await api('GET', '/v1/chat/products?q=water&limit=5')).items.find(
			(/** @type {any} */ item) => item.id === water.id,
		);
		expect(card).toMatchObject({ limits: { step: 6, min: 12, max: 60 }, unit: null });
		/** @param {number} quantity */
		const codes = async (quantity) =>
			(await quote([{ productId: water.id, quantity }])).lines[0].problems.map((/** @type {any} */ p) => p.code);
		expect(await codes(18)).toEqual([]);
		expect(await codes(6)).toEqual(['quantity_min']);
		expect(await codes(20)).toEqual(['quantity_step']);
		expect(await codes(66)).toEqual(['quantity_max']);
		await api('DELETE', `/v1/products/${water.id}`);
		await saveTypes();
	});

	it('takes a fixed deal off each unit and a percent off what the line comes to', async () => {
		const fixed = await api('POST', '/v1/deals', { name: 'A meter off', type: 'fixed', value: 100 });
		expect((await quote([{ productId: ids.linen.id, quantity: 2500 }])).lines[0]).toMatchObject({
			dealDiscount: 250,
			total: 2250,
		});
		await api('DELETE', `/v1/deals/${fixed.id}`);
		const percent = await api('POST', '/v1/deals', { name: 'Tenth off', type: 'percent', value: 10 });
		expect((await quote([{ productId: ids.linen.id, quantity: 1500 }])).lines[0]).toMatchObject({ dealDiscount: 150 });
		await api('DELETE', `/v1/deals/${percent.id}`);
	});

	it('refuses bundles and buy X get Y naming measured items', async () => {
		const set = await shop.api('POST', '/v1/bundles', {
			name: 'Linen and box',
			type: 'bundle',
			items: [
				{ productId: ids.linen.id, quantity: 1 },
				{ productId: ids.box.id, quantity: 1 },
			],
			price: 1000,
		});
		expect(set.status).toBe(422);
		expect(set.json.errors[0]).toMatchObject({ path: '/items', code: 'measured' });
		const plain = await shop.api('POST', '/v1/bundles', {
			name: 'Two boxes',
			type: 'bundle',
			items: [{ productId: ids.box.id, quantity: 2 }],
			price: 800,
		});
		expect(plain.status).toBe(201);
		await api('DELETE', `/v1/bundles/${plain.json.id}`);
	});
});

describe('orders', () => {
	it('hold stock in thousandths, keep the measure and print it', async () => {
		const { answer } = await place([{ productId: ids.linen.id, quantity: 2500 }]);
		expect(answer.status).toBe(201);
		const order = answer.json.order;
		expect(order.lines[0]).toMatchObject({ quantity: 2500, total: 2500, measure: { unit: 'bolt', quantityText: '2.5' } });
		expect(order.totals.subtotal).toBe(2500);
		ids.order = order;
		expect(await linenStock()).toBe(7500);
		const staff = await api('GET', `/v1/orders/${order.id}`);
		expect(staff.lines[0].measure).toEqual({ unit: 'bolt', decimals: 1, step: 500 });
		const invoice = (await shop.api('GET', `/v1/orders/${order.id}/invoice`)).text;
		expect(invoice).toContain('2.5 bolt');
		// off its steps: refused, nothing held
		const off = await place([{ productId: ids.linen.id, quantity: 2600 }]);
		expect(off.answer.status).toBe(422);
		expect(off.answer.json.errors[0]).toMatchObject({ path: '/lines/0', code: 'quantity_step' });
		expect(await linenStock()).toBe(7500);
	});

	it('count the low-stock level in units', async () => {
		await shop.setting('catalog', 'lowStock', 5);
		const low = async () =>
			(await api('GET', '/v1/products?lowStock=1')).items.map((/** @type {any} */ row) => row.id).includes(ids.linen.id);
		// 7.5 m left: not low at 5 m (it would be at 5 thousandths)
		expect(await low()).toBe(false);
		const { answer } = await place([{ productId: ids.linen.id, quantity: 3000 }]);
		expect(answer.status).toBe(201);
		expect(await linenStock()).toBe(4500);
		expect(await low()).toBe(true);
		const counts = await api('GET', '/v1/products/counts?by=variantStock');
		expect(counts.groups.low).toBeGreaterThanOrEqual(1);
		// the canceled order gives its 3 m back
		await api('POST', `/v1/orders/${answer.json.order.id}/move`, { to: 'cancelled' });
		expect(await linenStock()).toBe(7500);
		await shop.setting('catalog', 'lowStock', 0);
	});

	it('are claimed back in the steps they were sold in', async () => {
		const order = ids.order;
		await api('POST', `/v1/orders/${order.id}/move`, { to: 'confirmed' });
		await api('POST', `/v1/orders/${order.id}/move`, { to: 'delivered' });
		const token = await shop.signIn({ id: 'usr_measure00001' });
		/** @param {number} quantity */
		const claim = (quantity) => {
			shop.advance(61_000);
			return shop.call('POST', '/v1/shop/returns', {
				token: shop.browser,
				origin: ORIGIN,
				headers: { 'ss-sign-in': token, 'idempotency-key': `claim-${quantity}` },
				body: { orderId: order.id, kind: 'return', lines: [{ lineId: order.lines[0].id, quantity }], reason: 'Too much' },
			});
		};
		const returnable = await shop.call('GET', `/v1/shop/orders/${order.id}/returnable`, {
			token: shop.browser,
			origin: ORIGIN,
			headers: { 'ss-sign-in': token },
		});
		expect(returnable.json.lines[0]).toMatchObject({
			claimable: 2500,
			measure: { unit: 'bolt', step: 500, quantityText: '2.5' },
		});
		const odd = await claim(1250);
		expect(odd.status).toBe(422);
		expect(odd.json.errors[0].code).toBe('step');
		const made = await claim(1000);
		expect(made.status).toBe(201);
		const detail = await api('GET', `/v1/returns/${made.json.id}`);
		expect(detail.lines[0]).toMatchObject({ quantity: 1000, measure: { unit: 'bolt', quantityText: '1' } });
	});
});

describe('Chat, feeds and structured data', () => {
	it('quotes a decimal amount exactly and tells the measure', async () => {
		const answer = await api('GET', `/v1/chat/products/${ids.linen.id}/quote?quantity=2.5`);
		expect(answer).toMatchObject({
			quantity: 2500,
			measure: { unit: 'bolt', quantityText: '2.5' },
			price: 1000,
			subtotal: 2500,
		});
		expect((await api('GET', `/v1/chat/products/${ids.linen.id}/quote`)).quantity).toBe(1000);
		expect((await shop.api('GET', `/v1/chat/products/${ids.linen.id}/quote?quantity=2.5001`)).status).toBe(422);
		expect((await api('GET', `/v1/chat/products/${ids.box.id}/quote?quantity=2`)).measure).toBeNull();
		expect((await shop.api('GET', `/v1/chat/products/${ids.box.id}/quote?quantity=2.5`)).status).toBe(422);
		const context = await api('GET', `/v1/chat/context?productId=${ids.linen.id}`);
		expect(context.text).toContain('per bolt');
		const details = await api('GET', `/v1/chat/products/${ids.linen.id}`);
		expect(details.measure).toMatchObject({ unit: 'bolt', stepText: '0.5 bolt', minText: '1 bolt', maxText: '20 bolt' });
	});

	it('say in feeds and structured data what the price is for only once the unit is tied to a standard measure', async () => {
		await shop.setting('feeds', 'items', 'all');
		/** @param {unknown} value the structured data as text */
		const textOf = (value) => (typeof value === 'string' ? value : JSON.stringify(value));
		// a unit of the merchant's own: no unit price is guessed
		expect((await shop.api('GET', '/v1/feeds/products.xml')).text).not.toContain('unit_pricing');
		expect(textOf((await api('GET', `/v1/seo/products/${ids.linen.id}`)).jsonLd)).not.toContain('referenceQuantity');
		// one bolt is 12.5 meters (the standard measure may change while there is stock: quantities keep their meaning)
		await saveTypes([
			{
				key: 'fabric',
				name: 'Fabric',
				kind: 'physical',
				elements: { variants: true, measure: { ...FABRIC, standard: { code: 'MTR', amount: 12.5 } } },
			},
		]);
		const xml = (await shop.api('GET', '/v1/feeds/products.xml')).text;
		expect(xml).toContain('<g:unit_pricing_measure>12.5 m</g:unit_pricing_measure>');
		expect(xml).toContain('<g:unit_pricing_base_measure>12.5 m</g:unit_pricing_base_measure>');
		const seo = await api('GET', `/v1/seo/products/${ids.linen.id}`);
		const text = textOf(seo.jsonLd);
		expect(text).toContain('"referenceQuantity":{"@type":"QuantitativeValue","value":12.5,"unitCode":"MTR"}');
		await saveTypes();
		expect(textOf((await api('GET', `/v1/seo/products/${ids.box.id}`)).jsonLd)).not.toContain('referenceQuantity');
	});
});

describe('CSV', () => {
	it('exports, imports and updates stock in units, not thousandths', async () => {
		const linen = await api('GET', `/v1/products/${ids.linen.id}`);
		const variantId = linen.variants[0].id;
		const kept = linen.variants[0].stock;
		const exported = (await shop.api('GET', '/v1/csv/products')).text;
		const header = exported.split('\n')[0]?.split(',') ?? [];
		const row =
			exported
				.split('\n')
				.find((line) => line.includes(variantId))
				?.split(',') ?? [];
		expect(row[header.indexOf('stock')]).toBe(String(kept / 1000));
		// an update in units: 12.5 bolts are 12,500 thousandths; a box takes whole pieces only
		const box = await api('GET', `/v1/products/${ids.box.id}`);
		const csv = [
			'variant_id,updated_at,stock',
			`${variantId},${linen.updatedAt},12.5`,
			`${box.variants[0].id},${box.updatedAt},2.5`,
		].join('\n');
		const done = await shop.api('POST', '/v1/csv/products?mode=update', { csv, dryRun: false });
		expect(done.json).toMatchObject({ updated: 1 });
		expect(done.json.failed).toEqual([expect.objectContaining({ code: 'not_stock' })]);
		expect(await linenStock()).toBe(12_500);
		await api('PATCH', `/v1/products/${ids.linen.id}`, { variants: [{ id: variantId, stock: kept }] });
	});
});

describe('the unit of measure', () => {
	it('cannot change while the items have stock', async () => {
		await expect(
			saveTypes([{ key: 'fabric', name: 'Fabric', kind: 'physical', elements: { measure: { ...FABRIC, unit: 'roll' } } }]),
		).rejects.toThrow(/how they are measured cannot change/);
		// steps and limits may change
		await saveTypes([
			{
				key: 'fabric',
				name: 'Fabric',
				kind: 'physical',
				elements: { variants: true, measure: { ...FABRIC, decimals: 2, step: 250, min: 250 } },
			},
		]);
		expect((await shop.api('PATCH', `/v1/products/${ids.linen.id}`, { typeKey: 'physical' })).status).toBe(409);
		expect((await shop.api('PATCH', `/v1/categories/${ids.fabrics.id}`, { typeKey: null })).status).toBe(409);
		await saveTypes();
	});

	it('sells nothing measured while Measured sales is off', async () => {
		await shop.switchOn(FEATURES.filter((feature) => feature !== 'measured_sales'));
		const off = await quote([{ productId: ids.linen.id, quantity: 2500 }]);
		expect(off.lines[0].problems.map((/** @type {any} */ p) => p.code)).toEqual(['unavailable']);
		expect((await shopper('GET', `/v1/shop/products/${ids.linen.id}`)).json.measure).toBeNull();
		await shop.switchOn(FEATURES);
	});
});
