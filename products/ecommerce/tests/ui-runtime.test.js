// @vitest-environment jsdom
/* global document, window */
/**
 * The widget runtime (ui/widget.js): the visitor config with the browser token, which widgets mount, the shopper's
 * sign-in on visitor calls, the cart in the browser, the add-to-cart event Chat's product cards dispatch, and the
 * admin widgets with tickets. The widgets themselves are replaced by spies here (they have their own tests).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADD_TO_CART_EVENT, STORAGE_KEYS, WIDGET_ATTRIBUTE, WIDGET_GLOBAL } from '../core/widgets.js';
import { MAX_LINES, MAX_QUANTITY, createCartStore } from '../ui/cart-store.js';
import { adminCall, createTicketSource } from '../ui/tickets.js';
import { flush, growthEvents } from './ui-shop-helpers.js';

const mounts = vi.hoisted(() => ({ visitor: /** @type {any[]} */ ([]), admin: /** @type {any[]} */ ([]) }));
vi.mock('../ui/product-grid.js', () => ({
	mountProductGrid: async (/** @type {any} */ input) => void mounts.visitor.push(['product_grid', input]),
}));
vi.mock('../ui/product-page.js', () => ({
	mountProductPage: async (/** @type {any} */ input) => void mounts.visitor.push(['product_page', input]),
}));
vi.mock('../ui/cart.js', () => ({ mountCart: async (/** @type {any} */ input) => void mounts.visitor.push(['cart', input]) }));
vi.mock('../ui/my-orders.js', () => ({
	mountMyOrders: async (/** @type {any} */ input) => void mounts.visitor.push(['my_orders', input]),
}));
vi.mock('../ui/wishlist.js', () => ({
	mountWishlist: async (/** @type {any} */ input) => void mounts.visitor.push(['wishlist', input]),
}));
vi.mock('../ui/compare.js', () => ({
	mountCompare: async (/** @type {any} */ input) => void mounts.visitor.push(['compare', input]),
}));
vi.mock('../ui/catalog-admin.js', () => ({
	mountCatalogAdmin: async (/** @type {any} */ input) => void mounts.admin.push(['catalog_admin', input]),
}));
vi.mock('../ui/orders-admin.js', () => ({
	mountOrdersAdmin: async (/** @type {any} */ input) => void mounts.admin.push(['orders_admin', input]),
}));
vi.mock('../ui/promotions-admin.js', () => ({
	mountPromotionsAdmin: async (/** @type {any} */ input) => void mounts.admin.push(['promotions_admin', input]),
}));
vi.mock('../ui/customers-admin.js', () => ({
	mountCustomersAdmin: async (/** @type {any} */ input) => void mounts.admin.push(['customers_admin', input]),
}));

const { ADMIN_CONFIG_PATH, CONFIG_PATH, startWidget } = await import('../ui/widget.js');

const BASE = 'https://ecommerce.example.dev';

/** @param {string[]} features */
const configOf = (features) => ({ texts: {}, theme: { mode: 'light' }, customCss: '', features, settings: { currency: 'USD' } });

/** @param {string} key */
const place = (key) => {
	const host = document.createElement('div');
	host.setAttribute(WIDGET_ATTRIBUTE, key);
	document.body.append(host);
	return host;
};

/** @param {string | null} token */
const script = (token) => {
	const node = document.createElement('script');
	node.src = `${BASE}/widget.js`;
	if (token) node.dataset.token = token;
	return node;
};

/** @param {number} status @param {unknown} [body] */
const answer = (status, body = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status });

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
	window.localStorage.clear();
	mounts.visitor.length = 0;
	mounts.admin.length = 0;
});

describe('visitor widgets', () => {
	it('mount only the widgets of switched-on features, with the browser token and the shopper’s sign-in', async () => {
		place('product_grid');
		place('cart');
		place('wishlist');
		const fetch = vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
			const url = new URL(String(input));
			if (url.pathname === CONFIG_PATH) return answer(200, configOf(['catalog', 'checkout']));
			if (url.pathname === '/v1/shop/thing') return answer(200, { ok: 1 });
			if (url.pathname === '/v1/shop/empty') return answer(204);
			return answer(404, { type: 'not_found' });
		});
		const { ready, api } = startWidget({ window, script: script('browser-token') });
		await ready;
		expect(mounts.visitor.map(([key]) => key)).toEqual(['product_grid', 'cart']);
		expect(/** @type {any} */ (window)[WIDGET_GLOBAL]).toBe(api);
		const shop = mounts.visitor[0][1].shop;
		expect(shop.has('catalog')).toBe(true);
		expect(shop.has('wishlist')).toBe(false);
		expect(shop.signIn()).toBeNull();
		const heard = vi.fn();
		const stop = shop.onIdentity(heard);
		/** @type {any} */ (api).identify('sign-in-1');
		expect(heard).toHaveBeenCalledWith('sign-in-1');
		stop();
		expect(await shop.call('/v1/shop/thing', { method: 'POST', body: { a: 1 }, idempotencyKey: 'k1' })).toEqual({
			ok: true,
			status: 200,
			data: { ok: 1 },
		});
		const [, init] = /** @type {[unknown, RequestInit]} */ (fetch.mock.calls.at(-1));
		expect(init.headers).toEqual({
			authorization: 'Bearer browser-token',
			'ss-sign-in': 'sign-in-1',
			'idempotency-key': 'k1',
			'content-type': 'application/json',
		});
		expect(await shop.call('/v1/shop/empty')).toEqual({ ok: true, status: 204, data: null });
		expect(await shop.document('/v1/shop/thing')).toEqual({ ok: true, status: 200, text: '{"ok":1}' });
		fetch.mockRejectedValueOnce(new Error('offline'));
		expect(await shop.document('/v1/shop/thing')).toEqual({ ok: false, status: 0, text: '' });
		/** @type {any} */ (api).identify(null);
		expect(shop.signIn()).toBeNull();
		expect(typeof shop.newKey()).toBe('string');
		expect(shop.location().href).toBe(window.location.href);
		fetch.mockRejectedValueOnce(new Error('offline'));
		expect(await shop.call('/v1/shop/thing')).toEqual({ ok: false, status: 0, data: null });
	});

	it('add to cart from the page API and from Chat’s card event, only while checkout is on', async () => {
		vi.spyOn(window, 'fetch').mockResolvedValue(answer(200, configOf(['catalog', 'checkout'])));
		const { ready, api } = startWidget({ window, script: script('t') });
		const early = /** @type {any} */ (api).addToCart({ productId: 'prd_1' });
		expect(early).toBe(false);
		await ready;
		expect(/** @type {any} */ (api).addToCart({ productId: 'prd_1', variantId: 'var_1', quantity: 2 })).toBe(true);
		expect(/** @type {any} */ (api).addToCart({ productId: 7 })).toBe(false);
		const event = new window.CustomEvent(ADD_TO_CART_EVENT, { detail: { productId: 'prd_2' }, cancelable: true });
		window.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		const ignored = new window.CustomEvent(ADD_TO_CART_EVENT, { detail: null, cancelable: true });
		window.dispatchEvent(ignored);
		expect(ignored.defaultPrevented).toBe(false);
		expect(/** @type {any} */ (api).cart.count()).toBe(3);
		expect(JSON.parse(String(window.localStorage.getItem(STORAGE_KEYS.cart))).lines).toEqual([
			{ productId: 'prd_1', variantId: 'var_1', quantity: 2 },
			{ productId: 'prd_2', variantId: null, quantity: 1 },
		]);
	});

	it('tell Growth about lines added from the page API and Chat’s card event, priced from the catalog', async () => {
		const product = {
			id: 'prd_1',
			name: 'Phone One',
			price: 100000,
			currency: 'PKR',
			variants: [
				{ id: 'var_1', price: 100000 },
				{ id: 'var_2', price: 120000 },
			],
		};
		vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
			const url = new URL(String(input));
			if (url.pathname === CONFIG_PATH) return answer(200, configOf(['catalog', 'checkout']));
			if (url.pathname === '/v1/shop/products/prd_1') return answer(200, product);
			return answer(404, { type: 'not_found' });
		});
		const { ready, api } = startWidget({ window, script: script('t') });
		await ready;
		const events = growthEvents();
		const shop = /** @type {any} */ (api);
		shop.addToCart({ productId: 'prd_1', variantId: 'var_2', quantity: 2 });
		shop.addToCart({ productId: 'prd_1', quantity: 500 });
		shop.addToCart({ productId: 'prd_9', variantId: 'var_9' });
		await flush();
		expect(events.of('ss:add_to_cart')).toEqual([
			{
				currency: 'PKR',
				value: 240000,
				items: [{ id: 'prd_1', variantId: 'var_2', name: 'Phone One', price: 120000, quantity: 2 }],
			},
			{
				currency: 'PKR',
				value: 9900000,
				items: [{ id: 'prd_1', variantId: null, name: 'Phone One', price: 100000, quantity: 99 }],
			},
			{ currency: 'USD', value: 0, items: [{ id: 'prd_9', variantId: 'var_9', name: '', price: 0, quantity: 1 }] },
		]);
		events.seen.length = 0;
		window.dispatchEvent(
			new window.CustomEvent(ADD_TO_CART_EVENT, { detail: { productId: 'prd_1', variantId: 'var_1' }, cancelable: true }),
		);
		await flush();
		// widgets started by earlier tests listen too: every one tells the same
		expect(events.seen.length).toBeGreaterThan(0);
		for (const entry of events.seen)
			expect(entry).toEqual({
				name: 'ss:add_to_cart',
				detail: {
					currency: 'PKR',
					value: 100000,
					items: [{ id: 'prd_1', variantId: 'var_1', name: 'Phone One', price: 100000, quantity: 1 }],
				},
			});
		events.stop();
	});

	it('render nothing without a token or when the product says no', async () => {
		place('cart');
		const fetch = vi.spyOn(window, 'fetch').mockResolvedValue(answer(403, { type: 'product_unavailable' }));
		await startWidget({ window, script: script(null) }).ready;
		expect(fetch).not.toHaveBeenCalled();
		await startWidget({ window, script: script('t') }).ready;
		fetch.mockRejectedValueOnce(new Error('offline'));
		await startWidget({ window, script: script('t') }).ready;
		expect(mounts.visitor).toEqual([]);
	});
});

describe('admin widgets', () => {
	it('mount with a ticket, renew it and download files', async () => {
		place('orders_admin');
		place('customers_admin');
		place('promotions_admin');
		vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
			const url = new URL(String(input));
			if (url.pathname === ADMIN_CONFIG_PATH) {
				expect(/** @type {any} */ (init?.headers ?? {}).authorization).toBe('Bearer ticket-1');
				return answer(200, configOf(['catalog', 'checkout', 'reviews']));
			}
			return answer(404);
		});
		const { api } = startWidget({ window, script: script(null) });
		const getTicket = vi.fn(async () => ({ ticket: 'ticket-1', expiresAt: new Date(Date.now() + 900_000).toISOString() }));
		await /** @type {any} */ (api).admin({ getTicket });
		expect(mounts.admin.map(([key]) => key)).toEqual(['orders_admin', 'customers_admin']);
		const input = mounts.admin[0][1];
		expect(input.api.tickets.current()).toBe('ticket-1');
		input.api.tickets.stop();
		const open = vi.spyOn(window, 'open').mockReturnValue(null);
		input.open('https://example.com/x');
		expect(open).toHaveBeenCalledWith('https://example.com/x', '_blank', 'noopener');
		Object.assign(window.URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
		const click = vi.spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
		input.save('orders.csv', 'a,b');
		expect(click).toHaveBeenCalled();
	});

	it('mount nothing when the page gives no ticket or the config is refused', async () => {
		place('orders_admin');
		vi.spyOn(window, 'fetch').mockResolvedValue(answer(401));
		const { api } = startWidget({ window, script: script(null) });
		await /** @type {any} */ (api).admin({ getTicket: async () => Promise.reject(new Error('signed out')) });
		await /** @type {any} */ (api).admin({ getTicket: async () => /** @type {any} */ ({}) });
		await /** @type {any} */ (api).admin({ getTicket: async () => ({ ticket: 't', expiresAt: new Date().toISOString() }) });
		expect(mounts.admin).toEqual([]);
	});
});

describe('the cart store', () => {
	it('adds, merges, caps, sets, keeps a coupon and tells listeners', () => {
		/** @type {Map<string, string>} */
		const saved = new Map();
		const storage = /** @type {Storage} */ (
			/** @type {unknown} */ ({
				getItem: (/** @type {string} */ k) => saved.get(k) ?? null,
				setItem: (/** @type {string} */ k, /** @type {string} */ v) => void saved.set(k, v),
			})
		);
		const cart = createCartStore({ storage });
		const heard = vi.fn();
		const stop = cart.onChange(heard);
		cart.add({ productId: 'p1', variantId: null, quantity: 1 });
		cart.add({ productId: 'p1', variantId: null, quantity: 500 });
		cart.add({ productId: 'p2', variantId: 'v', quantity: 0, slot: '2026-10-06T09:00:00.000Z' });
		expect(cart.state().lines).toEqual([
			{ productId: 'p1', variantId: null, quantity: MAX_QUANTITY },
			{ productId: 'p2', variantId: 'v', quantity: 1, slot: '2026-10-06T09:00:00.000Z' },
		]);
		cart.set({ productId: 'p1', variantId: null, quantity: 1 }, 3);
		cart.set({ productId: 'p2', variantId: 'v', quantity: 1, slot: '2026-10-06T09:00:00.000Z' }, 0);
		cart.setCoupon('  save10 ');
		expect(cart.state()).toEqual({ lines: [{ productId: 'p1', variantId: null, quantity: 3 }], coupon: 'save10' });
		expect(createCartStore({ storage }).count()).toBe(3);
		cart.clear();
		expect(cart.count()).toBe(0);
		stop();
		cart.add({ productId: 'p3', variantId: null, quantity: 1 });
		expect(heard).toHaveBeenCalledTimes(7);
		for (let i = 0; i < MAX_LINES + 5; i += 1) cart.add({ productId: `x${i}`, variantId: null, quantity: 1 });
		expect(cart.state().lines).toHaveLength(MAX_LINES);
	});

	it('survives broken or blocked storage', () => {
		const broken = /** @type {Storage} */ (
			/** @type {unknown} */ ({
				getItem: () => '{"lines":[{"productId":"p","quantity":2,"variantId":5},{"quantity":1}],"coupon":7}',
				setItem: () => {
					throw new Error('full');
				},
			})
		);
		const cart = createCartStore({ storage: broken });
		expect(cart.state()).toEqual({ lines: [{ productId: 'p', variantId: null, quantity: 2 }], coupon: '' });
		cart.add({ productId: 'q', variantId: null, quantity: 1 });
		expect(cart.count()).toBe(3);
		expect(createCartStore({ storage: /** @type {any} */ ({ getItem: () => 'not json' }) }).count()).toBe(0);
		expect(
			createCartStore({
				storage: /** @type {any} */ ({
					getItem: () => {
						throw new Error('blocked');
					},
				}),
			}).count(),
		).toBe(0);
		expect(createCartStore({ storage: null }).count()).toBe(0);
	});
});

describe('tickets', () => {
	it('renew before expiry, sign out on failure, and call admin routes', async () => {
		/** @type {Array<() => void>} */
		const tasks = [];
		let n = 0;
		const getTicket = vi.fn(async () => {
			n += 1;
			if (n > 1) throw new Error('signed out');
			return { ticket: 'second', expiresAt: new Date(Date.now() + 900_000).toISOString() };
		});
		const source = createTicketSource({
			first: { ticket: 'first', expiresAt: new Date(Date.now() + 900_000).toISOString() },
			getTicket,
			schedule: (task) => tasks.push(task),
			cancel: () => {},
			now: () => Date.now(),
		});
		const heard = vi.fn();
		const stop = source.onChange(heard);
		tasks.shift()?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(source.current()).toBe('second');
		tasks.shift()?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(source.current()).toBeNull();
		expect(heard.mock.calls).toEqual([[true], [false]]);
		stop();
		source.stop();
		const fetch = vi.fn(async () => answer(200, { ok: true }));
		const api = { base: BASE, tickets: source, fetch: /** @type {any} */ (fetch) };
		expect(await adminCall(api, 'GET', '/v1/admin/orders')).toEqual({ ok: false, status: 0, data: null });
		const live = createTicketSource({
			first: { ticket: 'live', expiresAt: new Date(Date.now() + 900_000).toISOString() },
			getTicket,
			schedule: () => 1,
			cancel: () => {},
			now: () => Date.now(),
		});
		const liveApi = { base: BASE, tickets: live, fetch: /** @type {any} */ (fetch) };
		expect(await adminCall(liveApi, 'POST', '/v1/admin/orders/x/move', { to: 'confirmed' })).toEqual({
			ok: true,
			status: 200,
			data: { ok: true },
		});
		fetch.mockImplementationOnce(async () => answer(204));
		expect((await adminCall(liveApi, 'DELETE', '/v1/admin/x')).data).toBeNull();
		fetch.mockImplementationOnce(async () => {
			throw new Error('offline');
		});
		expect((await adminCall(liveApi, 'GET', '/v1/admin/x')).status).toBe(0);
	});
});
