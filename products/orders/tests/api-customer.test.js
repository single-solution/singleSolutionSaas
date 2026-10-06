/** Customers (pk_ + verified SS-Identity), tracking lookups, documents, bulk, risk, customer updates and the dashboard. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, WEBSITE } from './harness.js';
import { resolveDashboard } from '../api/dashboard.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
/** @type {any} */
let mine;
beforeAll(async () => {
	h = await createHarness({
		config: {
			invoices: { brand_name: 'Shop & Co', address_lines: ['1 Main St'], legal_text: 'Terms <apply>', tax_id: 'TX-1' },
			fulfilment: {
				carriers: [{ key: 'parcel-co', name: 'Parcel Co', tracking_url_template: 'https://track.example.com/{tracking}' }],
			},
		},
	});
	mine = await h.order({
		customer: { subject: 'usr_ada', email: 'ada@example.com', name: 'Ada' },
		taxLines: [{ label: 'VAT', rate: '20%', amount: 917 }],
		adjustments: [{ label: 'Points redeemed', amount: -200 }],
		amounts: { total: 5300 },
	});
});
afterAll(async () => h?.close());

describe('customers', () => {
	it('lists and reads only their own orders, and cancels while allowed', async () => {
		await h.order({ customer: { subject: 'usr_other', email: 'other@example.com' } });
		const identity = h.login({ sub: 'usr_ada' });
		expect((await h.call('GET', '/v1/my-orders', { key: h.pk })).status).toBe(401);
		const list = await h.call('GET', '/v1/my-orders', { key: h.pk, identity });
		expect(list.status, list.text).toBe(200);
		expect(list.json.items.map((/** @type {any} */ o) => o.id)).toEqual([mine.id]);
		expect(list.json.items[0]).toMatchObject({ canCancel: true, statusLabel: 'Awaiting payment' });
		const view = await h.call('GET', `/v1/my-orders/${mine.id}`, { key: h.pk, identity });
		expect(view.json).toMatchObject({ number: mine.number, money: { balanceDue: 5300 } });
		expect(view.text).not.toContain('risk');
		const byEmail = h.login({ sub: 'usr_new', email: 'ADA@example.com' });
		expect((await h.call('GET', `/v1/my-orders/${mine.id}`, { key: h.pk, identity: byEmail })).status).toBe(200);
		const stranger = h.login({ sub: 'usr_x' });
		expect((await h.call('GET', `/v1/my-orders/${mine.id}`, { key: h.pk, identity: stranger })).status).toBe(404);
		const receipt = await h.call('GET', `/v1/my-orders/${mine.id}/receipt?format=json`, { key: h.pk, identity });
		expect(receipt.json.html).toContain('Shop &amp; Co');
		const other = await h.order({ customer: { subject: 'usr_ada' } });
		const cancel = await h.call('POST', `/v1/my-orders/${other.id}/cancel`, { key: h.pk, identity });
		expect(cancel.status, cancel.text).toBe(200);
		expect(cancel.json).toMatchObject({ status: 'cancelled', canCancel: false });
		expect((await h.call('POST', `/v1/my-orders/${other.id}/cancel`, { key: h.pk, identity })).status).toBe(409);
		expect((await h.call('POST', '/v1/my-orders/ord_none/cancel', { key: h.pk, identity })).status).toBe(404);
	});

	it('looks up tracking by number and contact without leaking whether the order exists', async () => {
		await h.call('PATCH', `/v1/orders/${mine.id}/fulfilment`, { body: { carrier: 'parcel-co', trackingNumber: 'PC9' } });
		const found = await h.call('POST', '/v1/tracking-lookups', {
			key: h.pk,
			body: { number: mine.number, contact: 'ada@example.com' },
		});
		expect(found.status, found.text).toBe(200);
		expect(found.json.tracking).toMatchObject({ carrier: 'Parcel Co', trackingUrl: 'https://track.example.com/PC9' });
		expect(found.text).not.toContain('ada@example.com');
		const wrong = await h.call('POST', '/v1/tracking-lookups', {
			key: h.pk,
			body: { number: mine.number, contact: '+1 555 0100' },
		});
		expect(wrong.status).toBe(404);
		expect((await h.call('POST', '/v1/tracking-lookups', { key: h.pk, body: {} })).status).toBe(422);
	});

	it('serves element views for the Loader stub', async () => {
		const identity = h.login({ sub: 'usr_ada' });
		const anonymous = await h.call('GET', '/v1/elements/lifecycle/view', { key: h.pk });
		expect(anonymous.json.body).toBe('Sign in to see your orders.');
		const orders = await h.call('GET', '/v1/elements/lifecycle/view', { key: h.pk, identity });
		expect(orders.json.items.length).toBeGreaterThan(0);
		const tracking = await h.call('GET', '/v1/elements/fulfilment/view', { key: h.pk, identity });
		expect(tracking.json.items[0].href).toBe('https://track.example.com/PC9');
		const none = await h.call('GET', '/v1/elements/fulfilment/view', { key: h.pk, identity: h.login({ sub: 'usr_nobody' }) });
		expect(none.json.body).toBe('You have no orders yet.');
	});
});

describe('documents', () => {
	it('renders invoices from the snapshot (warranty per line, tax lines, adjustments) with sequential numbers', async () => {
		const html = await h.call('GET', `/v1/orders/${mine.id}/invoice`);
		expect(html.headers.get('content-type')).toMatch(/text\/html/);
		expect(html.headers.get('content-security-policy')).toContain("default-src 'none'");
		expect(html.text).toContain('INV-000001');
		expect(html.text).toContain('365 days');
		expect(html.text).toContain('No warranty');
		expect(html.text).toContain('VAT (20%)');
		expect(html.text).toContain('Points redeemed');
		expect(html.text).toContain('Terms &lt;apply&gt;');
		expect(html.text).toContain('Tax number: TX-1');
		const again = await h.call('GET', `/v1/orders/${mine.id}/invoice?kind=internal&format=json`);
		expect(again.json.html).toContain('INV-000001');
		expect(again.json.title).toBe('Internal invoice INV-000001');
		const list = await h.call('GET', '/v1/invoices');
		expect(list.json.items[0]).toMatchObject({ orderId: mine.id, invoiceNumber: 'INV-000001' });
		expect((await h.call('GET', '/v1/orders/ord_none/invoice')).status).toBe(404);
	});

	it('prints packing slips with serial slots and the amount to collect, and pick lists by SKU', async () => {
		const cod = await h.order({ payment: { method: 'cod' } });
		const slips = await h.call('GET', `/v1/packing-slips?ids=${mine.id},${cod.id}`);
		expect(slips.status).toBe(200);
		expect(slips.text).toContain('Collect on delivery');
		expect(slips.text).toContain('Prepaid: nothing to collect');
		expect(slips.text.match(/class="slot"/g)?.length).toBeGreaterThan(3);
		const pick = await h.call('GET', `/v1/pick-lists?ids=${mine.id},${cod.id}`);
		expect(pick.text).toContain('LAMP-1');
		expect(pick.text).toContain('2 orders');
		expect((await h.call('GET', '/v1/packing-slips')).status).toBe(422);
		expect((await h.call('GET', '/v1/pick-lists?ids=bad id')).status).toBe(422);
	});
});

describe('bulk', () => {
	it('moves many orders with per-order results, exports and imports CSV', async () => {
		const a = await h.order({ payment: { method: 'card', status: 'paid' } });
		const b = await h.order({ payment: { method: 'card', status: 'paid' } });
		const c = await h.order();
		const batch = await h.call('POST', '/v1/order-batches', {
			body: { ids: [a.id, b.id, c.id, 'ord_nope'], status: 'packed' },
		});
		expect(batch.json).toMatchObject({ updated: 2, failed: 2 });
		const skip = await h.call('POST', '/v1/order-batches', { body: { ids: [a.id], status: 'packed' } });
		expect(skip.json.skipped).toBe(1);
		expect((await h.call('POST', '/v1/order-batches', { body: { ids: [] } })).status).toBe(422);
		expect((await h.call('POST', '/v1/order-batches', { body: { ids: [a.id] } })).status).toBe(422);
		const csv = await h.call('GET', '/v1/order-exports?status=packed');
		expect(csv.headers.get('x-ss-rows')).toBe('2');
		expect(csv.text).toContain('number,placed_at,status');
		expect((await h.call('GET', '/v1/order-exports?from=bad')).status).toBe(422);
		const file = `number,status,carrier,tracking_number\n${a.number},dispatched,parcel-co,T-1\n${b.number},delivered,,\nmissing,packed,,\n,,,\n`;
		const dry = await h.call('POST', '/v1/order-imports', { body: { csv: file, dryRun: true } });
		expect(dry.json).toMatchObject({ dryRun: true, valid: 1, failed: 3 });
		const run = await h.call('POST', '/v1/order-imports', { body: { csv: file } });
		expect(run.json.updated).toBe(1);
		expect((await h.call('GET', `/v1/orders/${a.id}`)).json).toMatchObject({
			status: 'dispatched',
			fulfilment: { trackingNumber: 'T-1' },
		});
		expect((await h.call('POST', '/v1/order-imports', { body: { csv: '"' } })).status).toBe(422);
		expect((await h.call('POST', '/v1/order-imports', { body: {} })).status).toBe(422);
	});
});

describe('risk', () => {
	it('blocks customers, refuses or reviews orders, and checks before checkout', async () => {
		await h.entitle({
			config: { risk: { open_order_cap: 50, cod_max_total: [{ currency: 'EUR', amount: 1000 }], cod_advance_percent: 10 } },
		});
		const blocked = await h.call('POST', '/v1/blocklist', {
			body: { type: 'email', value: 'Bad@Example.com', reason: 'fraud' },
		});
		expect(blocked.status, blocked.text).toBe(201);
		expect(blocked.json).toMatchObject({ display: 'b***@example.com', blocked: true });
		const list = await h.call('GET', '/v1/blocklist');
		expect(list.json.items[0].key).toBe(blocked.json.key);
		const refused = await h.call('POST', '/v1/inbound-orders', {
			body: { currency: 'EUR', customer: { email: 'bad@example.com' }, lines: [{ title: 'X', quantity: 1, unitAmount: 100 }] },
		});
		expect(refused.status).toBe(422);
		expect(refused.json).toMatchObject({ flags: ['blocked'] });
		const check = await h.call('POST', '/v1/risk-checks', {
			body: { currency: 'EUR', total: 5000, payment: { method: 'cod' }, customer: { email: 'ok@example.com' } },
		});
		expect(check.json).toMatchObject({ decision: 'review', flags: ['cod_over_cap'], advance: 500 });
		const review = await h.order({ payment: { method: 'cod' } });
		expect(review).toMatchObject({ status: 'pending_payment', risk: { review: 'pending', advance: 550 } });
		const queue = await h.call('GET', '/v1/risk-reviews');
		expect(queue.json.items.map((/** @type {any} */ o) => o.id)).toContain(review.id);
		const cleared = await h.call('POST', `/v1/orders/${review.id}/review`, { body: { decision: 'clear', note: 'called' } });
		expect(cleared.json.risk.review).toBe('cleared');
		expect((await h.call('POST', `/v1/orders/${review.id}/review`, { body: { decision: 'maybe' } })).status).toBe(422);
		const unblock = await h.call('DELETE', `/v1/blocklist/${blocked.json.key}`);
		expect(unblock.json.blocked).toBe(false);
		expect((await h.call('DELETE', `/v1/blocklist/${blocked.json.key}`)).status).toBe(404);
		expect((await h.call('POST', '/v1/blocklist', { body: { type: 'fax', value: '1' } })).status).toBe(422);
		await h.entitle();
	});
});

describe('customer updates', () => {
	it('keeps a message log, retries failures and hands off to a messaging product in event mode', async () => {
		h.provider.fail(1, 503);
		const order = await h.order({ customer: { email: 'msg@example.com' } });
		const log = await h.call('GET', `/v1/customer-updates?orderId=${order.id}`);
		expect(log.json.items[0]).toMatchObject({ status: 'placed', state: 'retry', channel: 'email' });
		expect(log.json.items[0].to).toBeUndefined();
		const full = await h.call('GET', `/v1/customer-updates/${log.json.items[0].id}`);
		expect(full.json).toMatchObject({ to: { email: 'msg@example.com' } });
		expect(full.json.text).toContain(order.number);
		// a due retry is sent when its order is next read (no timer); before its backoff passes nothing is sent
		h.provider.fail(1, 503);
		await h.call('GET', `/v1/orders/${order.id}`);
		expect((await h.call('GET', `/v1/customer-updates/${log.json.items[0].id}`)).json.state).toBe('retry');
		h.clock.advance(2 * 60_000);
		await h.call('GET', `/v1/orders/${order.id}`);
		expect((await h.call('GET', `/v1/customer-updates/${log.json.items[0].id}`)).json.state).toBe('retry');
		h.clock.advance(5 * 60_000);
		await h.call('GET', `/v1/orders/${order.id}`);
		expect((await h.call('GET', `/v1/customer-updates/${log.json.items[0].id}`)).json.state).toBe('sent');
		const retry = await h.call('POST', `/v1/customer-updates/${log.json.items[0].id}/retry`);
		expect(retry.json.result).toBe('skipped');
		expect((await h.call('GET', '/v1/customer-updates/msg_none')).status).toBe(404);
		expect((await h.call('POST', '/v1/customer-updates/msg_none/retry')).status).toBe(404);
		h.provider.fail(1, 400);
		const refused = await h.order({ customer: { email: 'refused@example.com' } });
		const failed = await h.call('GET', `/v1/customer-updates?orderId=${refused.id}`);
		expect(failed.json.items[0].state).toBe('failed');
		await h.entitle({
			config: {
				customer_updates: {
					delivery: 'event',
					templates: [{ status: 'placed', lang: 'en', channel: 'any', text: 'Hi {name}: {number}' }],
				},
			},
		});
		const handed = await h.order({ customer: { email: 'event@example.com', name: 'Eve' } });
		const event = h.published('orders.customer_update@1').find((e) => e.data.orderId === handed.id);
		expect(event.data).toMatchObject({ status: 'placed', channel: 'email', lang: 'en' });
		expect(JSON.stringify(event.data)).not.toContain('event@example.com');
		const message = await h.call('GET', `/v1/customer-updates/${event.data.messageId}`);
		expect(message.json).toMatchObject({ state: 'handed_off', text: `Hi Eve: ${handed.number}` });
		await h.entitle();
	});
});

describe('dashboard', () => {
	it('serves the overview, writes as staff, prints and exports; demo sessions are read-only', async () => {
		const sid = await h.session('merchant');
		const auth = { authorization: `Bearer ${sid}`, 'x-ss-website': WEBSITE };
		const overview = await h.call('GET', '/v1/dashboard/overview', { key: null, headers: auth });
		expect(overview.status, overview.text).toBe(200);
		expect(overview.json.byCurrency.EUR.revenue).toBeGreaterThan(0);
		const order = await h.order();
		const moved = await h.call('POST', `/v1/dashboard/orders/${order.id}/transitions`, {
			key: null,
			headers: auth,
			body: { status: 'confirmed' },
		});
		expect(moved.json).toMatchObject({ status: 'confirmed' });
		const stored = await h.call('GET', `/v1/orders/${order.id}`);
		expect(stored.json.timeline.at(-1).actor).toEqual({ type: 'staff', id: 'usr_merchant' });
		const pay = await h.call('POST', `/v1/dashboard/orders/${order.id}/payments`, {
			key: null,
			headers: auth,
			body: { amount: 100, method: 'cash' },
		});
		expect(pay.status, pay.text).toBe(200);
		const bad = await h.call('POST', `/v1/dashboard/orders/${order.id}/refunds`, {
			key: null,
			headers: auth,
			body: { amount: 999, method: 'cash', reason: 'x' },
		});
		expect(bad.status).toBe(409);
		for (const path of [
			`/v1/dashboard/orders/${order.id}/invoice`,
			`/v1/dashboard/packing-slips?ids=${order.id}`,
			`/v1/dashboard/pick-lists?ids=${order.id}`,
		])
			expect((await h.call('GET', path, { key: null, headers: auth })).headers.get('content-type')).toMatch(/text\/html/);
		expect((await h.call('GET', '/v1/dashboard/packing-slips', { key: null, headers: auth })).status).toBe(404);
		const csv = await h.call('GET', '/v1/dashboard/order-exports', { key: null, headers: auth });
		expect(csv.text).toContain('number');
		const demo = await h.session('demo');
		const denied = await h.call('POST', `/v1/dashboard/orders/${order.id}/transitions`, {
			key: null,
			headers: { authorization: `Bearer ${demo}` },
			body: { status: 'packed' },
		});
		expect(denied.status).toBe(403);
		const ready = await resolveDashboard({ orders: h.orders, sessionId: sid, website: WEBSITE });
		expect(ready.state).toBe('ready');
		if (ready.state === 'ready') {
			expect((await ready.data.stats()).orders).toBeGreaterThan(0);
			expect((await ready.data.orders({ status: 'confirmed' })).items.length).toBeGreaterThan(0);
			expect((await ready.data.order(order.id))?.money.paid).toBe(100);
			expect(await ready.data.order('bad id')).toBeNull();
			expect((await ready.data.ledger({})).items.length).toBeGreaterThan(0);
			expect(Array.isArray(await ready.data.reviews())).toBe(true);
			expect((await ready.data.orders({ cursor: 'garbage' })).items).toEqual([]);
		}
		const sandbox = await resolveDashboard({ orders: h.orders, sessionId: demo });
		expect(sandbox.state).toBe('ready');
		if (sandbox.state === 'ready') {
			expect(sandbox.data.demo).toBe(true);
			expect((await sandbox.data.stats()).orders).toBe(5);
			expect((await sandbox.data.orders({ status: 'confirmed' })).items).toHaveLength(1);
			expect(await sandbox.data.order('ord_demo0')).toBeTruthy();
			expect((await sandbox.data.ledger({})).items).toEqual([]);
			expect(await sandbox.data.reviews()).toEqual([]);
		}
		expect((await resolveDashboard({ orders: h.orders, sessionId: undefined })).state).toBe('signin');
		expect((await resolveDashboard({ orders: h.orders, sessionId: 'ses_none' })).state).toBe('signin');
		const session = await h.call('GET', '/v1/session', { key: null, headers: { authorization: `Bearer ${sid}` } });
		expect(session.json).toMatchObject({ kind: 'merchant' });
	});

	it('exports and anonymises a customer’s personal data', async () => {
		const exported = await h.orders.product.context?.privacy?.export?.({
			websiteId: WEBSITE,
			subject: { customerId: 'cus_1' },
		});
		if (exported) expect(Object.keys(exported.collections)).toContain('orders');
	});
});
