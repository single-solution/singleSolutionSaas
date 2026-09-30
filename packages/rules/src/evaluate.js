/**
 * Tree-walking evaluator. Pure: reads the context (own data properties only), never mutates it, never calls into it.
 * Time-boxed by a deterministic step counter; every limit surfaces as `{ ok: false, error }` — evaluate never throws.
 */

import { staticPath } from './ast.js';
import { ruleError, toRuleError } from './errors.js';
import { format } from './format.js';
import { callEager } from './library.js';
import { DEFAULT_LIMITS, limit } from './limits.js';
import { isValidTimeZone } from './time.js';
import { ensureProgram } from './validate.js';
import {
	compareValues,
	deepEqual,
	isDate,
	isList,
	isMap,
	isNull,
	isNum,
	isStr,
	itemAt,
	kindOf,
	readIndex,
	readKey,
	toMs,
	truthy,
} from './values.js';

/** @typedef {import('./ast.js').Node} Node */
/** @typedef {import('./ast.js').Program} Program */
/** @typedef {import('./errors.js').RuleError} RuleError */

/**
 * @typedef {object} EvaluateOptions
 * @property {number} [maxSteps] Step budget (default 10000).
 * @property {Date | number | string} [now] The instant `now` denotes (default: context.now, else the real clock).
 * @property {string} [timeZone] Default IANA zone for dateParts()/between() when none is given (default 'UTC').
 * @property {number} [maxListLength] Cap on produced lists (default 1000).
 * @property {number} [maxStringLength] Cap on produced strings (default 10000).
 */

/**
 * @typedef {object} TraceFrame
 * @property {string} node AST node type.
 * @property {string} expr Canonical source of the sub-expression.
 * @property {unknown} value Its value (undefined only for skipped frames).
 * @property {TraceFrame[]} children
 * @property {boolean} [skipped] Not evaluated because of short-circuiting.
 */

/** @typedef {{ ok: true, value: unknown } | { ok: false, error: RuleError }} EvaluateResult */

const MAX_TRACE_FRAMES = 2000;

/**
 * @param {unknown} context
 * @param {EvaluateOptions} options
 * @param {boolean} tracing
 */
function createRuntime(context, options, tracing) {
	const maxSteps = limit(options.maxSteps, DEFAULT_LIMITS.maxSteps);
	const maxList = limit(options.maxListLength, DEFAULT_LIMITS.maxListLength);
	const maxString = limit(options.maxStringLength, DEFAULT_LIMITS.maxStringLength);
	const timeZone = options.timeZone === undefined ? 'UTC' : options.timeZone;
	if (!isValidTimeZone(timeZone)) throw ruleError('invalid_option', `Unknown time zone ${JSON.stringify(timeZone)}`);
	const nowMs = toMs(options.now ?? readKey(context, 'now')) ?? Date.now();
	const nowDate = new Date(nowMs);
	let steps = 0;

	/** @param {number} n */
	const tick = (n) => {
		steps += n;
		if (steps > maxSteps) throw ruleError('max_steps', `Evaluation exceeded the step budget (maxSteps ${maxSteps})`);
	};
	/** @param {unknown[]} list */
	const capList = (list) => {
		if (list.length > maxList) throw ruleError('list_too_long', `List result exceeds ${maxList} items (maxListLength)`);
		return list;
	};
	/** @param {string} s */
	const capString = (s) => {
		if (s.length > maxString)
			throw ruleError('string_too_long', `String result exceeds ${maxString} characters (maxStringLength)`);
		return s;
	};
	/** @type {import('./library.js').Runtime} */
	const rt = { tick, nowMs, timeZone, context, capList };

	/** @type {TraceFrame} */
	const root = { node: 'root', expr: '', value: null, children: [] };
	let current = root;
	let frames = 0;
	let quiet = 0;

	/** @param {Node} node */
	const skip = (node) => {
		if (tracing && frames < MAX_TRACE_FRAMES) {
			frames++;
			current.children.push({ node: node.type, expr: format(node), value: undefined, children: [], skipped: true });
		}
	};

	/**
	 * @param {Node} node
	 * @param {{ it: unknown } | null} scope
	 * @returns {unknown}
	 */
	function ev(node, scope) {
		tick(1);
		if (!tracing || quiet > 0 || frames >= MAX_TRACE_FRAMES) return evalNode(node, scope);
		frames++;
		/** @type {TraceFrame} */
		const frame = { node: node.type, expr: format(node), value: null, children: [] };
		const parent = current;
		parent.children.push(frame);
		current = frame;
		// A static path (order.lines[0].price) is one frame: its prefixes would only repeat the context.
		const isPath =
			(node.type === 'member' || node.type === 'index' || node.type === 'ident') && staticPath(node, 'it') !== null;
		if (isPath) quiet++;
		try {
			const value = evalNode(node, scope);
			frame.value = value;
			return value;
		} finally {
			if (isPath) quiet--;
			current = parent;
		}
	}

	/**
	 * @param {Node} node
	 * @param {{ it: unknown } | null} scope
	 * @returns {unknown}
	 */
	function evalNode(node, scope) {
		switch (node.type) {
			case 'literal':
				return node.value;
			case 'duration':
				return node.ms;
			case 'date':
				return new Date(node.ms);
			case 'list':
				capList(node.items);
				return node.items.map((n) => ev(n, scope));
			case 'ident':
				if (node.name === 'it') return scope === null ? null : scope.it;
				if (node.name === 'now') return nowDate;
				return readKey(context, node.name);
			case 'member':
				return readKey(ev(node.object, scope), node.key);
			case 'index': {
				const obj = ev(node.object, scope);
				return readIndex(obj, ev(node.index, scope));
			}
			case 'unary': {
				const v = ev(node.arg, scope);
				if (node.op === 'not') return !truthy(v);
				return isNum(v) ? (v === 0 ? 0 : -v) : null;
			}
			case 'logical': {
				const want = node.op === 'or';
				for (let i = 0; i < node.args.length; i++) {
					const arg = node.args[i];
					if (arg === undefined) continue;
					if (truthy(ev(arg, scope)) === want) {
						for (const rest of node.args.slice(i + 1)) skip(rest);
						return want;
					}
				}
				return !want;
			}
			case 'cond':
				if (truthy(ev(node.test, scope))) {
					const v = ev(node.ifTrue, scope);
					skip(node.ifFalse);
					return v;
				}
				skip(node.ifTrue);
				return ev(node.ifFalse, scope);
			case 'binary':
				return binary(node.op, ev(node.left, scope), ev(node.right, scope));
			case 'call':
				return call(node, scope);
			default:
				throw ruleError('invalid_program', 'Unknown node type');
		}
	}

	/**
	 * @param {import('./ast.js').BinaryOp} op
	 * @param {unknown} l
	 * @param {unknown} r
	 * @returns {unknown}
	 */
	function binary(op, l, r) {
		switch (op) {
			case '==':
				return deepEqual(l, r, tick);
			case '!=':
				return !deepEqual(l, r, tick);
			case '<':
			case '<=':
			case '>':
			case '>=': {
				const c = compareValues(l, r);
				if (c === null) return false;
				return op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0;
			}
			case 'in':
				return member(l, r);
			case 'not in':
				return !member(l, r);
			case 'contains':
				return member(r, l);
			case '+':
				return add(l, r);
			case '-':
				return subtract(l, r);
			default:
				return arithmetic(op, l, r);
		}
	}

	/**
	 * `x in collection`.
	 * @param {unknown} x
	 * @param {unknown} coll
	 * @returns {boolean}
	 */
	function member(x, coll) {
		if (isList(coll)) {
			for (let i = 0; i < coll.length; i++) if (deepEqual(x, itemAt(coll, i), tick)) return true;
			return false;
		}
		if (isStr(coll)) {
			if (!isStr(x)) return false;
			tick(1 + Math.ceil(coll.length / 256));
			return coll.includes(x);
		}
		if (isMap(coll)) return isStr(x) && readKey(coll, x) !== null;
		return false;
	}

	/**
	 * @param {unknown} l
	 * @param {unknown} r
	 * @returns {unknown}
	 */
	function add(l, r) {
		if (isNull(l) || isNull(r)) return null;
		if (isNum(l) && isNum(r)) return finite(l + r);
		if (isStr(l) || isStr(r)) {
			const a = textOf(l);
			const b = textOf(r);
			if (a === null || b === null) return null;
			tick(1 + Math.ceil((a.length + b.length) / 256));
			return capString(a + b);
		}
		if (isList(l) && isList(r)) {
			tick(1 + l.length + r.length);
			return capList([...l, ...r]);
		}
		if (isDate(l) && isNum(r)) return dateOf(l.getTime() + r);
		if (isNum(l) && isDate(r)) return dateOf(l + r.getTime());
		return null;
	}

	/**
	 * @param {unknown} l
	 * @param {unknown} r
	 * @returns {unknown}
	 */
	function subtract(l, r) {
		if (isNull(l) || isNull(r)) return null;
		if (isNum(l) && isNum(r)) return finite(l - r);
		if (isDate(l) && isNum(r)) return dateOf(l.getTime() - r);
		if (isDate(l) || isDate(r)) {
			const a = toMs(l);
			const b = toMs(r);
			return a === null || b === null ? null : finite(a - b);
		}
		return null;
	}

	/**
	 * @param {import('./ast.js').BinaryOp} op
	 * @param {unknown} l
	 * @param {unknown} r
	 * @returns {number | null}
	 */
	function arithmetic(op, l, r) {
		if (!isNum(l) || !isNum(r)) return null;
		if (op === '*') return finite(l * r);
		if (r === 0) return null;
		return finite(op === '/' ? l / r : l % r);
	}

	/**
	 * @param {import('./ast.js').CallNode} node
	 * @param {{ it: unknown } | null} scope
	 * @returns {unknown}
	 */
	function call(node, scope) {
		const { fn, args } = node;
		const [a0, a1] = args;
		switch (fn) {
			case 'has':
				return a0 !== undefined && !isNull(ev(a0, scope));
			case 'coalesce':
				for (let i = 0; i < args.length; i++) {
					const a = args[i];
					const v = a === undefined ? null : ev(a, scope);
					if (!isNull(v)) {
						for (const rest of args.slice(i + 1)) skip(rest);
						return v;
					}
				}
				return null;
			case 'any':
			case 'all':
			case 'filter':
			case 'map':
				if (a0 === undefined || a1 === undefined) throw ruleError('invalid_program', `${fn}() needs two arguments`);
				return iterate(fn, ev(a0, scope), a1);
			case 'count':
				if (a0 !== undefined && a1 !== undefined) return iterate(fn, ev(a0, scope), a1);
				if (a0 === undefined) throw ruleError('invalid_program', 'count() needs an argument');
				{
					const v = ev(a0, scope);
					return isList(v) ? v.length : null;
				}
			default:
				return callEager(
					fn,
					args.map((a) => ev(a, scope)),
					rt,
				);
		}
	}

	/**
	 * any / all / filter / map / count(list, predicate) with `it` bound to each item.
	 * @param {string} fn
	 * @param {unknown} list
	 * @param {Node} body
	 * @returns {unknown}
	 */
	function iterate(fn, list, body) {
		if (!isList(list)) return fn === 'any' || fn === 'all' ? false : null;
		/** @type {unknown[]} */
		const out = [];
		let n = 0;
		for (let i = 0; i < list.length; i++) {
			tick(1);
			const item = itemAt(list, i);
			const v = ev(body, { it: item });
			if (fn === 'map') out.push(v);
			else if (truthy(v)) {
				if (fn === 'any') return true;
				if (fn === 'filter') out.push(item);
				n++;
			} else if (fn === 'all') return false;
			if (out.length > maxList) capList(out);
		}
		if (fn === 'any') return false;
		if (fn === 'all') return true;
		if (fn === 'count') return n;
		return out;
	}

	return {
		/** @param {Node} ast */
		run: (ast) => ev(ast, null),
		trace: () => root.children[0] ?? root,
		steps: () => steps,
	};
}

/** @param {number} n */
const finite = (n) => (Number.isFinite(n) ? (n === 0 ? 0 : n) : null);

/** @param {number} ms */
const dateOf = (ms) => (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms) : null);

/**
 * Text form used by `+` concatenation: strings, numbers, booleans and dates (ISO); anything else → null.
 * @param {unknown} v
 * @returns {string | null}
 */
function textOf(v) {
	switch (kindOf(v)) {
		case 'string':
			return /** @type {string} */ (v);
		case 'number':
		case 'boolean':
			return String(v);
		case 'date':
			return /** @type {Date} */ (v).toISOString();
		default:
			return null;
	}
}

/**
 * Evaluate a compiled program against a context.
 * @param {Program} program From `compile()` or `deserialize()` (anything else is validated first).
 * @param {unknown} [context] Plain data; `context.segments` feeds inSegment().
 * @param {EvaluateOptions} [options]
 * @returns {EvaluateResult}
 */
export function evaluate(program, context = {}, options = {}) {
	try {
		const checked = ensureProgram(program);
		if (!checked.ok) return checked;
		const runtime = createRuntime(context, options, false);
		return { ok: true, value: runtime.run(checked.program.ast) };
	} catch (err) {
		return { ok: false, error: toRuleError(err) };
	}
}

/**
 * Evaluate a program as a condition: `value` is true exactly when the result is truthy.
 * An evaluation error yields `{ ok: false }` — callers should treat that as "did not match".
 * @param {Program} program
 * @param {unknown} [context]
 * @param {EvaluateOptions} [options]
 * @returns {{ ok: true, value: boolean } | { ok: false, error: RuleError }}
 */
export function evaluateCondition(program, context, options) {
	const r = evaluate(program, context, options);
	return r.ok ? { ok: true, value: truthy(r.value) } : r;
}

/**
 * Evaluate with a full trace tree for "why did this match?" UIs. Each frame carries the canonical source of the
 * sub-expression and its value; short-circuited operands appear with `skipped: true`. Traces are capped at 2000 frames.
 * @param {Program} program
 * @param {unknown} [context]
 * @param {EvaluateOptions} [options]
 * @returns {({ ok: true, value: unknown } | { ok: false, error: RuleError }) & { trace: TraceFrame | null, steps: number }}
 */
export function explain(program, context = {}, options = {}) {
	/** @type {ReturnType<typeof createRuntime> | null} */
	let runtime = null;
	try {
		const checked = ensureProgram(program);
		if (!checked.ok) return { ...checked, trace: null, steps: 0 };
		runtime = createRuntime(context, options, true);
		const value = runtime.run(checked.program.ast);
		return { ok: true, value, trace: runtime.trace(), steps: runtime.steps() };
	} catch (err) {
		return {
			ok: false,
			error: toRuleError(err),
			trace: runtime === null ? null : runtime.trace(),
			steps: runtime === null ? 0 : runtime.steps(),
		};
	}
}
