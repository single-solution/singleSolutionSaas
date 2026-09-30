/**
 * Structural validation of programs that did not come straight from `compile()` (e.g. loaded from a database or sent
 * by a visual builder). Validation re-applies every compile-time rule: node shapes, operators, identifiers, forbidden
 * keys, function names/arity/literal arguments, `it` scoping, depth and node limits.
 */

import { BINARY_OPS, deepFreeze, isIdentifierName } from './ast.js';
import { KEYWORDS } from './lexer.js';
import { checkCall, FUNCTIONS } from './library.js';
import { compileLimits } from './limits.js';
import { MAX_DATE_MS, MIN_DATE_MS } from './time.js';
import { FORBIDDEN_KEYS } from './values.js';

/** @typedef {import('./ast.js').Node} Node */
/** @typedef {import('./ast.js').Program} Program */
/** @typedef {import('./errors.js').RuleError} RuleError */

/** Programs known to be valid (produced by compile() or already validated). */
const VALID = new WeakSet();

/**
 * @param {Program} program
 * @returns {Program}
 */
export function markValid(program) {
	VALID.add(program);
	return program;
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
	throw Object.assign(new Error(message), { code: 'invalid_program' });
}

/**
 * Validate an unknown value as a rules@1 program. Returns a new, frozen, validated program (input is not mutated).
 * @param {unknown} input
 * @param {{ maxDepth?: number, maxNodes?: number }} [options]
 * @returns {{ ok: true, program: Program } | { ok: false, error: RuleError }}
 */
export function validateProgram(input, options = {}) {
	const limits = compileLimits(options);
	if (!isObj(input)) return { ok: false, error: { code: 'invalid_program', message: 'Program must be an object { v, ast }' } };
	if (input.v !== 1)
		return {
			ok: false,
			error: {
				code: 'unsupported_version',
				message: `Unsupported rules version ${JSON.stringify(input.v)} (this evaluator supports 1)`,
			},
		};
	let nodes = 0;
	let lambda = 0;

	/**
	 * @param {unknown} raw
	 * @param {number} depth
	 * @returns {Node}
	 */
	function node(raw, depth) {
		if (depth > limits.maxDepth) {
			throw Object.assign(new Error(`Program is nested too deeply (max depth ${limits.maxDepth})`), { code: 'too_deep' });
		}
		if (++nodes > limits.maxNodes) {
			throw Object.assign(new Error(`Program has too many nodes (max ${limits.maxNodes})`), { code: 'too_many_nodes' });
		}
		if (!isObj(raw)) return fail('AST node must be an object');
		const d = depth + 1;
		/** @param {unknown} v */
		const list = (v) => (Array.isArray(v) ? v.map((x) => node(x, d)) : fail('Expected an array of nodes'));
		switch (raw.type) {
			case 'literal': {
				const v = raw.value;
				if (!(v === null || typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))))
					return fail('Invalid literal');
				return { type: 'literal', value: v };
			}
			case 'duration':
				if (typeof raw.ms !== 'number' || !Number.isFinite(raw.ms)) return fail('Invalid duration');
				return { type: 'duration', ms: raw.ms };
			case 'date':
				if (typeof raw.ms !== 'number' || !(raw.ms >= MIN_DATE_MS && raw.ms <= MAX_DATE_MS)) return fail('Invalid date');
				return { type: 'date', ms: raw.ms };
			case 'list':
				return { type: 'list', items: list(raw.items) };
			case 'ident': {
				const name = raw.name;
				if (typeof name !== 'string' || !isIdentifierName(name) || KEYWORDS.has(name)) return fail('Invalid identifier');
				if (FORBIDDEN_KEYS.has(name)) return fail(`Identifier '${name}' is not accessible`);
				if (name === 'it' && lambda === 0) return fail("'it' used outside a predicate");
				return { type: 'ident', name };
			}
			case 'member': {
				const key = raw.key;
				if (typeof key !== 'string' || !isIdentifierName(key) || FORBIDDEN_KEYS.has(key))
					return fail('Invalid property key (use an index node for non-identifier keys)');
				return { type: 'member', object: node(raw.object, d), key };
			}
			case 'index': {
				const object = node(raw.object, d);
				const index = node(raw.index, d);
				if (index.type === 'literal' && typeof index.value === 'string' && FORBIDDEN_KEYS.has(index.value))
					return fail('Invalid property key');
				return { type: 'index', object, index };
			}
			case 'unary':
				if (raw.op !== 'not' && raw.op !== '-') return fail('Invalid unary operator');
				return { type: 'unary', op: raw.op, arg: node(raw.arg, d) };
			case 'binary': {
				const op = raw.op;
				if (typeof op !== 'string' || !BINARY_OPS.has(op)) return fail('Invalid binary operator');
				return {
					type: 'binary',
					op: /** @type {import('./ast.js').BinaryOp} */ (op),
					left: node(raw.left, d),
					right: node(raw.right, d),
				};
			}
			case 'logical': {
				if (raw.op !== 'and' && raw.op !== 'or') return fail('Invalid logical operator');
				const args = list(raw.args);
				if (args.length < 2) return fail('Logical node needs at least two operands');
				return { type: 'logical', op: raw.op, args };
			}
			case 'cond':
				return { type: 'cond', test: node(raw.test, d), ifTrue: node(raw.ifTrue, d), ifFalse: node(raw.ifFalse, d) };
			case 'call': {
				const fn = raw.fn;
				if (typeof fn !== 'string' || !FUNCTIONS.has(fn)) return fail(`Unknown function ${JSON.stringify(fn)}`);
				const spec = FUNCTIONS.get(fn);
				if (!Array.isArray(raw.args)) return fail('Expected an array of nodes');
				const args = raw.args.map((a, i) => {
					const isLambda = spec?.lambda === i;
					if (isLambda) lambda++;
					const n = node(a, d);
					if (isLambda) lambda--;
					return n;
				});
				const problem = checkCall(fn, args);
				if (problem !== null) return fail(problem.message);
				return { type: 'call', fn, args };
			}
			default:
				return fail(`Unknown node type ${JSON.stringify(raw.type)}`);
		}
	}

	try {
		/** @type {Program} */
		const program = deepFreeze({ v: 1, ast: node(input.ast, 1) });
		return { ok: true, program: markValid(program) };
	} catch (err) {
		const code = err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : 'invalid_program';
		return { ok: false, error: { code, message: err instanceof Error ? err.message : 'Invalid program' } };
	}
}

/**
 * Return a program that is safe to evaluate: the input itself when already known-valid, else a validated copy.
 * @param {unknown} program
 * @returns {{ ok: true, program: Program } | { ok: false, error: RuleError }}
 */
export function ensureProgram(program) {
	if (typeof program !== 'object' || program === null) return validateProgram(program);
	if (VALID.has(program)) return { ok: true, program: /** @type {Program} */ (program) };
	const cached = COPIES.get(program);
	if (cached !== undefined) return { ok: true, program: cached };
	const r = validateProgram(program);
	if (r.ok) COPIES.set(program, r.program);
	return r;
}

/** Validated copies of foreign program objects (a later mutation of the original cannot affect the copy). */
const COPIES = new WeakMap();
