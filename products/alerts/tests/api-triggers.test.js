/** Triggers: events, API, batches, CSV, waitlists and custom types on MongoDB. */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, WEBSITE } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>> | null} */
let h = null;
afterEach(async () => {
	await h?.close();
	h = null;
});
/** @param {Parameters<typeof createHarness>[0]} [options] */
const harness = async (options) => (h = await createHarness(options));
const eur = (/** @type {number} */ amount) => ({ amount, currency: 'EUR' });
/** @param {Awaited<ReturnType<typeof createHarness>>} t @param {string} id */
const statusOf = async (t, id) => (await t.collection('subscriptions').findOne({ websiteId: WEBSITE, id }))?.status;

describe('event triggers', () => {
	it('alerts price drops below the reference (and only then)', async () => {
		const t = await harness();
		await t.deliver('price.changed@1', { itemId: 'itm_w', price: eur(25_000) });
		const sub = await t.subscribe({ type: 'price_drop', itemId: 'itm_w', item: { name: 'Watch' } }, { key: t.pk });
		await t.deliver('price.changed@1', { itemId: 'itm_w', price: eur(26_000), previousPrice: eur(25_000) });
		expect(t.provider.sent).toHaveLength(0);
		await t.deliver('price.changed@1', { itemId: 'itm_w', price: eur(19_900) });
		expect(t.provider.sent).toHaveLength(1);
		expect(t.provider.sent[0].subject).toBe('Price drop: Watch is now €199.00');
		expect(t.provider.sent[0].text).toContain('(was €250.00, 20% less)');
		expect(await statusOf(t, sub.json.id)).toBe('notified');
	});

	it('fires item-level subscriptions on a variant change and ignores price lists not tracked', async () => {
		const t = await harness({ config: { triggers: { price_lists: ['retail'] } } });
		await t.subscribe({ itemId: 'itm_v' }, { key: t.pk });
		await t.deliver('inventory.changed@1', { itemId: 'itm_v', variantId: 'blue', quantity: 2, previousQuantity: 0 });
		expect(t.provider.sent).toHaveLength(1);
		await t.subscribe({ type: 'price_drop', itemId: 'itm_p', price: eur(1000) }, { key: t.pk });
		await t.deliver('price.changed@1', { itemId: 'itm_p', priceListId: 'wholesale', price: eur(10) });
		expect(t.provider.sent).toHaveLength(1);
		await t.deliver('price.changed@1', { itemId: 'itm_p', priceListId: 'retail', price: eur(900) });
		expect(t.provider.sent).toHaveLength(2);
	});

	it('trusts stock and price only from servers unless configured', async () => {
		const t = await harness();
		await t.subscribe({}, { key: t.pk });
		await t.deliver(
			'inventory.changed@1',
			{ itemId: 'itm_1', quantity: 5, previousQuantity: 0 },
			{ actor: { type: 'customer', id: 'cus_1' } },
		);
		await t.deliver('price.changed@1', { itemId: 'itm_1', price: eur(1) }, { actor: { type: 'anonymous' } });
		// a browser pushing to the product's own /v1/events with its pk_ key is not trusted either
		await t.call('POST', '/v1/events', {
			key: t.pk,
			body: {
				events: [
					{
						id: 'evt_0000000000000000000000browser',
						type: 'inventory.changed@1',
						occurredAt: new Date(t.clock.now()).toISOString(),
						idempotencyKey: 'evt_b',
						actor: { type: 'merchant' },
						data: { itemId: 'itm_1', quantity: 9 },
					},
				],
			},
		});
		expect(t.provider.sent).toHaveLength(0);
		await t.entitle({ config: { triggers: { accept_customer_events: true } } });
		await t.deliver(
			'inventory.changed@1',
			{ itemId: 'itm_1', quantity: 5, previousQuantity: 0 },
			{ actor: { type: 'customer', id: 'cus_1' } },
		);
		expect(t.provider.sent).toHaveLength(1);
	});

	it('ignores sources that are switched off, stale changes and untracked locations', async () => {
		const t = await harness({
			config: { triggers: { consume_inventory_events: false, consume_price_events: false, consume_custom_events: false } },
		});
		await t.subscribe({}, { key: t.pk });
		await t.deliver('inventory.changed@1', { itemId: 'itm_1', quantity: 5, previousQuantity: 0 });
		await t.deliver('price.changed@1', { itemId: 'itm_1', price: eur(1) });
		await t.deliver('custom.anything@1', { itemId: 'itm_1' });
		expect(await t.collection('triggers').countDocuments({ websiteId: WEBSITE })).toBe(0);
		await t.entitle({ config: { triggers: { locations: ['store_a'] } } });
		await t.deliver('inventory.changed@1', { itemId: 'itm_1', locationId: 'store_b', quantity: 5, previousQuantity: 0 });
		await t.deliver(
			'inventory.changed@1',
			{ itemId: 'itm_1', locationId: 'store_a', quantity: 0 },
			{ occurredAt: t.clock.now() + 60_000 },
		);
		await t.deliver(
			'inventory.changed@1',
			{ itemId: 'itm_1', locationId: 'store_a', quantity: 9 },
			{ occurredAt: t.clock.now() },
		);
		const runs = await t.collection('triggers').find({ websiteId: WEBSITE }).sort({ _id: 1 }).toArray();
		expect(runs.map((run) => run.reason)).toEqual(['untracked_location', null, 'stale']);
		expect(t.provider.sent).toHaveLength(0);
		await t.entitle({ elements: { triggers: false } });
		await t.deliver(
			'inventory.changed@1',
			{ itemId: 'itm_1', locationId: 'store_a', quantity: 3 },
			{ occurredAt: t.clock.now() + 120_000 },
		);
		expect(await t.collection('triggers').countDocuments({ websiteId: WEBSITE })).toBe(3);
	});

	it('records state but claims nothing while dispatch is off', async () => {
		const t = await harness({ elements: { dispatch: false } });
		const sub = await t.subscribe({}, { key: t.pk });
		await t.deliver('inventory.changed@1', { itemId: 'itm_1', quantity: 5, previousQuantity: 0 });
		expect(await statusOf(t, sub.json.id)).toBe('pending');
		expect((await t.collection('triggers').findOne({ websiteId: WEBSITE }))?.reason).toBe('dispatch_disabled');
		await t.entitle({ elements: { dispatch: true } });
		await t.deliver('inventory.changed@1', { itemId: 'itm_1', quantity: 0 }, { occurredAt: t.clock.now() + 1 });
		await t.deliver('inventory.changed@1', { itemId: 'itm_1', quantity: 4 }, { occurredAt: t.clock.now() + 2 });
		expect(t.provider.sent).toHaveLength(1);
	});

	it('notifies availability waitlists by free capacity, in waitlist (tier) order', async () => {
		const t = await harness({
			config: {
				types: { availability_enabled: true },
				waitlist_priority: {
					order: 'tier',
					tiers: [
						{ key: 'gold', rank: 0 },
						{ key: 'silver', rank: 1 },
					],
				},
			},
		});
		const add = (/** @type {string} */ email, /** @type {string[]} */ ...[tier]) =>
			t.subscribe({ type: 'availability', itemId: 'slot_1', email, ...(tier ? { tier } : {}) });
		const a = await add('a@example.com');
		t.clock.advance(1000);
		const b = await add('b@example.com', 'silver');
		t.clock.advance(1000);
		const c = await add('c@example.com', 'gold');
		const position = await t.call('GET', `/v1/waitlist/position?subscriptionId=${a.json.id}`);
		expect(position.json).toEqual({ subscriptionId: a.json.id, status: 'pending', position: 3, ahead: 2 });
		const list = await t.call('GET', '/v1/waitlist?type=availability&itemId=slot_1');
		expect(list.json.items.map((/** @type {any} */ s) => s.contact.email)).toEqual([
			'c@example.com',
			'b@example.com',
			'a@example.com',
		]);
		await t.deliver('inventory.changed@1', { itemId: 'slot_1', quantity: 2, previousQuantity: 0 });
		expect(t.provider.sent.map((m) => m.to.email)).toEqual(['c@example.com', 'b@example.com']);
		expect(t.provider.sent[0].text).toContain('(2 available now)');
		expect(await statusOf(t, a.json.id)).toBe('pending');
		expect((await t.call('GET', `/v1/waitlist/position?subscriptionId=${c.json.id}`)).json).toMatchObject({
			position: null,
			status: 'notified',
		});
		expect(b.json.position).toBe(1);
		expect((await t.call('GET', '/v1/waitlist?type=availability')).status).toBe(422);
		expect((await t.call('GET', '/v1/waitlist/position?subscriptionId=als_x')).status).toBe(404);
		const pageOne = await t.call('GET', '/v1/waitlist?type=availability&itemId=slot_1&limit=1');
		expect(pageOne.json.items).toHaveLength(1);
		const pageTwo = await t.call(
			'GET',
			`/v1/waitlist?type=availability&itemId=slot_1&limit=1&cursor=${encodeURIComponent(pageOne.json.nextCursor ?? '')}`,
		);
		expect(pageTwo.status).toBe(200);
	});

	it('fires custom types from custom.* events with rules@1 conditions, provenance and capacity', async () => {
		const t = await harness({
			config: {
				types: {
					custom_types: [
						{
							key: 'preorder',
							name: 'Pre-orders open',
							event: 'custom.preorder_opened',
							target_field: 'product.id',
							when: "event.data.region == 'EU'",
						},
						{
							key: 'drop',
							event: 'custom.drop@2',
							target_field: '',
							allow_customer_actor: true,
							notify: 'capacity',
							capacity_field: 'seats',
						},
					],
				},
			},
		});
		const pre = await t.subscribe({ type: 'custom:preorder', itemId: 'itm_pre', item: { name: 'Console' } }, { key: t.pk });
		await t.deliver('custom.preorder_opened@1', { product: { id: 'itm_pre' }, region: 'US' });
		await t.deliver('custom.preorder_opened@1', { product: { id: 'itm_pre' }, region: 'EU' }, { actor: { type: 'customer' } });
		await t.deliver('custom.preorder_opened@1', { product: { id: 'bad id' }, region: 'EU' });
		expect(t.provider.sent).toHaveLength(0);
		await t.deliver('custom.preorder_opened@3', { product: { id: 'itm_pre' }, region: 'EU' });
		expect(t.provider.sent).toHaveLength(1);
		expect(t.provider.sent[0].subject).toBe('Pre-orders open: Console');
		expect(await statusOf(t, pre.json.id)).toBe('notified');
		const d1 = await t.subscribe({ type: 'custom:drop', itemId: '*', email: 'd1@example.com' });
		t.clock.advance(1000);
		await t.subscribe({ type: 'custom:drop', itemId: '*', email: 'd2@example.com' });
		await t.deliver('custom.drop@1', { seats: 5 });
		expect(t.provider.sent).toHaveLength(1);
		await t.deliver('custom.drop@2', { seats: 0 }, { actor: { type: 'customer' } });
		expect(t.provider.sent).toHaveLength(1);
		await t.deliver('custom.drop@2', { seats: 1 }, { actor: { type: 'customer' } });
		expect(t.provider.sent).toHaveLength(2);
		expect(t.provider.sent[1].to.email).toBe('d1@example.com');
		expect(await statusOf(t, d1.json.id)).toBe('notified');
		await t.deliver('custom.unrelated@1', {});
		const ignored = await t.collection('triggers').findOne({ websiteId: WEBSITE, eventType: 'custom.unrelated@1' });
		expect(ignored).toMatchObject({ status: 'ignored', reason: 'no_custom_type' });
		const api = await t.call('POST', '/v1/triggers', { body: { kind: 'custom', type: 'custom.drop@2', data: { seats: 3 } } });
		expect(api.json).toMatchObject({ kind: 'custom', status: 'done', queued: 1 });
		const viaItem = await t.call('POST', '/v1/triggers', {
			body: { kind: 'custom', type: 'custom.preorder_opened', itemId: 'itm_x' },
		});
		expect(viaItem.json.queued).toBe(0);
	});
});

describe('API triggers', () => {
	it('creates runs idempotently, lists and reads them (sk only)', async () => {
		const t = await harness();
		await t.subscribe({}, { key: t.pk });
		const body = {
			kind: 'inventory',
			itemId: 'itm_1',
			quantity: 5,
			previousQuantity: 0,
			item: { name: 'Phone', url: 'https://shop.example.com/p' },
		};
		const first = await t.call('POST', '/v1/triggers', { body, idempotencyKey: 'stock-sync-1' });
		expect(first.status).toBe(201);
		expect(first.json).toMatchObject({
			source: 'api',
			kind: 'inventory',
			status: 'done',
			matched: 1,
			queued: 1,
			before: { quantity: 0 },
			after: { quantity: 5, available: true },
		});
		const repeated = await t.call('POST', '/v1/triggers', { body, idempotencyKey: 'stock-sync-1' });
		expect(repeated.status).toBe(409);
		expect(repeated.json.type).toMatch(/duplicate_request$/);
		const sameId = await t.call('POST', '/v1/triggers', { body: { ...body, id: 'chg_1' } });
		const sameIdAgain = await t.call('POST', '/v1/triggers', { body: { ...body, id: 'chg_1' } });
		expect(sameIdAgain.json.id).toBe(sameId.json.id);
		expect(t.provider.sent).toHaveLength(1);
		expect(t.provider.sent[0].text).toContain('Order here: https://shop.example.com/p');
		const list = await t.call('GET', '/v1/triggers?limit=1');
		expect(list.json.items).toHaveLength(1);
		expect(list.json.hasMore).toBe(true);
		expect((await t.call('GET', `/v1/triggers/${first.json.id}`)).json.id).toBe(first.json.id);
		expect((await t.call('GET', '/v1/triggers/trg_missing')).status).toBe(404);
		expect((await t.call('POST', '/v1/triggers', { body: { kind: 'inventory' } })).status).toBe(422);
		expect((await t.call('GET', '/v1/triggers', { key: t.pk })).status).toBe(403);
		const price = await t.call('POST', '/v1/triggers', {
			body: { kind: 'price', itemId: 'itm_1', price: eur(100), occurredAt: '2026-10-01T09:00:00Z' },
		});
		expect(price.json.after.price).toEqual(eur(100));
	});

	it('processes batches and CSV imports with per-item errors', async () => {
		const t = await harness({ config: { triggers: { max_batch_items: 3, max_csv_rows: 3 } } });
		await t.subscribe({ itemId: 'a' }, { key: t.pk });
		await t.subscribe({ itemId: 'b' }, { key: t.pk });
		const batch = await t.call('POST', '/v1/triggers:batch', {
			body: {
				changes: [
					{ kind: 'inventory', itemId: 'a', quantity: 1 },
					{ kind: 'nope' },
					{ kind: 'price', itemId: 'zz', price: eur(5) },
				],
			},
		});
		expect(batch.status).toBe(200);
		expect(batch.json.results.map((/** @type {any} */ r) => r.ok)).toEqual([true, false, true]);
		expect(batch.json.queued).toBe(1);
		expect(batch.json.dispatched).toMatchObject({ sent: 1 });
		expect((await t.call('POST', '/v1/triggers:batch', { body: { changes: [] } })).status).toBe(422);
		expect((await t.call('POST', '/v1/triggers:batch', { body: { changes: [{}, {}, {}, {}] } })).json.errors[0].code).toBe(
			'too_many',
		);
		const csv = await t.call('POST', '/v1/triggers:import', {
			body: { csv: 'kind,item_id,quantity,item_name\ninventory,b,4,Bee\ninventory,,1,\n' },
		});
		expect(csv.json).toMatchObject({ rows: 2, processed: 1, queued: 1, errors: [{ row: 3 }] });
		expect(t.provider.sent.map((m) => m.subject)).toEqual(['this item is back in stock', 'Bee is back in stock']);
		expect((await t.call('POST', '/v1/triggers:import', { body: {} })).status).toBe(422);
		const malformed = await t.call('POST', '/v1/triggers:import', { body: { csv: 'item_id\n"x' } });
		expect(malformed.status).toBe(422);
		expect(malformed.json.type).toMatch(/csv_invalid$/);
		expect((await t.call('POST', '/v1/triggers:import', { body: { csv: 'quantity\n1\n' } })).json.detail).toMatch(/item_id/);
		expect((await t.call('POST', '/v1/triggers:import', { body: { csv: 'item_id\na\nb\nc\nd\n' } })).json.errors[0].code).toBe(
			'csv_too_many_rows',
		);
	});

	it('continues large waitlists beyond the fan-out limit in later runs, telling everyone once', async () => {
		const t = await harness({ config: { triggers: { fanout_limit: 2 }, dispatch: { inline_dispatch: false } } });
		for (const email of ['1@example.com', '2@example.com', '3@example.com', '4@example.com', '5@example.com'])
			await t.subscribe({ email });
		const run = await t.call('POST', '/v1/triggers', {
			body: { kind: 'inventory', itemId: 'itm_1', quantity: 9, previousQuantity: 0 },
		});
		expect(run.json).toMatchObject({ queued: 2, more: true });
		expect(t.provider.sent).toHaveLength(0);
		const first = await t.call('POST', '/v1/messages:dispatch', { idempotencyKey: null });
		expect(first.json).toMatchObject({ resumed: { resumed: 1, queued: 2 } });
		const second = await t.call('POST', '/v1/messages:dispatch', { idempotencyKey: null });
		expect(second.json.resumed).toEqual({ resumed: 1, queued: 1 });
		await t.call('POST', '/v1/messages:dispatch', { idempotencyKey: null });
		expect(new Set(t.provider.sent.map((m) => m.to.email)).size).toBe(5);
		expect(t.provider.sent).toHaveLength(5);
		expect((await t.call('GET', `/v1/triggers/${run.json.id}`)).json).toMatchObject({ more: false, queued: 5 });
	});

	it('continues capacity-limited custom runs with the remaining budget only', async () => {
		const t = await harness({
			config: {
				triggers: { fanout_limit: 1 },
				types: {
					custom_types: [
						{
							key: 'seat',
							event: 'custom.seat_freed',
							target_field: 'eventId',
							notify: 'capacity',
							capacity_field: 'seats',
						},
					],
				},
			},
		});
		for (const email of ['1@example.com', '2@example.com', '3@example.com'])
			await t.subscribe({ type: 'custom:seat', itemId: 'show_1', email });
		await t.deliver('custom.seat_freed@1', { eventId: 'show_1', seats: 2 });
		// the event's own outbox run continues the open run once: both seats are told right away
		expect(t.provider.sent).toHaveLength(2);
		await t.call('POST', '/v1/messages:dispatch', { idempotencyKey: null });
		await t.call('POST', '/v1/messages:dispatch', { idempotencyKey: null });
		expect(t.provider.sent).toHaveLength(2);
	});
});

describe('caller-scoped Idempotency-Keys', () => {
	it('never lets another key reuse a run created under the same Idempotency-Key', async () => {
		const t = await harness();
		const other = await t.key('sk');
		const body = { kind: 'custom', type: 'custom.drop@2', data: { seats: 3 } };
		const first = await t.call('POST', '/v1/triggers', { body, idempotencyKey: 'shared-run' });
		expect(first.status).toBe(201);
		t.clock.advance(25 * 3_600_000); // past app-kit's 24 h duplicate refusal
		await t.entitle();
		const theirs = await t.call('POST', '/v1/triggers', { body, key: other, idempotencyKey: 'shared-run' });
		expect(theirs.status).toBe(201);
		expect(theirs.json.id).not.toBe(first.json.id);
		t.clock.advance(25 * 3_600_000);
		await t.entitle();
		const mine = await t.call('POST', '/v1/triggers', { body, idempotencyKey: 'shared-run' });
		expect(mine.json.id).toBe(first.json.id);
	});
});
