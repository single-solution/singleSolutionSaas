/**
 * Hand-written lexer for rules@1. Linear time, no regular expressions over the source.
 */

import { ruleError } from './errors.js';
import { parseIsoPrefix } from './time.js';

export const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'contains', 'true', 'false', 'null']);

/** Duration units in milliseconds. */
export const DURATION_UNITS = new Map([
	['w', 604800000],
	['d', 86400000],
	['h', 3600000],
	['m', 60000],
	['s', 1000],
	['ms', 1],
]);

/**
 * @typedef {'num' | 'dur' | 'str' | 'date' | 'ident' | 'kw' | 'op' | 'eof'} TokenType
 * @typedef {{ type: TokenType, value: string, num: number, start: number, end: number }} Token
 * `value` is the decoded text (strings) or source text; `num` holds numbers, durations (ms) and dates (epoch ms).
 */

const SINGLE_OPS = '()[],.?:<>+-*/%';

/** @param {number} c */
const isDigit = (c) => c >= 48 && c <= 57;
/** @param {number} c */
const isLetter = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
/** @param {number} c */
const isIdentStart = (c) => isLetter(c) || c === 95;
/** @param {number} c */
const isIdentPart = (c) => isIdentStart(c) || isDigit(c);
/** @param {number} c */
const isHex = (c) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

/**
 * @param {string} source
 * @returns {Token[]} Always ends with an `eof` token.
 */
export function tokenize(source) {
	/** @type {Token[]} */
	const tokens = [];
	const n = source.length;
	let i = 0;
	/** @param {number} j */
	const code = (j) => (j < n ? source.charCodeAt(j) : -1);
	/** @param {TokenType} type @param {string} value @param {number} num @param {number} start */
	const push = (type, value, num, start) => {
		tokens.push({ type, value, num, start, end: i });
	};

	const readNumber = () => {
		const s = i;
		while (isDigit(code(i))) i++;
		if (code(i) === 46 && isDigit(code(i + 1))) {
			i++;
			while (isDigit(code(i))) i++;
		}
		if (code(i) === 101 || code(i) === 69) {
			const save = i;
			i++;
			if (code(i) === 43 || code(i) === 45) i++;
			if (isDigit(code(i))) while (isDigit(code(i))) i++;
			else i = save;
		}
		const value = Number(source.slice(s, i));
		if (!Number.isFinite(value)) throw ruleError('syntax', 'Number is out of range', s);
		return value;
	};

	/** @param {number} start */
	const readString = (start) => {
		const quote = code(i);
		i++;
		let out = '';
		for (;;) {
			const ch = code(i);
			if (ch === -1 || ch === 10 || ch === 13) throw ruleError('syntax', 'Unterminated string', start);
			if (ch === quote) {
				i++;
				return out;
			}
			if (ch !== 92) {
				out += source.charAt(i++);
				continue;
			}
			const esc = source.charAt(i + 1);
			const at = i;
			i += 2;
			switch (esc) {
				case 'n':
					out += '\n';
					break;
				case 't':
					out += '\t';
					break;
				case 'r':
					out += '\r';
					break;
				case '\\':
				case "'":
				case '"':
					out += esc;
					break;
				case 'u': {
					if (code(i) === 123) {
						const hs = ++i;
						while (isHex(code(i)) && i - hs < 6) i++;
						const cp = parseInt(source.slice(hs, i), 16);
						if (i === hs || code(i) !== 125 || !(cp <= 0x10ffff)) throw ruleError('syntax', 'Invalid \\u{…} escape', at);
						i++;
						out += String.fromCodePoint(cp);
					} else {
						for (let k = 0; k < 4; k++) if (!isHex(code(i + k))) throw ruleError('syntax', 'Invalid \\uXXXX escape', at);
						out += String.fromCharCode(parseInt(source.slice(i, i + 4), 16));
						i += 4;
					}
					break;
				}
				default:
					throw ruleError('syntax', `Invalid escape '\\${esc}' (use \\n \\t \\r \\\\ \\' \\" \\uXXXX)`, at);
			}
		}
	};

	for (;;) {
		for (;;) {
			const c = code(i);
			if (c === 32 || c === 9 || c === 10 || c === 13) i++;
			else if (c === 35) while (i < n && code(i) !== 10) i++;
			else break;
		}
		const start = i;
		if (i >= n) {
			push('eof', '', 0, start);
			return tokens;
		}
		const c = code(i);

		if (isDigit(c)) {
			const value = readNumber();
			if (!isIdentPart(code(i))) {
				push('num', source.slice(start, i), value, start);
				continue;
			}
			let total = 0;
			let amount = value;
			for (;;) {
				const us = i;
				while (isLetter(code(i))) i++;
				const unit = source.slice(us, i);
				const mult = DURATION_UNITS.get(unit);
				if (mult === undefined)
					throw ruleError(
						'syntax',
						unit === ''
							? 'Invalid number'
							: `Invalid duration unit '${unit}' (use w, d, h, m, s or ms; e.g. 7d, 12h, 1h30m)`,
						us,
					);
				total += amount * mult;
				if (!isDigit(code(i))) break;
				const ps = i;
				amount = readNumber();
				if (!isLetter(code(i))) throw ruleError('syntax', 'Each part of a duration needs a unit (e.g. 1h30m)', ps);
			}
			if (isIdentPart(code(i))) throw ruleError('syntax', 'Invalid duration', start);
			if (!Number.isFinite(total)) throw ruleError('syntax', 'Duration is out of range', start);
			push('dur', source.slice(start, i), total, start);
			continue;
		}

		if (c === 39 || c === 34) {
			const value = readString(start);
			push('str', value, 0, start);
			continue;
		}

		if (c === 64) {
			const r = parseIsoPrefix(source, i + 1, false);
			if (r === null)
				throw ruleError('syntax', 'Invalid date literal (expected @YYYY-MM-DD or @YYYY-MM-DDTHH:MM[:SS][Z|±HH:MM])', start);
			i = r.end;
			if (isIdentPart(code(i)) || code(i) === 58) throw ruleError('syntax', 'Invalid date literal', start);
			push('date', source.slice(start, i), r.ms, start);
			continue;
		}

		if (isIdentStart(c)) {
			while (isIdentPart(code(i))) i++;
			const word = source.slice(start, i);
			push(KEYWORDS.has(word) ? 'kw' : 'ident', word, 0, start);
			continue;
		}

		const two = source.slice(i, i + 2);
		if (two === '==' || two === '!=' || two === '<=' || two === '>=') {
			i += 2;
			push('op', two, 0, start);
			continue;
		}
		if (two === '&&') throw ruleError('syntax', "Use 'and' instead of '&&'", start);
		if (two === '||') throw ruleError('syntax', "Use 'or' instead of '||'", start);
		const ch = source.charAt(i);
		if (SINGLE_OPS.includes(ch)) {
			i++;
			push('op', ch, 0, start);
			continue;
		}
		if (ch === '!') throw ruleError('syntax', "Use 'not' instead of '!'", start);
		if (ch === '=') throw ruleError('syntax', "Use '==' to compare values", start);
		throw ruleError('syntax', `Unexpected character ${JSON.stringify(ch)}`, start);
	}
}
