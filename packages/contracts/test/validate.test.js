import { describe, expect, it } from 'vitest';
import { ALL_SCHEMAS, SCHEMA_IDS, createValidator, getDefaultValidator, problemsFromAjv } from '../src/index.js';
import { expectProblem } from './helpers.js';

describe('createValidator', () => {
	it('registers every built-in schema and compiles it in strict mode', () => {
		const v = createValidator();
		for (const schema of ALL_SCHEMAS) {
			const id = /** @type {string} */ (schema.$id);
			expect(v.has(id)).toBe(true);
			expect(() => v.validate(id, {})).not.toThrow();
		}
		expect(v.has('urn:nope')).toBe(false);
	});

	it('all built-in schemas are deeply frozen', () => {
		for (const schema of ALL_SCHEMAS) expect(Object.isFrozen(schema)).toBe(true);
		expect(Object.isFrozen(ALL_SCHEMAS)).toBe(true);
	});

	it('returns ok results with the same value', () => {
		const value = { type: 'about:blank', title: 'x', status: 400 };
		const result = getDefaultValidator().validate(SCHEMA_IDS.problem, value);
		expect(result).toEqual({ ok: true, value });
		expect(Object.isFrozen(result)).toBe(true);
	});

	it('reports unknown schema ids as problems', () => {
		expectProblem(getDefaultValidator().validate('urn:nope', {}), '', 'schema');
	});

	it('accepts extra schemas that reference the common definitions', () => {
		const v = createValidator({
			schemas: [
				{
					$id: 'urn:product:ecommerce:v1:coupon',
					type: 'object',
					required: ['value'],
					properties: { value: { $ref: `${SCHEMA_IDS.common}#/$defs/millicredits` } },
				},
			],
		});
		expect(v.validate('urn:product:ecommerce:v1:coupon', { value: 1500 }).ok).toBe(true);
		expectProblem(v.validate('urn:product:ecommerce:v1:coupon', { value: -1 }), '/value', 'minimum');
		expectProblem(v.validate('urn:product:ecommerce:v1:coupon', {}), '/value', 'required');
		expect(() => createValidator({ schemas: [{ type: 'object' }] })).toThrow(TypeError);
	});

	it('strict mode refuses unknown keywords in extra schemas', () => {
		expect(() =>
			createValidator({ schemas: [{ $id: 'urn:x', type: 'object', colour: 'red' }] }).validate('urn:x', {}),
		).toThrow();
	});
});

describe('problemsFromAjv', () => {
	it('maps Ajv errors to pointer paths and stable messages', () => {
		const problems = problemsFromAjv([
			{ keyword: 'required', instancePath: '/a', schemaPath: '', params: { missingProperty: 'b/c' }, message: 'x' },
			{ keyword: 'additionalProperties', instancePath: '', schemaPath: '', params: { additionalProperty: 'z~' } },
			{ keyword: 'propertyNames', instancePath: '/m', schemaPath: '', params: { propertyName: 'Bad' }, message: 'x' },
			{ keyword: 'enum', instancePath: '/e', schemaPath: '', params: { allowedValues: ['a', 'b'] }, message: 'x' },
			{ keyword: 'const', instancePath: '/k', schemaPath: '', params: { allowedValue: '1' }, message: 'x' },
			{ keyword: 'false schema', instancePath: '/f', schemaPath: '', params: {}, message: 'boolean schema is false' },
			{ keyword: 'if', instancePath: '', schemaPath: '', params: {}, message: 'must match "then" schema' },
			{ keyword: 'type', instancePath: '/t', schemaPath: '', params: {}, message: 'must be string' },
			{ keyword: 'type', instancePath: '/t', schemaPath: '', params: {}, message: 'must be string' },
		]);
		expect(problems).toEqual([
			{ path: '/a/b~1c', message: 'is required', keyword: 'required' },
			{ path: '/z~0', message: 'is not allowed', keyword: 'additionalProperties' },
			{ path: '/m/Bad', message: 'has an invalid property name', keyword: 'propertyNames' },
			{ path: '/e', message: 'must be one of: "a", "b"', keyword: 'enum' },
			{ path: '/k', message: 'must equal "1"', keyword: 'const' },
			{ path: '/f', message: 'is not allowed', keyword: 'false schema' },
			{ path: '/t', message: 'must be string', keyword: 'type' },
		]);
		expect(problemsFromAjv(null)).toEqual([]);
		expect(problemsFromAjv([{ keyword: 'x', instancePath: '/q', schemaPath: '', params: {} }], '/data')).toEqual([
			{ path: '/data/q', message: 'is invalid', keyword: 'x' },
		]);
	});
});
