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

/** One offer as `POST /v1/offers:evaluate` returns it. @param {Record<string, any>} [overrides] */
export const offerView = (overrides = {}) => ({
	itemId: 'itm_1',
	variantId: null,
	currency: 'EUR',
	quantity: 1,
	unitAmount: 10_000,
	price: 8000,
	total: 8000,
	discount: 2000,
	percentOff: 20,
	locked: false,
	deals: [{ id: 'dl_1', stockLeft: 4 }],
	badge: { dealId: 'dl_1', kind: 'flash', label: null, tone: 'urgent', reward: { type: 'percent', percent: 20 } },
	pills: [
		{
			dealId: 'dl_1',
			kind: 'flash',
			name: 'Flash',
			label: null,
			tone: 'urgent',
			reward: { type: 'percent', percent: 20 },
			conditions: {},
			conditional: false,
		},
		{
			dealId: 'dl_2',
			kind: 'cart',
			name: 'Card',
			label: 'Pay by card',
			tone: 'accent',
			reward: { type: 'percent', percent: 3 },
			conditions: { paymentMethods: ['card'], minSubtotal: 5000 },
			conditional: true,
		},
	],
	countdown: { endsAt: '2026-10-02T14:00:00.000Z' },
	...overrides,
});

/** A deals page card as `GET /v1/deals-page` returns it. @param {Record<string, any>} [overrides] */
export const dealCardView = (overrides = {}) => ({
	id: 'dl_1',
	kind: 'flash',
	name: 'Flash sale',
	description: 'Today only',
	badge: { label: null, tone: 'urgent' },
	reward: { type: 'percent', percent: 20 },
	schedule: { active: true, activeUntil: '2026-10-02T14:00:00.000Z', nextStart: null, timeZone: 'Europe/Berlin' },
	stockLeft: 4,
	conditions: { minQuantity: 2 },
	currency: 'EUR',
	items: [
		{
			itemId: 'itm_1',
			variantId: null,
			title: 'Runner',
			url: '/runner',
			image: 'https://cdn.example.com/r.jpg',
			currency: 'EUR',
			unitAmount: 10_000,
			price: 8000,
		},
	],
	moreItems: true,
	...overrides,
});
