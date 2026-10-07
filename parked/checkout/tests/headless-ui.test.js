import { describe, expect, it } from 'vitest';
import en from '../strings/en.json' with { type: 'json' };
import { createCart } from '../headless/cart.js';
import { createCheckoutForm } from '../headless/checkoutForm.js';
import { createLoyaltyRedeem } from '../headless/loyaltyRedeem.js';
import { createOfferApply } from '../headless/offerApply.js';
import { createPaymentGateway } from '../headless/paymentGateway.js';
import { createPaymentManual } from '../headless/paymentManual.js';
import { createPaymentProofs } from '../headless/paymentProofs.js';
import { createPlaceOrder } from '../headless/placeOrder.js';
import { createPoliciesNotice } from '../headless/policiesNotice.js';
import { createSigninGate } from '../headless/signinGate.js';
import { createSuccessPage } from '../headless/successPage.js';
import { errorText, newKey } from '../headless/store.js';
import * as cartUi from '../ui/cart.js';
import * as formUi from '../ui/checkoutForm.js';
import * as loyaltyUi from '../ui/loyaltyRedeem.js';
import * as offersUi from '../ui/offerApply.js';
import * as gatewayUi from '../ui/paymentGateway.js';
import * as manualUi from '../ui/paymentManual.js';
import * as proofsUi from '../ui/paymentProofs.js';
import * as placeUi from '../ui/placeOrder.js';
import * as policiesUi from '../ui/policiesNotice.js';
import * as gateUi from '../ui/signinGate.js';
import * as successUi from '../ui/successPage.js';
import { createFakeDom, findAll } from './helpers.js';

const strings = /** @type {Record<string, string>} */ (en);
const dom = createFakeDom();

/**
 * A fake Mode C client: answers by `METHOD path` (first match wins), records calls.
 * @param {Record<string, any>} answers value, or `{ error }` for a problem, or a function of the body
 */
const fakeClient = (answers) => {
	/** @type {Array<{ method: string, path: string, body?: any, options?: any }>} */
	const calls = [];
	/** @param {string} method @param {string} path @param {any} [body] @param {any} [options] @returns {Promise<any>} */
	const answer = async (method, path, body, options) => {
		calls.push({ method, path, body, options });
		const key =
			Object.keys(answers).find((k) => k === `${method} ${path}`) ??
			Object.keys(answers).find((k) => `${method} ${path}`.startsWith(k));
		const raw = key ? answers[key] : { error: { code: 'not_found' } };
		const value = typeof raw === 'function' ? raw(body) : raw;
		return value && value.error ? { ok: false, error: value.error } : { ok: true, value };
	};
	return {
		calls,
		get: (/** @type {string} */ path, /** @type {any} */ options) => answer('GET', path, undefined, options),
		post: (/** @type {string} */ path, /** @type {any} */ body, /** @type {any} */ options) =>
			answer('POST', path, body, options),
		patch: (/** @type {string} */ path, /** @type {any} */ body) => answer('PATCH', path, body),
		delete: (/** @type {string} */ path) => answer('DELETE', path),
	};
};

/** @param {any} root */
const text = (root) => root.textContent;
/** @param {any} root @param {string} tag */
const all = (root, tag) => findAll(root, (n) => n.tag === tag);

const cartValue = (/** @type {Record<string, any>} */ extra = {}) => ({
	id: 'crt_1',
	status: 'open',
	currency: 'EUR',
	lines: [
		{
			lineId: 'l1',
			itemId: 'i',
			title: 'Socks',
			variantTitle: 'M',
			image: 'https://x/i.png',
			url: 'https://x/i',
			quantity: 2,
			maxQuantity: 2,
			available: true,
		},
		{ lineId: 'l2', itemId: 'j', title: 'Hat', quantity: 1, maxQuantity: null, available: false },
	],
	quantity: 3,
	subtotalAmount: 3000,
	changes: [
		{ kind: 'price', title: 'Socks', to: 1500 },
		{ kind: 'quantity', title: 'Socks', to: 2 },
		{ kind: 'unavailable', title: 'Hat' },
		{ kind: 'removed', title: 'Cap' },
	],
	...extra,
});

describe('cart', () => {
	it('loads or creates, changes lines and renders', async () => {
		/** @type {string[]} */
		const events = [];
		const client = fakeClient({
			'GET /v1/carts/old': cartValue({ status: 'converted' }),
			'POST /v1/carts/crt_1/lines': cartValue(),
			'POST /v1/carts': cartValue({ lines: [], changes: [] }),
			'PATCH /v1/carts/crt_1/lines/l1': cartValue(),
			'DELETE /v1/carts/crt_1/lines/l2': cartValue(),
			'POST /v1/carts/crt_1/reconcile': { error: { code: 'cart_closed' } },
			'POST /v1/carts/crt_1/merge': { error: {} },
		});
		const cart = createCart({ config: { max_quantity_per_line: 2 }, strings, client, emit: (name) => events.push(name) });
		let seen = 0;
		const off = cart.subscribe(() => (seen += 1));
		expect((await cart.actions.load('old')).ok).toBe(true);
		const empty = cartUi.render({ state: cart.state(), actions: cart.actions, strings, dom });
		expect(text(empty)).toContain(strings['cart.empty']);
		await cart.actions.add({ itemId: 'i', quantity: 2 });
		expect(cart.state().notices).toHaveLength(4);
		await cart.actions.setQuantity('l1', 9);
		expect(client.calls.at(-1)?.body).toEqual({ quantity: 2 });
		await cart.actions.remove('l2');
		expect((await cart.actions.reconcile()).ok).toBe(false);
		expect(cart.state().error).toBe(strings['checkout.error.cart_closed']);
		await cart.actions.merge();
		expect(cart.state().error).toBe(strings['checkout.error.request_failed']);
		expect(events).toEqual(['cart.created', 'cart.line_added', 'cart.updated', 'cart.line_removed']);
		expect(cart.validate({ quantity: 3 })).toHaveLength(1);
		expect(cart.validate({ quantity: 1 })).toEqual([]);
		await cart.actions.setQuantity('l1', 1);
		const root = cartUi.render({
			state: cart.state(),
			actions: cart.actions,
			strings,
			theme: { variant: 'drawer' },
			dom,
			slots: { before: dom.createTextNode('B') },
		});
		expect(root.attributes.class).toContain('ss-cart--drawer');
		const buttons = all(root, 'button');
		for (const button of buttons) button.dispatch('click');
		expect(client.calls.filter((c) => c.method === 'DELETE')).toHaveLength(3);
		expect(cartUi.styles).toContain('var(--ss-color-text)');
		off();
		expect(seen).toBeGreaterThan(0);
		cart.destroy();
		// no cart id yet: add creates one first
		const fresh = createCart({
			client: fakeClient({ 'POST /v1/carts/crt_1/lines': cartValue({ currency: null }), 'POST /v1/carts': cartValue() }),
		});
		await fresh.actions.add({ itemId: 'i' });
		expect(fresh.state().subtotalText).toBeNull();
	});
});

describe('checkout form', () => {
	const form = {
		country: 'DE',
		countries: ['DE', 'FR'],
		contact: [
			{ key: 'name', kind: 'text', required: true, max_length: 5, label: 'Name', autocomplete: 'name' },
			{ key: 'news', kind: 'checkbox', required: false, max_length: 1, label: 'News', autocomplete: '' },
		],
		address: [
			{ key: 'line1', kind: 'text', required: true, max_length: 50, label: 'Line', autocomplete: '' },
			{ key: 'zone', kind: 'select', options: ['a', 'b'], required: false, max_length: 5, label: 'Zone', autocomplete: '' },
			{ key: 'note', kind: 'textarea', required: false, max_length: 50, label: 'Note', autocomplete: '' },
		],
		custom: [{ key: 'vat', kind: 'postal', required: false, max_length: 20, label: 'VAT', autocomplete: '' }],
		deliveryMethods: [
			{ key: 'ship', kind: 'ship', label: 'Ship', requires_address: true },
			{ key: 'pick', kind: 'pickup', label: 'Pick', requires_address: false },
		],
	};
	it('loads the schema, checks locally and on the server, and renders', async () => {
		const client = fakeClient({
			'GET /v1/checkout-form': form,
			'GET /v1/addresses': { items: [{ id: 'a1', address: { line1: 'Saved 1' } }] },
			'POST /v1/checkout-form:validate': (/** @type {any} */ body) =>
				body.contact.name === 'Ada'
					? { valid: true, errors: [], values: { ok: 1 } }
					: {
							valid: false,
							errors: [
								{ path: '/contact/name', code: 'phone_invalid', message: 'm' },
								{ path: '/x', code: 'odd', message: 'raw' },
							],
						},
		});
		/** @type {string[]} */
		const events = [];
		const f = createCheckoutForm({ strings, client, emit: (n) => events.push(n) });
		expect(f.validate(undefined)).toEqual([]);
		expect(formUi.render({ state: f.state(), actions: f.actions, strings, dom }).attributes['aria-busy']).toBe('true');
		await f.actions.load();
		expect(f.state()).toMatchObject({ needsAddress: true, values: { country: 'DE', deliveryMethod: 'ship' } });
		expect((await f.actions.check()).ok).toBe(false);
		expect(Object.keys(f.state().errors)).toEqual(['/contact/name', '/address/line1']);
		await f.actions.setField('contact', 'name', 'toolongname');
		expect(f.validate(f.state().values)[0]?.code).toBe('too_long');
		await f.actions.loadAddresses();
		expect((await f.actions.useAddress('nope')).ok).toBe(false);
		await f.actions.useAddress('a1');
		await f.actions.setField('contact', 'name', 'Bob');
		expect((await f.actions.check()).ok).toBe(false);
		expect(f.state().errors['/contact/name']).toBe(strings['checkout_form.error.phone_invalid']);
		expect(f.state().errors['/x']).toBe('raw');
		await f.actions.setField('contact', 'name', 'Ada');
		expect(await f.actions.check()).toEqual({ ok: true, value: { ok: 1 } });
		await f.actions.setDelivery('pick');
		await f.actions.setPickup('main');
		expect(f.payload()).toEqual({
			country: 'DE',
			contact: { name: 'Ada' },
			custom: {},
			deliveryMethod: 'pick',
			pickupLocation: 'main',
		});
		expect(events).toEqual(['checkout_form.delivery_selected']);
		await f.actions.setDelivery('ship');
		await f.actions.setField('contact', 'news', true);
		await f.actions.setField('address', 'zone', 'a');
		const root = formUi.render({
			state: { ...f.state(), errors: { '/address/line1': 'Required.' } },
			actions: f.actions,
			strings,
			dom,
		});
		const inputs = [...all(root, 'input'), ...all(root, 'select'), ...all(root, 'textarea')];
		expect(inputs.some((n) => n.attributes['aria-invalid'] === 'true')).toBe(true);
		for (const input of inputs)
			input.dispatch(input.attributes.type === 'checkbox' ? 'change' : 'input', { target: { value: 'v', checked: true } });
		for (const select of all(root, 'select')) select.dispatch('change', { target: { value: 'FR' } });
		for (const radio of findAll(root, (n) => n.attributes?.type === 'radio')) radio.dispatch('change');
		all(root, 'form')[0].dispatch('submit', { preventDefault: () => {} });
		expect(formUi.styles).toContain('--ss-color-danger');
		await f.actions.setCountry('FR');
		expect(client.calls.some((c) => c.options?.query?.country === 'FR')).toBe(true);
		const failing = createCheckoutForm({ strings, client: fakeClient({}) });
		await failing.actions.load('XX');
		expect(failing.state().status).toBe('error');
	});
});

describe('placement, payments and offers', () => {
	const quote = {
		currency: 'EUR',
		totals: {
			subtotal: 5000,
			itemDiscount: 500,
			couponDiscount: 100,
			shipping: 500,
			shippingDiscount: 0,
			surcharge: 50,
			loyalty: 10,
			total: 4940,
		},
		paymentMethods: [
			{ key: 'cod', available: true, reason: null, surcharge: 50 },
			{ key: 'bank_transfer', available: false, reason: 'rule_not_met', surcharge: 0 },
		],
	};
	it('quotes and places with one idempotency key per submission', async () => {
		let n = 0;
		let fail = true;
		const client = fakeClient({
			'POST /v1/quotes': (/** @type {any} */ body) => (body.bad ? { error: { code: 'cart_empty' } } : quote),
			'POST /v1/orders': () =>
				fail
					? { error: { code: 'total_changed', totals: { ...quote.totals, total: 1 } } }
					: { id: 'ord_1', status: 'pending_payment' },
		});
		/** @type {string[]} */
		const events = [];
		const p = createPlaceOrder({ strings, client, emit: (e) => events.push(e), newKey: () => `k${(n += 1)}` });
		await p.actions.quote({ bad: true });
		expect(p.state().errorCode).toBe('cart_empty');
		await p.actions.quote({});
		expect(p.state().rows.map((r) => r.label)).toHaveLength(6);
		await p.actions.place({ a: 1 });
		expect(p.state()).toMatchObject({ status: 'error', errorCode: 'total_changed' });
		expect(p.state().quote?.totals.total).toBe(1);
		fail = false;
		await p.actions.place({ a: 1 });
		const keys = client.calls.filter((c) => c.path === '/v1/orders').map((c) => c.options.idempotencyKey);
		expect(keys[0]).not.toBe(keys[1]);
		expect(events).toEqual(['place_order.placed']);
		const root = placeUi.render({ state: p.state(), actions: p.actions, strings, dom });
		expect(all(root, 'button')[0].attributes.disabled).toBe('');
		all(root, 'button')[0].dispatch('click');
		expect(
			placeUi.render({
				state: { ...p.state(), status: 'placing', totalText: null },
				actions: p.actions,
				strings,
				theme: { variant: 'button' },
				dom,
			}).attributes['aria-busy'],
		).toBe('true');
		expect(p.validate()).toEqual([]);
		expect(newKey()).toMatch(/^idk_[0-9a-f]{32}$/);
		expect(errorText((k) => k, undefined)).toBe('checkout.error.request_failed');
		const quick = createPlaceOrder({ strings, client: fakeClient({ 'POST /v1/orders': { error: {} } }) });
		await quick.actions.place({});
		expect(quick.state().errorCode).toBe('request_failed');
		// a network failure retries with the same key; a refusal (4xx) starts a new submission
		let answer = /** @type {any} */ ({ error: { code: 'request_failed' } });
		const retry = fakeClient({ 'POST /v1/orders': () => answer });
		let m = 0;
		const r = createPlaceOrder({ strings, client: retry, newKey: () => `r${(m += 1)}` });
		await r.actions.place({ a: 1 });
		await r.actions.place({ a: 1 });
		answer = { error: { code: 'open_orders_limit', status: 409 } };
		await r.actions.place({ a: 1 });
		answer = { error: { code: 'duplicate_request', status: 409 } };
		await r.actions.place({ a: 1 });
		await r.actions.place({ a: 1 });
		expect(retry.calls.map((c) => c.options.idempotencyKey)).toEqual(['r1', 'r1', 'r1', 'r2', 'r2']);
	});

	it('chooses manual payment methods with availability from the quote', async () => {
		const client = fakeClient({
			'GET /v1/payment-methods': {
				methods: [{ key: 'bank_transfer' }, { key: 'cod' }],
				bankDetails: [{ label: 'IBAN', value: 'X' }],
			},
		});
		const m = createPaymentManual({ strings, client });
		expect(m.validate()).toHaveLength(1);
		await m.actions.load();
		expect(m.state().selected).toBe('bank_transfer');
		let root = manualUi.render({ state: m.state(), actions: m.actions, strings, dom });
		expect(all(root, 'dd')).toHaveLength(1);
		await m.actions.applyQuote(quote);
		expect(m.state()).toMatchObject({ selected: 'cod' });
		expect(m.state().methods[1]?.surchargeText).toContain('0.50');
		expect((await m.actions.select('bank_transfer')).ok).toBe(false);
		expect((await m.actions.select('cod')).ok).toBe(true);
		root = manualUi.render({ state: m.state(), actions: m.actions, strings, dom });
		for (const radio of findAll(root, (n) => n.attributes?.type === 'radio')) radio.dispatch('change');
		const failing = createPaymentManual({ strings, client: fakeClient({}) });
		await failing.actions.load();
		expect(failing.state().status).toBe('error');
	});

	it('uploads proofs straight to storage', async () => {
		const client = fakeClient({
			'POST /v1/payment-proofs/prf_1/complete': { status: 'submitted' },
			'POST /v1/payment-proofs': { proofId: 'prf_1', upload: { method: 'PUT', url: 'https://s/x', headers: {} } },
		});
		let ok = false;
		const p = createPaymentProofs({
			config: { content_types: ['image/png'], max_bytes: 100 },
			strings,
			client,
			order: { id: 'ord_1', token: 'oat_1' },
			upload: async () => ({ ok }),
		});
		expect((await p.actions.submit({ type: 'text/plain', size: 1 })).ok).toBe(false);
		expect(p.validate({ type: 'image/png', size: 101 })[0]?.code).toBe('too_large');
		await p.actions.setReference('TRX');
		expect((await p.actions.submit({ type: 'image/png', size: 10 })).ok).toBe(false);
		expect(p.state().error).toBe(strings['proofs.error.upload']);
		ok = true;
		await p.actions.submit({ type: 'image/png', size: 10 });
		expect(p.state().status).toBe('done');
		expect(client.calls.find((c) => c.path === '/v1/payment-proofs')?.body).toMatchObject({
			orderId: 'ord_1',
			token: 'oat_1',
			reference: 'TRX',
		});
		const root = proofsUi.render({
			state: { ...p.state(), status: 'uploading', message: null },
			actions: p.actions,
			strings,
			dom,
		});
		const [ref, file] = all(root, 'input');
		ref.dispatch('input', { target: { value: 'R2' } });
		file.dispatch('change', { target: { files: [] } });
		file.dispatch('change', { target: { files: [{ type: 'image/png', size: 1 }] } });
		const refused = createPaymentProofs({
			strings,
			client: fakeClient({ 'POST /v1/payment-proofs': { error: { code: 'order_state' } } }),
			order: { id: 'o' },
			upload: async () => ({ ok: true }),
		});
		await refused.actions.submit({ type: 'x', size: 1 });
		expect(refused.state().error).toBe(strings['checkout.error.order_state']);
		const incomplete = createPaymentProofs({
			strings,
			client: fakeClient({
				'POST /v1/payment-proofs/p/complete': { error: { code: 'proof_not_uploaded' } },
				'POST /v1/payment-proofs': { proofId: 'p', upload: {} },
			}),
			order: { id: 'o' },
			upload: async () => ({ ok: true }),
		});
		await incomplete.actions.submit({ type: 'x', size: 1 });
		expect(incomplete.state().error).toBe(strings['checkout.error.proof_not_uploaded']);
	});

	it('runs the gateway preview flow', async () => {
		const client = fakeClient({
			'POST /v1/payments/p1/refresh': { status: 'paid' },
			'POST /v1/payments/p2/refresh': { error: { code: 'not_found' } },
			'POST /v1/payments': (/** @type {any} */ b) =>
				b.returnUrl === 'bad'
					? { error: { code: 'return_url_invalid' } }
					: b.returnUrl === 'direct'
						? { paymentId: 'p1', status: 'failed', redirectUrl: null }
						: { paymentId: 'p1', status: 'pending', redirectUrl: 'https://pay/x' },
		});
		/** @type {string[]} */
		const events = [];
		const g = createPaymentGateway({ strings, client, order: { id: 'o' }, emit: (e) => events.push(e) });
		await g.actions.start('bad');
		expect(g.state().status).toBe('error');
		await g.actions.start('direct');
		expect(g.state().status).toBe('failed');
		await g.actions.start('https://shop/r');
		expect(g.state()).toMatchObject({ status: 'redirect', redirectUrl: 'https://pay/x' });
		expect(all(gatewayUi.render({ state: g.state(), actions: g.actions, strings, dom }), 'a')).toHaveLength(1);
		await g.actions.check('p2');
		await g.actions.check('p1');
		expect(g.state().status).toBe('paid');
		expect(events).toEqual(['payment_gateway.paid']);
		expect(gatewayUi.render({ state: g.state(), actions: g.actions, strings, dom }).children.filter(Boolean)).toHaveLength(1);
		const idle = gatewayUi.render({
			state: { ...g.state(), status: 'idle' },
			actions: g.actions,
			strings,
			dom,
			returnUrl: 'https://shop/r',
		});
		all(idle, 'button')[0].dispatch('click');
		expect(g.validate()).toEqual([]);
	});

	it('applies codes and shows deals', async () => {
		const client = fakeClient({
			'POST /v1/offers:check': (/** @type {any} */ b) => ({
				totals: { currency: 'EUR' },
				deals: [{ name: 'Autumn', amount: 500 }],
				codes: {
					applied: b.codes.includes('SAVE') ? [{ code: 'SAVE', discount: 100 }] : [],
					rejected: b.codes
						.filter((/** @type {string} */ c) => c !== 'SAVE')
						.map((/** @type {string} */ code) => ({ code, reason: code === 'X' ? 'exhausted' : 'mystery' })),
				},
			}),
		});
		/** @type {string[]} */
		const events = [];
		const o = createOfferApply({ config: { max_codes: 2 }, strings, client, emit: (e) => events.push(e) });
		expect((await o.actions.apply()).ok).toBe(false);
		expect(o.validate('ok-code')).toEqual([]);
		expect(o.validate('!')).toHaveLength(1);
		await o.actions.setCart('crt_1');
		await o.actions.setCode('!!');
		expect((await o.actions.apply()).ok).toBe(false);
		await o.actions.setCode('SAVE');
		await o.actions.apply();
		expect(o.state().applied[0]?.text).toContain('SAVE');
		expect(o.codes()).toEqual(['SAVE']);
		await o.actions.setCode('X');
		await o.actions.apply();
		expect(o.state().error).toBe(strings['offers.reason.exhausted']);
		await o.actions.setCode('Y');
		await o.actions.apply();
		expect(o.state().error).toBe(strings['offers.reason.not_eligible']);
		expect(events).toContain('offer_apply.applied');
		const root = offersUi.render({ state: o.state(), actions: o.actions, strings, dom });
		all(root, 'input')[0].dispatch('input', { target: { value: 'Z' } });
		all(root, 'form')[0].dispatch('submit', { preventDefault: () => {} });
		for (const b of all(root, 'button').filter((n) => n.attributes.type === 'button')) b.dispatch('click');
		await o.actions.remove('SAVE');
		const failing = createOfferApply({ strings, client: fakeClient({}), cartId: 'c' });
		await failing.actions.setCart('c');
		expect(failing.state().status).toBe('error');
	});

	it('redeems loyalty points within the bounds', async () => {
		const client = fakeClient({
			'POST /v1/loyalty:quote': (/** @type {any} */ b) =>
				b.cartId === 'anon'
					? { error: { code: 'identity_required' } }
					: b.cartId === 'down'
						? { error: { code: 'integration_unavailable' } }
						: b.cartId === 'no'
							? { allowed: false }
							: {
									allowed: true,
									balance: 900,
									minPoints: 100,
									maxPoints: 800,
									currency: 'EUR',
									pointValue: { points: 1, value: 1 },
								},
		});
		const l = createLoyaltyRedeem({ strings, client, cartId: 'c' });
		await l.actions.load('anon');
		expect(l.state()).toMatchObject({ status: 'unavailable', message: strings['loyalty.signin'] });
		await l.actions.load('down');
		expect(l.state().status).toBe('error');
		await l.actions.load('no');
		expect(l.state().message).toBe(strings['loyalty.not_allowed']);
		await l.actions.load();
		await l.actions.setPoints(50);
		expect(l.state().points).toBe(100);
		await l.actions.useMax();
		expect(l.state().valueText).toContain('8.00');
		await l.actions.setPoints(0);
		expect(l.validate(0)).toEqual([]);
		expect(l.validate(5)).toHaveLength(1);
		const root = loyaltyUi.render({ state: { ...l.state(), valueText: 'x' }, actions: l.actions, strings, dom });
		all(root, 'input')[0].dispatch('change', { target: { value: '300' } });
		all(root, 'button')[0].dispatch('click');
		expect(
			loyaltyUi.render({ state: { ...l.state(), status: 'idle' }, actions: l.actions, strings, dom }).children,
		).toBeTruthy();
		const bare = createLoyaltyRedeem({
			client: fakeClient({ 'POST /v1/loyalty:quote': { allowed: true, minPoints: 1, maxPoints: 5 } }),
		});
		await bare.actions.load();
		await bare.actions.setPoints(2);
		expect(bare.state().valueText).toBeNull();
	});
});

describe('success, policies, gate', () => {
	it('shows the success view and lets the shopper cancel', async () => {
		const view = {
			title: 'T',
			order: { number: 'N1', currency: 'EUR', totals: { total: 100 }, cancellable: true, status: 'awaiting_confirmation' },
			steps: [
				{ key: 'confirm', text: 'Call', when: 'Today', current: true },
				{ key: 'ship', text: 'Ship', when: null, current: false },
			],
			bankDetails: [{ label: 'IBAN', value: 'X' }],
			continueUrl: '/',
		};
		let cancel = { error: { code: 'order_state' } };
		const client = fakeClient({
			'POST /v1/success-views': view,
			'GET /v1/success-views/o2': view,
			'POST /v1/orders/o/cancel': () => cancel,
		});
		/** @type {string[]} */
		const events = [];
		const s = createSuccessPage({ strings, client, order: { id: 'o', token: 't' }, emit: (e) => events.push(e) });
		expect(successUi.render({ state: s.state(), actions: s.actions, strings, dom }).attributes['aria-busy']).toBe('true');
		await s.actions.load();
		const root = successUi.render({ state: s.state(), actions: s.actions, strings, dom });
		expect(all(root, 'li')).toHaveLength(2);
		all(root, 'button')[0].dispatch('click');
		await s.actions.cancel();
		expect(s.state().error).toBe(strings['checkout.error.order_state']);
		cancel = /** @type {any} */ ({ ok: true });
		await s.actions.cancel();
		expect(events).toEqual(['success_page.shown', 'success_page.cancelled', 'success_page.shown']);
		const signedIn = createSuccessPage({ strings, client, order: { id: 'o2' } });
		await signedIn.actions.load();
		expect(signedIn.state().status).toBe('ready');
		const missing = createSuccessPage({ strings, client: fakeClient({}), order: { id: 'x' } });
		await missing.actions.load();
		expect(missing.state().status).toBe('error');
		expect(
			successUi.render({
				state: { ...s.state(), view: { ...view, bankDetails: [], order: { ...view.order, cancellable: false } } },
				actions: s.actions,
				strings,
				dom,
			}),
		).toBeTruthy();
		expect(s.validate()).toEqual([]);
	});

	it('collects required consents', async () => {
		const client = fakeClient({
			'GET /v1/policies': {
				items: [
					{ key: 'terms', label: 'Terms', url: 'https://x/t', required: true },
					{ key: 'privacy', label: 'Privacy', url: null, required: false },
				],
			},
		});
		const p = createPoliciesNotice({ strings, client });
		await p.actions.load();
		expect(p.validate()).toHaveLength(1);
		const root = policiesUi.render({ state: p.state(), actions: p.actions, strings, dom });
		all(root, 'input')[0].dispatch('change', { target: { checked: true } });
		await p.actions.setAccepted('terms', true);
		expect(p.consents()).toEqual(['terms']);
		expect(p.validate()).toEqual([]);
		await p.actions.setAccepted('terms', false);
		expect(p.consents()).toEqual([]);
		const failing = createPoliciesNotice({ strings, client: fakeClient({}) });
		await failing.actions.load();
		expect(failing.state().status).toBe('error');
	});

	it('asks for sign-in when the checkout needs it', async () => {
		const client = fakeClient({ 'GET /v1/signin-gate': { required: true, signedIn: false, signinUrl: '/login' } });
		/** @type {string[]} */
		const events = [];
		const g = createSigninGate({ strings, client, emit: (e) => events.push(e) });
		await g.actions.check({ returnTo: '/c', paymentMethod: 'cod', total: 5 });
		expect(client.calls[0]?.options.query).toEqual({ return: '/c', paymentMethod: 'cod', total: 5 });
		expect(g.validate()).toHaveLength(1);
		expect(all(gateUi.render({ state: g.state(), strings, dom }), 'a')).toHaveLength(1);
		expect(events).toEqual(['signin_gate.prompted']);
		const ok = createSigninGate({
			strings,
			client: fakeClient({ 'GET /v1/signin-gate': { required: false, signedIn: true, signinUrl: null } }),
		});
		await ok.actions.check();
		expect(ok.state().message).toBe(strings['signin.signed_in']);
		expect(ok.validate()).toEqual([]);
		const failing = createSigninGate({ strings, client: fakeClient({}) });
		await failing.actions.check();
		expect(failing.state().status).toBe('error');
	});
});
