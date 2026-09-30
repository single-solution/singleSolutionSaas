/**
 * compile / check / static analysis.
 */

import { childrenOf, deepFreeze, staticPath } from './ast.js';
import { positionOf, ruleError, toRuleError } from './errors.js';
import { compileLimits } from './limits.js';
import { FUNCTIONS } from './library.js';
import { parse } from './parser.js';
import { ensureProgram, markValid, validateProgram } from './validate.js';

/** @typedef {import('./ast.js').Node} Node */
/** @typedef {import('./ast.js').Program} Program */
/** @typedef {import('./errors.js').RuleError} RuleError */

/**
 * @typedef {object} CompileOptions
 * @property {number} [version] Grammar version; only 1 exists. Omit for the current version.
 * @property {number} [maxLength] Max source length (default 4000).
 * @property {number} [maxDepth] Max nesting depth (default 64, hard ceiling 256).
 * @property {number} [maxNodes] Max AST nodes (default 2000).
 */

/** @typedef {{ ok: true, program: Program } | { ok: false, error: RuleError }} CompileResult */

/**
 * @param {unknown} source
 * @param {CompileOptions} options
 * @returns {{ program: Program, spans: WeakMap<object, { start: number, end: number }> }}
 */
function compileInternal(source, options) {
	if (typeof source !== 'string') throw ruleError('invalid_source', 'Source must be a string', 0);
	if (options.version !== undefined && options.version !== 1)
		throw ruleError('unsupported_version', `Unsupported rules version ${JSON.stringify(options.version)} (supported: 1)`, 0);
	const limits = compileLimits(options);
	if (source.length > limits.maxLength)
		throw ruleError(
			'too_long',
			`Expression is too long (${source.length} > maxLength ${limits.maxLength} characters)`,
			limits.maxLength,
		);
	const { ast, spans } = parse(source, limits);
	let nodes = 0;
	/**
	 * @param {Node} node
	 * @param {number} depth
	 */
	const measure = (node, depth) => {
		nodes++;
		if (nodes > limits.maxNodes)
			throw ruleError(
				'too_many_nodes',
				`Expression is too large (more than maxNodes ${limits.maxNodes} nodes)`,
				spans.get(node)?.start ?? 0,
			);
		if (depth > limits.maxDepth)
			throw ruleError(
				'too_deep',
				`Expression is nested too deeply (max depth ${limits.maxDepth})`,
				spans.get(node)?.start ?? 0,
			);
		for (const child of childrenOf(node)) measure(child, depth + 1);
	};
	measure(ast, 1);
	/** @type {Program} */
	const program = { v: 1, ast };
	return { program: markValid(deepFreeze(program)), spans };
}

/**
 * Compile rules@1 source into a serialisable program. Never throws.
 * @param {string} source
 * @param {CompileOptions} [options]
 * @returns {CompileResult}
 */
export function compile(source, options = {}) {
	try {
		return { ok: true, program: compileInternal(source, options).program };
	} catch (err) {
		return { ok: false, error: toRuleError(err, typeof source === 'string' ? source : '') };
	}
}

/**
 * @typedef {object} CheckWarning
 * @property {string} code
 * @property {string} message
 * @property {number} line
 * @property {number} column
 * @property {number} offset
 */

/**
 * @typedef {object} CheckResult
 * @property {boolean} ok
 * @property {RuleError[]} errors At most one (the first); positions are 1-based.
 * @property {CheckWarning[]} warnings e.g. identifiers not in `options.roots`.
 * @property {string[]} paths Referenced context paths (see referencedPaths).
 * @property {string[]} functions Functions used, sorted.
 */

/**
 * Editor support: compile and report errors, warnings, referenced paths and functions used.
 * @param {string} source
 * @param {CompileOptions & { roots?: string[] }} [options] `roots`: identifiers the context provides (enables warnings).
 * @returns {CheckResult}
 */
export function check(source, options = {}) {
	try {
		const { program, spans } = compileInternal(source, options);
		/** @type {CheckWarning[]} */
		const warnings = [];
		const roots = options.roots === undefined ? null : new Set(options.roots);
		if (roots !== null) {
			/** @param {Node} node */
			const walk = (node) => {
				if (node.type === 'ident' && node.name !== 'it' && node.name !== 'now' && !roots.has(node.name)) {
					const offset = spans.get(node)?.start ?? 0;
					warnings.push({
						code: 'unknown_identifier',
						message: `Unknown identifier '${node.name}' (available: ${[...roots].join(', ') || 'none'})`,
						offset,
						...positionOf(source, offset),
					});
				}
				for (const c of childrenOf(node)) walk(c);
			};
			walk(program.ast);
		}
		return { ok: true, errors: [], warnings, paths: referencedPaths(program), functions: functionsUsed(program) };
	} catch (err) {
		return {
			ok: false,
			errors: [toRuleError(err, typeof source === 'string' ? source : '')],
			warnings: [],
			paths: [],
			functions: [],
		};
	}
}

const FIELD_FNS = new Set(['sum', 'avg', 'min', 'max']);

/**
 * Context paths a program reads, sorted and de-duplicated. Paths inside predicates are expressed relative to the
 * iterated list with `[]`: `any(order.lines, it.price > 5)` → `order.lines`, `order.lines[].price`. Literal field
 * arguments count too: `sum(order.lines, 'qty')` → `order.lines[].qty`. `now` is built in and not listed.
 * @param {Program} program
 * @returns {string[]}
 */
export function referencedPaths(program) {
	const checked = ensureProgram(program);
	if (!checked.ok) return [];
	/** @type {Set<string>} */
	const out = new Set();
	/**
	 * @param {Node} node
	 * @param {string | null} itPath
	 */
	const walk = (node, itPath) => {
		if (node.type === 'ident' || node.type === 'member' || node.type === 'index') {
			const p = staticPath(node, itPath);
			if (p !== null) {
				if (p !== 'now') out.add(p);
				/** @type {Node} */
				let n = node;
				while (n.type === 'member' || n.type === 'index') {
					if (n.type === 'index' && n.index.type !== 'literal') walk(n.index, itPath);
					n = n.object;
				}
				return;
			}
		}
		if (node.type === 'call') {
			const spec = FUNCTIONS.get(node.fn);
			const [a0, a1] = node.args;
			const base = a0 === undefined ? null : staticPath(a0, itPath);
			node.args.forEach((arg, i) => walk(arg, spec?.lambda === i ? (base === null ? null : `${base}[]`) : itPath));
			if (FIELD_FNS.has(node.fn) && base !== null && a1 !== undefined && a1.type === 'literal' && typeof a1.value === 'string')
				out.add(`${base}[].${a1.value}`);
			return;
		}
		for (const c of childrenOf(node)) walk(c, itPath);
	};
	walk(checked.program.ast, null);
	return [...out].sort();
}

/**
 * Names of the functions a program calls, sorted.
 * @param {Program} program
 * @returns {string[]}
 */
export function functionsUsed(program) {
	const checked = ensureProgram(program);
	if (!checked.ok) return [];
	/** @type {Set<string>} */
	const out = new Set();
	/** @param {Node} node */
	const walk = (node) => {
		if (node.type === 'call') out.add(node.fn);
		for (const c of childrenOf(node)) walk(c);
	};
	walk(checked.program.ast);
	return [...out].sort();
}

/**
 * Serialise a program to JSON text.
 * @param {Program} program
 * @returns {string}
 */
export function serialize(program) {
	return JSON.stringify(program);
}

/**
 * Parse and fully validate a serialised program (JSON text or an already-parsed object).
 * @param {string | unknown} input
 * @param {{ maxDepth?: number, maxNodes?: number }} [options]
 * @returns {CompileResult}
 */
export function deserialize(input, options) {
	/** @type {unknown} */
	let value = input;
	if (typeof input === 'string') {
		try {
			value = JSON.parse(input);
		} catch {
			return { ok: false, error: { code: 'invalid_program', message: 'Program is not valid JSON' } };
		}
	}
	return validateProgram(value, options);
}
