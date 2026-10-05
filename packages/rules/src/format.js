/**
 * Canonical printer: AST → rules@1 source with minimal parentheses. `compile(format(p)).program` deep-equals `p`
 * for every program produced by `compile`. Used for the code view of visual builders and for `explain()` traces.
 */

import { DURATION_UNITS } from './lexer.js';
import { formatDateLiteral } from './time.js';

/** @typedef {import('./ast.js').Node} Node */

const PREC = /** @type {const} */ ({ cond: 1, or: 2, and: 3, not: 4, cmp: 5, add: 6, mul: 7, neg: 8, postfix: 9 });

/** @param {import('./ast.js').BinaryOp} op */
function binaryPrec(op) {
	if (op === '+' || op === '-') return PREC.add;
	if (op === '*' || op === '/' || op === '%') return PREC.mul;
	return PREC.cmp;
}

/**
 * @param {Node} node
 * @returns {number}
 */
function precOf(node) {
	switch (node.type) {
		case 'cond':
			return PREC.cond;
		case 'logical':
			return node.op === 'or' ? PREC.or : PREC.and;
		case 'unary':
			return node.op === 'not' ? PREC.not : PREC.neg;
		case 'binary':
			return binaryPrec(node.op);
		case 'literal':
			return typeof node.value === 'number' && (node.value < 0 || Object.is(node.value, -0)) ? PREC.neg : PREC.postfix;
		default:
			return PREC.postfix;
	}
}

/**
 * Quote a string with single quotes; escapes keep the output ASCII-safe for control and surrogate code units.
 * @param {string} s
 * @returns {string}
 */
export function quote(s) {
	let out = "'";
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		const ch = s.charAt(i);
		if (ch === "'") out += "\\'";
		else if (ch === '\\') out += '\\\\';
		else if (ch === '\n') out += '\\n';
		else if (ch === '\r') out += '\\r';
		else if (ch === '\t') out += '\\t';
		else if (c < 0x20 || c === 0x7f || (c >= 0xd800 && c <= 0xdfff)) out += `\\u${c.toString(16).padStart(4, '0')}`;
		else out += ch;
	}
	return `${out}'`;
}

/** @param {number} n */
function formatNumber(n) {
	return Object.is(n, -0) ? '-0' : String(n);
}

/**
 * Canonical duration text: `1h30m`, `7d`, `0s`; non-integer milliseconds print as `<n>ms`.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
	if (ms === 0) return '0s';
	if (!Number.isInteger(ms) || ms < 0 || !Number.isSafeInteger(ms)) return `${String(ms)}ms`;
	let rest = ms;
	let out = '';
	for (const [unit, size] of [...DURATION_UNITS].filter(([u]) => u !== 'w')) {
		const q = Math.floor(rest / size);
		if (q > 0) {
			out += `${q}${unit}`;
			rest -= q * size;
		}
	}
	return out;
}

/**
 * Print a node or program.
 * @param {Node | import('./ast.js').Program} input
 * @returns {string}
 */
export function format(input) {
	return print('ast' in input ? input.ast : input, 0);
}

/**
 * @param {Node} node
 * @param {number} minPrec
 * @returns {string}
 */
function print(node, minPrec) {
	const text = printBare(node);
	return precOf(node) < minPrec ? `(${text})` : text;
}

/**
 * @param {Node} node
 * @returns {string}
 */
function printBare(node) {
	switch (node.type) {
		case 'literal':
			if (node.value === null) return 'null';
			if (typeof node.value === 'string') return quote(node.value);
			if (typeof node.value === 'number') return formatNumber(node.value);
			return String(node.value);
		case 'duration':
			return formatDuration(node.ms);
		case 'date':
			return formatDateLiteral(node.ms);
		case 'list':
			return `[${node.items.map((n) => print(n, 0)).join(', ')}]`;
		case 'ident':
			return node.name;
		case 'member':
			return `${print(node.object, PREC.postfix)}.${node.key}`;
		case 'index':
			return `${print(node.object, PREC.postfix)}[${print(node.index, 0)}]`;
		case 'call':
			return `${node.fn}(${node.args.map((n) => print(n, 0)).join(', ')})`;
		case 'unary':
			return node.op === 'not' ? `not ${print(node.arg, PREC.not)}` : `-${spaceIfNeg(print(node.arg, PREC.neg))}`;
		case 'logical': {
			const p = node.op === 'or' ? PREC.and : PREC.not;
			return node.args.map((n) => print(n, p)).join(` ${node.op} `);
		}
		case 'binary': {
			const p = binaryPrec(node.op);
			const leftMin = p === PREC.cmp ? p + 1 : p;
			return `${print(node.left, leftMin)} ${node.op} ${print(node.right, p + 1)}`;
		}
		case 'cond':
			return `${print(node.test, PREC.or)} ? ${print(node.ifTrue, 0)} : ${print(node.ifFalse, PREC.cond)}`;
		default:
			return 'null';
	}
}

/** @param {string} s */
function spaceIfNeg(s) {
	return s.startsWith('-') ? ` ${s}` : s;
}
