/** Test doubles shared by the unit tests (no DOM library, no network). */

/** A minimal DOM: enough for renderer tests to inspect structure, attributes, text, CSS properties and listeners. */
export const createFakeDom = () => {
	/** @param {string} tag */
	const createElement = (tag) => {
		/** @type {Record<string, Array<(event: any) => void>>} */
		const listeners = {};
		/** @type {Record<string, string>} */
		const properties = {};
		const node = {
			tag,
			/** @type {Record<string, string>} */
			attributes: {},
			/** @type {any[]} */
			children: [],
			style: {
				properties,
				/** @param {string} name @param {string} value */
				setProperty: (name, value) => {
					properties[name] = value;
				},
			},
			/** @param {string} name @param {string} value */
			setAttribute: (name, value) => {
				node.attributes[name] = value;
			},
			/** @param {...any} items */
			append: (...items) => {
				node.children.push(...items);
			},
			/** @param {string} type @param {(event: any) => void} listener */
			addEventListener: (type, listener) => {
				(listeners[type] ??= []).push(listener);
			},
			/** @param {string} type @param {any} [event] */
			dispatch: (type, event = {}) => {
				for (const listener of listeners[type] ?? []) listener(event);
			},
			get textContent() {
				return node.children.map((child) => (typeof child.text === 'string' ? child.text : child.textContent)).join('');
			},
		};
		return node;
	};
	/** @param {string} text */
	const createTextNode = (text) => ({ text, textContent: text });
	return { createElement, createTextNode };
};

/**
 * Depth-first search in a fake DOM tree.
 * @param {any} node
 * @param {(node: any) => boolean} predicate
 * @returns {any[]}
 */
export const findAll = (node, predicate) => [
	...(predicate(node) ? [node] : []),
	...(node.children ?? []).flatMap((/** @type {any} */ child) => findAll(child, predicate)),
];

/**
 * A scripted Mode C client: routes `GET`/`POST` paths to handlers returning values (ok) or `{ error }` (problem).
 * @param {Record<string, (query: any, body?: any) => any>} routes keyed by `METHOD path`
 */
export const createClient = (routes) => {
	/** @type {Array<{ method: string, path: string, query?: any, body?: any }>} */
	const calls = [];
	/** @param {string} method @param {string} path @param {any} [query] @param {any} [body] */
	const run = async (method, path, query, body) => {
		calls.push({ method, path, query, body });
		const handler = routes[`${method} ${path}`];
		if (!handler) return { ok: /** @type {const} */ (false), error: { code: 'not_found', status: 404 } };
		const value = await handler(query, body);
		return value && value.error
			? { ok: /** @type {const} */ (false), error: value.error }
			: { ok: /** @type {const} */ (true), value };
	};
	return {
		calls,
		/** @param {string} path @param {{ query?: any }} [options] */
		get: (path, options = {}) => run('GET', path, options.query),
		/** @param {string} path @param {any} [body] */
		post: (path, body) => run('POST', path, undefined, body),
	};
};

/** A tier view as the API returns it. @param {Record<string, any>} [overrides] */
export const tierView = (overrides = {}) => ({
	key: 'good',
	label: 'Good',
	shortLabel: 'Good',
	description: 'Light signs of use.',
	color: { hex: null, token: '--ss-color-warning', css: 'var(--ss-color-warning)' },
	icon: 'check',
	order: 3,
	rank: 2,
	badge: 'soft',
	...overrides,
});
