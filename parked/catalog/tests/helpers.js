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
 * A scripted Mode C client: `routes['GET /v1/items']` → value (or `{ error }` for a failure).
 * @param {Record<string, (query: any) => any>} routes
 * @returns {any}
 */
export const createClient = (routes) => {
	/** @type {Array<{ path: string, query: any }>} */
	const calls = [];
	return {
		calls,
		/** @param {string} path @param {{ query?: Record<string, unknown> }} [options] */
		get: async (path, options = {}) => {
			const query = Object.fromEntries(Object.entries(options.query ?? {}).filter(([, v]) => v !== undefined));
			calls.push({ path, query });
			const route = routes[`GET ${path}`];
			if (!route) return { ok: false, error: { code: 'not_found', status: 404 } };
			const value = route(query);
			return value && value.error ? { ok: false, error: value.error } : { ok: true, value };
		},
	};
};

/** A public item view as `GET /v1/items` returns it. @param {Record<string, any>} [overrides] */
export const itemView = (overrides = {}) => ({
	id: 'itm_1',
	slug: 'polo',
	url: 'https://shop.example.com/items/polo',
	title: 'Polo',
	brand: { id: 'brd_1', slug: 'acme', name: 'Acme' },
	currency: 'EUR',
	priceMin: 2000,
	priceMax: 2200,
	inStock: true,
	options: [
		{
			key: 'size',
			label: 'Size',
			values: [
				{ value: 's', label: 'S' },
				{ value: 'm', label: 'M' },
			],
		},
		{
			key: 'color',
			label: 'Color',
			values: [
				{ value: 'navy', label: 'Navy' },
				{ value: 'red', label: 'Red' },
			],
		},
	],
	variants: [
		{
			id: 'var_1',
			options: { size: 's', color: 'navy' },
			price: 2000,
			compareAtPrice: 2500,
			availability: 'in_stock',
			purchasable: true,
		},
		{
			id: 'var_2',
			options: { size: 'm', color: 'navy' },
			price: 2200,
			compareAtPrice: null,
			availability: 'sold_out',
			purchasable: false,
		},
		{
			id: 'var_3',
			options: { size: 'm', color: 'red' },
			price: 2200,
			compareAtPrice: null,
			availability: 'low_stock',
			purchasable: true,
		},
	],
	media: [
		{
			id: 'med_1',
			kind: 'image',
			url: 'https://cdn.example.com/1.jpg',
			srcset: 'a 320w',
			alt: 'Front',
			width: 800,
			height: 800,
			variantIds: [],
		},
		{
			id: 'med_2',
			kind: 'video',
			url: 'https://cdn.example.com/2.mp4',
			srcset: null,
			alt: 'Clip',
			width: null,
			height: null,
			variantIds: ['var_3'],
		},
		{ id: 'med_3', kind: 'image', url: null, srcset: null, alt: 'Private', width: null, height: null, variantIds: [] },
	],
	...overrides,
});
