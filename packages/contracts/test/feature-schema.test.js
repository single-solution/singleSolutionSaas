import { describe, expect, it } from 'vitest';
import {
	MANIFEST_RULES,
	SCHEMA_IDS,
	checkFeatureSchema,
	featureValueError,
	getDefaultValidator,
	resolveFeature,
	validateFeatureConfig,
	jsonEqual,
} from '../src/index.js';
import { manifest } from '../src/testing.js';
import { expectProblem, expectRule } from './helpers.js';

const features = () => manifest().elements[0].features;

describe('feature meta-schema', () => {
	const v = getDefaultValidator();
	it('accepts the reference feature schema', () => {
		expect(v.validate(SCHEMA_IDS.featureSchema, features()).ok).toBe(true);
	});
	it.each([
		[
			'$ref',
			{ type: 'object', properties: { a: { $ref: '#/x', type: 'string', title: 'A', default: '' } } },
			'/properties/a/$ref',
		],
		[
			'oneOf',
			{ type: 'object', properties: { a: { oneOf: [], type: 'string', title: 'A', default: '' } } },
			'/properties/a/oneOf',
		],
		['non-object root', { type: 'array', properties: {} }, '/type'],
		['open additionalProperties', { type: 'object', additionalProperties: true, properties: {} }, '/additionalProperties'],
		[
			'unknown format',
			{ type: 'object', properties: { a: { type: 'string', title: 'A', default: '', format: 'ipv4' } } },
			'/properties/a/format',
		],
		[
			'unknown x-ui key',
			{ type: 'object', properties: { a: { type: 'string', title: 'A', default: '', 'x-ui': { colour: 'red' } } } },
			'/properties/a/x-ui/colour',
		],
	])('rejects %s', (_name, schema, path) => {
		expectProblem(v.validate(SCHEMA_IDS.featureSchema, schema), path);
	});
});

describe('checkFeatureSchema (pure)', () => {
	it('passes the reference schema', () => {
		expect(checkFeatureSchema(features(), { planCodes: ['starter'] })).toEqual([]);
		expect(checkFeatureSchema(features())).toEqual([]);
	});

	it('rejects non-object schemas and bad roots', () => {
		expectRule(checkFeatureSchema(null), MANIFEST_RULES.featureType, '');
		expectRule(checkFeatureSchema({ type: 'object', properties: {}, anyOf: [] }), MANIFEST_RULES.featureKeyword, '/anyOf');
		expectRule(
			checkFeatureSchema({ type: 'object', properties: {}, required: ['x'] }),
			MANIFEST_RULES.featureRequired,
			'/required',
		);
	});

	it('flags disallowed keywords, types, missing title/default and ranges', () => {
		const schema = {
			type: 'object',
			properties: {
				a: { type: 'integer', title: 'A', default: 1, minimum: 5, maximum: 1, not: {} },
				b: { type: 'date', title: 'B', default: 1 },
				c: { type: 'string' },
				d: 'nope',
				e: { type: 'string', title: 'E', default: 'x', pattern: '(' },
			},
		};
		const problems = checkFeatureSchema(schema, { path: ['features'] });
		expectRule(problems, MANIFEST_RULES.featureKeyword, '/features/properties/a/not');
		expectRule(problems, MANIFEST_RULES.featureRange, '/features/properties/a/minimum');
		expectRule(problems, MANIFEST_RULES.featureType, '/features/properties/b/type');
		expectRule(problems, MANIFEST_RULES.featureRequired, '/features/properties/c/title');
		expectRule(problems, MANIFEST_RULES.featureRequired, '/features/properties/c/default');
		expectRule(problems, MANIFEST_RULES.featureType, '/features/properties/d');
		expectRule(problems, MANIFEST_RULES.featurePattern, '/features/properties/e/pattern');
	});

	it('checks defaults, kinds, nested objects and arrays', () => {
		const problems = checkFeatureSchema({
			type: 'object',
			properties: {
				flag: { type: 'string', title: 'F', default: 'x', 'x-kind': 'flag' },
				quota: { type: 'boolean', title: 'Q', default: true, 'x-kind': 'quota' },
				obj: { type: 'object', title: 'O', default: {} },
				nested: {
					type: 'object',
					title: 'N',
					default: { a: 1 },
					required: ['z'],
					properties: { a: { type: 'integer', maximum: 0 } },
				},
				list: { type: 'array', title: 'L', default: [1], items: { type: 'string', unknown: 1 } },
			},
		});
		expectRule(problems, MANIFEST_RULES.featureKind, '/properties/flag/x-kind');
		expectRule(problems, MANIFEST_RULES.featureKind, '/properties/quota/x-kind');
		expectRule(problems, MANIFEST_RULES.featureOpenObject, '/properties/obj');
		expectRule(problems, MANIFEST_RULES.featureRequired, '/properties/nested/required');
		expectRule(problems, MANIFEST_RULES.featureDefault, '/properties/nested/default');
		expectRule(problems, MANIFEST_RULES.featureKeyword, '/properties/list/items/unknown');
		expectRule(problems, MANIFEST_RULES.featureDefault, '/properties/list/default');
	});

	it('ignores non-object x-plan entries beyond the meta-schema', () => {
		const schema = { type: 'object', properties: { a: { type: 'integer', title: 'A', default: 1, 'x-plan': { starter: 5 } } } };
		expect(checkFeatureSchema(schema, { planCodes: ['starter'] })).toEqual([]);
	});
});

describe('featureValueError', () => {
	/** @type {Array<[any, unknown, string | null]>} */
	const cases = [
		[{ type: 'integer' }, 1.5, 'must be integer'],
		[{ type: 'number' }, Number.NaN, 'must be number'],
		[{ type: 'number', minimum: 1 }, 0, 'must be >= 1'],
		[{ type: 'number', maximum: 1 }, 2, 'must be <= 1'],
		[{ type: 'number', exclusiveMinimum: 1 }, 1, 'must be > 1'],
		[{ type: 'number', exclusiveMaximum: 1 }, 1, 'must be < 1'],
		[{ type: 'number', multipleOf: 5 }, 7, 'must be a multiple of 5'],
		[{ type: 'string', minLength: 2 }, 'é', 'must have at least 2 characters'],
		[{ type: 'string', maxLength: 1 }, '👍👍', 'must have at most 1 characters'],
		[{ type: 'string', pattern: '^a' }, 'b', 'must match pattern'],
		[{ type: 'string', enum: ['a'] }, 'b', 'must be one of the enum values'],
		[{ type: 'string', const: 'a' }, 'b', 'must equal const'],
		[{ type: 'array', minItems: 1 }, [], 'must have at least 1 items'],
		[{ type: 'array', maxItems: 1 }, [1, 2], 'must have at most 1 items'],
		[{ type: 'array', uniqueItems: true }, [{ a: 1 }, { a: 1 }], 'must have unique items'],
		[{ type: 'array', items: { type: 'integer' } }, [1, 'x'], 'item 1 must be integer'],
		[{ type: 'object', properties: {} }, { x: 1 }, "must not have property 'x'"],
		[{ type: 'object', properties: { x: { type: 'boolean' } } }, { x: 1 }, "property 'x' must be boolean"],
		[{ type: 'boolean' }, true, null],
		[{ type: 'string', maxLength: 2 }, '👍👍', null],
	];
	it.each(cases)('%j with %j', (node, value, expected) => {
		expect(featureValueError(node, value)).toBe(expected);
	});
});

describe('helpers', () => {
	it('resolveFeature walks nested properties', () => {
		expect(resolveFeature(features(), ['window', 'days'])?.type).toBe('integer');
		expect(resolveFeature(features(), ['window', 'nope'])).toBeUndefined();
		expect(resolveFeature(features(), [])).toBeUndefined();
		expect(resolveFeature(undefined, ['a'])).toBeUndefined();
	});
	it('jsonEqual compares structurally', () => {
		expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
		expect(jsonEqual({ a: 1 }, { b: 1 })).toBe(false);
		expect(jsonEqual([1], [1, 2])).toBe(false);
		expect(jsonEqual(1, '1')).toBe(false);
	});
	it('validateFeatureConfig checks element config against the feature schema (cached)', () => {
		const schema = features();
		expect(validateFeatureConfig(schema, { maxActive: 5, prefix: 'AB' }).ok).toBe(true);
		expectProblem(validateFeatureConfig(schema, { maxActive: 0 }), '/maxActive', 'minimum');
		expectProblem(validateFeatureConfig(schema, { other: 1 }), '/other', 'additionalProperties');
		expectProblem(validateFeatureConfig(schema, { window: {} }), '/window/days', 'required');
	});
});
