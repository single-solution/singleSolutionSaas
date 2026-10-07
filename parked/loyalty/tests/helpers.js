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

/** A wallet view as `GET /v1/wallet` returns it. @param {Record<string, any>} [overrides] */
export const walletView = (overrides = {}) => ({
	customerId: 'cus_1',
	balance: 1234,
	lifetime: { earned: 2000, redeemed: 766, spend: 0 },
	tier: { key: 'silver', name: 'Silver', metric: 1500, next: { key: 'gold', name: 'Gold', remaining: 3500 } },
	expiring: { points: 300, expiresAt: '2026-10-15T08:00:00.000Z', expiresOn: '2026-10-15' },
	display: { showHistory: true, showTier: true },
	history: {
		items: [
			{ id: 'ptx_2', kind: 'redeem', points: -500, occurredAt: '2026-09-20T10:00:00.000Z', reason: 'checkout' },
			{ id: 'ptx_1', kind: 'earn', points: 1734, occurredAt: '2026-09-01T10:00:00.000Z', reason: 'earn_rules' },
		],
		nextCursor: 'c1',
		hasMore: true,
	},
	...overrides,
});
