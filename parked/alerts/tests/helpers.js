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

/**
 * In-memory Mode C client of the Notify-me element (headless tests).
 * @param {{ types?: string[], channels?: string[], requireConsent?: boolean, allowEntry?: boolean, fail?: Record<string, any> }} [options]
 */
export const createNotifyMeClient = ({
	types = ['back_in_stock', 'price_drop'],
	channels = ['email', 'sms'],
	requireConsent = true,
	allowEntry = true,
	fail = {},
} = {}) => {
	/** @type {Array<Record<string, any>>} */
	const bodies = [];
	return {
		bodies,
		alertTypes: async () =>
			fail.alertTypes
				? { ok: /** @type {const} */ (false), problem: fail.alertTypes }
				: {
						ok: /** @type {const} */ (true),
						value: {
							items: types.map((type) => ({
								type,
								name: type,
								...(type === 'price_drop' ? { priceDrop: { allowTarget: true } } : {}),
							})),
							capture: { channels, requireConsent, doubleOptIn: false, allowEntry },
						},
					},
		/** @param {Record<string, any>} body */
		subscribe: async (body) => {
			bodies.push(body);
			if (fail.subscribe) return { ok: /** @type {const} */ (false), problem: fail.subscribe };
			return {
				ok: /** @type {const} */ (true),
				value: {
					id: 'als_1',
					type: body.type,
					channel: body.channel,
					status: fail.unconfirmed ? 'unconfirmed' : 'pending',
					contactMasked: 'j•••@example.com',
					position: fail.position,
					created: true,
				},
			};
		},
		/** @param {string} id */
		unsubscribe: async (id) =>
			fail.unsubscribe
				? { ok: /** @type {const} */ (false), problem: fail.unsubscribe }
				: { ok: /** @type {const} */ (true), value: { id, type: 'back_in_stock', status: 'unsubscribed' } },
	};
};
