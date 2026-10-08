/**
 * Ecommerce's list settings, in the product database (like Chat's, PLAN 0.8.4 step 8): settings that are lists or
 * records, which a settings schema cannot hold — the order flow (statuses and allowed moves), delivery zones, couriers,
 * tax rules, condition grades and booking hours. They are kept per website in the kit's settings collection (so a
 * removed website's lists go with its settings), each checked by its feature's rules, edited in the dashboard
 * (Settings, `/v1/dashboard/websites/:websiteId/lists/:list`) and recorded in Recent changes. Lists have no global
 * defaults; an unsaved list reads as its code default.
 * @module
 */
import { checkBookingHours } from '../core/bookings.js';
import { checkCouriers } from '../core/couriers.js';
import { checkZones } from '../core/delivery.js';
import { DEFAULT_FLOW, checkOrderFlow } from '../core/flow.js';
import { checkGrades } from '../core/grades.js';
import { checkTaxRules } from '../core/taxes.js';

/**
 * @typedef {{ ok: true, value: any } | { ok: false, errors: string[] }} ListCheck
 * @typedef {{ feature: string, title: string, check: (value: unknown) => ListCheck, fallback: () => any }} ListDefinition
 */

/** Each list: the feature it belongs to, its name on screens, its check and its value before it is saved. */
export const LISTS = Object.freeze({
	order_flow: { feature: 'checkout', title: 'Order statuses and moves', check: checkOrderFlow, fallback: () => DEFAULT_FLOW },
	couriers: { feature: 'checkout', title: 'Couriers', check: checkCouriers, fallback: () => [] },
	delivery_zones: { feature: 'delivery_zones', title: 'Delivery zones', check: checkZones, fallback: () => [] },
	tax_rules: { feature: 'taxes', title: 'Tax rules', check: checkTaxRules, fallback: () => [] },
	grades: { feature: 'grades_serials', title: 'Condition grades', check: checkGrades, fallback: () => [] },
	booking_hours: { feature: 'bookings', title: 'Booking hours', check: checkBookingHours, fallback: () => [] },
});

/** @typedef {keyof typeof LISTS} ListName */

/**
 * @param {unknown} name
 * @returns {name is ListName}
 */
export const isListName = (name) => typeof name === 'string' && Object.hasOwn(LISTS, name);

/**
 * @param {{ store: import('@ss/app-kit').Store, now: () => number }} options
 */
export const createLists = ({ store, now }) => {
	/** @param {string} websiteId @param {string} key */
	const idOf = (websiteId, key) => `${websiteId}|ecommerce|${key}`;

	return Object.freeze({
		/**
		 * The saved value of a list, else its default.
		 * @param {string} websiteId
		 * @param {ListName} name
		 * @returns {Promise<any>}
		 */
		get: async (websiteId, name) => {
			const doc = await store.get('settings', idOf(websiteId, `list.${name}`));
			return doc && doc.value !== undefined ? doc.value : LISTS[name].fallback();
		},
		/**
		 * Check and save a list.
		 * @param {string} websiteId
		 * @param {ListName} name
		 * @param {unknown} value
		 * @returns {Promise<ListCheck>}
		 */
		save: async (websiteId, name, value) => {
			const checked = LISTS[name].check(value);
			if (!checked.ok) return checked;
			await store.put('settings', idOf(websiteId, `list.${name}`), {
				websiteId,
				kind: 'ecommerce',
				key: `list.${name}`,
				value: checked.value,
				at: now(),
			});
			return checked;
		},
	});
};

/** @typedef {ReturnType<typeof createLists>} Lists */
