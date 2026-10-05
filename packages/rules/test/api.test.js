import { describe, expect, it } from 'vitest';
import {
	check,
	compile,
	deserialize,
	evaluate,
	evaluateCondition,
	explain,
	format,
	functionsUsed,
	LANGUAGE_VERSION,
	referencedPaths,
	serialize,
	validateProgram,
} from '../src/index.js';
import { NOW, prog } from './helpers.js';

describe('compile', () => {
	it('produces a frozen, versioned, plain-JSON program', () => {
		const r = compile('order.total > 5');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.program).toEqual({
			v: 1,
			ast: {
				type: 'binary',
				op: '>',
				left: { type: 'member', object: { type: 'ident', name: 'order' }, key: 'total' },
				right: { type: 'literal', value: 5 },
			},
		});
		expect(Object.isFrozen(r.program)).toBe(true);
		expect(Object.isFrozen(r.program.ast)).toBe(true);
		expect(JSON.parse(JSON.stringify(r.program))).toEqual(r.program);
		expect(LANGUAGE_VERSION).toBe(1);
	});
	it('stores durations and dates as numbers', () => {
		expect(prog('7d').ast).toEqual({ type: 'duration', ms: 604800000 });
		expect(prog('@2026-10-01').ast).toEqual({ type: 'date', ms: Date.UTC(2026, 9, 1) });
	});
});

describe('evaluate / evaluateCondition', () => {
	it('returns values and never throws', () => {
		expect(evaluate(prog('1 + 1'))).toEqual({ ok: true, value: 2 });
		expect(evaluate(/** @type {any} */ (null))).toMatchObject({ ok: false, error: { code: 'invalid_program' } });
		expect(evaluate(/** @type {any} */ ({ v: 2, ast: {} }))).toMatchObject({
			ok: false,
			error: { code: 'unsupported_version' },
		});
		expect(evaluate(prog('a'), /** @type {any} */ (null))).toEqual({ ok: true, value: null });
		expect(evaluate(prog('a'), 'not an object')).toEqual({ ok: true, value: null });
	});
	it('evaluateCondition coerces to boolean', () => {
		expect(evaluateCondition(prog('count(xs)'), { xs: [1] })).toEqual({ ok: true, value: true });
		expect(evaluateCondition(prog('xs'), { xs: [] })).toEqual({ ok: true, value: false });
		expect(evaluateCondition(prog("'' + s"), { s: 'x'.repeat(20000) })).toMatchObject({ ok: false });
	});
	it('reports Proxy traps that throw as an internal error, not an exception', () => {
		const hostile = new Proxy(
			{},
			{
				getOwnPropertyDescriptor() {
					throw new Error('boom');
				},
			},
		);
		expect(evaluate(prog('x.y'), { x: hostile })).toMatchObject({ ok: false, error: { code: 'internal' } });
	});
});

describe('serialise / deserialise', () => {
	it('round-trips and evaluates identically', () => {
		const p = prog("any(order.lines, it.sku like 'A*') ? 1 : 2".replace(' like ', ' == '));
		const text = serialize(p);
		const back = deserialize(text);
		expect(back.ok).toBe(true);
		if (!back.ok) return;
		expect(back.program).toEqual(p);
		const ctx = { order: { lines: [{ sku: 'A*' }] } };
		expect(evaluate(back.program, ctx)).toEqual(evaluate(p, ctx));
	});
	it('accepts already-parsed objects and validates them', () => {
		expect(deserialize({ v: 1, ast: { type: 'literal', value: 3 } }).ok).toBe(true);
		expect(deserialize('not json')).toMatchObject({ ok: false, error: { code: 'invalid_program' } });
	});
	it('evaluate validates foreign objects (and caches the validated copy)', () => {
		const foreign = {
			v: 1,
			ast: { type: 'binary', op: '+', left: { type: 'literal', value: 1 }, right: { type: 'literal', value: 2 } },
		};
		expect(evaluate(/** @type {any} */ (foreign))).toEqual({ ok: true, value: 3 });
		foreign.ast.op = 'eval';
		expect(evaluate(/** @type {any} */ (foreign))).toEqual({ ok: true, value: 3 });
	});
	const lit = { type: 'literal', value: 1 };
	const tampered = [
		['not an object', 'x'],
		['array', []],
		['missing ast', { v: 1 }],
		['unknown node', { v: 1, ast: { type: 'js', code: 'process.exit()' } }],
		['bad literal', { v: 1, ast: { type: 'literal', value: { $gt: 1 } } }],
		['NaN literal', { v: 1, ast: { type: 'literal', value: NaN } }],
		['bad duration', { v: 1, ast: { type: 'duration', ms: 'x' } }],
		['bad date', { v: 1, ast: { type: 'date', ms: 1e20 } }],
		['bad list', { v: 1, ast: { type: 'list', items: 'x' } }],
		['keyword ident', { v: 1, ast: { type: 'ident', name: 'and' } }],
		['bad ident', { v: 1, ast: { type: 'ident', name: 'a-b' } }],
		['proto ident', { v: 1, ast: { type: 'ident', name: '__proto__' } }],
		['free it', { v: 1, ast: { type: 'ident', name: 'it' } }],
		['proto member', { v: 1, ast: { type: 'member', object: lit, key: '__proto__' } }],
		['non-string key', { v: 1, ast: { type: 'member', object: lit, key: 5 } }],
		['proto index', { v: 1, ast: { type: 'index', object: lit, index: { type: 'literal', value: 'constructor' } } }],
		['bad unary', { v: 1, ast: { type: 'unary', op: '!', arg: lit } }],
		['bad binary', { v: 1, ast: { type: 'binary', op: '**', left: lit, right: lit } }],
		['bad logical op', { v: 1, ast: { type: 'logical', op: 'xor', args: [lit, lit] } }],
		['short logical', { v: 1, ast: { type: 'logical', op: 'and', args: [lit] } }],
		['unknown fn', { v: 1, ast: { type: 'call', fn: 'require', args: [] } }],
		['proto fn', { v: 1, ast: { type: 'call', fn: 'toString', args: [] } }],
		['bad args', { v: 1, ast: { type: 'call', fn: 'abs', args: 'x' } }],
		['arity', { v: 1, ast: { type: 'call', fn: 'abs', args: [] } }],
		['has non-path', { v: 1, ast: { type: 'call', fn: 'has', args: [lit] } }],
		['cond child', { v: 1, ast: { type: 'cond', test: lit, ifTrue: lit, ifFalse: null } }],
	];
	for (const [name, value] of tampered)
		it(`rejects tampered program: ${name}`, () => {
			const r = validateProgram(value);
			expect(r.ok).toBe(false);
			expect(evaluate(/** @type {any} */ (value)).ok).toBe(false);
		});
	it('accepts it inside a lambda argument', () => {
		const ast = {
			type: 'call',
			fn: 'any',
			args: [
				{ type: 'ident', name: 'xs' },
				{ type: 'ident', name: 'it' },
			],
		};
		const r = validateProgram({ v: 1, ast });
		expect(r.ok).toBe(true);
		if (r.ok) expect(evaluate(r.program, { xs: [0, 2] })).toEqual({ ok: true, value: true });
	});
	it('requires canonical member keys (non-identifier keys must be index nodes)', () => {
		const r = validateProgram({ v: 1, ast: { type: 'member', object: { type: 'ident', name: 'a' }, key: 'x-y' } });
		expect(r.ok).toBe(false);
		const ok = validateProgram({
			v: 1,
			ast: { type: 'index', object: { type: 'ident', name: 'a' }, index: { type: 'literal', value: 'x-y' } },
		});
		expect(ok.ok && format(ok.program)).toBe("a['x-y']");
	});
});

describe('check', () => {
	it('returns errors with positions', () => {
		const r = check('order.total >');
		expect(r.ok).toBe(false);
		expect(r.errors[0]).toMatchObject({ code: 'syntax', line: 1, column: 14 });
		expect(r.paths).toEqual([]);
	});
	it('returns paths, functions and unknown-root warnings', () => {
		const r = check(
			"order.total > 10 and any(order.lines, it.price > 5 and it.tags contains 'x') and sum(order.lines, 'qty') > 2 and custmer.tier == now",
			{
				roots: ['order', 'customer'],
			},
		);
		expect(r.ok).toBe(true);
		expect(r.errors).toEqual([]);
		expect(r.functions).toEqual(['any', 'sum']);
		expect(r.paths).toEqual([
			'custmer.tier',
			'order.lines',
			'order.lines[].price',
			'order.lines[].qty',
			'order.lines[].tags',
			'order.total',
		]);
		expect(r.warnings).toHaveLength(1);
		expect(r.warnings[0]).toMatchObject({ code: 'unknown_identifier', line: 1 });
		expect(r.warnings[0]?.message).toMatch(/custmer/);
	});
	it('no warnings without roots', () => expect(check('anything').warnings).toEqual([]));
	it('handles non-string input', () => expect(check(/** @type {any} */ (5)).ok).toBe(false));
});

describe('referencedPaths / functionsUsed', () => {
	/** @param {string} src */
	const paths = (src) => referencedPaths(prog(src));
	it('lists maximal static paths', () => {
		expect(paths('a.b.c + a.b')).toEqual(['a.b', 'a.b.c']);
		expect(paths("x[0].y + x['k'] + x['a-b'] + x[i.j].z")).toEqual(['i.j', 'x.k', 'x["a-b"]', 'x[0].y', 'x[].z']);
		expect(paths('now > @2026-01-01')).toEqual([]);
		expect(paths('has(customer.email)')).toEqual(['customer.email']);
		expect(paths('any(map(xs, it.a), it > 1)')).toEqual(['xs', 'xs[].a']);
		expect(paths('any(xs, any(it.tags, it == y))')).toEqual(['xs', 'xs[].tags', 'xs[].tags[]', 'y']);
		expect(paths("dateParts(now).hour + min(o.lines, 'p')")).toEqual(['o.lines', 'o.lines[].p']);
		expect(paths('(a or b).c')).toEqual(['a', 'b']);
	});
	it('functionsUsed', () => expect(functionsUsed(prog('round(sum(xs), 2) + abs(round(1))'))).toEqual(['abs', 'round', 'sum']));
	it('return [] for invalid programs', () => {
		expect(referencedPaths(/** @type {any} */ ({}))).toEqual([]);
		expect(functionsUsed(/** @type {any} */ ({}))).toEqual([]);
	});
});

describe('explain', () => {
	const ctx = { order: { total: 120, lines: [{ price: 50 }, { price: 5 }] }, customer: { tags: [] } };
	it('builds a trace tree with values', () => {
		const r = explain(prog("order.total > 100 and 'vip' in customer.tags"), ctx, { now: NOW });
		expect(r.ok && r.value).toBe(false);
		expect(r.trace).toMatchObject({
			node: 'logical',
			expr: "order.total > 100 and 'vip' in customer.tags",
			value: false,
			children: [
				{
					expr: 'order.total > 100',
					value: true,
					children: [{ expr: 'order.total', value: 120, children: [] }, { expr: '100' }],
				},
				{ expr: "'vip' in customer.tags", value: false },
			],
		});
	});
	it('marks short-circuited operands as skipped', () => {
		const r = explain(prog('order.total > 500 and x or true ? 1 : 2'), ctx);
		expect(r.ok && r.value).toBe(1);
		const skipped = JSON.stringify(r.trace).match(/"skipped":true/g) ?? [];
		expect(skipped.length).toBe(2); // `x` and the unused branch `2`
		const c = explain(prog('coalesce(order.total, y, z)'), ctx);
		expect(c.trace?.children.filter((f) => f.skipped).map((f) => f.expr)).toEqual(['y', 'z']);
	});
	it('traces predicate iterations', () => {
		const r = explain(prog('any(order.lines, it.price < 10)'), ctx);
		expect(r.ok && r.value).toBe(true);
		expect(r.trace?.children.map((f) => f.expr)).toEqual(['order.lines', 'it.price < 10', 'it.price < 10']);
		expect(r.trace?.children.map((f) => f.value)).toEqual([ctx.order.lines, false, true]);
	});
	it('caps the number of frames', () => {
		const xs = Array.from({ length: 3000 }, (_, i) => i);
		const r = explain(prog('count(xs, it >= 0)'), { xs }, { maxSteps: 1e6 });
		expect(r.ok && r.value).toBe(3000);
		/** @param {import('../src/evaluate.js').TraceFrame} f @returns {number} */
		const size = (f) => 1 + f.children.reduce((n, c) => n + size(c), 0);
		expect(r.trace && size(r.trace)).toBeLessThanOrEqual(2000);
	});
	it('invalid program', () => expect(explain(/** @type {any} */ ({ v: 1 }))).toMatchObject({ ok: false, trace: null }));
	it('invalid options', () => expect(explain(prog('1'), {}, { timeZone: 'X/Y' })).toMatchObject({ ok: false, trace: null }));
});
