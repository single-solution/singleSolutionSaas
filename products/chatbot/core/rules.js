/**
 * rules@1 conditions (handoff, flows, assignment, proactive, AI forbidden topics stay plain text): compiled once per
 * source (bounded LRU), checked for editors with the roots each use provides, evaluated with the website's zone.
 * Merchants never get a private DSL (PLAN F.4). An evaluation error means "did not match".
 * @module
 */
import { check, compile, evaluateCondition } from '@ss/rules';

/** Context roots per use. */
export const RULE_ROOTS = Object.freeze({
	handoff: ['message', 'conversation', 'customer', 'ai'],
	flow: ['vars', 'message', 'conversation', 'customer', 'page'],
	assignment: ['conversation', 'customer', 'message'],
	proactive: ['page', 'visitor', 'cart'],
});

const CACHE_LIMIT = 500;
/** @type {Map<string, ReturnType<typeof compile>>} */
const cache = new Map();

/**
 * Compile (empty source = always true → `program: null`).
 * @param {string | undefined | null} source
 */
export const compileCondition = (source) => {
	if (typeof source !== 'string' || source.trim() === '') return /** @type {const} */ ({ ok: true, program: null });
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
 * Editor diagnostics.
 * @param {string} source
 * @param {keyof typeof RULE_ROOTS} use
 */
export const checkCondition = (source, use) => {
	if (typeof source !== 'string' || source.trim() === '')
		return { ok: true, errors: [], warnings: [], paths: [], functions: [] };
	return check(source, { roots: [...RULE_ROOTS[use]] });
};

/**
 * Evaluate a condition. Empty = `whenEmpty` (true by default).
 * @param {string | undefined | null} source
 * @param {Record<string, unknown>} context JSON + Date only
 * @param {{ now: number, timeZone: string, whenEmpty?: boolean }} options
 * @returns {{ matched: boolean, error: string | null }}
 */
export const conditionMatches = (source, context, { now, timeZone, whenEmpty = true }) => {
	const compiled = compileCondition(source);
	if (!compiled.ok) return { matched: false, error: compiled.error.code };
	if (compiled.program === null) return { matched: whenEmpty, error: null };
	const result = evaluateCondition(compiled.program, context, { now: new Date(now), timeZone });
	return result.ok ? { matched: result.value === true, error: null } : { matched: false, error: result.error.code };
};
