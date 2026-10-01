/**
 * Subscription state (pure): holds → status, resolver inputs, pins, settlement pauses and the element timeline.
 *
 * A subscription is `cancelled` once cancelled; otherwise its status follows its **holds**:
 * `suspended` (merchant suspended) › `paused` (any of a manual pause, insufficient credits, a spend cap) › `active`.
 * Each hold is a separate pause interval for settlement (F.1: only fully paused hours are free), so releasing one
 * hold never resumes a subscription another hold still stops.
 * @module
 */

export const HOLDS = Object.freeze(/** @type {const} */ (['paused', 'insufficient_credits', 'spend_cap', 'suspended']));
/** @typedef {typeof HOLDS[number]} Hold */
/** @typedef {'active' | 'paused' | 'suspended' | 'cancelled'} SubscriptionStatus */

/**
 * @typedef {object} Pin
 * @property {string} version price-book version
 * @property {string | number} manifestVersion catalog version of the manifest the price book came from
 * @property {string | null} planCode
 * @property {Date | string | number} at
 */

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
 * Status and runtime flags for `resolveEntitlement`.
 * @param {{ cancelledAt?: Date | null, holds?: readonly string[] }} sub
 * @returns {{ status: 'active' | 'paused' | 'suspended' | 'cancelled', spendCap: boolean }}
 */
export const resolverState = (sub) => {
	const holds = sub.holds ?? [];
	if (sub.cancelledAt) return { status: 'cancelled', spendCap: false };
	if (holds.includes('suspended')) return { status: 'suspended', spendCap: false };
	if (holds.includes('paused') || holds.includes('insufficient_credits')) return { status: 'paused', spendCap: false };
	return { status: 'active', spendCap: holds.includes('spend_cap') };
};

/**
 * Settlement pause reason of a hold (`@ss/entitlements` priority names).
 * @param {string} hold
 * @returns {string}
 */
export const pauseReasonOf = (hold) => (hold === 'insufficient_credits' ? 'balance' : hold);

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
 * Whether the subscription would bill the next hour (it holds nothing that stops it except possibly a spend cap).
 * @param {{ cancelledAt?: Date | null, holds?: readonly string[] }} sub
 * @param {{ ignoreSpendCap?: boolean }} [options]
 */
export const runsNextHour = (sub, { ignoreSpendCap = false } = {}) => {
	if (sub.cancelledAt) return false;
	return (sub.holds ?? []).every((h) => ignoreSpendCap && h === 'spend_cap');
};

/**
 * The pin in effect at `at` (the last pin with `pin.at ≤ at`; the first pin before any).
 * @param {readonly Pin[]} pins
 * @param {Date | string | number} at
 * @returns {Pin}
 */
export const pinAt = (pins, at) => {
	const t = new Date(at).getTime();
	const sorted = [...pins].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
	let current = sorted[0];
	for (const pin of sorted) if (new Date(pin.at).getTime() <= t) current = pin;
	if (!current) throw Object.assign(new Error('subscription has no price-book pin'), { code: 'subscription/no_pin' });
	return current;
};

/**
 * Converts timeline snapshots `{ at, elements }` (ascending) into `planSettlement` events
 * `{ at, element, enabled }` (the first snapshot switches its elements on; later ones switch the difference).
 * @param {readonly { at: Date | string | number, elements: readonly string[] }[]} snapshots
 * @returns {{ at: string, element: string, enabled: boolean }[]}
 */
export const timelineEvents = (snapshots) => {
	/** @type {{ at: string, element: string, enabled: boolean }[]} */
	const events = [];
	/** @type {Set<string>} */
	let previous = new Set();
	for (const snapshot of snapshots) {
		const at = new Date(snapshot.at).toISOString();
		const next = new Set(snapshot.elements);
		for (const element of [...next].sort()) if (!previous.has(element)) events.push({ at, element, enabled: true });
		for (const element of [...previous].sort()) if (!next.has(element)) events.push({ at, element, enabled: false });
		previous = next;
	}
	return events;
};

/**
 * @param {readonly string[] | null | undefined} a
 * @param {readonly string[]} b
 */
export const sameElements = (a, b) => {
	if (!a || a.length !== b.length) return false;
	const sa = [...a].sort();
	const sb = [...b].sort();
	return sa.every((x, i) => x === sb[i]);
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
