/**
 * DOM helpers of the renderers: elements through the injected `dom` (the Loader passes `document`) and the tier colour
 * as a CSS custom property set through the CSSOM (CSP-safe).
 */

/** @typedef {{ createElement: (tag: string) => any, createTextNode: (text: string) => any }} DomLike */

/**
 * @param {DomLike} dom
 * @param {string} tag
 * @param {Record<string, string>} [attributes]
 * @param {Array<any>} [children] strings become text nodes; null / undefined / false are skipped
 */
export const el = (dom, tag, attributes = {}, children = []) => {
	const node = dom.createElement(tag);
	for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
	for (const child of children)
		if (child !== null && child !== undefined && child !== false)
			node.append(typeof child === 'string' ? dom.createTextNode(child) : child);
	return node;
};

/**
 * Paint a node with a tier colour (a `var(--…)` or hex value validated by the headless core).
 * @param {any} node
 * @param {string | null} color
 */
export const paint = (node, color) => {
	if (color && typeof node.style?.setProperty === 'function') node.style.setProperty('--ss-grades-tier', color);
	return node;
};

/**
 * The polite status line (errors are announced).
 * @param {DomLike} dom
 * @param {string | null} error
 */
export const statusLine = (dom, error) =>
	el(dom, 'p', { class: 'ss-grades-error', role: 'status', 'aria-live': 'polite' }, error ? [error] : []);
