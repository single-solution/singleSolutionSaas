/**
 * Ecommerce's list settings, in the product database (like Chat's, PLAN 0.8.4 step 8): settings that are lists or
 * records, which a settings schema cannot hold — the order flow (statuses and allowed moves), delivery zones, couriers,
 * the region names checkout offers per country (dynamic model §5), tax rules, condition grades, item types (dynamic model §1), booking hours and role prices (E19). They are kept per website in the kit's settings collection (so a
 * removed website's lists go with its settings), each checked by its feature's rules, edited in the dashboard
 * (Settings, `/v1/dashboard/websites/:websiteId/lists/:list`) and recorded in Recent changes and the activity log. Lists have no global
 * defaults; an unsaved list reads as its code default. A list may also be checked against the merchant's data before
 * it is saved (`guards`: the order flow keeps the key and kind of every status that has orders; item types keep what
 * products, categories and units in stock rely on).
 * @module
 */
import { checkAddressRegions } from '../core/address.js';
import { checkBookingHours } from '../core/bookings.js';
import { checkCouriers } from '../core/couriers.js';
import { checkZones } from '../core/delivery.js';
import { DEFAULT_FLOW, checkOrderFlow, readOrderFlow } from '../core/flow.js';
import { checkGrades } from '../core/grades.js';
import { checkItemTypes } from '../core/item-types.js';
import { checkRolePrices } from '../core/role-pricing.js';
import { checkTaxRules } from '../core/taxes.js';

/**
 * @typedef {{ ok: true, value: any } | { ok: false, errors: Array<string | { path: string, message: string, code?: string }> }} ListCheck
 * @typedef {{ feature: string, title: string, check: (value: unknown) => ListCheck, fallback: () => any,
 *   read?: (value: unknown) => any }} ListDefinition `read`: a saved value as the code reads it today (the order flow
 *   fills what a flow saved before phase 2 leaves out with today's behavior)
 * @typedef {(websiteId: string, saved: any, next: any) => Promise<Array<{ path: string, message: string, code?: string }>>} ListGuard
 *   what saving a list would break in the merchant's data (the order flow: statuses that have orders; item types: the
 *   fields they name, the types in use and units in stock)
 */

/** Each list: the feature it belongs to, its name on screens, its check and its value before it is saved. */
export const LISTS = Object.freeze({
	order_flow: {
		feature: 'checkout',
		title: 'Order statuses and moves',
		check: checkOrderFlow,
		fallback: () => DEFAULT_FLOW,
		read: readOrderFlow,
	},
	couriers: { feature: 'checkout', title: 'Couriers', check: checkCouriers, fallback: () => [] },
	address_regions: { feature: 'checkout', title: 'Address regions', check: checkAddressRegions, fallback: () => [] },
	delivery_zones: { feature: 'delivery_zones', title: 'Delivery zones', check: checkZones, fallback: () => [] },
	tax_rules: { feature: 'taxes', title: 'Tax rules', check: checkTaxRules, fallback: () => [] },
	grades: { feature: 'grades_serials', title: 'Condition grades', check: checkGrades, fallback: () => [] },
	item_types: { feature: 'catalog', title: 'Item types', check: checkItemTypes, fallback: () => [] },
	booking_hours: { feature: 'bookings', title: 'Booking hours', check: checkBookingHours, fallback: () => [] },
	role_prices: { feature: 'role_pricing', title: 'Role prices', check: checkRolePrices, fallback: () => [] },
});

/** @typedef {keyof typeof LISTS} ListName */

/**
 * @param {unknown} name
 * @returns {name is ListName}
 */
export const isListName = (name) => typeof name === 'string' && Object.hasOwn(LISTS, name);

/**
 * @param {{ store: import('@ss/app-kit').Store, now: () => number, guards?: Partial<Record<ListName, ListGuard>> }} options
 *   `guards`: checks of a list against the merchant's data before it is saved (both the dashboard and the settings API
 *   save through here)
 */
export const createLists = ({ store, now, guards = {} }) => {
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
			const value = doc && doc.value !== undefined ? doc.value : LISTS[name].fallback();
			/** @type {ListDefinition} */
			const list = LISTS[name];
			return list.read ? list.read(value) : value;
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
			const guard = guards[name];
			if (guard) {
				const doc = await store.get('settings', idOf(websiteId, `list.${name}`));
				const saved = doc && doc.value !== undefined ? doc.value : LISTS[name].fallback();
				const problems = await guard(websiteId, saved, checked.value);
				if (problems.length > 0) return { ok: false, errors: problems };
			}
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
