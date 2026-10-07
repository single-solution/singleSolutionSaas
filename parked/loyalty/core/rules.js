/**
 * rules@1 conditions of earn rules (`when`): compiled once per source (bounded cache), checked for the editor with the
 * context roots this product provides, and evaluated with the website's time zone. Merchants never get a private DSL:
 * this is the shared `@ss/rules` language (PLAN F.4). An evaluation error means "did not match".
 * @module
 */
import { check, compile, evaluateCondition } from '@ss/rules';

/** Identifiers an earn-rule condition can read. */
export const RULE_ROOTS = Object.freeze(['event', 'order', 'customer', 'tier']);

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
 * Editor diagnostics for a condition: errors with positions, unknown identifiers as warnings, paths and functions.
 * @param {string} source
 */
export const checkCondition = (source) => {
	if (typeof source !== 'string' || source.trim() === '')
		return { ok: true, errors: [], warnings: [], paths: [], functions: [] };
	return check(source, { roots: [...RULE_ROOTS] });
};

/**
 * Evaluate a condition against an earn context.
 * @param {string | undefined | null} source
 * @param {Record<string, unknown>} context
 * @param {{ now: number, timeZone: string }} options
 * @returns {{ matched: boolean, error: string | null }}
 */
export const conditionMatches = (source, context, { now, timeZone }) => {
	const compiled = compileCondition(source);
	if (!compiled.ok) return { matched: false, error: compiled.error.code };
	if (compiled.program === null) return { matched: true, error: null };
	const result = evaluateCondition(compiled.program, context, { now: new Date(now), timeZone });
	return result.ok ? { matched: result.value === true, error: null } : { matched: false, error: result.error.code };
};
