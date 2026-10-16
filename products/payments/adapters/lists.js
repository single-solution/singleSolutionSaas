/**
 * Payments' list settings, in the product database (like Chat's and Ecommerce's): the merchant's manual payment
 * methods (`manual_methods`, fixed-choices P1, P2), a list a settings schema cannot hold. It is kept per website in the
 * kit's settings collection (so a removed website's list goes with its settings), checked by `core/methods.js`, edited in
 * the dashboard (Settings → Manual payment methods) and by the merchant's server (`GET|PUT /v1/lists/manual_methods`),
 * and recorded in Recent changes and the activity log. Before it is saved it reads as the seeded list (today's bank
 * transfer).
 * @module
 */
import { checkMethods, defaultMethods } from '../core/methods.js';

/** Each list: the feature it belongs to, its name on screens, its check and its value before it is saved. */
export const LISTS = Object.freeze({
	manual_methods: {
		feature: 'manual_payments',
		title: 'Manual payment methods',
		check: checkMethods,
		fallback: defaultMethods,
	},
});

/** @typedef {keyof typeof LISTS} ListName */

/**
 * @param {{ store: import('@ss/app-kit').Store, now: () => number }} options
 */
export const createLists = ({ store, now }) => {
	/** @param {string} websiteId @param {ListName} name */
	const idOf = (websiteId, name) => `${websiteId}|payments|list.${name}`;

	/**
	 * The saved value of a list, else its default.
	 * @param {string} websiteId
	 * @param {ListName} name
	 * @returns {Promise<import('../core/methods.js').ManualMethod[]>}
	 */
	const get = async (websiteId, name) => {
		const doc = await store.get('settings', idOf(websiteId, name));
		return doc && Array.isArray(doc.value) ? doc.value : LISTS[name].fallback();
	};

	/**
	 * Check and save a list whole.
	 * @param {string} websiteId
	 * @param {ListName} name
	 * @param {unknown} value
	 */
	const save = async (websiteId, name, value) => {
		const checked = LISTS[name].check(value);
		if (!checked.ok) return checked;
		await store.put('settings', idOf(websiteId, name), {
			websiteId,
			kind: 'payments',
			key: `list.${name}`,
			value: checked.value,
			at: now(),
		});
		return checked;
	};

	return Object.freeze({ get, save });
};

/** @typedef {ReturnType<typeof createLists>} Lists */
