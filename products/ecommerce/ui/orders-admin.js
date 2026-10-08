/**
 * Orders and returns (admin widget `orders_admin`, tickets) (owner: admin widgets; stub until built).
 * @module
 */

/**
 * @param {import('./widget.js').AdminMount} input
 * @returns {Promise<void>}
 */
export const mountOrdersAdmin = async ({ host }) => {
	host.setAttribute('data-ss-mounted', 'orders-admin');
};
