/**
 * The order engine on the database (PLAN 0.8.10 dynamic model §3, phase 1): one transaction per transition (of two
 * moves at once one wins), facts written on the first transition of an older order, `flow_changed`, the refund a
 * cancel asks of Payments kept pending when Payments fails and done exactly once on a later use, the flow-save guard on
 * both save routes, restatus, an activity line for every way an order moves, and a delete given back once (the
 * property test is `transitions-property.test.js`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLACED_FACTS } from '../core/facts.js';
import { DEFAULT_FLOW } from '../core/flow.js';
import { COLLECTIONS } from '../core/model.js';
import { createMoves } from '../server/orders-moves.js';
import { createService } from '../server/service.js';
import { ALL_PERMISSIONS, DOMAIN, ORIGIN, PAYMENTS, UNIT_TYPES, readyShop, setup } from './helpers.js';
import { orderRecords } from './order-records.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {ReturnType<typeof createService>} */
let service;
/** @type {ReturnType<typeof createMoves>} */
let moves;
/** @type {string} */
let ticket;
/** @type {ReturnType<typeof orderRecords>} */
let records;

beforeAll(async () => {
	shop = await readyShop();
	service = createService(shop.product);
	moves = createMoves(shop.product, service);
	ticket = await shop.ticket(ALL_PERMISSIONS);
	records = orderRecords(shop);
});
afterAll(async () => shop.product.close());

/** A server-token request context, as the routes give the moves module. */
const ctx = () => ({
	websiteId: shop.websiteId,
	merchantId: null,
	status: { domain: DOMAIN },
	headers: new Headers(),
	ticket: null,
	after: () => {},
});

/** @param {{ json: any }} response */
const codeOf = (response) =>
	String(response.json?.type ?? '')
		.split('/')
		.pop();

const orders = () => records.orders();
/** @param {string} id */
const recordOf = (id) => records.recordOf(id);
/** @param {string} id */
const stockOf = (id) => records.stockOf(id);
/** @param {Parameters<ReturnType<typeof orderRecords>['seedOrder']>[0]} [options] */
const seedOrder = (options) => records.seedOrder(options);
/** @param {string} id @param {string} to @param {Record<string, unknown>} [extra] */
const moveTo = (id, to, extra) => records.moveTo(id, to, extra);
/** @param {{ status: number, type?: string, body?: unknown }} answer @param {string} [paymentId] */
const refundsAnswer = (answer, paymentId) => records.refundsAnswer(answer, paymentId);
/** @param {string} paymentId */
const refundCalls = (paymentId) => records.refundCalls(paymentId);

/** The activity entries of a target, newest first. @param {string} target */
const activityOf = async (target) => (await shop.api('GET', `/v1/activity?target=${encodeURIComponent(target)}`)).json.items;

describe('one transaction per move', () => {
	it('lets one of two moves at once win; the other changes nothing (409)', async () => {
		const { order, product } = await seedOrder({ quantity: 2 });
		expect(await stockOf(product.id)).toBe(3);
		const s = await service.site(ctx());
		const input = (/** @type {string} */ to) => ({ to, note: '', serials: {}, shipment: null, updatedAt: null });
		const both = await Promise.allSettled([
			moves.move(s, ctx(), order, input('cancelled'), DEFAULT_FLOW),
			moves.move(await service.site(ctx()), ctx(), order, input('cancelled'), DEFAULT_FLOW),
		]);
		expect(both.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		const refused = /** @type {PromiseRejectedResult} */ (both.find((result) => result.status === 'rejected'));
		expect(refused.reason.code).toBe('conflict');
		// the stock came back once, and the money went back once
		expect(await stockOf(product.id)).toBe(5);
		const after = await recordOf(order.id);
		expect(after.history.filter((/** @type {any} */ entry) => entry.to === 'cancelled')).toHaveLength(1);
		expect(after.refunds).toHaveLength(1);
		expect(after.facts).toEqual({ stock: 'back', offers: 'released', redeemed: 'given_back', earned: 'none', units: 'none' });

		// two different moves at once: one wins
		const other = await seedOrder();
		const race = await Promise.allSettled([
			moves.move(s, ctx(), other.order, input('packed'), DEFAULT_FLOW),
			moves.move(await service.site(ctx()), ctx(), other.order, input('cancelled'), DEFAULT_FLOW),
		]);
		expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		const won = /** @type {PromiseFulfilledResult<any>} */ (race.find((result) => result.status === 'fulfilled'));
		expect(await stockOf(other.product.id)).toBe(won.value.order.role === 'cancelled' ? 5 : 4);
	});

	it('writes the facts of an older order on its first move, and refuses an order whose status changed its role', async () => {
		const { order } = await seedOrder();
		expect(order.facts).toBeUndefined();
		const detail = await shop.api('GET', `/v1/orders/${order.id}`);
		expect(detail.json.facts).toEqual(PLACED_FACTS);
		expect(detail.json.effects).toEqual([]);
		const packed = await moveTo(order.id, 'packed');
		expect(packed.status).toBe(200);
		expect((await recordOf(order.id)).facts).toEqual(PLACED_FACTS);
		// a flow that gave the packed status another role (refused when saved; here given to the moves directly)
		const reRoled = {
			...DEFAULT_FLOW,
			statuses: DEFAULT_FLOW.statuses.map((status) =>
				status.key === 'packed' ? { ...status, role: /** @type {const} */ ('open') } : status,
			),
		};
		const s = await service.site(ctx());
		await expect(
			moves.move(
				s,
				ctx(),
				await recordOf(order.id),
				{ to: 'cancelled', note: '', serials: {}, shipment: null, updatedAt: null },
				reRoled,
			),
		).rejects.toMatchObject({ code: 'flow_changed' });
		expect((await recordOf(order.id)).role).toBe('packed');
	});
});

describe('the refund a staff cancel asks of Payments', () => {
	it('stays pending when Payments fails, then is done exactly once on a later use', async () => {
		const { order, paymentId } = await seedOrder({ quantity: 2 });
		const restore = refundsAnswer({ status: 503, body: {} });
		/** @type {any} */
		let cancelled;
		try {
			cancelled = await moveTo(order.id, 'cancelled', { note: 'Shop closed' });
		} finally {
			restore();
		}
		expect(cancelled.status).toBe(200);
		expect(cancelled.json.warningCodes).toEqual([{ code: 'cancel_refund_failed', values: { amount: 2000 } }]);
		expect(cancelled.json.warnings[0]).toContain('tried again');
		expect(cancelled.json.effects).toEqual([
			expect.objectContaining({ id: `${order.id}:cancel`, kind: 'refund', amount: 2000, state: 'pending', tries: 1 }),
		]);
		expect(cancelled.json.payment).toMatchObject({ refunded: 0, refundable: 2000 });
		expect(refundCalls(paymentId)).toHaveLength(1);

		// within the minute nothing is tried again
		const soon = await shop.api('GET', `/v1/orders/${order.id}`);
		expect(soon.json.effects[0].state).toBe('pending');
		expect(refundCalls(paymentId)).toHaveLength(1);

		// staff open it a minute later: refunded once, with the same Idempotency-Key
		shop.advance(61_000);
		const later = await shop.api('GET', `/v1/orders/${order.id}`);
		expect(later.json.effects[0]).toMatchObject({ state: 'done', refundId: expect.any(String), tries: 2 });
		expect(later.json.payment).toMatchObject({ state: 'refunded', refunded: 2000 });
		// the note staff typed is the refund entry's; Payments (which may show its reason to the payer) gets plain words
		expect(later.json.refunds).toEqual([expect.objectContaining({ method: 'payments', amount: 2000, note: 'Shop closed' })]);
		const calls = refundCalls(paymentId);
		expect(calls).toHaveLength(2);
		expect(calls.map((call) => call.headers['idempotency-key'])).toEqual([`${order.id}:cancel`, `${order.id}:cancel`]);
		expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({ amount: 2000, reason: 'Order canceled' });
		expect((await activityOf(order.id))[0]).toMatchObject({ action: 'order.refunded', detail: 'Refunded USD 20.00' });

		// and never again
		shop.advance(61_000);
		await shop.api('GET', `/v1/orders/${order.id}`);
		expect(refundCalls(paymentId)).toHaveLength(2);
		expect((await recordOf(order.id)).refunds).toHaveLength(1);
	});

	it('is done on use too, skipped when staff refunded it meanwhile, and failed when Payments refuses it', async () => {
		const restore = refundsAnswer({ status: 503, body: {} });
		const onUse = await seedOrder();
		const byStaff = await seedOrder();
		const refused = await seedOrder();
		try {
			for (const { order } of [onUse, byStaff, refused]) expect((await moveTo(order.id, 'cancelled')).status).toBe(200);
		} finally {
			restore();
		}
		// staff refund one by hand meanwhile: Payments shows nothing refunded, so its pending refund is not sent any more
		const byHand = await shop.admin(ticket, 'POST', `/v1/admin/orders/${byStaff.order.id}/refunds`, {
			amount: 1000,
			reason: 'Refunded by hand',
			method: 'cod',
		});
		expect(byHand.status).toBe(201);
		expect((await recordOf(byStaff.order.id)).effects[0]).toMatchObject({
			state: 'skipped',
			detail: 'Refunded from the order instead',
		});
		// any later use of the shop tries pending refunds again; Payments refuses one payment's refund for good
		const no = refundsAnswer(
			{ status: 422, type: 'application/problem+json', body: { status: 422, detail: 'Not refundable.' } },
			refused.paymentId,
		);
		try {
			shop.advance(61_000);
			await shop.call('POST', '/v1/shop/cart/quote', { token: shop.browser, origin: ORIGIN, body: { lines: [] } });
			expect(refundCalls(byStaff.paymentId)).toHaveLength(1);
			expect((await recordOf(onUse.order.id)).effects[0].state).toBe('done');
			expect((await recordOf(onUse.order.id)).payment.refunded).toBe(1000);
			expect(refundCalls(onUse.paymentId)).toHaveLength(2);
			const read = await shop.api('GET', `/v1/orders/${refused.order.id}`);
			expect(read.json.effects[0]).toMatchObject({ state: 'failed', detail: 'Not refundable.' });
			expect(read.json.payment.refundable).toBe(1000);
			// refused: not tried again
			const calls = refundCalls(refused.paymentId).length;
			shop.advance(61_000);
			await shop.api('GET', `/v1/orders/${refused.order.id}`);
			expect(refundCalls(refused.paymentId)).toHaveLength(calls);
		} finally {
			no();
		}
	});

	it('is recorded, never sent twice, when its answer was lost and staff then refund by hand', async () => {
		const { order, paymentId } = await seedOrder();
		const normal = /** @type {any} */ (shop.responders.get(PAYMENTS));
		/** Payments did the refund, but its answer never came. */
		let done = 0;
		shop.responders.set(PAYMENTS, (call) => {
			if (call.path.endsWith('/refunds')) {
				if (done === 0) done = JSON.parse(call.body).amount;
				return { status: 503, body: {} };
			}
			// nor can its payment be read
			if (call.method === 'GET' && call.path.endsWith(`/${paymentId}`)) return { status: 503, body: {} };
			return normal(call);
		});
		try {
			expect((await moveTo(order.id, 'cancelled')).json.effects[0]).toMatchObject({ state: 'pending', tries: 1 });
			expect(done).toBe(1000);
			// Payments cannot be reached to tell: staff cannot refund by hand yet
			const unreachable = await shop.admin(ticket, 'POST', `/v1/admin/orders/${order.id}/refunds`, {
				amount: 1000,
				reason: 'By hand',
				method: 'cod',
			});
			expect(codeOf(unreachable)).toBe('payments_unavailable');
		} finally {
			shop.responders.set(PAYMENTS, normal);
		}
		// Payments answers again: it shows the refund the order does not record, so the pending one is recorded as done
		// (not asked again); staff reload and see it refunded
		shop.responders.set(PAYMENTS, (call) =>
			call.method === 'GET' && call.path.endsWith(`/${paymentId}`)
				? { status: 200, body: { ...normal(call).body, refunded: 1000, refunds: [{ id: 'rfd_x_1', amount: 1000 }] } }
				: normal(call),
		);
		try {
			const byHand = await shop.admin(ticket, 'POST', `/v1/admin/orders/${order.id}/refunds`, {
				amount: 1000,
				reason: 'By hand',
				method: 'cod',
			});
			expect(codeOf(byHand)).toBe('conflict');
		} finally {
			shop.responders.set(PAYMENTS, normal);
		}
		const after = await recordOf(order.id);
		expect(after.effects[0]).toMatchObject({ state: 'done' });
		expect(after.payment).toMatchObject({ refunded: 1000, state: 'refunded' });
		expect(after.refunds).toEqual([expect.objectContaining({ method: 'payments', amount: 1000 })]);
		// recorded from what Payments shows, not asked again
		expect(after.effects[0].refundId).toBe('rfd_x_1');
		expect(refundCalls(paymentId).map((call) => call.headers['idempotency-key'])).toEqual([`${order.id}:cancel`]);
	});

	it('is taken by one try at a time; staff wait while it runs', async () => {
		const restore = refundsAnswer({ status: 503, body: {} });
		const { order, paymentId } = await seedOrder();
		try {
			expect((await moveTo(order.id, 'cancelled')).status).toBe(200);
		} finally {
			restore();
		}
		// another call runs it at Payments right now
		await (
			await orders()
		).updateOne(
			{ websiteId: shop.websiteId, id: order.id },
			{ $set: { 'effects.0.runningAt': new Date(shop.now()), 'effects.0.triedAt': null } },
		);
		const calls = refundCalls(paymentId).length;
		shop.advance(61_000);
		await shop.api('GET', `/v1/orders/${order.id}`);
		expect(refundCalls(paymentId)).toHaveLength(calls);
		const waits = await shop.admin(ticket, 'POST', `/v1/admin/orders/${order.id}/refunds`, {
			amount: 1000,
			reason: 'By hand',
			method: 'cod',
		});
		expect(codeOf(waits)).toBe('conflict');
		// a try that never ended is taken over after two minutes, with the same key
		shop.advance(2 * 60_000);
		const read = await shop.api('GET', `/v1/orders/${order.id}`);
		expect(read.json.effects[0]).toMatchObject({ state: 'done', runningAt: null });
		expect(refundCalls(paymentId)).toHaveLength(calls + 1);
	});
});

describe('the flow-save guard and restatus', () => {
	it('refuses removing, re-keying or re-roling a status with orders on both save routes; names and moves change', async () => {
		const { order } = await seedOrder({ status: 'packed', role: 'packed' });
		const cookie = await shop.adminSession();
		const path = `/v1/dashboard/websites/${shop.websiteId}/lists/order_flow`;
		const without = {
			statuses: DEFAULT_FLOW.statuses.filter((status) => status.key !== 'packed'),
			moves: DEFAULT_FLOW.moves.filter((move) => move.from !== 'packed' && move.to !== 'packed'),
		};
		const removed = await shop.dashboard(cookie, 'PUT', path, { value: without });
		expect(removed.status).toBe(422);
		expect(removed.json.errors[0]).toMatchObject({ path: '/value/statuses', code: 'status_in_use' });
		expect(removed.json.errors[0].message).toMatch(
			/^The status Packed \(packed\) has \d+ orders? in it, so it cannot be removed/,
		);
		const reKeyed = {
			statuses: DEFAULT_FLOW.statuses.map((status) => (status.key === 'packed' ? { ...status, key: 'boxed' } : status)),
			moves: DEFAULT_FLOW.moves.map((move) => ({
				from: move.from === 'packed' ? 'boxed' : move.from,
				to: move.to === 'packed' ? 'boxed' : move.to,
			})),
		};
		expect(codeOf(await shop.api('PUT', '/v1/lists/order_flow', { value: reKeyed }))).toBe('validation_failed');
		const reRoled = {
			...DEFAULT_FLOW,
			statuses: DEFAULT_FLOW.statuses.map((status) => (status.key === 'packed' ? { ...status, role: 'open' } : status)),
			moves: DEFAULT_FLOW.moves.filter((move) => !(move.from === 'packed' && move.to === 'dispatched')),
		};
		const roleRefused = await shop.api('PUT', '/v1/lists/order_flow', { value: reRoled });
		expect(roleRefused.status).toBe(422);
		expect(roleRefused.json.errors[0]).toMatchObject({ path: '/value/statuses/3/role' });
		// names and moves change freely
		const renamed = {
			statuses: DEFAULT_FLOW.statuses.map((status) => (status.key === 'packed' ? { ...status, label: 'Boxed' } : status)),
			moves: DEFAULT_FLOW.moves.filter((move) => move.to !== 'delivered' || move.from === 'dispatched'),
		};
		expect((await shop.api('PUT', '/v1/lists/order_flow', { value: renamed })).status).toBe(200);

		// restatus: its orders move to another packed status, then the status can go
		const withBoxed = {
			statuses: [...DEFAULT_FLOW.statuses, { key: 'boxed', label: 'Boxed', role: 'packed' }],
			moves: [...DEFAULT_FLOW.moves, { from: 'boxed', to: 'dispatched' }],
		};
		expect((await shop.list('order_flow', withBoxed)).statuses).toHaveLength(10);
		expect(codeOf(await shop.api('POST', '/v1/orders/restatus', { from: 'packed', to: 'confirmed' }))).toBe(
			'validation_failed',
		);
		expect(codeOf(await shop.api('POST', '/v1/orders/restatus', { from: 'packed', to: 'nowhere' }))).toBe('validation_failed');
		// tickets are short-lived: fresh ones
		ticket = await shop.ticket(ALL_PERMISSIONS);
		const viewer = await shop.ticket(['orders.read']);
		expect((await shop.admin(viewer, 'POST', '/v1/admin/orders/restatus', { from: 'packed', to: 'boxed' })).status).toBe(403);
		const moved = await shop.admin(ticket, 'POST', '/v1/admin/orders/restatus', { from: 'packed', to: 'boxed' });
		expect(moved.json).toEqual({ from: 'packed', to: 'boxed', role: 'packed', moved: expect.any(Number) });
		expect(moved.json.moved).toBeGreaterThanOrEqual(1);
		const after = await recordOf(order.id);
		expect(after).toMatchObject({ status: 'boxed', role: 'packed' });
		expect(after.history.at(-1)).toMatchObject({
			from: 'packed',
			to: 'boxed',
			by: 'Sam Staff',
			byKind: 'staff',
			code: 'restatus',
		});
		expect((await shop.api('GET', '/v1/activity?action=orders.restatus')).json.items[0]).toMatchObject({
			label: `${moved.json.moved} orders`,
			detail: 'Packed → Boxed',
		});
		const flowWithout = {
			statuses: withBoxed.statuses.filter((status) => status.key !== 'packed'),
			moves: withBoxed.moves.filter((move) => move.from !== 'packed' && move.to !== 'packed'),
		};
		expect((await shop.api('PUT', '/v1/lists/order_flow', { value: flowWithout })).status).toBe(200);
		// a status left from before may come back, with its orders' kind of step only
		const back = (/** @type {string} */ role) => ({
			...flowWithout,
			statuses: [...flowWithout.statuses, { key: 'packed', label: 'Packed', role }],
		});
		await (await orders()).updateOne({ websiteId: shop.websiteId, id: order.id }, { $set: { status: 'packed' } });
		expect((await shop.api('PUT', '/v1/lists/order_flow', { value: back('open') })).status).toBe(422);
		expect((await shop.api('PUT', '/v1/lists/order_flow', { value: back('packed') })).status).toBe(200);
		expect((await shop.api('POST', '/v1/orders/restatus', { from: 'packed', to: 'boxed' })).json.moved).toBeGreaterThanOrEqual(
			1,
		);
		await shop.list('order_flow', withBoxed);
	});

	it('checks nothing against orders while the merchant database is not connected', async () => {
		const bare = await setup();
		try {
			await bare.switchOn(['catalog', 'checkout']);
			const without = { ...DEFAULT_FLOW, statuses: DEFAULT_FLOW.statuses.filter((status) => status.key !== 'refunded') };
			without.moves = DEFAULT_FLOW.moves.filter((move) => move.to !== 'refunded');
			expect((await bare.list('order_flow', without)).statuses).toHaveLength(8);
		} finally {
			await bare.product.close();
		}
	});
});

describe('every way an order moves goes through the engine', () => {
	it('writes the facts and an activity line for a shopper’s cancel, an ended window and Payments’ confirmation', async () => {
		const item = await shop.seedProduct({ price: 1000, stock: 5 });
		const token = await shop.signIn({ id: 'usr_engineshop01' });
		/** @param {string} payment @param {string} key */
		const place = (payment, key) =>
			shop.call('POST', '/v1/shop/orders', {
				token: shop.browser,
				origin: ORIGIN,
				body: {
					lines: [{ productId: item.id }],
					payment,
					address: { name: 'Eve', phone: '+15550001111', line1: '1 Main', city: 'Springfield', country: 'US' },
				},
				headers: { 'ss-sign-in': token, 'idempotency-key': key, 'x-forwarded-for': `10.77.0.${key.length}` },
			});
		const cod = (await place('cod', 'engine-1')).json.order;
		expect((await recordOf(cod.id)).facts).toEqual(PLACED_FACTS);
		const cancelled = await shop.call('POST', `/v1/shop/orders/${cod.id}/cancel`, {
			token: shop.browser,
			origin: ORIGIN,
			headers: { 'ss-sign-in': token },
		});
		expect(cancelled.status).toBe(200);
		expect((await recordOf(cod.id)).facts).toMatchObject({ stock: 'back', offers: 'released' });
		expect((await activityOf(cod.id))[0]).toMatchObject({
			actor: { kind: 'shopper', id: 'usr_engineshop01', name: 'Shopper' },
			action: 'order.moved',
			detail: 'Awaiting confirmation → Canceled',
		});

		const online = (await place('online', 'engine-22')).json.order;
		const paymentId = (await recordOf(online.id)).payment.paymentId;
		shop.payPayment(paymentId);
		shop.advance(31_000);
		const paid = await shop.api('GET', `/v1/orders/${online.id}`);
		expect(paid.json).toMatchObject({ status: 'confirmed', facts: PLACED_FACTS });
		expect((await activityOf(online.id))[0]).toMatchObject({
			actor: { kind: 'system', id: 'payments' },
			action: 'order.moved',
		});

		const ending = (await place('cod', 'engine-333')).json.order;
		shop.advance(25 * 3_600_000);
		await shop.call('POST', '/v1/shop/cart/quote', { token: shop.browser, origin: ORIGIN, body: { lines: [] } });
		expect(await recordOf(ending.id)).toMatchObject({ role: 'cancelled', facts: { stock: 'back' } });
		expect((await activityOf(ending.id))[0]).toMatchObject({
			actor: { kind: 'system', id: 'checkout' },
			action: 'order.moved',
		});
	});

	it('captures typed serial numbers through the engine: the lines, their facts and the numbers together', async () => {
		await shop.list('item_types', UNIT_TYPES);
		const { order } = await seedOrder({ status: 'packed', role: 'packed', typeKey: 'typed' });
		const line = order.lines[0];
		const typed = await shop.api('PATCH', `/v1/orders/${order.id}`, { serials: { [line.id]: ['SN-0001'] } });
		expect(typed.status).toBe(200);
		expect(typed.json.facts.units).toBe('captured');
		expect((await recordOf(order.id)).facts).toEqual({ ...PLACED_FACTS, units: 'captured' });
		// typed again with the order as read before: refused, nothing written
		const s = await service.site(ctx());
		await expect(moves.typeSerials(s, ctx(), order, { [line.id]: ['SN-0002'] })).rejects.toMatchObject({
			code: 'conflict',
		});
		const serials = (await shop.db()).collection(COLLECTIONS.serials);
		expect(await serials.countDocuments({ websiteId: shop.websiteId, serial: 'SN-0002' })).toBe(0);
		// canceled: the typed number goes (it never was in stock)
		expect((await moveTo(order.id, 'cancelled')).json.facts.units).toBe('none');
		expect(await serials.countDocuments({ websiteId: shop.websiteId, serial: 'SN-0001' })).toBe(0);
	});

	it('gives back what a deleted order holds once, and refuses to delete an order that changed meanwhile', async () => {
		const { order, product } = await seedOrder({ cod: true, quantity: 2 });
		const s = await service.site(ctx());
		await (await orders()).updateOne({ websiteId: shop.websiteId, id: order.id }, { $set: { staffNote: 'changed' } });
		shop.advance(1000);
		await (await orders()).updateOne({ websiteId: shop.websiteId, id: order.id }, { $set: { staffNote: 'again' } });
		expect(await moves.giveBack(s, order)).toBe(false);
		expect(await stockOf(product.id)).toBe(3);
		expect((await shop.api('DELETE', `/v1/orders/${order.id}`)).status).toBe(204);
		expect(await stockOf(product.id)).toBe(5);
	});
});
