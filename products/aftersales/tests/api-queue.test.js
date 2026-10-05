/** Mode C: the staff queue, refunds to the ledger, restock exactly once, serials, messages, dashboard and gating. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEBSITE, createHarness } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;

beforeAll(async () => {
	h = await createHarness({ config: { messages: { staff_recipients: ['staff@example.com'] } } });
}, 60_000);

afterAll(async () => {
	await h?.close();
});

/** A delivered order and a return claim of it by its customer. @param {string} subject @param {number} [quantity] */
const claimFor = async (subject, quantity = 2) => {
	const { orderId, purchaseId } = await h.order({ subject, email: `${subject}@example.com` });
	const claim = await h.call('POST', '/v1/claims', {
		as: subject,
		body: { purchaseId, type: 'return', reason: 'defective', details: 'Broken.', lines: [{ lineId: 'itm_1:var_1', quantity }] },
	});
	expect(claim.status).toBe(201);
	return { orderId, purchaseId, claimId: /** @type {string} */ (claim.json.id) };
};

describe('queue', () => {
	it('moves claims along the transitions, with history, notes, assignment and events', async () => {
		const { claimId } = await claimFor('cus_q1');
		expect(h.providers.messages.some((m) => m.body.to === 'staff@example.com')).toBe(true);
		const queue = await h.call('GET', '/v1/queue?filter[status]=requested');
		expect(queue.status).toBe(200);
		expect(queue.json.counts.byKind.open).toBeGreaterThanOrEqual(1);
		expect(queue.json.items[0]).toMatchObject({ id: claimId, nextStatuses: ['approved', 'rejected'], overdue: false });
		expect((await h.call('GET', '/v1/queue', { browser: true })).status).toBe(403);
		const invalid = await h.call('POST', `/v1/queue/${claimId}/transition`, { body: { to: 'refunded' } });
		expect(invalid.status).toBe(409);
		expect((await h.call('POST', `/v1/queue/${claimId}/transition`, { body: {} })).status).toBe(422);
		expect((await h.call('POST', '/v1/queue/clm_none/transition', { body: { to: 'approved' } })).status).toBe(404);
		const sent = h.providers.messages.length;
		const approved = await h.call('POST', `/v1/queue/${claimId}/transition`, {
			body: { to: 'approved', note: 'Ship it back.' },
		});
		expect(approved.status).toBe(200);
		expect(approved.json).toMatchObject({ status: 'approved', dueAt: null });
		expect(approved.json.history.at(-1)).toMatchObject({
			from: 'requested',
			to: 'approved',
			note: 'Ship it back.',
			actor: { type: 'api' },
		});
		expect(h.providers.messages.length).toBe(sent + 1);
		expect(h.providers.messages.at(-1)?.body).toMatchObject({ channel: 'email', to: 'cus_q1@example.com' });
		const same = await h.call('POST', `/v1/queue/${claimId}/transition`, { body: { to: 'approved' } });
		expect(same.json.history).toHaveLength(2);
		const events = await h.published('aftersales.claim_status_changed@1');
		expect(events.at(-1).data).toMatchObject({ claimId, from: 'requested', to: 'approved', kind: 'open' });
		const note = await h.call('POST', `/v1/queue/${claimId}/notes`, {
			body: { body: 'Called them.' },
			idempotencyKey: 'note-1',
		});
		expect(note.status).toBe(201);
		const replay = await h.call('POST', `/v1/queue/${claimId}/notes`, {
			body: { body: 'Called them.' },
			idempotencyKey: 'note-1',
		});
		expect(replay.json.notes).toHaveLength(1);
		expect((await h.call('POST', `/v1/queue/${claimId}/notes`, { body: { body: '' } })).status).toBe(422);
		expect((await h.call('POST', '/v1/queue/clm_none/notes', { body: { body: 'x' } })).status).toBe(404);
		const assigned = await h.call('POST', `/v1/queue/${claimId}/assign`, { body: { assignee: 'stf_7' } });
		expect(assigned.json.assignee).toBe('stf_7');
		expect((await h.call('GET', '/v1/queue?filter[assignee]=stf_7')).json.items).toHaveLength(1);
		expect((await h.call('POST', `/v1/queue/${claimId}/assign`, { body: { assignee: null } })).json.assignee).toBeNull();
		expect((await h.call('POST', `/v1/queue/${claimId}/assign`, { body: { assignee: 5 } })).status).toBe(422);
		expect((await h.call('POST', '/v1/queue/clm_none/assign', { body: { assignee: 'x' } })).status).toBe(404);
		// the customer sees the new status but not the note or the assignee
		const customer = await h.call('GET', `/v1/claims/${claimId}`, { as: 'cus_q1' });
		expect(customer.json).toMatchObject({ status: 'approved', statusLabel: 'Approved' });
		expect(customer.json.notes).toBeUndefined();
		expect(customer.json.assignee).toBeUndefined();
	});

	it('releases rejected units for a new claim and caps notes', async () => {
		await h.entitle({ config: { queue: { max_notes_per_claim: 1 } } });
		const { purchaseId, claimId } = await claimFor('cus_q2');
		await h.call('POST', `/v1/queue/${claimId}/notes`, { body: { body: 'one' } });
		expect((await h.call('POST', `/v1/queue/${claimId}/notes`, { body: { body: 'two' } })).status).toBe(409);
		const rejected = await h.call('POST', `/v1/queue/${claimId}/transition`, { body: { to: 'rejected' } });
		expect(rejected.json).toMatchObject({ released: true, kind: 'rejected' });
		expect(rejected.json.resolvedAt).toBeTruthy();
		const closed = await h.call('POST', `/v1/queue/${claimId}/transition`, { body: { to: 'closed' } });
		expect(closed.json.closedAt).toBeTruthy();
		const view = await h.call('GET', `/v1/purchases/${purchaseId}`);
		expect(view.json.lines[0].claimable).toBe(2);
		await h.entitle({ config: { messages: { staff_recipients: ['staff@example.com'] } } });
	});
});

describe('refunds', () => {
	it('records capped refunds once, publishes order.refunded@1 and moves to the status after a full refund', async () => {
		const { orderId, claimId } = await claimFor('cus_r1');
		const body = { claimId, amount: 2000, method: 'bank_transfer', reference: 'TX-1' };
		expect((await h.call('POST', '/v1/refunds', { body })).status).toBe(409);
		await h.call('POST', `/v1/queue/${claimId}/transition`, { body: { to: 'approved' } });
		await h.call('POST', `/v1/queue/${claimId}/transition`, { body: { to: 'received' } });
		expect((await h.call('POST', '/v1/refunds', { body: { ...body, amount: 6000 } })).json.type).toMatch(/refund_exceeds$/);
		expect((await h.call('POST', '/v1/refunds', { body: { ...body, method: 'gold' } })).json.errors[0].code).toBe(
			'method_invalid',
		);
		expect((await h.call('POST', '/v1/refunds', { body: { ...body, claimId: 'clm_none' } })).status).toBe(404);
		expect((await h.call('POST', '/v1/refunds', { body: { claimId, amount: 0 } })).status).toBe(422);
		const first = await h.call('POST', '/v1/refunds', { body, idempotencyKey: 'refund-1' });
		expect(first.status).toBe(201);
		expect(first.json.refund).toMatchObject({ amount: 2000, currency: 'USD', method: 'bank_transfer', reference: 'TX-1' });
		expect(first.json.claim).toMatchObject({ refundedAmount: 2000, status: 'received' });
		const again = await h.call('POST', '/v1/refunds', { body, idempotencyKey: 'refund-1' });
		expect(again.json.refund.id).toBe(first.json.refund.id);
		const ledger = (await h.published('order.refunded@1')).at(-1);
		expect(ledger.data).toMatchObject({ orderId, amount: { amount: 2000, currency: 'USD' }, customerId: 'cus_r1' });
		expect(ledger.data.reason).toContain('TX-1');
		expect(ledger.data.lines[0]).toMatchObject({ itemId: 'itm_1', quantity: 2, unitAmount: 2500, totalAmount: 5000 });
		const rest = await h.call('POST', '/v1/refunds', { body: { ...body, amount: 3000 } });
		expect(rest.json.claim).toMatchObject({ refundedAmount: 5000, status: 'refunded', kind: 'resolved' });
		const list = await h.call('GET', `/v1/refunds?filter[claimId]=${claimId}`);
		expect(list.json.items).toHaveLength(2);
		expect((await h.call('GET', '/v1/refunds')).json.items.length).toBeGreaterThanOrEqual(2);
		const purchase = await h.collection('purchases').findOne({ websiteId: WEBSITE, orderId });
		expect(purchase?.refundedAmount).toBe(5000);
	});

	it('honours methods needing a reference, no partial refunds and non-refundable types', async () => {
		await h.entitle({
			config: {
				refunds: {
					methods: [{ key: 'card', label: 'Card', reference_required: true }],
					allow_partial: false,
					publish_event: false,
					allowed_statuses: ['requested'],
				},
				claims: {
					types: [
						{ key: 'return', label: 'Return', window_days: 30 },
						{ key: 'exchange', label: 'Exchange', window_days: 30, refundable: false },
					],
				},
			},
		});
		const { claimId } = await claimFor('cus_r2', 1);
		expect((await h.call('POST', '/v1/refunds', { body: { claimId, amount: 2500, method: 'card' } })).json.errors[0].code).toBe(
			'required',
		);
		expect(
			(await h.call('POST', '/v1/refunds', { body: { claimId, amount: 100, method: 'card', reference: 'x' } })).json.errors[0]
				.code,
		).toBe('partial_not_allowed');
		const done = await h.call('POST', '/v1/refunds', {
			body: { claimId, amount: 2500, method: 'card', reference: 'x', note: 'ok' },
		});
		expect(done.json.refund.eventId).toBeNull();
		const { purchaseId } = await h.order({ subject: 'cus_r3' });
		const exchange = await h.call('POST', '/v1/claims', {
			as: 'cus_r3',
			body: { purchaseId, type: 'exchange', reason: 'wrong_item', lines: [{ lineId: 'itm_1:var_1', quantity: 1 }] },
		});
		expect(
			(await h.call('POST', '/v1/refunds', { body: { claimId: exchange.json.id, amount: 1, method: 'card', reference: 'x' } }))
				.status,
		).toBe(409);
		await h.entitle({ config: { messages: { staff_recipients: ['staff@example.com'] } } });
	});
});

describe('restock', () => {
	it('restocks each line once, only once received, publishing inventory.changed@1 from the known level', async () => {
		const { claimId } = await claimFor('cus_s1');
		const body = { claimId, lines: [{ lineId: 'itm_1:var_1', restock: true }] };
		expect((await h.call('POST', '/v1/restocks', { body })).json.type).toMatch(/restock_not_allowed$/);
		await h.call('POST', `/v1/queue/${claimId}/transition`, { body: { to: 'approved' } });
		await h.call('POST', `/v1/queue/${claimId}/transition`, { body: { to: 'received' } });
		await h.deliver('inventory.changed@1', { itemId: 'itm_1', variantId: 'var_1', quantity: 3, available: 1 });
		expect(
			(await h.call('POST', '/v1/restocks', { body: { claimId, lines: [{ lineId: 'zzz', restock: true }] } })).status,
		).toBe(422);
		expect((await h.call('POST', '/v1/restocks', { body: { claimId, lines: [] } })).status).toBe(422);
		expect((await h.call('POST', '/v1/restocks', { body: { ...body, claimId: 'clm_none' } })).status).toBe(404);
		const done = await h.call('POST', '/v1/restocks', { body });
		expect(done.status).toBe(200);
		expect(done.json.results).toEqual([{ lineId: 'itm_1:var_1', applied: true, restock: true, stock: 'published' }]);
		expect(done.json.claim.lines[0].restock).toBe(true);
		const event = (await h.published('inventory.changed@1')).at(-1);
		expect(event.data).toMatchObject({
			itemId: 'itm_1',
			variantId: 'var_1',
			quantity: 5,
			previousQuantity: 3,
			available: 3,
			reason: 'returned',
		});
		const twice = await h.call('POST', '/v1/restocks', { body });
		expect(twice.json.results[0]).toMatchObject({ applied: false, reason: 'already_decided' });
		const list = await h.call('GET', `/v1/restocks?filter[claimId]=${claimId}`);
		expect(list.json.items[0]).toMatchObject({ restock: true, stock: 'published', quantity: 2 });
		expect((await h.call('GET', '/v1/restocks')).status).toBe(200);
	});

	it('records restock without a known level, refuses restock, and supports record-only', async () => {
		const { purchaseId } = await h.order({
			subject: 'cus_s2',
			lines: [
				{ itemId: 'itm_new', quantity: 1, unitAmount: 100 },
				{ itemId: 'itm_b', quantity: 1, unitAmount: 100 },
			],
		});
		const claim = await h.call('POST', '/v1/claims', {
			as: 'cus_s2',
			body: {
				purchaseId,
				type: 'return',
				reason: 'defective',
				lines: [
					{ lineId: 'itm_new', quantity: 1 },
					{ lineId: 'itm_b', quantity: 1 },
				],
			},
		});
		const claimId = claim.json.id;
		await h.call('POST', `/v1/queue/${claimId}/transition`, { body: { to: 'approved' } });
		await h.call('POST', `/v1/queue/${claimId}/transition`, { body: { to: 'received' } });
		const result = await h.call('POST', '/v1/restocks', {
			body: {
				claimId,
				lines: [
					{ lineId: 'itm_new', restock: true },
					{ lineId: 'itm_b', restock: false },
				],
			},
		});
		expect(result.json.results).toEqual([
			{ lineId: 'itm_new', applied: true, restock: true, stock: 'unknown_level' },
			{ lineId: 'itm_b', applied: true, restock: false, stock: 'not_restocked' },
		]);
		await h.entitle({ config: { restock: { target: 'record' }, messages: { staff_recipients: ['staff@example.com'] } } });
		const other = await claimFor('cus_s3');
		await h.call('POST', `/v1/queue/${other.claimId}/transition`, { body: { to: 'approved' } });
		await h.call('POST', `/v1/queue/${other.claimId}/transition`, { body: { to: 'received' } });
		const recorded = await h.call('POST', '/v1/restocks', {
			body: { claimId: other.claimId, lines: [{ lineId: 'itm_1:var_1', restock: true }] },
		});
		expect(recorded.json.results[0].stock).toBe('recorded');
		await h.entitle({ config: { messages: { staff_recipients: ['staff@example.com'] } } });
	});
});

describe('serial registry', () => {
	it('registers, lists and looks units up for staff and the public', async () => {
		const { orderId, purchaseId } = await h.order({
			subject: 'cus_sr',
			lines: [{ itemId: 'itm_w', quantity: 1, unitAmount: 100 }],
		});
		const made = await h.call('POST', '/v1/serials', {
			body: { serial: 'imei 3567', itemId: 'itm_w', orderId, soldAt: '2026-09-01T00:00:00Z' },
		});
		expect(made.status).toBe(201);
		expect(made.json).toMatchObject({ key: 'IMEI3567', purchaseId, lineId: 'itm_w', title: null });
		expect((await h.call('POST', '/v1/serials', { body: { serial: 'x', itemId: 'itm_w' } })).json.errors[0].code).toBe(
			'serial_invalid',
		);
		expect(
			(await h.call('POST', '/v1/serials', { body: { serial: 'ABCDE', itemId: 'itm_w', purchaseId: 'pur_none' } })).status,
		).toBe(404);
		expect(
			(await h.call('POST', '/v1/serials', { body: { serial: 'LOOSE-1', itemId: 'itm_w', title: 'Loose unit' } })).status,
		).toBe(201);
		expect((await h.call('POST', '/v1/serials', { body: {} })).status).toBe(422);
		const listed = await h.call('GET', `/v1/serials?filter[orderId]=${orderId}`);
		expect(listed.json.items).toHaveLength(1);
		expect((await h.call('GET', '/v1/serials?filter[itemId]=itm_w')).json.items.length).toBe(2);
		expect((await h.call('GET', '/v1/serials', { browser: true })).status).toBe(403);
		const owner = await h.call('GET', '/v1/serials/IMEI-3567');
		expect(owner.json).toMatchObject({ orderId, purchaseId, claims: [] });
		expect(owner.json.cover.find((/** @type {any} */ c) => c.type === 'return')).toMatchObject({ active: true });
		const loose = await h.call('GET', '/v1/serials/LOOSE1', { browser: true });
		expect(loose.json).toMatchObject({ title: 'Loose unit' });
		expect((await h.call('GET', '/v1/serials/NOPE-404')).status).toBe(404);
		expect((await h.call('GET', '/v1/serials/x')).status).toBe(404);
		const view = await h.call('GET', '/v1/elements/serial_registry/view', { browser: true });
		expect(view.json.actions[0].action).toBe('lookup');
		const action = await h.call('POST', '/v1/elements/serial_registry/actions/lookup', {
			browser: true,
			body: { fields: { serial: 'imei3567' } },
		});
		expect(action.json.items.length).toBeGreaterThan(0);
		expect(action.json.body).toContain('2026-09-01');
		const missing = await h.call('POST', '/v1/elements/serial_registry/actions/lookup', {
			browser: true,
			body: { fields: { serial: 'NOPE-404' } },
		});
		expect(missing.json.body).toBe('We could not find this serial number.');
		expect(
			(await h.call('POST', '/v1/elements/serial_registry/actions/lookup', { browser: true, body: { fields: {} } })).status,
		).toBe(422);
		await h.entitle({ config: { serial_registry: { public_lookup: false, show_sale_date: false } } });
		expect((await h.call('GET', '/v1/serials/IMEI3567', { browser: true })).status).toBe(403);
		expect(
			(
				await h.call('POST', '/v1/elements/serial_registry/actions/lookup', {
					browser: true,
					body: { fields: { serial: 'IMEI3567' } },
				})
			).status,
		).toBe(403);
		await h.entitle({
			config: { serial_registry: { show_sale_date: false }, messages: { staff_recipients: ['staff@example.com'] } },
		});
		expect((await h.call('GET', '/v1/serials/IMEI3567', { browser: true })).json.soldAt).toBeNull();
		await h.entitle({ config: { messages: { staff_recipients: ['staff@example.com'] } } });
	});
});

describe('messages', () => {
	it('lets customer and staff talk on a claim and notifies the other side', async () => {
		const { claimId } = await claimFor('cus_m1');
		const sent = h.providers.messages.length;
		const fromCustomer = await h.call('POST', '/v1/messages', {
			as: 'cus_m1',
			body: { claimId, body: 'Any news?' },
			idempotencyKey: 'msg-1',
		});
		expect(fromCustomer.status).toBe(201);
		expect(fromCustomer.json).toMatchObject({ author: 'customer', body: 'Any news?' });
		expect(fromCustomer.json.actor).toBeUndefined();
		expect(h.providers.messages.length).toBe(sent + 1);
		expect(
			(await h.call('POST', '/v1/messages', { as: 'cus_m1', body: { claimId, body: 'Any news?' }, idempotencyKey: 'msg-1' }))
				.json.id,
		).toBe(fromCustomer.json.id);
		h.clock.advance(1000);
		const fromStaff = await h.call('POST', '/v1/messages', { body: { claimId, body: 'Picked up tomorrow.' } });
		expect(fromStaff.json).toMatchObject({ author: 'staff', notified: true });
		const thread = await h.call('GET', `/v1/messages?filter[claimId]=${claimId}`, { as: 'cus_m1' });
		expect(thread.json.items.map((/** @type {any} */ m) => m.author)).toEqual(['customer', 'staff']);
		expect((await h.call('GET', `/v1/messages?filter[claimId]=${claimId}`)).json.items[1].actor).toMatchObject({ type: 'api' });
		expect((await h.call('GET', `/v1/messages?filter[claimId]=${claimId}`, { as: 'cus_x' })).status).toBe(404);
		expect((await h.call('GET', '/v1/messages', { as: 'cus_m1' })).status).toBe(422);
		expect((await h.call('GET', '/v1/messages', { browser: true })).status).toBe(401);
		expect((await h.call('POST', '/v1/messages', { browser: true, body: { claimId, body: 'x' } })).status).toBe(401);
		expect(
			(await h.call('POST', '/v1/messages', { browser: true, body: { claimId, body: 'x', token: 'ct1.a.b' } })).status,
		).toBe(401);
		expect((await h.call('POST', '/v1/messages', { as: 'cus_m1', body: { claimId, body: '' } })).status).toBe(422);
		expect((await h.call('POST', '/v1/messages', { as: 'cus_x', body: { claimId, body: 'hi' } })).status).toBe(404);
		h.providers.failMessaging(true);
		expect((await h.call('POST', '/v1/messages', { body: { claimId, body: 'Lost?' } })).json.notified).toBe(false);
		h.providers.failMessaging(false);
		await h.entitle({
			config: {
				messages: { customer_can_message: false, max_messages_per_claim: 4, notify_customer: false, channels: ['sms'] },
			},
		});
		expect((await h.call('POST', '/v1/messages', { as: 'cus_m1', body: { claimId, body: 'hi' } })).status).toBe(403);
		expect((await h.call('POST', '/v1/messages', { body: { claimId, body: 'four' } })).json.notified).toBe(false);
		expect((await h.call('POST', '/v1/messages', { body: { claimId, body: 'five' } })).status).toBe(409);
		await h.entitle({ config: { messages: { staff_recipients: ['staff@example.com'] } } });
	});

	it('serves guests their conversation through the claim token', async () => {
		const { number, purchaseId } = await h.order({ subject: 'cus_m2', email: 'm2@example.com' });
		const { token } = (await h.call('POST', '/v1/claim-access', { browser: true, body: { number, email: 'm2@example.com' } }))
			.json;
		const claim = await h.call('POST', '/v1/claims', {
			browser: true,
			body: { token, purchaseId, type: 'return', reason: 'defective', lines: [{ lineId: 'itm_1:var_1', quantity: 1 }] },
		});
		expect(
			(await h.call('POST', '/v1/messages', { browser: true, body: { token, claimId: claim.json.id, body: 'Hello' } })).status,
		).toBe(201);
		const view = await h.call('POST', '/v1/claims:view', { browser: true, body: { token, claimId: claim.json.id } });
		expect(view.json.messages.map((/** @type {any} */ m) => m.body)).toEqual(['Hello']);
	});
});

describe('gating, stub views and the dashboard API', () => {
	it('answers 403 for disabled elements and serves the claims stub view', async () => {
		await h.entitle({ elements: { refunds: false, queue: false } });
		expect((await h.call('GET', '/v1/refunds')).status).toBe(403);
		expect((await h.call('GET', '/v1/queue')).status).toBe(403);
		await h.entitle({ config: { messages: { staff_recipients: ['staff@example.com'] } } });
		await claimFor('cus_v1');
		const signedIn = await h.call('GET', '/v1/elements/claims/view', { as: 'cus_v1' });
		expect(signedIn.json.items[0].text).toContain('Return for a refund');
		expect((await h.call('GET', '/v1/elements/claims/view', { as: 'cus_nobody' })).json.body).toBe('You have no claims yet.');
		expect((await h.call('GET', '/v1/elements/claims/view', { browser: true })).json.body).toContain('Sign in');
	});

	it('runs staff actions from a dashboard session (audited actor) and refuses demo sessions', async () => {
		const { claimId } = await claimFor('cus_d1');
		const session = await h.session('merchant');
		/** @param {string} action @param {unknown} body @param {string} [ses] */
		const dash = (action, body, ses = session) =>
			h.call('POST', `/v1/dashboard/claims/${claimId}/${action}`, { key: ses, body, headers: { 'x-ss-website': WEBSITE } });
		const overview = await h.call('GET', '/v1/dashboard/overview', { key: session, headers: { 'x-ss-website': WEBSITE } });
		expect(overview.json.byKind.open).toBeGreaterThan(0);
		expect((await dash('transition', { to: 'approved' })).json.history.at(-1).actor).toMatchObject({
			type: 'merchant',
			id: 'usr_merchant',
		});
		expect((await dash('notes', { body: 'From the dashboard' })).status).toBe(201);
		expect((await dash('assign', { assignee: 'me' })).json.assignee).toBe('me');
		expect((await dash('transition', { to: 'received' })).status).toBe(200);
		expect((await dash('restocks', { lines: [{ lineId: 'itm_1:var_1', restock: false }] })).status).toBe(200);
		expect((await dash('refunds', { amount: 1000, method: 'cash' })).status).toBe(201);
		expect((await dash('messages', { body: 'Refunded in part.' })).json.author).toBe('staff');
		const demo = await h.session('demo');
		expect((await dash('notes', { body: 'x' }, demo)).status).toBe(403);
		const demoOverview = await h.call('GET', '/v1/dashboard/overview', { key: demo });
		expect(demoOverview.status).toBe(400);
	});
});
