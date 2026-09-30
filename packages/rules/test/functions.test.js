import { describe, expect, it } from 'vitest';
import { FUNCTIONS } from '../src/index.js';
import { globMatch, roundHalfAway } from '../src/library.js';
import { run } from './helpers.js';

const ctx = {
	order: {
		lines: [
			{ sku: 'A', price: 50, qty: 2, variant: { price: 55 }, tags: ['sale'] },
			{ sku: 'B', price: 20, qty: 1, variant: { price: 21 }, tags: [] },
			{ sku: 'C', price: '9', qty: null, tags: ['new', 'sale'] },
		],
		createdAt: '2026-09-21T12:00:00Z',
	},
	customer: { email: 'ann@example.com', name: '  Ann  ', nickname: null, tags: ['vip'] },
	segments: ['loyal', 'newsletter'],
	nums: [3, 1, 2],
	words: ['pear', 'apple'],
	dates: ['2026-01-01', '2025-06-01'],
	empty: [],
};

/** @param {Array<[string, unknown]>} cases */
function table(cases) {
	for (const [src, expected] of cases) it(`${src} → ${JSON.stringify(expected)}`, () => expect(run(src, ctx)).toEqual(expected));
}

describe('has', () =>
	table([
		['has(customer.email)', true],
		['has(customer.nickname)', false],
		['has(customer.phone)', false],
		['has(order.lines[0].sku)', true],
		['has(order.lines[9].sku)', false],
		['has(missing)', false],
	]));

describe('count', () =>
	table([
		['count(order.lines)', 3],
		['count(empty)', 0],
		['count(missing)', null],
		["count('abc')", null],
		['count(order.lines, it.price > 10)', 2],
		["count(order.lines, 'sale' in it.tags)", 2],
		['count(missing, true)', null],
	]));

describe('sum / avg', () =>
	table([
		['sum(nums)', 6],
		["sum(order.lines, 'price')", 70],
		["sum(order.lines, 'qty')", 3],
		["sum(order.lines, 'variant.price')", 76],
		['sum(empty)', 0],
		['sum(missing)', null],
		['sum([1e308, 1e308])', null],
		['avg(nums)', 2],
		["avg(order.lines, 'price')", 35],
		['avg(empty)', null],
		["avg(['a'])", null],
		['avg(missing)', null],
	]));

describe('min / max', () =>
	table([
		['min(nums)', 1],
		['max(nums)', 3],
		['min(3, 1, 2)', 1],
		['max(3, 1, 2)', 3],
		['max(x, 1, 2)', 2],
		["min(order.lines, 'price')", null], // '9' is a string: mixed types → null
		["min(filter(order.lines, it.sku != 'C'), 'price')", 20],
		["max(order.lines, 'variant.price')", 55],
		['min(words)', 'apple'],
		['max(dates)', '2026-01-01'],
		['min(empty)', null],
		["min(1, 'a')", null],
		['min([[1]])', null],
		['min(5)', 5],
		['max(@2026-01-01, @2026-03-01)', new Date('2026-03-01T00:00:00Z')],
	]));

describe('round / floor / ceil / abs', () => {
	table([
		['round(2.5)', 3],
		['round(-2.5)', -3],
		['round(1.005, 2)', 1.01],
		['round(1.004, 2)', 1],
		['round(1234.5678, -2)', 1200],
		['round(1234.5678, 1)', 1234.6],
		['round(-0.4)', 0],
		['round(1e-7, 7)', 1e-7],
		["round('1')", null],
		['round(1, x)', 1],
		['floor(2.7)', 2],
		['floor(-2.1)', -3],
		['ceil(2.1)', 3],
		['ceil(-2.7)', -2],
		['abs(-3)', 3],
		['abs(x)', null],
		["floor('2')", null],
		["ceil('2')", null],
	]);
	it('rejects bad dynamic digits', () => {
		expect(run('round(1.5, d)', { d: 1.5 })).toBe(null);
		expect(run('round(1.5, d)', { d: 20 })).toBe(null);
		expect(roundHalfAway(1e300, 10)).toBe(null);
	});
});

describe('string functions', () =>
	table([
		["lower('AbC')", 'abc'],
		["upper('straße')", 'STRASSE'],
		['trim(customer.name)', 'Ann'],
		['lower(5)', null],
		['upper(x)', null],
		['trim([])', null],
		["startsWith(customer.email, 'ann@')", true],
		["startsWith(customer.email, 'bob')", false],
		["endsWith(customer.email, '@example.com')", true],
		["endsWith(5, '5')", false],
		["startsWith(x, '')", false],
		["len('héllo')", 5],
		["len('😀a')", 2],
		['len(order.lines)', 3],
		['len(customer)', 4],
		['len(5)', null],
		["number('12.50')", 12.5],
		["number(' -3 ')", -3],
		["number('.5')", 0.5],
		["number('1e3')", null],
		["number('')", null],
		["number('abc')", null],
		['number(7)', 7],
		['number(true)', null],
		['string(12)', '12'],
		['string(true)', 'true'],
		["string('s')", 's'],
		['string(@2026-10-01)', '2026-10-01T00:00:00.000Z'],
		['string([1])', null],
		['string(x)', null],
	]));

describe('like / ilike (glob)', () => {
	table([
		["like('photo.jpg', '*.jpg')", true],
		["like('photo.jpeg', '*.jpg')", false],
		["like('/products/phone-x', '/products/*')", true],
		["like('/products', '/products/*')", false],
		["like('abc', 'a?c')", true],
		["like('ac', 'a?c')", false],
		["like('ABC', 'abc')", false],
		["ilike('ABC', 'abc')", true],
		["ilike('Sale-2026', 'sale-*')", true],
		["like('a*b', 'a\\\\*b')", true],
		["like('axb', 'a\\\\*b')", false],
		["like('', '*')", true],
		["like('', '')", true],
		["like('x', '')", false],
		["like('aaa', 'a**a')", true],
		["like('mississippi', '*sip*')", true],
		["like('mississippi', 'm*s*s*i')", true],
		["like('mississippi', 'm*x*')", false],
		["like('😀x', '?x')", true],
		["like(5, '*')", false],
		['like(x, x)', false],
	]);
	it('handles pathological patterns in linear-ish time', () => {
		const s = 'a'.repeat(200);
		expect(globMatch(s, '*a*a*a*a*a*a*a*a*b')).toBe(false);
		expect(globMatch(`${s}b`, '*a*a*a*a*a*a*a*a*b')).toBe(true);
	});
	it('overlong dynamic patterns never match', () => {
		expect(run('like(s, p)', { s: 'a', p: '*'.repeat(300) })).toBe(false);
	});
	it('trailing backslash is literal', () => expect(globMatch('a\\', 'a\\')).toBe(true));
});

describe('daysSince / hoursSince / minutesSince (now = 2026-10-01T12:00Z)', () =>
	table([
		['daysSince(order.createdAt)', 10],
		["daysSince('2026-09-30T13:00:00Z')", 0],
		["daysSince('2026-09-30T12:00:00Z')", 1],
		["daysSince('2026-10-03T00:00:00Z')", -1],
		["daysSince('2026-10-01T18:00:00Z')", 0],
		['daysSince(@2026-09-01)', 30],
		['daysSince(0)', 20727],
		["hoursSince('2026-10-01T09:30:00Z')", 2],
		["minutesSince('2026-10-01T11:58:30Z')", 1],
		['daysSince(x)', null],
		["daysSince('yesterday')", null],
	]));

describe('inSegment', () => {
	table([
		["inSegment('loyal')", true],
		["inSegment('wholesale')", false],
		['inSegment(x)', false],
	]);
	it('missing or malformed segments', () => {
		expect(run("inSegment('a')", {})).toBe(false);
		expect(run("inSegment('a')", { segments: 'a' })).toBe(false);
		expect(run("inSegment('a')", { segments: [{ name: 'a' }] })).toBe(false);
	});
});

describe('any / all / filter / map', () =>
	table([
		['any(order.lines, it.price > 40)', true],
		['any(order.lines, it.price > 400)', false],
		['all(order.lines, has(it.sku))', true],
		['all(order.lines, it.qty > 0)', false],
		['any(empty, true)', false],
		['all(empty, false)', true],
		['any(missing, true)', false],
		['all(missing, true)', false],
		["any(order.lines, any(it.tags, it == 'new'))", true],
		["all(order.lines, all(it.tags, it == 'sale'))", false],
		['filter(nums, it >= 2)', [3, 2]],
		['map(nums, it * 10)', [30, 10, 20]],
		['map(order.lines, it.sku)', ['A', 'B', 'C']],
		['filter(missing, true)', null],
		['map(missing, it)', null],
		['sum(map(order.lines, it.price * coalesce(it.qty, 1)))', 120],
		['count(filter(order.lines, it.price > 10))', 2],
		['map(nums, it)[0]', 3],
	]));

describe('coalesce', () =>
	table([
		['coalesce(x, y, 3)', 3],
		['coalesce(customer.nickname, customer.email)', 'ann@example.com'],
		['coalesce(0, 5)', 0],
		["coalesce('', 'b')", ''],
		['coalesce(x)', null],
		['coalesce(1, 1 / 0)', 1],
	]));

describe('date', () =>
	table([
		["date('2026-10-01')", new Date('2026-10-01T00:00:00Z')],
		["date('2026-10-01 10:00')", new Date('2026-10-01T10:00:00Z')],
		["date('2026-10-01T10:00:00.5+02:00')", new Date('2026-10-01T08:00:00.500Z')],
		['date(0)', new Date(0)],
		['date(now)', new Date('2026-10-01T12:00:00Z')],
		["date('2026-02-29')", null],
		["date('01/10/2026')", null],
		['date(true)', null],
	]));

describe('library metadata', () => {
	it('lists every function with a signature', () => {
		expect(FUNCTIONS.length).toBeGreaterThanOrEqual(30);
		for (const f of FUNCTIONS) {
			expect(f.signature.startsWith(f.name)).toBe(true);
			expect(Object.isFrozen(f)).toBe(true);
		}
	});
});
