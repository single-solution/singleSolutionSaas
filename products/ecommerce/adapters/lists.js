/**
 * Ecommerce's list settings, in the product database (like Chat's, PLAN 0.8.4 step 8): settings that are lists or
 * records, which a settings schema cannot hold — the order flow (statuses and allowed moves), the payment methods
 * (fixed-choices E2), delivery zones, couriers, the shop's policies (E27), saved customer segments (E11; today's three
 * until saved),
 * the region names checkout offers per country (dynamic model §5), tax rules, condition grades, unit states (E38), item types (dynamic model §1), booking schedules with their dated exceptions (E30), role prices (E19), the
 * cancel and failed-delivery reasons (fixed-choices E19) and the claim kinds and statuses (E18). They are kept per website in the kit's settings collection (so a
 * removed website's lists go with its settings), each checked by its feature's rules, edited in the dashboard
 * (Settings, `/v1/dashboard/websites/:websiteId/lists/:list`) and recorded in Recent changes and the activity log. Lists have no global
 * defaults; an unsaved list reads as its code default. A list may also be checked against the merchant's data before
 * it is saved (`guards`: the order flow keeps the key and kind of every status that has orders, the claim statuses the
 * key and role of every status that has claims; item types keep what products, categories and units in stock rely on).
 * @module
 */
import { checkAddressRegions } from '../core/address.js';
import { checkBookingSchedules, defaultSchedules } from '../core/bookings.js';
import { checkCouriers } from '../core/couriers.js';
import { DEFAULT_SEGMENTS, checkSegments } from '../core/customer-segments.js';
import { checkZones, defaultZones } from '../core/delivery.js';
import { DEFAULT_FLOW, checkOrderFlow } from '../core/flow.js';
import { checkGrades } from '../core/grades.js';
import { DEFAULT_POLICIES, checkPolicies } from '../core/policies.js';
import { checkItemTypes } from '../core/item-types.js';
import { checkPaymentMethods, defaultPaymentMethods } from '../core/payment-methods.js';
import { checkRolePrices } from '../core/role-pricing.js';
import { DEFAULT_CANCEL_REASONS, DEFAULT_DELIVERY_FAILURE_REASONS, checkReasons } from '../core/order-reasons.js';
import { DEFAULT_CLAIM_KINDS, DEFAULT_CLAIM_STATUSES, checkClaimKinds, checkClaimStatuses } from '../core/returns.js';
import { checkTaxRules } from '../core/taxes.js';
import { DEFAULT_UNIT_STATES, checkUnitStates } from '../core/unit-states.js';

/**
 * @typedef {{ ok: true, value: any } | { ok: false, errors: Array<string | { path: string, message: string, code?: string }> }} ListCheck
 * @typedef {{ feature: string, title: string, check: (value: unknown) => ListCheck, fallback: () => any }} ListDefinition
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
	},
	payment_methods: {
		feature: 'checkout',
		title: 'Payment methods',
		check: checkPaymentMethods,
		fallback: defaultPaymentMethods,
	},
	couriers: { feature: 'checkout', title: 'Couriers', check: checkCouriers, fallback: () => [] },
	policies: {
		feature: 'checkout',
		title: 'Policies',
		check: checkPolicies,
		fallback: () => DEFAULT_POLICIES.map((policy) => ({ ...policy })),
	},
	address_regions: { feature: 'checkout', title: 'Address regions', check: checkAddressRegions, fallback: () => [] },
	customer_segments: {
		feature: 'checkout',
		title: 'Customer segments',
		check: checkSegments,
		fallback: () => structuredClone(DEFAULT_SEGMENTS),
	},
	delivery_zones: { feature: 'delivery_zones', title: 'Delivery zones', check: checkZones, fallback: defaultZones },
	tax_rules: { feature: 'taxes', title: 'Tax rules', check: checkTaxRules, fallback: () => [] },
	grades: { feature: 'grades_serials', title: 'Condition grades', check: checkGrades, fallback: () => [] },
	unit_states: {
		feature: 'grades_serials',
		title: 'Unit states',
		check: checkUnitStates,
		fallback: () => DEFAULT_UNIT_STATES.map((state) => ({ ...state })),
	},
	item_types: { feature: 'catalog', title: 'Item types', check: checkItemTypes, fallback: () => [] },
	booking_schedules: {
		feature: 'bookings',
		title: 'Booking schedules',
		check: checkBookingSchedules,
		fallback: defaultSchedules,
	},
	role_prices: { feature: 'role_pricing', title: 'Role prices', check: checkRolePrices, fallback: () => [] },
	cancel_reasons: {
		feature: 'checkout',
		title: 'Cancel reasons',
		check: checkReasons,
		fallback: () => DEFAULT_CANCEL_REASONS.map((reason) => ({ ...reason })),
	},
	delivery_failure_reasons: {
		feature: 'checkout',
		title: 'Failed delivery reasons',
		check: checkReasons,
		fallback: () => DEFAULT_DELIVERY_FAILURE_REASONS.map((reason) => ({ ...reason })),
	},
	claim_kinds: {
		feature: 'returns',
		title: 'Claim kinds',
		check: checkClaimKinds,
		fallback: () => DEFAULT_CLAIM_KINDS.map((kind) => ({ ...kind, outcomes: [...kind.outcomes] })),
	},
	claim_statuses: {
		feature: 'returns',
		title: 'Claim statuses',
		check: checkClaimStatuses,
		fallback: () => DEFAULT_CLAIM_STATUSES.map((status) => ({ ...status })),
	},
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
			return doc ? doc.value : LISTS[name].fallback();
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
				const saved = doc ? doc.value : LISTS[name].fallback();
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
