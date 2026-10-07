/**
 * A tiny element builder for the widgets: text is always set as text, never as HTML.
 * @module
 */

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {Record<string, string>} [attributes]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
export const element = (doc, tag, attributes = {}, text = '') => {
	const node = doc.createElement(tag);
	for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
	node.textContent = text;
	return node;
};
