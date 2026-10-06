/**
 * Free-tier hosting model (one daily cron): a lapsed reservation is expired when it is read or touched, before any
 * sweep, and the throttled per-website sweep registered with `product.background.every` expires the rest after requests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SWEEP_EVERY_MS, sweepWebsite } from '../api/routes.js';
import { cart, createHarness, MINUTE, T0, WEBSITE } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
beforeAll(async () => {
	h = await createHarness({ config: { api: { reservation_ttl_minutes: 15 } } });
});
afterAll(async () => h?.close());

/** @param {string} id */
const stored = async (id) => (await h.collection('reservations').findOne({ id }))?.status;

describe('expire on read', () => {
	it('treats a lapsed reservation as expired when it is read, and gives its use back', async () => {
		await h.coupon({ code: 'READ1', action: { type: 'percent', percent: 10 }, limits: { per_code: 1 } });
		const held = await h.call('POST', '/v1/reservations', { body: { codes: ['READ1'], cart: cart() } });
		expect(held.status).toBe(201);
		h.clock.advance(16 * MINUTE);
		expect(await stored(held.json.id)).toBe('reserved');
		const site = /** @type {any} */ (await h.coupons.siteFor(WEBSITE));
		expect((await h.coupons.service.overview(site)).openReservations).toBe(0);
		expect((await h.call('GET', `/v1/reservations/${held.json.id}`)).json.status).toBe('expired');
		expect(await stored(held.json.id)).toBe('expired');
		expect(h.published('coupons.released@1').find((e) => e.data.reservationId === held.json.id)?.data.reason).toBe('expired');
		expect((await h.collection('codes').findOne({ code: 'READ1' }))?.taken ?? 0).toBe(0);
		h.clock.set(T0);
	});

	it('expires a lapsed reservation on release and re-claims it on a late redeem', async () => {
		await h.coupon({ code: 'READ2', action: { type: 'percent', percent: 10 }, limits: { per_code: 1 } });
		const first = await h.call('POST', '/v1/reservations', { body: { codes: ['READ2'], cart: cart() } });
		h.clock.advance(16 * MINUTE);
		const released = await h.call('POST', `/v1/reservations/${first.json.id}/release`, {});
		expect(released.json.status).toBe('expired');
		const second = await h.call('POST', '/v1/reservations', { body: { codes: ['READ2'], cart: cart() } });
		h.clock.advance(16 * MINUTE);
		const late = await h.call('POST', `/v1/reservations/${second.json.id}/redeem`, {});
		expect(late.status).toBe(200);
		expect(late.json.status).toBe('redeemed');
		h.clock.set(T0);
	});

	it('frees a device’s own abandoned use when the same device checks out again', async () => {
		await h.coupon({ code: 'READ3', action: { type: 'percent', percent: 10 }, limits: { per_device: 1 } });
		const body = { codes: ['READ3'], cart: cart({ context: { deviceId: 'dev_lapsed' } }) };
		expect((await h.call('POST', '/v1/reservations', { body })).status).toBe(201);
		expect((await h.call('POST', '/v1/validations', { body: { code: 'READ3', cart: body.cart } })).json.reason).toBe(
			'device_limit_reached',
		);
		h.clock.advance(16 * MINUTE);
		expect((await h.call('POST', '/v1/validations', { body: { code: 'READ3', cart: body.cart } })).json.valid).toBe(true);
		h.clock.set(T0);
	});
});

describe('background sweep', () => {
	it('is registered per website and expires lapsed reservations when triggered (throttled)', async () => {
		await h.coupon({ code: 'BGSWEEP1', action: { type: 'percent', percent: 10 } });
		const held = await h.call('POST', '/v1/reservations', { body: { codes: ['BGSWEEP1'], cart: cart() } });
		h.clock.advance(16 * MINUTE);
		expect(h.coupons.tasks.sweep.name).toBe('sweep');
		expect(await h.coupons.tasks.sweep.trigger({ websiteId: WEBSITE })).toBe(true);
		expect(await stored(held.json.id)).toBe('expired');
		// throttled: at most once per interval per website
		expect(await h.coupons.tasks.sweep.trigger({ websiteId: WEBSITE })).toBe(false);
		h.clock.advance(SWEEP_EVERY_MS);
		expect(await h.coupons.tasks.sweep.trigger({ websiteId: WEBSITE })).toBe(true);
		h.clock.set(T0);
	});

	it('does nothing without a website or past its deadline', async () => {
		expect(await sweepWebsite(h.coupons, { websiteId: null, deadline: Infinity })).toBe(0);
		await h.coupon({ code: 'BGSWEEP2', action: { type: 'percent', percent: 10 } });
		const held = await h.call('POST', '/v1/reservations', { body: { codes: ['BGSWEEP2'], cart: cart() } });
		h.clock.advance(16 * MINUTE);
		expect(await sweepWebsite(h.coupons, { websiteId: WEBSITE, deadline: h.clock.now() })).toBe(0);
		expect(await stored(held.json.id)).toBe('reserved');
		expect(await sweepWebsite(h.coupons, { websiteId: WEBSITE, deadline: h.clock.now() + 1000 })).toBe(1);
		h.clock.set(T0);
	});
});
