/**
 * The wishlist (visitor widget `wishlist`) (owner: widgets; stub until built).
 * @module
 */

/**
 * @param {import('./widget.js').VisitorMount} input
 * @returns {Promise<void>}
 */
export const mountWishlist = async ({ host }) => {
	host.setAttribute('data-ss-mounted', 'wishlist');
};
