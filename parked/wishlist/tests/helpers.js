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

/** An in-memory Storage. @param {{ broken?: boolean }} [options] */
export const createStorage = ({ broken = false } = {}) => {
	/** @type {Map<string, string>} */
	const map = new Map();
	const guard = () => {
		if (broken) throw new Error('blocked');
	};
	return {
		map,
		/** @param {string} key */
		getItem: (key) => (guard(), map.get(key) ?? null),
		/** @param {string} key @param {string} value */
		setItem: (key, value) => {
			guard();
			map.set(key, value);
		},
		/** @param {string} key */
		removeItem: (key) => {
			guard();
			map.delete(key);
		},
	};
};

const ok = (/** @type {any} */ value) => ({ ok: /** @type {const} */ (true), value });
const no = (/** @type {string} */ code) => ({ ok: /** @type {const} */ (false), problem: { code } });

/**
 * An in-memory Mode C client of the widgets element that behaves like the API (one owner).
 * @param {{ owner?: 'guest' | 'customer' | null, settings?: Record<string, any>, fail?: Record<string, string>, lists?: any[] }} [options]
 */
export const createWishlistClient = ({ owner = 'guest', settings = {}, fail = {}, lists: initial } = {}) => {
	let n = 0;
	const id = (/** @type {string} */ prefix) => `${prefix}_${(n += 1)}`;
	/** @type {any[]} */
	let lists = initial ?? [];
	/** @type {Array<[string, any]>} */
	const calls = [];
	const view = (/** @type {any} */ list) => ({ ...list, itemCount: list.items.length });
	const find = (/** @type {string} */ listId) =>
		listId === 'default' ? (lists.find((l) => l.isDefault) ?? null) : (lists.find((l) => l.id === listId) ?? null);
	return {
		calls,
		get lists() {
			return lists;
		},
		/** @param {Record<string, unknown>} body */
		state: async (body) => {
			calls.push(['state', body]);
			if (fail.state) return no(fail.state);
			return ok({
				owner: owner ? { kind: owner } : null,
				guest: owner === 'guest' && !body.guest ? { token: 'wg1.new.token', expiresAt: 'x' } : null,
				dropGuest: owner === 'customer' && Boolean(body.guest),
				merged: 0,
				lists: lists.map(view),
				settings: {
					maxLists: 3,
					maxItems: 10,
					guests: true,
					storage: 'local',
					consentCategory: 'preferences',
					share: true,
					notify: owner === 'customer',
					manageLists: true,
					layout: 'grid',
					announce: true,
					...settings,
				},
			});
		},
		/** @param {string} listId @param {Record<string, any>} body */
		add: async (listId, body) => {
			calls.push(['add', { listId, ...body }]);
			if (fail.add) return no(fail.add);
			let list = find(listId);
			if (!list) {
				list = { id: id('wl'), name: 'Wishlist', isDefault: true, notify: false, shared: false, items: [] };
				lists = [...lists, list];
			}
			const fields = Object.fromEntries(Object.entries(body).filter(([name]) => name !== 'guest'));
			const entry = { id: id('wli'), variantId: null, title: null, price: null, ...fields };
			list.items = [entry, ...list.items];
			return ok({ entryId: entry.id, added: true, list: view(list) });
		},
		/** @param {string} listId @param {string} entryId @param {Record<string, unknown>} body */
		remove: async (listId, entryId, body) => {
			calls.push(['remove', { listId, entryId, ...body }]);
			if (fail.remove) return no(fail.remove);
			const list = find(listId);
			list.items = list.items.filter((/** @type {any} */ e) => e.id !== entryId);
			return ok({ entryId, removed: true, list: view(list) });
		},
		/** @param {Record<string, any>} body */
		createList: async (body) => {
			calls.push(['createList', body]);
			if (fail.createList) return no(fail.createList);
			const list = { id: id('wl'), name: body.name, isDefault: lists.length === 0, notify: false, shared: false, items: [] };
			lists = [...lists, list];
			return ok(view(list));
		},
		/** @param {string} listId @param {Record<string, any>} body */
		updateList: async (listId, body) => {
			calls.push(['updateList', { listId, ...body }]);
			if (fail.updateList) return no(fail.updateList);
			const list = find(listId);
			Object.assign(list, body);
			return ok(view(list));
		},
		/** @param {string} listId @param {Record<string, unknown>} body */
		deleteList: async (listId, body) => {
			calls.push(['deleteList', { listId, ...body }]);
			if (fail.deleteList) return no(fail.deleteList);
			lists = lists.filter((l) => l.id !== listId);
			return ok({ id: listId, deleted: true });
		},
		/** @param {Record<string, any>} body */
		share: async (body) => {
			calls.push(['share', body]);
			if (fail.share) return no(fail.share);
			return ok({ listId: body.listId, token: 'tok', url: 'https://shop.example.com/s?t=tok' });
		},
		/** @param {Record<string, any>} body */
		revoke: async (body) => {
			calls.push(['revoke', body]);
			if (fail.revoke) return no(fail.revoke);
			return ok({ listId: body.listId, shared: false });
		},
		/** @param {string} token */
		shared: async (token) => {
			calls.push(['shared', token]);
			if (token !== 'tok') return no('not_found');
			return ok({
				name: 'Birthday',
				itemCount: 1,
				items: [
					{ itemId: 'a', title: 'Mug', image: null, url: null, price: { amount: 1500, currency: 'EUR' }, inStock: null },
				],
			});
		},
	};
};
