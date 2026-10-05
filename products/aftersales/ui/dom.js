/**
 * Tiny DOM builder shared by the renderers: elements through the injected `dom` (the Loader passes `document`), text
 * nodes for strings, listeners by `on<event>` keys. No globals, no innerHTML.
 */

/** @typedef {{ createElement: (tag: string) => any, createTextNode: (text: string) => any }} DomLike */

/**
 * @param {DomLike} dom
 * @param {string} tag
 * @param {Record<string, string | ((event: any) => void) | null | undefined>} [attributes] `on<event>` keys add listeners
 * @param {Array<any>} [children]
 */
export const el = (dom, tag, attributes = {}, children = []) => {
	const node = dom.createElement(tag);
	for (const [name, value] of Object.entries(attributes)) {
		if (value === null || value === undefined) continue;
		if (typeof value === 'function') node.addEventListener(name.slice(2), value);
		else node.setAttribute(name, value);
	}
	for (const child of children)
		if (child !== null && child !== undefined && child !== false)
			node.append(typeof child === 'string' ? dom.createTextNode(child) : child);
	return node;
};

/** @param {string | null | undefined} value ISO instant → its date */
export const day = (value) => (typeof value === 'string' ? value.slice(0, 10) : '');
