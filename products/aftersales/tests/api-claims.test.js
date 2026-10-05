/** Mode C: purchases from order events and the API, eligibility windows, customer and guest claims, photos. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY, WEBSITE, WEBSITE_2, createHarness } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;

beforeAll(async () => {
	h = await createHarness();
}, 60_000);

afterAll(async () => {
	await h?.close();
});

describe('purchases from order events', () => {
	it('builds a purchase from order.placed@1 and opens the windows on order.completed@1', async () => {
		const { orderId, purchaseId } = await h.order({ complete: false });
		const placed = await h.call('GET', `/v1/purchases/${purchaseId}`);
		expect(placed.status).toBe(200);
		expect(placed.json).toMatchObject({ orderId, status: 'placed', deliveredAt: null, canClaim: false });
		expect(placed.json.lines[0].windows.return).toMatchObject({ eligible: false, reason: 'not_delivered' });
		await h.deliver('order.completed@1', { orderId });
		const delivered = await h.call('GET', `/v1/purchases/${purchaseId}`);
		expect(delivered.json).toMatchObject({ status: 'delivered', canClaim: true, customer: { customerId: 'cus_ada' } });
		expect(delivered.json.lines[0]).toMatchObject({ lineId: 'itm_1:var_1', claimable: 2, unitAmount: 2500 });
		expect(delivered.json.lines[0].windows.return).toMatchObject({ eligible: true, days: 14, source: 'type' });
		// warranty: no snapshot, no grade → 0 days
		expect(delivered.json.lines[0].windows.warranty).toMatchObject({ eligible: false, reason: 'no_window' });
	});

	it('ignores events without a purchase to enrich, cancels, and applies outside refunds once', async () => {
		expect((await h.deliver('order.paid@1', { orderId: 'ord_unknown', amount: { amount: 1, currency: 'USD' } })).status).toBe(
			200,
		);
		expect(await h.collection('purchases').findOne({ websiteId: WEBSITE, orderId: 'ord_unknown' })).toBeNull();
		const { orderId, purchaseId } = await h.order();
		const refund = await h.deliver('order.refunded@1', {
			orderId,
			amount: { amount: 2500, currency: 'USD' },
			lines: [{ itemId: 'itm_1', variantId: 'var_1', quantity: 1 }],
		});
		await h.deliver(
			'order.refunded@1',
			{ orderId, amount: { amount: 2500, currency: 'USD' }, lines: [{ itemId: 'itm_1', variantId: 'var_1', quantity: 1 }] },
			{ id: refund.id },
		);
		// our own refund events are skipped
		await h.deliver(
			'order.refunded@1',
			{ orderId, amount: { amount: 2500, currency: 'USD' }, lines: [{ itemId: 'itm_1', variantId: 'var_1', quantity: 1 }] },
			{ context: { source: 'product', product: 'aftersales' } },
		);
		await h.deliver('order.refunded@1', { orderId: 'ord_none', amount: { amount: 1, currency: 'USD' } });
		let view = await h.call('GET', `/v1/purchases/${purchaseId}`);
		expect(view.json.lines[0]).toMatchObject({ claimable: 1, refundedQuantity: 1 });
		await h.deliver('order.cancelled@1', { orderId });
		view = await h.call('GET', `/v1/purchases/${purchaseId}`);
		expect(view.json).toMatchObject({ status: 'cancelled', canClaim: false });
		expect(view.json.lines[0].windows.return.reason).toBe('cancelled');
	});

	it('registers serials from Orders product events and enriches through the wildcard', async () => {
		const { orderId } = await h.order();
		await h.deliver('orders.serials_recorded@1', {
			orderId,
			serials: [{ serial: 'sn-0001-aa', itemId: 'itm_1', variantId: 'var_1' }],
		});
		await h.deliver('orders.note_added@1', { orderId });
		await h.deliver('order.shipped@1', { orderId: 'ord_ghost' });
		await h.deliver('custom.thing@1', { orderId });
		const lookup = await h.call('GET', '/v1/serials/SN0001AA');
		expect(lookup.status).toBe(200);
		expect(lookup.json).toMatchObject({ orderId, itemId: 'itm_1', lineId: 'itm_1:var_1', source: 'event' });
		const pub = await h.call('GET', '/v1/serials/sn-0001-aa', { browser: true });
		expect(pub.json).toMatchObject({ serial: 'sn-0001-aa', title: 'Phone case' });
		expect(pub.json.orderId).toBeUndefined();
	});

	it('reads Grades tiers for grade windows and stock levels from inventory.changed@1', async () => {
		await h.entitle({ config: { claims: { grade_windows: [{ grade: 'excellent', type: 'warranty', days: 180 }] } } });
		await h.deliver('grades.tier_assigned@1', { itemId: 'itm_g', tier: 'excellent', source: 'api' });
		await h.deliver('grades.tier_assigned@1', { itemId: 'itm_g', unitId: 'unt_1', tier: 'good', source: 'api' });
		const { purchaseId } = await h.order({ lines: [{ itemId: 'itm_g', quantity: 1, unitAmount: 900 }] });
		const view = await h.call('GET', `/v1/purchases/${purchaseId}`);
		expect(view.json.lines[0]).toMatchObject({ grade: 'excellent' });
		expect(view.json.lines[0].windows.warranty).toMatchObject({ eligible: true, days: 180, source: 'grade' });
		await h.deliver('grades.tier_assigned@1', { itemId: 'itm_g', tier: null, source: 'api' });
		const after = await h.call('GET', `/v1/purchases/${purchaseId}`);
		expect(after.json.lines[0].grade).toBeNull();
		await h.deliver('inventory.changed@1', { itemId: 'itm_1', variantId: 'var_1', quantity: 7, available: 5 });
		await h.deliver('inventory.changed@1', { itemId: 'itm_1', quantity: 'x' });
		expect(await h.collection('stock').findOne({ websiteId: WEBSITE, itemId: 'itm_1', variant: 'var_1' })).toMatchObject({
			quantity: 7,
			available: 5,
		});
		await h.entitle();
	});

	it('ignores websites without claims or the serial registry', async () => {
		await h.entitle({ websiteId: WEBSITE_2, elements: { claims: false, serial_registry: false } });
		expect(
			(
				await h.deliver(
					'order.placed@1',
					{
						orderId: 'ord_w2',
						currency: 'USD',
						lines: [{ itemId: 'i', quantity: 1, unitAmount: 1 }],
						amounts: { subtotal: 1, total: 1 },
					},
					{ websiteId: WEBSITE_2 },
				)
			).status,
		).toBe(200);
		expect(await h.collection('purchases').findOne({ websiteId: WEBSITE_2 })).toBeNull();
	});
});

describe('purchases API', () => {
	it('registers purchases with and without an order id, paginated', async () => {
		const body = {
			reference: 'BOOK-1',
			customer: { customerId: 'cus_api', email: 'API@example.com', phone: '+44 20 7946 0000', name: 'Api' },
			currency: 'EUR',
			lines: [
				{
					itemId: 'svc_1',
					title: 'Cleaning',
					quantity: 1,
					unitAmount: 4000,
					itemType: 'service',
					warrantyDays: 30,
					serials: ['ABCD-1'],
				},
				{ itemId: 'svc_1', quantity: 1 },
			],
		};
		const first = await h.call('POST', '/v1/purchases', { body, idempotencyKey: 'pur-1' });
		expect(first.status).toBe(201);
		expect(first.json).toMatchObject({
			reference: 'BOOK-1',
			status: 'delivered',
			source: 'api',
			customer: { email: 'api@example.com', phone: '+442079460000' },
		});
		expect(first.json.lines).toHaveLength(1);
		expect(first.json.lines[0]).toMatchObject({ quantity: 2, itemType: 'service' });
		const second = await h.call('POST', '/v1/purchases', { body: { ...body, deliveredAt: null }, idempotencyKey: 'pur-2' });
		expect(second.json.status).toBe('placed');
		const withOrder = {
			orderId: 'ord_api_1',
			number: 'A-1',
			reference: 'R',
			total: 9000,
			lines: [{ itemId: 'itm_9', quantity: 1 }],
			deliveredAt: '2026-09-30T10:00:00Z',
		};
		expect((await h.call('POST', '/v1/purchases', { body: withOrder })).status).toBe(201);
		const again = await h.call('POST', '/v1/purchases', { body: withOrder });
		expect(again.status).toBe(200);
		expect(again.json).toMatchObject({ orderId: 'ord_api_1', reference: 'R', total: 9000 });
		const page = await h.call('GET', '/v1/purchases?limit=1');
		expect(page.json.items).toHaveLength(1);
		expect(page.json.nextCursor).toBeTruthy();
		const next = await h.call('GET', `/v1/purchases?limit=1&cursor=${encodeURIComponent(page.json.nextCursor)}`);
		expect(next.json.items[0].id).not.toBe(page.json.items[0].id);
		const filtered = await h.call('GET', '/v1/purchases?filter[orderId]=ord_api_1');
		expect(filtered.json.items).toHaveLength(1);
		const byCustomer = await h.call('GET', '/v1/purchases?filter[customerId]=cus_api');
		expect(byCustomer.json.items.length).toBeGreaterThanOrEqual(2);
	});

	it('validates purchase input', async () => {
		const bad = await h.call('POST', '/v1/purchases', {
			body: {
				orderId: 'bad id',
				customer: { email: 'nope', phone: '123', customerId: '' },
				currency: 'usd',
				total: -1,
				placedAt: 'yesterday',
				lines: [{ itemId: 'i', quantity: 0, unitAmount: 1.5, itemType: 'X', warrantyDays: -1, serials: [1] }, 'x'],
			},
		});
		expect(bad.status).toBe(422);
		const paths = bad.json.errors.map((/** @type {any} */ e) => e.path);
		expect(paths).toEqual(
			expect.arrayContaining([
				'/orderId',
				'/customer/email',
				'/customer/phone',
				'/currency',
				'/total',
				'/placedAt',
				'/lines/0/quantity',
				'/lines/1',
			]),
		);
		expect((await h.call('POST', '/v1/purchases', { body: { lines: [] } })).status).toBe(422);
		expect((await h.call('POST', '/v1/purchases', { body: [] })).status).toBe(422);
		expect(
			(await h.call('POST', '/v1/purchases', { body: { customer: 'x', lines: [{ itemId: 'i', quantity: 1, serials: 'x' }] } }))
				.status,
		).toBe(422);
	});
});

describe('customer claims (SS-Identity)', () => {
	it('lets the signed-in customer see only their purchases and claim within the window', async () => {
		const { purchaseId } = await h.order({ subject: 'cus_bea', email: 'bea@example.com' });
		await h.order({ subject: 'cus_other', email: 'o@example.com' });
		const mine = await h.call('GET', '/v1/purchases', { as: 'cus_bea' });
		expect(mine.status).toBe(200);
		expect(mine.json.items.map((/** @type {any} */ p) => p.id)).toEqual([purchaseId]);
		expect(mine.json.items[0].customer).toBeUndefined();
		expect((await h.call('GET', '/v1/purchases', { browser: true })).status).toBe(401);
		expect((await h.call('GET', `/v1/purchases/${purchaseId}`, { as: 'cus_other' })).status).toBe(404);
		expect((await h.call('GET', `/v1/purchases/${purchaseId}`, { as: 'cus_bea' })).status).toBe(200);
		const form = await h.call('GET', '/v1/claim-form', { browser: true });
		expect(form.status).toBe(200);
		expect(form.headers.get('cache-control')).toContain('public');
		expect(form.json.types.map((/** @type {any} */ t) => t.key)).toEqual(['return', 'exchange', 'warranty']);
		const created = await h.call('POST', '/v1/claims', {
			as: 'cus_bea',
			body: { purchaseId, type: 'return', reason: 'changed_mind', lines: [{ lineId: 'itm_1:var_1', quantity: 1 }] },
		});
		expect(created.status).toBe(201);
		expect(created.json).toMatchObject({ type: 'return', status: 'requested', statusLabel: 'Requested', kind: 'open' });
		expect(created.json.notes).toBeUndefined();
		const list = await h.call('GET', '/v1/claims', { as: 'cus_bea' });
		expect(list.json.items).toHaveLength(1);
		expect((await h.call('GET', '/v1/claims', { as: 'cus_other' })).json.items).toHaveLength(0);
		expect((await h.call('GET', `/v1/claims/${created.json.id}`, { as: 'cus_other' })).status).toBe(404);
		expect((await h.call('GET', `/v1/claims/${created.json.id}`, { as: 'cus_bea' })).json.id).toBe(created.json.id);
		expect((await h.call('GET', `/v1/claims/${created.json.id}`)).json.nextStatuses).toEqual(['approved', 'rejected']);
		// one unit left; asking for two is refused, the window closes after 14 days
		const tooMany = await h.call('POST', '/v1/claims', {
			as: 'cus_bea',
			body: { purchaseId, type: 'return', reason: 'changed_mind', lines: [{ lineId: 'itm_1:var_1', quantity: 2 }] },
		});
		expect(tooMany.status).toBe(409);
		expect(tooMany.json.type).toMatch(/quantity_unavailable$/);
		const submitted = await h.published('aftersales.claim_submitted@1');
		expect(submitted.at(-1).data).toMatchObject({ claimId: created.json.id, via: 'identity' });
		h.clock.advance(20 * DAY);
		const late = await h.call('POST', '/v1/claims', {
			as: 'cus_bea',
			body: { purchaseId, type: 'return', reason: 'changed_mind', lines: [{ lineId: 'itm_1:var_1', quantity: 1 }] },
		});
		expect(late.status).toBe(409);
		expect(late.json.errors[0].code).toBe('window_closed');
		h.clock.advance(-20 * DAY);
	});

	it('replays a claim for the same Idempotency-Key and validates submissions', async () => {
		const { purchaseId } = await h.order({ subject: 'cus_cy' });
		const body = { purchaseId, type: 'exchange', reason: 'wrong_item', lines: [{ lineId: 'itm_1:var_1', quantity: 1 }] };
		const a = await h.call('POST', '/v1/claims', { as: 'cus_cy', body, idempotencyKey: 'same-claim' });
		const b = await h.call('POST', '/v1/claims', { as: 'cus_cy', body, idempotencyKey: 'same-claim' });
		expect(b.json.id).toBe(a.json.id);
		/** @param {Record<string, unknown>} patch */
		const attempt = (patch) => h.call('POST', '/v1/claims', { as: 'cus_cy', body: { ...body, ...patch } });
		expect((await attempt({ type: 'nope' })).json.errors[0].code).toBe('type_invalid');
		expect((await attempt({ reason: 'changed_mind', type: 'warranty' })).json.errors[0].code).toBe('reason_invalid');
		expect((await attempt({ reason: 'other' })).json.errors[0].code).toBe('too_short');
		expect((await attempt({ lines: [{ lineId: 'zzz', quantity: 1 }] })).json.errors[0].code).toBe('line_unknown');
		expect((await attempt({ lines: [{ lineId: 'itm_1:var_1', quantity: 1, serial: '!' }] })).json.errors[0].code).toBe(
			'serial_invalid',
		);
		expect((await attempt({ photoIds: ['cph_missing'] })).json.errors[0].code).toBe('photo_invalid');
		expect((await attempt({ type: 1, reason: 2, lines: 'x', photoIds: ['a', 'a'], token: 5, details: 4 })).status).toBe(422);
		expect((await attempt({ lines: [{ lineId: 1, quantity: 0, serial: 2 }, 'x'] })).status).toBe(422);
		expect((await h.call('POST', '/v1/claims', { as: 'cus_cy', body: [] })).status).toBe(422);
		expect((await h.call('POST', '/v1/claims', { browser: true, body })).status).toBe(401);
		expect(
			(await h.call('POST', '/v1/claims', { browser: true, body, headers: { 'ss-identity': 'garbage' } })).json.type,
		).toMatch(/identity_invalid$/);
		expect((await h.call('POST', '/v1/claims', { as: 'cus_other', body })).status).toBe(404);
		expect((await h.call('GET', '/v1/claims', { browser: true })).status).toBe(401);
		expect((await h.call('GET', '/v1/claims/clm_x', { browser: true })).status).toBe(401);
		expect((await h.call('GET', '/v1/claims?filter[status]=nope')).status).toBe(422);
		expect((await h.call('GET', '/v1/claims?filter[type]=BAD')).status).toBe(422);
		const filtered = await h.call(
			'GET',
			`/v1/claims?filter[status]=requested&filter[type]=exchange&filter[purchaseId]=${purchaseId}&filter[customerId]=cus_cy&sort=oldest`,
		);
		expect(filtered.json.items).toHaveLength(1);
	});

	it('requires serials and enforces the open-claim limit and window rules', async () => {
		await h.entitle({
			config: {
				claims: {
					types: [{ key: 'repair', label: 'Repair', window_days: 0, require_serial: true, min_photos: 0 }],
					reasons: [{ key: 'broken', label: 'Broken' }],
					window_rules: [
						{ id: 'off', type: 'repair', when: "line.sku == 'NONE'", days: 0, enabled: false },
						{ id: 'cases', type: 'repair', when: "line.itemType == 'goods' and line.unitAmount >= 1000", days: 90 },
					],
					max_open_claims_per_customer: 1,
				},
			},
		});
		const { orderId, purchaseId } = await h.order({ subject: 'cus_dee' });
		await h.call('POST', '/v1/serials', { body: { serial: 'UNIT-1', itemId: 'itm_1', variantId: 'var_1', orderId } });
		const view = await h.call('GET', `/v1/purchases/${purchaseId}`);
		expect(view.json.lines[0].windows.repair).toMatchObject({ eligible: true, days: 90, source: 'rule' });
		const base = { purchaseId, type: 'repair', reason: 'broken' };
		const noSerial = await h.call('POST', '/v1/claims', {
			as: 'cus_dee',
			body: { ...base, lines: [{ lineId: 'itm_1:var_1', quantity: 1 }] },
		});
		expect(noSerial.json.errors[0]).toMatchObject({ path: '/lines/0/serial', code: 'required' });
		const wrong = await h.call('POST', '/v1/claims', {
			as: 'cus_dee',
			body: { ...base, lines: [{ lineId: 'itm_1:var_1', quantity: 1, serial: 'UNIT-2' }] },
		});
		expect(wrong.json.type).toMatch(/serial_mismatch$/);
		const okay = await h.call('POST', '/v1/claims', {
			as: 'cus_dee',
			body: { ...base, lines: [{ lineId: 'itm_1:var_1', quantity: 1, serial: 'unit 1' }] },
		});
		expect(okay.status).toBe(201);
		expect(okay.json.lines[0].serial).toBe('UNIT1');
		const limited = await h.call('POST', '/v1/claims', {
			as: 'cus_dee',
			body: { ...base, lines: [{ lineId: 'itm_1:var_1', quantity: 1, serial: 'UNIT-1' }] },
		});
		expect(limited.status).toBe(429);
		const check = await h.call('POST', '/v1/claim-form:check', { body: { when: 'line.itemType ==' } });
		expect(check.json.ok).toBe(false);
		expect((await h.call('POST', '/v1/claim-form:check', { body: {} })).status).toBe(422);
		expect((await h.call('POST', '/v1/claim-form:check', { body: { when: '' } })).json.ok).toBe(true);
		await h.entitle();
	});
});

describe('guest claims (claim token)', () => {
	it('issues a token for the order number + contact and scopes everything to that purchase', async () => {
		const { purchaseId, number } = await h.order({ subject: 'cus_gus', email: 'gus@example.com', phone: '+15551234567' });
		const miss = await h.call('POST', '/v1/claim-access', { browser: true, body: { number, email: 'nobody@example.com' } });
		expect(miss.status).toBe(404);
		expect((await h.call('POST', '/v1/claim-access', { browser: true, body: { email: 'bad' } })).status).toBe(422);
		expect((await h.call('POST', '/v1/claim-access', { browser: true, body: [] })).status).toBe(422);
		expect((await h.call('POST', '/v1/claim-access', { browser: true, body: { number, phone: 'x' } })).status).toBe(422);
		const byPhone = await h.call('POST', '/v1/claim-access', { browser: true, body: { number, phone: '+1 555 123 4567' } });
		expect(byPhone.status).toBe(200);
		const access = await h.call('POST', '/v1/claim-access', { browser: true, body: { number, email: 'GUS@example.com' } });
		expect(access.json.purchaseId).toBe(purchaseId);
		const { token } = access.json;
		const viewed = await h.call('POST', '/v1/claims:view', { browser: true, body: { token } });
		expect(viewed.status).toBe(200);
		expect(viewed.json.purchase).toMatchObject({ id: purchaseId, canClaim: true });
		const created = await h.call('POST', '/v1/claims', {
			browser: true,
			body: { token, purchaseId, type: 'return', reason: 'defective', lines: [{ lineId: 'itm_1:var_1', quantity: 1 }] },
		});
		expect(created.status).toBe(201);
		const other = await h.order({ subject: 'cus_zed' });
		expect(
			(
				await h.call('POST', '/v1/claims', {
					browser: true,
					body: {
						token,
						purchaseId: other.purchaseId,
						type: 'return',
						reason: 'defective',
						lines: [{ lineId: 'itm_1:var_1', quantity: 1 }],
					},
				})
			).status,
		).toBe(404);
		const one = await h.call('POST', '/v1/claims:view', { browser: true, body: { token, claimId: created.json.id } });
		expect(one.json.claims).toHaveLength(1);
		expect(one.json.messages).toEqual([]);
		expect((await h.call('POST', '/v1/claims:view', { browser: true, body: { token, claimId: 'clm_other' } })).status).toBe(
			404,
		);
		expect((await h.call('POST', '/v1/claims:view', { browser: true, body: { token: 'ct1.x.y' } })).status).toBe(401);
		expect((await h.call('POST', '/v1/claims:view', { browser: true, body: {} })).status).toBe(422);
		expect(
			(
				await h.call('POST', '/v1/claims', {
					browser: true,
					body: {
						token: 'ct1.a.b',
						purchaseId,
						type: 'return',
						reason: 'defective',
						lines: [{ lineId: 'itm_1:var_1', quantity: 1 }],
					},
				})
			).status,
		).toBe(401);
		// a token of another website is refused
		await h.entitle({ websiteId: WEBSITE_2 });
		const foreign = await h.call('POST', '/v1/claims:view', {
			key: await h.key('pk', WEBSITE_2),
			body: { token },
			headers: { origin: 'https://shop.example.com' },
		});
		expect(foreign.status).toBe(401);
		await h.entitle({ config: { claims: { guest_access: false } } });
		expect(
			(await h.call('POST', '/v1/claim-access', { browser: true, body: { number, email: 'gus@example.com' } })).status,
		).toBe(403);
		await h.entitle();
	});
});

describe('evidence photos', () => {
	it('signs uploads, HEAD-checks them, attaches them and meters usage', async () => {
		const { purchaseId } = await h.order({ subject: 'cus_pia' });
		const slot = await h.call('POST', '/v1/claim-photos', {
			as: 'cus_pia',
			body: { contentType: 'image/jpeg', size: 1234 },
			idempotencyKey: 'photo-1',
		});
		expect(slot.status).toBe(201);
		expect(slot.json.upload.headers['content-length']).toBe('1234');
		const again = await h.call('POST', '/v1/claim-photos', {
			as: 'cus_pia',
			body: { contentType: 'image/jpeg', size: 1234 },
			idempotencyKey: 'photo-1',
		});
		expect(again.json.id).toBe(slot.json.id);
		const stored = await h.collection('photos').findOne({ websiteId: WEBSITE, id: slot.json.id });
		const body = {
			purchaseId,
			type: 'return',
			reason: 'defective',
			lines: [{ lineId: 'itm_1:var_1', quantity: 1 }],
			photoIds: [slot.json.id],
		};
		// not uploaded yet
		expect((await h.call('POST', '/v1/claims', { as: 'cus_pia', body })).json.type).toMatch(/photo_invalid$/);
		// wrong size
		h.providers.upload(/** @type {string} */ (stored?.objectKey), 99, 'image/jpeg');
		expect((await h.call('POST', '/v1/claims', { as: 'cus_pia', body })).status).toBe(422);
		// another customer's photo
		expect((await h.call('POST', '/v1/claims', { as: 'cus_other', body })).status).toBe(404);
		h.providers.upload(/** @type {string} */ (stored?.objectKey), 1234, 'image/jpeg');
		h.providers.failStorage(true);
		expect((await h.call('POST', '/v1/claims', { as: 'cus_pia', body })).status).toBe(503);
		h.providers.failStorage(false);
		const created = await h.call('POST', '/v1/claims', { as: 'cus_pia', body });
		expect(created.status).toBe(201);
		expect(created.json.photos[0]).toMatchObject({ id: slot.json.id, contentType: 'image/jpeg' });
		expect(created.json.photos[0].url).toMatch(/^https:\/\/s3\.example\.com\//);
		const meta = await h.call('GET', `/v1/claim-photos/${slot.json.id}`);
		expect(meta.json).toMatchObject({ status: 'attached', claimId: created.json.id });
		expect((await h.call('GET', '/v1/claim-photos/cph_none')).status).toBe(404);
		expect((await h.aftersales.product.usage.stats()).pending).toBeGreaterThanOrEqual(1);
		expect(
			(await h.call('POST', '/v1/claim-photos', { as: 'cus_pia', body: { contentType: 'image/gif', size: 0 } })).status,
		).toBe(422);
		expect(
			(await h.call('POST', '/v1/claim-photos', { as: 'cus_pia', body: { contentType: 'image/png', size: 99_000_000 } }))
				.status,
		).toBe(422);
		expect(
			(await h.call('POST', '/v1/claim-photos', { browser: true, body: { contentType: 'image/png', size: 10 } })).status,
		).toBe(401);
		expect(
			(
				await h.call('POST', '/v1/claim-photos', {
					browser: true,
					body: { contentType: 'image/png', size: 10, token: 'ct1.a.b' },
				})
			).status,
		).toBe(401);
		expect((await h.call('POST', '/v1/claim-photos', { body: { contentType: 'image/png', size: 10 } })).status).toBe(201);
		expect((await h.call('POST', '/v1/claim-photos', { body: [] })).status).toBe(422);
		const tooMany = await h.call('POST', '/v1/claims', {
			as: 'cus_pia',
			body: { ...body, photoIds: ['a1', 'a2', 'a3', 'a4', 'a5'] },
		});
		expect(tooMany.json.errors[0].code).toBe('too_many');
		await h.entitle({ elements: { photos: false } });
		expect(
			(await h.call('POST', '/v1/claims', { as: 'cus_pia', body: { ...body, photoIds: ['a1'] } })).json.errors[0].code,
		).toBe('photos_off');
		await h.entitle();
	});
});
