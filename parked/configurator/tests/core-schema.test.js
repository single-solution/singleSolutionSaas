import { describe, expect, it } from 'vitest';
import { compileSchema } from '../core/compile.js';
import { effectiveConfig } from '../core/config.js';
import { checkCondition, compileCondition, holds } from '../core/rules.js';
import { parseSchema } from '../core/schema.js';
import { validateEvaluation, validateLifecycle, validateQuote, validateUrlParams } from '../core/validate.js';
import { configuratorView, publicView, summaryView } from '../core/views.js';
import { SAMPLES } from '../api/samples.js';
import { PHONE } from './helpers.js';

/** @param {unknown} input @param {Record<string, number>} [limits] */
const problems = (input, limits) => {
	const result = parseSchema(input, limits);
	return result.ok ? [] : result.problems.map((p) => `${p.path} ${p.code}`);
};

describe('parseSchema', () => {
	it('normalises a schema with defaults for every field', () => {
		const result = parseSchema(PHONE);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const [storage, color, addons] = result.schema.groups;
		expect(storage).toMatchObject({
			key: 'storage',
			label: 'Storage',
			type: 'single',
			required: true,
			display: null,
			attribute: null,
			default: null,
		});
		expect(storage?.options[0]).toEqual({
			key: '128',
			label: '128',
			description: null,
			swatch: null,
			image: null,
			hidden: false,
			when: null,
			priceDelta: 0,
			stock: null,
			popularity: 0,
		});
		expect(color?.display).toBe('swatches');
		expect(addons).toMatchObject({ type: 'multi', required: false, minSelect: 0, maxSelect: 200 });
		expect(result.schema.source).toEqual({ type: 'standalone' });
		expect(result.schema.combinations[3]?.options.color).toEqual(['black', 'gold']);
		expect(result.schema.pricing).toEqual({ base: null, currency: 'EUR', rules: [], rounding: null });
	});

	it('accepts every sample (apparel, a computer, a SaaS plan builder)', () => {
		for (const sample of SAMPLES) {
			const parsed = parseSchema(sample);
			expect(parsed.ok, JSON.stringify(parsed.ok ? null : parsed.problems)).toBe(true);
			if (parsed.ok) expect(compileSchema(parsed.schema).ok).toBe(true);
		}
	});

	it('reports every structural problem with a JSON pointer', () => {
		expect(problems(null)).toEqual([' type']);
		expect(problems({})).toEqual(['/name required', '/groups required']);
		expect(problems({ name: 'x', groups: [{ key: '1bad', options: [{ key: 'a' }] }] })).toEqual(['/groups/0/key pattern']);
		expect(
			problems({
				key: 'Bad Key',
				name: 'x'.repeat(201),
				description: 3,
				groups: [
					{
						key: 'a',
						display: 'grid',
						options: [{ key: ' a' }, { key: 'b', swatch: 'red', image: 'http://x' }, { key: 'b' }, 'x'],
					},
					{ key: 'a', options: [] },
					'x',
					{ key: 'z', type: 'nope' },
				],
			}),
		).toEqual([
			'/key pattern',
			'/name too_long',
			'/description type',
			'/groups/0/display enum',
			'/groups/0/options/0/key invalid',
			'/groups/0/options/1/swatch pattern',
			'/groups/0/options/1/image pattern',
			'/groups/0/options/2/key duplicate',
			'/groups/0/options/3 type',
			'/groups/1/key duplicate',
			'/groups/1/options required',
			'/groups/2 type',
			'/groups/3/type enum',
		]);
	});

	it('checks type-specific fields and defaults', () => {
		expect(
			problems({
				name: 'x',
				groups: [
					{ key: 'r', type: 'range', max: 1, default: 3 },
					{ key: 's', type: 'range', min: 5, max: 1 },
					{ key: 'm', type: 'multi', minSelect: 3, maxSelect: 1, options: [{ key: 'a' }], default: ['a', 'a'] },
					{ key: 't', type: 'text', maxLength: 0, default: 5 },
					{ key: 'u', options: [{ key: 'a' }], default: 'zz', min: 1, minSelect: 1, maxLength: 3 },
					{ key: 'v', type: 'range', min: 0, max: 4, step: 2, default: 3, options: [{ key: 'a' }] },
				],
			}),
		).toEqual([
			'/groups/0/min required',
			'/groups/0/default type',
			'/groups/1/max range',
			'/groups/2/maxSelect range',
			'/groups/2/default unknown_option',
			'/groups/3/maxLength range',
			'/groups/3/default invalid',
			'/groups/4 not_allowed',
			'/groups/4 not_allowed',
			'/groups/4 not_allowed',
			'/groups/4/default unknown_option',
			'/groups/5/options not_allowed',
			'/groups/5/default range',
		]);
		const ok = parseSchema({
			name: 'x',
			groups: [
				{ key: 'm', type: 'multi', options: [{ key: 'a' }, { key: 'b' }], default: ['b', 'a'], maxSelect: 2 },
				{ key: 'r', type: 'range', min: 0, max: 10, step: 5, default: 5, unitPrice: 100 },
				{ key: 't', type: 'text', default: 'hi' },
			],
		});
		expect(ok.ok && ok.schema.groups.map((group) => group.default)).toEqual([['a', 'b'], 5, 'hi']);
	});

	it('validates rules, combinations and pricing', () => {
		expect(
			problems({
				name: 'x',
				groups: [
					{ key: 'a', options: [{ key: '1' }] },
					{ key: 'm', type: 'multi', options: [{ key: '1' }] },
				],
				rules: [
					{ id: 'r', when: 'selection.zz == 1' },
					{ id: 'r', when: 'bad ==' },
					{ id: 'q' },
					{ id: 'p', when: 'order.total > 1' },
					'x',
				],
				combinations: [
					{ id: 'c', options: { a: '9' } },
					{ id: 'c', options: { m: '1' } },
					{ id: 'd', options: { zz: '1' } },
					{ id: 'e', options: {} },
					{ id: 'f', options: { a: [] } },
					'x',
				],
				pricing: {
					currency: 'eur',
					base: -1,
					rules: [{ id: 'x' }, { id: 'x', amount: 1, when: 'selection.a ==' }, 3],
					rounding: { mode: 'odd', increment: 10, ending: 10 },
				},
			}),
		).toEqual([
			'/rules/1/id duplicate',
			'/rules/1/when rule_invalid',
			'/rules/2/when required',
			'/rules/3/when rule_invalid',
			'/rules/4 type',
			'/combinations/0/options/a unknown_option',
			'/combinations/1/id duplicate',
			'/combinations/1/options/m not_allowed',
			'/combinations/2/options/zz unknown_group',
			'/combinations/3/options required',
			'/combinations/4/options/a invalid',
			'/combinations/5 type',
			'/pricing/currency pattern',
			'/pricing/rules/0 required',
			'/pricing/rules/1/id duplicate',
			'/pricing/rules/1/when rule_invalid',
			'/pricing/rules/2 type',
			'/pricing/rounding/mode enum',
			'/pricing/rounding/ending range',
			'/pricing/base range',
			'/rules/0/when unknown_group',
		]);
		expect(
			problems({ name: 'x', groups: [{ key: 'a', options: [{ key: '1' }] }], rules: 'x', combinations: 'x', pricing: 'x' }),
		).toEqual(['/rules type', '/combinations type', '/pricing type']);
		expect(
			problems({ name: 'x', groups: [{ key: 'a', options: [{ key: '1' }] }], pricing: { rules: 'x', rounding: 'x' } }),
		).toEqual(['/pricing/rules type', '/pricing/rounding type']);
	});

	it('applies the website limits', () => {
		const groups = [
			{ key: 'a', options: [{ key: '1' }, { key: '2' }] },
			{ key: 'b', options: [{ key: '1' }] },
		];
		expect(problems({ name: 'x', groups }, { groups: 1 })).toEqual(['/groups too_many']);
		expect(problems({ name: 'x', groups }, { options: 1 })).toEqual(['/groups/0/options too_many']);
		expect(problems({ name: 'x', groups, rules: [{ id: 'r', when: 'true' }] }, { rules: 0 })).toEqual(['/rules too_many']);
		expect(problems({ name: 'x', groups, combinations: [{ id: 'c', options: { a: '1' } }] }, { combinations: 0 })).toEqual([
			'/combinations too_many',
		]);
		expect(problems({ name: 'x', groups, pricing: { rules: [{ id: 'p', amount: 1 }] } }, { priceRules: 0 })).toEqual([
			'/pricing/rules too_many',
		]);
	});

	it('supports catalog-linked configurators (options from the variants, no combinations)', () => {
		const linked = parseSchema({
			name: 'x',
			source: { type: 'catalog', itemId: 'itm_1' },
			groups: [{ key: 'size' }, { key: 'note', type: 'text' }],
		});
		expect(linked.ok && linked.schema.groups[0]).toMatchObject({ attribute: 'size', options: [] });
		expect(problems({ name: 'x', source: { type: 'catalog' }, groups: [{ key: 'size' }] })).toEqual([
			'/source/itemId required',
		]);
		expect(problems({ name: 'x', source: { type: 'catalog', itemId: 'bad id' }, groups: [{ key: 'size' }] })).toEqual([
			'/source/itemId pattern',
		]);
		expect(problems({ name: 'x', source: { type: 'x' }, groups: [{ key: 's', options: [{ key: '1' }] }] })).toEqual([
			'/source/type enum',
		]);
		expect(problems({ name: 'x', source: 3, groups: [{ key: 's', options: [{ key: '1' }] }] })).toEqual(['/source type']);
		expect(
			problems({
				name: 'x',
				source: { type: 'catalog', itemId: 'i' },
				groups: [{ key: 's', attribute: '9' }],
				combinations: [{ id: 'c', options: { s: 'x' } }],
			}),
		).toEqual(['/groups/0/attribute pattern', '/combinations not_allowed']);
	});
});

describe('rules@1 conditions', () => {
	it('compile, report the groups read and evaluate (errors never match)', () => {
		expect(compileCondition('  ')).toEqual({ ok: true, condition: null });
		expect(compileCondition(3)).toMatchObject({ ok: false, error: { code: 'type' } });
		expect(compileCondition("selection.b == 'x' and quantity > 1 and 'y' in selection.a")).toMatchObject({
			ok: true,
			condition: { groups: ['a', 'b'] },
		});
		expect(compileCondition('len(selection) > 1')).toMatchObject({ ok: true, condition: { groups: null } });
		expect(compileCondition('customer.tier == 1')).toMatchObject({ ok: false, error: { code: 'unknown_identifier' } });
		const compiled = compileCondition('selection.a > 2');
		if (!compiled.ok || !compiled.condition) throw new Error('compile');
		expect(holds(compiled.condition, { selection: { a: 3 } }, { now: 0 })).toBe(true);
		expect(holds(compiled.condition, { selection: { a: 'x' } }, { now: 0 })).toBe(false);
		expect(checkCondition('')).toMatchObject({ ok: true, paths: [] });
		expect(checkCondition('order.x == 1').warnings.length).toBeGreaterThan(0);
	});
});

describe('effective configuration', () => {
	it('overlays typed values inside enums and bounds on the schema defaults', () => {
		const schema = {
			properties: {
				mode: { type: 'string', enum: ['a', 'b'], default: 'a' },
				count: { type: 'integer', minimum: 1, maximum: 5, default: 2 },
				on: { type: 'boolean', default: true },
				list: { type: 'array', default: [] },
				ratio: { type: 'number', default: 0.5 },
				map: { type: 'object', default: {} },
				any: { default: null },
			},
		};
		expect(
			effectiveConfig(schema, { mode: 'b', count: 9, on: 'yes', list: ['x'], ratio: 2, map: [], any: 3, extra: 1 }),
		).toEqual({
			mode: 'b',
			count: 2,
			on: true,
			list: ['x'],
			ratio: 2,
			map: {},
			any: 3,
		});
		expect(effectiveConfig(schema, { mode: 'c', count: 0 })).toMatchObject({ mode: 'a', count: 2 });
		expect(effectiveConfig({}, null)).toEqual({});
	});
});

describe('request validation', () => {
	it('checks and caps evaluation, quote and URL bodies', () => {
		expect(validateEvaluation(null, { maxQuantity: 5 })).toEqual([{ path: '', code: 'type', message: 'must be an object' }]);
		expect(
			validateEvaluation(
				{
					configurator: 'phone-x',
					selection: { a: 'x', b: ['y'], c: 3, d: null },
					changed: 'a',
					quantity: 2,
					search: '?a=1',
				},
				{ maxQuantity: 5 },
			),
		).toEqual([]);
		expect(
			validateEvaluation(
				{
					configurator: 'bad id',
					selection: { ['k'.repeat(65)]: 1, a: 'x'.repeat(2001), b: [1], c: {} },
					changed: 5,
					quantity: 9,
					search: 3,
				},
				{ maxQuantity: 5 },
			).map((p) => `${p.path} ${p.code}`),
		).toEqual([
			'/configurator required',
			`/selection/${'k'.repeat(65)} too_long`,
			'/selection/a too_long',
			'/selection/b invalid',
			'/selection/c type',
			'/changed invalid',
			'/quantity range',
			'/search invalid',
		]);
		expect(validateEvaluation({ configurator: 'a', selection: [] }, { maxQuantity: 5 })).toEqual([
			{ path: '/selection', code: 'type', message: 'must be an object' },
		]);
		expect(
			validateEvaluation(
				{ configurator: 'a', selection: Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`k${i}`, 1])) },
				{ maxQuantity: 5 },
			),
		).toEqual([{ path: '/selection', code: 'too_many' }]);
		expect(validateQuote({ configurator: 'a' }, { maxQuantity: 5 })).toEqual([{ path: '/selection', code: 'required' }]);
		expect(validateQuote('x', { maxQuantity: 5 })).toHaveLength(1);
		expect(validateQuote({ configurator: 'a', selection: {}, quantity: 1 }, { maxQuantity: 5 })).toEqual([]);
		expect(validateUrlParams({ configurator: 'a' }, 'parse')).toEqual([{ path: '/search', code: 'required' }]);
		expect(validateUrlParams({ configurator: 'a', selection: {} }, 'build')).toEqual([]);
		expect(validateUrlParams(1, 'build')).toHaveLength(1);
		expect(validateLifecycle({ status: 'x' }, { update: true }).map((p) => p.path)).toEqual(['/status', '/version']);
		expect(validateLifecycle({ status: 'published', version: 2 }, { update: true })).toEqual([]);
		expect(validateLifecycle([], { update: false })).toHaveLength(1);
	});
});

describe('views', () => {
	it('expose the definition, a summary and the public concrete view (stock as flags)', () => {
		const parsed = parseSchema(PHONE);
		if (!parsed.ok) throw new Error('fixture');
		const record = {
			id: 'cfg_1',
			key: 'phone-x',
			name: 'Phone X',
			status: /** @type {const} */ ('published'),
			version: 2,
			schema: parsed.schema,
			createdAt: 'a',
			updatedAt: 'b',
			publishedAt: 'c',
		};
		expect(configuratorView(record)).toMatchObject({ id: 'cfg_1', version: 2, schema: parsed.schema });
		expect(summaryView(record)).toEqual({
			id: 'cfg_1',
			key: 'phone-x',
			name: 'Phone X',
			status: 'published',
			version: 2,
			groups: ['storage', 'color', 'addons'],
			source: { type: 'standalone' },
			updatedAt: 'b',
		});
		const view = publicView(record, parsed.schema);
		expect(view.schema.combinations.map((c) => c.stock)).toEqual([1, 0, 1, 1]);
		expect(view.itemId).toBeNull();
		expect(parseSchema(view.schema).ok).toBe(true);
		const linked = {
			...record,
			schema: { ...parsed.schema, source: /** @type {const} */ ({ type: 'catalog', itemId: 'itm_1' }) },
		};
		const withStock = {
			...parsed.schema,
			groups: parsed.schema.groups.map((group) => ({
				...group,
				options: group.options.map((option) => ({ ...option, stock: 7 })),
			})),
		};
		const linkedView = publicView(linked, withStock);
		expect(linkedView.itemId).toBe('itm_1');
		expect(linkedView.schema.source).toEqual({ type: 'standalone' });
		expect(linkedView.schema.groups[0]?.options[0]?.stock).toBe(1);
	});
});
