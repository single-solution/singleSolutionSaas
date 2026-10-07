/**
 * rules@1 availability conditions (`*_available_when` settings): compiled once per source (bounded cache), evaluated
 * with the website's time zone. This is the shared `@ss/rules` language — no private DSL. An empty condition always
 * matches; an evaluation or compile error means "not available".
 * @module
 */
import { check, compile, evaluateCondition } from '@ss/rules';

/** Identifiers a condition can read. */
export const RULE_ROOTS = Object.freeze(['cart', 'customer', 'delivery', 'country', 'payment']);

const CACHE_LIMIT = 200;
/** @type {Map<string, ReturnType<typeof compile>>} */
const cache = new Map();

/** @param {string} source */
const compiled = (source) => {
	const hit = cache.get(source);
	if (hit) return hit;
	const result = compile(source);
	cache.set(source, result);
	if (cache.size > CACHE_LIMIT) cache.delete(/** @type {string} */ (cache.keys().next().value));
	return result;
};

/**
 * @param {string | null | undefined} source
 * @param {Record<string, unknown>} context
 * @param {{ now: number, timeZone: string }} options
 * @returns {boolean}
 */
export const conditionMatches = (source, context, { now, timeZone }) => {
	if (typeof source !== 'string' || source.trim() === '') return true;
	const program = compiled(source);
	if (!program.ok) return false;
	const result = evaluateCondition(program.program, context, { now: new Date(now), timeZone });
	return result.ok && result.value === true;
};

/**
 * Editor diagnostics for a condition (dashboard).
 * @param {string} source
 */
export const checkCondition = (source) =>
	source.trim() === '' ? { ok: true, errors: [], warnings: [] } : check(source, { roots: [...RULE_ROOTS] });
