/**
 * rules@1 conditions of a configurator (PLAN F.4): group `when` (the group applies only when true), option `when` (the
 * option is available only when true), exclusion rules (`when` true = the combination is not allowed) and price rules.
 * A condition reads `selection.<group key>` (a string for single choice, a list for multi choice, a number for range,
 * a string for text; `null` when empty) and `quantity`. Merchants never get a private DSL; an evaluation error means
 * "did not match". Pure: no caches, no clock (callers pass `now`).
 * @module
 */
import { check, compile, evaluateCondition, referencedPaths } from '@ss/rules';

/** Identifiers a configurator condition can read. */
export const RULE_ROOTS = Object.freeze(['selection', 'quantity']);

/**
 * @typedef {object} Condition a compiled condition
 * @property {import('@ss/rules').Program} program
 * @property {string[] | null} groups group keys it reads (`null` = the whole selection)
 */

/**
 * Group keys a program reads, from its context paths (`selection.color`, `selection.addons[]`). `null` when it reads
 * the selection as a whole (`len(selection)`) or through a computed index.
 * @param {import('@ss/rules').Program} program
 * @returns {{ ok: true, groups: string[] | null } | { ok: false, path: string }}
 */
const groupsRead = (program) => {
	/** @type {Set<string>} */
	const groups = new Set();
	let all = false;
	for (const path of referencedPaths(program)) {
		const [root, ...rest] = path.split('.');
		const head = (root ?? '').replace(/\[\]$/, '');
		if (head === 'quantity') continue;
		if (head !== 'selection') return { ok: false, path };
		const key = (rest[0] ?? '').replace(/\[\]$/, '');
		if (key === '' || root !== 'selection') all = true;
		else groups.add(key);
	}
	return { ok: true, groups: all ? null : [...groups].sort() };
};

/**
 * Compile a condition. Empty / whitespace = no condition (`condition: null`).
 * @param {unknown} source
 * @returns {{ ok: true, condition: Condition | null }
 *   | { ok: false, error: { code: string, message: string, line?: number, column?: number } }}
 */
export const compileCondition = (source) => {
	if (source === undefined || source === null || (typeof source === 'string' && source.trim() === ''))
		return { ok: true, condition: null };
	if (typeof source !== 'string') return { ok: false, error: { code: 'type', message: 'must be a string' } };
	const compiled = compile(source);
	if (!compiled.ok) return { ok: false, error: compiled.error };
	const read = groupsRead(compiled.program);
	if (!read.ok)
		return {
			ok: false,
			error: { code: 'unknown_identifier', message: `'${read.path}' is not readable (use selection.<group> or quantity)` },
		};
	return { ok: true, condition: { program: compiled.program, groups: read.groups } };
};

/**
 * Editor diagnostics: errors with positions, unknown identifiers as warnings, the paths and functions used.
 * @param {string} source
 */
export const checkCondition = (source) => {
	if (typeof source !== 'string' || source.trim() === '')
		return { ok: true, errors: [], warnings: [], paths: [], functions: [] };
	return check(source, { roots: [...RULE_ROOTS] });
};

/**
 * Evaluate a compiled condition; an evaluation error is "no match".
 * @param {Condition} condition
 * @param {Record<string, unknown>} context `{ selection, quantity }`
 * @param {{ now: number, timeZone?: string }} options
 * @returns {boolean}
 */
export const holds = (condition, context, { now, timeZone = 'UTC' }) => {
	const result = evaluateCondition(condition.program, context, { now: new Date(now), timeZone });
	return result.ok && result.value === true;
};
