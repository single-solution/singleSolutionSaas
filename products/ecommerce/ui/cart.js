/**
 * The cart, checkout and success page (visitor widget `cart`, feature checkout) (owner: widgets; stub until built).
 * @module
 */

/**
 * @param {import('./widget.js').VisitorMount} input
 * @returns {Promise<void>}
 */
export const mountCart = async ({ host }) => {
	host.setAttribute('data-ss-mounted', 'cart');
};
