import { afterEach, describe, expect, it } from 'vitest';
import { createId } from '@ss/contracts';
import { fromServer } from '../api/signals.js';
import { createHarness, item } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
afterEach(async () => {
	await h?.close();
});

/**
 * A customer with a saved item, opted in (or not) on the default list.
 * @param {string} subject
 * @param {{ notify?: boolean, email?: string, patch?: Record<string, unknown> }} [options]
 */
const saver = async (subject, { notify = true, email, patch = {} } = {}) => {
	const login = await h.login(subject, email ? { email } : {});
	const saved = await h.call('POST', '/v1/lists/default/items', { identity: login, body: item(patch) });
	if (notify) {
		const opted = await h.call('PATCH', `/v1/lists/${saved.json.list.id}`, { identity: login, body: { notify: true } });
		expect(opted.status, opted.text).toBe(200);
		expect(opted.json.notify).toBe(true);
	}
	return { login, listId: saved.json.list.id };
};

describe('price-drop hook', () => {
	it('publishes one price drop per opted-in customer, exactly once, and keeps entries current', async () => {
		h = await createHarness();
		const jane = await saver('cus_jane');
		await saver('cus_bob', { notify: false });
		const price = {
			itemId: 'itm_1',
			price: { amount: 4000, currency: 'EUR' },
			previousPrice: { amount: 5000, currency: 'EUR' },
		};
		const first = await h.deliver('price.changed@1', price);
		expect(first.status).toBe(200);
		await h.deliver('price.changed@1', price, { id: first.id });
		await h.wishlist.product.events.dispatch(first.envelope, { source: 'portal' });
		await h.wishlist.signals.price(await h.site(), first.envelope);
		const events = h.published('wishlist.price_dropped@1');
		expect(events).toHaveLength(1);
		expect(events[0].data).toEqual({
			customer: { subject: 'cus_jane' },
			itemId: 'itm_1',
			title: 'Linen shirt',
			url: 'https://shop.example.com/p/linen-shirt',
			image: 'https://cdn.example.net/linen.jpg',
			price: { amount: 4000, currency: 'EUR' },
			referencePrice: { amount: 5000, currency: 'EUR' },
			dropPercent: 20,
			listIds: [jane.listId],
		});
		expect(events[0].idempotencyKey).toBe(`${first.id}:cus_jane`);
		const list = (await h.call('GET', '/v1/lists/default', { identity: jane.login })).json;
		expect(list.items[0]).toMatchObject({ price: { amount: 4000 }, savedPrice: { amount: 5000 } });
		const bob = (await h.call('GET', '/v1/lists?customerId=cus_bob', { key: h.sk })).json.items[0];
		expect((await h.call('GET', `/v1/lists/${bob.id}`, { key: h.sk })).json.items[0].price.amount).toBe(4000);
		// a further drop inside the cool-down stays quiet; after it, it is measured against the last signal
		await h.deliver('price.changed@1', { ...price, price: { amount: 3000, currency: 'EUR' } });
		expect(h.published('wishlist.price_dropped@1')).toHaveLength(1);
		h.clock.advance(25 * 3_600_000);
		await h.deliver('price.changed@1', { ...price, price: { amount: 3900, currency: 'EUR' } });
		expect(h.published('wishlist.price_dropped@1')).toHaveLength(1);
		await h.deliver('price.changed@1', { ...price, price: { amount: 3000, currency: 'EUR' } });
		const second = h.published('wishlist.price_dropped@1');
		expect(second).toHaveLength(2);
		expect(second[1].data).toMatchObject({ referencePrice: { amount: 4000 }, dropPercent: 25 });
		const notifications = await h.call('GET', '/v1/notifications', { key: h.sk });
		expect(notifications.json.items.map((/** @type {any} */ n) => n.kind)).toEqual(['price_dropped', 'price_dropped']);
		expect(notifications.json.items[0].customer).toEqual({ subject: 'cus_jane' });
		expect((await h.call('GET', '/v1/notifications')).status).toBe(403);
	});

	it('publishes back in stock on a restock, with the e-mail only when allowed', async () => {
		h = await createHarness({ config: { price_drop_hook: { include_email: true, locations: ['loc_main'] } } });
		const jane = await saver('cus_jane', { email: 'jane@example.com' });
		await h.deliver('inventory.changed@1', { itemId: 'itm_1', quantity: 0, locationId: 'loc_main' });
		await h.deliver('inventory.changed@1', { itemId: 'itm_1', quantity: 9, locationId: 'loc_other' });
		expect(h.published('wishlist.back_in_stock@1')).toHaveLength(0);
		expect((await h.call('GET', '/v1/lists/default', { identity: jane.login })).json.items[0].inStock).toBe(false);
		await h.deliver('inventory.changed@1', { itemId: 'itm_1', quantity: 5, locationId: 'loc_main' });
		const events = h.published('wishlist.back_in_stock@1');
		expect(events).toHaveLength(1);
		expect(events[0].data).toMatchObject({
			customer: { subject: 'cus_jane', email: 'jane@example.com' },
			itemId: 'itm_1',
			available: 5,
			locationId: 'loc_main',
			listIds: [jane.listId],
		});
		expect((await h.call('GET', '/v1/lists/default', { identity: jane.login })).json.items[0].inStock).toBe(true);
		// still in stock: no new signal
		await h.deliver('inventory.changed@1', { itemId: 'itm_1', quantity: 4, previousQuantity: 5, locationId: 'loc_main' });
		expect(h.published('wishlist.back_in_stock@1')).toHaveLength(1);
		// opting out stops signals; opting out also drops the kept e-mail
		await h.call('PATCH', `/v1/lists/${jane.listId}`, { identity: jane.login, body: { notify: false } });
		expect((await h.collection('lists').findOne({ id: jane.listId }))?.contactEmail).toBeNull();
	});

	it('trusts price and stock only from servers, ignores unusable events and websites with the hook off', async () => {
		h = await createHarness();
		await saver('cus_jane');
		const drop = { itemId: 'itm_1', price: { amount: 100, currency: 'EUR' } };
		await h.deliver('price.changed@1', drop, { actor: { type: 'customer' } });
		await h.deliver('price.changed@1', drop, { context: { keyKind: 'pk' } });
		await h.deliver('price.changed@1', { itemId: 'itm_1' });
		await h.deliver('inventory.changed@1', { itemId: 'itm_1' });
		const pushed = await h.call('POST', '/v1/events', {
			body: {
				id: createId('evt'),
				type: 'price.changed@1',
				idempotencyKey: 'k1',
				occurredAt: new Date(h.clock.now()).toISOString(),
				actor: { type: 'anonymous' },
				data: drop,
			},
		});
		expect(pushed.status, pushed.text).toBeLessThan(300);
		expect(h.published('wishlist.price_dropped@1')).toHaveLength(0);
		// the merchant's server pushes the same change with an sk_ key
		const server = await h.call('POST', '/v1/events', {
			key: h.sk,
			body: {
				id: createId('evt'),
				type: 'price.changed@1',
				idempotencyKey: 'k2',
				occurredAt: new Date(h.clock.now()).toISOString(),
				actor: { type: 'merchant' },
				data: drop,
			},
		});
		expect(server.status, server.text).toBeLessThan(300);
		expect(h.published('wishlist.price_dropped@1')).toHaveLength(1);
		expect(fromServer({ actor: { type: 'system' } }, { source: 'site', website: { kind: 'sk' } })).toBe(true);
		h.clock.advance(48 * 3_600_000);
		await h.entitle({ elements: { price_drop_hook: false } });
		await h.deliver('price.changed@1', { ...drop, price: { amount: 50, currency: 'EUR' } });
		expect(h.published('wishlist.price_dropped@1')).toHaveLength(1);
		const jane = await h.login('cus_jane');
		const list = (await h.call('GET', '/v1/lists/default', { identity: jane })).json;
		expect((await h.call('PATCH', `/v1/lists/${list.id}`, { identity: jane, body: { notify: true } })).status).toBe(403);
	});

	it('accepts browser events when the merchant allows it', async () => {
		h = await createHarness({ config: { price_drop_hook: { accept_customer_events: true, min_drop_percent: 0 } } });
		await saver('cus_jane');
		await h.deliver(
			'price.changed@1',
			{ itemId: 'itm_1', price: { amount: 4999, currency: 'EUR' } },
			{ actor: { type: 'anonymous' } },
		);
		expect(h.published('wishlist.price_dropped@1')).toHaveLength(1);
	});

	it('only customer lists opt in', async () => {
		h = await createHarness();
		const jane = await h.login('cus_jane');
		const list = (await h.call('POST', '/v1/lists/default/items', { identity: jane, body: item() })).json.list;
		// a server key may opt a customer's list in on their behalf; a guest list never
		expect((await h.call('PATCH', `/v1/lists/${list.id}`, { key: h.sk, body: { notify: true } })).status).toBe(200);
		const token = await h.guest();
		const guestList = (await h.call('POST', '/v1/lists/default/items', { body: { ...item(), guest: token } })).json.list;
		expect((await h.call('PATCH', `/v1/lists/${guestList.id}`, { key: h.sk, body: { notify: true } })).status).toBe(401);
	});
});
