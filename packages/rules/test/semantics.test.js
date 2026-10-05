import { describe, expect, it } from 'vitest';
import { evaluate, truthy } from '../src/index.js';
import { prog, run } from './helpers.js';

describe('null semantics (README §5 truth table)', () => {
	const table = [
		['x == null', true],
		['null == null', true],
		['x != null', false],
		['x == 0', false],
		["x == ''", false],
		['x == false', false],
		['x != 0', true],
		['x < 1', false],
		['x >= 1', false],
		['x > null', false],
		['null <= null', false],
		['1 > x', false],
		['x + 1', null],
		['x * 2', null],
		['-x', null],
		["x + 'a'", null],
		["'a' + x", null],
		['x - 7d', null],
		['1 / 0', null],
		['5 % 0', null],
		['x in [1, null]', true],
		['1 in x', false],
		["'a' in x", false],
		['1 not in x', true],
		['x contains 1', false],
		['not x', true],
		['x and true', false],
		['x or true', true],
		['x or x', false],
		["x ? 'a' : 'b'", 'b'],
		['has(x)', false],
		['has(x.y.z)', false],
		['coalesce(x, 5)', 5],
		['x.y.z', null],
		['x[0]', null],
		['x.y[x]', null],
	];
	for (const [src, expected] of table)
		it(`${src} → ${JSON.stringify(expected)}`, () => expect(run(String(src))).toEqual(expected));
});

describe('safe navigation', () => {
	const ctx = {
		order: { total: 100, lines: [{ price: 5 }, { price: 7 }], meta: { 'fit-type': 'slim' } },
		n: 5,
		s: 'str',
		nothing: undefined,
		fn: () => 1,
		nan: NaN,
		inf: Infinity,
		bad: new Date('nope'),
		big: 10n,
	};
	it('reads nested data', () => {
		expect(run('order.total', ctx)).toBe(100);
		expect(run('order.lines[1].price', ctx)).toBe(7);
		expect(run('order.lines[-1].price', ctx)).toBe(7);
		expect(run('order.lines[-3]', ctx)).toBe(null);
		expect(run('order.lines[2]', ctx)).toBe(null);
		expect(run('order.lines[0.5]', ctx)).toBe(null);
		expect(run("order.lines['0']", ctx)).toBe(null);
		expect(run("order.meta['fit-type']", ctx)).toBe('slim');
		expect(run("order['total']", ctx)).toBe(100);
	});
	it('stepping into non-maps yields null', () => {
		expect(run('n.x', ctx)).toBe(null);
		expect(run('s.length', ctx)).toBe(null);
		expect(run('order.lines.length', ctx)).toBe(null);
		expect(run('s[0]', ctx)).toBe(null);
		expect(run('order.total.x.y', ctx)).toBe(null);
	});
	it('non-language values read as null', () => {
		for (const k of ['nothing', 'fn', 'nan', 'inf', 'bad', 'big']) expect(run(`${k} == null`, ctx)).toBe(true);
	});
	it('map index by number reads string key', () => expect(run('m[1]', { m: { 1: 'one' } })).toBe('one'));
	it('never reads the prototype chain or invokes getters', () => {
		let called = false;
		const withGetter = Object.defineProperty({}, 'secret', {
			get() {
				called = true;
				return 42;
			},
			enumerable: true,
		});
		expect(run('o.secret', { o: withGetter })).toBe(null);
		expect(called).toBe(false);
		const inherited = Object.create({ inherited: 1 });
		expect(run('o.inherited', { o: inherited })).toBe(null);
		expect(run('o.toString', { o: {} })).toBe(null);
		expect(run('o.hasOwnProperty', { o: {} })).toBe(null);
		expect(run('o[k]', { o: { a: 1 }, k: '__proto__' })).toBe(null);
		expect(run('o[k]', { o: { a: 1 }, k: 'constructor' })).toBe(null);
		const own = JSON.parse('{"__proto__": {"x": 1}}');
		expect(run('o[k].x', { o: own, k: '__proto__' })).toBe(null);
	});
	it('does not mutate the context', () => {
		const ctx2 = Object.freeze({ list: Object.freeze([3, 1, 2]), m: Object.freeze({ a: 1 }) });
		expect(run('map(list, it * 2) + filter(list, it > 1)', ctx2)).toEqual([6, 2, 4, 3, 2]);
		expect(ctx2.list).toEqual([3, 1, 2]);
	});
});

describe('truthiness', () => {
	const falsy = [null, undefined, false, 0, '', [], {}, NaN];
	const truthyValues = [true, 1, -1, 'a', [0], { a: 1 }, new Date(0)];
	it('falsy values', () => falsy.forEach((v) => expect(truthy(v)).toBe(false)));
	it('truthy values', () => truthyValues.forEach((v) => expect(truthy(v)).toBe(true)));
	it('and/or/not return booleans', () => {
		expect(run("1 and 'a'")).toBe(true);
		expect(run("0 or ''")).toBe(false);
		expect(run('not []')).toBe(true);
		expect(run('not e', { e: {} })).toBe(true);
		expect(run('m and true', { m: { a: 1 } })).toBe(true);
	});
	it('short-circuits', () => {
		expect(run('false and 1 / 0 == 1')).toBe(false);
		expect(run('true or x.y.z')).toBe(true);
	});
});

describe('equality', () => {
	const cases = [
		['1 == 1', true],
		["1 == '1'", false],
		['true == 1', false],
		["'a' == 'a'", true],
		['[1, [2, 3]] == [1, [2, 3]]', true],
		['[1, 2] == [2, 1]', false],
		['[1] == [1, 2]', false],
		['m == n', true],
		['m == o', false],
		['m == p', false],
		['m == q', false],
		['m == [1]', false],
		['@2026-10-01 == @2026-10-01T00:00Z', true],
		["@2026-10-01 == '2026-10-01'", true],
		["'2026-10-01T00:00:00Z' == @2026-10-01", true],
		["@2026-10-01 == 'nope'", false],
		['@2026-10-01 != @2026-10-02', true],
		['0.1 + 0.2 == 0.3', false],
		['round(0.1 + 0.2, 2) == 0.3', true],
	];
	const ctx = { m: { a: 1, b: [1] }, n: { b: [1], a: 1 }, o: { a: 1 }, p: { a: 1, c: [1] }, q: { a: 2, b: [1] } };
	for (const [src, expected] of cases) it(`${src} → ${expected}`, () => expect(run(String(src), ctx)).toBe(expected));
	it('gives up on absurdly deep structures instead of recursing forever', () => {
		/** @type {any} */
		let a = 1;
		/** @type {any} */
		let b = 1;
		for (let i = 0; i < 40; i++) {
			a = [a];
			b = [b];
		}
		expect(run('a == b', { a, b })).toBe(false);
		const cyc = /** @type {any} */ ({});
		cyc.self = cyc;
		expect(run('a == b', { a: cyc, b: cyc })).toBe(false);
	});
});

describe('ordering', () => {
	const cases = [
		['1 < 2', true],
		['2 <= 2', true],
		['3 > 2', true],
		['2 >= 3', false],
		["'apple' < 'banana'", true],
		["'B' < 'a'", true],
		["1 < '2'", false],
		['true > false', false],
		['[1] < [2]', false],
		['@2026-01-01 < @2026-10-01', true],
		["@2026-01-01 < '2026-10-01T00:00:00Z'", true],
		["'2026-01-01' < @2025-01-01", false],
		["@2026-01-01 < 'garbage'", false],
		['now > @2026-09-30', true],
		['now < @2026-09-30', false],
		['now >= now', true],
	];
	for (const [src, expected] of cases) it(`${src} → ${expected}`, () => expect(run(String(src))).toBe(expected));
});

describe('membership', () => {
	const cases = [
		["'vip' in ['vip', 'new']", true],
		["'x' in ['vip']", false],
		['[1] in [[1], [2]]', true],
		["'ell' in 'hello'", true],
		["'ELL' in 'hello'", false],
		["1 in 'a1'", false],
		["'a' in m", true],
		["'z' in m", false],
		["'n' in m", false],
		["m contains 'a'", true],
		["'hello' contains 'ell'", true],
		["['a', 'b'] contains 'b'", true],
		["'b' not in ['a']", true],
		['1 in 1', false],
		['@2026-10-01 in [d]', true],
	];
	const ctx = { m: { a: 1, n: null }, d: '2026-10-01' };
	for (const [src, expected] of cases) it(`${src} → ${expected}`, () => expect(run(String(src), ctx)).toBe(expected));
});

describe('arithmetic and concatenation', () => {
	const cases = [
		['1 + 2', 3],
		['5 - 7', -2],
		['6 * 7', 42],
		['7 / 2', 3.5],
		['7 % 3', 1],
		['-7 % 3', -1],
		['1e308 * 10', null],
		['-0', 0],
		['-(0)', 0],
		['0 * -1', 0],
		["'a' + 'b'", 'ab'],
		["'n=' + 5", 'n=5'],
		["5 + '!'", '5!'],
		["'ok: ' + true", 'ok: true'],
		["'at ' + @2026-10-01", 'at 2026-10-01T00:00:00.000Z'],
		["'a' + [1]", null],
		['[1] + [2, 3]', [1, 2, 3]],
		['[1] + 2', null],
		["'a' * 2", null],
		['true + 1', null],
		['7d / 1d', 7],
		['1h == 60m', true],
		['1d + 1', 86400001],
		['m + 1', null],
	];
	for (const [src, expected] of cases)
		it(`${src} → ${JSON.stringify(expected)}`, () => expect(run(String(src), { m: {} })).toEqual(expected));

	it('date arithmetic', () => {
		expect(run('@2026-10-01 + 1d')).toEqual(new Date('2026-10-02T00:00:00Z'));
		expect(run('1d + @2026-10-01')).toEqual(new Date('2026-10-02T00:00:00Z'));
		expect(run('@2026-10-01 - 12h')).toEqual(new Date('2026-09-30T12:00:00Z'));
		expect(run('@2026-10-02 - @2026-10-01')).toBe(86400000);
		expect(run("@2026-10-02 - '2026-10-01'")).toBe(86400000);
		expect(run("'2026-10-02' - @2026-10-01")).toBe(86400000);
		expect(run('now - o.createdAt > 7d', { o: { createdAt: '2026-09-01T00:00:00Z' } })).toBe(true);
		expect(run('now - o.createdAt > 7d', { o: { createdAt: new Date('2026-09-30T00:00:00Z') } })).toBe(false);
		expect(run("@2026-10-01 - 'nope'")).toBe(null);
		expect(run('@2026-10-01 + 1e300')).toBe(null);
		expect(run("'a' - 1")).toBe(null);
	});

	it('now defaults to context.now, then the clock', () => {
		const p = prog('now');
		const a = evaluate(p, { now: '2020-01-01T00:00:00Z' });
		expect(a).toEqual({ ok: true, value: new Date('2020-01-01T00:00:00Z') });
		const b = evaluate(p, {}, {});
		expect(b.ok && b.value instanceof Date && Math.abs(b.value.getTime() - Date.now()) < 5000).toBe(true);
		const c = evaluate(p, { now: '2020-01-01T00:00:00Z' }, { now: 0 });
		expect(c).toEqual({ ok: true, value: new Date(0) });
	});
});
