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
			value: '',
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

/** In-memory Mode C client for headless tests. */
export const createMemoryClient = () => {
	/** @type {Array<{ id: string, text: string, pinned: boolean, createdAt: string, updatedAt: string }>} */
	const notes = [];
	let counter = 0;
	return {
		notes,
		list: async () => ({ ok: /** @type {const} */ (true), value: { items: [...notes] } }),
		/** @param {{ text: string, pinned?: boolean }} input */
		create: async (input) => {
			counter += 1;
			const note = {
				id: `note_${String(counter).padStart(4, '0')}`,
				text: input.text,
				pinned: input.pinned ?? false,
				createdAt: '2026-10-01T00:00:00.000Z',
				updatedAt: '2026-10-01T00:00:00.000Z',
			};
			notes.push(note);
			return { ok: /** @type {const} */ (true), value: note };
		},
		/** @param {string} id @param {{ pinned?: boolean }} patch */
		update: async (id, patch) => {
			const note = notes.find((candidate) => candidate.id === id);
			if (!note) return { ok: /** @type {const} */ (false), problem: { code: 'not_found', status: 404 } };
			Object.assign(note, patch);
			return { ok: /** @type {const} */ (true), value: { ...note } };
		},
		/** @param {string} id */
		remove: async (id) => {
			const index = notes.findIndex((candidate) => candidate.id === id);
			if (index >= 0) notes.splice(index, 1);
			return { ok: /** @type {const} */ (true), value: { id } };
		},
	};
};
