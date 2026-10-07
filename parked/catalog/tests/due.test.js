/** No timers: work due by time (holds, scheduled visibility, outbox leftovers) happens on read, on access, or from the dashboard. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@ss/contracts';
import { createDueWork } from '../api/due.js';
import { HOUR, MERCHANT, WEBSITE, createHarness } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
/** @type {string} */
let variantId;
/** @type {string} */
let itemId;

beforeAll(async () => {
	h = await createHarness();
	const created = await h.call('POST', '/v1/items', {
		body: { title: 'Mug', status: 'active', variants: [{ sku: 'MUG-1', price: 900, quantity: 5 }] },
	});
	expect(created.status, JSON.stringify(created.json)).toBe(201);
	variantId = created.json.variants[0].id;
	itemId = created.json.id;
}, 60_000);

afterAll(async () => {
	await h?.close();
});

/** Current stock of the mug (raw, so reads here never release anything). */
const quantity = async () => (await h.collection('items').findOne({ websiteId: WEBSITE, id: itemId }))?.variants[0].quantity;
/** @param {number} n @param {string} [key] */
const reserve = (n, key) =>
	h.call('POST', '/v1/stock-reservations', {
		...(key ? { idempotencyKey: key } : {}),
		body: { lines: [{ variantId, quantity: n }] },
	});
/** @param {string} id */
const stored = (id) => h.collection('stock_moves').findOne({ websiteId: WEBSITE, id });

describe('reservation expiry on read and on access', () => {
	it('reads an expired reservation as expired and gives its stock back on access', async () => {
		const held = await reserve(2);
		expect(held.status, JSON.stringify(held.json)).toBe(201);
		expect(await quantity()).toBe(3);
		h.clock.advance(HOUR);
		expect((await stored(held.json.id))?.status).toBe('held');
		const read = await h.call('GET', `/v1/stock-reservations/${held.json.id}`);
		expect(read.json.status).toBe('expired');
		expect((await stored(held.json.id))?.status).toBe('expired');
		expect(await quantity()).toBe(5);
		// reading it again changes nothing
		expect((await h.call('GET', `/v1/stock-reservations/${held.json.id}`)).json.status).toBe('expired');
		expect(await quantity()).toBe(5);
	});

	it('releases expired reservations before a new one takes stock, and on a retried key', async () => {
		const first = await reserve(5);
		expect(first.status).toBe(201);
		expect(await quantity()).toBe(0);
		h.clock.advance(HOUR);
		const second = await reserve(4, 'due-second');
		expect(second.status, JSON.stringify(second.json)).toBe(201);
		expect((await stored(first.json.id))?.status).toBe('expired');
		expect(await quantity()).toBe(1);
		h.clock.advance(25 * HOUR);
		// the same key from the same caller again (a retry after the kit's 24 h window) reports the expiry
		const replay = await reserve(4, 'due-second');
		expect(replay.status).toBe(200);
		expect(replay.json).toMatchObject({ id: second.json.id, status: 'expired' });
		expect(await quantity()).toBe(5);
	});

	it('releases expired holds before an order takes stock and before a stock adjustment', async () => {
		const held = await reserve(3);
		h.clock.advance(HOUR);
		const orderId = createId('ord');
		const placed = await h.deliver('order.placed@1', {
			orderId,
			currency: 'EUR',
			lines: [{ itemId, variantId, quantity: 1, unitAmount: 900 }],
			amounts: { subtotal: 900, total: 900 },
		});
		expect(placed.status).toBe(200);
		expect((await stored(held.json.id))?.status).toBe('expired');
		expect(await quantity()).toBe(4);
		const again = await reserve(2);
		h.clock.advance(HOUR);
		const set = await h.call('POST', `/v1/variants/${variantId}/stock`, { body: { quantity: 10 } });
		expect(set.status, JSON.stringify(set.json)).toBe(200);
		expect((await stored(again.json.id))?.status).toBe('expired');
		expect(await quantity()).toBe(10);
	});
});

describe('dashboard "Process due changes"', () => {
	it('publishes passed visibility changes, releases expired holds and republishes leftovers for the website', async () => {
		const until = new Date(h.clock.now() + HOUR).toISOString();
		const closing = await h.call('POST', '/v1/items', {
			body: { title: 'Closing', status: 'active', price: 10, unpublishAt: until },
		});
		expect(closing.status).toBe(201);
		const held = await reserve(1);
		const left = await h.call('POST', '/v1/items', { body: { title: 'Leftover', status: 'active', price: 10 } });
		await h.collection('items').updateOne(
			{ websiteId: WEBSITE, id: left.json.id },
			{
				$push: { outbox: { type: 'item.updated@1', key: `item.updated:${left.json.id}:left`, changed: ['title'] } },
				$set: { outboxAt: new Date(h.clock.now()) },
			},
		);
		h.clock.advance(2 * HOUR);
		const before = h.published('item.updated@1').length;
		const session = await h.session('merchant');
		const due = await h.call('POST', '/v1/dashboard/due-work', { key: session, idempotencyKey: null });
		expect(due.status, JSON.stringify(due.json)).toBe(200);
		expect(due.json).toEqual({ transitions: 1, expiredReservations: 1, republished: 1 });
		expect((await stored(held.json.id))?.status).toBe('expired');
		const events = h.published('item.updated@1').slice(before);
		expect(events.map((/** @type {any} */ e) => e.data.changed)).toEqual(expect.arrayContaining([['unpublished'], ['title']]));
		// nothing left: a second run does nothing
		expect((await h.call('POST', '/v1/dashboard/due-work', { key: session, idempotencyKey: null })).json).toEqual({
			transitions: 0,
			expiredReservations: 0,
			republished: 0,
		});
		// there is no website without a scope
		const unscoped = await h.session('merchant', { scope: { merchantId: MERCHANT } });
		expect((await h.call('POST', '/v1/dashboard/due-work', { key: unscoped, idempotencyKey: null })).status).toBe(400);
	});

	it('settles items the dashboard reads', async () => {
		const at = new Date(h.clock.now() + HOUR).toISOString();
		const opening = await h.call('POST', '/v1/items', {
			body: { title: 'Opening', status: 'active', price: 10, publishAt: at },
		});
		h.clock.advance(2 * HOUR);
		const site = /** @type {any} */ (await h.catalog.siteFor(WEBSITE));
		const { liveDashboard } = await import('../api/dashboard.js');
		const data = liveDashboard({ catalog: h.catalog, site, canWrite: true });
		const before = h.published('item.updated@1').length;
		expect(await data.item(opening.json.id)).toMatchObject({ id: opening.json.id });
		expect(h.published('item.updated@1').length).toBe(before + 1);
		expect(await data.item('itm_missing')).toBeNull();
		const later = new Date(h.clock.now() + HOUR).toISOString();
		await h.call('PATCH', `/v1/items/${opening.json.id}`, { body: { unpublishAt: later } });
		h.clock.advance(2 * HOUR);
		await data.items({});
		expect(h.published('item.updated@1').at(-1).data).toMatchObject({ itemId: opening.json.id, changed: ['unpublished'] });
	});
});

describe('settle', () => {
	it('skips items with nothing due and logs a failure without throwing', async () => {
		/** @type {unknown[]} */
		const warnings = [];
		const due = createDueWork(
			/** @type {any} */ ({ now: () => 10 * HOUR, log: { warn: (/** @type {unknown[]} */ ...args) => warnings.push(args) } }),
			{ variants: { expire: async () => 0 } },
		);
		const site = /** @type {any} */ ({
			websiteId: WEBSITE,
			settings: { items: { statuses: [{ key: 'active', standard: 'active', visible: true }] } },
			repos: {
				items: {
					write: async () => {
						throw new Error('down');
					},
				},
			},
		});
		const result = await due.settle(site, [
			{ id: 'itm_a' },
			{ id: 'itm_b', nextTransitionAt: 'not a date', outboxAt: new Date(9 * HOUR), outbox: [] },
			{ id: 'itm_c', status: 'active', nextTransitionAt: new Date(HOUR) },
		]);
		expect(result).toEqual({ transitions: 0, republished: 0 });
		expect(warnings).toHaveLength(1);
	});
});
