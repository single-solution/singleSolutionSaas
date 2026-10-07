/**
 * Property tests of the resolver (fast-check): on random configurators — single, multi and range groups, required and
 * optional groups, defaults, hidden options, option stock, rules@1 group / option dependencies and exclusions, and
 * random variant matrices with stock — and random partial, partly invalid selections, the resolver
 *
 *   - always returns a valid combination, or a clear problem — and the problem only when none exists;
 *   - returns the closest one (the changed group's pick first, then as many of the other picks as possible), and an
 *     in-stock one whenever an equally close one is in stock;
 *   - is deterministic (same input, same output; key order of the input does not matter);
 *   - keeps a selection that is already valid and complete exactly as it is.
 *
 * Validity is checked by an independent brute-force oracle that enumerates every assignment.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { compile, evaluateCondition } from '@ss/rules';
import { compileSchema } from '../core/compile.js';
import { resolve } from '../core/resolve.js';
import { parseSchema } from '../core/schema.js';

const RUNS = 400;

const atomArb = fc.record({ group: fc.nat(3), option: fc.nat(3), negate: fc.boolean(), threshold: fc.nat(6) });
const groupArb = fc.record({
	type: fc.constantFrom('single', 'single', 'single', 'multi', 'range'),
	options: fc.integer({ min: 1, max: 4 }),
	required: fc.boolean(),
	defaultIndex: fc.option(fc.nat(3), { nil: null }),
	hidden: fc.array(fc.integer({ min: 0, max: 7 }), { minLength: 4, maxLength: 4 }),
	stock: fc.array(fc.option(fc.integer({ min: 0, max: 2 }), { nil: null }), { minLength: 4, maxLength: 4 }),
	min: fc.integer({ min: 0, max: 3 }),
	span: fc.integer({ min: 0, max: 4 }),
	step: fc.integer({ min: 1, max: 2 }),
	minSelect: fc.integer({ min: 0, max: 2 }),
	maxSelect: fc.integer({ min: 1, max: 4 }),
	when: fc.option(atomArb, { nil: null, freq: 4 }),
	optionWhen: fc.array(fc.option(atomArb, { nil: null, freq: 3 }), { minLength: 4, maxLength: 4 }),
});
const specArb = fc.record({
	groups: fc.array(groupArb, { minLength: 1, maxLength: 4 }),
	rules: fc.array(fc.array(atomArb, { minLength: 1, maxLength: 2 }), { maxLength: 3 }),
	combinations: fc.option(
		fc.record({
			mask: fc.nat(15),
			rows: fc.array(
				fc.record({
					picks: fc.array(fc.nat(3), { minLength: 4, maxLength: 4 }),
					any: fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 4, maxLength: 4 }),
					stock: fc.option(fc.integer({ min: 0, max: 2 }), { nil: null }),
				}),
				{ maxLength: 8 },
			),
		}),
		{ nil: null },
	),
	selection: fc.array(
		fc.option(
			fc.record({
				index: fc.integer({ min: -1, max: 4 }),
				list: fc.subarray([0, 1, 2, 3, 9]),
				number: fc.integer({ min: -1, max: 9 }),
			}),
			{ nil: null },
		),
		{
			minLength: 4,
			maxLength: 4,
		},
	),
	changed: fc.option(fc.nat(3), { nil: null }),
	inStock: fc.constantFrom('prefer', 'require', 'ignore'),
	partial: fc.constantFrom('fill', 'fill', 'keep'),
	tieBreak: fc.constantFrom('schema', 'price_low', 'popularity'),
});

/** @param {number} i */
const g = (i) => `g${i}`;
/** @param {number} i */
const o = (i) => `o${i}`;

/**
 * The schema of a spec.
 * @param {any} spec
 */
const schemaOf = (spec) => {
	const n = spec.groups.length;
	/** @param {any} atom */
	const source = (atom) => {
		const index = atom.group % n;
		const target = spec.groups[index];
		if (target.type === 'single')
			return `selection.${g(index)} ${atom.negate ? '!=' : '=='} '${o(atom.option % target.options)}'`;
		if (target.type === 'multi')
			return `${atom.negate ? 'not ' : ''}('${o(atom.option % target.options)}' in selection.${g(index)})`;
		return `selection.${g(index)} ${atom.negate ? '<' : '>='} ${atom.threshold}`;
	};
	const groups = spec.groups.map((/** @type {any} */ group, /** @type {number} */ gi) => {
		const base = {
			key: g(gi),
			type: group.type,
			required: group.required,
			...(group.when ? { when: source(group.when) } : {}),
		};
		if (group.type === 'range') {
			const max = group.min + group.span;
			return {
				...base,
				min: group.min,
				max,
				step: group.step,
				...(group.defaultIndex !== null ? { default: group.min } : {}),
			};
		}
		const options = Array.from({ length: group.options }, (_, oi) => ({
			key: o(oi),
			hidden: group.hidden[oi] === 0,
			priceDelta: (oi * 37) % 5,
			popularity: (oi * 13) % 7,
			...(group.stock[oi] !== null ? { stock: group.stock[oi] } : {}),
			...(group.optionWhen[oi] ? { when: source(group.optionWhen[oi]) } : {}),
		}));
		const defaultIndex = group.defaultIndex === null ? null : group.defaultIndex % group.options;
		const defaultOk = defaultIndex !== null && !options[defaultIndex]?.hidden;
		if (group.type === 'single')
			return { ...base, options, ...(defaultOk ? { default: o(/** @type {number} */ (defaultIndex)) } : {}) };
		const maxSelect = Math.max(group.maxSelect, group.minSelect, 1);
		return {
			...base,
			options,
			minSelect: group.minSelect,
			maxSelect,
			...(defaultOk ? { default: [o(/** @type {number} */ (defaultIndex))] } : {}),
		};
	});
	const singles = groups
		.map((/** @type {any} */ group, /** @type {number} */ gi) => (group.type === 'single' ? gi : -1))
		.filter((/** @type {number} */ gi) => gi >= 0);
	let combinations = [];
	if (spec.combinations && singles.length > 0) {
		const chosen = singles.filter((/** @type {number} */ gi) => (spec.combinations.mask & (1 << gi)) !== 0);
		const dims = chosen.length > 0 ? chosen : [/** @type {number} */ (singles[0])];
		combinations = spec.combinations.rows.map((/** @type {any} */ row, /** @type {number} */ ri) => ({
			id: `c${ri}`,
			options: Object.fromEntries(
				dims.map((/** @type {number} */ gi, /** @type {number} */ di) => {
					const count = spec.groups[gi].options;
					const first = o(row.picks[di] % count);
					return [g(gi), row.any[di] === 0 && count > 1 ? [first, o((row.picks[di] + 1) % count)] : first];
				}),
			),
			...(row.stock !== null ? { stock: row.stock } : {}),
		}));
	}
	return {
		name: 'Generated',
		groups,
		rules: spec.rules.map((/** @type {any[]} */ atoms, /** @type {number} */ ri) => ({
			id: `r${ri}`,
			when: atoms.map(source).join(' and '),
		})),
		combinations,
	};
};

/**
 * The raw selection of a spec (some values unknown or out of range on purpose).
 * @param {any} spec
 * @param {any} schema
 */
const selectionOf = (spec, schema) => {
	/** @type {Record<string, unknown>} */
	const selection = {};
	schema.groups.forEach((/** @type {any} */ group, /** @type {number} */ gi) => {
		const pick = spec.selection[gi];
		if (!pick) return;
		if (group.type === 'single')
			selection[group.key] = pick.index < 0 || pick.index >= group.options.length ? 'zz' : o(pick.index);
		else if (group.type === 'multi') selection[group.key] = pick.list.map(o);
		else selection[group.key] = pick.number;
	});
	return selection;
};

// ── the independent oracle ─────────────────────────────────────────────────────────────────────────

/** @param {unknown} v */
const empty = (v) => v === null || (Array.isArray(v) && v.length === 0);
/** @param {unknown} a @param {unknown} b */
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null) || (empty(a) && empty(b));

/**
 * Every value of a group: empty, each option / subset / number.
 * @param {any} group normalised group
 */
const valuesOf = (group) => {
	if (group.type === 'single') return [null, ...group.options.map((/** @type {any} */ option) => option.key)];
	if (group.type === 'multi') {
		const keys = group.options.map((/** @type {any} */ option) => option.key);
		return Array.from({ length: 1 << keys.length }, (_, mask) =>
			keys.filter((/** @type {string} */ _key, /** @type {number} */ i) => (mask & (1 << i)) !== 0),
		);
	}
	const values = [null];
	for (let v = group.min; v <= group.max; v += group.step) values.push(v);
	return values;
};

/**
 * @param {any} schema normalised schema
 * @param {{ inStock: string, partial: string }} options
 */
const createOracle = (schema, options) => {
	const programs = new Map();
	/** @param {string} source @param {Record<string, unknown>} selection */
	const holds = (source, selection) => {
		if (!programs.has(source)) programs.set(source, compile(source));
		const compiled = programs.get(source);
		if (!compiled.ok) throw new Error(source);
		const result = evaluateCondition(compiled.program, { selection, quantity: 1 }, { now: new Date(0) });
		return result.ok && result.value === true;
	};
	const dims = schema.groups.filter((/** @type {any} */ group) =>
		schema.combinations.some((/** @type {any} */ c) => c.options[group.key] !== undefined),
	);
	/**
	 * @param {unknown[]} values
	 * @returns {{ valid: boolean, outOfStock: boolean }}
	 */
	const check = (values) => {
		const selection = Object.fromEntries(
			schema.groups.map((/** @type {any} */ group, /** @type {number} */ gi) => [group.key, values[gi]]),
		);
		for (const [gi, group] of schema.groups.entries()) {
			const value = values[gi];
			const applies = group.when === null || holds(group.when, selection);
			if (!applies) {
				if (!empty(value)) return { valid: false, outOfStock: false };
				continue;
			}
			if (empty(value)) {
				if (group.required && options.partial === 'fill') return { valid: false, outOfStock: false };
				continue;
			}
			const keys = Array.isArray(value) ? value : group.type === 'single' ? [value] : [];
			if (group.type === 'multi' && (keys.length < group.minSelect || keys.length > group.maxSelect))
				return { valid: false, outOfStock: false };
			for (const key of keys) {
				const option = group.options.find((/** @type {any} */ candidate) => candidate.key === key);
				if (!option || option.hidden || (option.when !== null && !holds(option.when, selection)))
					return { valid: false, outOfStock: false };
			}
		}
		if (schema.rules.some((/** @type {any} */ rule) => holds(rule.when, selection))) return { valid: false, outOfStock: false };
		let combination = null;
		if (schema.combinations.length > 0) {
			const matching = schema.combinations.filter((/** @type {any} */ c) =>
				dims.every((/** @type {any} */ group) => {
					const value = selection[group.key];
					const wanted = c.options[group.key];
					return empty(value) || wanted === undefined || (Array.isArray(wanted) ? wanted.includes(value) : wanted === value);
				}),
			);
			if (matching.length === 0) return { valid: false, outOfStock: false };
			if (dims.every((/** @type {any} */ group) => !empty(selection[group.key])))
				combination = matching.find((/** @type {any} */ c) => c.stock === null || c.stock > 0) ?? matching[0];
		}
		let outOfStock = combination !== null && combination.stock !== null && combination.stock <= 0;
		for (const [gi, group] of schema.groups.entries()) {
			const value = values[gi];
			for (const key of Array.isArray(value) ? value : group.type === 'single' && value !== null ? [value] : []) {
				const option = group.options.find((/** @type {any} */ candidate) => candidate.key === key);
				if (option && option.stock !== null && option.stock <= 0) outOfStock = true;
			}
		}
		if (outOfStock && options.inStock === 'require') return { valid: false, outOfStock };
		return { valid: true, outOfStock };
	};
	/** Every valid assignment. */
	const all = () => {
		/** @type {Array<{ values: unknown[], outOfStock: boolean }>} */
		const found = [];
		const domains = schema.groups.map(valuesOf);
		/** @param {number} depth @param {unknown[]} values */
		const walk = (depth, values) => {
			if (depth === domains.length) {
				const result = check(values);
				if (result.valid) found.push({ values: [...values], outOfStock: result.outOfStock });
				return;
			}
			for (const value of domains[depth]) walk(depth + 1, [...values, value]);
		};
		walk(0, []);
		return found;
	};
	/**
	 * The picks the resolver honours (unknown and hidden options dropped, numbers snapped).
	 * @param {Record<string, unknown>} raw
	 */
	const picksOf = (raw) =>
		schema.groups.map((/** @type {any} */ group) => {
			const value = raw[group.key];
			if (value === undefined) return undefined;
			const offered = (/** @type {unknown} */ key) =>
				group.options.some((/** @type {any} */ option) => option.key === key && !option.hidden);
			if (group.type === 'single') return offered(value) ? value : undefined;
			if (group.type === 'multi') {
				const index = (/** @type {string} */ key) =>
					group.options.findIndex((/** @type {any} */ option) => option.key === key);
				return [...new Set(/** @type {string[]} */ (value).filter(offered))]
					.sort((a, b) => index(a) - index(b))
					.slice(0, group.maxSelect);
			}
			const clamped = Math.min(group.max, Math.max(group.min, /** @type {number} */ (value)));
			const snapped = group.min + Math.round((clamped - group.min) / group.step) * group.step;
			return snapped > group.max ? snapped - group.step : snapped;
		});
	return { check, all, picksOf };
};

/**
 * Build everything for one spec (null when the space is too large for the oracle).
 * @param {any} spec
 */
const scenario = (spec) => {
	const input = schemaOf(spec);
	const parsed = parseSchema(input);
	if (!parsed.ok) throw new Error(`generated an invalid schema: ${JSON.stringify(parsed.problems)}`);
	const built = compileSchema(parsed.schema);
	if (!built.ok) throw new Error(JSON.stringify(built.problems));
	const size = parsed.schema.groups.reduce((total, group) => total * valuesOf(group).length, 1);
	const oracle = createOracle(parsed.schema, spec);
	const selection = selectionOf(spec, input);
	const changed = spec.changed === null ? null : g(spec.changed % parsed.schema.groups.length);
	const options = { inStock: spec.inStock, partial: spec.partial, tieBreak: spec.tieBreak, maxSteps: 200_000 };
	return { schema: parsed.schema, compiled: built.compiled, oracle, selection, changed, options, size };
};

/** The resolution's values in group order. @param {any} schema @param {Record<string, unknown>} selection */
const valuesFrom = (schema, selection) =>
	schema.groups.map((/** @type {any} */ group) => selection[group.key] ?? (group.type === 'multi' ? [] : null));

describe('resolver properties (fast-check)', () => {
	it('always returns a valid combination, or a problem only when no valid combination exists', () => {
		const seen = { valid: 0, none: 0, adjusted: 0, matrix: 0, outOfStock: 0 };
		fc.assert(
			fc.property(specArb, (spec) => {
				const { schema, compiled, oracle, selection, changed, options, size } = scenario(spec);
				fc.pre(size <= 4000);
				const result = resolve(compiled, { selection, changed }, options);
				const valid = oracle.all();
				if (compiled.combinations) seen.matrix += 1;
				if (result.ok) {
					seen.valid += 1;
					if (!result.exact) seen.adjusted += 1;
					if (!result.inStock) seen.outOfStock += 1;
					const verdict = oracle.check(valuesFrom(schema, result.selection));
					expect(verdict.valid).toBe(true);
					expect(result.inStock).toBe(!verdict.outOfStock);
					expect(result.optimal).toBe(true);
				} else {
					seen.none += 1;
					expect(result.problem.code).toBe('no_valid_combination');
					expect(result.problem.exhaustive).toBe(true);
					expect(valid).toEqual([]);
				}
				expect(result.ok).toBe(valid.length > 0);
			}),
			{ numRuns: RUNS },
		);
		// the generator really exercises the interesting cases
		expect(seen.none).toBeGreaterThan(0);
		expect(seen.adjusted).toBeGreaterThan(RUNS / 20);
		expect(seen.matrix).toBeGreaterThan(RUNS / 10);
		expect(seen.outOfStock).toBeGreaterThan(0);
		expect(seen.valid).toBeGreaterThan(RUNS / 2);
	});

	it('returns the closest valid combination: the changed pick first, then as many other picks as possible, then stock', () => {
		fc.assert(
			fc.property(specArb, (spec) => {
				const { schema, compiled, oracle, selection, changed, options, size } = scenario(spec);
				fc.pre(size <= 4000);
				const result = resolve(compiled, { selection, changed }, options);
				fc.pre(result.ok);
				if (!result.ok) return;
				const picks = oracle.picksOf(selection);
				const pinned = changed === null ? -1 : schema.groups.findIndex((/** @type {any} */ group) => group.key === changed);
				const pinnedActive = pinned >= 0 && picks[pinned] !== undefined;
				/** @param {unknown[]} values */
				const cost = (values) => {
					const changedPin = pinnedActive && !same(values[pinned], picks[pinned]) ? 1 : 0;
					const others = picks.filter(
						(/** @type {unknown} */ pick, /** @type {number} */ gi) =>
							gi !== (pinnedActive ? pinned : -1) && pick !== undefined && !same(values[gi], pick),
					).length;
					return changedPin * 1000 + others;
				};
				const valid = oracle.all();
				const best = Math.min(...valid.map((entry) => cost(entry.values)));
				expect(cost(valuesFrom(schema, result.selection))).toBe(best);
				if (options.inStock === 'prefer' && valid.some((entry) => cost(entry.values) === best && !entry.outOfStock))
					expect(result.inStock).toBe(true);
				if (options.inStock === 'require') expect(result.inStock).toBe(true);
			}),
			{ numRuns: RUNS },
		);
	});

	it('is deterministic: same output for the same input, whatever the key order', () => {
		fc.assert(
			fc.property(specArb, (spec) => {
				const { compiled, selection, changed, options } = scenario(spec);
				const first = resolve(compiled, { selection, changed }, options);
				const again = resolve(compiled, { selection, changed }, options);
				const reversed = resolve(
					compiled,
					{ selection: Object.fromEntries(Object.entries(selection).reverse()), changed },
					options,
				);
				expect(again).toEqual(first);
				expect(reversed).toEqual(first);
			}),
			{ numRuns: RUNS },
		);
	});

	it('keeps a selection that is already valid and complete exactly as it is', () => {
		fc.assert(
			fc.property(specArb, fc.nat(), (spec, choice) => {
				const { schema, compiled, oracle, options, size } = scenario(spec);
				fc.pre(size <= 4000);
				const valid = oracle
					.all()
					.filter((entry) => entry.values.every((value, gi) => !empty(value) || !schema.groups[gi]?.required));
				fc.pre(valid.length > 0);
				const entry = /** @type {{ values: unknown[] }} */ (valid[choice % valid.length]);
				const selection = Object.fromEntries(
					schema.groups.map((/** @type {any} */ group, gi) => [group.key, entry.values[gi]]),
				);
				const result = resolve(compiled, { selection }, options);
				expect(result.ok).toBe(true);
				if (!result.ok) return;
				expect(result.exact).toBe(true);
				expect(result.adjusted).toEqual([]);
				expect(valuesFrom(schema, result.selection)).toEqual(
					entry.values.map((value, gi) => (empty(value) && schema.groups[gi]?.type === 'multi' ? [] : value)),
				);
			}),
			{ numRuns: RUNS },
		);
	});
});
