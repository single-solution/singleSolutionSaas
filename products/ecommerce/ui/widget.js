/**
 * Starts the widgets on a page (PLAN 0.4.10). `widget.js` is the same for every website. With `data-token` on its
 * script tag (the website's browser token) it fetches the website's widget config and mounts the visitor widgets of
 * switched-on features into the elements the merchant placed (`<div data-ss-ecommerce="product_grid"></div>`, …),
 * and offers `window.SSEcommerce`:
 *
 * - `identify(signIn | null)`: the shopper's Accounts sign-in (PLAN 0.4.6), sent in `SS-Sign-In` on visitor calls;
 * - `addToCart({ productId, variantId?, quantity? })`: adds to the cart kept in the browser;
 * - `cart.count()`, `cart.onChange(listener)`: the cart for the merchant's own header;
 * - `admin({ getTicket })`: on the merchant's admin pages (no `data-token`), mounts the admin widgets with tickets.
 *
 * It also handles the `ss-ecommerce:add-to-cart` window event (Chat's product cards, PLAN 0.8.4). Both ways of adding
 * dispatch Growth's `ss:add_to_cart` (PLAN 0.8.9) once the product's name and price are read from the catalog (an
 * unreadable product still dispatches it, with an empty name and price 0). Widgets render nothing while the product
 * is stopped, their feature is off or the merchant database is not connected.
 * @module
 */
import { GROWTH_EVENTS, growthItem, itemsDetail } from '../core/growth-events.js';
import { isCurrency } from '../core/money.js';
import { ADD_TO_CART_EVENT, WIDGET_ATTRIBUTE, WIDGET_FEATURES, WIDGET_GLOBAL } from '../core/widgets.js';
import { mountCart } from './cart.js';
import { MAX_QUANTITY, createCartStore } from './cart-store.js';
import { mountCatalogAdmin } from './catalog-admin.js';
import { mountCompare } from './compare.js';
import { mountCustomersAdmin } from './customers-admin.js';
import { mountMyOrders } from './my-orders.js';
import { mountOrdersAdmin } from './orders-admin.js';
import { mountProductGrid } from './product-grid.js';
import { mountProductPage } from './product-page.js';
import { mountPromotionsAdmin } from './promotions-admin.js';
import { announce } from './shop-common.js';
import { createTicketSource } from './tickets.js';
import { mountWishlist } from './wishlist.js';

/** The kit's widget config routes (browser token; ticket). */
export const CONFIG_PATH = '/v1/widget/config';
export const ADMIN_CONFIG_PATH = '/v1/widget/admin/config';

/**
 * The website's widget config, from the kit.
 * @typedef {object} WidgetConfig
 * @property {Record<string, string>} texts the widget texts (the website's own, else the defaults)
 * @property {import('@ss/app-kit/widget').WidgetTheme} theme
 * @property {string} customCss
 * @property {typeof import('@ss/app-kit/widget').DEFAULT_FORMAT} [format] how money and dates look (PLAN 0.8.10 K7)
 * @property {string} [timeZone] the business.json time zone (UTC when missing)
 * @property {string[]} features the switched-on features
 * @property {Record<string, any>} settings what the visitor widgets need (`currency`, and each part's `widgetSettings`)
 */

/** @typedef {{ ok: boolean, status: number, data: any }} Answer status 0 when unreachable */

/**
 * The visitor API as widgets use it.
 * @typedef {object} Shop
 * @property {(path: string, init?: { method?: string, body?: unknown, idempotencyKey?: string }) => Promise<Answer>} call
 *   a visitor route with the browser token, and the shopper's sign-in when there is one
 * @property {() => string | null} signIn the shopper's Accounts sign-in, or null (a guest)
 * @property {(listener: (signIn: string | null) => void) => () => void} onIdentity
 * @property {import('./cart-store.js').CartStore} cart
 * @property {(feature: string) => boolean} has whether a feature is on
 * @property {(url: string) => void} go send the browser to an address (the payment page, a product page)
 * @property {() => URL} location the page's address (the success page reads `ss_order`)
 * @property {() => string} newKey a fresh Idempotency-Key
 * @property {(path: string) => Promise<{ ok: boolean, status: number, text: string }>} document a visitor route that
 *   answers a document (the invoice's HTML), with the same headers as `call`; status 0 when unreachable
 */

/**
 * What a visitor widget's mount function receives.
 * @typedef {{ host: HTMLElement, config: WidgetConfig, shop: Shop, win: Window & typeof globalThis }} VisitorMount
 */

/**
 * What an admin widget's mount function receives (`adminCall(api, method, path, body)` from `./tickets.js`).
 * @typedef {{ host: HTMLElement, config: WidgetConfig, api: import('./tickets.js').AdminApi,
 *   win: Window & typeof globalThis, save: (name: string, text: string, type?: string) => void,
 *   open: (url: string) => void }} AdminMount
 */

/** Visitor widgets by key. @type {Record<string, (input: VisitorMount) => Promise<void>>} */
const VISITOR = {
	product_grid: mountProductGrid,
	product_page: mountProductPage,
	cart: mountCart,
	my_orders: mountMyOrders,
	wishlist: mountWishlist,
	compare: mountCompare,
};

/** Admin widgets by key. @type {Record<string, (input: AdminMount) => Promise<void>>} */
const ADMIN = {
	catalog_admin: mountCatalogAdmin,
	orders_admin: mountOrdersAdmin,
	promotions_admin: mountPromotionsAdmin,
	customers_admin: mountCustomersAdmin,
};

/**
 * @param {typeof globalThis.fetch} request
 * @param {string} url
 * @param {string} credential browser token or ticket
 * @returns {Promise<WidgetConfig | null>} null when the product says no (stopped, database not connected …)
 */
const loadConfig = async (request, url, credential) => {
	try {
		const response = await request(url, { headers: { authorization: `Bearer ${credential}` } });
		return response.ok ? /** @type {WidgetConfig} */ (await response.json()) : null;
	} catch {
		return null;
	}
};

/**
 * @param {Window & typeof globalThis} win
 * @returns {Storage | null}
 */
const storageOf = (win) => {
	try {
		return win.localStorage;
	} catch {
		return null;
	}
};

/**
 * @param {{ window: Window & typeof globalThis, script: HTMLScriptElement | null }} input
 * @returns {{ ready: Promise<void>, api: Record<string, unknown> }} `ready` settles once the visitor widgets are mounted
 */
export const startWidget = ({ window: win, script }) => {
	const doc = win.document;
	const base = new URL(script?.src ?? win.location.href).origin;
	const token = script?.dataset.token;
	/** @param {string} key */
	const hosts = (key) => /** @type {HTMLElement[]} */ ([...doc.querySelectorAll(`[${WIDGET_ATTRIBUTE}="${key}"]`)]);
	/** @type {typeof globalThis.fetch} */
	const request = (input, init) => win.fetch(input, init);
	/** @param {WidgetConfig} config @param {string} key */
	const on = (config, key) =>
		(WIDGET_FEATURES[/** @type {keyof typeof WIDGET_FEATURES} */ (key)] ?? []).some((feature) =>
			config.features.includes(feature),
		);

	const cart = createCartStore({ storage: storageOf(win) });
	/** @type {string | null} */
	let signIn = null;
	/** @type {Set<(signIn: string | null) => void>} */
	const identityListeners = new Set();
	/** @type {WidgetConfig | null} */
	let visitorConfig = null;

	/** @type {Shop['call']} */
	const call = async (path, init = {}) => {
		try {
			const response = await request(`${base}${path}`, {
				method: init.method ?? 'GET',
				headers: {
					authorization: `Bearer ${token}`,
					...(signIn ? { 'ss-sign-in': signIn } : {}),
					...(init.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}),
					...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
				},
				...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
			});
			const data = response.status === 204 ? null : await response.json().catch(() => null);
			return { ok: response.ok, status: response.status, data };
		} catch {
			return { ok: false, status: 0, data: null };
		}
	};

	/** @type {Shop['document']} */
	const fetchDocument = async (path) => {
		try {
			const response = await request(`${base}${path}`, {
				headers: { authorization: `Bearer ${token}`, ...(signIn ? { 'ss-sign-in': signIn } : {}) },
			});
			return { ok: response.ok, status: response.status, text: await response.text() };
		} catch {
			return { ok: false, status: 0, text: '' };
		}
	};

	/**
	 * Growth's `ss:add_to_cart` for a line added here, with the product's name and price from the catalog.
	 * @param {import('./cart-store.js').CartLine} line
	 * @param {string} fallback the shop's currency
	 */
	const tellAdded = async (line, fallback) => {
		const found = await call(`/v1/shop/products/${encodeURIComponent(line.productId)}`);
		const product = found.ok ? found.data : null;
		const variants = Array.isArray(product?.variants) ? product.variants : [];
		const variant = variants.find((/** @type {{ id: unknown }} */ entry) => entry.id === line.variantId);
		announce(
			win,
			GROWTH_EVENTS.addToCart,
			itemsDetail(isCurrency(product?.currency) ? product.currency : fallback, [
				growthItem({ ...line, name: product?.name, price: variant?.price ?? product?.price }),
			]),
		);
	};

	/** @param {{ productId?: unknown, variantId?: unknown, quantity?: unknown }} item @returns {boolean} added */
	const addToCart = (item) => {
		if (!visitorConfig?.features.includes('checkout') || typeof item?.productId !== 'string') return false;
		const line = {
			productId: item.productId,
			variantId: typeof item.variantId === 'string' ? item.variantId : null,
			quantity: Number.isSafeInteger(item.quantity) ? Math.max(1, Math.min(MAX_QUANTITY, Number(item.quantity))) : 1,
		};
		cart.add(line);
		void tellAdded(line, String(visitorConfig.settings?.currency ?? ''));
		return true;
	};

	const ready = (async () => {
		if (!token) return;
		const config = await loadConfig(request, `${base}${CONFIG_PATH}`, token);
		if (!config) return;
		visitorConfig = config;
		/** @type {Shop} */
		const shop = {
			call,
			document: fetchDocument,
			signIn: () => signIn,
			onIdentity: (listener) => {
				identityListeners.add(listener);
				return () => identityListeners.delete(listener);
			},
			cart,
			has: (feature) => config.features.includes(feature),
			go: (url) => win.location.assign(url),
			location: () => new URL(win.location.href),
			newKey: () =>
				typeof win.crypto?.randomUUID === 'function' ? win.crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
		};
		win.addEventListener(ADD_TO_CART_EVENT, (event) => {
			const detail = /** @type {CustomEvent} */ (event).detail;
			if (addToCart(detail ?? {})) event.preventDefault();
		});
		await Promise.all(
			Object.entries(VISITOR)
				.filter(([key]) => on(config, key))
				.flatMap(([key, mount]) => hosts(key).map((host) => mount({ host, config, shop, win }))),
		);
	})();

	/** @param {{ getTicket: import('./tickets.js').GetTicket }} options */
	const admin = async ({ getTicket }) => {
		/** @type {import('./tickets.js').Ticket} */
		let first;
		try {
			first = await getTicket();
		} catch {
			return;
		}
		if (typeof first?.ticket !== 'string') return;
		const config = await loadConfig(request, `${base}${ADMIN_CONFIG_PATH}`, first.ticket);
		if (!config) return;
		const tickets = createTicketSource({
			first,
			getTicket,
			schedule: (task, ms) => win.setTimeout(task, ms),
			cancel: (id) => win.clearTimeout(id),
			now: () => Date.now(),
		});
		const api = { base, tickets, fetch: request };
		/** @type {AdminMount['save']} */
		const save = (name, text, type = 'text/csv;charset=utf-8') => {
			const link = doc.createElement('a');
			link.href = win.URL.createObjectURL(new win.Blob([text], { type }));
			link.download = name;
			link.click();
			win.URL.revokeObjectURL(link.href);
		};
		const open = (/** @type {string} */ url) => void win.open(url, '_blank', 'noopener');
		await Promise.all(
			Object.entries(ADMIN)
				.filter(([key]) => on(config, key))
				.flatMap(([key, mount]) => hosts(key).map((host) => mount({ host, config, api, win, save, open }))),
		);
	};

	const api = Object.freeze({
		admin,
		/** @param {string | null} next the shopper's Accounts sign-in, or null on sign-out */
		identify: (next) => {
			signIn = typeof next === 'string' && next ? next : null;
			for (const listener of identityListeners) listener(signIn);
		},
		addToCart,
		cart: Object.freeze({ count: cart.count, onChange: cart.onChange }),
	});
	Object.assign(win, { [WIDGET_GLOBAL]: api });
	return { ready, api };
};
