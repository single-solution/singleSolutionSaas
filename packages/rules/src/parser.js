/**
 * Pratt parser for rules@1. Recursion depth is bounded by `maxDepth` so hostile input cannot overflow the stack.
 *
 * Binding powers (low → high): `?:` 1 (right-assoc) · `or` 2 · `and` 3 · `not` (prefix, operand at 3) ·
 * comparisons 5 (non-associative) · `+ -` 6 · `* / %` 7 · unary `-` (operand at 8) · postfix `. [] ()` 9.
 */

import { ruleError } from './errors.js';
import { tokenize } from './lexer.js';
import { FORBIDDEN_KEYS } from './values.js';
import { FUNCTIONS, checkCall, suggestFunction } from './library.js';

/** @typedef {import('./ast.js').Node} Node */
/** @typedef {import('./lexer.js').Token} Token */
/** @typedef {{ start: number, end: number }} Span */

const CMP = new Set(['==', '!=', '<', '<=', '>', '>=']);

/**
 * @param {Token} t
 * @param {Token} next
 * @returns {number}
 */
function infixPower(t, next) {
	if (t.type === 'op') {
		if (t.value === '?') return 1;
		if (CMP.has(t.value)) return 5;
		if (t.value === '+' || t.value === '-') return 6;
		if (t.value === '*' || t.value === '/' || t.value === '%') return 7;
		if (t.value === '.' || t.value === '[' || t.value === '(') return 9;
		return 0;
	}
	if (t.type === 'kw') {
		if (t.value === 'or') return 2;
		if (t.value === 'and') return 3;
		if (t.value === 'in' || t.value === 'contains') return 5;
		if (t.value === 'not' && next.type === 'kw' && next.value === 'in') return 5;
	}
	return 0;
}

/** @param {Token} t */
function describe(t) {
	if (t.type === 'eof') return 'end of expression';
	if (t.type === 'str') return 'a string';
	return `'${t.value}'`;
}

/**
 * Parse source text into an AST.
 * @param {string} source
 * @param {{ maxDepth: number }} limits
 * @returns {{ ast: Node, spans: WeakMap<object, Span> }} `spans` maps nodes to source ranges (not part of the program).
 */
export function parse(source, limits) {
	const tokens = tokenize(source);
	const last = tokens[tokens.length - 1];
	if (last === undefined) throw ruleError('syntax', 'Expression is empty', 0);
	const EOF = last;
	/** @type {WeakMap<object, Span>} */
	const spans = new WeakMap();
	let pos = 0;
	let depth = 0;
	let lambda = 0;
	let lastEnd = 0;

	const peek = (k = 0) => tokens[pos + k] ?? EOF;
	const advance = () => {
		const t = peek();
		if (t.type !== 'eof') pos++;
		lastEnd = t.end;
		return t;
	};
	/** @param {Token} t @param {string} v */
	const isOp = (t, v) => t.type === 'op' && t.value === v;
	/**
	 * @template {Node} T
	 * @param {T} node
	 * @param {number} start
	 * @returns {T}
	 */
	const mk = (node, start) => {
		spans.set(node, { start, end: lastEnd });
		return node;
	};
	/** @param {Node} node */
	const startOf = (node) => spans.get(node)?.start ?? 0;
	/** @param {string} v @param {string} context */
	const expectOp = (v, context) => {
		const t = peek();
		if (!isOp(t, v)) throw ruleError('syntax', `Expected '${v}' ${context} but found ${describe(t)}`, t.start);
		advance();
	};

	/**
	 * @param {number} minBp
	 * @returns {Node}
	 */
	function parseExpr(minBp) {
		depth++;
		if (depth > limits.maxDepth)
			throw ruleError('too_deep', `Expression is nested too deeply (max depth ${limits.maxDepth})`, peek().start);
		let left = parsePrefix();
		for (;;) {
			const t = peek();
			const bp = infixPower(t, peek(1));
			if (bp <= minBp) break;
			const start = startOf(left);
			if (bp === 1) {
				advance();
				const ifTrue = parseExpr(0);
				expectOp(':', "in 'condition ? then : else'");
				const ifFalse = parseExpr(0);
				left = mk({ type: 'cond', test: left, ifTrue, ifFalse }, start);
			} else if (bp === 9) {
				left = parsePostfix(left, t, start);
			} else if (bp === 2 || bp === 3) {
				advance();
				const op = bp === 2 ? 'or' : 'and';
				const right = parseExpr(bp);
				const args =
					left.type === 'logical' && left.op === op && !parenthesised.has(left) ? [...left.args, right] : [left, right];
				left = mk({ type: 'logical', op, args }, start);
			} else if (bp === 5) {
				advance();
				/** @type {import('./ast.js').BinaryOp} */
				let op = /** @type {import('./ast.js').BinaryOp} */ (t.value);
				if (t.value === 'not') {
					advance();
					op = 'not in';
				}
				const right = parseExpr(5);
				left = mk({ type: 'binary', op, left, right }, start);
				const nt = peek();
				if (infixPower(nt, peek(1)) === 5)
					throw ruleError(
						'syntax',
						`Comparisons cannot be chained; combine them with 'and' (e.g. a < b and b < c)`,
						nt.start,
					);
			} else {
				advance();
				const op = /** @type {'+' | '-' | '*' | '/' | '%'} */ (t.value);
				const right = parseExpr(bp);
				left = mk({ type: 'binary', op, left, right }, start);
			}
		}
		depth--;
		return left;
	}

	/** Logical nodes that came from parentheses are not flattened into a surrounding chain. */
	const parenthesised = new WeakSet();

	/**
	 * @param {Node} left
	 * @param {Token} t
	 * @param {number} start
	 * @returns {Node}
	 */
	function parsePostfix(left, t, start) {
		if (t.value === '(') throw ruleError('syntax', 'Only built-in functions can be called', t.start);
		advance();
		if (t.value === '.') {
			const k = peek();
			if (k.type !== 'ident' && k.type !== 'kw')
				throw ruleError('syntax', `Expected a property name after '.' but found ${describe(k)}`, k.start);
			if (FORBIDDEN_KEYS.has(k.value)) throw ruleError('forbidden_key', `Property '${k.value}' is not accessible`, k.start);
			advance();
			return mk({ type: 'member', object: left, key: k.value }, start);
		}
		const index = parseExpr(0);
		if (index.type === 'literal' && typeof index.value === 'string' && FORBIDDEN_KEYS.has(index.value))
			throw ruleError('forbidden_key', `Property '${index.value}' is not accessible`, startOf(index));
		expectOp(']', 'to close the index');
		return mk({ type: 'index', object: left, index }, start);
	}

	/** @returns {Node} */
	function parsePrefix() {
		const t = peek();
		const start = t.start;
		switch (t.type) {
			case 'num':
				advance();
				return mk({ type: 'literal', value: t.num }, start);
			case 'dur':
				advance();
				return mk({ type: 'duration', ms: t.num }, start);
			case 'date':
				advance();
				return mk({ type: 'date', ms: t.num }, start);
			case 'str':
				advance();
				return mk({ type: 'literal', value: t.value }, start);
			case 'kw':
				if (t.value === 'true' || t.value === 'false' || t.value === 'null') {
					advance();
					return mk({ type: 'literal', value: t.value === 'null' ? null : t.value === 'true' }, start);
				}
				if (t.value === 'not') {
					advance();
					const arg = parseExpr(3);
					return mk({ type: 'unary', op: 'not', arg }, start);
				}
				throw ruleError('syntax', `Unexpected keyword '${t.value}'`, t.start);
			case 'ident':
				return parseIdent(t);
			case 'op':
				if (t.value === '-') {
					advance();
					const arg = parseExpr(8);
					if (arg.type === 'literal' && typeof arg.value === 'number')
						return mk({ type: 'literal', value: arg.value === 0 ? 0 : -arg.value }, start);
					return mk({ type: 'unary', op: '-', arg }, start);
				}
				if (t.value === '(') {
					advance();
					const inner = parseExpr(0);
					expectOp(')', 'to close the parenthesis');
					parenthesised.add(inner);
					return inner;
				}
				if (t.value === '[') {
					advance();
					/** @type {Node[]} */
					const items = [];
					while (!isOp(peek(), ']')) {
						items.push(parseExpr(0));
						if (isOp(peek(), ',')) advance();
						else if (!isOp(peek(), ']'))
							throw ruleError('syntax', `Expected ',' or ']' in list but found ${describe(peek())}`, peek().start);
					}
					advance();
					return mk({ type: 'list', items }, start);
				}
				throw ruleError('syntax', `Unexpected ${describe(t)}`, t.start);
			default:
				throw ruleError('syntax', `Unexpected ${describe(t)}`, t.start);
		}
	}

	/**
	 * @param {Token} t
	 * @returns {Node}
	 */
	function parseIdent(t) {
		advance();
		const name = t.value;
		if (!isOp(peek(), '(')) {
			if (name === 'it' && lambda === 0)
				throw ruleError(
					'reserved',
					"'it' is only available inside any(), all(), filter(), map() and count() predicates",
					t.start,
				);
			return mk({ type: 'ident', name }, t.start);
		}
		const spec = FUNCTIONS.get(name);
		if (spec === undefined) {
			const hint = name === 'now' ? " ('now' is a value, not a function — write now)" : suggestFunction(name);
			const extra = hint === null ? '' : hint.startsWith(' ') ? hint : ` (did you mean ${hint}()?)`;
			throw ruleError('unknown_function', `Unknown function '${name}'${extra}`, t.start);
		}
		advance();
		/** @type {Node[]} */
		const args = [];
		while (!isOp(peek(), ')')) {
			const isLambda = spec.lambda === args.length;
			if (isLambda) lambda++;
			args.push(parseExpr(0));
			if (isLambda) lambda--;
			if (isOp(peek(), ',')) advance();
			else if (!isOp(peek(), ')'))
				throw ruleError('syntax', `Expected ',' or ')' in ${name}() but found ${describe(peek())}`, peek().start);
		}
		advance();
		const problem = checkCall(name, args);
		if (problem !== null) throw ruleError(problem.code, problem.message, t.start);
		return mk({ type: 'call', fn: name, args }, t.start);
	}

	if (EOF === tokens[0]) throw ruleError('empty', 'Expression is empty', 0);
	const ast = parseExpr(0);
	const rest = peek();
	if (rest.type !== 'eof') {
		const hint = rest.type === 'kw' && rest.value === 'not' ? " (did you mean 'not in'?)" : '';
		throw ruleError('syntax', `Unexpected ${describe(rest)}${hint}`, rest.start);
	}
	return { ast, spans };
}
