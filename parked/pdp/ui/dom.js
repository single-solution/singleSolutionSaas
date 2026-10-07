/** DOM helpers of the renderers over the injected `dom` (the page's document); a missing feature never throws. */

/** @typedef {{ createElement: (tag: string) => any, createTextNode: (text: string) => any, defaultView?: any, documentElement?: any }} DomLike */

/**
 * Element with attributes (`null`/`undefined`/`false` skipped, `true` → '') and text or node children.
 * @param {DomLike} dom
 * @param {string} tag
 * @param {Record<string, string | number | boolean | null | undefined>} [attributes]
 * @param {any[]} [children]
 * @returns {any}
 */
export const el = (dom, tag, attributes = {}, children = []) => {
	const node = dom.createElement(tag);
	for (const [name, value] of Object.entries(attributes))
		if (value !== null && value !== undefined && value !== false) node.setAttribute(name, value === true ? '' : String(value));
	for (const child of children)
		if (child !== null && child !== undefined && child !== '')
			node.append(typeof child === 'object' ? child : dom.createTextNode(String(child)));
	return node;
};

/** @param {any} node @param {string} type @param {(event: any) => void} fn */
export const listen = (node, type, fn) => node?.addEventListener?.(type, fn);

/** @param {DomLike} dom @returns {any} */
export const winOf = (dom) => dom?.defaultView ?? null;

/** @param {any} root @param {string} selector @returns {any} */
export const query = (root, selector) => {
	try {
		return root?.querySelector?.(selector) ?? null;
	} catch {
		return null;
	}
};

/** @param {any} root @param {string} selector @returns {any[]} */
export const queryAll = (root, selector) => {
	try {
		return [...(root?.querySelectorAll?.(selector) ?? [])];
	} catch {
		return [];
	}
};

/** @type {WeakMap<object, Set<string>>} */
const started = new WeakMap();

/**
 * Run `task` once per instance (its stable `actions`) and name, after the current render.
 * @param {object} actions
 * @param {() => unknown} task
 * @param {string} [name]
 */
export const once = (actions, task, name = 'load') => {
	const done = started.get(actions) ?? new Set();
	if (done.has(name)) return;
	started.set(actions, done.add(name));
	void Promise.resolve().then(task);
};

/** The Loader's public API (`window.SS`). @param {DomLike} dom @returns {any} */
export const loaderApi = (dom) => winOf(dom)?.SS ?? null;

/**
 * `update(node, props)` that renders anew and moves focus to the new `data-ss-autofocus` control, else to the
 * control with the focused one's `data-ss-focus` key.
 * @param {(props: any) => any} render
 * @returns {(node: any, props: any) => any}
 */
export const refocusing = (render) => (node, props) => {
	const next = render(props);
	const active = node?.ownerDocument?.activeElement;
	const key = node?.contains?.(active) ? active.getAttribute('data-ss-focus') : null;
	const target = query(next, '[data-ss-autofocus]') ?? (key ? query(next, `[data-ss-focus="${key}"]`) : null);
	if (target) void Promise.resolve().then(() => target.focus?.());
	return next;
};

/** Token-only base styles. */
export const BASE_STYLES = `.ss-pdp{color:var(--ss-color-text);font:var(--ss-font-body)}.ss-pdp[hidden],.ss-pdp [hidden]{display:none!important}
.ss-pdp button{font:inherit;cursor:pointer}.ss-pdp :focus-visible{outline:2px solid var(--ss-color-focus);outline-offset:2px}
.ss-pdp__sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:reduce){.ss-pdp *{transition:none!important;animation:none!important}}`;
