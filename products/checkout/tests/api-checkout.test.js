import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestIdentityIssuer } from '@ss/app-kit/testing';
import { CONNECTED, CRON_SECRET, HOUR, URLS, WEBSITE, WEBSITE_2, checkoutBody, createHarness } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
/** @type {ReturnType<typeof createTestIdentityIssuer>} */
let issuer;
const KEY = 'sk_live_integration_key_0123456789';
const POLICIES = {
	policies: [{ key: 'terms', url: 'https://shop.example.com/terms', required: true, version: '3' }],
	content_url_template: '',
};

/** @param {Record<string, any>} [config] */
const entitle = (config = {}) => h.entitle({ identity: issuer.section, config: { ...CONNECTED, ...config } });

/** @param {string} subject */
const as = (subject) => {
	const now = Math.floor(h.clock.now() / 1000);
	return {
		key: h.pk,
		headers: { 'ss-identity': issuer.sign({ iss: issuer.section.issuer, sub: subject, iat: now, exp: now + 900 }) },
	};
};

/** Mocks of the merchant's other products answering like the real ones. */
const mockProducts = () => {
	h.remote.reset();
	h.remote.on(`POST ${URLS.deals}/v1/quotes/`, (call) => ({
		status: call.url.endsWith('/release') ? 200 : 201,
		body: { status: 'committed' },
	}));
	h.remote.on(`POST ${URLS.deals}/v1/quotes$`, (call) => ({
		status: 201,
		body: {
			id: 'qte_1',
			discountTotal: call.body.lines[0].unitAmount >= 2500 ? 500 : 0,
			lines: [{ lineId: call.body.lines[0].lineId, discount: call.body.lines[0].unitAmount >= 2500 ? 500 : 0 }],
			shipping: { discount: 0, free: false },
			deals: [{ dealId: 'dl_1', name: 'Autumn', amount: 500 }],
			couponsAllowed: true,
			loyaltyAllowed: true,
		},
	}));
	h.remote.on(`POST ${URLS.coupons}/v1/quotes`, (call) => {
		const ok = call.body.codes.includes('SAVE10');
		return {
			status: 200,
			body: {
				discount: ok ? 1000 : 0,
				shippingDiscount: 0,
				applied: ok ? [{ code: 'SAVE10', name: 'Ten', discount: 1000, shippingDiscount: 0 }] : [],
				rejected: call.body.codes
					.filter((/** @type {string} */ c) => c !== 'SAVE10')
					.map((/** @type {string} */ code) => ({ code, reason: 'code_not_found' })),
				dealsAllowed: true,
				loyaltyAllowed: true,
			},
		};
	});
	h.remote.on(`POST ${URLS.coupons}/v1/reservations`, (call) =>
		call.url.endsWith('/v1/reservations')
			? { status: 201, body: { id: 'rsv_1', status: 'reserved' } }
			: { status: 200, body: { id: 'rsv_1' } },
	);
	h.remote.on(`POST ${URLS.loyalty}/v1/redemptions:quote`, () => ({
		status: 200,
		body: { allowed: true, balance: 900, minPoints: 100, maxPoints: 800, maxValue: 800, pointValue: { points: 1, value: 1 } },
	}));
	h.remote.on(`POST ${URLS.loyalty}/v1/redemptions/`, () => ({ status: 200, body: { id: 'red_1' } }));
	h.remote.on(`POST ${URLS.loyalty}/v1/redemptions$`, () => ({ status: 201, body: { id: 'red_1', status: 'applied' } }));
	h.remote.on(`HEAD https://`, () => ({
		status: 200,
		headers: { 'content-length': '2048', 'content-type': 'image/png', etag: '"e"' },
	}));
};

beforeAll(async () => {
	h = await createHarness({ config: CONNECTED });
	issuer = createTestIdentityIssuer({ issuer: 'https://id.shop.example.com' });
	await entitle();
	await h.call('PUT', '/v1/integrations/key', { body: { key: KEY } });
	await h.item('itm_a', { variants: [{ variantId: 'v', price: 2500, available: 10 }] });
	await h.item('itm_b', { requiresShipping: false, variants: [{ variantId: 'v', price: 1000, available: null }] });
	await h.item('itm_last', { variants: [{ variantId: 'v', price: 3000, available: 1 }] });
}, 60_000);
afterAll(async () => h?.close());
beforeEach(() => mockProducts());

describe('form, quotes, integrations', () => {
	it('serves the form, validates it, and saves / lists addresses', async () => {
		const form = await h.call('GET', '/v1/checkout-form?country=DE', { key: h.pk });
		expect(form.json.contact.map((/** @type {any} */ f) => f.key)).toEqual(['name', 'email', 'phone']);
		expect(form.json.deliveryMethods.map((/** @type {any} */ m) => m.key)).toEqual(['standard', 'pickup']);
		const bad = await h.call('POST', '/v1/checkout-form:validate', {
			key: h.pk,
			body: { contact: { email: 'x' }, deliveryMethod: 'standard' },
		});
		expect(bad.json.valid).toBe(false);
		expect(bad.json.errors.map((/** @type {any} */ e) => e.path)).toContain('/address/line1');
		const good = await h.call('POST', '/v1/checkout-form:validate', {
			key: h.pk,
			body: { ...checkoutBody(), needsShipping: false },
		});
		expect(good.json.valid).toBe(true);
		expect((await h.call('GET', '/v1/addresses', { key: h.pk })).status).toBe(401);
		expect((await h.call('GET', '/v1/addresses')).json.items).toEqual([]);
		expect((await h.call('DELETE', '/v1/addresses/nope', as('user_x'))).status).toBe(404);
	});

	it('manages the integration key, policies, the gate, offers and loyalty status', async () => {
		expect((await h.call('GET', '/v1/integrations')).json).toMatchObject({
			key: 'sk_live_…6789',
			coupons: true,
			deals: true,
			loyalty: true,
			catalog: true,
		});
		expect((await h.call('PUT', '/v1/integrations/key', { body: { key: 'pk_nope' } })).status).toBe(422);
		expect((await h.call('DELETE', '/v1/integrations/key')).json.key).toBeNull();
		expect((await h.call('GET', '/v1/offers', { key: h.pk })).json).toMatchObject({ coupons: false });
		await h.call('PUT', '/v1/integrations/key', { body: { key: KEY } });
		expect((await h.call('GET', '/v1/offers', { key: h.pk })).json).toMatchObject({ coupons: true, deals: true, maxCodes: 2 });
		expect((await h.call('GET', '/v1/loyalty', as('user_l'))).json).toEqual({ connected: true, signedIn: true });
		await entitle({
			policies_notice: POLICIES,
			signin_gate: { required: 'over_amount', over_amount: 100, signin_url: '/login' },
		});
		expect((await h.call('GET', '/v1/policies', { key: h.pk })).json.items[0]).toMatchObject({ key: 'terms', required: true });
		const gate = await h.call('GET', '/v1/signin-gate?total=500&return=%2Fcheckout', { key: h.pk });
		expect(gate.json).toEqual({
			policy: 'over_amount',
			required: true,
			signedIn: false,
			signinUrl: '/login?return=%2Fcheckout',
		});
		await entitle();
		expect(
			(await h.call('GET', '/v1/payment-methods', { key: h.pk })).json.methods.map((/** @type {any} */ m) => m.key),
		).toEqual(['bank_transfer', 'cod', 'pickup_pay', 'gateway']);
	});

	it('quotes with deals, coupons and points from their products', async () => {
		const cartId = await h.cartWith([{ itemId: 'itm_a', quantity: 2 }]);
		const q = await h.call('POST', '/v1/quotes', {
			...as('user_q'),
			body: { cartId, deliveryMethod: 'standard', paymentMethod: 'cod', codes: ['SAVE10', 'NOPE'], loyaltyPoints: 200 },
		});
		expect(q.status).toBe(200);
		expect(q.json.totals).toMatchObject({
			subtotal: 5000,
			itemDiscount: 500,
			couponDiscount: 1000,
			shipping: 500,
			loyalty: 200,
			total: 3800,
		});
		expect(q.json.codes.rejected).toEqual([{ code: 'NOPE', reason: 'code_not_found' }]);
		expect(q.json.paymentMethods.find((/** @type {any} */ m) => m.key === 'cod').available).toBe(true);
		const couponCall = h.remote.calls.find((c) => c.url === `${URLS.coupons}/v1/quotes`);
		expect(couponCall?.body.cart.lines[0].unitAmount).toBe(2250);
		const offers = await h.call('POST', '/v1/offers:check', { key: h.pk, body: { cartId, codes: ['SAVE10'] } });
		expect(offers.json.codes.applied[0].code).toBe('SAVE10');
		const loyalty = await h.call('POST', '/v1/loyalty:quote', { ...as('user_q'), body: { cartId } });
		expect(loyalty.json).toMatchObject({ allowed: true, maxPoints: 800 });
		expect((await h.call('POST', '/v1/loyalty:quote', { key: h.pk, body: { cartId } })).status).toBe(401);
		expect((await h.call('POST', '/v1/quotes', { key: h.pk, body: { lines: [{ itemId: 'itm_a' }] } })).status).toBe(422);
		expect(
			(await h.call('POST', '/v1/quotes', { key: h.pk, body: { lines: [{ itemId: 'itm_zz', quantity: 1 }] } })).status,
		).toBe(409);
		const direct = await h.call('POST', '/v1/quotes', {
			body: { lines: [{ itemId: 'itm_b', quantity: 1 }], loyaltyPoints: 50 },
		});
		expect(direct.json.loyalty.refused).toBe('identity_required');
	});

	it('goes on without a product that does not answer, and says so', async () => {
		h.remote.reset();
		const cartId = await h.cartWith([{ itemId: 'itm_a', quantity: 1 }]);
		const q = await h.call('POST', '/v1/quotes', { ...as('user_w'), body: { cartId, codes: ['SAVE10'], loyaltyPoints: 100 } });
		expect(q.json.warnings).toEqual(
			expect.arrayContaining(['deals_unavailable', 'coupons_unavailable', 'loyalty_unavailable']),
		);
		expect(q.json.codes.rejected[0].reason).toBe('coupons_unavailable');
		expect((await h.call('POST', '/v1/loyalty:quote', { ...as('user_w'), body: { cartId } })).status).toBe(503);
		await h.call('DELETE', '/v1/integrations/key');
		const none = await h.call('POST', '/v1/quotes', {
			...as('user_w'),
			body: { cartId, codes: ['SAVE10'], loyaltyPoints: 100 },
		});
		expect(none.json).toMatchObject({ warnings: [], loyalty: { refused: 'loyalty_unavailable' } });
		expect((await h.call('POST', '/v1/loyalty:quote', { ...as('user_w'), body: { cartId } })).status).toBe(503);
		await h.call('PUT', '/v1/integrations/key', { body: { key: KEY } });
	});
});

describe('placement', () => {
	it('places a bank-transfer order atomically, idempotently, with offers and points', async () => {
		const who = as('user_ada');
		const cartId = await h.cartWith([{ itemId: 'itm_a', quantity: 2 }], who);
		const body = checkoutBody({ cartId, codes: ['SAVE10'], loyaltyPoints: 200, saveAddress: true, note: 'ring twice' });
		const placed = await h.call('POST', '/v1/orders', { ...who, body, idempotencyKey: 'idk_place_1' });
		expect(placed.status, placed.text).toBe(201);
		expect(placed.json).toMatchObject({
			status: 'pending_payment',
			totals: { total: 3800 },
			payment: { method: 'bank_transfer', dueNow: 3800 },
		});
		expect(placed.json.accessToken).toMatch(/^oat_/);
		expect(placed.json.offers).toMatchObject({ codes: ['SAVE10'], loyaltyPoints: 200 });
		const replay = await h.call('POST', '/v1/orders', { ...who, body, idempotencyKey: 'idk_place_1' });
		expect(replay.json.id).toBe(placed.json.id);
		const stock = (await h.call('GET', '/v1/items/itm_a')).json.variants[0].available;
		expect(stock).toBe(8);
		expect((await h.call('GET', `/v1/carts/${cartId}`)).json.status).toBe('converted');
		const placedEvents = h.published('order.placed@1');
		expect(placedEvents.at(-1).data).toMatchObject({
			orderId: placed.json.id,
			currency: 'EUR',
			customer: { subject: 'user_ada', email: 'ada@example.com' },
		});
		const urls = h.remote.calls.map((c) => `${c.method} ${c.url}`);
		expect(urls).toEqual(
			expect.arrayContaining([
				`POST ${URLS.coupons}/v1/reservations`,
				`POST ${URLS.loyalty}/v1/redemptions`,
				`POST ${URLS.deals}/v1/quotes/qte_1/commit`,
				`POST ${URLS.coupons}/v1/reservations/rsv_1/redeem`,
			]),
		);
		expect((await h.call('GET', '/v1/addresses', who)).json.items).toHaveLength(1);
		const address = (await h.call('GET', '/v1/addresses', who)).json.items[0].id;
		// order access: the shopper, the token, the server; nobody else
		expect((await h.call('GET', `/v1/orders/${placed.json.id}`, who)).status).toBe(200);
		expect((await h.call('GET', `/v1/orders/${placed.json.id}`, { key: h.pk })).status).toBe(404);
		expect(
			(await h.call('POST', `/v1/orders/${placed.json.id}/view`, { key: h.pk, body: { token: placed.json.accessToken } }))
				.status,
		).toBe(200);
		expect(
			(await h.call('POST', `/v1/orders/${placed.json.id}/view`, { key: h.pk, body: { token: 'oat_wrong' } })).status,
		).toBe(404);
		expect((await h.call('GET', '/v1/orders?limit=1')).json.items).toHaveLength(1);
		expect((await h.call('DELETE', `/v1/addresses/${address}`, who)).status).toBe(200);
		const success = await h.call('POST', '/v1/success-views', {
			key: h.pk,
			body: { orderId: placed.json.id, token: placed.json.accessToken },
		});
		expect(success.json).toMatchObject({ proofUpload: true, bankDetails: [{ label: 'IBAN' }] });
		expect(success.json.steps.map((/** @type {any} */ s) => s.text)[0]).toContain('quoting order');
		expect((await h.call('GET', `/v1/success-views/${placed.json.id}`, who)).status).toBe(200);
		expect((await h.call('GET', '/v1/success-views/nope', who)).status).toBe(404);
	});

	it('never oversells: of two checkouts for the last unit exactly one wins', async () => {
		const results = await Promise.all(
			['a', 'b'].map((n) =>
				h.call('POST', '/v1/orders', {
					key: h.pk,
					body: checkoutBody({
						lines: [{ itemId: 'itm_last', quantity: 1 }],
						contact: { name: 'N', phone: `+4412345678${n === 'a' ? '1' : '2'}` },
					}),
				}),
			),
		);
		expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
		expect((await h.call('GET', '/v1/items/itm_last')).json.variants[0].available).toBe(0);
	});

	it('cash on delivery: surcharge, cap, confirmation step that expires, open-order cap', async () => {
		await entitle({
			payment_manual: { ...CONNECTED.payment_manual, cod_surcharge_bp: 200, cod_max_order: 100_000, max_open_orders: 2 },
		});
		const body = checkoutBody({
			lines: [{ itemId: 'itm_b', quantity: 1 }],
			paymentMethod: 'cod',
			deliveryMethod: 'standard',
			contact: { name: 'Cod', phone: '+447700900001' },
		});
		const placed = await h.call('POST', '/v1/orders', { key: h.pk, body });
		expect(placed.json).toMatchObject({ status: 'awaiting_confirmation', totals: { surcharge: 20, total: 1520 } });
		await h.call('POST', '/v1/orders', { key: h.pk, body });
		const third = await h.call('POST', '/v1/orders', { key: h.pk, body });
		expect(third.json.type).toMatch(/open_orders_limit$/);
		await entitle({ payment_manual: { ...CONNECTED.payment_manual, cod_max_order: 1000 } });
		const capped = await h.call('POST', '/v1/orders', {
			key: h.pk,
			body: { ...body, contact: { name: 'Other', phone: '+447700900002' } },
		});
		expect(capped.json.errors[0]).toMatchObject({ path: '/paymentMethod', code: 'over_cap' });
		await entitle();
		// the confirmation hold expires: the sweep cancels it, gives the stock back, publishes order.cancelled@1
		h.clock.advance(25 * HOUR);
		const swept = await h.call('GET', '/cron/sweep', { key: null, headers: { authorization: `Bearer ${CRON_SECRET}` } });
		expect(swept.status).toBe(200);
		expect(swept.json.results[0].expired).toBeGreaterThanOrEqual(2);
		expect((await h.call('GET', `/v1/orders/${placed.json.id}`)).json).toMatchObject({ status: 'cancelled' });
		expect(h.published('order.cancelled@1').some((e) => e.data.orderId === placed.json.id && e.data.reason === 'expired')).toBe(
			true,
		);
		expect((await h.call('GET', '/cron/sweep', { key: null })).status).toBe(401);
	});

	it('refuses what it must, and compensates other products when placement fails', async () => {
		const base = checkoutBody({ lines: [{ itemId: 'itm_a', quantity: 1 }] });
		expect((await h.call('POST', '/v1/orders', { key: h.pk, body: { ...base, lines: undefined } })).status).toBe(422);
		expect((await h.call('POST', '/v1/orders', { key: h.pk, body: base, idempotencyKey: null })).status).toBe(428);
		expect((await h.call('POST', '/v1/orders', { key: h.pk, body: { ...base, contact: {} } })).status).toBe(422);
		expect(
			(await h.call('POST', '/v1/orders', { key: h.pk, body: { ...base, lines: [{ itemId: 'itm_zz', quantity: 1 }] } }))
				.status,
		).toBe(409);
		expect(
			(await h.call('POST', '/v1/orders', { key: h.pk, body: { ...base, lines: [{ itemId: 'itm_a', quantity: 9 }] } })).json
				.type,
		).toMatch(/insufficient_stock$/);
		expect((await h.call('POST', '/v1/orders', { key: h.pk, body: { ...base, codes: ['NOPE'] } })).json.type).toMatch(
			/offer_unavailable$/,
		);
		expect((await h.call('POST', '/v1/orders', { key: h.pk, body: { ...base, loyaltyPoints: 100 } })).json.type).toMatch(
			/identity_required$/,
		);
		expect((await h.call('POST', '/v1/orders', { key: h.pk, body: { ...base, expectedTotal: 1 } })).json).toMatchObject({
			totals: { total: 2500 },
		});
		expect((await h.call('POST', '/v1/orders', { key: h.pk, body: { ...base, paymentMethod: 'pickup_pay' } })).status).toBe(
			422,
		);
		expect(
			(await h.call('POST', '/v1/orders', { key: h.pk, body: { ...base, cartId: 'crt_none', lines: undefined } })).status,
		).toBe(404);
		const empty = await h.call('POST', '/v1/carts', { key: h.pk, body: {} });
		expect(
			(await h.call('POST', '/v1/orders', { key: h.pk, body: { ...base, cartId: empty.json.id, lines: undefined } })).json
				.type,
		).toMatch(/cart_empty$/);
		// consents and the sign-in gate
		await entitle({ policies_notice: POLICIES, signin_gate: { required: 'for_cod' } });
		expect((await h.call('POST', '/v1/orders', { key: h.pk, body: base })).json.type).toMatch(/consent_required$/);
		expect(
			(await h.call('POST', '/v1/orders', { key: h.pk, body: { ...base, consents: ['terms'], paymentMethod: 'cod' } })).json
				.type,
		).toMatch(/identity_required$/);
		const consented = await h.call('POST', '/v1/orders', { key: h.pk, body: { ...base, consents: ['terms'] } });
		expect(consented.status).toBe(201);
		await entitle();
		// blocklist
		const block = await h.call('POST', '/v1/blocks', { body: { kind: 'email', value: 'BLOCKED@example.com' } });
		expect(block.status).toBe(201);
		expect((await h.call('POST', '/v1/blocks', { body: { kind: 'email', value: 'blocked@example.com' } })).status).toBe(409);
		expect((await h.call('POST', '/v1/blocks', { body: { kind: 'x' } })).status).toBe(422);
		expect((await h.call('GET', '/v1/blocks')).json.items).toHaveLength(1);
		expect(
			(
				await h.call('POST', '/v1/orders', {
					key: h.pk,
					body: { ...base, contact: { name: 'B', email: 'blocked@example.com', phone: '+447700900009' } },
				})
			).status,
		).toBe(403);
		expect((await h.call('DELETE', `/v1/blocks/${block.json.id}`)).status).toBe(200);
		expect((await h.call('DELETE', `/v1/blocks/${block.json.id}`)).status).toBe(404);
		// a refused deal commit releases the coupon reservation and the points
		h.remote.on(`POST ${URLS.deals}/v1/quotes/qte_1/commit`, () => ({
			status: 409,
			body: { type: 'https://deals.test/problems/deal_exhausted' },
		}));
		const failed = await h.call('POST', '/v1/orders', {
			...as('user_c'),
			body: { ...base, codes: ['SAVE10'], loyaltyPoints: 100 },
		});
		expect(failed.json.type).toMatch(/offer_unavailable$/);
		const urls = h.remote.calls.map((c) => `${c.method} ${c.url}`);
		expect(urls).toEqual(
			expect.arrayContaining([
				`POST ${URLS.loyalty}/v1/redemptions/red_1/release`,
				`POST ${URLS.coupons}/v1/reservations/rsv_1/release`,
			]),
		);
		// refused points and coupons
		h.remote.on(`POST ${URLS.loyalty}/v1/redemptions$`, () => ({ status: 409, body: { type: 'x/insufficient_points' } }));
		expect((await h.call('POST', '/v1/orders', { ...as('user_c'), body: { ...base, loyaltyPoints: 100 } })).json.type).toMatch(
			/points_unavailable$/,
		);
		h.remote.on(`POST ${URLS.coupons}/v1/reservations`, () => ({ status: 409, body: { type: 'x/exhausted' } }));
		expect((await h.call('POST', '/v1/orders', { key: h.pk, body: { ...base, codes: ['SAVE10'] } })).json.type).toMatch(
			/offer_unavailable$/,
		);
	});

	it('reserves stock in the Catalog product when it is the stock source', async () => {
		await entitle({ place_order: { stock_source: 'catalog' } });
		h.remote.on(`POST ${URLS.catalog}/v1/stock-reservations`, () => ({ status: 201, body: { id: 'res_1', status: 'held' } }));
		h.remote.on(`DELETE ${URLS.catalog}/v1/stock-reservations/`, () => ({ status: 200, body: {} }));
		const placed = await h.call('POST', '/v1/orders', {
			body: checkoutBody({
				lines: [{ itemId: 'itm_b', quantity: 1 }],
				customer: { subject: 'srv_1', email: 'srv@example.com' },
			}),
		});
		expect(placed.status).toBe(201);
		const cancelled = await h.call('POST', `/v1/orders/${placed.json.id}/cancel`, { body: { reason: 'oos' } });
		expect(cancelled.json.status).toBe('cancelled');
		expect(h.remote.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/v1/stock-reservations/res_1'))).toBe(true);
		h.remote.on(`POST ${URLS.catalog}/v1/stock-reservations`, () => ({ status: 409, body: { type: 'x/insufficient_stock' } }));
		expect(
			(await h.call('POST', '/v1/orders', { body: checkoutBody({ lines: [{ itemId: 'itm_b', quantity: 1 }] }) })).json.type,
		).toMatch(/insufficient_stock$/);
		h.remote.reset();
		expect(
			(await h.call('POST', '/v1/orders', { body: checkoutBody({ lines: [{ itemId: 'itm_b', quantity: 1 }] }) })).status,
		).toBe(503);
		await entitle();
	});

	it('runs the placement without a transaction on a standalone database, compensating its steps', async () => {
		const site = await h.application.siteFor(WEBSITE, 'place_order');
		if (!site) throw new Error('no site');
		const standalone = {
			...site,
			repos: {
				...site.repos,
				transaction: async () =>
					Promise.reject(
						Object.assign(new Error('Transaction numbers are only allowed on a replica set member'), { code: 20 }),
					),
			},
		};
		const order = (/** @type {string} */ id) => ({
			id,
			number: id,
			idempotencyKey: id,
			status: 'confirmed',
			placedAt: new Date(),
			lines: [],
		});
		await h.application.placement.commitLocal(/** @type {any} */ (standalone), order('ord_seq_1'), [
			{ itemId: 'itm_a', variantId: 'v', quantity: 1 },
		]);
		const before = (await h.call('GET', '/v1/items/itm_a')).json.variants[0].available;
		await expect(
			h.application.placement.commitLocal(/** @type {any} */ (standalone), order('ord_seq_2'), [
				{ itemId: 'itm_a', variantId: 'v', quantity: 1 },
				{ itemId: 'itm_last', variantId: 'v', quantity: 1 },
			]),
		).rejects.toMatchObject({ refusal: 'insufficient_stock' });
		await expect(
			h.application.placement.commitLocal(/** @type {any} */ (standalone), order('ord_seq_1'), [
				{ itemId: 'itm_a', variantId: 'v', quantity: 1 },
			]),
		).rejects.toMatchObject({ code: 11000 });
		expect((await h.call('GET', '/v1/items/itm_a')).json.variants[0].available).toBe(before);
		const broken = { ...site, repos: { ...site.repos, transaction: async () => Promise.reject(new Error('boom')) } };
		await expect(h.application.placement.commitLocal(/** @type {any} */ (broken), order('ord_seq_3'), [])).rejects.toThrow(
			'boom',
		);
	});
});

describe('after placement', () => {
	/** @param {Record<string, unknown>} [extra] */
	const place = async (extra = {}) => {
		const result = await h.call('POST', '/v1/orders', {
			key: h.pk,
			body: checkoutBody({
				lines: [{ itemId: 'itm_b', quantity: 1 }],
				contact: { name: 'P', phone: `+4477009${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}` },
				...extra,
			}),
		});
		if (result.status !== 201) throw new Error(result.text);
		return result.json;
	};

	it('confirms, records payments (A22), cancels by the shopper and by the merchant', async () => {
		const order = await place();
		expect((await h.call('POST', `/v1/orders/${order.id}/payments`, { body: { amount: 0 } })).status).toBe(422);
		const paid = await h.call('POST', `/v1/orders/${order.id}/payments`, {
			body: { amount: order.totals.total, method: 'bank_transfer', reference: 'TRX-1' },
		});
		expect(paid.json).toMatchObject({
			status: 'confirmed',
			payment: { status: 'paid', reference: 'TRX-1' },
			payments: [{ amount: order.totals.total, reference: 'TRX-1' }],
		});
		expect(h.published('order.paid@1').some((e) => e.data.orderId === order.id)).toBe(true);
		expect(h.published('checkout.order_confirmed@1').some((e) => e.data.orderId === order.id && e.data.by === 'payment')).toBe(
			true,
		);
		expect((await h.call('POST', `/v1/orders/${order.id}/confirm`)).status).toBe(409);
		expect(
			(await h.call('POST', `/v1/orders/${order.id}/cancel`, { key: h.pk, body: { token: order.accessToken } })).status,
		).toBe(409);
		const cod = await place({ paymentMethod: 'cod' });
		expect((await h.call('POST', `/v1/orders/${cod.id}/confirm`)).json.status).toBe('confirmed');
		const mine = await place({ paymentMethod: 'cod' });
		const cancelled = await h.call('POST', `/v1/orders/${mine.id}/cancel`, { key: h.pk, body: { token: mine.accessToken } });
		expect(cancelled.json).toMatchObject({ status: 'cancelled', cancellable: false });
		expect((await h.call('POST', `/v1/orders/${mine.id}/cancel`, { key: h.pk, body: { token: 'wrong' } })).status).toBe(404);
		expect((await h.call('POST', '/v1/orders/ord_nope/confirm')).status).toBe(404);
		expect((await h.call('POST', '/v1/orders/ord_nope/payments', { body: { amount: 1 } })).status).toBe(404);
		expect((await h.call('POST', `/v1/orders/${cod.id}/cancel`, { body: {} })).json.status).toBe('cancelled');
		expect((await h.call('GET', `/v1/success-views/${cod.id}`)).json.title).toBe('This order was cancelled');
	});

	it('applies the Order Manager lifecycle from events (paid, completed, cancelled, refunded)', async () => {
		const a = await place();
		await h.deliver('order.paid@1', {
			orderId: a.id,
			amount: { amount: a.totals.total, currency: 'EUR' },
			method: 'bank_transfer',
			reference: 'B1',
		});
		await h.deliver('order.paid@1', { orderId: a.id, amount: { amount: 1, currency: 'USD' } });
		await h.deliver('order.completed@1', { orderId: a.id });
		const refund = { orderId: a.id, amount: { amount: a.totals.total, currency: 'EUR' }, reason: 'return' };
		await h.deliver('order.refunded@1', refund, { id: 'evt_refund_1' });
		await h.deliver('order.refunded@1', { orderId: a.id, amount: {} });
		const after = (await h.call('GET', `/v1/orders/${a.id}`)).json;
		expect(after).toMatchObject({
			status: 'refunded',
			payment: { status: 'refunded' },
			refunds: [{ amount: a.totals.total, reason: 'return' }],
		});
		const b = await place({ paymentMethod: 'cod' });
		await h.deliver('order.cancelled@1', { orderId: b.id, reason: 'customer_called' });
		expect((await h.call('GET', `/v1/orders/${b.id}`)).json.status).toBe('cancelled');
		await h.deliver('order.cancelled@1', { orderId: 'ord_not_ours' });
		await h.deliver('order.completed@1', {});
	});

	it('takes bank-transfer proofs into the merchant storage with signed length', async () => {
		const order = await place();
		const started = await h.call('POST', '/v1/payment-proofs', {
			key: h.pk,
			body: { orderId: order.id, token: order.accessToken, contentType: 'image/png', size: 2048, reference: 'TRX-9' },
		});
		expect(started.status).toBe(201);
		expect(started.json.upload).toMatchObject({ method: 'PUT' });
		expect(started.json.upload.headers['content-length'] ?? started.json.upload.headers['Content-Length']).toBe('2048');
		const proofId = started.json.proofId;
		const done = await h.call('POST', `/v1/payment-proofs/${proofId}/complete`, {
			key: h.pk,
			body: { orderId: order.id, token: order.accessToken },
		});
		expect(done.json).toEqual({ proofId, status: 'submitted' });
		expect(
			(
				await h.call('POST', `/v1/payment-proofs/${proofId}/complete`, {
					key: h.pk,
					body: { orderId: order.id, token: order.accessToken },
				})
			).json.status,
		).toBe('submitted');
		expect(h.published('checkout.payment_proof_submitted@1').some((e) => e.data.proofId === proofId)).toBe(true);
		const link = await h.call('GET', `/v1/payment-proofs/${proofId}?orderId=${order.id}`);
		expect(link.json.url).toMatch(/^https:/);
		expect((await h.call('GET', `/v1/payment-proofs/${proofId}`)).status).toBe(404);
		expect(
			(
				await h.call('POST', '/v1/payment-proofs', {
					key: h.pk,
					body: { orderId: order.id, token: order.accessToken, contentType: 'text/html', size: 1 },
				})
			).status,
		).toBe(422);
		expect(
			(
				await h.call('POST', '/v1/payment-proofs', {
					key: h.pk,
					body: { orderId: 'ord_x', contentType: 'image/png', size: 1 },
				})
			).status,
		).toBe(404);
		expect(
			(
				await h.call('POST', '/v1/payment-proofs/prf_x/complete', {
					key: h.pk,
					body: { orderId: order.id, token: order.accessToken },
				})
			).status,
		).toBe(404);
		// the file did not arrive
		const second = await h.call('POST', '/v1/payment-proofs', {
			key: h.pk,
			body: { orderId: order.id, token: order.accessToken, contentType: 'image/png', size: 999 },
		});
		expect(
			(
				await h.call('POST', `/v1/payment-proofs/${second.json.proofId}/complete`, {
					key: h.pk,
					body: { orderId: order.id, token: order.accessToken },
				})
			).json.type,
		).toMatch(/proof_not_uploaded$/);
		await entitle({ payment_proofs: { reference_required: true, max_proofs_per_order: 2 } });
		expect(
			(
				await h.call('POST', '/v1/payment-proofs', {
					key: h.pk,
					body: { orderId: order.id, token: order.accessToken, contentType: 'image/png', size: 5 },
				})
			).status,
		).toBe(422);
		expect(
			(
				await h.call('POST', '/v1/payment-proofs', {
					key: h.pk,
					body: { orderId: order.id, token: order.accessToken, contentType: 'image/png', size: 5, reference: 'R' },
				})
			).json.type,
		).toMatch(/proof_limit$/);
		await entitle();
		const cod = await place({ paymentMethod: 'cod' });
		expect(
			(
				await h.call('POST', '/v1/payment-proofs', {
					key: h.pk,
					body: { orderId: cod.id, token: cod.accessToken, contentType: 'image/png', size: 5 },
				})
			).status,
		).toBe(409);
	});

	it('pays online through the gateway adapter (preview) and its webhook', async () => {
		const order = await place({ paymentMethod: 'gateway' });
		expect(order.status).toBe('pending_payment');
		expect(
			(
				await h.call('POST', '/v1/payments', {
					key: h.pk,
					body: { orderId: order.id, token: order.accessToken, returnUrl: 'https://evil.test/r' },
				})
			).status,
		).toBe(422);
		const started = await h.call('POST', '/v1/payments', {
			key: h.pk,
			body: { orderId: order.id, token: order.accessToken, returnUrl: 'https://shop.example.com/return' },
		});
		expect(started.status).toBe(201);
		expect(started.json).toMatchObject({ status: 'pending' });
		expect(started.json.redirectUrl).toContain('payment=');
		const refreshed = await h.call('POST', `/v1/payments/${started.json.paymentId}/refresh`, {
			key: h.pk,
			body: { orderId: order.id, token: order.accessToken },
		});
		expect(refreshed.json.status).toBe('paid');
		expect((await h.call('GET', `/v1/orders/${order.id}`)).json).toMatchObject({
			status: 'confirmed',
			payment: { status: 'paid' },
		});
		expect(
			(
				await h.call('POST', '/v1/payments/tpay_x/refresh', {
					key: h.pk,
					body: { orderId: order.id, token: order.accessToken },
				})
			).status,
		).toBe(404);
		expect(
			(
				await h.call('POST', '/v1/payments', {
					key: h.pk,
					body: { orderId: order.id, token: order.accessToken, returnUrl: 'https://shop.example.com/r' },
				})
			).status,
		).toBe(409);
		// webhook
		const other = await place({ paymentMethod: 'gateway' });
		const pay = await h.call('POST', '/v1/payments', {
			key: h.pk,
			body: { orderId: other.id, token: other.accessToken, returnUrl: 'https://shop.example.com/r' },
		});
		const raw = JSON.stringify({ paymentId: pay.json.paymentId, orderId: other.id, status: 'succeeded' });
		const signature = createHmac('sha256', 'whsec_test_0123456789').update(raw).digest('hex');
		expect(
			(await h.call('POST', `/webhooks/payments/${WEBSITE}`, { key: null, raw, headers: { 'x-test-signature': 'bad' } }))
				.status,
		).toBe(401);
		expect(
			(await h.call('POST', `/webhooks/payments/${WEBSITE}`, { key: null, raw, headers: { 'x-test-signature': signature } }))
				.status,
		).toBe(200);
		expect((await h.call('GET', `/v1/orders/${other.id}`)).json.payment.status).toBe('paid');
		expect((await h.call('POST', '/webhooks/payments/web_unknownunknownunknownun', { key: null, raw })).status).toBe(404);
		const pending = JSON.stringify({ paymentId: 'x', status: 'pending' });
		const sig2 = createHmac('sha256', 'whsec_test_0123456789').update(pending).digest('hex');
		expect(
			(
				await h.call('POST', `/webhooks/payments/${WEBSITE}`, {
					key: null,
					raw: pending,
					headers: { 'x-test-signature': sig2 },
				})
			).status,
		).toBe(200);
	});

	it('publishes abandoned carts once', async () => {
		const id = await h.cartWith([{ itemId: 'itm_b', quantity: 1 }]);
		h.clock.advance(30 * HOUR);
		await entitle();
		const first = await h.call('GET', '/cron/sweep', { key: null, headers: { authorization: `Bearer ${CRON_SECRET}` } });
		await h.call('GET', '/cron/sweep', { key: null, headers: { authorization: `Bearer ${CRON_SECRET}` } });
		const cart = await h.collection('carts').findOne({ id });
		expect(
			h.published('checkout.cart_abandoned@1').filter((e) => e.data.cartId === id),
			`${first.text} ${JSON.stringify(cart)}`,
		).toHaveLength(1);
	});
});

describe('expiry without a sweep (free-tier hosting: daily cron + work on requests)', () => {
	it('treats an expired hold as expired on read and releases it on access', async () => {
		await entitle({ payment_manual: { ...CONNECTED.payment_manual, max_open_orders: 1 } });
		await h.item('itm_hold', { variants: [{ variantId: 'v', price: 2000, available: 1 }] });
		/** @param {string} phone */
		const body = (phone) =>
			checkoutBody({ lines: [{ itemId: 'itm_hold', quantity: 1 }], paymentMethod: 'cod', contact: { name: 'Hold', phone } });
		const first = await h.call('POST', '/v1/orders', { key: h.pk, body: body('+447700900111') });
		expect(first.json.status).toBe('awaiting_confirmation');
		const capped = await h.call('POST', '/v1/orders', {
			key: h.pk,
			body: checkoutBody({
				lines: [{ itemId: 'itm_b', quantity: 1 }],
				paymentMethod: 'cod',
				contact: { name: 'Hold', phone: '+447700900111' },
			}),
		});
		expect(capped.json.type).toMatch(/open_orders_limit$/);
		const soldOut = await h.call('POST', '/v1/orders', { key: h.pk, body: body('+447700900112') });
		expect(soldOut.json.type).toMatch(/cart_unavailable_lines$/);

		// the confirmation hold passes; no sweep runs: the expired order is not open and its unit is released on access
		h.clock.advance(25 * HOUR);
		const second = await h.call('POST', '/v1/orders', { key: h.pk, body: body('+447700900111') });
		expect(second.status, second.text).toBe(201);
		expect((await h.collection('orders').findOne({ id: first.json.id }))?.status).toBe('cancelled');
		expect(h.published('order.cancelled@1').some((e) => e.data.orderId === first.json.id && e.data.reason === 'expired')).toBe(
			true,
		);

		// reading an expired order cancels it and gives the stock back
		h.clock.advance(25 * HOUR);
		await entitle({ payment_manual: { ...CONNECTED.payment_manual, max_open_orders: 1 } });
		expect((await h.collection('orders').findOne({ id: second.json.id }))?.status).toBe('awaiting_confirmation');
		expect((await h.call('GET', `/v1/orders/${second.json.id}`)).json).toMatchObject({ status: 'cancelled' });
		expect((await h.call('GET', '/v1/items/itm_hold')).json.variants[0].available).toBe(1);

		// a merchant cannot confirm after the hold passed; a listed expired order shows as cancelled
		const third = await h.call('POST', '/v1/orders', { key: h.pk, body: body('+447700900113') });
		const fourth = await h.call('POST', '/v1/orders', {
			key: h.pk,
			body: checkoutBody({
				lines: [{ itemId: 'itm_b', quantity: 1 }],
				paymentMethod: 'cod',
				contact: { name: 'L', phone: '+447700900114' },
			}),
		});
		h.clock.advance(25 * HOUR);
		await entitle();
		expect((await h.call('POST', `/v1/orders/${third.json.id}/confirm`)).status).toBe(409);
		expect((await h.collection('orders').findOne({ id: third.json.id }))?.status).toBe('cancelled');
		const listed = await h.call('GET', '/v1/orders?status=awaiting_confirmation&limit=100');
		expect(listed.json.items.find((/** @type {any} */ o) => o.id === fourth.json.id)).toMatchObject({ status: 'cancelled' });
		await entitle();
	});

	it('registers the per-website background work; its trigger sweeps that website', async () => {
		await entitle();
		const placed = await h.call('POST', '/v1/orders', {
			key: h.pk,
			body: checkoutBody({
				lines: [{ itemId: 'itm_b', quantity: 1 }],
				paymentMethod: 'cod',
				contact: { name: 'B', phone: '+447700900221' },
			}),
		});
		const cartId = await h.cartWith([{ itemId: 'itm_b', quantity: 1 }]);
		h.clock.advance(31 * HOUR);
		await entitle();
		const { holds, abandoned } = h.application.jobs;
		expect([holds.name, abandoned.name]).toEqual(['holds', 'abandoned']);
		expect(await holds.trigger({})).toBe(false); // per website: nothing to do without one
		expect(await holds.trigger({ websiteId: WEBSITE })).toBe(true);
		expect((await h.collection('orders').findOne({ id: placed.json.id }))?.status).toBe('cancelled');
		expect(await holds.trigger({ websiteId: WEBSITE })).toBe(false); // throttled: at most once per interval
		expect(await abandoned.trigger({ websiteId: WEBSITE })).toBe(true);
		expect(h.published('checkout.cart_abandoned@1').some((e) => e.data.cartId === cartId)).toBe(true);
		expect(await abandoned.trigger({ websiteId: WEBSITE_2 })).toBe(true); // not subscribed: nothing to sweep
	});
});
