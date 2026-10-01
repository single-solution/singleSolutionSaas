/**
 * DOM helpers shared by the default renderers: build elements with the injected `dom` (the Loader passes `document`),
 * text only (never HTML), attributes set one by one, listeners attached explicitly.
 */

/** @typedef {{ createElement: (tag: string) => any, createTextNode: (text: string) => any }} DomLike */

/**
 * @param {DomLike} dom
 * @param {string} tag
 * @param {Record<string, string | null | undefined>} [attributes] null / undefined values are skipped
 * @param {Array<any>} [children] strings become text nodes; null / undefined are skipped
 */
export const el = (dom, tag, attributes = {}, children = []) => {
	const node = dom.createElement(tag);
	for (const [name, value] of Object.entries(attributes))
		if (value !== null && value !== undefined) node.setAttribute(name, value);
	for (const child of children)
		if (child !== null && child !== undefined && child !== false)
			node.append(typeof child === 'string' ? dom.createTextNode(child) : child);
	return node;
};

/**
 * Attach a listener and return the node.
 * @param {any} node
 * @param {string} type
 * @param {(event: any) => void} listener
 */
export const on = (node, type, listener) => {
	node.addEventListener(type, listener);
	return node;
};

/**
 * A status line announced politely (errors and changes).
 * @param {DomLike} dom
 * @param {string} prefix CSS class prefix
 * @param {string | null} message
 */
export const statusLine = (dom, prefix, message) =>
	el(dom, 'p', { class: `${prefix}__status`, role: 'status', 'aria-live': 'polite' }, message ? [message] : []);
