/**
 * rules@1 conditions of window rules (`when`): compiled once per source (bounded cache), checked for the editor with the
 * context roots this product provides, and evaluated with the website's time zone. This is the shared `@ss/rules`
 * language (PLAN F.4); an evaluation error means "did not match".
 * @module
 */
import { check, compile, evaluateCondition } from '@ss/rules';

/** Identifiers a window condition can read. */
export const RULE_ROOTS = Object.freeze(['line', 'purchase', 'customer']);

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
 * Editor diagnostics for a condition: errors with positions and unknown identifiers as warnings.
 * @param {unknown} source
 */
export const checkCondition = (source) => {
	if (typeof source !== 'string' || source.trim() === '')
		return { ok: true, errors: [], warnings: [], paths: [], functions: [] };
	return check(source, { roots: [...RULE_ROOTS] });
};

/**
 * Evaluate a condition against a window context.
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
