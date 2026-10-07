/**
 * Stacking policy (pure). Every deal belongs to a **class** (`stacking.classes`, e.g. `item`, `cart`, `exclusive`);
 * two deals that touch the same line may both apply only when their classes allow it:
 *
 * - same class → the class's `stack_within`;
 * - different classes → **each** class lists the other in `combines_with` (mutual, so an exclusive class can always
 *   say no);
 * - stacking switched off → nothing combines (one offer per line, a cart deal only on lines without item deals).
 *
 * Deals that touch disjoint lines never conflict. Which compatible set wins is the strategy: `best_for_customer`
 * (largest saving) or `priority` (higher priority first). Generalised from ibrahimMobiles, where a cart-wide offer
 * joined line deals only when both sides were stackable.
 * @module
 */

/** Selection strategies (`stacking.strategy`). */
export const STRATEGIES = Object.freeze(/** @type {const} */ (['best_for_customer', 'priority']));

/** @typedef {{ key: string, stack_within: boolean, combines_with: string[] }} ClassConfig */
/** @typedef {{ enabled: boolean, classes: Map<string, { stackWithin: boolean, combinesWith: Set<string> }> }} Policy */

/**
 * @param {{ enabled: boolean, classes: ClassConfig[] }} input
 * @returns {Policy}
 */
export const createPolicy = ({ enabled, classes }) => ({
	enabled,
	classes: new Map(
		classes.map((c) => [c.key, { stackWithin: c.stack_within === true, combinesWith: new Set(c.combines_with ?? []) }]),
	),
});

/**
 * May deals of class `a` and class `b` apply to the same line?
 * @param {Policy} policy
 * @param {string} a
 * @param {string} b
 */
export const classesCombine = (policy, a, b) => {
	if (!policy.enabled) return false;
	const ca = policy.classes.get(a);
	const cb = policy.classes.get(b);
	if (!ca || !cb) return false;
	if (a === b) return ca.stackWithin;
	return ca.combinesWith.has(b) && cb.combinesWith.has(a);
};

/**
 * Class sets (a lock stands for the classes of the deals it froze): compatible when every pair combines.
 * @param {Policy} policy
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 */
export const classSetsCombine = (policy, a, b) => a.every((x) => b.every((y) => classesCombine(policy, x, y)));
