/**
 * The browser events Growth's page script listens for (PLAN 0.8.9: how Growth learns about carts and orders). There
 * is no server path between products: the shopper widgets dispatch these on `window`, not cancelable, and Growth
 * records them and forwards them to the merchant's pixels. Ecommerce needs no Growth token for this.
 *
 * - `ss:view_item`: the product page shows a product (once per product; a variant change does not fire it again);
 * - `ss:add_to_cart`: a line is added to the browser cart (the product page's Add to cart, the wishlist's Add to cart,
 *   `SSEcommerce.addToCart(…)` and the `ss-ecommerce:add-to-cart` event of Chat's product cards);
 * - `ss:begin_checkout`: the shopper first presses Place order in the cart widget (once per cart widget);
 * - `ss:purchase`: `POST /v1/shop/orders` answered and the order exists (once per order placed).
 *
 * Money is integer minor units with an ISO 4217 currency, as everywhere in Ecommerce. `value` is the sum of price ×
 * quantity of the items, except on `ss:purchase`, where it is the order's total.
 * @module
 */

/** The event names. */
export const GROWTH_EVENTS = Object.freeze({
	viewItem: 'ss:view_item',
	addToCart: 'ss:add_to_cart',
	beginCheckout: 'ss:begin_checkout',
	purchase: 'ss:purchase',
});

/**
 * One item of an event.
 * @typedef {{ id: string, variantId: string | null, name: string, price: number, quantity: number }} GrowthItem
 */

/**
 * @typedef {{ currency: string, value: number, items: GrowthItem[] }} ItemsDetail
 * @typedef {ItemsDetail & { orderId: string, orderNumber: string }} PurchaseDetail
 */

/** @param {unknown} value @returns {number} a whole amount of minor units, 0 when unknown */
const amountOf = (value) => (Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0);

/**
 * An event item from a cart, quote or order line, or from a product with its variant.
 * @param {{ productId: string, variantId?: unknown, name?: unknown, price?: unknown, unitPrice?: unknown,
 *   quantity?: unknown }} line `unitPrice` (a priced line) or `price` (a product's variant)
 * @returns {GrowthItem}
 */
export const growthItem = (line) => ({
	id: line.productId,
	variantId: typeof line.variantId === 'string' ? line.variantId : null,
	name: typeof line.name === 'string' ? line.name : '',
	price: amountOf(line.unitPrice ?? line.price),
	quantity: Number.isSafeInteger(line.quantity) && Number(line.quantity) > 0 ? Number(line.quantity) : 1,
});

/**
 * The detail of `ss:view_item`, `ss:add_to_cart` and `ss:begin_checkout`.
 * @param {string} currency
 * @param {GrowthItem[]} items
 * @returns {ItemsDetail}
 */
export const itemsDetail = (currency, items) => ({
	currency,
	value: items.reduce((sum, item) => sum + item.price * item.quantity, 0),
	items,
});

/**
 * The detail of `ss:purchase` from the placed order (the shopper's view of it).
 * @param {{ id: string, number: string, totals: { total: number, currency: string },
 *   lines: Array<{ productId: string, variantId: string | null, name: string, unitPrice: number, quantity: number }> }} order
 * @returns {PurchaseDetail}
 */
export const purchaseDetail = (order) => ({
	orderId: order.id,
	orderNumber: order.number,
	currency: order.totals.currency,
	value: amountOf(order.totals.total),
	items: order.lines.map(growthItem),
});
