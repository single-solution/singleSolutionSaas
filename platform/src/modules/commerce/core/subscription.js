/**
 * Subscription state (pure): holds → status, resolver inputs and element switches.
 *
 * A subscription is `cancelled` once cancelled; otherwise its status follows its **holds**: `suspended` (merchant
 * suspended) › `paused` (a manual pause) › `active`. Releasing one hold never resumes a subscription another hold still
 * stops. Money does not follow subscriptions (`core/money.js`).
 * @module
 */

export const HOLDS = Object.freeze(/** @type {const} */ (['paused', 'suspended']));
/** @typedef {typeof HOLDS[number]} Hold */
/** @typedef {'active' | 'paused' | 'suspended' | 'cancelled'} SubscriptionStatus */

/**
 * @param {{ cancelledAt?: Date | null, holds?: readonly string[] }} sub
 * @returns {SubscriptionStatus}
 */
export const statusOf = (sub) => {
	if (sub.cancelledAt) return 'cancelled';
	const holds = sub.holds ?? [];
	if (holds.includes('suspended')) return 'suspended';
	return holds.length > 0 ? 'paused' : 'active';
};

/**
 * Status for `resolveEntitlement`.
 * @param {{ cancelledAt?: Date | null, holds?: readonly string[] }} sub
 * @returns {{ status: SubscriptionStatus }}
 */
export const resolverState = (sub) => ({ status: statusOf(sub) });

/**
 * @param {readonly string[]} holds
 * @param {Hold} hold
 * @param {boolean} on
 * @returns {string[]}
 */
export const withHold = (holds, hold, on) => {
	const set = new Set(holds);
	if (on) set.add(hold);
	else set.delete(hold);
	return HOLDS.filter((h) => set.has(h));
};

/**
 * Commerce element switches overlaid onto configuration layers: merchant switches are website overrides, staff
 * switches admin overrides; a switch replaces the config entry of the same element in the same layer.
 * @param {Record<string, any>} layers config layers (`config.layersFor`)
 * @param {{ website?: Record<string, boolean>, admin?: Record<string, boolean> } | undefined} switches
 * @returns {Record<string, any>}
 */
export const overlaySwitches = (layers, switches) => {
	/** @type {Record<string, any>} */
	const out = { ...layers };
	for (const layer of /** @type {const} */ (['website', 'admin'])) {
		const own = switches?.[layer] ?? {};
		if (Object.keys(own).length === 0) continue;
		const base = out[layer] ?? {};
		/** @type {Record<string, unknown>} */
		const elements = { ...(base.elements ?? {}) };
		for (const [key, enabled] of Object.entries(own)) {
			const existing = elements[key];
			const locked = typeof existing === 'object' && existing !== null && /** @type {any} */ (existing).locked === true;
			elements[key] = { enabled, ...(locked ? { locked: true } : {}) };
		}
		out[layer] = { ...base, elements };
	}
	return out;
};
