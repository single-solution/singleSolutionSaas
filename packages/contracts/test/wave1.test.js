import { describe, expect, it } from 'vitest';
import {
	MANIFEST_RULES,
	PLACEMENT_MEMBERS,
	checkFeatureSchema,
	readsOf,
	validateFeatureConfig,
	validateManifest,
} from '../src/index.js';
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

describe('manifest reads and optional resources', () => {
	it('normalises and checks reads', () => {
		const m = packManifest();
		m.reads = ['catalog', { product: 'search', scopes: ['search.read'] }];
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
