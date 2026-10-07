/** Test doubles and fixtures shared by the unit tests (no DOM library, no network). */
import { compileSchema } from '../core/compile.js';
import { parseSchema } from '../core/schema.js';

/**
 * A minimal DOM: structure, attributes, text, listeners, focus, `style.setProperty` and `replaceWith`.
 * @returns {{ createElement: (tag: string) => any, createTextNode: (text: string) => any, activeElement: any }}
 */
export const createFakeDom = () => {
	/** @type {WeakMap<object, any>} */
	const parents = new WeakMap();
	const doc = {
		/** @type {any} */
		activeElement: null,
		/** @param {string} tag */
		createElement: (tag) => {
			/** @type {Record<string, Array<(event: any) => void>>} */
			const listeners = {};
			const node = {
				tag,
				ownerDocument: doc,
				/** @type {Record<string, string>} */
				attributes: {},
				/** @type {Record<string, string>} */
				styles: {},
				/** @type {any[]} */
				children: [],
				style: {
					/** @param {string} name @param {string} value */
					setProperty: (name, value) => {
						node.styles[name] = value;
					},
				},
				/** @param {string} name @param {string} value */
				setAttribute: (name, value) => {
					node.attributes[name] = value;
				},
				/** @param {string} name */
				getAttribute: (name) => node.attributes[name] ?? null,
				/** @param {...any} items */
				append: (...items) => {
					for (const item of items) {
						if (item && typeof item === 'object') parents.set(item, node);
						node.children.push(item);
					}
				},
				/** @param {any} next */
				replaceWith: (next) => {
					const parent = parents.get(node);
					if (!parent) return;
					parent.children = parent.children.map((/** @type {any} */ child) => (child === node ? next : child));
					parents.set(next, parent);
					parents.delete(node);
				},
				focus: () => {
					doc.activeElement = node;
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
		},
		/** @param {string} text */
		createTextNode: (text) => ({ text, textContent: text }),
	};
	return doc;
};

/**
 * Depth-first search in a fake DOM tree.
 * @param {any} node
 * @param {(node: any) => boolean} predicate
 * @returns {any[]}
 */
export const findAll = (node, predicate) => [
	...(node && predicate(node) ? [node] : []),
	...(node?.children ?? []).flatMap((/** @type {any} */ child) => findAll(child, predicate)),
];

/** A phone: storage × colour combinations with stock, an exclusion rule and a dependent add-on. */
export const PHONE = Object.freeze({
	key: 'phone-x',
	name: 'Phone X',
	groups: [
		{
			key: 'storage',
			label: 'Storage',
			options: [{ key: '128' }, { key: '256', priceDelta: 10000 }, { key: '512', priceDelta: 25000 }],
		},
		{
			key: 'color',
			label: 'Colour',
			display: 'swatches',
			options: [
				{ key: 'black', label: 'Black', swatch: '#000000' },
				{ key: 'pink', label: 'Pink', swatch: '#ffc0cb' },
				{ key: 'gold', label: 'Gold' },
			],
		},
		{
			key: 'addons',
			label: 'Add-ons',
			type: 'multi',
			required: false,
			options: [
				{ key: 'case', label: 'Case', priceDelta: 1500 },
				{ key: 'charger', label: 'Charger', priceDelta: 2500, when: "selection.storage != '128'" },
			],
		},
	],
	rules: [
		{ id: 'no-pink-512', when: "selection.storage == '512' and selection.color == 'pink'", message: 'Pink stops at 256.' },
	],
	combinations: [
		{ id: 'v1', sku: 'PX-128-BK', options: { storage: '128', color: 'black' }, stock: 3, price: 50000 },
		{ id: 'v2', sku: 'PX-256-BK', options: { storage: '256', color: 'black' }, stock: 0, price: 60000 },
		{ id: 'v3', sku: 'PX-256-PK', options: { storage: '256', color: 'pink' }, stock: 5, price: 60000 },
		{ id: 'v4', sku: 'PX-512', options: { storage: '512', color: ['black', 'gold'] }, stock: 2, price: 75000 },
	],
	pricing: { currency: 'EUR' },
});

/**
 * Parse and compile a schema (throws on problems — fixtures must be valid).
 * @param {unknown} input
 */
export const compiled = (input) => {
	const parsed = parseSchema(input);
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
	const built = compileSchema(parsed.schema);
	if (!built.ok) throw new Error(JSON.stringify(built.problems));
	return built.compiled;
};
