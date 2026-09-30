import { describe, expect, it } from 'vitest';
import { compile, deserialize, DEFAULT_LIMITS, evaluate, explain } from '../src/index.js';
import { compileError, evalError, prog } from './helpers.js';

describe('compile limits', () => {
	it('defaults', () =>
		expect(DEFAULT_LIMITS).toEqual({
			maxLength: 4000,
			maxDepth: 64,
			maxNodes: 2000,
			maxSteps: 10000,
			maxListLength: 1000,
			maxStringLength: 10000,
		}));

	it('maxLength trips', () => {
		expect(compileError(`a${' '.repeat(4000)}`).code).toBe('too_long');
		expect(compile(`a${' '.repeat(3998)}`).ok).toBe(true);
		expect(compileError('a + b', { maxLength: 3 })).toMatchObject({ code: 'too_long', column: 4 });
	});

	it('maxDepth trips for parentheses without overflowing the stack', () => {
		const e = compileError(`${'('.repeat(3000)}1${')'.repeat(3000)}`, { maxLength: 10000 });
		expect(e.code).toBe('too_deep');
		expect(compile(`${'('.repeat(60)}1${')'.repeat(60)}`).ok).toBe(true);
	});

	it('maxDepth trips for nested operators, unary chains and calls', () => {
		expect(compileError('not '.repeat(100) + 'a').code).toBe('too_deep');
		expect(compileError('- '.repeat(100) + 'a').code).toBe('too_deep');
		expect(compileError(`${'abs('.repeat(80)}1${')'.repeat(80)}`).code).toBe('too_deep');
		expect(compileError(Array.from({ length: 80 }, (_, i) => `a${i}`).join(' + ')).code).toBe('too_deep');
		expect(compileError('a + b + c + d', { maxDepth: 3 }).code).toBe('too_deep');
		expect(compileError('[[[[1]]]]', { maxDepth: 3 }).code).toBe('too_deep');
	});

	it('and/or chains are flat, so long disjunctions stay within depth', () => {
		const src = Array.from({ length: 200 }, (_, i) => `x == ${i}`).join(' or ');
		expect(compile(src).ok).toBe(true);
	});

	it('maxNodes trips', () => {
		const list = (/** @type {number} */ n) => `[${Array.from({ length: n }, () => '1').join(',')}]`;
		expect(compileError(list(2000), { maxLength: 10000 }).code).toBe('too_many_nodes'); // 2001 nodes
		expect(compile(list(1999), { maxLength: 10000 }).ok).toBe(true); // exactly 2000
		expect(compileError('a + b', { maxNodes: 2 }).code).toBe('too_many_nodes');
	});

	it('hard ceiling on maxDepth', () => {
		const deep = `${'('.repeat(300)}1${')'.repeat(300)}`;
		expect(compileError(deep, { maxDepth: 100000, maxLength: 10000 }).code).toBe('too_deep');
	});

	it('invalid limit options fall back to defaults', () => {
		expect(compile('a', { maxLength: -1, maxDepth: 0, maxNodes: 1.5 }).ok).toBe(true);
	});

	it('deserialize enforces depth and node limits', () => {
		/** @type {any} */
		let ast = { type: 'literal', value: 1 };
		for (let i = 0; i < 100; i++) ast = { type: 'unary', op: '-', arg: ast };
		expect(deserialize({ v: 1, ast })).toMatchObject({ ok: false, error: { code: 'too_deep' } });
		const items = Array.from({ length: 2001 }, () => ({ type: 'literal', value: 1 }));
		expect(deserialize({ v: 1, ast: { type: 'list', items } })).toMatchObject({ ok: false, error: { code: 'too_many_nodes' } });
	});
});

describe('evaluation limits', () => {
	const bigList = Array.from({ length: 5000 }, (_, i) => i);

	it('maxSteps trips on predicates over large lists', () => {
		expect(evalError('any(xs, it < 0)', { xs: bigList })).toMatchObject({ code: 'max_steps' });
		expect(evaluate(prog('any(xs, it < 0)'), { xs: bigList }, { maxSteps: 100000 })).toEqual({ ok: true, value: false });
	});

	it('maxSteps trips on list functions, membership and equality', () => {
		expect(evalError('sum(xs) > 0', { xs: bigList }, { maxSteps: 1000 }).code).toBe('max_steps');
		expect(evalError('-1 in xs', { xs: bigList }, { maxSteps: 1000 }).code).toBe('max_steps');
		expect(evalError('xs == ys', { xs: bigList, ys: [...bigList] }, { maxSteps: 1000 }).code).toBe('max_steps');
		expect(evalError("inSegment('x')", { segments: bigList }, { maxSteps: 1000 }).code).toBe('max_steps');
	});

	it('maxSteps trips on expensive string work', () => {
		const s = 'a'.repeat(200000);
		expect(evalError("like(s, '*a*a*a*b')", { s }).code).toBe('max_steps');
		expect(evalError('len(upper(s)) > 0', { s }, { maxSteps: 100 }).code).toBe('max_steps');
		expect(evalError("'b' in s", { s }, { maxSteps: 100 }).code).toBe('max_steps');
	});

	it('nested predicates multiply cost and are bounded', () => {
		const xs = Array.from({ length: 200 }, (_, i) => i);
		expect(evalError('any(xs, any(xs, it < 0))', { xs }).code).toBe('max_steps');
	});

	it('the step budget is deterministic', () => {
		const p = prog('count(xs, it % 2 == 0)');
		const ctx = { xs: Array.from({ length: 100 }, (_, i) => i) };
		const a = explain(p, ctx);
		const b = explain(p, ctx);
		expect(a.steps).toBe(b.steps);
		expect(a.steps).toBeGreaterThan(400);
		expect(evaluate(p, ctx, { maxSteps: a.steps }).ok).toBe(true);
		expect(evaluate(p, ctx, { maxSteps: a.steps - 1 })).toMatchObject({ ok: false, error: { code: 'max_steps' } });
	});

	it('maxListLength trips on literals, filter, map and concatenation', () => {
		const xs = Array.from({ length: 1500 }, (_, i) => i);
		const opts = { maxSteps: 1e6 };
		expect(evalError('map(xs, it)', { xs }, opts).code).toBe('list_too_long');
		expect(evalError('filter(xs, true)', { xs }, opts).code).toBe('list_too_long');
		expect(evalError('xs + xs', { xs: xs.slice(0, 600) }, opts).code).toBe('list_too_long');
		expect(evalError('[1, 2, 3]', {}, { maxListLength: 2 }).code).toBe('list_too_long');
		expect(evaluate(prog('map(xs, it)'), { xs }, { ...opts, maxListLength: 2000 }).ok).toBe(true);
	});

	it('maxStringLength trips on concatenation', () => {
		expect(evalError('s + s', { s: 'a'.repeat(6000) }).code).toBe('string_too_long');
		expect(evalError("'ab' + 'cd'", {}, { maxStringLength: 3 }).code).toBe('string_too_long');
	});

	it('explain returns the partial trace on a limit error', () => {
		const r = explain(prog('any(xs, it < 0)'), { xs: bigList });
		expect(r.ok).toBe(false);
		expect(r.trace).not.toBe(null);
	});
});
