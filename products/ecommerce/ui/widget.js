/**
 * Starts the widgets on a page (PLAN 0.4.10). `widget.js` is the same for every website. With `data-token` on its
 * script tag (the website's browser token) it fetches the website's widget config and mounts the visitor widgets of
 * switched-on features into the elements the merchant placed (`<div data-ss-ecommerce="product_grid"></div>`, …),
 * and offers `window.SSEcommerce`:
 *
 * - `identify(signIn | null)`: the shopper's Accounts sign-in (PLAN 0.4.6), sent in `SS-Sign-In` on visitor calls;
 *   a guest's order keys (E21) are kept in the browser and each goes in `SS-Order-Key` with the calls about its order;
 * - `addToCart({ productId, variantId?, quantity?, measured? })`: adds to the cart kept in the browser (an item sold in
 *   a unit of its own: `quantity` in thousandths of its unit with `measured: true`);
 * - `cart.count()`, `cart.onChange(listener)`: the cart for the merchant's own header;
 * - `admin({ getTicket })`: on the merchant's admin pages (no `data-token`), mounts the admin widgets with tickets.
 *
 * A visitor call with an `Idempotency-Key` that the product answers 409 `in_progress` (the same request, sent before,
 * still runs: K-14) is sent again with the same key after its `Retry-After`, a few times, so a shopper whose first press
 * of Place order lost its answer gets that order, never a second one.
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
import { mountAlertsStop } from './alerts-stop.js';
import { mountCart } from './cart.js';
import { MAX_MEASURED, MAX_QUANTITY, createCartStore } from './cart-store.js';
import { mountCatalogAdmin } from './catalog-admin.js';
import { mountCompare } from './compare.js';
import { mountCustomersAdmin } from './customers-admin.js';
import { mountMyOrders } from './my-orders.js';
import { mountOrdersAdmin } from './orders-admin.js';
import { mountProductGrid } from './product-grid.js';
import { mountProductPage } from './product-page.js';
import { mountPromotionsAdmin } from './promotions-admin.js';
import { announce } from './shop-common.js';
import { createOrderKeys } from './order-keys.js';
import { createTicketSource } from '@ss/app-kit/widget';
import { mountWishlist } from './wishlist.js';

/** The kit's widget config routes (browser token; ticket). */
export const CONFIG_PATH = '/v1/widget/config';
export const ADMIN_CONFIG_PATH = '/v1/widget/admin/config';
/** A call answered 409 `in_progress` is sent again with its Idempotency-Key at most this many times (K-14). */
export const IN_PROGRESS_RETRIES = 4;
/** The longest wait before such a retry (seconds), whatever `Retry-After` says; 1 second without one. */
const IN_PROGRESS_MAX_WAIT_S = 5;

/**
 * Seconds to wait before sending a request still in progress again, from its `Retry-After` (seconds).
 * @param {string | null} header
 */
const retryAfterSeconds = (header) => {
	const seconds = Number(header);
	return header !== null && header.trim() !== '' && Number.isFinite(seconds) && seconds >= 0
		? Math.min(seconds, IN_PROGRESS_MAX_WAIT_S)
		: 1;
};

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
 * @property {(orderId: string, key: string) => void} keepOrderKey keep a guest order's key (its answer's `orderKey`, E21)
 * @property {() => string[]} guestOrders the ids of the guest orders whose keys this browser keeps, the newest first
 */

/**
 * What a visitor widget's mount function receives.
 * @typedef {{ host: HTMLElement, config: WidgetConfig, shop: Shop, win: Window & typeof globalThis }} VisitorMount
 */

/**
 * What an admin widget's mount function receives (`adminCall(api, method, path, body)` from `@ss/app-kit/widget`).
 * @typedef {{ host: HTMLElement, config: WidgetConfig, api: import('@ss/app-kit/widget').AdminApi,
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
	alerts_stop: mountAlertsStop,
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
	const orderKeys = createOrderKeys({ storage: storageOf(win) });
	/**
	 * The `SS-Order-Key` header of a call about a guest order whose key the browser keeps: its path names the order
	 * (`/v1/shop/orders/<id>…`) or its body does (`orderId`, a review of an item).
	 * @param {string} path @param {unknown} [body]
	 * @returns {Record<string, string>}
	 */
	const orderKeyHeader = (path, body) => {
		const named = /^\/v1\/shop\/orders\/(ord_[A-Za-z0-9_-]{1,64})(?:[/?]|$)/.exec(path)?.[1];
		const id = named ?? (typeof (/** @type {any} */ (body)?.orderId) === 'string' ? /** @type {any} */ (body).orderId : null);
		const key = id ? orderKeys.keyOf(id) : null;
		return key ? { 'ss-order-key': key } : {};
	};
	/** @type {string | null} */
	let signIn = null;
	/** @type {Set<(signIn: string | null) => void>} */
	const identityListeners = new Set();
	/** @type {WidgetConfig | null} */
	let visitorConfig = null;

	/** @param {number} seconds */
	const pause = (seconds) => new Promise((resolve) => win.setTimeout(resolve, seconds * 1000));

	/** @type {Shop['call']} */
	const call = async (path, init = {}) => {
		for (let retries = 0; ; retries += 1) {
			try {
				const response = await request(`${base}${path}`, {
					method: init.method ?? 'GET',
					headers: {
						authorization: `Bearer ${token}`,
						...(signIn ? { 'ss-sign-in': signIn } : {}),
						...orderKeyHeader(path, init.body),
						...(init.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}),
						...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
					},
					...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
				});
				const data = response.status === 204 ? null : await response.json().catch(() => null);
				// the same request sent before still runs: ask again with the same key once it may have finished (K-14)
				const running = response.status === 409 && typeof data?.type === 'string' && data.type.endsWith('/in_progress');
				if (running && init.idempotencyKey && retries < IN_PROGRESS_RETRIES) {
					await pause(retryAfterSeconds(response.headers.get('retry-after')));
					continue;
				}
				return { ok: response.ok, status: response.status, data };
			} catch {
				return { ok: false, status: 0, data: null };
			}
		}
	};

	/** @type {Shop['document']} */
	const fetchDocument = async (path) => {
		try {
			const response = await request(`${base}${path}`, {
				headers: {
					authorization: `Bearer ${token}`,
					...(signIn ? { 'ss-sign-in': signIn } : {}),
					...orderKeyHeader(path),
				},
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
				growthItem({ ...line, name: product?.name, price: variant?.price ?? product?.price, measure: product?.measure }),
			]),
		);
	};

	/**
	 * @param {{ productId?: unknown, variantId?: unknown, quantity?: unknown, measured?: unknown }} item `measured`: an
	 *   item sold in a unit of its own, its quantity in thousandths of the unit
	 * @returns {boolean} added
	 */
	const addToCart = (item) => {
		if (!visitorConfig?.features.includes('checkout') || typeof item?.productId !== 'string') return false;
		const measured = item.measured === true;
		const line = {
			productId: item.productId,
			variantId: typeof item.variantId === 'string' ? item.variantId : null,
			quantity: Number.isSafeInteger(item.quantity)
				? Math.max(1, Math.min(measured ? MAX_MEASURED : MAX_QUANTITY, Number(item.quantity)))
				: 1,
			...(measured ? { measured: true } : {}),
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
		// the shop's most lines in a cart (E4)
		cart.setLimits({ lines: Number(config.settings?.checkout?.maxLines) || undefined });
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
			keepOrderKey: orderKeys.keep,
			guestOrders: orderKeys.ids,
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

	/** @param {{ getTicket: import('@ss/app-kit/widget').GetTicket }} options */
	const admin = async ({ getTicket }) => {
		/** @type {import('@ss/app-kit/widget').Ticket} */
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
