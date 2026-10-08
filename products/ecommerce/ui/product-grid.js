/**
 * The product grid with filters and search (visitor widget `product_grid`, feature catalog) (owner: widgets; stub until built).
 * @module
 */

/**
 * @param {import('./widget.js').VisitorMount} input
 * @returns {Promise<void>}
 */
export const mountProductGrid = async ({ host }) => {
	host.setAttribute('data-ss-mounted', 'product-grid');
};
