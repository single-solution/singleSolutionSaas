import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { check, compile, deserialize, evaluate, explain, format, serialize, validateProgram } from '../src/index.js';

/** @typedef {import('../src/ast.js').Node} Node */

/**
 * CI runs are deterministic (fixed seed). Set RULES_FUZZ=1 for a deep, randomly seeded run
 * (RULES_FUZZ_SCALE multiplies numRuns, default 20); failures print the seed and path to replay.
 */
const FUZZ = process.env.RULES_FUZZ === '1';
const SCALE = Number(process.env.RULES_FUZZ_SCALE) || 20;
const SEED = 20261001;
/** @param {number} numRuns @returns {fc.Parameters<unknown>} */
const runs = (numRuns) => (FUZZ ? { numRuns: numRuns * SCALE } : { numRuns, seed: SEED });

const NOW = Date.UTC(2026, 9, 1, 12);
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const NAMES = ['a', 'b', 'order', 'customer', 'event', 'x_1', 'now', 'website'];
const KEYS = ['total', 'lines', 'tags', 'in', 'and', 'data', 'price'];
const DATA_KEYS = [...KEYS, 'x-y', '', 'x', 'y'];
const BIN = ['==', '!=', '<', '<=', '>', '>=', 'in', 'not in', 'contains', '+', '-', '*', '/', '%'];
const FNS1 = [
	'abs',
	'lower',
	'upper',
	'trim',
	'len',
	'count',
	'sum',
	'avg',
	'floor',
	'ceil',
	'date',
	'number',
	'string',
	'min',
	'max',
	'daysSince',
];
const LAMBDA_FNS = ['any', 'all', 'filter', 'map', 'count'];

const numberArb = fc
	.oneof(fc.integer({ min: -1000, max: 1000 }), fc.double({ noNaN: true, noDefaultInfinity: true }))
	.map((n) => (n === 0 ? 0 : n));

/** @type {fc.Arbitrary<Node>} */
const literalArb = fc.oneof(
	numberArb.map((value) => /** @type {Node} */ ({ type: 'literal', value })),
	fc.string().map((value) => /** @type {Node} */ ({ type: 'literal', value })),
	fc.boolean().map((value) => /** @type {Node} */ ({ type: 'literal', value })),
	fc.constant(/** @type {Node} */ ({ type: 'literal', value: null })),
	fc.integer({ min: 0, max: 1e12 }).map((ms) => /** @type {Node} */ ({ type: 'duration', ms })),
	fc.integer({ min: -62167219200000, max: 253402300799999 }).map((ms) => /** @type {Node} */ ({ type: 'date', ms })),
);

/**
 * Valid-by-construction ASTs of bounded depth (the shapes compile() can produce).
 * @param {number} depth
 * @param {boolean} inLambda
 * @returns {fc.Arbitrary<Node>}
 */
function astArb(depth, inLambda) {
	const names = inLambda ? [...NAMES, 'it'] : NAMES;
	const ident = fc.constantFrom(...names).map((name) => /** @type {Node} */ ({ type: 'ident', name }));
	const leaf = fc.oneof(literalArb, ident);
	if (depth <= 0) return leaf;
	const sub = astArb(depth - 1, inLambda);
	const lambdaBody = astArb(depth - 1, true);
	const notNumberLiteral = sub.filter((n) => !(n.type === 'literal' && typeof n.value === 'number'));
	return fc.oneof(
		{ weight: 3, arbitrary: leaf },
		fc.array(sub, { maxLength: 3 }).map((items) => /** @type {Node} */ ({ type: 'list', items })),
		fc.record({ object: sub, key: fc.constantFrom(...KEYS) }).map((r) => /** @type {Node} */ ({ type: 'member', ...r })),
		fc
			.record({ object: sub, index: sub })
			// Literal forbidden keys are compile/validation errors by contract (fc.string is biased towards '__proto__').
			.filter(({ index }) => !(index.type === 'literal' && typeof index.value === 'string' && FORBIDDEN.has(index.value)))
			.map((r) => /** @type {Node} */ ({ type: 'index', ...r })),
		sub.map((arg) => /** @type {Node} */ ({ type: 'unary', op: 'not', arg })),
		notNumberLiteral.map((arg) => /** @type {Node} */ ({ type: 'unary', op: '-', arg })),
		fc
			.record({ op: fc.constantFrom(...BIN), left: sub, right: sub })
			.map((r) => /** @type {Node} */ ({ type: 'binary', ...r })),
		fc
			.record({ op: fc.constantFrom('and', 'or'), args: fc.array(sub, { minLength: 2, maxLength: 4 }) })
			.map((r) => /** @type {Node} */ ({ type: 'logical', ...r })),
		fc.record({ test: sub, ifTrue: sub, ifFalse: sub }).map((r) => /** @type {Node} */ ({ type: 'cond', ...r })),
		fc
			.record({ fn: fc.constantFrom(...FNS1), a: sub })
			.map(({ fn, a }) => /** @type {Node} */ ({ type: 'call', fn, args: [a] })),
		fc
			.record({ fn: fc.constantFrom(...LAMBDA_FNS), list: sub, body: lambdaBody })
			.map(({ fn, list, body }) => /** @type {Node} */ ({ type: 'call', fn, args: [list, body] })),
		fc.array(sub, { minLength: 1, maxLength: 3 }).map((args) => /** @type {Node} */ ({ type: 'call', fn: 'coalesce', args })),
	);
}

const programArb = astArb(4, false).map((ast) => ({ v: /** @type {const} */ (1), ast }));

/** Context values: JSON data plus dates. */
const valueArb = fc.letrec((tie) => ({
	value: fc.oneof(
		{ depthSize: 'small' },
		fc.constant(null),
		fc.boolean(),
		numberArb,
		fc.string({ maxLength: 12 }),
		fc.date({ noInvalidDate: true }),
		fc.array(tie('value'), { maxLength: 4 }),
		fc.dictionary(fc.constantFrom(...DATA_KEYS), tie('value'), { maxKeys: 4 }),
	),
}));
const anyValue = /** @type {fc.Arbitrary<unknown>} */ (valueArb.value);
const contextArb = fc.record({
	a: anyValue,
	b: anyValue,
	order: anyValue,
	customer: anyValue,
	event: anyValue,
	x_1: anyValue,
	segments: fc.array(fc.string({ maxLength: 4 }), { maxLength: 3 }),
});

const TOKENS = [
	'a',
	'b.c',
	'it',
	'now',
	'1',
	'2.5',
	'-',
	'+',
	'*',
	'/',
	'%',
	'(',
	')',
	'[',
	']',
	',',
	'.',
	'?',
	':',
	'==',
	'!=',
	'<',
	'>=',
	'and',
	'or',
	'not',
	'in',
	'contains',
	'true',
	'null',
	"'s'",
	'"t\\n"',
	'7d',
	'@2026-10-01',
	'count(',
	'any(',
	'has(',
	'coalesce(',
	'between(',
	'like(',
	'#c\n',
	'__proto__',
	'!',
	'&&',
	'=',
	'@',
	"'",
];

describe('property: robustness', () => {
	it('compile never throws on arbitrary text and errors carry positions', () => {
		fc.assert(
			fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (src) => {
				const r = compile(src);
				if (!r.ok) {
					expect(typeof r.error.code).toBe('string');
					expect(r.error.line).toBeGreaterThanOrEqual(1);
					expect(r.error.column).toBeGreaterThanOrEqual(1);
				}
				expect(check(src).ok).toBe(r.ok);
			}),
			runs(1000),
		);
	});

	it('compile and evaluate never throw on token soup', () => {
		fc.assert(
			fc.property(fc.array(fc.constantFrom(...TOKENS), { maxLength: 30 }), contextArb, (toks, ctx) => {
				const r = compile(toks.join(' '));
				if (r.ok) {
					const e = evaluate(r.program, ctx, { now: NOW });
					expect(typeof e.ok).toBe('boolean');
					expect(explain(r.program, ctx, { now: NOW }).ok).toBe(e.ok);
				}
			}),
			runs(2000),
		);
	});

	it('evaluate never throws on random programs and contexts', () => {
		fc.assert(
			fc.property(programArb, contextArb, (program, ctx) => {
				const v = validateProgram(program);
				expect(v.ok).toBe(true);
				if (!v.ok) return;
				const r = evaluate(v.program, ctx, { now: NOW });
				expect(typeof r.ok).toBe('boolean');
				if (!r.ok) expect(['max_steps', 'list_too_long', 'string_too_long']).toContain(r.error.code);
			}),
			runs(1000),
		);
	});

	it('validateProgram never throws on arbitrary JSON', () => {
		fc.assert(
			fc.property(fc.jsonValue(), (value) => {
				expect(typeof validateProgram({ v: 1, ast: value }).ok).toBe('boolean');
				expect(evaluate(/** @type {any} */ ({ v: 1, ast: value })).ok !== undefined).toBe(true);
			}),
			runs(500),
		);
	});
});

describe('property: determinism and round-trips', () => {
	it('evaluate is deterministic', () => {
		fc.assert(
			fc.property(programArb, contextArb, (program, ctx) => {
				const v = validateProgram(program);
				if (!v.ok) return;
				expect(evaluate(v.program, ctx, { now: NOW })).toEqual(evaluate(v.program, ctx, { now: NOW }));
			}),
			runs(500),
		);
	});

	it('format → compile reproduces the AST', () => {
		fc.assert(
			fc.property(programArb, (program) => {
				const v = validateProgram(program);
				if (!v.ok) return;
				const src = format(v.program);
				const again = compile(src, { maxLength: 1e6, maxNodes: 1e6 });
				if (!again.ok) throw new Error(`${src}: ${again.error.message}`);
				expect(again.program).toEqual(v.program);
			}),
			runs(1000),
		);
	});

	it('serialise → deserialise round-trips and evaluates identically', () => {
		fc.assert(
			fc.property(programArb, contextArb, (program, ctx) => {
				const v = validateProgram(program);
				if (!v.ok) return;
				const back = deserialize(serialize(v.program));
				expect(back.ok).toBe(true);
				if (!back.ok) return;
				expect(back.program).toEqual(v.program);
				expect(evaluate(back.program, ctx, { now: NOW })).toEqual(evaluate(v.program, ctx, { now: NOW }));
			}),
			runs(300),
		);
	});

	it('explain agrees with evaluate', () => {
		fc.assert(
			fc.property(programArb, contextArb, (program, ctx) => {
				const v = validateProgram(program);
				if (!v.ok) return;
				const a = evaluate(v.program, ctx, { now: NOW });
				const b = explain(v.program, ctx, { now: NOW });
				expect(b.ok).toBe(a.ok);
				if (a.ok && b.ok) expect(b.value).toEqual(a.value);
			}),
			runs(300),
		);
	});
});
