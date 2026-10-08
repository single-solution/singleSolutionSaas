/**
 * Customers, reviews moderation, reports and CSV (admin widget `customers_admin`, tickets) (owner: admin widgets; stub until built).
 * @module
 */

/**
 * @param {import('./widget.js').AdminMount} input
 * @returns {Promise<void>}
 */
export const mountCustomersAdmin = async ({ host }) => {
	host.setAttribute('data-ss-mounted', 'customers-admin');
};
