/**
 * rules@1 conditions on deals (`scope.when` per line, `conditions.when` per cart): compiled once per source (bounded
 * cache), checked for editors with the roots this product provides, evaluated with the website's time zone. Merchants
 * never get a private DSL — this is the shared `@ss/rules` language (PLAN F.4). An evaluation error means "did not
 * match".
 * @module
 */
import { check, compile, evaluateCondition } from '@ss/rules';

/** Identifiers a deal condition can read: `item` (line conditions only), `cart`, `customer`, `now`. */
export const RULE_ROOTS = Object.freeze(['item', 'cart', 'customer']);

/** Sources kept compiled per process (least recently used are dropped first). */
const CACHE_LIMIT = 500;

/** @type {Map<string, ReturnType<typeof compile>>} */
const cache = new Map();

/**
 * Compile a condition (empty / whitespace = always true, represented by `null`).
 * @param {string | undefined | null} source
 * @returns {{ ok: true, program: import('@ss/rules').Program | null } | { ok: false, error: import('@ss/rules').RuleError }}
 */
export const compileCondition = (source) => {
	if (typeof source !== 'string' || source.trim() === '') return { ok: true, program: null };
	const hit = cache.get(source);
	if (hit) {
		cache.delete(source);
		cache.set(source, hit);
		return hit;
	}
	const result = compile(source);
	cache.set(source, result);
	if (cache.size > CACHE_LIMIT) cache.delete(/** @type {string} */ (cache.keys().next().value));
	return result;
};

/**
 * Editor diagnostics: errors with positions, unknown identifiers as warnings, paths and functions.
 * @param {string} source
 */
export const checkCondition = (source) => {
	if (typeof source !== 'string' || source.trim() === '')
		return { ok: true, errors: [], warnings: [], paths: [], functions: [] };
	return check(source, { roots: [...RULE_ROOTS] });
};

/**
 * Evaluate a condition.
 * @param {string | undefined | null} source
 * @param {Record<string, unknown>} context
 * @param {{ now: number, timeZone: string }} options
 * @returns {boolean}
 */
export const conditionMatches = (source, context, { now, timeZone }) => {
	const compiled = compileCondition(source);
	if (!compiled.ok) return false;
	if (compiled.program === null) return true;
	const result = evaluateCondition(compiled.program, context, { now: new Date(now), timeZone });
	return result.ok && result.value === true;
};
