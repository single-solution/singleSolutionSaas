/**
 * No timers: a lapsed reservation is expired when it is read or touched (or its code is read, or its code, customer or
 * device needs the use), and the dashboard's "Release expired reservations" releases a website's lapsed ones at once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPIRE_RUN_LIMIT } from '../api/routes.js';
import { cart, createHarness, MERCHANT, MINUTE, T0, WEBSITE } from './harness.js';

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

describe('without timers', () => {
	/** @param {any} kind */
	const launch = async (kind) => {
		const { token } = await h.portal.issueLaunch({
			kind,
			subject: 'usr_merchant',
			user: { id: 'usr_merchant' },
			scope: { merchantId: MERCHANT, websiteId: WEBSITE },
		});
		const sso = await h.handle(new Request(`https://coupons.example.com/sso?launch=${encodeURIComponent(token)}`));
		const session = /ss_session=(ses_[^;]+)/.exec(sso.headers.get('set-cookie') ?? '')?.[1];
		if (!session) throw new Error(`no session (${sso.status})`);
		return session;
	};

	it('registers no periodic work: time passing alone changes nothing stored', async () => {
		expect(h.coupons.product.background.mode).toBe('off');
		expect(/** @type {any} */ (h.coupons).tasks).toBeUndefined();
		await h.coupon({ code: 'IDLE1', action: { type: 'percent', percent: 10 } });
		const held = await h.call('POST', '/v1/reservations', { body: { codes: ['IDLE1'], cart: cart() } });
		h.clock.advance(16 * MINUTE);
		await h.call('GET', '/v1/coupons');
		expect(await stored(held.json.id)).toBe('reserved');
		h.clock.set(T0);
	});

	it('releases the lapsed reservations holding a code when the code is read', async () => {
		await h.coupon({ code: 'CODEREAD', action: { type: 'percent', percent: 10 }, limits: { per_code: 1 } });
		const held = await h.call('POST', '/v1/reservations', { body: { codes: ['CODEREAD'], cart: cart() } });
		expect((await h.call('GET', '/v1/codes/CODEREAD')).json.taken).toBe(1);
		h.clock.advance(16 * MINUTE);
		const read = await h.call('GET', '/v1/codes/CODEREAD');
		expect(read.json.taken).toBe(0);
		expect(await stored(held.json.id)).toBe('expired');
		h.clock.set(T0);
	});

	it('"Release expired reservations" releases the website\'s lapsed reservations at once (dashboard)', async () => {
		await h.coupon({ code: 'BTN1', action: { type: 'percent', percent: 10 } });
		await h.coupon({ code: 'BTN2', action: { type: 'percent', percent: 10 } });
		const one = await h.call('POST', '/v1/reservations', { body: { codes: ['BTN1'], cart: cart() } });
		const two = await h.call('POST', '/v1/reservations', { body: { codes: ['BTN2'], cart: cart() } });
		h.clock.advance(16 * MINUTE);
		const merchant = await launch('merchant');
		const run = await h.call('POST', '/v1/dashboard/reservations:expire', { key: merchant, body: {} });
		expect(run.status, run.text).toBe(200);
		expect(run.json.expired).toBeGreaterThanOrEqual(2);
		expect(run.json.more).toBe(false);
		expect(await stored(one.json.id)).toBe('expired');
		expect(await stored(two.json.id)).toBe('expired');
		expect((await h.call('POST', '/v1/dashboard/reservations:expire', { key: merchant, body: {} })).json).toEqual({
			expired: 0,
			more: false,
		});
		expect(EXPIRE_RUN_LIMIT).toBe(100);
		h.clock.set(T0);
	});
});
