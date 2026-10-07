import { describe, expect, it } from 'vitest';
import { compileSchema } from '../core/compile.js';
import { checkSelection, combinationById, resolve, sameValue } from '../core/resolve.js';
import { parseSchema } from '../core/schema.js';
import { PHONE, compiled } from './helpers.js';

const phone = compiled(PHONE);

/** @param {any} result */
const okOf = (result) => {
	if (!result.ok) throw new Error(JSON.stringify(result.problem));
	return result;
};

describe('resolve: closest match (ported from the PDP variant selector)', () => {
	it('fills an empty selection with the first valid, in-stock combination', () => {
		const result = okOf(resolve(phone, {}));
		expect(result.selection).toEqual({ storage: '128', color: 'black' });
		expect(result).toMatchObject({
			exact: true,
			complete: true,
			inStock: true,
			optimal: true,
			combination: { id: 'v1', sku: 'PX-128-BK', inStock: true },
		});
		expect(result.filled).toEqual([
			{ group: 'storage', value: '128', source: 'auto' },
			{ group: 'color', value: 'black', source: 'auto' },
		]);
		expect(result.applicable).toEqual(['storage', 'color', 'addons']);
	});

	it('keeps an exact match as it is, even out of stock (stock only breaks ties)', () => {
		const result = okOf(resolve(phone, { selection: { storage: '256', color: 'black' } }));
		expect(result.selection).toEqual({ storage: '256', color: 'black' });
		expect(result).toMatchObject({ exact: true, inStock: false, combination: { id: 'v2', inStock: false } });
	});

	it('honours the option just clicked and realigns the others', () => {
		const result = okOf(resolve(phone, { selection: { storage: '512', color: 'pink' }, changed: 'color' }));
		expect(result.selection).toEqual({ storage: '256', color: 'pink' });
		expect(result.adjusted).toEqual([{ group: 'storage', from: '512', to: '256', reason: 'conflict' }]);
		const other = okOf(resolve(phone, { selection: { storage: '512', color: 'pink' }, changed: 'storage' }));
		expect(other.selection).toEqual({ storage: '512', color: 'black' });
		expect(other.combination?.id).toBe('v4');
	});

	it('changes the clicked group only when nothing valid keeps it', () => {
		const schema = compiled({
			name: 'x',
			groups: [
				{ key: 'a', options: [{ key: '1' }, { key: '2' }] },
				{ key: 'b', options: [{ key: 'x' }, { key: 'y' }] },
			],
			rules: [{ id: 'no-2', when: "selection.a == '2'" }],
		});
		const result = okOf(resolve(schema, { selection: { a: '2', b: 'y' }, changed: 'a' }));
		expect(result.selection).toEqual({ a: '1', b: 'y' });
		expect(result.adjusted).toEqual([{ group: 'a', from: '2', to: '1', reason: 'conflict' }]);
	});

	it('prefers, requires or ignores stock', () => {
		expect(
			okOf(resolve(phone, { selection: { color: 'black' }, changed: 'color' }, { inStock: 'prefer', tieBreak: 'price_high' }))
				.selection,
		).toEqual({
			storage: '512',
			color: 'black',
		});
		const required = okOf(
			resolve(phone, { selection: { storage: '256', color: 'black' }, changed: 'storage' }, { inStock: 'require' }),
		);
		expect(required.selection).toEqual({ storage: '256', color: 'pink' });
		expect(required.adjusted).toEqual([{ group: 'color', from: 'black', to: 'pink', reason: 'out_of_stock' }]);
		const ignored = okOf(resolve(phone, { selection: { storage: '256' } }, { inStock: 'ignore' }));
		expect(ignored.selection).toEqual({ storage: '256', color: 'black' });
		expect(ignored.inStock).toBe(false);
		const preferred = okOf(resolve(phone, { selection: { storage: '256' } }, { inStock: 'prefer' }));
		expect(preferred.selection).toEqual({ storage: '256', color: 'pink' });
	});

	it('breaks ties by schema order, price or popularity', () => {
		const schema = compiled({
			name: 'x',
			groups: [
				{
					key: 'plan',
					options: [
						{ key: 'pro', priceDelta: 300, popularity: 1 },
						{ key: 'basic', priceDelta: 100, popularity: 9 },
						{ key: 'max', priceDelta: 900, popularity: 5 },
					],
				},
			],
		});
		const pick = (/** @type {any} */ tieBreak) => okOf(resolve(schema, {}, { tieBreak })).selection.plan;
		expect([pick('schema'), pick('price_low'), pick('price_high'), pick('popularity')]).toEqual([
			'pro',
			'basic',
			'max',
			'basic',
		]);
	});

	it('uses defaults first and reports filled groups by source', () => {
		const schema = compiled({ name: 'x', groups: [{ key: 'size', default: 'M', options: [{ key: 'S' }, { key: 'M' }] }] });
		const result = okOf(resolve(schema, {}));
		expect(result.selection).toEqual({ size: 'M' });
		expect(result.filled).toEqual([{ group: 'size', value: 'M', source: 'default' }]);
	});

	it('keeps partial selections partial with partial: keep', () => {
		const result = okOf(resolve(phone, { selection: { color: 'pink' } }, { partial: 'keep' }));
		expect(result.selection).toEqual({ color: 'pink' });
		expect(result).toMatchObject({ complete: false, missing: ['storage'], combination: null });
	});

	it('resets to defaults with fallback: defaults, and rejects with a suggestion with fallback: reject', () => {
		const schema = compiled({
			name: 'x',
			groups: [
				{ key: 'a', default: '1', options: [{ key: '1' }, { key: '2' }, { key: '3' }] },
				{ key: 'b', default: 'x', options: [{ key: 'x' }, { key: 'y' }] },
				{ key: 'c', default: 'p', options: [{ key: 'p' }, { key: 'q' }] },
			],
			rules: [{ id: 'r', when: "selection.b == 'y' and selection.c == 'q'" }],
		});
		const closest = okOf(resolve(schema, { selection: { a: '3', b: 'y', c: 'q' }, changed: 'b' }));
		expect(closest.selection).toEqual({ a: '3', b: 'y', c: 'p' });
		const defaults = okOf(resolve(schema, { selection: { a: '3', b: 'y', c: 'q' }, changed: 'b' }, { fallback: 'defaults' }));
		expect(defaults.selection).toEqual({ a: '1', b: 'y', c: 'p' });
		expect(defaults.adjusted.map((/** @type {any} */ change) => change.group)).toEqual(['a', 'c']);
		const exact = okOf(resolve(schema, { selection: { a: '3', b: 'y', c: 'p' } }, { fallback: 'defaults' }));
		expect(exact.selection).toEqual({ a: '3', b: 'y', c: 'p' });
		const rejected = resolve(schema, { selection: { a: '3', b: 'y', c: 'q' }, changed: 'b' }, { fallback: 'reject' });
		expect(rejected).toEqual({
			ok: false,
			problem: {
				code: 'selection_invalid',
				detail: 'The selection is not a valid combination.',
				exhaustive: true,
				suggestion: { a: '3', b: 'y', c: 'p' },
				adjusted: [{ group: 'c', from: 'q', to: 'p', reason: 'conflict' }],
			},
		});
		expect(resolve(schema, { selection: { a: 'zz' } }, { fallback: 'reject' })).toMatchObject({
			ok: false,
			problem: { code: 'selection_invalid' },
		});
		expect(okOf(resolve(schema, { selection: { a: '2' } }, { fallback: 'reject' })).selection).toEqual({
			a: '2',
			b: 'x',
			c: 'p',
		});
	});

	it('answers a clear problem when no combination exists', () => {
		const schema = compiled({
			name: 'x',
			groups: [{ key: 'a', options: [{ key: '1' }] }],
			rules: [{ id: 'never', when: "selection.a == '1'" }],
		});
		expect(resolve(schema, {})).toEqual({
			ok: false,
			problem: {
				code: 'no_valid_combination',
				detail: 'No combination of the options satisfies the rules.',
				exhaustive: true,
			},
		});
	});

	it('stops at the step budget and says so', () => {
		const groups = Array.from({ length: 6 }, (_, i) => ({
			key: `g${i}`,
			options: Array.from({ length: 6 }, (_, j) => ({ key: `o${j}` })),
		}));
		const schema = compiled({ name: 'x', groups, rules: [{ id: 'all-last', when: "selection.g5 != 'o5'" }] });
		const cut = resolve(schema, {}, { maxSteps: 10 });
		expect(cut).toEqual({
			ok: false,
			problem: {
				code: 'no_valid_combination',
				detail: 'No valid combination was found within the search budget.',
				exhaustive: false,
			},
		});
		const found = okOf(resolve(schema, {}, { maxSteps: Number.NaN }));
		expect(found.selection.g5).toBe('o5');
		expect(okOf(resolve(schema, {}, { maxSteps: 5000 })).optimal).toBe(true);
	});

	it('applies group and option conditions (dependencies)', () => {
		const schema = compiled({
			name: 'Plan',
			groups: [
				{ key: 'plan', options: [{ key: 'team' }, { key: 'business' }] },
				{ key: 'region', when: "selection.plan == 'business'", options: [{ key: 'eu' }, { key: 'us' }] },
				{
					key: 'addons',
					type: 'multi',
					required: false,
					options: [{ key: 'sso', when: "selection.plan == 'business'" }, { key: 'audit' }],
				},
			],
		});
		const team = okOf(
			resolve(schema, { selection: { plan: 'team', region: 'us', addons: ['sso', 'audit'] }, changed: 'plan' }),
		);
		expect(team.selection).toEqual({ plan: 'team', addons: ['audit'] });
		expect(team.applicable).toEqual(['plan', 'addons']);
		expect(team.adjusted).toEqual([
			{ group: 'region', from: 'us', to: null, reason: 'not_applicable' },
			{ group: 'addons', from: ['sso', 'audit'], to: ['audit'], reason: 'conflict' },
		]);
		const business = okOf(resolve(schema, { selection: { plan: 'business', addons: ['sso'] } }));
		expect(business.selection).toEqual({ plan: 'business', region: 'eu', addons: ['sso'] });
		expect(business.states.find((/** @type {any} */ s) => s.key === 'region')?.applicable).toBe(true);
	});

	it('sanitises input: unknown groups and options, multi caps, range snapping, text cleaning, quantity', () => {
		const schema = compiled({
			name: 'x',
			groups: [
				{ key: 'size', options: [{ key: 'S' }, { key: 'M', hidden: true }] },
				{ key: 'extras', type: 'multi', required: false, maxSelect: 1, options: [{ key: 'a' }, { key: 'b' }] },
				{ key: 'seats', type: 'range', min: 1, max: 10, step: 3 },
				{ key: 'note', type: 'text', required: false, maxLength: 5 },
				{ key: 'more', type: 'multi', required: false, options: [{ key: 'z' }] },
			],
		});
		const result = okOf(
			resolve(schema, {
				selection: { size: 'M', extras: ['b', 'a'], seats: 99, note: 'hello\u0007world', zz: 1, more: 'z' },
				quantity: 9_999_999,
			}),
		);
		expect(result.selection).toEqual({ size: 'S', extras: ['a'], seats: 10, note: 'hello', more: ['z'] });
		expect(result.adjusted).toEqual([
			{ group: 'size', from: 'M', to: null, reason: 'unknown_option' },
			{ group: 'extras', from: ['b', 'a'], to: ['a'], reason: 'too_many' },
			{ group: 'seats', from: 99, to: 10, reason: 'clamped' },
			{ group: 'note', from: 'hello\u0007world', to: 'hello', reason: 'truncated' },
		]);
		expect(result.ignored).toEqual(['zz']);
		expect(result.quantity).toBe(100_000);
		const odd = okOf(resolve(schema, { selection: { seats: 'x', note: 5, extras: ['q'], size: null }, quantity: 0 }));
		expect(odd.adjusted.map((/** @type {any} */ change) => change.reason)).toEqual([
			'unknown_option',
			'invalid_number',
			'invalid_text',
		]);
		expect(odd.quantity).toBe(1);
		expect(odd.selection.seats).toBeUndefined();
		expect(okOf(resolve(schema, { selection: /** @type {any} */ ([]) })).selection.size).toBe('S');
		expect(okOf(resolve(schema, { selection: { note: '' } })).selection.note).toBeUndefined();
	});

	it('searches range groups and reports text groups the shopper must fill', () => {
		const schema = compiled({
			name: 'x',
			groups: [
				{ key: 'plan', options: [{ key: 'team' }, { key: 'business' }] },
				{ key: 'seats', type: 'range', min: 1, max: 50, required: true, default: 5 },
				{ key: 'company', type: 'text', required: true },
			],
			rules: [{ id: 'team-max', when: "selection.plan == 'team' and selection.seats > 20" }],
		});
		const result = okOf(resolve(schema, { selection: { plan: 'team', seats: 30 }, changed: 'plan' }));
		expect(result.selection).toEqual({ plan: 'team', seats: 20 });
		expect(result).toMatchObject({ complete: false, missing: ['company'] });
		const big = compiled({
			name: 'x',
			groups: [{ key: 'n', type: 'range', min: 0, max: 100_000, required: true }],
			rules: [{ id: 'r', when: 'selection.n < 777' }],
		});
		const found = okOf(resolve(big, { selection: { n: 3 } }));
		expect(found.selection.n).toBeGreaterThanOrEqual(777);
		expect(okOf(resolve(big, {})).selection.n).toBeGreaterThanOrEqual(777);
	});

	it('searches multi-choice groups with many options heuristically', () => {
		const options = Array.from({ length: 9 }, (_, i) => ({ key: `o${i}` }));
		const schema = compiled({
			name: 'x',
			groups: [{ key: 'm', type: 'multi', minSelect: 2, maxSelect: 3, required: true, options, default: ['o1', 'o2'] }],
		});
		expect(okOf(resolve(schema, {})).selection.m).toEqual(['o1', 'o2']);
		const picked = okOf(resolve(schema, { selection: { m: ['o3', 'o4', 'o5'] } }));
		expect(picked.selection.m).toEqual(['o3', 'o4', 'o5']);
		const ruled = compiled({
			name: 'x',
			groups: [{ key: 'm', type: 'multi', minSelect: 1, options }],
			rules: [{ id: 'r', when: "'o0' in selection.m" }],
		});
		expect(okOf(resolve(ruled, { selection: { m: ['o0', 'o7'] } })).selection.m).toEqual(['o7']);
	});

	it('marks option states for the widget', () => {
		const result = okOf(resolve(phone, {}));
		expect(result.states).toEqual([
			{
				key: 'storage',
				applicable: true,
				options: [
					{ key: '128', state: 'selected' },
					{ key: '256', state: 'out_of_stock' },
					{ key: '512', state: 'available' },
				],
			},
			{
				key: 'color',
				applicable: true,
				options: [
					{ key: 'black', state: 'selected' },
					{ key: 'pink', state: 'conflict' },
					{ key: 'gold', state: 'conflict' },
				],
			},
			{
				key: 'addons',
				applicable: true,
				options: [
					{ key: 'case', state: 'available' },
					{ key: 'charger', state: 'conflict' },
				],
			},
		]);
		const range = compiled({ name: 'x', groups: [{ key: 'n', type: 'range', min: 0, max: 2 }] });
		expect(okOf(resolve(range, {})).states).toEqual([{ key: 'n', applicable: true, options: [] }]);
		expect(okOf(resolve(phone, {}, { states: false })).states).toEqual([]);
	});

	it('treats option stock like combination stock', () => {
		const schema = compiled({
			name: 'x',
			groups: [
				{
					key: 'size',
					options: [
						{ key: 'S', stock: 0 },
						{ key: 'M', stock: 4 },
					],
				},
			],
		});
		expect(okOf(resolve(schema, {})).selection.size).toBe('M');
		const sold = okOf(resolve(schema, { selection: { size: 'S' } }));
		expect(sold).toMatchObject({ exact: true, inStock: false });
		expect(okOf(resolve(schema, { selection: { size: 'S' } }, { inStock: 'require' })).adjusted[0]?.reason).toBe(
			'out_of_stock',
		);
	});

	it('reads quantity and the clock in conditions', () => {
		const schema = compiled({
			name: 'x',
			groups: [{ key: 'ship', options: [{ key: 'pallet', when: 'quantity >= 10' }, { key: 'parcel' }] }],
			rules: [{ id: 'closed', when: "selection.ship == 'parcel' and dateParts(now).year > 2030" }],
		});
		expect(okOf(resolve(schema, { quantity: 12 })).selection.ship).toBe('pallet');
		expect(okOf(resolve(schema, { quantity: 1 })).selection.ship).toBe('parcel');
		expect(resolve(schema, { quantity: 1 }, { now: Date.parse('2031-01-01T00:00:00Z') })).toMatchObject({ ok: false });
	});
});

describe('checkSelection (strict, for quotes)', () => {
	it('accepts a valid complete selection and explains everything else', () => {
		expect(checkSelection(phone, { selection: { storage: '128', color: 'black', addons: ['case'] }, quantity: 2 })).toEqual({
			valid: true,
			complete: true,
			missing: [],
			inStock: true,
			violations: [],
			combination: { id: 'v1', sku: 'PX-128-BK', inStock: true },
			selection: { storage: '128', color: 'black', addons: ['case'] },
			quantity: 2,
		});
		const invalid = checkSelection(phone, { selection: { storage: '512', color: 'pink', addons: ['charger', 'x'], zz: 1 } });
		expect(invalid.valid).toBe(false);
		expect(invalid.violations).toEqual([
			{ group: 'addons', reason: 'unknown_option' },
			{ group: 'zz', reason: 'unknown_group' },
			{ rule: 'no-pink-512', message: 'Pink stops at 256.', reason: 'excluded' },
			{ reason: 'no_combination' },
		]);
		expect(checkSelection(phone, { selection: { color: 'black' } })).toMatchObject({
			valid: true,
			complete: false,
			missing: ['storage'],
			combination: null,
		});
		expect(checkSelection(phone, { selection: { storage: '256', color: 'black' } }, { inStock: 'require' })).toMatchObject({
			valid: false,
			inStock: false,
		});
		expect(checkSelection(phone, { selection: /** @type {any} */ (null), quantity: -3 })).toMatchObject({
			quantity: 1,
			complete: false,
		});
	});

	it('finds the combination of a resolution', () => {
		expect(combinationById(phone, { id: 'v3' })?.price).toBe(60000);
		expect(combinationById(phone, null)).toBeNull();
		expect(combinationById(compiled({ name: 'x', groups: [{ key: 'a', options: [{ key: '1' }] }] }), { id: 'v1' })).toBeNull();
		expect(sameValue(['a'], ['a'])).toBe(true);
		expect(sameValue([], null)).toBe(true);
		expect(sameValue(['a'], 'a')).toBe(false);
	});

	it('compiles away unavailable combinations and reports compile problems', () => {
		const parsed = parseSchema({
			name: 'x',
			groups: [{ key: 'a', options: [{ key: '1' }, { key: '2' }] }],
			combinations: [
				{ id: 'c1', options: { a: '1' }, available: false },
				{ id: 'c2', options: { a: '2' } },
			],
		});
		if (!parsed.ok) throw new Error('fixture');
		const built = compileSchema(parsed.schema);
		expect(built.ok && built.compiled.combinations?.map((c) => c.id)).toEqual(['c2']);
		const broken = compileSchema({
			...parsed.schema,
			rules: [{ id: 'r', when: 'selection.zz ==', message: null }],
			groups: [{ .../** @type {any} */ (parsed.schema.groups[0]), when: 'selection.nope == 1' }],
		});
		expect(broken.ok ? [] : broken.problems.map((p) => p.code)).toEqual(['unknown_group', 'rule_invalid']);
		const all = compileSchema({ ...parsed.schema, rules: [{ id: 'r', when: 'len(selection) > 5', message: null }] });
		expect(all.ok && [...all.compiled.referenced]).toEqual([0]);
	});
});
