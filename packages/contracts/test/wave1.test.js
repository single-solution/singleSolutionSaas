import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
	MANIFEST_RULES,
	PLACEMENT_MEMBERS,
	checkFeatureSchema,
	readsOf,
	validateFeatureConfig,
	validateManifest,
} from '../src/index.js';
import { GZIP_LEVEL, gzipSize, measureBundle, relativeImports, resolveModule, toKb } from '../src/budget.js';
import { manifest, packManifest, placement } from '../src/testing.js';
import { expectProblem, expectRule } from './helpers.js';

/**
 * A placement feature (F.18) on the pack fixture.
 * @param {Record<string, unknown>} [node]
 * @param {Array<{ code: string, elements: string[] }>} [plans]
 * @returns {any}
 */
const withPlacement = (node = {}, plans = undefined) => {
	const m = /** @type {any} */ (packManifest());
	m.elements[0].features = {
		type: 'object',
		properties: {
			placement: {
				type: 'object',
				title: 'Placement',
				default: { selectors: [{ selector: 'body', position: 'prepend' }], frequency: { dismissMemory: 'P7D' } },
				'x-kind': 'placement',
				...node,
			},
		},
	};
	if (plans) m.plans = plans;
	return m;
};

describe('placement feature kind', () => {
	it('accepts a placement feature and validates values against the full placement v1 schema', () => {
		const m = withPlacement();
		const checked = validateManifest(m);
		expect(checked.ok, JSON.stringify(checked)).toBe(true);
		const schema = m.elements[0].features;
		expect(validateFeatureConfig(schema, { placement: placement() }).ok).toBe(true);
		expectProblem(validateFeatureConfig(schema, { placement: { triggers: [{ type: 'scroll' }] } }), '/placement/triggers/0');
		expectProblem(
			validateFeatureConfig(schema, { placement: { frequency: { cooldown: 'soon' } } }),
			'/placement/frequency/cooldown',
		);
		expectProblem(validateFeatureConfig(schema, { placement: { unknown: true } }), '/placement/unknown');
		// semantic checks (IANA time zone) run on placement values
		expectProblem(
			validateFeatureConfig(schema, { placement: { schedule: { timezone: 'Mars/Olympus' } } }),
			'/placement/schedule/timezone',
		);
	});

	it('narrows members with x-placement and bounds plans with x-plan members', () => {
		const m = withPlacement({ 'x-placement': { members: ['selectors', 'frequency', 'audience'] } }, [
			{ code: 'starter', elements: ['bar'] },
		]);
		m.elements[0].features.properties.placement['x-plan'] = { starter: { members: ['selectors', 'frequency'] } };
		expect(validateManifest(m).ok).toBe(true);
		const schema = m.elements[0].features;
		expectProblem(validateFeatureConfig(schema, { placement: { devices: ['mobile'] } }), '/placement');
		expect(validateFeatureConfig(schema, { placement: { audience: "page.path == '/'" } }).ok).toBe(true);
		expect(PLACEMENT_MEMBERS).toContain('frequency');
	});

	it('reports misuse of a placement feature', () => {
		const problems = checkFeatureSchema(
			{
				type: 'object',
				properties: {
					p: {
						type: 'string',
						'x-kind': 'placement',
						properties: {},
						'x-placement': { members: ['paths'] },
						default: { audience: 'x' },
						'x-plan': {
							pro: { max: 3, members: ['devices'], default: { triggers: [] } },
							starter: { members: ['paths'] },
						},
					},
					q: { type: 'object', 'x-placement': {}, title: 'Q', default: {} },
				},
			},
			{ planCodes: ['pro'] },
		);
		for (const keyword of [
			MANIFEST_RULES.featurePlacement,
			MANIFEST_RULES.featureRequired,
			MANIFEST_RULES.unknownPlan,
			MANIFEST_RULES.boundType,
			MANIFEST_RULES.planDefaultExceedsMax,
		])
			expectRule(problems, keyword);
		const nested = checkFeatureSchema({
			type: 'object',
			properties: {
				o: { type: 'object', title: 'O', default: {}, properties: { p: { type: 'object', 'x-kind': 'placement' } } },
			},
		});
		expectRule(nested, MANIFEST_RULES.featurePlacement, '/properties/o/properties/p/x-kind');
	});
});

describe('manifest reads, shared budget and optional resources', () => {
	it('normalises and checks reads', () => {
		const m = packManifest();
		m.reads = ['catalog', { product: 'search', scopes: ['search.read'] }];
		m.budget = { shared: 4 };
		m.elements[0].stringKeys = ['bar.*', 'common.title'];
		expect(validateManifest(m).ok).toBe(true);
		expect(readsOf(m)).toEqual([
			{ product: 'catalog', scopes: ['catalog.read'] },
			{ product: 'search', scopes: ['search.read'] },
		]);
		expect(readsOf({})).toEqual([]);
		expect(readsOf({ reads: [{ product: 'deals' }] })).toEqual([{ product: 'deals', scopes: ['deals.read'] }]);
		m.reads = ['notice-bar', 'catalog', 'catalog', { product: 'deals', scopes: ['catalog.read'] }];
		const result = validateManifest(m);
		expectProblem(result, '/reads/0', MANIFEST_RULES.selfRead);
		expectProblem(result, '/reads/2', MANIFEST_RULES.duplicateRead);
		expectProblem(result, '/reads/3/scopes/0', MANIFEST_RULES.readScope);
	});

	it('accepts optional resources and refuses ones that are also required', () => {
		const m = manifest();
		m.elements[0].requires = { resources: ['database'], optionalResources: ['storage'] };
		expect(validateManifest(m).ok).toBe(true);
		m.elements[0].requires = { resources: ['database'], optionalResources: ['database'] };
		expectProblem(validateManifest(m), '/elements/0/requires/optionalResources/0', MANIFEST_RULES.optionalResourceRequired);
	});
});

describe('bundle budget measurement', () => {
	const files = new Map(
		Object.entries({
			'headless/a.js': 'import{x as a}from"./../chunks/chunk-1.js";export const createA=()=>a;',
			'ui/a.js': 'import"../chunks/chunk-1.js";export const render=()=>null;import("./lazy.js");',
			'ui/lazy.js': 'export const lazy=1;',
			'headless/b.js': 'export{y as createB}from"../chunks/chunk-2.js";',
			'ui/shared.js': 'export const render=()=>1;',
			'chunks/chunk-1.js': 'export const x=1;'.repeat(20),
			'chunks/chunk-2.js': 'import"../missing.js";export const y=2;',
			'outside.js': 'import"../../escape.js";',
		}),
	);
	it('counts element entries on their own and every shared module once', () => {
		const result = measureBundle({
			elements: [
				{ key: 'a', modules: ['headless/a.js', 'ui/a.js', 'ui/shared.js'] },
				{ key: 'b', modules: ['headless/b.js', 'ui/shared.js', 'ui/absent.js'] },
				{ key: 'c', modules: ['outside.js'] },
			],
			read: (path) => files.get(path),
		});
		const [a, b] = result.elements;
		expect(a?.modules).toEqual(['headless/a.js', 'ui/a.js']);
		expect(b?.modules).toEqual(['headless/b.js', 'ui/absent.js']);
		expect(result.shared.modules).toEqual([
			'chunks/chunk-1.js',
			'chunks/chunk-2.js',
			'missing.js',
			'ui/lazy.js',
			'ui/shared.js',
		]);
		expect(result.missing).toEqual(['missing.js', 'ui/absent.js']);
		const expected = ['headless/a.js', 'ui/a.js'].reduce((sum, p) => sum + gzipSize(String(files.get(p))), 0);
		expect(a?.gzipBytes).toBe(expected);
		expect(a?.kb).toBe(toKb(expected));
	});
	it('uses cached gzip sizes when given', () => {
		const result = measureBundle({
			elements: [{ key: 'a', modules: ['ui/lazy.js'] }],
			read: (path) => files.get(path),
			gzip: (path) => (path === 'ui/lazy.js' ? 2048 : undefined),
		});
		expect(result.elements[0]?.gzipBytes).toBe(2048);
		expect(result.elements[0]?.kb).toBe(2);
	});
	it('measures like gzip level 9 and parses bundled imports', () => {
		expect(gzipSize('hello')).toBe(gzipSync(Buffer.from('hello'), { level: GZIP_LEVEL }).byteLength);
		expect(gzipSize(new Uint8Array([1, 2, 3]))).toBeGreaterThan(0);
		expect(toKb(1)).toBe(0.1);
		expect(toKb(1024)).toBe(1);
		expect(relativeImports('import*as m from"./m.js";export{a}from\'../b.js\';import("./c.js");import"pkg";')).toEqual([
			'./m.js',
			'../b.js',
			'./c.js',
		]);
		expect(resolveModule('ui/a.js', '../chunks/x.js')).toBe('chunks/x.js');
		expect(resolveModule('a.js', '../x.js')).toBeNull();
	});
});
