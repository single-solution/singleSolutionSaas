/**
 * Compare products side by side (visitor widget `compare`) (owner: widgets; stub until built).
 * @module
 */

/**
 * @param {import('./widget.js').VisitorMount} input
 * @returns {Promise<void>}
 */
export const mountCompare = async ({ host }) => {
	host.setAttribute('data-ss-mounted', 'compare');
};
