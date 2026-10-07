/**
 * The apply box: headless core (Mode B) against a scripted Mode C client, and the default renderer (Mode A) on a fake
 * DOM — tokens only, labels, live region, keyboard (form submit), variants and slots.
 */
import { describe, expect, it } from 'vitest';
import { createApplyBox } from '../headless/applyBox.js';
import { render, styles } from '../ui/applyBox.js';
import en from '../strings/en.json' with { type: 'json' };
import { createFakeDom, findAll } from './helpers.js';

/** A quote as `POST /v1/quotes` returns it. @param {string[]} codes */
const quoteFor = (codes) => {
	const applied = codes
		.filter((code) => code.toUpperCase() !== 'BAD' && code.toUpperCase() !== 'SHIP')
		.map((code) => ({
			code: code.toUpperCase(),
			name: code,
			discount: 500,
			shippingDiscount: 0,
			freeShipping: false,
		}));
	if (codes.some((code) => code.toUpperCase() === 'SHIP'))
		applied.push({ code: 'SHIP', name: 'Ship', discount: 0, shippingDiscount: 300, freeShipping: true });
	const discount = applied.reduce((sum, c) => sum + c.discount, 0);
	const shippingDiscount = applied.reduce((sum, c) => sum + c.shippingDiscount, 0);
	return {
		currency: 'EUR',
		subtotal: 5000,
		discount,
		shipping: 300,
		shippingDiscount,
		total: 5300 - discount - shippingDiscount,
		freeShipping: shippingDiscount > 0,
		gifts: [],
		applied,
		rejected: codes.filter((code) => code.toUpperCase() === 'BAD').map((code) => ({ code, reason: 'code_not_found' })),
	};
};

/** @param {{ fail?: string }} [options] */
const scriptedClient = ({ fail } = {}) => {
	/** @type {Array<{ codes: string[], cart: Record<string, unknown> }>} */
	const calls = [];
	return {
		calls,
		/** @param {{ codes: string[], cart: Record<string, unknown> }} body */
		quote: async (body) => {
			calls.push(body);
			if (fail) return { ok: /** @type {const} */ (false), problem: { code: fail } };
			return { ok: /** @type {const} */ (true), value: quoteFor(body.codes) };
		},
	};
};

const CART = { currency: 'EUR', lines: [{ itemId: 'i', quantity: 1, unitAmount: 5000 }] };

describe('headless apply box', () => {
	it('applies codes through quotes, shows savings, removes and clears', async () => {
		const client = scriptedClient();
		/** @type {Array<[string, unknown]>} */
		const events = [];
		const box = createApplyBox({
			config: { max_codes: 2 },
			strings: en,
			client,
			cart: CART,
			emit: (name, data) => events.push([name, data]),
		});
		/** @type {unknown[]} */
		const seen = [];
		const off = box.subscribe((state) => seen.push(state.status));
		expect(box.state()).toMatchObject({ status: 'idle', applied: [], maxCodes: 2, variant: 'inline', expanded: true });
		await box.actions.setCode('save5');
		const applied = await box.actions.apply();
		expect(applied.ok).toBe(true);
		expect(box.state()).toMatchObject({
			status: 'ready',
			code: '',
			savingsText: 'You save €5.00',
			message: 'SAVE5 applied — you save €5.00.',
		});
		expect(box.state().applied).toEqual([{ code: 'SAVE5', name: 'save5', savingsText: '€5.00' }]);
		await box.actions.setCode('ship');
		await box.actions.apply();
		expect(box.state().applied.map((entry) => entry.savingsText)).toEqual(['€5.00', 'Free shipping']);
		expect(client.calls.at(-1)?.codes).toEqual(['SAVE5', 'ship']);
		await box.actions.setCode('third');
		expect((await box.actions.apply()).ok).toBe(false);
		expect(box.state().errorCode).toBe('too_many_coupons');
		await box.actions.remove('SHIP');
		expect(box.state().applied.map((entry) => entry.code)).toEqual(['SAVE5']);
		await box.actions.setCart({ ...CART, shipping: 0 });
		expect(client.calls.at(-1)?.cart).toMatchObject({ shipping: 0 });
		await box.actions.clear();
		expect(box.state()).toMatchObject({ applied: [], quote: null, savingsText: null });
		expect(events.map(([name]) => name)).toEqual(['apply_box.applied', 'apply_box.applied', 'apply_box.removed']);
		expect(seen.length).toBeGreaterThan(5);
		off();
		expect(box.formatMoney(1234, 'EUR')).toBe('€12.34');
		const before = box.state().code;
		box.destroy();
		await box.actions.setCode('ignored');
		expect(box.state().code).toBe(before);
	});

	it('explains refusals and failures with catalog strings', async () => {
		const box = createApplyBox({ strings: en, client: scriptedClient(), cart: CART });
		expect((await box.actions.apply()).ok).toBe(false);
		expect(box.state()).toMatchObject({ status: 'error', errorCode: 'required', error: 'Please enter a code.' });
		await box.actions.setCode('no spaces!');
		await box.actions.apply();
		expect(box.state().errorCode).toBe('code_invalid');
		await box.actions.setCode('bad');
		const refused = await box.actions.apply();
		expect(refused).toEqual({ ok: false, problem: { code: 'code_not_found' } });
		expect(box.state().error).toBe('This code does not exist.');
		await box.actions.setCode('good');
		await box.actions.apply();
		await box.actions.setCode('GOOD');
		await box.actions.apply();
		expect(box.state().errorCode).toBe('already_applied');
		const failing = createApplyBox({ strings: en, client: scriptedClient({ fail: 'velocity_limited' }), cart: CART });
		await failing.actions.setCode('x1');
		await failing.actions.apply();
		expect(failing.state().error).toBe('Too many attempts. Please wait a few minutes.');
		const unknown = createApplyBox({ strings: en, client: scriptedClient({ fail: 'teapot' }), cart: CART });
		await unknown.actions.setCode('x1');
		await unknown.actions.apply();
		expect(unknown.state().error).toBe('The code could not be checked. Please try again.');
		expect((await unknown.actions.setCart(CART)).ok).toBe(true); // nothing applied: no request
		const noCart = createApplyBox({ strings: en, client: scriptedClient() });
		await noCart.actions.setCode('x1');
		await noCart.actions.apply();
		expect(noCart.state().errorCode).toBe('cart_required');
		const errorClient = { quote: async () => ({ ok: /** @type {const} */ (false), error: { code: 'network_error' } }) };
		const viaError = createApplyBox({ strings: en, client: errorClient, cart: CART });
		await viaError.actions.setCode('x1');
		await viaError.actions.apply();
		expect(viaError.state().errorCode).toBe('network_error');
		expect(box.validate('ok-1')).toEqual([]);
	});

	it('re-quotes failures, auto-applies codes from links and toggles the collapsible variant', async () => {
		let fail = false;
		const client = {
			quote: async (/** @type {any} */ body) =>
				fail
					? { ok: /** @type {const} */ (false), problem: { code: 'rate_limited' } }
					: { ok: /** @type {const} */ (true), value: quoteFor(body.codes) },
		};
		const box = createApplyBox({
			config: { variant: 'collapsible', auto_apply_param: 'promo' },
			strings: en,
			client,
			cart: CART,
		});
		expect(box.state()).toMatchObject({ variant: 'collapsible', expanded: false });
		await box.actions.toggle();
		expect(box.state().expanded).toBe(true);
		expect(await box.actions.applyFromUrl('https://shop.example.com/')).toEqual({ ok: false, problem: { code: 'no_code' } });
		expect((await box.actions.applyFromUrl('https://shop.example.com/?promo=link5')).ok).toBe(true);
		expect(box.state().applied.map((entry) => entry.code)).toEqual(['LINK5']);
		fail = true;
		expect((await box.actions.setCart(CART)).ok).toBe(false);
		expect(box.state().errorCode).toBe('rate_limited');
		const off = createApplyBox({ config: { auto_apply_from_url: false }, strings: en, client, cart: CART });
		expect(await off.actions.applyFromUrl('?coupon=X1')).toEqual({ ok: false, problem: { code: 'disabled' } });
	});
});

describe('apply box renderer', () => {
	const actions = () => {
		/** @type {string[]} */
		const calls = [];
		return {
			calls,
			setCode: (/** @type {string} */ code) => calls.push(`set:${code}`),
			apply: () => calls.push('apply'),
			remove: (/** @type {string} */ code) => calls.push(`remove:${code}`),
			toggle: () => calls.push('toggle'),
		};
	};

	it('renders an accessible form, applied codes and the live region with tokens only', async () => {
		const box = createApplyBox({ strings: en, client: scriptedClient(), cart: CART, config: { max_codes: 1 } });
		await box.actions.setCode('save5');
		await box.actions.apply();
		const dom = createFakeDom();
		const handlers = actions();
		const root = render({
			state: box.state(),
			actions: handlers,
			strings: en,
			slots: { success: dom.createTextNode('thanks') },
			dom,
		});
		expect(root.attributes).toMatchObject({
			role: 'region',
			'aria-label': 'Coupon code',
			'aria-busy': 'false',
			class: 'ss-apply ss-apply--inline',
		});
		const [form] = findAll(root, (node) => node.tag === 'form');
		const [input] = findAll(root, (node) => node.tag === 'input');
		const [label] = findAll(root, (node) => node.tag === 'label');
		expect(label.attributes.for).toBe(input.attributes.id);
		const [submit] = findAll(root, (node) => node.tag === 'button' && node.attributes.type === 'submit');
		expect(submit.attributes.disabled).toBe(''); // one code allowed and applied
		input.dispatch('input', { target: { value: 'NEXT' } });
		form.dispatch('submit', { preventDefault: () => handlers.calls.push('prevented') });
		const [remove] = findAll(root, (node) => node.attributes?.class === 'ss-apply__remove');
		expect(remove.attributes['aria-label']).toBe('Remove code SAVE5');
		remove.dispatch('click');
		expect(handlers.calls).toEqual(['set:NEXT', 'prevented', 'apply', 'remove:SAVE5']);
		const [status] = findAll(root, (node) => node.attributes?.role === 'status');
		expect(status.attributes['aria-live']).toBe('polite');
		expect(status.textContent).toBe('SAVE5 applied — you save €5.00.');
		expect(root.textContent).toContain('You save €5.00');
		expect(root.textContent).toContain('thanks');
		expect(styles).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
		expect(styles).toContain('prefers-reduced-motion');
	});

	it('renders the collapsible variant, errors, loading and slots', () => {
		const dom = createFakeDom();
		const handlers = actions();
		const base = createApplyBox({ strings: en, client: scriptedClient(), config: { variant: 'collapsible' } }).state();
		const closed = render({ state: base, actions: handlers, strings: en, dom });
		expect(findAll(closed, (node) => node.tag === 'form')).toHaveLength(0);
		const [toggle] = findAll(closed, (node) => node.attributes?.class === 'ss-apply__toggle');
		expect(toggle.attributes['aria-expanded']).toBe('false');
		toggle.dispatch('click');
		expect(handlers.calls).toEqual(['toggle']);
		const open = render({
			state: { ...base, expanded: true, status: 'loading', error: 'Nope', errorCode: 'x' },
			actions: handlers,
			strings: en,
			theme: { variant: 'collapsible' },
			slots: { before: dom.createTextNode('B'), after: dom.createTextNode('A') },
			dom,
		});
		expect(open.attributes['aria-busy']).toBe('true');
		const [input] = findAll(open, (node) => node.tag === 'input');
		expect(input.attributes['aria-invalid']).toBe('true');
		input.dispatch('input', {});
		expect(handlers.calls.at(-1)).toBe('set:');
		expect(open.textContent).toMatch(/^B.*Applying….*Nope.*A$/);
		const [form] = findAll(open, (node) => node.tag === 'form');
		form.dispatch('submit', {});
		expect(handlers.calls.at(-1)).toBe('apply');
	});
});
