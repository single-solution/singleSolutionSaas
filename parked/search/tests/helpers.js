/** Test doubles shared by the unit tests (no DOM library, no network). */

/** A minimal DOM: enough for renderer tests to inspect structure, attributes, text and listeners. */
export const createFakeDom = () => {
	/** @param {string} tag */
	const createElement = (tag) => {
		/** @type {Record<string, Array<(event: any) => void>>} */
		const listeners = {};
		const node = {
			tag,
			/** @type {Record<string, string>} */
			attributes: {},
			/** @type {any[]} */
			children: [],
			/** @param {string} name @param {string} value */
			setAttribute: (name, value) => {
				node.attributes[name] = value;
			},
			/** @param {string} name */
			getAttribute: (name) => node.attributes[name] ?? null,
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
				return node.children
					.map((/** @type {any} */ child) => (typeof child.text === 'string' ? child.text : child.textContent))
					.join('');
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
 * A scripted Mode C client: `routes['GET /v1/search']` → value (or `{ error }`) from the query; POSTs are recorded.
 * @param {Record<string, (query: any) => any>} routes
 * @returns {any}
 */
export const createClient = (routes) => {
	/** @type {Array<{ method: string, path: string, query?: any, body?: any }>} */
	const calls = [];
	/** @param {string} method @param {string} path @param {any} input */
	const answer = (method, path, input) => {
		const route = routes[`${method} ${path}`];
		if (!route) return { ok: false, error: { code: 'not_found', status: 404 } };
		const value = route(input);
		return value && value.error ? { ok: false, error: value.error } : { ok: true, value };
	};
	return {
		calls,
		/** @param {string} path @param {{ query?: Record<string, unknown> }} [options] */
		get: async (path, options = {}) => {
			const query = Object.fromEntries(Object.entries(options.query ?? {}).filter(([, v]) => v !== undefined));
			calls.push({ method: 'GET', path, query });
			return answer('GET', path, query);
		},
		/** @param {string} path @param {unknown} body */
		post: async (path, body) => {
			calls.push({ method: 'POST', path, body });
			return answer('POST', path, body);
		},
	};
};

/** A manual scheduler for debounced code: `run()` fires every pending timer. */
export const createScheduler = () => {
	/** @type {Array<{ fn: () => void, ms: number, cancelled: boolean }>} */
	const timers = [];
	return {
		timers,
		/** @param {() => void} fn @param {number} ms */
		schedule: (fn, ms) => {
			const timer = { fn, ms, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		run: () => {
			for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn();
		},
	};
};

/** An in-memory key-value storage. */
export const createStorage = () => {
	/** @type {Map<string, string>} */
	const values = new Map();
	return {
		values,
		get: (/** @type {string} */ key) => values.get(key) ?? null,
		set: (/** @type {string} */ key, /** @type {string} */ value) => void values.set(key, value),
	};
};
