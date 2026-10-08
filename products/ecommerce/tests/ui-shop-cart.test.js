// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountCart } from '../ui/cart.js';
import { returnUrlOf } from '../ui/shop-checkout.js';
import {
	$,
	$$,
	buttonOf,
	click,
	configOf,
	fail,
	flush,
	handTimers,
	makeShop,
	ok,
	place,
	resetPage,
	setValue,
	submit,
	text,
	textOf,
} from './ui-shop-helpers.js';

beforeEach(resetPage);
afterEach(resetPage);

/** @param {Record<string, unknown>} [over] */
const line = (over = {}) => ({
	key: 'prd_1|var_1',
	productId: 'prd_1',
	variantId: 'var_1',
	kind: 'physical',
	name: 'Phone',
	variantName: 'Blue',
	gradeLabel: 'Like new',
	image: 'https://cdn.example.com/1.png',
	slot: null,
	unitPrice: 100000,
	quantity: 2,
	discount: 10000,
	tax: 0,
	total: 190000,
	problems: [],
	...over,
});

const DELIVERY = { method: 'delivery', zone: 'z1', name: 'City', fee: 20000, locationId: null, minDays: 1, maxDays: 3 };
const PICKUP = { method: 'pickup', zone: '', name: 'Main shop', fee: 0, locationId: 'loc_1', minDays: null, maxDays: null };

/** @param {Record<string, unknown>} [over] */
const quoteOf = (over = {}) => ({
	currency: 'PKR',
	lines: [line()],
	promotions: {
		applied: [{ id: 'dl_1', name: 'Sale', kind: 'deal', amount: 10000 }],
		couponCode: '',
		couponProblem: null,
		freeDelivery: false,
	},
	delivery: DELIVERY,
	deliveryOptions: [DELIVERY, PICKUP],
	deliveryProblem: null,
	paymentMethods: [
		{ method: 'cod', available: true, reason: null, advance: 5000 },
		{ method: 'online', available: true, reason: null, advance: 0 },
		{ method: 'pickup', available: false, reason: 'needs_pickup', advance: 0 },
	],
	points: null,
	totals: { subtotal: 200000, discount: 10000, delivery: 20000, tax: 0, total: 210000, currency: 'PKR', taxIncluded: true },
	ready: true,
	...over,
});

const ORDER = {
	id: 'ord_1',
	number: 'SO2026-1',
	status: 'placed',
	statusLabel: 'Placed',
	role: 'awaiting_confirmation',
	lines: [
		{ id: 'oln_1', name: 'Phone', variantName: 'Blue', quantity: 2, total: 190000 },
		{ id: 'oln_2', name: 'Case', variantName: '', quantity: 1, total: 1000 },
	],
	totals: { subtotal: 200000, discount: 10000, delivery: 20000, tax: 0, total: 210000, currency: 'PKR', taxIncluded: true },
	payment: { method: 'cod', state: 'unpaid', advance: 0, paid: 0, refunded: 0, payUrl: null, payBy: null },
};

const SETTINGS = {
	checkout: {
		paymentMethods: ['cod', 'online'],
		coupons: true,
		loyalty: true,
		delivery: { zones: true, cities: ['Lahore', 'Karachi'] },
		policies: { shipping: 'Ships fast.\n\nReally fast.', returns: '', privacy: '  ', terms: 'Be nice.' },
		address: { required: ['name', 'phone', 'line1', 'city'], optional: ['line2', 'area', 'postalCode', 'country', 'notes'] },
	},
};

/**
 * @param {{ quote?: (call: any) => any, routes?: Record<string, any>, signIn?: string | null, url?: string,
 *   settings?: Record<string, any>, lines?: any[] }} [options]
 */
const setup = async ({ quote = () => ok(quoteOf()), routes = {}, signIn = null, url, settings = SETTINGS, lines } = {}) => {
	const fake = makeShop({
		features: ['checkout'],
		signIn,
		routes: { 'POST /v1/shop/cart/quote': quote, ...routes },
		...(url ? { url } : {}),
	});
	for (const entry of lines ?? [{ productId: 'prd_1', variantId: 'var_1', quantity: 2 }]) fake.cart.add(entry);
	const timers = handTimers();
	const host = place('cart');
	await mountCart({ host, config: configOf(['checkout'], settings), shop: fake.shop, win: /** @type {any} */ (timers) });
	await flush();
	return { fake, timers, host };
};

describe('cart', () => {
	it('says when the cart is empty', async () => {
		const { fake, host } = await setup({ lines: [] });
		expect(textOf(host)).toContain(text('cart.empty'));
		expect(fake.calls).toHaveLength(0);
		expect(host.getAttribute('data-ss-mounted')).toBe('cart');
	});

	it('prices the cart and changes quantities after a short pause', async () => {
		const { fake, timers, host } = await setup({
			quote: (call) => ok(quoteOf({ lines: [line({ quantity: call.body.lines[0]?.quantity ?? 0 })] })),
		});
		expect(fake.last('POST /v1/shop/cart/quote')?.body).toEqual({
			lines: [{ productId: 'prd_1', variantId: 'var_1', quantity: 2 }],
			coupon: '',
			points: 0,
			delivery: { method: 'delivery', city: '', area: '', country: '', locationId: null },
			payment: null,
		});
		const page = textOf(host);
		for (const part of [
			'Phone',
			'Blue',
			text('cart.grade', { grade: 'Like new' }),
			text('cart.unitPrice', { price: 'PKR 1,000.00' }),
			text('cart.lineDiscount', { amount: 'PKR 100.00' }),
			'PKR 1,900.00',
			text('cart.applied', { name: 'Sale' }),
			'−PKR 100.00',
			'PKR 2,100.00',
			text('checkout.codAdvance', { amount: 'PKR 50.00' }),
			text('checkout.days', { min: 1, max: 3 }),
			text('checkout.pickupAt', { name: 'Main shop' }),
			'Ships fast.',
			'Really fast.',
			text('checkout.policy.terms'),
		])
			expect(page).toContain(part);
		expect(page).not.toContain(text('checkout.policy.privacy'));
		expect(page).not.toContain(text('checkout.method.pickup'));
		expect($$(host, 'datalist option')).toHaveLength(2);
		expect(textOf(host)).toContain(text('checkout.optional', { field: text('checkout.field.line2') }));
		await click(buttonOf(host, text('cart.more', { name: 'Phone' })));
		await click(buttonOf(host, text('cart.more', { name: 'Phone' })));
		expect(timers.pending()).toBe(1);
		await timers.run();
		expect(fake.last('POST /v1/shop/cart/quote')?.body.lines[0].quantity).toBe(4);
		await click(buttonOf(host, text('cart.less', { name: 'Phone' })));
		await setValue($(host, 'input[type="number"]'), 'x');
		expect(fake.cart.state().lines[0]?.quantity).toBe(1);
		await setValue($(host, 'input[type="number"]'), '7');
		await timers.run();
		expect(fake.last('POST /v1/shop/cart/quote')?.body.lines[0].quantity).toBe(7);
		await click(buttonOf(host, text('cart.removeLabel', { name: 'Phone' })));
		await timers.run();
		expect(textOf(host)).toContain(text('cart.empty'));
	});

	it('shows line problems, bookings, unknown items and merged lines', async () => {
		const { host, fake, timers } = await setup({
			lines: [
				{ productId: 'prd_1', variantId: null, quantity: 99 },
				{ productId: 'prd_2', variantId: 'var_2', quantity: 1, slot: '2026-10-09T05:00:00.000Z' },
				{ productId: 'prd_3', variantId: null, quantity: 1 },
			],
			quote: () =>
				ok(
					quoteOf({
						lines: [
							line({
								variantId: 'var_1',
								quantity: 99,
								problems: [
									{ code: 'not_enough_stock', message: 'x' },
									{ code: 'mystery', message: 'y' },
								],
							}),
							line({
								productId: 'prd_2',
								variantId: 'var_2',
								kind: 'booking',
								name: 'Haircut',
								variantName: '',
								gradeLabel: '',
								image: null,
								discount: 0,
								slot: { start: '2026-10-09T05:00:00.000Z', end: '2026-10-09T05:30:00.000Z' },
							}),
						],
						ready: false,
					}),
				),
		});
		const page = textOf(host);
		expect(page).toContain(text('cart.problem.not_enough_stock'));
		expect(page).toContain(text('cart.problem.unavailable'));
		expect(page).toContain('Haircut');
		expect(page).toContain(text('cart.notReady'));
		expect(buttonOf(host, text('cart.more', { name: 'Phone' })).disabled).toBe(true);
		expect(() => buttonOf(host, text('cart.more', { name: 'Haircut' }))).toThrow();
		await click(buttonOf(host, text('cart.removeLabel', { name: 'Haircut' })));
		await timers.run();
		expect(fake.cart.state().lines).toHaveLength(2);

		resetPage();
		const unknown = await setup({
			quote: () =>
				ok(
					quoteOf({
						lines: [
							line({
								productId: 'prd_9',
								variantId: 'var_9',
								name: '',
								unitPrice: 0,
								total: 0,
								problems: [{ code: 'unavailable', message: '' }],
							}),
							line({ productId: 'prd_8' }),
						],
					}),
				),
		});
		expect(textOf(unknown.host)).toContain(text('cart.unknownItem'));
	});

	it('applies a coupon and shows why one does not apply', async () => {
		/** @type {any} */
		let problem = null;
		const { fake, timers, host } = await setup({
			quote: (call) =>
				ok(
					quoteOf({
						promotions: {
							applied:
								call.body.coupon && !problem ? [{ id: 'cpn_1', name: call.body.coupon, kind: 'coupon', amount: 0 }] : [],
							couponCode: call.body.coupon,
							couponProblem: problem,
							freeDelivery: Boolean(call.body.coupon && !problem),
						},
					}),
				),
		});
		const form = () => $(host, '#ss-cart-coupon').closest('form');
		await submit(form());
		expect(timers.pending()).toBe(0);
		$(host, '#ss-cart-coupon').value = ' free ';
		await submit(form());
		await timers.run();
		expect(fake.last('POST /v1/shop/cart/quote')?.body.coupon).toBe('free');
		expect(textOf(host)).toContain(text('cart.couponApplied', { code: 'free' }));
		expect(textOf(host)).toContain(text('cart.freeDelivery'));
		problem = { code: 'coupon_expired', message: 'x' };
		await click(buttonOf(host, text('cart.couponRemove')));
		await timers.run();
		fake.cart.setCoupon('OLD');
		await timers.run();
		expect(textOf(host)).toContain(text('cart.coupon.coupon_expired'));
		problem = { code: 'coupon_new_kind', message: 'x' };
		fake.cart.setCoupon('OLD2');
		await timers.run();
		expect(textOf(host)).toContain(text('cart.coupon.coupon_not_applicable'));

		resetPage();
		const off = await setup({ settings: { checkout: { ...SETTINGS.checkout, coupons: false } } });
		expect($(off.host, '#ss-cart-coupon')).toBeNull();
	});

	it('redeems loyalty points when signed in', async () => {
		const { fake, timers, host } = await setup({
			signIn: 's1',
			quote: (call) => {
				const asked = call.body.points;
				const used = asked === 100 ? 100 : 0;
				return ok(quoteOf({ points: { balance: 500, max: 200, used, value: used * 10 } }));
			},
		});
		expect(textOf(host)).toContain(text('cart.points.balance', { balance: 500 }));
		$(host, '#ss-cart-points').value = '100';
		await submit($(host, '#ss-cart-points').closest('form'));
		await timers.run();
		expect(fake.last('POST /v1/shop/cart/quote')?.body.points).toBe(100);
		expect(textOf(host)).toContain(text('cart.points.used', { points: 100, amount: 'PKR 10.00' }));
		expect(textOf(host)).toContain(text('cart.pointsDiscount'));
		$(host, '#ss-cart-points').value = '5000';
		await submit($(host, '#ss-cart-points').closest('form'));
		await timers.run();
		expect(fake.last('POST /v1/shop/cart/quote')?.body.points).toBe(200);
		expect(textOf(host)).toContain(text('cart.points.notEnough'));
		$(host, '#ss-cart-points').value = 'x';
		await submit($(host, '#ss-cart-points').closest('form'));
		await timers.run();
		expect(fake.last('POST /v1/shop/cart/quote')?.body.points).toBe(0);
		fake.identify(null);
		await timers.run();
		expect($(host, '#ss-cart-points')).toBeNull();

		resetPage();
		const none = await setup({ signIn: 's1', quote: () => ok(quoteOf({ points: { balance: 0, max: 0, used: 0, value: 0 } })) });
		expect($(none.host, '#ss-cart-points')).toBeNull();
		expect(textOf(none.host)).toContain(text('cart.points.balance', { balance: 0 }));
	});

	it('switches between delivery and pickup and prices the address city', async () => {
		const { fake, timers, host } = await setup({
			quote: (call) => {
				const pickup = call.body.delivery.method === 'pickup';
				return ok(
					quoteOf({
						delivery: pickup
							? call.body.delivery.locationId
								? PICKUP
								: { ...PICKUP, locationId: null, name: '' }
							: { ...DELIVERY, name: '', minDays: null, maxDays: null, fee: 0 },
						deliveryOptions: [{ ...DELIVERY, name: '', minDays: null, maxDays: null, fee: 0 }, PICKUP],
						deliveryProblem: pickup && !call.body.delivery.locationId ? 'choose_pickup_location' : null,
						totals: { ...quoteOf().totals, delivery: 0, tax: 3000, taxIncluded: false },
					}),
				);
			},
		});
		expect(textOf(host)).toContain(
			text('checkout.deliver', { fee: text('checkout.free'), zone: text('checkout.zoneUnknown') }),
		);
		expect(textOf(host)).toContain(text('cart.tax'));
		await setValue($(host, '#ss-cart-city'), 'Lahore');
		await timers.run();
		expect(fake.last('POST /v1/shop/cart/quote')?.body.delivery.city).toBe('Lahore');
		const radios = () => $$(host, 'input[name="ss-cart-delivery"]');
		await setValue(radios()[1], true);
		await timers.run();
		expect(fake.last('POST /v1/shop/cart/quote')?.body.delivery).toEqual({
			method: 'pickup',
			city: 'Lahore',
			area: '',
			country: '',
			locationId: 'loc_1',
		});
		expect(radios()[1].checked).toBe(true);
		expect($(host, 'fieldset.box legend').closest('fieldset')).toBeTruthy();
		expect($(host, '#ss-cart-name').closest('fieldset').hidden).toBe(true);
		expect(textOf(host)).not.toContain(text('cart.delivery') + 'Free');
		await setValue(radios()[0], true);
		await timers.run();
		expect($(host, '#ss-cart-name').closest('fieldset').hidden).toBe(false);

		resetPage();
		const problem = await setup({
			quote: () =>
				ok(
					quoteOf({
						delivery: { ...PICKUP, locationId: null },
						deliveryProblem: 'choose_pickup_location',
						paymentMethods: [],
					}),
				),
		});
		expect(textOf(problem.host)).toContain(text('checkout.deliveryProblem.choose_pickup_location'));
		expect(textOf(problem.host)).toContain(text('checkout.noPayment'));

		resetPage();
		const digital = await setup({
			quote: () =>
				ok(
					quoteOf({
						lines: [line({ kind: 'digital' })],
						delivery: { ...DELIVERY, method: 'none' },
						deliveryOptions: [],
						totals: { ...quoteOf().totals, tax: 2000, taxIncluded: true },
					}),
				),
		});
		expect($(digital.host, 'input[name="ss-cart-delivery"]')).toBeNull();
		expect($(digital.host, '#ss-cart-name').closest('fieldset').hidden).toBe(true);
		expect(textOf(digital.host)).toContain(text('cart.taxIncluded'));
	});

	it('shows the error of a failed quote and tries again', async () => {
		let fails = true;
		const { host } = await setup({ quote: () => (fails ? fail(500, 'internal_error') : ok(quoteOf())) });
		expect(textOf(host)).toContain(text('cart.quoteError'));
		fails = false;
		await click(buttonOf(host, text('cart.retry')));
		expect(textOf(host)).toContain('PKR 2,100.00');
	});

	it('drops a quote that a newer one replaced', async () => {
		/** @type {Array<(value: any) => void>} */
		const waiting = [];
		const { timers, host, fake } = await setup({
			quote: (call) =>
				call.body.lines[0].quantity === 2
					? new Promise((resolve) => waiting.push(resolve))
					: ok(quoteOf({ lines: [line({ quantity: 3, total: 300000 })] })),
		});
		fake.cart.set({ productId: 'prd_1', variantId: 'var_1', quantity: 2 }, 3);
		await timers.run();
		waiting[0]?.(ok(quoteOf({ lines: [line({ total: 111 })] })));
		await flush();
		expect(textOf(host)).toContain('PKR 3,000.00');
		expect(textOf(host)).not.toContain('PKR 1.11');
	});
});

describe('checkout', () => {
	/** @param {any} host */
	const fillAddress = async (host) => {
		$(host, '#ss-cart-name').value = 'Ana';
		$(host, '#ss-cart-phone').value = '+92 300 0000000';
		$(host, '#ss-cart-line1').value = '1 Road';
		await setValue($(host, '#ss-cart-city'), 'Lahore');
	};

	it('asks a guest to sign in, checks the address and pays on Payments', async () => {
		const { fake, timers, host } = await setup({
			url: 'https://shop.example.com/cart?ss_order=bad#top',
			routes: {
				'POST /v1/shop/orders': () =>
					ok(
						{ order: { ...ORDER, role: 'awaiting_payment' }, next: { kind: 'pay', url: 'https://pay.example.com/p/1' } },
						201,
					),
			},
		});
		expect(textOf(host)).toContain(text('checkout.signIn'));
		expect(() => buttonOf(host, text('checkout.place'))).toThrow();
		fake.identify('s1');
		await timers.run();
		await click(buttonOf(host, text('checkout.place')));
		expect(textOf(host)).toContain(text('checkout.missing', { field: text('checkout.field.name') }));
		expect(host.shadowRoot?.activeElement?.id).toBe('ss-cart-name');
		await fillAddress(host);
		await timers.run();
		await setValue($$(host, 'input[name="ss-cart-payment"]')[1], true);
		$(host, '#ss-cart-note').value = ' Ring twice ';
		await click(buttonOf(host, text('checkout.place')));
		const placed = fake.last('POST /v1/shop/orders');
		expect(placed?.key).toBe('key-1');
		expect(placed?.body).toMatchObject({
			payment: 'online',
			note: 'Ring twice',
			returnUrl: 'https://shop.example.com/cart',
			address: { name: 'Ana', phone: '+92 300 0000000', line1: '1 Road', city: 'Lahore', line2: '', notes: '' },
		});
		expect(fake.went).toEqual(['https://pay.example.com/p/1']);
		expect(fake.cart.state().lines).toHaveLength(0);
	});

	it('shows the success page of an order that needs no payment now, and the cart again after a new item', async () => {
		const { fake, timers, host } = await setup({
			signIn: 's1',
			quote: () =>
				ok(
					quoteOf({
						deliveryOptions: [PICKUP],
						delivery: PICKUP,
						paymentMethods: [{ method: 'pickup', available: true, reason: null, advance: 0 }],
					}),
				),
			routes: { 'POST /v1/shop/orders': () => ok({ order: ORDER, next: { kind: 'done' } }, 201) },
		});
		await click(buttonOf(host, text('checkout.place')));
		expect(fake.last('POST /v1/shop/orders')?.body.address).toBeUndefined();
		expect(fake.last('POST /v1/shop/orders')?.body.payment).toBe('pickup');
		const page = textOf(host);
		expect(page).toContain(text('success.title'));
		expect(page).toContain(text('success.number', { number: 'SO2026-1' }));
		expect(page).toContain(text('success.line', { name: 'Phone (Blue)', quantity: 2 }));
		expect(page).toContain(text('success.line', { name: 'Case', quantity: 1 }));
		expect(page).toContain(text('success.confirming'));
		await timers.run();
		fake.cart.add({ productId: 'prd_5', variantId: null, quantity: 1 });
		await timers.run();
		expect(textOf(host)).toContain(text('cart.title'));
		expect($(host, '.box h2').closest('[hidden]')).not.toBeNull();
	});

	it('starts the payment again when Payments could not be reached', async () => {
		let pay = fail(503, 'payments_unavailable');
		const waiting = {
			...ORDER,
			role: 'awaiting_payment',
			payment: { ...ORDER.payment, method: 'online', state: 'pending', payBy: '2026-10-09T10:00:00.000Z' },
		};
		const { fake, host } = await setup({
			signIn: 's1',
			routes: {
				'POST /v1/shop/orders': () => ok({ order: waiting, next: { kind: 'retry' } }, 201),
				'POST /v1/shop/orders/ord_1/pay': () => pay,
			},
		});
		await fillAddress(host);
		await click(buttonOf(host, text('checkout.place')));
		expect(textOf(host)).toContain(text('success.payBy', { date: '' }).slice(0, 10));
		await click(buttonOf(host, text('success.retry')));
		expect(fake.last('POST /v1/shop/orders/ord_1/pay')?.body).toEqual({ returnUrl: 'https://shop.example.com/cart' });
		expect(textOf(host)).toContain(text('checkout.problem.payments_unavailable'));
		pay = ok({ order: { ...waiting, role: 'open', payment: { ...waiting.payment, state: 'paid' } }, next: { kind: 'done' } });
		await click(buttonOf(host, text('success.retry')));
		expect(textOf(host)).toContain(text('success.paid'));
		resetPage();
		const second = await setup({
			signIn: 's1',
			routes: {
				'POST /v1/shop/orders': () => ok({ order: waiting, next: { kind: 'retry' } }, 201),
				'POST /v1/shop/orders/ord_1/pay': () =>
					ok({ order: waiting, next: { kind: 'pay', url: 'https://pay.example.com/2' } }),
			},
		});
		await fillAddress(second.host);
		await click(buttonOf(second.host, text('checkout.place')));
		await click(buttonOf(second.host, text('success.retry')));
		expect(second.fake.went).toEqual(['https://pay.example.com/2']);
	});

	it('keeps the attempt key after a lost answer and shows refusals', async () => {
		/** @type {any[]} */
		const answers = [
			{ ok: false, status: 0, data: null },
			fail(409, 'out_of_stock'),
			fail(422, 'validation_failed', { errors: [{ path: '/address/phone', message: 'x' }] }),
			fail(422, 'validation_failed', { errors: [{ path: '/note', message: 'x' }] }),
			fail(422, 'cod_not_allowed'),
			fail(403, 'customer_blocked'),
			fail(400, 'something_new'),
		];
		const { fake, host } = await setup({ signIn: 's1', routes: { 'POST /v1/shop/orders': () => answers.shift() } });
		await fillAddress(host);
		const status = () => $$(host, '[role="status"]').at(-2)?.textContent ?? '';
		const place = async () => click(buttonOf(host, text('checkout.place')));
		await place();
		expect(textOf(host)).toContain(text('checkout.problem.offline'));
		await place();
		const keys = fake.all('POST /v1/shop/orders').map((call) => call.key);
		expect(keys[0]).toBe(keys[1]);
		expect(textOf(host)).toContain(text('checkout.problem.out_of_stock'));
		const quotes = fake.all('POST /v1/shop/cart/quote').length;
		await flush();
		expect(fake.all('POST /v1/shop/cart/quote').length).toBeGreaterThanOrEqual(quotes);
		await place();
		expect(fake.all('POST /v1/shop/orders').at(-1)?.key).not.toBe(keys[0]);
		expect(textOf(host)).toContain(text('checkout.problem.address'));
		await place();
		expect(textOf(host)).toContain(text('checkout.problem.validation_failed'));
		await place();
		expect(textOf(host)).toContain(text('checkout.problem.cod_not_allowed'));
		await place();
		expect(textOf(host)).toContain(text('checkout.problem.customer_blocked'));
		await place();
		expect(textOf(host)).toContain(text('checkout.problem.failed'));
		expect(status()).toBeDefined();
	});
});

describe('success page after Payments', () => {
	it('waits for the sign-in, reads the order and clears the cart', async () => {
		const paidLater = {
			...ORDER,
			role: 'awaiting_payment',
			payment: { ...ORDER.payment, state: 'pending', payUrl: 'https://pay.example.com/again', payBy: null },
		};
		const { fake, timers, host } = await setup({
			url: 'https://shop.example.com/cart?ss_order=ord_1',
			routes: { 'GET /v1/shop/orders/ord_1': () => ok(paidLater) },
		});
		expect(textOf(host)).toContain(text('success.signIn'));
		expect(fake.all('POST /v1/shop/cart/quote')).toHaveLength(0);
		fake.identify('s1');
		await flush();
		expect(textOf(host)).toContain(text('success.number', { number: 'SO2026-1' }));
		expect($(host, `a[href="https://pay.example.com/again"]`).textContent).toBe(text('success.pay'));
		expect(fake.cart.state().lines).toHaveLength(0);
		await timers.run();
		fake.identify('s2');
		await flush();
		expect(fake.all('GET /v1/shop/orders/ord_1')).toHaveLength(1);
	});

	it('says when the order cannot be found or read', async () => {
		const missing = await setup({ signIn: 's1', url: 'https://shop.example.com/cart?ss_order=ord_9' });
		expect(textOf(missing.host)).toContain(text('success.notFound'));
		expect(missing.fake.cart.state().lines).toHaveLength(1);
		resetPage();
		const broken = await setup({
			signIn: 's1',
			url: 'https://shop.example.com/cart?ss_order=ord_1',
			routes: { 'GET /v1/shop/orders/ord_1': () => fail(500, 'internal_error') },
		});
		expect(textOf(broken.host)).toContain(text('success.error'));
	});

	it('makes the return address without ss_order', () => {
		const fake = makeShop({ url: 'https://shop.example.com/checkout?a=1&ss_order=ord_1#x' });
		expect(returnUrlOf(fake.shop)).toBe('https://shop.example.com/checkout?a=1');
	});
});
