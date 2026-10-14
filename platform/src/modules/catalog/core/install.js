/**
 * The install snippet of a product with widgets (PLAN 0.4.10): one line per page, the same in the consoles' Install and
 * tokens and in a website's Setup sheet. Pure, with no imports, so both the browser and the server use this one copy.
 * @module
 */

/**
 * The widget script tag of a product, with the website's browser token filled in.
 * @param {string} widgetScriptUrl
 * @param {string} browserToken
 */
export const scriptTag = (widgetScriptUrl, browserToken) =>
	`<script src="${widgetScriptUrl}" data-token="${browserToken}" async></script>`;
