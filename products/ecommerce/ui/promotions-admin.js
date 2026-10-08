/**
 * Promotions: coupons, deals, bundles, loyalty (admin widget `promotions_admin`, tickets) (owner: admin widgets; stub until built).
 * @module
 */

/**
 * @param {import('./widget.js').AdminMount} input
 * @returns {Promise<void>}
 */
export const mountPromotionsAdmin = async ({ host }) => {
	host.setAttribute('data-ss-mounted', 'promotions-admin');
};
