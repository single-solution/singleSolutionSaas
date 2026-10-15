/**
 * The browser events Growth's page script listens for (PLAN 0.8.9: how Growth learns about carts and orders). There
 * is no server path between products: the shopper widgets dispatch these on `window`, not cancelable, and Growth
 * records them and forwards them to the merchant's pixels. Ecommerce needs no Growth token for this.
 *
 * - `ss:view_item`: the product page shows a product (once per product; a variant change does not fire it again);
 * - `ss:add_to_cart`: a line is added to the browser cart (the product page's Add to cart, the wishlist's Add to cart,
 *   `SSEcommerce.addToCart(…)` and the `ss-ecommerce:add-to-cart` event of Chat's product cards);
 * - `ss:begin_checkout`: the shopper first presses Place order in the cart widget (once per cart widget);
 * - `ss:purchase`: `POST /v1/shop/orders` answered and the order exists (once per order placed);
 * - `ss:search`: the product grid's own search box ran a search (`{ term, results }`: the words and how many products it
 *   found); a search in the page's address is Growth's to find, so the grid sends none for it.
 *
 * Money is integer minor units with an ISO 4217 currency, as everywhere in Ecommerce. `value` is the sum of price ×
 * quantity of the items, except on `ss:purchase`, where it is the order's total. An item sold by length, weight or
 * volume is one item (`core/measure.js` `piecesOf`) priced at what its line comes to.
 * @module
 */
import { grossFits, lineGross } from './measure.js';

/** The event names. */
export const GROWTH_EVENTS = Object.freeze({
	viewItem: 'ss:view_item',
	addToCart: 'ss:add_to_cart',
	beginCheckout: 'ss:begin_checkout',
	purchase: 'ss:purchase',
	search: 'ss:search',
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
 * An event item from a cart, quote or order line, or from a product with its variant. A measured line (`measure`
 * given, its quantity in thousandths of its unit) is one item at what it comes to (`gross` when the line has it).
 * @param {{ productId: string, variantId?: unknown, name?: unknown, price?: unknown, unitPrice?: unknown,
 *   quantity?: unknown, measure?: unknown, gross?: unknown }} line `unitPrice` (a priced line) or `price` (a product's
 *   variant)
 * @returns {GrowthItem}
 */
export const growthItem = (line) => {
	const price = amountOf(line.unitPrice ?? line.price);
	const quantity = Number.isSafeInteger(line.quantity) && Number(line.quantity) > 0 ? Number(line.quantity) : 1;
	const measured = Boolean(line.measure);
	return {
		id: line.productId,
		variantId: typeof line.variantId === 'string' ? line.variantId : null,
		name: typeof line.name === 'string' ? line.name : '',
		price: !measured
			? price
			: Number.isSafeInteger(line.gross)
				? amountOf(line.gross)
				: grossFits(price, quantity, true)
					? lineGross(price, quantity, true)
					: 0,
		quantity: measured ? 1 : quantity,
	};
};

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
