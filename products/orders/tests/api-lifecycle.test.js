/** Intake, the lifecycle matrix, fulfilment, serials, the ledger and the events they publish (through the real API). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, HOUR, WEBSITE, WEBSITE_2 } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
/** @type {any} */
let phone;
beforeAll(async () => {
	h = await createHarness({
		config: {
			fulfilment: {
				carriers: [
					{
						key: 'parcel-co',
						name: 'Parcel Co',
						tracking_url_template: 'https://track.example.com/{tracking}',
						service_levels: ['standard'],
					},
				],
			},
			serials: { required_for: 'flagged', required_attributes: [{ key: 'kind', values: ['device'] }] },
		},
	});
});
afterAll(async () => h?.close());

describe('intake', () => {
	it('takes in an order, numbers it, snapshots lines and publishes order.placed@1 once', async () => {
		const order = await h.order({ externalId: 'ext-1' });
		expect(order).toMatchObject({
			number: '000001',
			status: 'pending_payment',
			source: 'api',
			currency: 'EUR',
			duplicate: false,
		});
		expect(order.lines[0]).toMatchObject({ id: 'l1', warranty: { days: 365, label: null }, serials: [] });
		expect(order.amounts).toMatchObject({ subtotal: 5500, total: 5500 });
		expect(order.money).toMatchObject({ balanceDue: 5500, paymentState: 'unpaid' });
		const again = await h.order({ externalId: 'ext-1' });
		expect(again).toMatchObject({ id: order.id, duplicate: true });
		const placed = h.published('order.placed@1').filter((e) => e.data.orderId === order.id);
		expect(placed).toHaveLength(1);
		expect(placed[0].data).toMatchObject({ number: '000001', currency: 'EUR', customer: { customerId: 'cus_1' } });
		expect(JSON.stringify(placed[0].data)).not.toContain('ada@example.com');
		// the customer heard about it on the first channel they can be reached on
		expect(h.provider.sent.some((m) => m.metadata.orderId === order.id && m.channel === 'email')).toBe(true);
		const stored = await h.collection('orders').findOne({ id: order.id });
		expect(stored.customerKeys.every((/** @type {string} */ k) => !k.includes('@'))).toBe(true);
		expect(stored.pending).toEqual([]);
	});

	it('refuses invalid orders with field problems and unknown mappings', async () => {
		const bad = await h.call('POST', '/v1/inbound-orders', { body: { currency: 'EURO', lines: [{ quantity: 0 }] } });
		expect(bad.status).toBe(422);
		expect(bad.json.errors.map((/** @type {any} */ e) => e.path)).toEqual(
			expect.arrayContaining(['/currency', '/lines/0/title']),
		);
		expect((await h.call('POST', '/v1/inbound-orders?mapping=nope', { body: {} })).status).toBe(422);
		expect((await h.call('POST', '/v1/inbound-orders', { body: { lines: [] } })).status).toBe(422);
	});

	it('maps another checkout’s payload with decimal money', async () => {
		await h.entitle({
			config: {
				inbound_api: {
					mappings: [
						{
							key: 'shopx',
							amounts: 'decimal',
							source_label: 'Shop X',
							fields: [
								{ target: 'externalId', source: 'id' },
								{ target: 'currency', source: 'currency_code' },
								{ target: 'customer.email', source: 'buyer.mail' },
								{ target: 'amounts.total', source: 'grand_total' },
								{ target: 'payment.status', source: 'financial' },
								{ target: 'payment.method', source: 'gateway' },
							],
							lines_path: 'items',
							line_fields: [
								{ target: 'sku', source: 'code' },
								{ target: 'title', source: 'name' },
								{ target: 'quantity', source: 'qty' },
								{ target: 'unitAmount', source: 'price' },
								{ target: 'attributes.kind', source: 'kind' },
							],
						},
					],
				},
				fulfilment: {
					carriers: [{ key: 'parcel-co', name: 'Parcel Co', tracking_url_template: 'https://track.example.com/{tracking}' }],
				},
				serials: { required_for: 'flagged', required_attributes: [{ key: 'kind', values: ['device'] }] },
			},
		});
		const result = await h.call('POST', '/v1/inbound-orders?mapping=shopx', {
			body: {
				id: 'X-77',
				currency_code: 'usd',
				buyer: { mail: 'BOB@example.com' },
				grand_total: '19.98',
				financial: 'paid',
				gateway: 'card',
				items: [{ code: 'PH-1', name: 'Phone', qty: '2', price: '9.99', kind: 'device' }],
			},
		});
		expect(result.status, result.text).toBe(201);
		expect(result.json).toMatchObject({
			sourceLabel: 'Shop X',
			externalId: 'X-77',
			currency: 'USD',
			status: 'confirmed',
			customer: { email: 'bob@example.com' },
			amounts: { total: 1998 },
			money: { paid: 1998, paymentState: 'paid' },
		});
		expect(h.published('order.paid@1').some((e) => e.data.orderId === result.json.id)).toBe(true);
		const bad = await h.call('POST', '/v1/inbound-orders?mapping=shopx', { body: { grand_total: 'x', items: 3 } });
		expect(bad.status).toBe(422);
		phone = result.json;
	});
});

describe('lifecycle', () => {
	it('moves through the matrix with checks; dispatched may only be delivered or returned', async () => {
		const pack = await h.call('POST', `/v1/orders/${phone.id}/transitions`, { body: { status: 'packed' } });
		expect(pack.status, pack.text).toBe(200);
		const early = await h.call('POST', `/v1/orders/${phone.id}/transitions`, { body: { status: 'dispatched' } });
		expect(early.status).toBe(409);
		expect(early.json.type).toMatch(/serials_missing$/);
		const badSerial = await h.call('PUT', `/v1/orders/${phone.id}/serials`, {
			body: { lines: [{ lineId: 'l1', serials: ['490154203237519'] }] },
		});
		expect(badSerial.status).toBe(422);
		expect(badSerial.json.errors[0].code).toBe('serial_checksum');
		const serials = await h.call('PUT', `/v1/orders/${phone.id}/serials`, {
			body: { lines: [{ lineId: 'l1', serials: ['49015420323751-8', 'SN 0002'] }] },
		});
		expect(serials.status, serials.text).toBe(200);
		expect(serials.json.lines[0].serials).toEqual(['490154203237518', 'SN 0002']);
		const lookup = await h.call('GET', '/v1/serials?serial=490154203237518');
		expect(lookup.json.items[0]).toMatchObject({ orderId: phone.id, lineId: 'l1' });
		const recorded = h.published('orders.serials_recorded@1').filter((e) => e.data.orderId === phone.id);
		expect(recorded.at(-1).data.serials).toEqual([
			{ serial: '490154203237518', lineId: 'l1', itemId: 'PH-1', sku: 'PH-1' },
			{ serial: 'SN 0002', lineId: 'l1', itemId: 'PH-1', sku: 'PH-1' },
		]);
		const fulfil = await h.call('PATCH', `/v1/orders/${phone.id}/fulfilment`, {
			body: { carrier: 'parcel-co', trackingNumber: 'PC 123', serviceLevel: 'standard' },
		});
		expect(fulfil.status, fulfil.text).toBe(200);
		expect(fulfil.json.fulfilment).toMatchObject({
			carrierName: 'Parcel Co',
			trackingUrl: 'https://track.example.com/PC%20123',
		});
		const unknownCarrier = await h.call('PATCH', `/v1/orders/${phone.id}/fulfilment`, { body: { carrier: 'nobody' } });
		expect(unknownCarrier.status).toBe(422);
		const dispatch = await h.call('POST', `/v1/orders/${phone.id}/transitions`, { body: { status: 'dispatched' } });
		expect(dispatch.status, dispatch.text).toBe(200);
		expect(dispatch.json.next).toEqual(['delivered', 'returned']);
		const cancel = await h.call('POST', `/v1/orders/${phone.id}/transitions`, { body: { status: 'cancelled' } });
		expect(cancel.status).toBe(409);
		expect(cancel.json.type).toMatch(/transition_not_allowed$/);
		const changed = h.published('orders.status_changed@1').filter((e) => e.data.orderId === phone.id);
		expect(changed.at(-1).data).toMatchObject({ from: 'packed', to: 'dispatched', trackingNumber: 'PC 123', revenue: true });
		const deliver = await h.call('POST', `/v1/orders/${phone.id}/transitions`, { body: { status: 'delivered' } });
		expect(deliver.status).toBe(200);
		const completed = h.published('order.completed@1').filter((e) => e.data.orderId === phone.id);
		expect(completed).toHaveLength(1);
		expect(completed[0].data.lines[0]).toMatchObject({ itemId: 'PH-1', sku: 'PH-1', quantity: 2 });
	});

	it('requires a return reason, counts returns to origin and flags repeat customers', async () => {
		await h.entitle({ config: { risk: { rto_warning_threshold: 1 } } });
		const order = await h.order({ payment: { method: 'cod' }, customer: { customerId: 'cus_rto', email: 'rto@example.com' } });
		expect(order.status).toBe('awaiting_confirmation');
		for (const status of ['confirmed', 'packed', 'dispatched'])
			expect((await h.call('POST', `/v1/orders/${order.id}/transitions`, { body: { status } })).status).toBe(200);
		const noReason = await h.call('POST', `/v1/orders/${order.id}/transitions`, { body: { status: 'returned' } });
		expect(noReason.status).toBe(422);
		const wrong = await h.call('POST', `/v1/orders/${order.id}/transitions`, { body: { status: 'returned', reason: 'lost' } });
		expect(wrong.json.type).toMatch(/reason_not_allowed$/);
		const back = await h.call('POST', `/v1/orders/${order.id}/transitions`, { body: { status: 'returned', reason: 'rto' } });
		expect(back.status, back.text).toBe(200);
		expect(back.json.returnReason).toBe('rto');
		const cancelled = h.published('order.cancelled@1').find((e) => e.data.orderId === order.id);
		expect(cancelled.data.reason).toBe('returned:rto');
		const next = await h.order({ payment: { method: 'cod' }, customer: { customerId: 'cus_rto' } });
		expect(next.risk.flags).toContain('rto_flagged');
		await h.entitle();
	});

	it('expires unconfirmed orders through the sweep job and cancels them', async () => {
		const order = await h.order();
		expect(order.expiresAt).toBeTruthy();
		h.clock.advance(49 * HOUR);
		const swept = await h.call('GET', '/cron/sweep', {
			key: null,
			headers: { authorization: 'Bearer cron-secret-0123456789abcdef' },
		});
		expect(swept.status, swept.text).toBe(200);
		const after = await h.call('GET', `/v1/orders/${order.id}`);
		expect(after.json.status).toBe('cancelled');
		expect(after.json.timeline.at(-1)).toMatchObject({ status: 'cancelled', reason: 'expired', actor: { type: 'system' } });
		expect((await h.call('GET', '/cron/sweep', { key: null })).status).toBe(401);
	});

	it('treats an expired status as expired on read, before any sweep (free-tier hosting: daily cron)', async () => {
		await h.entitle({ config: { risk: { open_order_cap: 1, cap_action: 'flag' } } });
		const customer = { customerId: 'cus_exp', email: 'exp@example.com', phone: '+44 20 7946 1111', name: 'Exp' };
		const first = await h.order({ customer });
		const second = await h.order({ customer });
		expect(second.risk.flags).toContain('open_cap');
		h.clock.advance(49 * HOUR);
		// expired orders no longer count as open, though nothing swept them
		const third = await h.order({ customer });
		expect(third.risk.flags).not.toContain('open_cap');
		expect((await h.collection('orders').findOne({ id: first.id })).status).toBe('pending_payment');
		// reading applies the expiry: the API, the list and the stored order agree
		const read = await h.call('GET', `/v1/orders/${first.id}`);
		expect(read.json.status).toBe('cancelled');
		expect(read.json.timeline.at(-1)).toMatchObject({ status: 'cancelled', reason: 'expired', actor: { type: 'system' } });
		expect((await h.collection('orders').findOne({ id: first.id })).status).toBe('cancelled');
		const listed = await h.call('GET', '/v1/orders?limit=100');
		expect(listed.json.items.find((/** @type {any} */ o) => o.id === second.id)?.status).toBe('cancelled');
		// a staff move on an order whose status expired starts from the expired status
		h.clock.advance(49 * HOUR);
		const late = await h.call('POST', `/v1/orders/${third.id}/transitions`, { body: { status: 'confirmed' } });
		expect(late.status).not.toBe(200);
		expect((await h.collection('orders').findOne({ id: third.id })).status).toBe('cancelled');
		await h.entitle();
	});

	it('registers the per-website background sweep; its trigger sweeps that website', async () => {
		const order = await h.order();
		h.clock.advance(49 * HOUR);
		const { sweep } = h.orders.jobs;
		expect(sweep.name).toBe('sweep');
		expect(await sweep.trigger({})).toBe(false); // per website: nothing to do without one
		expect(await sweep.trigger({ websiteId: WEBSITE })).toBe(true);
		expect((await h.collection('orders').findOne({ id: order.id })).status).toBe('cancelled');
		expect(await sweep.trigger({ websiteId: WEBSITE })).toBe(false); // throttled: at most once per interval
		expect(await sweep.trigger({ websiteId: WEBSITE_2 })).toBe(true); // not subscribed: nothing to sweep
		// a run past its deadline leaves the remaining steps for the next one
		const site = await h.site();
		expect(await h.orders.sweepSite(site, { limit: 5, deadline: 0 })).toEqual({ expired: 0, redelivered: 0, messages: 0 });
	});

	it('lists with filters and cursor pages; statuses and carriers are public', async () => {
		const page = await h.call('GET', '/v1/orders?limit=2');
		expect(page.json.items).toHaveLength(2);
		expect(page.json.nextCursor).toBeTruthy();
		const next = await h.call('GET', `/v1/orders?limit=2&cursor=${encodeURIComponent(page.json.nextCursor)}`);
		expect(next.json.items.map((/** @type {any} */ o) => o.id)).not.toContain(page.json.items[0].id);
		const cancelled = await h.call('GET', '/v1/orders?status=cancelled');
		expect(cancelled.json.items.every((/** @type {any} */ o) => o.status === 'cancelled')).toBe(true);
		expect((await h.call('GET', '/v1/orders?status=Bad!')).status).toBe(422);
		expect((await h.call('GET', '/v1/orders', { key: h.pk })).status).toBe(403);
		const statuses = await h.call('GET', '/v1/order-statuses', { key: h.pk });
		expect(statuses.json.items.find((/** @type {any} */ s) => s.key === 'confirmed')).toMatchObject({
			label: 'Confirmed',
			revenue: true,
		});
		const carriers = await h.call('GET', '/v1/carriers', { key: h.pk });
		expect(carriers.json.items[0]).toMatchObject({ key: 'parcel-co', tracking: true });
		expect((await h.call('GET', '/v1/orders/ord_missing')).status).toBe(404);
	});
});

describe('ledger', () => {
	it('records payments (no overpayment), confirms when paid, refunds within what is held, then refunded', async () => {
		const order = await h.order();
		const over = await h.call('POST', `/v1/orders/${order.id}/payments`, { body: { amount: 999999, method: 'cash' } });
		expect(over.json.type).toMatch(/overpayment$/);
		const noRef = await h.call('POST', `/v1/orders/${order.id}/payments`, { body: { amount: 100, method: 'bank_transfer' } });
		expect(noRef.status).toBe(422);
		const part = await h.call('POST', `/v1/orders/${order.id}/payments`, { body: { amount: 5000, method: 'cash' } });
		expect(part.status, part.text).toBe(201);
		expect(part.json.order).toMatchObject({
			status: 'pending_payment',
			money: { paymentState: 'partially_paid', balanceDue: 500 },
		});
		const rest = await h.call('POST', `/v1/orders/${order.id}/payments`, {
			body: { amount: 500, method: 'bank_transfer', reference: 'TRX-9' },
		});
		expect(rest.json.order.status).toBe('confirmed');
		expect(h.published('order.paid@1').filter((e) => e.data.orderId === order.id)).toHaveLength(2);
		const tooMuch = await h.call('POST', `/v1/orders/${order.id}/refunds`, {
			body: { amount: 6000, method: 'cash', reason: 'x' },
		});
		expect(tooMuch.json.type).toMatch(/refund_exceeds_paid$/);
		const noReason = await h.call('POST', `/v1/orders/${order.id}/refunds`, { body: { amount: 100, method: 'cash' } });
		expect(noReason.status).toBe(422);
		const refund = await h.call('POST', `/v1/orders/${order.id}/refunds`, {
			body: { amount: 2500, method: 'cash', reason: 'broken', lines: [{ lineId: 'l1', quantity: 1 }] },
		});
		expect(refund.status, refund.text).toBe(201);
		expect(refund.json.order.money).toMatchObject({ refunded: 2500, refundState: 'partial' });
		const event = h.published('order.refunded@1').find((e) => e.data.orderId === order.id);
		expect(event.data).toMatchObject({ amount: { amount: 2500, currency: 'EUR' }, lines: [{ itemId: 'itm_1', quantity: 1 }] });
		// the default matrix has no confirmed → refunded door: refunded in full, status stays
		const all = await h.call('POST', `/v1/orders/${order.id}/refunds`, {
			body: { amount: 3000, method: 'cash', reason: 'cancel' },
		});
		expect(all.json.order).toMatchObject({ status: 'confirmed', money: { refundState: 'full', netPaid: 0 } });
		const ledger = await h.call('GET', '/v1/ledger');
		expect(ledger.json.totals.EUR.refunds).toBeGreaterThanOrEqual(5500);
		expect((await h.call('GET', '/v1/ledger?from=nope')).status).toBe(422);
		const refunds = await h.call('GET', '/v1/ledger?kind=refund&method=cash&limit=5');
		expect(refunds.json.items.every((/** @type {any} */ e) => e.kind === 'refund')).toBe(true);
	});

	it('moves delivered orders to refunded once refunds cover the payments', async () => {
		const order = await h.order({ payment: { method: 'card', status: 'paid' } });
		expect(order.status).toBe('confirmed');
		for (const status of ['packed', 'dispatched', 'delivered'])
			expect((await h.call('POST', `/v1/orders/${order.id}/transitions`, { body: { status } })).status).toBe(200);
		const early = await h.call('POST', `/v1/orders/${order.id}/transitions`, { body: { status: 'refunded' } });
		expect(early.json.type).toMatch(/refund_incomplete$/);
		const refund = await h.call('POST', `/v1/orders/${order.id}/refunds`, {
			body: { amount: 5500, method: 'card', reason: 'return' },
		});
		expect(refund.json.order.status).toBe('refunded');
	});
});

describe('events consumed', () => {
	it('takes in order.placed@1 from the Checkout with its id, records order.paid@1, follows order.cancelled@1', async () => {
		const placed = await h.deliver('order.placed@1', {
			orderId: 'ord_checkout_1',
			number: 'C-1',
			currency: 'EUR',
			customer: { customerId: 'cus_9', email: 'cy@example.com' },
			lines: [{ itemId: 'itm_9', quantity: 1, unitAmount: 1200 }],
			amounts: { subtotal: 1200, total: 1200 },
		});
		expect(placed.status).toBe(200);
		const order = await h.call('GET', '/v1/orders/ord_checkout_1');
		expect(order.json).toMatchObject({ source: 'checkout', number: 'C-1', status: 'pending_payment' });
		expect(h.published('order.placed@1').some((e) => e.data.orderId === 'ord_checkout_1')).toBe(false);
		await h.deliver(
			'order.paid@1',
			{ orderId: 'ord_checkout_1', amount: { amount: 1200, currency: 'EUR' }, method: 'gateway' },
			{ id: 'evt_paid_1' },
		);
		await h.deliver(
			'order.paid@1',
			{ orderId: 'ord_checkout_1', amount: { amount: 1200, currency: 'EUR' }, method: 'gateway' },
			{ id: 'evt_paid_1' },
		);
		const paid = await h.call('GET', '/v1/orders/ord_checkout_1');
		expect(paid.json).toMatchObject({ status: 'confirmed', paid: 1200 });
		expect(paid.json.payments).toHaveLength(1);
		await h.deliver('order.cancelled@1', { orderId: 'ord_checkout_1' });
		const cancelled = await h.call('GET', '/v1/orders/ord_checkout_1');
		expect(cancelled.json.status).toBe('cancelled');
		// mirrored, not republished
		expect(h.published('order.cancelled@1').some((e) => e.data.orderId === 'ord_checkout_1')).toBe(false);
		// our own publications coming back are ignored
		await h.deliver(
			'order.placed@1',
			{
				orderId: 'ord_own',
				currency: 'EUR',
				lines: [{ itemId: 'i', quantity: 1, unitAmount: 1 }],
				amounts: { subtotal: 1, total: 1 },
			},
			{ context: { source: 'product', product: 'orders' } },
		);
		expect((await h.call('GET', '/v1/orders/ord_own')).status).toBe(404);
		await h.deliver('order.paid@1', { orderId: 'ord_none', amount: { amount: 1, currency: 'EUR' } });
		await h.deliver('order.cancelled@1', { orderId: 'ord_none' });
		await h.deliver('order.placed@1', { orderId: 'ord_bad' }, { websiteId: WEBSITE });
	});

	it('records an order.refunded@1 from After-sales once, without republishing it', async () => {
		const order = await h.order({ payment: { method: 'card', status: 'paid' } });
		const data = { orderId: order.id, amount: { amount: 1000, currency: 'EUR' }, reason: 'Return R-1 · Card' };
		const context = { source: 'product', product: 'aftersales' };
		await h.deliver('order.refunded@1', data, { id: 'evt_as_refund_1', context });
		await h.deliver('order.refunded@1', data, { id: 'evt_as_refund_1', context });
		const after = await h.call('GET', `/v1/orders/${order.id}`);
		expect(after.json.refunds).toHaveLength(1);
		expect(after.json.refunds[0]).toMatchObject({
			amount: 1000,
			reference: 'aftersales:evt_as_refund_1',
			note: 'Return R-1 · Card',
		});
		expect(after.json.money).toMatchObject({ refunded: 1000, refundState: 'partial' });
		expect(h.published('order.refunded@1').some((e) => e.data.orderId === order.id)).toBe(false);
		// our own refund event coming back is skipped
		await h.deliver('order.refunded@1', data, { id: 'evt_own_refund', context: { source: 'product', product: 'orders' } });
		await h.deliver('order.refunded@1', { ...data, amount: { amount: 5, currency: 'USD' } });
		await h.deliver('order.refunded@1', { orderId: 'ord_none', amount: { amount: 5, currency: 'EUR' } });
		expect((await h.call('GET', `/v1/orders/${order.id}`)).json.refunds).toHaveLength(1);
	});
});
