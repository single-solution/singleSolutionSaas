/**
 * The product page blocks: gallery, variant picker, price, buy box, reviews (visitor widget `product_page`) (owner: widgets; stub until built).
 * @module
 */

/**
 * @param {import('./widget.js').VisitorMount} input
 * @returns {Promise<void>}
 */
export const mountProductPage = async ({ host }) => {
	host.setAttribute('data-ss-mounted', 'product-page');
};
