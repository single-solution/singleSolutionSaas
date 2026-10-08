/**
 * Products and catalog (admin widget `catalog_admin`, tickets) (owner: admin widgets; stub until built).
 * @module
 */

/**
 * @param {import('./widget.js').AdminMount} input
 * @returns {Promise<void>}
 */
export const mountCatalogAdmin = async ({ host }) => {
	host.setAttribute('data-ss-mounted', 'catalog-admin');
};
