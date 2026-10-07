/**
 * DOM helpers of the default renderer: elements built with the injected `dom` (the Loader passes `document`), text
 * only (never parsed HTML), `on<event>` listeners, per-instance memory, focus kept across re-renders and a Tab trap
 * for modal dialogs. Browser features are reached through `dom.defaultView` and are optional.
 */

/** @typedef {any} DomNode */
/** @typedef {{ createElement: (tag: string) => DomNode, createTextNode: (text: string) => DomNode, defaultView?: any, activeElement?: any }} DomLike */

/**
 * @param {DomLike} dom
 * @param {string} tag
 * @param {Record<string, unknown>} [attrs] `null`/`undefined`/`false` skipped, `true` → empty, functions → listeners
 * @param {Array<any>} [children]
 */
export const el = (dom, tag, attrs = {}, children = []) => {
	const node = dom.createElement(tag);
	for (const [name, value] of Object.entries(attrs)) {
		if (value === null || value === undefined || value === false) continue;
		if (typeof value === 'function') node.addEventListener(name.slice(2), value);
		else node.setAttribute(name, value === true ? '' : String(value));
	}
	for (const child of children.flat(2))
		if (child !== null && child !== undefined && child !== false && child !== '')
			node.append(typeof child === 'string' ? dom.createTextNode(child) : child);
	return node;
};

/** @type {WeakMap<object, Record<string, any>>} */
const instances = new WeakMap();
let sequence = 0;

/**
 * Per-instance memory (keyed by the element's actions object, which lives as long as the element).
 * @param {object} actions
 */
export const memo = (actions) => {
	let entry = instances.get(actions);
	if (!entry) {
		sequence += 1;
		entry = { id: `ss-search-${sequence}` };
		instances.set(actions, entry);
	}
	return entry;
};

/**
 * Keep keyboard focus across re-renders: the control that had focus (marked `data-k`) is focused again in the new
 * tree, caret at the end.
 * @param {DomLike} dom
 * @param {object} actions
 * @param {DomNode} root
 */
export const refocus = (dom, actions, root) => {
	const local = memo(actions);
	const active = dom.activeElement;
	const key = (local.root?.contains?.(active) ? active.getAttribute?.('data-k') : null) ?? local.pending ?? null;
	local.root = root;
	if (!key) return;
	local.pending = key;
	queueMicrotask(() => {
		if (local.pending !== key) return;
		local.pending = null;
		const next = [...(local.root.querySelectorAll?.('[data-k]') ?? [])].find((node) => node.getAttribute('data-k') === key);
		next?.focus?.();
		if (typeof next?.setSelectionRange === 'function') next.setSelectionRange(next.value.length, next.value.length);
	});
};

/**
 * Keep Tab inside a modal container.
 * @param {any} event keydown
 * @param {DomNode} root
 */
export const trapTab = (event, root) => {
	if (event.key !== 'Tab' || typeof root?.querySelectorAll !== 'function') return;
	const nodes = [...root.querySelectorAll('a[href],button:not([disabled]),input:not([disabled])')];
	const active = root.ownerDocument?.activeElement;
	const head = nodes[0];
	const tail = nodes.at(-1);
	if (!head) return;
	if (event.shiftKey ? active === head : active === tail) {
		event.preventDefault();
		(event.shiftKey ? tail : head).focus();
	}
};

/**
 * The visitor's `localStorage` as a key-value storage (null when unavailable).
 * @param {any} win
 */
export const browserStorage = (win) => {
	try {
		const storage = win?.localStorage;
		return storage
			? {
					get: (/** @type {string} */ key) => storage.getItem(key),
					set: (/** @type {string} */ key, /** @type {string} */ value) => storage.setItem(key, value),
				}
			: null;
	} catch {
		return null;
	}
};
