/**
 * Renderer helpers (Mode A). Every renderer is a function of its props that builds DOM with the injected `dom` (the
 * Loader passes the page's `document`): text is always a text node, never parsed HTML; URLs were checked by the core.
 * Browser features (history, observers, timers) are reached through `dom.defaultView` and are optional, so a
 * renderer also works on a minimal document (server-side or test DOM) and simply skips the enhancement.
 */

/** @typedef {any} DomNode */
/**
 * @typedef {object} DomLike
 * @property {(tag: string) => DomNode} createElement
 * @property {(text: string) => DomNode} createTextNode
 * @property {any} [defaultView]
 * @property {any} [documentElement]
 * @property {(id: string) => DomNode | null} [getElementById]
 */
/** @typedef {DomNode | string | null | undefined | false | ReadonlyArray<any>} Child */

/**
 * Create an element: attributes (`null`/`false` skipped, `true` → empty), `on<event>` listeners, children.
 * @param {DomLike} dom
 * @param {string} tag
 * @param {Record<string, unknown>} [attrs]
 * @param {Child[]} [children]
 * @returns {DomNode}
 */
export const el = (dom, tag, attrs = {}, children = []) => {
	const node = dom.createElement(tag);
	for (const [name, value] of Object.entries(attrs)) {
		if (value === null || value === undefined || value === false) continue;
		if (typeof value === 'function') node.addEventListener(name.slice(2), value);
		else node.setAttribute(name, value === true ? '' : String(value));
	}
	for (const child of children.flat(3))
		if (child !== null && child !== undefined && child !== false && child !== '')
			node.append(typeof child === 'string' ? dom.createTextNode(child) : child);
	return node;
};

/**
 * The window behind a document (null on a minimal DOM).
 * @param {DomLike} dom
 * @returns {any}
 */
export const windowOf = (dom) => dom.defaultView ?? null;

/** @type {WeakMap<object, Record<string, any>>} per element instance (its actions object) */
const instances = new WeakMap();

/**
 * Per-instance memory of a renderer (keyed by the instance's actions, which live as long as the element).
 * @param {object} actions
 * @returns {Record<string, any>}
 */
export const memo = (actions) => {
	let entry = instances.get(actions);
	if (!entry) {
		entry = {};
		instances.set(actions, entry);
	}
	return entry;
};

/**
 * Data a website embedded in the page: `<script type="application/json" id="…">`.
 * @param {DomLike} dom
 * @param {string} id
 * @returns {unknown} undefined when absent or not JSON
 */
export const pageData = (dom, id) => {
	const node = typeof dom.getElementById === 'function' ? dom.getElementById(id) : null;
	if (!node || typeof node.textContent !== 'string') return undefined;
	try {
		return JSON.parse(node.textContent);
	} catch {
		return undefined;
	}
};

/** Event elements dispatch after changing the listing query in the URL. */
export const QUERY_EVENT = 'ss:query';

/**
 * Put a listing query string into the URL (push, or replace for infinite scroll) and tell the other listing
 * elements (they re-read `location.search`).
 * @param {any} win
 * @param {string} search `?…` or ''
 * @param {{ replace?: boolean }} [options]
 */
export const navigate = (win, search, { replace = false } = {}) => {
	if (!win?.history || !win.location) return;
	const url = `${win.location.pathname}${search}${win.location.hash ?? ''}`;
	if (replace) win.history.replaceState(win.history.state, '', url);
	else win.history.pushState(win.history.state, '', url);
	win.dispatchEvent(new win.Event(QUERY_EVENT));
};

/**
 * Run `fn` once per element instance and follow URL changes (back/forward and other elements).
 * @param {DomLike} dom
 * @param {object} actions
 * @param {(search: string) => void} first called once with the current query string
 * @param {((search: string) => void) | null} [follow] called on every URL change
 */
export const boot = (dom, actions, first, follow = null) => {
	const entry = memo(actions);
	if (entry.booted) return;
	entry.booted = true;
	const win = windowOf(dom);
	const search = () => String(win?.location?.search ?? '');
	queueMicrotask(() => first(search()));
	if (follow && win?.addEventListener) {
		const handler = () => follow(search());
		win.addEventListener('popstate', handler);
		win.addEventListener(QUERY_EVENT, handler);
	}
};

/**
 * Set CSS custom properties through the CSSOM (allowed under a strict CSP, unlike style attributes).
 * @param {DomNode} node
 * @param {Record<string, string | number>} vars
 */
export const setVars = (node, vars) => {
	for (const [name, value] of Object.entries(vars)) node.style?.setProperty?.(name, String(value));
};

/**
 * True when the visitor asked for reduced motion (the Loader's flag, else the media query).
 * @param {any} win
 * @param {boolean | undefined} flag
 */
export const reduced = (win, flag) => flag === true || win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;

/**
 * A plain left click without modifier keys (others keep the browser's own behaviour: new tab, …).
 * @param {any} event
 */
export const plainClick = (event) =>
	event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented;

/**
 * Keep keyboard focus across re-renders: the Loader replaces an element's node when its state changes, so the
 * control that had focus (marked `data-k`) is focused again in the new tree, caret at the end.
 * @param {DomLike} dom
 * @param {object} actions the element instance
 * @param {DomNode} root the new tree
 */
export const refocus = (dom, actions, root) => {
	const local = memo(actions);
	const active = /** @type {any} */ (dom).activeElement;
	// several renders can follow one another before the microtask runs: the pending key carries over
	const key = (local.root?.contains?.(active) ? active.getAttribute?.('data-k') : null) ?? local.pending ?? null;
	local.root = root;
	if (!key) return;
	local.pending = key;
	queueMicrotask(() => {
		if (local.pending !== key) return;
		local.pending = null;
		const next = [...(local.root.querySelectorAll?.('[data-k]') ?? [])].find((node) => node.getAttribute('data-k') === key);
		next?.focus?.();
		if (typeof next?.setSelectionRange === 'function' && next.type === 'search')
			next.setSelectionRange(next.value.length, next.value.length);
	});
};

/**
 * Keep Tab focus inside a modal container (wraps from the last control to the first and back).
 * @param {any} event a keydown event
 * @param {DomNode} root
 */
export const trapTab = (event, root) => {
	if (event.key !== 'Tab' || typeof root.querySelectorAll !== 'function') return;
	const nodes = [...root.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select,summary')];
	const active = root.ownerDocument?.activeElement;
	const [head, tail] = [nodes[0], nodes.at(-1)];
	if (!head) return;
	if (event.shiftKey ? active === head : active === tail) {
		event.preventDefault();
		(event.shiftKey ? tail : head).focus();
	}
};

/**
 * An inline SVG icon from a path.
 * @param {DomLike} dom
 * @param {string} d
 */
export const icon = (dom, d) => {
	const ns = 'http://www.w3.org/2000/svg';
	const make = (/** @type {string} */ tag) =>
		typeof (/** @type {any} */ (dom).createElementNS) === 'function'
			? /** @type {any} */ (dom).createElementNS(ns, tag)
			: dom.createElement(tag);
	const svg = make('svg');
	for (const [name, value] of Object.entries({
		viewBox: '0 0 24 24',
		width: '24',
		height: '24',
		'aria-hidden': 'true',
		focusable: 'false',
		fill: 'none',
		stroke: 'currentColor',
		'stroke-width': '2',
		'stroke-linecap': 'round',
		'stroke-linejoin': 'round',
	}))
		svg.setAttribute(name, value);
	const path = make('path');
	path.setAttribute('d', d);
	svg.append(path);
	return svg;
};
