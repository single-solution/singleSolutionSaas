/**
 * Audience evaluators for placement rules, backed by `@ss/rules` (rules@1). Kept out of the Loader core so websites
 * without audience rules never download the evaluator: the website-bundle compiler imports one of these only when an
 * element declares `placement.audience`, and passes it to `boot({ audience })`.
 *
 * - `evaluateAudienceProgram` — precompiled programs (`{ v: 1, ast }`) only; the compiler compiles at build time.
 * - `evaluateAudience` — also accepts source strings (adds the parser; compiled once and cached).
 *
 * Any compile or evaluation error means "not in the audience".
 * @module
 */
import { compile, evaluateCondition } from '@ss/rules';

/**
 * @param {unknown} program
 * @param {Record<string, unknown>} context
 * @param {{ now: number, timeZone: string }} options
 * @returns {boolean}
 */
export const evaluateAudienceProgram = (program, context, { now, timeZone }) => {
	if (program === null || typeof program !== 'object') return false;
	const result = evaluateCondition(/** @type {any} */ (program), context, { now, timeZone });
	return result.ok && result.value === true;
};

/** @type {Map<string, unknown>} */
const compiled = new Map();

/**
 * @param {unknown} audience rules@1 source text or a program
 * @param {Record<string, unknown>} context
 * @param {{ now: number, timeZone: string }} options
 * @returns {boolean}
 */
export const evaluateAudience = (audience, context, options) => {
	if (typeof audience !== 'string') return evaluateAudienceProgram(audience, context, options);
	if (!compiled.has(audience)) {
		const result = compile(audience);
		compiled.set(audience, result.ok ? result.program : null);
	}
	return evaluateAudienceProgram(compiled.get(audience), context, options);
};
