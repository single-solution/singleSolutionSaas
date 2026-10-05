/**
 * Helpers for default renderers (Mode A, PLAN Part E §4 and §8): a safe DOM builder, design tokens as CSS variables,
 * slot resolution, layout-shift reservation, reduced motion, focus management and accessibility utilities.
 * Nothing here ever parses HTML: text becomes text nodes and only allowlisted attributes are written.
 * @module
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** HTML tags a renderer may create (no script, style, iframe, object, embed, form, link, meta, base, template). */
export const HTML_TAGS = Object.freeze(
	new Set(
		'a abbr article aside b blockquote br button caption code dd del details dialog div dl dt em fieldset figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img input ins kbd label legend li main mark menu meter nav ol optgroup option output p picture pre progress q s section select small source span strong sub summary sup table tbody td textarea tfoot th thead time tr u ul'.split(
			' ',
		),
	),
);

/** SVG tags for icons. */
export const SVG_TAGS = Object.freeze(new Set('svg g path circle ellipse line polyline polygon rect title'.split(' ')));

/** Attributes a renderer may set (plus `aria-*` and `data-*`). */
export const ATTRIBUTES = Object.freeze(
	new Set(
		'id class role title alt href src type name value placeholder for tabindex lang dir width height loading decoding rel target autocomplete inputmode min max step minlength maxlength pattern rows cols colspan rowspan scope datetime size accept enterkeyhint spellcheck draggable open disabled checked selected hidden required readonly multiple novalidate autofocus'.split(
			' ',
		),
	),
);

const SVG_ATTRIBUTES = new Set(
	'viewBox d fill stroke stroke-width stroke-linecap stroke-linejoin fill-rule clip-rule cx cy r rx ry x y x1 y1 x2 y2 points transform xmlns focusable opacity'.split(
		' ',
	),
);
const BOOLEAN_ATTRIBUTES = new Set(
	'open disabled checked selected hidden required readonly multiple novalidate autofocus'.split(' '),
);
const URL_ATTRIBUTES = new Set(['href', 'src']);
const PROPERTY_ATTRIBUTES = new Set(['value', 'checked', 'selected']);
const UNSAFE_CSS = /[;{}<>\\]|url\s*\(|expression\s*\(|javascript:|@import|image-set\s*\(|image\s*\(/i;

/**
 * Validate a CSS value coming from configuration (no declarations, blocks, resource loads or escapes).
 * @param {unknown} value
 * @returns {string | undefined}
 */
export const safeCssValue = (value) => {
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	if (typeof value !== 'string' || value.length > 200 || UNSAFE_CSS.test(value)) return undefined;
	return value.trim() === '' ? undefined : value;
};

/**
 * Only http(s), mailto, tel and same-document relative URLs (`src`: http(s) and relative only).
 * @param {string} name
 * @param {unknown} value
 * @returns {string | undefined}
 */
export const safeUrl = (name, value) => {
	if (typeof value !== 'string' || value.length > 2048) return undefined;
	const trimmed = value.trim();
	// Browsers strip control characters and whitespace from schemes; refuse them instead of guessing.
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f\s\\]/.test(trimmed)) return undefined;
	const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)?.[1]?.toLowerCase();
	if (scheme === undefined) return trimmed.startsWith('//') ? undefined : trimmed;
	const allowed = name === 'src' ? ['http', 'https'] : ['http', 'https', 'mailto', 'tel'];
	return allowed.includes(scheme) ? trimmed : undefined;
};

/** @param {string} name */
const kebab = (name) => name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);

/**
 * @typedef {Node | string | number | boolean | null | undefined | ReadonlyArray<any>} Child a node, text, nothing, or a (nested) array of those
 */

/**
 * @param {Document} doc
 * @param {Node} parent
 * @param {Child} child
 */
const appendChild = (doc, parent, child) => {
	if (child === null || child === undefined || typeof child === 'boolean') return;
	if (Array.isArray(child)) {
		for (const item of child) appendChild(doc, parent, item);
		return;
	}
	if (typeof child === 'string' || typeof child === 'number') {
		parent.appendChild(doc.createTextNode(String(child)));
		return;
	}
	if (typeof child === 'object' && typeof (/** @type {Node} */ (child).nodeType) === 'number')
		parent.appendChild(/** @type {Node} */ (child));
	// anything else (plain objects, functions) is ignored rather than stringified
};

/**
 * @param {HTMLElement | SVGElement} el
 * @param {Record<string, unknown>} style
 */
const applyStyle = (el, style) => {
	for (const [name, raw] of Object.entries(style)) {
		const property = name.startsWith('--') ? name : kebab(name);
		if (!/^(--)?[a-z][a-z0-9-]*$/.test(property)) continue;
		const value = safeCssValue(raw);
		if (value !== undefined) el.style.setProperty(property, value);
	}
};

/**
 * Create a DOM builder bound to a document.
 * @param {Document} [doc]
 */
export const createH = (doc) => {
	/**
	 * Minimal hyperscript: `h('button', { type: 'button', onClick }, strings.label)`.
	 * Unknown tags throw (a renderer bug); unknown or unsafe attributes are dropped.
	 * @param {string} tag
	 * @param {Record<string, unknown> | null} [props]
	 * @param {...Child} children
	 * @returns {HTMLElement}
	 */
	const h = (tag, props, ...children) => {
		const document = doc ?? globalThis.document;
		const svg = SVG_TAGS.has(tag);
		if (!svg && !HTML_TAGS.has(tag)) throw new TypeError(`h: tag <${tag}> is not allowed`);
		const el = /** @type {HTMLElement} */ (svg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag));
		for (const [rawName, value] of Object.entries(props ?? {})) {
			if (value === undefined || value === null || value === false) continue;
			const name = rawName === 'className' ? 'class' : rawName === 'htmlFor' ? 'for' : rawName;
			if (/^on[A-Z]/.test(name)) {
				if (typeof value === 'function')
					el.addEventListener(name.slice(2).toLowerCase(), /** @type {EventListener} */ (value));
				continue;
			}
			if (name === 'ref') {
				if (typeof value === 'function') value(el);
				continue;
			}
			if (name === 'style') {
				if (typeof value === 'object') applyStyle(el, /** @type {Record<string, unknown>} */ (value));
				continue;
			}
			const lower = name.toLowerCase();
			const known =
				ATTRIBUTES.has(lower) ||
				(svg && SVG_ATTRIBUTES.has(name)) ||
				/^aria-[a-z]+$/.test(lower) ||
				/^data-[a-z0-9-]+$/.test(lower);
			if (!known || lower.startsWith('on')) continue;
			if (BOOLEAN_ATTRIBUTES.has(lower)) {
				if (value === true || value === '') {
					el.setAttribute(lower, '');
					if (PROPERTY_ATTRIBUTES.has(lower)) /** @type {any} */ (el)[lower] = true;
				}
				continue;
			}
			if (typeof value !== 'string' && typeof value !== 'number' && value !== true) continue;
			const text = String(value);
			if (URL_ATTRIBUTES.has(lower)) {
				const url = safeUrl(lower, text);
				if (url !== undefined) el.setAttribute(lower, url);
				continue;
			}
			el.setAttribute(svg ? name : lower, text);
			if (lower === 'value') /** @type {any} */ (el).value = text;
		}
		if (el.getAttribute('target') === '_blank') el.setAttribute('rel', 'noopener noreferrer');
		appendChild(document, el, children);
		return el;
	};
	return h;
};

/** The DOM builder bound to the current document. */
export const h = createH();

/**
 * Design tokens → CSS custom properties (`{ color: { primary: '#123' } }` → `--ss-color-primary: #123`).
 */
export const tokens = Object.freeze({
	/**
	 * @param {unknown} theme nested token object
	 * @param {{ prefix?: string }} [options]
	 * @returns {Record<string, string>}
	 */
	toVars: (theme, { prefix = '--ss' } = {}) => {
		/** @type {Record<string, string>} */
		const out = {};
		/**
		 * @param {unknown} node
		 * @param {string} path
		 * @param {number} depth
		 */
		const walk = (node, path, depth) => {
			if (depth > 6 || node === null || typeof node !== 'object' || Array.isArray(node)) return;
			for (const [name, value] of Object.entries(node)) {
				const segment = kebab(name).replace(/[^a-z0-9-]/g, '');
				if (segment === '') continue;
				const next = `${path}-${segment}`;
				if (typeof value === 'object') walk(value, next, depth + 1);
				else {
					const css = safeCssValue(value);
					if (css !== undefined) out[next] = css;
				}
			}
		};
		walk(theme, prefix, 0);
		return out;
	},
	/**
	 * Apply tokens to an element; returns the variable names that were set.
	 * @param {HTMLElement} el
	 * @param {unknown} theme
	 * @param {{ prefix?: string }} [options]
	 * @returns {string[]}
	 */
	apply: (el, theme, options) => {
		const vars = tokens.toVars(theme, options);
		for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, value);
		return Object.keys(vars);
	},
});

/**
 * @typedef {Node | string | { template: string } | ((context: unknown) => Node | string | null | undefined)} SlotValue
 */

/**
 * Resolve a slot: merchant content (a Node — cloned, a string — text, `{ template: '#id' }` — a clone of that
 * `<template>`'s content from the merchant's own page, or a function) falling back to the renderer's default.
 * @param {string} name
 * @param {Record<string, SlotValue | undefined> | undefined} slots
 * @param {SlotValue | undefined} [fallback]
 * @param {{ document?: Document, context?: unknown }} [options]
 * @returns {Node | null}
 */
export const slot = (name, slots, fallback, options = {}) => {
	const doc = options.document ?? globalThis.document;
	/** @param {SlotValue | undefined} value @returns {Node | null} */
	const toNode = (value) => {
		if (value === undefined || value === null) return null;
		if (typeof value === 'string') return doc.createTextNode(value);
		if (typeof value === 'function') {
			try {
				const produced = value(options.context);
				return typeof produced === 'function' ? null : toNode(produced ?? undefined);
			} catch {
				return null;
			}
		}
		if (typeof (/** @type {Node} */ (value).nodeType) === 'number') return /** @type {Node} */ (value).cloneNode(true);
		if (typeof (/** @type {{ template: unknown }} */ (value).template) === 'string') {
			try {
				const template = doc.querySelector(/** @type {{ template: string }} */ (value).template);
				return template && template.tagName === 'TEMPLATE'
					? /** @type {HTMLTemplateElement} */ (template).content.cloneNode(true)
					: null;
			} catch {
				return null;
			}
		}
		return null;
	};
	const provided = slots && Object.hasOwn(slots, name) ? toNode(slots[name]) : null;
	return provided ?? toNode(fallback);
};

/**
 * Reserve layout space before an element's code loads (no CLS on mount). Returns `release()`.
 * @param {HTMLElement} el
 * @param {{ minHeight?: number | string, minWidth?: number | string, aspectRatio?: number | string }} [space]
 * @returns {() => void}
 */
export const reserveSpace = (el, space = {}) => {
	/** @type {string[]} */
	const set = [];
	/** @param {unknown} value */
	const length = (value) =>
		typeof value === 'number' ? (value >= 0 && Number.isFinite(value) ? `${value}px` : undefined) : safeCssValue(value);
	for (const [property, value] of /** @type {const} */ ([
		['min-height', length(space.minHeight)],
		['min-width', length(space.minWidth)],
		['aspect-ratio', safeCssValue(space.aspectRatio)],
	])) {
		if (value === undefined) continue;
		el.style.setProperty(property, value);
		set.push(property);
	}
	return () => {
		for (const property of set) el.style.removeProperty(property);
	};
};

/**
 * @param {{ matchMedia?: (query: string) => { matches: boolean } }} [win]
 * @returns {boolean}
 */
export const prefersReducedMotion = (win = globalThis.window) => {
	try {
		return win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
	} catch {
		return false;
	}
};

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex], [contenteditable="true"]';

/**
 * Keyboard-focusable descendants in DOM order.
 * @param {ParentNode} root
 * @returns {HTMLElement[]}
 */
export const focusables = (root) =>
	/** @type {HTMLElement[]} */ ([...root.querySelectorAll(FOCUSABLE)]).filter(
		(el) =>
			el.tabIndex >= 0 && !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true' && !el.closest('[inert]'),
	);

/**
 * Focus the first focusable descendant (or the root itself when it is focusable).
 * @param {HTMLElement} root
 * @returns {boolean}
 */
export const focusFirst = (root) => {
	const target = focusables(root)[0] ?? (root.hasAttribute('tabindex') ? root : undefined);
	target?.focus();
	return target !== undefined;
};

/**
 * Remember the focused element; the returned function restores focus to it (if still in the document).
 * @param {Document} [doc]
 * @returns {() => void}
 */
export const saveFocus = (doc = globalThis.document) => {
	const previous = /** @type {HTMLElement | null} */ (doc?.activeElement ?? null);
	return () => {
		if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus();
	};
};

/**
 * Keep Tab/Shift+Tab inside `root` (dialogs); Escape calls `onEscape`. Returns `release()` which also restores focus.
 * @param {HTMLElement} root
 * @param {{ onEscape?: () => void, initialFocus?: boolean }} [options]
 * @returns {() => void}
 */
export const trapFocus = (root, { onEscape, initialFocus = true } = {}) => {
	const restore = saveFocus(root.ownerDocument);
	/** @param {KeyboardEvent} event */
	const onKey = (event) => {
		if (event.key === 'Escape') {
			onEscape?.();
			return;
		}
		if (event.key !== 'Tab') return;
		const items = focusables(root);
		if (items.length === 0) {
			event.preventDefault();
			return;
		}
		const first = /** @type {HTMLElement} */ (items[0]);
		const last = /** @type {HTMLElement} */ (items.at(-1));
		const active = root.ownerDocument.activeElement;
		if (event.shiftKey && (active === first || !root.contains(active))) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && (active === last || !root.contains(active))) {
			event.preventDefault();
			first.focus();
		}
	};
	root.addEventListener('keydown', onKey);
	if (initialFocus) focusFirst(root);
	return () => {
		root.removeEventListener('keydown', onKey);
		restore();
	};
};

/** Visually hidden but announced by screen readers. */
export const VISUALLY_HIDDEN = Object.freeze({
	position: 'absolute',
	width: '1px',
	height: '1px',
	padding: '0',
	margin: '-1px',
	overflow: 'hidden',
	clip: 'rect(0 0 0 0)',
	whiteSpace: 'nowrap',
	border: '0',
});

let idCounter = 0;
/**
 * A document-unique id for label/description wiring.
 * @param {string} [prefix]
 * @returns {string}
 */
export const uniqueId = (prefix = 'ss') => `${prefix}-${(idCounter += 1).toString(36)}`;

/**
 * An accessible button: always has an accessible name. Icon-only buttons get `aria-label`.
 * @param {{ label: string, onClick?: (event: MouseEvent) => void, icon?: Node, showLabel?: boolean, document?: Document } & Record<string, unknown>} props
 * @returns {HTMLButtonElement}
 */
export const button = ({ label, onClick, icon, showLabel = icon === undefined, document: doc, ...rest }) => {
	if (typeof label !== 'string' || label.trim() === '') throw new TypeError('button: label is required');
	const build = createH(doc);
	return /** @type {HTMLButtonElement} */ (
		build(
			'button',
			{ type: 'button', ...rest, onClick, 'aria-label': showLabel ? undefined : label },
			icon,
			showLabel ? label : null,
		)
	);
};

/**
 * A polite (or assertive) live region; `announce(text)` re-announces even identical messages.
 * @param {HTMLElement} parent
 * @param {{ politeness?: 'polite' | 'assertive', setTimer?: (fn: () => void, ms: number) => unknown }} [options]
 */
export const liveRegion = (parent, { politeness = 'polite', setTimer = (fn, ms) => globalThis.setTimeout(fn, ms) } = {}) => {
	const node = createH(parent.ownerDocument)('div', {
		role: politeness === 'assertive' ? 'alert' : 'status',
		'aria-live': politeness,
		'aria-atomic': 'true',
		style: VISUALLY_HIDDEN,
	});
	parent.appendChild(node);
	return Object.freeze({
		node,
		/** @param {string} text */
		announce: (text) => {
			node.textContent = '';
			setTimer(() => {
				node.textContent = String(text);
			}, 50);
		},
		destroy: () => node.remove(),
	});
};
