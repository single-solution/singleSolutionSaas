import { describe, expect, it } from 'vitest';
import { PROBLEM_CODES, SCHEMA_IDS, createProblemFactory, getDefaultValidator, problem, validateManifest } from '../src/index.js';
import { expectProblem } from './helpers.js';

const v = getDefaultValidator();

/** @returns {any} */
const problemDoc = () => ({
	type: 'https://errors.example.dev/validation_failed',
	title: 'Validation failed',
	status: 422,
	detail: 'The request body is invalid.',
	instance: '/v1/notes',
	requestId: 'req_0123456789abcdefghjkmnpq',
	errors: [{ path: '/body', message: 'must be string', keyword: 'type' }],
});

describe('problem schema', () => {
	it('accepts RFC 9457 documents with extensions', () => {
		expect(v.validate(SCHEMA_IDS.problem, problemDoc()).ok).toBe(true);
		expect(v.validate(SCHEMA_IDS.problem, { ...problemDoc(), reason: 'stopped', extra: 1 }).ok).toBe(true);
		expect(v.validate(SCHEMA_IDS.problem, { type: 'about:blank', title: 'Not found', status: 404 }).ok).toBe(true);
	});
	/** @type {Array<[string, (p: any) => unknown, string, string]>} */
	const invalid = [
		['missing title', (p) => delete p.title, '/title', 'required'],
		['status out of range', (p) => (p.status = 700), '/status', 'maximum'],
		['string status', (p) => (p.status = '422'), '/status', 'type'],
		['error without message', (p) => (p.errors = [{ path: '/a' }]), '/errors/0/message', 'required'],
		['error with bad pointer', (p) => (p.errors = [{ path: 'a', message: 'x' }]), '/errors/0/path', 'pattern'],
		['unknown reason', (p) => (p.reason = 'deleted'), '/reason', 'enum'],
	];
	it.each(invalid)('rejects %s', (_name, mutate, path, keyword) => {
		const p = problemDoc();
		mutate(p);
		expectProblem(v.validate(SCHEMA_IDS.problem, p), path, keyword);
	});
});

describe('problem builder', () => {
	it('builds a frozen minimal problem with about:blank', () => {
		const p = problem({ title: 'Not found', status: 404 });
		expect(p).toEqual({ type: 'about:blank', title: 'Not found', status: 404 });
		expect(Object.isFrozen(p)).toBe(true);
	});

	it('keeps optional members and normalises errors', () => {
		const p = problem({
			type: 'https://errors.example.dev/x',
			title: 'X',
			status: 400,
			detail: 'd',
			instance: '/v1/x',
			requestId: 'req_1',
			errors: [{ path: '/a', message: 'bad', keyword: 'type', code: 'x1' }, /** @type {any} */ ({ message: 'root' })],
		});
		expect(p.errors).toEqual([
			{ path: '/a', message: 'bad', keyword: 'type', code: 'x1' },
			{ path: '', message: 'root' },
		]);
		expect(v.validate(SCHEMA_IDS.problem, p).ok).toBe(true);
		expect(problem({ title: 'X', status: 400, errors: [] })).not.toHaveProperty('errors');
	});

	it('rejects invalid status and empty title', () => {
		expect(() => problem({ title: 'X', status: 99 })).toThrow(RangeError);
		expect(() => problem({ title: 'X', status: 200.5 })).toThrow(RangeError);
		expect(() => problem({ title: '', status: 400 })).toThrow(TypeError);
	});
});

describe('problem factory', () => {
	const factory = createProblemFactory({ baseUri: 'https://errors.example.dev' });

	it('normalises the base URI and resolves codes', () => {
		expect(factory.baseUri).toBe('https://errors.example.dev/');
		expect(factory.typeFor('not_found')).toBe('https://errors.example.dev/not_found');
		expect(factory.codeOf('https://errors.example.dev/rate_limited')).toBe('rate_limited');
		expect(factory.codeOf('https://errors.example.dev/nope')).toBeNull();
		expect(factory.codeOf('https://other.dev/not_found')).toBeNull();
		expect(() => factory.typeFor('nope')).toThrow(TypeError);
	});

	it('creates problems from codes with registry title/status', () => {
		const p = factory.create('feature_off', { detail: 'Notes is off', requestId: 'req_9' });
		expect(p).toEqual({
			type: 'https://errors.example.dev/feature_off',
			title: PROBLEM_CODES.feature_off.title,
			status: 403,
			detail: 'Notes is off',
			requestId: 'req_9',
		});
		expect(factory.problem({ code: 'forbidden', detail: 'x' }).type).toBe('https://errors.example.dev/forbidden');
		expect(factory.problem({ title: 'Raw', status: 418 }).type).toBe('about:blank');
	});

	it('carries the reason of product_unavailable, and only there', () => {
		expect(factory.create('product_unavailable', { reason: 'suspended' })).toEqual({
			type: 'https://errors.example.dev/product_unavailable',
			title: PROBLEM_CODES.product_unavailable.title,
			status: 403,
			reason: 'suspended',
		});
		expect(() => factory.create('product_unavailable')).toThrow(TypeError);
		expect(() => factory.create('forbidden', { reason: 'stopped' })).toThrow(TypeError);
		expect(() => problem({ title: 'X', status: 403, reason: /** @type {any} */ ('deleted') })).toThrow(TypeError);
		expect(v.validate(SCHEMA_IDS.problem, factory.create('product_unavailable', { reason: 'removed' })).ok).toBe(true);
	});

	it('has the status codes of PLAN 0.4.7', () => {
		expect(PROBLEM_CODES.invalid_token.status).toBe(401);
		expect(PROBLEM_CODES.product_unavailable.status).toBe(403);
		expect(PROBLEM_CODES.feature_off.status).toBe(403);
		expect(PROBLEM_CODES.database_not_connected.status).toBe(403);
		expect(PROBLEM_CODES.website_not_found.status).toBe(404);
		expect(PROBLEM_CODES.portal_unreachable.status).toBe(503);
	});

	it('wraps validation problems', () => {
		const result = validateManifest({});
		if (result.ok) throw new Error('expected failure');
		const p = factory.fromValidation(result.problems, { requestId: 'req_1' });
		expect(p.status).toBe(422);
		expect(p.errors?.length).toBe(result.problems.length);
		expect(factory.fromValidation([], { code: 'invalid_manifest' }).title).toBe('Invalid manifest');
		expect(v.validate(SCHEMA_IDS.problem, p).ok).toBe(true);
	});

	it('supports product codes but not overriding built-ins', () => {
		const extended = createProblemFactory({
			baseUri: 'https://errors.example.dev/ecommerce/',
			codes: { code_expired: { status: 410, title: 'Code expired' } },
		});
		expect(extended.create('code_expired').type).toBe('https://errors.example.dev/ecommerce/code_expired');
		expect(() => createProblemFactory({ baseUri: 'https://e.dev', codes: { not_found: { status: 404, title: 'x' } } })).toThrow(
			TypeError,
		);
		expect(() =>
			createProblemFactory({ baseUri: 'https://e.dev', codes: { 'Bad-Code': { status: 400, title: 'x' } } }),
		).toThrow(TypeError);
		expect(() => createProblemFactory({ baseUri: 'https://e.dev', codes: { weird: { status: 42, title: 'x' } } })).toThrow(
			RangeError,
		);
	});

	it('rejects relative or query-bearing base URIs', () => {
		expect(() => createProblemFactory({ baseUri: '/errors' })).toThrow(TypeError);
		expect(() => createProblemFactory({ baseUri: 'https://e.dev/?x=1' })).toThrow(TypeError);
	});

	it('every registered code has a valid status and title', () => {
		for (const [code, definition] of Object.entries(PROBLEM_CODES)) {
			expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
			expect(() => problem({ title: definition.title, status: definition.status })).not.toThrow();
		}
	});
});
