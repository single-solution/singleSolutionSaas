import { describe, expect, it } from 'vitest';
import { compile, format } from '../src/index.js';
import { compileError, prog, run } from './helpers.js';

/** Sources that must compile, with the canonical form format() prints for them. */
/** @type {Array<[string, string]>} */
const VALID = [
	['1', '1'],
	['42', '42'],
	['3.25', '3.25'],
	['1e3', '1000'],
	['2.5E-4', '0.00025'],
	['-5', '-5'],
	['- 5', '-5'],
	["'single'", "'single'"],
	['"double"', "'double'"],
	["'it\\'s'", "'it\\'s'"],
	['"tab\\tnew\\nline"', "'tab\\tnew\\nline'"],
	["'\\u00e9'", "'é'"],
	["'\\u{1F600}'", "'\\ud83d\\ude00'"],
	["'\\\\'", "'\\\\'"],
	['true', 'true'],
	['false', 'false'],
	['null', 'null'],
	['7d', '7d'],
	['12h', '12h'],
	['30m', '30m'],
	['45s', '45s'],
	['250ms', '250ms'],
	['2w', '14d'],
	['1h30m', '1h30m'],
	['1.5h', '1h30m'],
	['@2026-10-01', '@2026-10-01'],
	['@2026-10-01T10:00Z', '@2026-10-01T10:00Z'],
	['@2026-10-01T10:00', '@2026-10-01T10:00Z'],
	['@2026-10-01T10:00:30Z', '@2026-10-01T10:00:30Z'],
	['@2026-10-01T10:00:30.250Z', '@2026-10-01T10:00:30.250Z'],
	['@2026-10-01T10:00+05:00', '@2026-10-01T05:00Z'],
	['@2024-02-29', '@2024-02-29'],
	['[]', '[]'],
	['[1, 2, 3]', '[1, 2, 3]'],
	['[1, 2,]', '[1, 2]'],
	["[[1], ['a']]", "[[1], ['a']]"],
	['website', 'website'],
	['event.data.total', 'event.data.total'],
	['order.lines[0]', 'order.lines[0]'],
	['order.lines[-1].price', 'order.lines[-1].price'],
	["item.attributes['fit-type']", "item.attributes['fit-type']"],
	['a[b.c]', 'a[b.c]'],
	['event.data.in', 'event.data.in'],
	['a  +  b', 'a + b'],
	['a - b - c', 'a - b - c'],
	['a - (b - c)', 'a - (b - c)'],
	['a * b + c', 'a * b + c'],
	['a * (b + c)', 'a * (b + c)'],
	['a / b % c', 'a / b % c'],
	['a == b', 'a == b'],
	['a != b', 'a != b'],
	['a <= b', 'a <= b'],
	['a >= b', 'a >= b'],
	['a < b', 'a < b'],
	['a > b', 'a > b'],
	["'vip' in customer.tags", "'vip' in customer.tags"],
	["'vip' not in customer.tags", "'vip' not in customer.tags"],
	["customer.tags contains 'vip'", "customer.tags contains 'vip'"],
	['not a', 'not a'],
	['not not a', 'not not a'],
	['a and b', 'a and b'],
	['a or b', 'a or b'],
	['a and b and c', 'a and b and c'],
	['a or b and c', 'a or b and c'],
	['(a or b) and c', '(a or b) and c'],
	['(a or b) or c', '(a or b) or c'],
	['a ? b : c', 'a ? b : c'],
	['a ? b : c ? d : e', 'a ? b : c ? d : e'],
	['(a ? b : c) ? d : e', '(a ? b : c) ? d : e'],
	['a ? (b ? c : d) : e', 'a ? b ? c : d : e'],
	['count(order.lines)', 'count(order.lines)'],
	['coalesce(a, b, 0)', 'coalesce(a, b, 0)'],
	['any(order.lines, it.price > 10)', 'any(order.lines, it.price > 10)'],
	["any(order.lines, any(it.tags, it == 'sale'))", "any(order.lines, any(it.tags, it == 'sale'))"],
	['# comment\na # trailing', 'a'],
	['a\n  and\n  b', 'a and b'],
	['-x.y', '-x.y'],
	['-(a + b)', '-(a + b)'],
	['- -a', '- -a'],
	['-7d', '-7d'],
	['(-5)', '-5'],
	['(a)', 'a'],
	['not a == b', 'not a == b'],
	['(not a) == b', '(not a) == b'],
	['a == (b == c)', 'a == (b == c)'],
	['now - 7d', 'now - 7d'],
	['1 + 2 * 3 - 4 / 2', '1 + 2 * 3 - 4 / 2'],
	['has(customer.email)', 'has(customer.email)'],
];

describe('grammar: valid sources', () => {
	it('has at least 60 cases', () => expect(VALID.length).toBeGreaterThanOrEqual(60));
	for (const [src, canonical] of VALID) {
		it(`parses ${JSON.stringify(src)}`, () => {
			const p = prog(src);
			expect(format(p)).toBe(canonical);
			expect(prog(format(p))).toEqual(p);
		});
	}
});

/** Sources that must fail, with the expected error code and (1-based) column. */
/** @type {Array<[string, string, number]>} */
const INVALID = [
	['', 'empty', 1],
	['   # only a comment', 'empty', 1],
	['1 +', 'syntax', 4],
	['(1 + 2', 'syntax', 7],
	['[1, 2', 'syntax', 6],
	['a b', 'syntax', 3],
	['a && b', 'syntax', 3],
	['a || b', 'syntax', 3],
	['!a', 'syntax', 1],
	['a = 1', 'syntax', 3],
	['a === b', 'syntax', 5],
	["'unterminated", 'syntax', 1],
	["'bad \\q escape'", 'syntax', 6],
	["'\\u12'", 'syntax', 2],
	['"line\nbreak"', 'syntax', 1],
	['7days', 'syntax', 2],
	['1h30', 'syntax', 3],
	['12abc', 'syntax', 3],
	['1e999', 'syntax', 1],
	['@2026-13-01', 'syntax', 1],
	['@2026-02-30', 'syntax', 1],
	['@2026-10-01T25:00Z', 'syntax', 1],
	['@2026-10-01T', 'syntax', 1],
	['@2026-10-01T10:00:00Zx', 'syntax', 1],
	['a < b < c', 'syntax', 7],
	['a == b != c', 'syntax', 8],
	['a not b', 'syntax', 3],
	['a ? b', 'syntax', 6],
	['a.', 'syntax', 3],
	['a.1', 'syntax', 3],
	['a[1', 'syntax', 4],
	['x.__proto__', 'forbidden_key', 3],
	["x['constructor']", 'forbidden_key', 3],
	['x.prototype', 'forbidden_key', 3],
	['foo(1)', 'unknown_function', 1],
	['Count(x)', 'unknown_function', 1],
	['now()', 'unknown_function', 1],
	['a.b(1)', 'syntax', 4],
	['count()', 'arity', 1],
	['round(1, 2, 3)', 'arity', 1],
	['has(1)', 'invalid_argument', 1],
	['has(a + b)', 'invalid_argument', 1],
	['it', 'reserved', 1],
	['it.price > 3', 'reserved', 1],
	['any(it, true)', 'reserved', 5],
	['+1', 'syntax', 1],
	['and', 'syntax', 1],
	['a $ b', 'syntax', 3],
	["dateParts(now, 'Mars/Olympus')", 'invalid_argument', 1],
	["between(now, '25:00', '02:00')", 'invalid_argument', 1],
	["between(now, '22:00', '02:00', 'Nope/Zone')", 'invalid_argument', 1],
	['round(x, 1.5)', 'invalid_argument', 1],
	['round(x, 11)', 'invalid_argument', 1],
	['like(x, 5)', 'invalid_argument', 1],
	['inSegment(5)', 'invalid_argument', 1],
	['sum(x, 5)', 'invalid_argument', 1],
	['()', 'syntax', 2],
	['[,]', 'syntax', 2],
	['coalesce(,a)', 'syntax', 10],
	['a b', 'syntax', 3],
	['1 2', 'syntax', 3],
];

describe('grammar: invalid sources report code and position', () => {
	for (const [src, code, column] of INVALID) {
		it(`rejects ${JSON.stringify(src)}`, () => {
			const e = compileError(String(src));
			expect(e.code).toBe(code);
			expect(e.column).toBe(column);
			expect(e.line).toBe(1);
			expect(typeof e.message).toBe('string');
		});
	}

	it('reports line and column on later lines', () => {
		const e = compileError('a and\n  b and\n    (c or');
		expect(e).toMatchObject({ code: 'syntax', line: 3, column: 10 });
	});

	it('gives helpful messages', () => {
		expect(compileError('a && b').message).toMatch(/'and'/);
		expect(compileError('a = 1').message).toMatch(/==/);
		expect(compileError('Count(x)').message).toMatch(/did you mean count\(\)/);
		expect(compileError('a < b < c').message).toMatch(/cannot be chained/);
		expect(compileError('7days').message).toMatch(/duration unit/);
		expect(compileError('round(1, 2, 3)').message).toMatch(/round\(\) takes 1–2 arguments but got 3/);
		expect(compileError('a not b').message).toMatch(/not in/);
		expect(compileError('now()').message).toMatch(/value, not a function/);
	});

	it('rejects non-string sources and unknown versions', () => {
		expect(compile(/** @type {any} */ (42))).toMatchObject({ ok: false, error: { code: 'invalid_source' } });
		expect(compile('1', { version: 2 })).toMatchObject({ ok: false, error: { code: 'unsupported_version' } });
		expect(compile('1', { version: 1 }).ok).toBe(true);
	});
});

describe('precedence and associativity', () => {
	/** @type {Array<[string, unknown]>} */
	const cases = [
		['1 + 2 * 3', 7],
		['(1 + 2) * 3', 9],
		['10 - 4 - 3', 3],
		['10 - (4 - 3)', 9],
		['100 / 10 / 2', 5],
		['2 * 3 % 4', 2],
		['7 % 4 * 2', 6],
		['-2 * 3', -6],
		['-(2 * 3) + 1', -5],
		['- - 2', 2],
		['1 + 2 == 3', true],
		['(1 < 2) == true', true],
		['not 1 == 2', true],
		['not true and false', false],
		['not (true and false)', true],
		['true or false and false', true],
		['(true or false) and false', false],
		['false and true or true', true],
		['true ? 1 : 2 + 10', 1],
		['false ? 1 : 2 + 10', 12],
		['false ? 1 : true ? 2 : 3', 2],
		['true ? false ? 1 : 2 : 3', 2],
		['1 + 1 > 1 ? "yes" : "no"', 'yes'],
		['3 in [1, 2] or 2 in [1, 2]', true],
		["'a' + 'b' == 'ab'", true],
		['2 * 3 in [6]', true],
	];
	for (const [src, expected] of cases)
		it(`${src} → ${JSON.stringify(expected)}`, () => expect(run(String(src))).toEqual(expected));

	it('flattens and/or chains into one n-ary node', () => {
		const p = prog('a or b or c or d');
		expect(p.ast).toMatchObject({ type: 'logical', op: 'or' });
		expect(p.ast.type === 'logical' && p.ast.args.length).toBe(4);
		const q = prog('a and b or c and d');
		expect(q.ast.type === 'logical' && q.ast.args.map((n) => n.type)).toEqual(['logical', 'logical']);
	});

	it('folds negative number literals', () => {
		expect(prog('-5').ast).toEqual({ type: 'literal', value: -5 });
		expect(prog('-x').ast).toEqual({ type: 'unary', op: '-', arg: { type: 'ident', name: 'x' } });
	});
});
