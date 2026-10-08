/**
 * My orders: orders, tracking, invoices and returns (visitor widget `my_orders`, feature checkout) (owner: widgets; stub until built).
 * @module
 */

/**
 * @param {import('./widget.js').VisitorMount} input
 * @returns {Promise<void>}
 */
export const mountMyOrders = async ({ host }) => {
	host.setAttribute('data-ss-mounted', 'my-orders');
};
