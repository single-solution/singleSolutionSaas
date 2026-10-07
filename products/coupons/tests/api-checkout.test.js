/**
 * The redemption API end to end on a real MongoDB: validations and quotes (eligibility, schedules, stacking), atomic
 * reservations under concurrency, redeem / release / attach, TTL expiry (lazy and by the job), late completions,
 * order events from the Event Hub (completed, cancelled, refunded), metering, published events, per-customer limits
 * with bring-your-own identity, per-device limits, velocity limits and the blocklist.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestIdentityIssuer } from '@ss/app-kit/testing';
import { cart, createHarness, MINUTE, ORIGIN, T0 } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
beforeAll(async () => {
	h = await createHarness({ config: { api: { reservation_ttl_minutes: 15 } } });
});
afterAll(async () => h?.close());

const codesOf = (/** @type {any} */ items) => items.map((/** @type {any} */ entry) => entry.code);

describe('validations and quotes', () => {
	it('validates a code for a cart (browser key) and explains refusals', async () => {
		await h.coupon({
			code: 'SOCKS20',
			action: { type: 'percent', percent: 20, target: 'matched' },
			eligibility: { conditions: [{ type: 'collections', operator: 'in', value: ['socks'] }] },
		});
		const valid = await h.call('POST', '/v1/validations', {
			key: h.pk,
			headers: ORIGIN,
			body: { code: 'socks20', cart: cart() },
		});
		expect(valid.status).toBe(200);
		expect(valid.json).toMatchObject({ code: 'SOCKS20', valid: true, reason: null });
		expect(valid.json.quote).toMatchObject({
			subtotal: 10_000,
			discount: 600,
			shipping: 500,
			total: 9900,
			lines: [{ lineId: 'l1', discount: 600 }],
		});
		const noSocks = await h.call('POST', '/v1/validations', {
			key: h.pk,
			headers: ORIGIN,
			body: { code: 'SOCKS20', cart: cart({ lines: [{ itemId: 'itm_shoes', quantity: 1, unitAmount: 7000 }] }) },
		});
		expect(noSocks.json).toMatchObject({ valid: false, reason: 'not_eligible' });
		const unknown = await h.call('POST', '/v1/validations', {
			key: h.pk,
			headers: ORIGIN,
			body: { code: 'NOPE', cart: cart() },
		});
		expect(unknown.json).toMatchObject({ valid: false, reason: 'code_not_found' });
		const invalid = await h.call('POST', '/v1/validations', {
			key: h.pk,
			headers: ORIGIN,
			body: { code: '', cart: { currency: 'eur' } },
		});
		expect(invalid.status).toBe(422);
	});

	it('honours validity windows in the website zone, including overnight windows', async () => {
		await h.entitle({ config: { codes: { time_zone: 'Asia/Karachi' } } });
		await h.coupon({
			code: 'LATENIGHT',
			action: { type: 'percent', percent: 10, target: 'order' },
			validity: { windows: [{ days: ['thu'], start: '22:00', end: '02:00' }] },
		});
		// 2026-10-01 is a Thursday; 10:00Z = 15:00 PKT → outside
		const day = await h.call('POST', '/v1/validations', { body: { code: 'LATENIGHT', cart: cart() } });
		expect(day.json.reason).toBe('outside_schedule');
		h.clock.set(Date.parse('2026-10-01T20:30:00Z')); // Friday 01:30 PKT, the Thursday-night window
		expect((await h.call('POST', '/v1/validations', { body: { code: 'LATENIGHT', cart: cart() } })).json.valid).toBe(true);
		h.clock.set(T0);
		await h.entitle();
		await h.coupon({
			code: 'FUTURE',
			action: { type: 'percent', percent: 5 },
			validity: { starts_at: '2027-01-01T00:00:00Z' },
		});
		await h.coupon({ code: 'PAST', action: { type: 'percent', percent: 5 }, validity: { ends_at: '2026-01-01T00:00:00Z' } });
		expect((await h.call('POST', '/v1/validations', { body: { code: 'FUTURE', cart: cart() } })).json.reason).toBe(
			'not_started',
		);
		expect((await h.call('POST', '/v1/validations', { body: { code: 'PAST', cart: cart() } })).json.reason).toBe('ended');
	});

	it('quotes several codes with the stacking policy (classes, exclusivity, currency, loyalty flags)', async () => {
		await h.coupon({ code: 'SHIPFREE', action: { type: 'free_shipping' }, stacking: { class: 'shipping' } });
		await h.coupon({
			code: 'ORDER10',
			action: { type: 'percent', percent: 10, target: 'order' },
			stacking: { class: 'order', with_loyalty: false },
		});
		await h.coupon({ code: 'ORDER5', action: { type: 'percent', percent: 5, target: 'order' }, stacking: { class: 'order' } });
		await h.coupon({ code: 'SOLO', action: { type: 'percent', percent: 50, target: 'order' }, stacking: { exclusive: true } });
		await h.coupon({ code: 'USDONLY', currency: 'USD', action: { type: 'fixed', amount: 100 } });
		// coupons without a class are `order` coupons (stacking.default_class); SOCKS20 becomes an item discount
		const socks = (await h.call('GET', '/v1/codes/SOCKS20')).json.couponId;
		expect((await h.call('PATCH', `/v1/coupons/${socks}`, { body: { stacking: { class: 'item' } } })).json.stacking).toEqual({
			class: 'item',
		});
		expect((await h.call('PATCH', `/v1/coupons/${socks}`, { body: { stacking: { class: 'nope' } } })).status).toBe(422);
		const quote = await h.call('POST', '/v1/quotes', {
			key: h.pk,
			headers: ORIGIN,
			body: { codes: ['SOCKS20', 'ORDER10', 'SHIPFREE', 'ORDER5', 'USDONLY'], cart: cart() },
		});
		expect(quote.status).toBe(200);
		expect(codesOf(quote.json.applied)).toEqual(['SOCKS20', 'ORDER10']);
		// default stacking: 2 coupons per cart, best discount first
		expect(quote.json.rejected).toEqual([
			{ code: 'SHIPFREE', reason: 'too_many_coupons' },
			{ code: 'ORDER5', reason: 'too_many_coupons' },
			{ code: 'USDONLY', reason: 'currency_mismatch' },
		]);
		// item class first (600 off the socks), then 10 % of what remains (9400 → 940)
		expect(quote.json).toMatchObject({ discount: 1540, shippingDiscount: 0, total: 8960, loyaltyAllowed: false });
		await h.entitle({ config: { stacking: { max_coupons_per_cart: 3 } } });
		const three = await h.call('POST', '/v1/quotes', { body: { codes: ['ORDER10', 'ORDER5', 'SHIPFREE'], cart: cart() } });
		expect(codesOf(three.json.applied)).toEqual(['ORDER10', 'SHIPFREE']);
		expect(three.json.rejected).toEqual([{ code: 'ORDER5', reason: 'not_combinable' }]);
		expect(three.json).toMatchObject({ freeShipping: true, shippingDiscount: 500, total: 9000 });
		const solo = await h.call('POST', '/v1/quotes', { body: { codes: ['SOLO', 'SHIPFREE'], cart: cart() } });
		expect(codesOf(solo.json.applied)).toEqual(['SOLO']);
		expect(solo.json.rejected).toEqual([{ code: 'SHIPFREE', reason: 'not_combinable' }]);
		await h.entitle({ elements: { stacking: false } });
		// without the stacking element: one coupon per cart, in the order entered
		const single = await h.call('POST', '/v1/quotes', { body: { codes: ['SHIPFREE', 'ORDER10'], cart: cart() } });
		expect(codesOf(single.json.applied)).toEqual(['SHIPFREE']);
		expect(single.json.rejected).toEqual([{ code: 'ORDER10', reason: 'too_many_coupons' }]);
		await h.entitle();
	});
});

describe('reservations', () => {
	it('lets exactly one of two concurrent checkouts reserve a single-use code', async () => {
		await h.coupon({ code: 'ONCEONLY', action: { type: 'percent', percent: 10 }, limits: { per_code: 1 } });
		const attempt = (/** @type {string} */ customer) =>
			h.call('POST', '/v1/reservations', {
				body: { codes: ['ONCEONLY'], cart: cart({ customer: { id: customer } }), reference: `cart_${customer}` },
			});
		const results = await Promise.all([attempt('cus_a'), attempt('cus_b'), attempt('cus_c'), attempt('cus_d')]);
		const statuses = results.map((result) => result.status).sort();
		expect(statuses).toEqual([201, 409, 409, 409]);
		const loser = results.find((result) => result.status === 409);
		expect(loser?.json.type).toMatch(/\/exhausted$/);
		expect(loser?.json.errors[0]).toMatchObject({ path: '/codes', code: 'exhausted' });
		const code = await h.collection('codes').findOne({ code: 'ONCEONLY' });
		expect(code).toMatchObject({ taken: 1, redeemed: 0 });
	});

	it('scopes reference / key derived reservations by caller: another key never sees or changes them', async () => {
		await h.coupon({ code: 'SCOPED', action: { type: 'fixed', amount: 100 }, currency: 'EUR', limits: { total: 5 } });
		const body = { codes: ['SCOPED'], cart: cart(), reference: 'cart_scoped' };
		const mine = await h.call('POST', '/v1/reservations', { body, idempotencyKey: 'k_scoped' });
		expect(mine.status).toBe(201);
		const otherKey = await h.key('sk');
		const theirs = await h.call('POST', '/v1/reservations', { key: otherKey, body, idempotencyKey: null });
		expect(theirs.status).toBe(201);
		expect(theirs.json.id).not.toBe(mine.json.id);
		expect((await h.call('GET', `/v1/reservations/${mine.json.id}`)).json.status).toBe('reserved');
		// an existing record whose owner differs is never answered (defence in depth on top of the scoped id)
		await h.collection('reservations').updateOne({ id: mine.json.id }, { $set: { requestedBy: 'sk:key_someone_else' } });
		const refused = await h.call('POST', '/v1/reservations', { body, idempotencyKey: null });
		expect(refused.status).toBe(409);
		expect(refused.json.type).toMatch(/duplicate_request$/);
	});

	it('is idempotent on the reference and on the Idempotency-Key', async () => {
		await h.coupon({ code: 'IDEM', action: { type: 'fixed', amount: 300 }, currency: 'EUR', limits: { total: 5 } });
		const body = { codes: ['IDEM'], cart: cart(), reference: 'cart_idem' };
		const first = await h.call('POST', '/v1/reservations', { body, idempotencyKey: 'k1' });
		const again = await h.call('POST', '/v1/reservations', { body, idempotencyKey: 'k1' });
		const sameReference = await h.call('POST', '/v1/reservations', { body, idempotencyKey: 'k2' });
		expect(first.status).toBe(201);
		expect(again.json).toEqual(first.json);
		expect(sameReference.json.id).toBe(first.json.id);
		expect(first.json).toMatchObject({ status: 'reserved', codes: ['IDEM'], totals: { discount: 300, total: 10_200 } });
		const coupon = await h.collection('coupons').findOne({ id: (await h.call('GET', '/v1/codes/IDEM')).json.couponId });
		expect(coupon?.counters).toEqual({ taken: 1, redeemed: 0 });
		const noKey = await h.call('POST', '/v1/reservations', { body, idempotencyKey: null });
		expect(noKey.json.id).toBe(first.json.id);
		// neither a reference nor a key: every call is a new reservation
		const loose = { codes: ['IDEM'], cart: cart() };
		const one = await h.call('POST', '/v1/reservations', { body: loose, idempotencyKey: null });
		const two = await h.call('POST', '/v1/reservations', { body: loose, idempotencyKey: null });
		expect(one.status).toBe(201);
		expect(two.status).toBe(201);
		expect(two.json.id).not.toBe(one.json.id);
		expect((await h.call('GET', `/v1/reservations/${first.json.id}`)).json.id).toBe(first.json.id);
		expect((await h.call('GET', '/v1/reservations/rsv_missing')).status).toBe(404);
	});

	it('redeems once (usage metered, coupons.redeemed@1 and coupons.exhausted@1 published) and undoes a redemption', async () => {
		const coupon = await h.coupon({
			code: 'LASTONE',
			action: { type: 'percent', percent: 10 },
			limits: { per_code: 1, total: 1 },
		});
		const reserved = await h.call('POST', '/v1/reservations', {
			body: { codes: ['LASTONE'], cart: cart({ customer: { id: 'cus_last' } }), orderId: 'ord_last' },
		});
		const redeemed = await h.call('POST', `/v1/reservations/${reserved.json.id}/redeem`, { body: { orderId: 'ord_last' } });
		expect(redeemed.json).toMatchObject({ status: 'redeemed', orderId: 'ord_last' });
		expect((await h.call('POST', `/v1/reservations/${reserved.json.id}/redeem`, {})).json.status).toBe('redeemed');
		expect(
			(await h.call('POST', `/v1/reservations/${reserved.json.id}/redeem`, { body: { orderId: 'ord_other' } })).status,
		).toBe(409);
		expect(h.published('coupons.redeemed@1').filter((e) => e.data.reservationId === reserved.json.id)).toHaveLength(1);
		const exhausted = h.published('coupons.exhausted@1').filter((e) => e.data.couponId === coupon.id);
		expect(exhausted.map((e) => e.data.scope).sort()).toEqual(['code', 'coupon']);
		expect((await h.collection('codes').findOne({ code: 'LASTONE' }))?.redeemed).toBe(1);
		const usage = await h.coupons.product.usage.stats();
		expect(usage.pending).toBeGreaterThanOrEqual(1);
		const flushed = await h.coupons.product.usage.flush();
		expect(flushed.sent + flushed.duplicates).toBeGreaterThanOrEqual(1);
		expect(h.portal.usage.get(`redemption:${reserved.json.id}:LASTONE`)).toMatchObject({ unit: 'redemption', quantity: 1 });
		const list = await h.call('GET', '/v1/redemptions');
		expect(list.json.items.map((/** @type {any} */ r) => r.id)).toContain(reserved.json.id);
		expect((await h.call('GET', `/v1/redemptions/${reserved.json.id}`)).json.status).toBe('redeemed');
		const undone = await h.call('POST', `/v1/redemptions/${reserved.json.id}/release`, { body: { reason: 'refund' } });
		expect(undone.json).toMatchObject({ status: 'released', releaseReason: 'released' });
		expect(await h.collection('codes').findOne({ code: 'LASTONE' })).toMatchObject({ taken: 0, redeemed: 0 });
		expect(h.published('coupons.released@1').find((e) => e.data.reservationId === reserved.json.id)?.data).toMatchObject({
			reason: 'released',
			wasRedeemed: true,
		});
		const released = await h.call('GET', '/v1/redemptions?status=released');
		expect(released.json.items.map((/** @type {any} */ r) => r.id)).toContain(reserved.json.id);
		expect((await h.call('POST', '/v1/redemptions/rsv_missing/release', {})).status).toBe(404);
		expect((await h.call('GET', '/v1/redemptions/rsv_missing')).status).toBe(404);
	});

	it('releases abandoned reservations and expires them after the TTL (lazily when the code is full, and by the job)', async () => {
		await h.coupon({ code: 'HOLD', action: { type: 'percent', percent: 10 }, limits: { per_code: 1 } });
		const first = await h.call('POST', '/v1/reservations', { body: { codes: ['HOLD'], cart: cart() } });
		expect(first.status).toBe(201);
		const released = await h.call('POST', `/v1/reservations/${first.json.id}/release`, {});
		expect(released.json.status).toBe('released');
		expect((await h.call('POST', `/v1/reservations/${first.json.id}/release`, {})).json.status).toBe('released');
		expect((await h.call('POST', `/v1/reservations/${first.json.id}/redeem`, {})).status).toBe(409);
		const second = await h.call('POST', '/v1/reservations', { body: { codes: ['HOLD'], cart: cart() } });
		expect(second.status).toBe(201);
		expect((await h.call('POST', '/v1/reservations', { body: { codes: ['HOLD'], cart: cart() } })).status).toBe(409);
		h.clock.advance(16 * MINUTE);
		// the code is full: the expired reservation is swept lazily and the use goes to the new checkout
		const third = await h.call('POST', '/v1/reservations', { body: { codes: ['HOLD'], cart: cart() } });
		expect(third.status).toBe(201);
		expect((await h.call('GET', `/v1/reservations/${second.json.id}`)).json.status).toBe('expired');
		expect(h.published('coupons.released@1').find((e) => e.data.reservationId === second.json.id)?.data.reason).toBe('expired');
		h.clock.advance(16 * MINUTE);
		expect((await h.call('GET', `/v1/reservations/${third.json.id}`)).json.status).toBe('expired');
		h.clock.set(T0);
	});

	it('confirms a late completion of an expired reservation when the use is still free', async () => {
		await h.coupon({ code: 'LATE', action: { type: 'percent', percent: 10 }, limits: { per_code: 1 } });
		const reserved = await h.call('POST', '/v1/reservations', { body: { codes: ['LATE'], cart: cart(), orderId: 'ord_late' } });
		h.clock.advance(20 * MINUTE);
		expect((await h.call('GET', `/v1/reservations/${reserved.json.id}`)).json.status).toBe('expired');
		const done = await h.deliver('order.completed@1', { orderId: 'ord_late' });
		expect(done.status).toBe(200);
		expect((await h.call('GET', `/v1/reservations/${reserved.json.id}`)).json.status).toBe('redeemed');
		h.clock.set(T0);
		await h.entitle({ config: { api: { reservation_ttl_minutes: 15, confirm_expired: false } } });
		await h.coupon({ code: 'LATE2', action: { type: 'percent', percent: 10 }, limits: { per_code: 1 } });
		const strict = await h.call('POST', '/v1/reservations', { body: { codes: ['LATE2'], cart: cart() } });
		h.clock.advance(20 * MINUTE);
		const refused = await h.call('POST', `/v1/reservations/${strict.json.id}/redeem`, {});
		expect(refused.status).toBe(409);
		expect(refused.json.type).toMatch(/reservation_expired$/);
		h.clock.set(T0);
		await h.entitle({ config: { api: { reservation_ttl_minutes: 15 } } });
	});

	it('reserves and redeems at once, and refuses carts where a code does not apply', async () => {
		await h.coupon({ code: 'DIRECT', action: { type: 'percent', percent: 10 } });
		const direct = await h.call('POST', '/v1/redemptions', {
			body: { codes: ['DIRECT'], cart: cart(), orderId: 'ord_direct' },
		});
		expect(direct.status).toBe(201);
		expect(direct.json).toMatchObject({ status: 'redeemed', orderId: 'ord_direct' });
		const refused = await h.call('POST', '/v1/reservations', { body: { codes: ['DIRECT', 'NOPE'], cart: cart() } });
		expect(refused.status).toBe(404);
		expect(refused.json.errors).toEqual([expect.objectContaining({ code: 'code_not_found' })]);
		expect((await h.call('POST', '/v1/reservations', { body: { codes: [], cart: cart() } })).status).toBe(422);
	});
});

describe('order events', () => {
	it('confirms reservations on order.completed@1 (bound by attach) exactly once', async () => {
		await h.coupon({ code: 'EVENTED', action: { type: 'percent', percent: 10 } });
		const reserved = await h.call('POST', '/v1/reservations', { body: { codes: ['EVENTED'], cart: cart() } });
		expect(
			(await h.call('POST', `/v1/reservations/${reserved.json.id}/attach`, { body: { orderId: 'ord_ev' } })).json.orderId,
		).toBe('ord_ev');
		expect(
			(await h.call('POST', `/v1/reservations/${reserved.json.id}/attach`, { body: { orderId: 'ord_other' } })).status,
		).toBe(409);
		expect((await h.call('POST', `/v1/reservations/${reserved.json.id}/attach`, { body: {} })).status).toBe(422);
		expect((await h.call('POST', '/v1/reservations/rsv_missing/attach', { body: { orderId: 'o' } })).status).toBe(404);
		const event = await h.deliver('order.completed@1', { orderId: 'ord_ev' }, { id: 'evt_completed_1' });
		expect(event.status).toBe(200);
		await h.deliver('order.completed@1', { orderId: 'ord_ev' }, { id: 'evt_completed_1' });
		await h.deliver('order.completed@1', { orderId: 'ord_ev' });
		expect((await h.call('GET', `/v1/reservations/${reserved.json.id}`)).json.status).toBe('redeemed');
		expect(h.published('coupons.redeemed@1').filter((e) => e.data.reservationId === reserved.json.id)).toHaveLength(1);
		expect((await h.collection('codes').findOne({ code: 'EVENTED' }))?.redeemed).toBe(1);
	});

	it('gives uses back on order.cancelled@1 and on full refunds (summed per event)', async () => {
		await h.coupon({ code: 'UNDO', action: { type: 'fixed', amount: 1000 }, currency: 'EUR', limits: { total: 10 } });
		const cancelled = await h.call('POST', '/v1/redemptions', {
			body: { codes: ['UNDO'], cart: cart(), orderId: 'ord_cancel' },
		});
		await h.deliver('order.cancelled@1', { orderId: 'ord_cancel' });
		expect((await h.call('GET', `/v1/reservations/${cancelled.json.id}`)).json).toMatchObject({
			status: 'released',
			releaseReason: 'order_cancelled',
		});
		const refunded = await h.call('POST', '/v1/redemptions', {
			body: { codes: ['UNDO'], cart: cart(), orderId: 'ord_refund' },
		});
		const total = refunded.json.totals.total; // 10_000 − 1000 + 500
		await h.deliver('order.refunded@1', { orderId: 'ord_refund', amount: { amount: 4000, currency: 'EUR' } }, { id: 'evt_r1' });
		await h.deliver('order.refunded@1', { orderId: 'ord_refund', amount: { amount: 4000, currency: 'EUR' } }, { id: 'evt_r1' });
		await h.deliver('order.refunded@1', { orderId: 'ord_refund', amount: { amount: 9999, currency: 'USD' } });
		expect((await h.call('GET', `/v1/reservations/${refunded.json.id}`)).json.status).toBe('redeemed');
		await h.deliver('order.refunded@1', { orderId: 'ord_refund', amount: { amount: total - 4000, currency: 'EUR' } });
		expect((await h.call('GET', `/v1/reservations/${refunded.json.id}`)).json).toMatchObject({
			status: 'released',
			releaseReason: 'order_refunded',
		});
		const coupon = await h.collection('coupons').findOne({ id: refunded.json.coupons[0].couponId });
		expect(coupon?.counters).toEqual({ taken: 0, redeemed: 0 });
		await h.entitle({ config: { api: { release_on_cancel: false, release_on_refund: 'never' } } });
		const kept = await h.call('POST', '/v1/redemptions', { body: { codes: ['UNDO'], cart: cart(), orderId: 'ord_keep' } });
		await h.deliver('order.cancelled@1', { orderId: 'ord_keep' });
		await h.deliver('order.refunded@1', { orderId: 'ord_keep', amount: { amount: 1, currency: 'EUR' } });
		expect((await h.call('GET', `/v1/reservations/${kept.json.id}`)).json.status).toBe('redeemed');
		await h.entitle({ config: { api: { release_on_refund: 'any' } } });
		await h.deliver('order.refunded@1', { orderId: 'ord_keep', amount: { amount: 1, currency: 'EUR' } });
		expect((await h.call('GET', `/v1/reservations/${kept.json.id}`)).json.status).toBe('released');
		await h.entitle({ config: { api: { reservation_ttl_minutes: 15 } } });
	});
});

describe('limits', () => {
	it('limits uses per customer with the website’s own login (pk_ + SS-Identity) and requires an identity', async () => {
		const issuer = createTestIdentityIssuer({ alg: 'ES256', audience: 'shop-web' });
		await h.entitle({ identity: issuer.section, config: { api: { reservation_ttl_minutes: 15 } } });
		await h.coupon({ code: 'ONEEACH', action: { type: 'percent', percent: 10 }, limits: { per_customer: 1 } });
		const now = Math.floor(h.clock.now() / 1000);
		const login = issuer.sign({ iss: issuer.section.issuer, aud: 'shop-web', sub: 'cus_fed', iat: now, exp: now + 900 });
		const anonymous = await h.call('POST', '/v1/validations', {
			key: h.pk,
			headers: ORIGIN,
			body: { code: 'ONEEACH', cart: cart() },
		});
		expect(anonymous.json.reason).toBe('identity_required');
		// a browser cannot claim to be someone through the body
		const spoofed = await h.call('POST', '/v1/validations', {
			key: h.pk,
			headers: ORIGIN,
			body: { code: 'ONEEACH', cart: cart({ customer: { id: 'cus_fed' } }) },
		});
		expect(spoofed.json.reason).toBe('identity_required');
		const identified = await h.call('POST', '/v1/validations', {
			key: h.pk,
			headers: { ...ORIGIN, 'ss-identity': login },
			body: { code: 'ONEEACH', cart: cart() },
		});
		expect(identified.json.valid).toBe(true);
		const used = await h.call('POST', '/v1/redemptions', {
			body: { codes: ['ONEEACH'], cart: cart({ customer: { id: 'cus_fed' } }) },
		});
		expect(used.status).toBe(201);
		const again = await h.call('POST', '/v1/validations', {
			key: h.pk,
			headers: { ...ORIGIN, 'ss-identity': login },
			body: { code: 'ONEEACH', cart: cart() },
		});
		expect(again.json.reason).toBe('customer_limit_reached');
		const second = await h.call('POST', '/v1/reservations', {
			body: { codes: ['ONEEACH'], cart: cart({ customer: { id: 'cus_fed' } }) },
		});
		expect(second.status).toBe(409);
		expect(second.json.type).toMatch(/customer_limit_reached$/);
		const usage = await h.collection('usage').findOne({ couponId: used.json.coupons[0].couponId });
		expect(usage).toMatchObject({ kind: 'customer', customerId: 'cus_fed', taken: 1 });
		expect(usage?.key).not.toContain('cus_fed');
		await h.entitle();
	});

	it('limits uses per device', async () => {
		await h.coupon({ code: 'PERDEVICE', action: { type: 'percent', percent: 10 }, limits: { per_device: 1 } });
		const body = { codes: ['PERDEVICE'], cart: cart({ context: { deviceId: 'dev_1' } }) };
		expect((await h.call('POST', '/v1/redemptions', { body })).status).toBe(201);
		const again = await h.call('POST', '/v1/reservations', { body });
		expect(again.json.type).toMatch(/device_limit_reached$/);
		expect(
			(await h.call('POST', '/v1/reservations', { body: { ...body, cart: cart({ context: { deviceId: 'dev_2' } }) } })).status,
		).toBe(201);
	});

	it('stops code guessing with velocity limits and blocks listed subjects', async () => {
		await h.entitle({ config: { limits: { velocity_max_failures: 3, velocity_window_minutes: 10 } } });
		const guess = (/** @type {string} */ code) =>
			h.call('POST', '/v1/validations', {
				key: h.pk,
				headers: { ...ORIGIN, 'x-forwarded-for': '203.0.113.7' },
				body: { code, cart: cart() },
			});
		for (const code of ['GUESS1', 'GUESS2', 'GUESS3']) expect((await guess(code)).json.reason).toBe('code_not_found');
		const limited = await guess('SOCKS20');
		expect(limited.status).toBe(429);
		expect(limited.json.type).toMatch(/velocity_limited$/);
		h.clock.advance(11 * MINUTE);
		expect((await guess('SOCKS20')).json.valid).toBe(true);
		h.clock.set(T0);
		await h.entitle();

		const blocked = await h.call('POST', '/v1/blocks', {
			body: { kind: 'email', value: 'Abuse@Example.com', note: 'chargebacks' },
		});
		expect(blocked.status).toBe(201);
		expect(blocked.json).toMatchObject({ kind: 'email', value: 'abuse@example.com' });
		expect((await h.call('POST', '/v1/blocks', { body: { kind: 'email', value: 'abuse@example.com' } })).status).toBe(409);
		expect((await h.call('POST', '/v1/blocks', { body: { kind: 'ip', value: 'x' } })).status).toBe(422);
		const refused = await h.call('POST', '/v1/validations', {
			body: { code: 'SOCKS20', cart: cart({ customer: { id: 'cus_x', email: 'abuse@example.com' } }) },
		});
		expect(refused.json.reason).toBe('blocked');
		await h.call('POST', '/v1/blocks', { body: { kind: 'code', value: 'socks20' } });
		expect((await h.call('POST', '/v1/validations', { body: { code: 'SOCKS20', cart: cart() } })).json.reason).toBe('blocked');
		const list = await h.call('GET', '/v1/blocks');
		expect(list.json.items).toHaveLength(2);
		for (const entry of list.json.items) expect((await h.call('DELETE', `/v1/blocks/${entry.id}`)).json.deleted).toBe(true);
		expect((await h.call('DELETE', '/v1/blocks/blk_missing')).status).toBe(404);
		expect((await h.call('POST', '/v1/validations', { body: { code: 'SOCKS20', cart: cart() } })).json.valid).toBe(true);
		await h.entitle({ config: { limits: { max_blocks: 1 } } });
		await h.call('POST', '/v1/blocks', { body: { kind: 'device', value: 'dev_bad' } });
		expect((await h.call('POST', '/v1/blocks', { body: { kind: 'device', value: 'dev_bad2' } })).json.type).toMatch(
			/limit_reached$/,
		);
		await h.entitle();
	});
});
