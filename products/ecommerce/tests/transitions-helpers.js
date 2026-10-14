/**
 * Helpers of the order engine's property tests: a seeded random generator (a failure replays by its seed) and random
 * order flows the role rules allow.
 * @module
 */
import { checkOrderFlow, rolesAllow } from '../core/flow.js';
import { STATUS_ROLES } from '../core/model.js';

/** A small seeded random generator (mulberry32), so a failure can be replayed by its seed. @param {number} seed */
export const randomOf = (seed) => {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

/**
 * A random flow the role rules allow: one or two statuses per role (one of each waiting role), random allowed moves.
 * With `full`, always two statuses per role (one of each waiting role), so flows differ only in their moves and each
 * can be saved over the last while orders are in any status (the flow-save guard).
 * @param {() => number} random
 * @param {{ full?: boolean }} [options]
 * @returns {import('../core/model.js').OrderFlow}
 */
export const randomFlow = (random, { full = false } = {}) => {
	/** @type {import('../core/model.js').OrderFlow['statuses']} */
	const statuses = [];
	for (const role of STATUS_ROLES) {
		const count = role === 'awaiting_payment' || role === 'awaiting_confirmation' ? 1 : full ? 2 : 1 + Math.floor(random() * 2);
		for (let n = 0; n < count; n += 1) statuses.push({ key: `${role.replace(/_/g, '-')}-${n}`, label: `${role} ${n}`, role });
	}
	const moves = [];
	for (const from of statuses)
		for (const to of statuses)
			if (from.key !== to.key && rolesAllow(from.role, to.role) && random() < 0.6) moves.push({ from: from.key, to: to.key });
	const checked = checkOrderFlow({ statuses, moves });
	if (!checked.ok) throw new Error(checked.errors.join(' '));
	return checked.value;
};
