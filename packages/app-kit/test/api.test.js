import { describe, expect, it } from 'vitest';
import { KIT_API, checkApiDescription, mergeApi, parseRouteKey, schemaProblems, validateValue } from '../src/api.js';
import { apiAnchor, renderApiReference } from '../src/index.js';
import { apiChecker } from '../src/testing.js';

const PAYMENT = {
	type: 'object',
	required: ['id', 'status', 'amount'],
	additionalProperties: false,
	properties: {
		id: { type: 'string', pattern: '^pay_[0-9a-z]+$' },
		status: { type: 'string', enum: ['pending', 'paid'] },
		amount: { type: 'integer', minimum: 1, maximum: 100 },
		note: { type: ['string', 'null'], maxLength: 3 },
		at: { type: 'string', format: 'date-time' },
	},
};

describe('the schema subset', () => {
	it('validates types, objects, lists, texts, numbers, enums, const and formats', () => {
		const ok = { id: 'pay_1', status: 'paid', amount: 5, note: null, at: '2026-10-01T10:00:00.000Z' };
		expect(validateValue(PAYMENT, ok)).toEqual([]);
		expect(
			validateValue(PAYMENT, { ...ok, id: 'x', status: 'gone', amount: 500, note: 'long', at: 'today', extra: 1 }),
		).toEqual([
			{ path: '/id', message: 'must match ^pay_[0-9a-z]+$' },
			{ path: '/status', message: 'must be one of "pending", "paid" (is "gone")' },
			{ path: '/amount', message: 'must be at most 100' },
			{ path: '/note', message: 'must be at most 3 characters' },
			{ path: '/at', message: 'must be a date-time (ISO 8601 with a zone)' },
			{ path: '/extra', message: 'is not described (additionalProperties is false)' },
		]);
		expect(validateValue(PAYMENT, { amount: 0.5 })).toEqual([
			{ path: '/id', message: 'is required' },
			{ path: '/status', message: 'is required' },
			{ path: '/amount', message: 'must be integer (is number)' },
		]);
		expect(validateValue({ type: 'number', minimum: 1 }, 0.5)).toEqual([{ path: '', message: 'must be at least 1' }]);
		expect(validateValue({ type: 'number' }, 3)).toEqual([]);
		expect(validateValue({ type: 'string', minLength: 2 }, 'é')).toEqual([
			{ path: '', message: 'must be at least 2 characters' },
		]);
		expect(validateValue({ const: 'a' }, 'b')).toEqual([{ path: '', message: 'must be "a"' }]);
		const list = { type: 'array', minItems: 1, maxItems: 2, items: { type: 'integer' } };
		expect(validateValue(list, [])).toEqual([{ path: '', message: 'must have at least 1 items' }]);
		expect(validateValue(list, [1, 'a', 3])).toEqual([
			{ path: '', message: 'must have at most 2 items' },
			{ path: '/1', message: 'must be integer (is string)' },
		]);
		const map = {
			type: 'object',
			maxProperties: 1,
			propertyNames: { pattern: '^[a-z]+$' },
			additionalProperties: { type: 'boolean' },
		};
		expect(validateValue(map, { a: true, 'B/c': 1 })).toEqual([
			{ path: '', message: 'must have at most 1 members' },
			{ path: '/B~1c', message: 'is not an allowed name' },
			{ path: '/B~1c', message: 'must be boolean (is integer)' },
		]);
		for (const [format, good, bad] of /** @type {Array<[string, string, string | null]>} */ ([
			['date', '2026-10-01', '2026-13-45'],
			['uri', 'https://example.com/a', 'not a uri'],
			['email', 'a@example.com', 'nope'],
			['uuid', 'anything', null],
		])) {
			expect(validateValue({ type: 'string', format }, good), format).toEqual([]);
			if (bad !== null) expect(validateValue({ type: 'string', format }, bad), format).toHaveLength(1);
		}
		expect(validateValue({ type: 'null' }, [])).toEqual([{ path: '', message: 'must be null (is array)' }]);
		expect(validateValue(true, 1)).toEqual([]);
	});

	it('follows shared schemas and says which oneOf or anyOf branch comes closest', () => {
		const schemas = { Payment: PAYMENT, Loop: { $ref: '#/components/schemas/Loop' } };
		const page = { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Payment' } } } };
		expect(validateValue(page, { items: [{ id: 'pay_1', status: 'paid', amount: 0 }] }, { schemas })).toEqual([
			{ path: '/items/0/amount', message: 'must be at least 1' },
		]);
		expect(validateValue({ $ref: '#/components/schemas/Loop' }, 1, { schemas })).toEqual([
			{ path: '', message: 'nests too deeply' },
		]);
		const either = { oneOf: [{ type: 'string' }, { type: 'object', required: ['a'], properties: { a: { type: 'integer' } } }] };
		expect(validateValue(either, 'x')).toEqual([]);
		expect(validateValue(either, { a: 'b' })).toEqual([
			{ path: '/a', message: 'must be integer (is string) (no oneOf schema fits)' },
		]);
		expect(validateValue({ oneOf: [{ type: 'integer' }, { type: 'number' }] }, 1)).toEqual([
			{ path: '', message: 'must match exactly one of the oneOf schemas (matches 2)' },
		]);
		expect(validateValue({ anyOf: [{ type: 'integer' }, { type: 'number' }] }, 1)).toEqual([]);
		expect(validateValue({ anyOf: [{ type: 'integer' }, { const: 'x' }] }, 'y')).toHaveLength(1);
	});

	it('checks schemas: keywords of the subset, their values and references', () => {
		expect(schemaProblems(PAYMENT)).toEqual([]);
		expect(
			schemaProblems(
				{
					type: ['string', 'string'],
					properties: { a: { type: 'date' }, b: 'x' },
					required: ['a', 'c'],
					additionalProperties: { nope: 1 },
					items: { type: 'integer' },
					enum: [],
					minimum: 'one',
					maxLength: -1,
					pattern: '(',
					oneOf: [],
					anyOf: [{ $ref: '#/components/schemas/Missing' }],
					$ref: '#/definitions/x',
					description: 1,
					examples: 'x',
					deprecated: 'yes',
					discriminator: {},
				},
				{ at: '/x' },
			),
		).toEqual([
			{ path: '/x/type', message: 'type is one of string, number, integer, boolean, object, array, null, or a list of them' },
			{ path: '/x/properties/a/type', message: expect.stringMatching(/^type is one of/) },
			{ path: '/x/properties/b', message: 'a schema is a JSON object' },
			{ path: '/x/required', message: "required names 'c', which is not in properties" },
			{ path: '/x/additionalProperties/nope', message: expect.stringMatching(/^'nope' is not a keyword/) },
			{ path: '/x/enum', message: 'enum lists the allowed values' },
			{ path: '/x/minimum', message: 'minimum is a number' },
			{ path: '/x/maxLength', message: 'maxLength is a whole number of at least 0' },
			{ path: '/x/pattern', message: 'pattern is a regular expression (Unicode mode)' },
			{ path: '/x/oneOf', message: 'oneOf lists schemas' },
			{ path: '/x/anyOf/0/$ref', message: "$ref names the shared schema 'Missing', which does not exist" },
			{ path: '/x/$ref', message: '$ref is #/components/schemas/<Name>' },
			{ path: '/x/description', message: 'description is a text' },
			{ path: '/x/examples', message: 'examples is a list' },
			{ path: '/x/deprecated', message: 'deprecated is true or false' },
			{ path: '/x/discriminator', message: expect.stringMatching(/^'discriminator' is not a keyword/) },
		]);
		expect(schemaProblems({ required: 'a' })).toEqual([
			{ path: '/required', message: 'required lists property names once each' },
		]);
		expect(schemaProblems({ properties: [] })).toEqual([{ path: '/properties', message: 'properties maps names to schemas' }]);
		/** @type {Record<string, any>} */
		let deep = { type: 'string' };
		for (let i = 0; i < 70; i += 1) deep = { items: deep };
		expect(schemaProblems(deep).at(-1)?.message).toBe('nests too deeply');
	});
});

describe('API descriptions', () => {
	it('checks keys, entries and shared schemas, the kit’s included', () => {
		expect(parseRouteKey('GET /v1/a/:id')).toEqual({ method: 'GET', path: '/v1/a/:id' });
		expect(parseRouteKey('HEAD /v1/a')).toBeNull();
		expect(checkApiDescription(KIT_API)).toEqual([]);
		expect(checkApiDescription([])).toEqual([{ pointer: '', message: 'the API description is a JSON object' }]);
		expect(checkApiDescription({ $schemas: [] })).toEqual([
			{ pointer: '/$schemas', message: '$schemas maps names to shared schemas' },
		]);
		const problems = checkApiDescription(
			{
				$schemas: { Count: { type: 'object' }, '9bad': { type: 'object' }, Own: { $ref: '#/components/schemas/Counts' } },
				'GET /v1/a/:id': { response: { $ref: '#/components/schemas/Own' } },
				'GET /v1/a/:other': {},
				'get /v1/b': {},
				'GET /v1/c': 'x',
				'POST /v1/d': { summary: 1, status: 204, response: {}, extra: true, query: { type: 'string' }, body: { type: 'x' } },
				'GET /v1/e': { status: 302 },
				'GET /v1/f': {
					headers: { type: 'object', properties: { 'SS-Guest': { type: 'string' }, '1x': { type: 'string' } } },
				},
				'GET /v1/g': { headers: { type: 'string' } },
			},
			{ schemas: /** @type {any} */ (KIT_API.$schemas) },
		);
		expect(problems).toEqual([
			{ pointer: '/$schemas/Count', message: "'Count' is a shared schema of the kit: reference it, or use another name" },
			{ pointer: '/$schemas/9bad', message: 'a shared schema name is a letter, then letters, digits, _ . - (at most 64)' },
			{ pointer: '/GET ~1v1~1a~1:other', message: "the same route as 'GET /v1/a/:id'" },
			{ pointer: '/get ~1v1~1b', message: expect.stringMatching(/^keys are '<METHOD> <path>'/) },
			{ pointer: '/GET ~1v1~1c', message: 'an entry is a JSON object' },
			{ pointer: '/POST ~1v1~1d/extra', message: expect.stringMatching(/^an entry has summary/) },
			{ pointer: '/POST ~1v1~1d/summary', message: 'summary is a text' },
			{ pointer: '/POST ~1v1~1d/response', message: 'a 204 answer has no body: leave response out' },
			{ pointer: '/POST ~1v1~1d/query', message: 'query is an object schema whose properties are the query parameters' },
			{ pointer: '/POST ~1v1~1d/body/type', message: expect.stringMatching(/^type is one of/) },
			{ pointer: '/GET ~1v1~1e/status', message: 'status is the success status, 200–299' },
			{ pointer: '/GET ~1v1~1f/headers/1x', message: 'a header name is a letter, then letters, digits and - (at most 64)' },
			{ pointer: '/GET ~1v1~1g/headers', message: 'headers is an object schema whose properties are the request headers' },
		]);
		expect(checkApiDescription({ 'GET /v1/a': { response: { $ref: '#/components/schemas/Count' } } })).toHaveLength(1);
		expect(mergeApi({ 'GET /v1/a': { summary: 'kit' } }, { 'GET /v1/a': { summary: 'own' } })).toEqual({
			'GET /v1/a': { summary: 'own' },
			$schemas: {},
		});
	});

	it('checks answers by route: status, body and schema, literal segments first; others are left alone', () => {
		const api = apiChecker({
			$schemas: { Payment: PAYMENT },
			'GET /v1/payments/:id': { response: { $ref: '#/components/schemas/Payment' } },
			'GET /v1/payments/count': { response: { $ref: '#/components/schemas/Count' } },
			'POST /v1/payments': { status: 201, response: { $ref: '#/components/schemas/Payment' } },
			'DELETE /v1/payments/:id': { status: 204 },
		});
		const payment = { id: 'pay_1', status: 'paid', amount: 5 };
		expect(api.check({ method: 'GET', path: '/v1/payments/pay_1?x=1', status: 200, body: payment })).toEqual([]);
		expect(
			api.check({
				method: 'GET',
				path: 'https://p.example/v1/payments/count',
				status: 200,
				body: { count: 1, capped: false },
			}),
		).toEqual([]);
		expect(api.described('get', '/v1/payments/count')).toBe('GET /v1/payments/count');
		expect(api.described('GET', '/v1/nope')).toBeNull();
		expect(api.check({ method: 'POST', path: '/v1/payments', status: 200, body: { ...payment, amount: 0 } })).toEqual([
			'POST /v1/payments (200): answered 200, described 201',
			'POST /v1/payments (200): /amount must be at least 1',
		]);
		expect(api.check({ method: 'POST', path: '/v1/payments', status: 201, body: null })).toEqual([
			'POST /v1/payments (201): answered no JSON body, but the description has a response',
		]);
		expect(api.check({ method: 'DELETE', path: '/v1/payments/pay_1', status: 200, body: {} })).toEqual([
			'DELETE /v1/payments/:id (200): answered 200, described 204',
			'DELETE /v1/payments/:id (200): answered a JSON body, but the description has no response',
		]);
		expect(api.check({ method: 'GET', path: '/v1/payments/pay_1', status: 200, body: 'x' })).toEqual([
			'GET /v1/payments/:id (200): (the body) must be object (is string)',
		]);
		expect(api.check({ method: 'GET', path: '/v1/payments/pay_1', status: 404, body: {} })).toEqual([]);
		expect(api.check({ method: 'GET', path: '/pay/web_1/pay_1', status: 200, body: null })).toEqual([]);
		// the kit's own routes are described too
		expect(api.check({ method: 'GET', path: '/v1/activity/count', status: 200, body: {} })).toEqual([
			'GET /v1/activity/count (200): /count is required',
			'GET /v1/activity/count (200): /capped is required',
		]);
		expect(() => api.assert({ method: 'POST', path: '/v1/payments', status: 201, body: payment })).not.toThrow();
		expect(() => api.assert({ method: 'POST', path: '/v1/payments', status: 201, body: {} })).toThrow(
			/does not fit schemas\/api.json/,
		);
		// a JSON null is an answer when the description allows it
		const notice = apiChecker({ 'GET /v1/notice': { response: { type: ['object', 'null'] } } }, { kit: false });
		expect(notice.check({ method: 'GET', path: '/v1/notice', status: 200, body: null })).toEqual([]);
		expect(notice.check({ method: 'GET', path: '/v1/notice', status: 200, body: {} })).toEqual([]);
		expect(apiChecker({}, { kit: false }).described('GET', '/v1/activity')).toBeNull();
		expect(() => apiChecker({ 'GET /v1/a': { status: 1 } })).toThrow(/the API description is invalid:\n\/GET ~1v1~1a\/status/);
	});
});

describe('the API reference', () => {
	const openapi = {
		paths: {
			'/v1/payments/{id}': {
				get: {
					summary: 'Read a payment',
					description: 'With its <history>.',
					'x-ss-auth': 'server',
					'x-ss-feature': 'payment_api',
					parameters: [
						{ name: 'id', in: 'path', required: true, schema: { type: 'string', description: 'x' } },
						{
							name: 'limit',
							in: 'query',
							required: false,
							description: 'Page size',
							schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
						},
						{ $ref: '#/components/parameters/SSActorId' },
						{ $ref: '#/components/parameters/Unknown' },
					],
					responses: {
						200: {
							description: 'Success',
							content: { 'application/json': { schema: { $ref: '#/components/schemas/Payment' } } },
						},
						default: { description: 'Problem' },
					},
				},
			},
			'/v1/payments': {
				post: {
					'x-ss-auth': 'browser',
					'x-ss-feature': ['a', 'b'],
					requestBody: {
						content: {
							'application/json': {
								schema: {
									type: 'object',
									required: ['amount'],
									properties: {
										amount: { type: 'integer', minimum: 1 },
										customer: {
											type: 'object',
											properties: { email: { type: 'string', format: 'email', maxLength: 320 } },
										},
										lines: {
											type: 'array',
											items: { type: 'object', properties: { sku: { type: 'string', minLength: 1 } } },
										},
										metadata: { type: 'object', additionalProperties: { type: 'string' } },
										tags: { type: 'array', maxItems: 3, maxProperties: 2 },
										kind: { enum: ['a', null] },
										fixed: { const: 1 },
										either: { anyOf: [{ type: 'string' }, { $ref: '#/components/schemas/Payment' }] },
										proof: { oneOf: [{ type: 'object', properties: { size: { type: 'integer' } } }, { type: 'null' }] },
										any: {},
										raw: 'x',
									},
								},
							},
						},
					},
					responses: {
						201: {
							description: 'Created',
							content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } },
						},
					},
				},
				delete: { 'x-ss-auth': 'ticket', 'x-ss-permission': 'payments.manage', responses: { 204: { description: 'Done' } } },
				put: 'x',
			},
		},
		components: {
			parameters: { SSActorId: { name: 'SS-Actor-Id', in: 'header' } },
			schemas: { Payment: { type: 'object', description: 'A payment.', properties: { id: { type: 'string' } } } },
		},
	};

	it('renders each operation with auth, feature, parameters, fields and answers, then the objects, escaped', () => {
		const html = renderApiReference(openapi);
		expect(html).toContain(`<section class="ss-api-op" id="${apiAnchor('GET', '/v1/payments/{id}')}">`);
		expect(apiAnchor('GET', '/v1/payments/{id}')).toBe('op-get-v1-payments-id');
		expect(html).toContain('<code>GET /v1/payments/{id}</code> Read a payment');
		expect(html).toContain('With its &#60;history&#62;.');
		expect(html).toContain(
			'<strong>Auth:</strong> server token (your server only). <strong>Feature:</strong> <code>payment_api</code>.',
		);
		expect(html).toContain(
			'<td><code>limit</code></td><td>query</td><td>integer</td><td>no</td><td>Page size. 1–100. default 25.</td>',
		);
		expect(html).toContain('Optional headers: <code>SS-Actor-Id</code>.');
		expect(html).toContain('<h4>Answer 200 (JSON)</h4><p><a href="#schema-Payment">Payment</a></p>');
		expect(html).toContain('browser token from the website');
		expect(html).toContain('<code>a</code> or <code>b</code>');
		expect(html).toContain(
			'<td><code>customer.email</code></td><td>string (email)</td><td>no</td><td>at most 320 characters.</td>',
		);
		expect(html).toContain('<td><code>lines[].sku</code></td><td>string</td><td>no</td><td>at least 1 characters.</td>');
		expect(html).toContain('<td><code>metadata</code></td><td>map of string</td>');
		expect(html).toContain('<td><code>tags</code></td><td>array</td><td>no</td><td>at most 3 items. at most 2 members.</td>');
		expect(html).toContain('<td><code>kind</code></td><td>&#34;a&#34; | null</td>');
		expect(html).toContain('<td><code>fixed</code></td><td>1</td>');
		expect(html).toContain('<td><code>either</code></td><td>string or <a href="#schema-Payment">Payment</a></td>');
		expect(html).toContain('<td><code>any</code></td><td>any</td>');
		expect(html).toContain('<td><code>proof</code></td><td>object or null</td>');
		expect(html).toContain('<td><code>proof.size</code></td><td>integer</td><td>no</td>');
		expect(html).toContain('<td><code>raw</code></td><td>any</td>');
		expect(html).toContain('<h4>Answer 201 (JSON)</h4><p>array of string</p>');
		expect(html).toContain(
			'ticket (admin widgets) with the permission <code>payments.manage</code>. <strong>Feature:</strong> always on.',
		);
		expect(html).toContain('<h4>Answer 204</h4><p>Done</p>');
		expect(html).toContain('<section class="ss-api-schema" id="schema-Payment"><h4>Payment</h4><p>A payment.</p><table>');
		expect(renderApiReference(openapi, { only: (method) => method === 'DELETE' })).not.toContain('GET /v1/payments');
		expect(renderApiReference(null)).toBe('<div class="ss-api">\n\n</div>');
	});
});
