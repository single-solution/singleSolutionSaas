/** Test doubles shared by the unit tests (no DOM library, no network). */

/** A minimal DOM: enough for renderer tests to inspect structure, attributes, text and listeners. */
export const createFakeDom = () => {
	/** @param {string} tag */
	const createElement = (tag) => {
		/** @type {Record<string, Array<(event: any) => void>>} */
		const listeners = {};
		const node = {
			tag,
			value: '',
			/** @type {Record<string, string>} */
			attributes: {},
			/** @type {any[]} */
			children: [],
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

/** A summary as `GET /v1/ratings/{itemId}` returns it. @param {Record<string, any>} [overrides] */
export const summaryView = (overrides = {}) => ({
	itemId: 'itm_1',
	title: 'Phone case',
	count: 2,
	average: 4.5,
	scale: 5,
	distribution: [
		{ rating: 5, count: 1, percent: 50 },
		{ rating: 4, count: 1, percent: 50 },
		{ rating: 3, count: 0, percent: 0 },
		{ rating: 2, count: 0, percent: 0 },
		{ rating: 1, count: 0, percent: 0 },
	],
	attributes: [
		{ key: 'quality', label: 'Quality', min: 1, max: 5, lowLabel: 'Poor', highLabel: 'Great', count: 2, average: 4.5 },
	],
	withPhotos: 0,
	verified: 2,
	lastReviewAt: '2026-10-01T10:00:00.000Z',
	display: { showSummary: true, showDistribution: true, showAttributes: true, allowSubmit: true },
	...overrides,
});

/** A public review. @param {Record<string, any>} [overrides] */
export const reviewView = (overrides = {}) => ({
	id: 'rev_1',
	itemId: 'itm_1',
	variantId: null,
	rating: 5,
	scale: 5,
	title: 'Great',
	body: 'Works perfectly.',
	author: 'Ava M.',
	verifiedPurchase: true,
	attributes: { quality: 5 },
	photos: [],
	reply: { body: 'Thanks!', at: '2026-10-02T10:00:00.000Z' },
	submittedAt: '2026-10-01T10:00:00.000Z',
	locale: 'en',
	...overrides,
});

/** The review form definition. @param {Record<string, any>} [overrides] */
export const formDefinition = (overrides = {}) => ({
	ratingScale: 5,
	title: { enabled: true, required: false, maxLength: 120 },
	body: { required: true, minLength: 10, maxLength: 2000 },
	authorName: { maxLength: 60 },
	attributes: [],
	photos: { enabled: false, max: 0, maxBytes: 0, types: [] },
	...overrides,
});

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
