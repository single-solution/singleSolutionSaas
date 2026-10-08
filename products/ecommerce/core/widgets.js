/**
 * Names the widgets, the docs and Chat's product cards share (PLAN 0.4.10): the browser global of `widget.js`
 * (`window.SSEcommerce`), the attribute of the elements the merchant places (`<div data-ss-ecommerce="cart"></div>`),
 * the feature of each widget, the add-to-cart event other widgets on the page (Chat's product cards) dispatch, and the
 * keys the shopper's browser keeps.
 * @module
 */

/** The browser global `widget.js` sets: `window.SSEcommerce.identify(signIn)`, `.addToCart(…)`, `.admin({ getTicket })`. */
export const WIDGET_GLOBAL = 'SSEcommerce';

/** Widgets mount only into elements with this attribute; its value is the widget key from manifest.json. */
export const WIDGET_ATTRIBUTE = 'data-ss-ecommerce';

/** The features of each widget (manifest.json `widgets`): a widget mounts only while one of them is on. */
export const WIDGET_FEATURES = Object.freeze({
	product_grid: Object.freeze(['catalog']),
	product_page: Object.freeze(['catalog']),
	cart: Object.freeze(['checkout']),
	my_orders: Object.freeze(['checkout']),
	wishlist: Object.freeze(['wishlist']),
	compare: Object.freeze(['compare']),
	catalog_admin: Object.freeze(['catalog']),
	orders_admin: Object.freeze(['checkout']),
	promotions_admin: Object.freeze(['coupons', 'deals', 'bundles', 'loyalty']),
	customers_admin: Object.freeze(['checkout', 'reviews', 'reports', 'csv']),
});

/**
 * The window event that adds a product to the shopper's cart (PLAN 0.8.4: how Add to cart works from a Chat card).
 * Chat's product card dispatches it, cancelable, with `detail: { productId, variantId?, quantity? }`; Ecommerce's
 * widget adds the item to its cart, opens the cart and calls `preventDefault()`. When no Ecommerce widget handled it,
 * Chat opens the product page instead.
 */
export const ADD_TO_CART_EVENT = 'ss-ecommerce:add-to-cart';

/** localStorage keys of the shopper's browser (the cart and compare list live in the browser, PLAN 0.8.4). */
export const STORAGE_KEYS = Object.freeze({ cart: 'ss-ecommerce-cart', compare: 'ss-ecommerce-compare' });
