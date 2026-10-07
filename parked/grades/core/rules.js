/**
 * rules@1 conditions (`applies_when`, `visible_when`): compiled once per source (bounded cache), checked for the
 * dashboard with the context roots of each condition, evaluated with the website's time zone. This is the shared
 * `@ss/rules` language (PLAN F.4); an evaluation error means "did not match".
 * @module
 */
import { check, compile, evaluateCondition } from '@ss/rules';

/** Roots each condition may read. */
export const RULE_ROOTS = Object.freeze({
	tier: Object.freeze(['item']),
	filter: Object.freeze(['tier', 'collection']),
	checklist: Object.freeze(['item', 'unit']),
});

/** Sources kept compiled per process (least recently used dropped first). */
const CACHE_LIMIT = 500;

/** @type {Map<string, ReturnType<typeof compile>>} */
const cache = new Map();

/**
 * Compile a condition (empty / whitespace = always, represented by `null`).
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
 * Dashboard diagnostics of a condition.
 * @param {string} source
 * @param {keyof typeof RULE_ROOTS} kind
 */
export const checkCondition = (source, kind) =>
	typeof source !== 'string' || source.trim() === ''
		? { ok: true, errors: [], warnings: [], paths: [], functions: [] }
		: check(source, { roots: [...RULE_ROOTS[kind]] });

/**
 * @param {string | undefined | null} source
 * @param {Record<string, unknown>} context JSON values and Dates only
 * @param {{ now: number, timeZone: string }} options
 */
export const matches = (source, context, { now, timeZone }) => {
	const compiled = compileCondition(source);
	if (!compiled.ok) return false;
	if (compiled.program === null) return true;
	const result = evaluateCondition(compiled.program, context, { now: new Date(now), timeZone });
	return result.ok && result.value === true;
};
