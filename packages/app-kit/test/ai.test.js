/**
 * The shared AI client: the wire formats of the four providers, the check of an AI key value (the same the Portal makes),
 * the endpoints and the client's calls and connection test through the product's outbound `send`.
 */
import { describe, expect, it } from 'vitest';
import { AI_PROVIDERS as CONTRACT_PROVIDERS } from '@ss/contracts';
import { createOutboundPolicy } from '@ss/net';
import { AI_PROVIDERS, MODEL_SUGGESTIONS, checkAiConnection, createAiClient, estimateTokens } from '../src/index.js';
import * as pure from '../src/ai/index.js';
import { endpointOf } from '../src/ai/client.js';
import { PROVIDER_BASE } from '../src/ai/models.js';
import { WIRE, parseArguments } from '../src/ai/wire.js';

/** @type {import('../src/ai/wire.js').AiMessage[]} */
const MESSAGES = [
	{ role: 'system', content: 'Rules' },
	{ role: 'user', content: 'Hi' },
	{ role: 'assistant', content: 'Let me check', toolCalls: [{ id: 'c1', name: 'stock', arguments: { sku: 'A' } }] },
	{ role: 'tool', toolCallId: 'c1', toolName: 'stock', content: '3' },
	{ role: 'tool', toolCallId: 'c2', toolName: 'price', content: '9' },
	{ role: 'assistant', content: '' },
];
const TOOLS = [
	{ name: 'stock', description: 'Stock', parameters: { type: 'object', properties: { sku: { type: 'string' } } } },
	{ name: 'ping', description: 'Ping', parameters: { type: 'object', properties: {} } },
];
const KEY = { provider: 'openai', apiKey: 'sk-test-0123456789', model: 'gpt-4.1-mini' };

describe('AI wire formats', () => {
	it('builds and parses OpenAI requests (also an OpenAI-compatible service) with tools', () => {
		const built = WIRE.openai.build({ model: 'm', messages: MESSAGES, tools: TOOLS, temperature: 0.3, maxTokens: 70 });
		expect(built.path).toBe('/chat/completions');
		const body = /** @type {any} */ (built.body);
		expect(body).toMatchObject({ model: 'm', temperature: 0.3, max_tokens: 70, tool_choice: 'auto' });
		expect(body.messages[2]).toEqual({
			role: 'assistant',
			content: 'Let me check',
			tool_calls: [{ id: 'c1', type: 'function', function: { name: 'stock', arguments: '{"sku":"A"}' } }],
		});
		expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '3' });
		expect(body.tools[0]).toEqual({
			type: 'function',
			function: { name: 'stock', description: 'Stock', parameters: TOOLS[0]?.parameters },
		});
		const bare = /** @type {any} */ (
			WIRE.compatible.build({ model: 'm', messages: [{ role: 'user', content: 'Hi' }], temperature: 0, maxTokens: 5 }).body
		);
		expect(bare).not.toHaveProperty('tools');
		expect(bare.messages).toEqual([{ role: 'user', content: 'Hi' }]);
		expect(
			WIRE.openai.parse({
				choices: [
					{
						message: {
							content: ' Hello ',
							tool_calls: [
								{ id: 'a', function: { name: 'stock', arguments: '{"sku":"B"}' } },
								{ function: { name: 'ping', arguments: {} } },
								{ function: {} },
							],
						},
						finish_reason: 'tool_calls',
					},
				],
				usage: { prompt_tokens: 12, completion_tokens: 4 },
			}),
		).toEqual({
			text: 'Hello',
			toolCalls: [
				{ id: 'a', name: 'stock', arguments: { sku: 'B' } },
				{ id: 'call_1', name: 'ping', arguments: {} },
			],
			usage: { input: 12, output: 4 },
			finish: 'tool_calls',
		});
		expect(WIRE.openai.parse({})).toMatchObject({ text: '', toolCalls: [], usage: { input: 0, output: 0 }, finish: null });
	});

	it('builds and parses Anthropic and Gemini requests with tools', () => {
		const anthropic = WIRE.anthropic.build({ model: 'm', messages: MESSAGES, tools: TOOLS, temperature: 0.2, maxTokens: 50 });
		expect(anthropic.body).toMatchObject({ system: 'Rules', max_tokens: 50 });
		expect(/** @type {any} */ (anthropic.body).messages.map((/** @type {any} */ m) => m.role)).toEqual([
			'user',
			'assistant',
			'user',
			'assistant',
		]);
		expect(
			WIRE.anthropic.parse({
				content: [
					{ type: 'text', text: 'Hi ' },
					{ type: 'tool_use', id: 't', name: 'stock', input: { sku: 'A' } },
				],
				usage: { input_tokens: 5, output_tokens: 2 },
				stop_reason: 'tool_use',
			}),
		).toEqual({
			text: 'Hi',
			toolCalls: [{ id: 't', name: 'stock', arguments: { sku: 'A' } }],
			usage: { input: 5, output: 2 },
			finish: 'tool_use',
		});
		expect(WIRE.anthropic.parse(null)).toMatchObject({ text: '', toolCalls: [], finish: null });
		const google = WIRE.google.build({ model: 'gemini', messages: MESSAGES, tools: TOOLS, temperature: 0, maxTokens: 9 });
		expect(google.path).toBe('/models/gemini:generateContent');
		const declarations = /** @type {any} */ (google.body).tools[0].functionDeclarations;
		expect(declarations[1]).toEqual({ name: 'ping', description: 'Ping' });
		expect(
			WIRE.google.parse({
				candidates: [
					{
						content: { parts: [{ text: 'ok' }, { functionCall: { name: 'stock', args: '{"sku":"B"}' } }] },
						finishReason: 'STOP',
					},
				],
				usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
			}),
		).toEqual({
			text: 'ok',
			toolCalls: [{ id: 'stock-1', name: 'stock', arguments: { sku: 'B' } }],
			usage: { input: 3, output: 1 },
			finish: 'STOP',
		});
		expect(WIRE.google.parse({})).toMatchObject({ text: '', finish: null });
		expect(parseArguments('not json')).toEqual({});
		expect(parseArguments('[1]')).toEqual({});
		expect(parseArguments('')).toEqual({});
		expect(estimateTokens(MESSAGES, 'abcd').output).toBe(1);
	});
});

describe('the check of an AI key value', () => {
	it('names the providers of the contracts and exports its pure part for a browser form', () => {
		expect(AI_PROVIDERS).toBe(CONTRACT_PROVIDERS);
		expect(Object.keys(MODEL_SUGGESTIONS)).toEqual([...AI_PROVIDERS]);
		expect(pure.checkAiConnection).toBe(checkAiConnection);
		expect(pure.estimateTokens).toBe(estimateTokens);
		for (const provider of /** @type {const} */ (['openai', 'anthropic', 'google']))
			expect(PROVIDER_BASE[provider]).toMatch(/^https:\/\//);
	});

	it('accepts what the Portal accepts: trimmed values, a known provider, a model, a public https base URL', () => {
		expect(checkAiConnection({ provider: 'anthropic', apiKey: '  sk-ant-0123456789 ', model: ' claude-haiku-4-5 ' })).toEqual({
			ok: true,
			value: { provider: 'anthropic', apiKey: 'sk-ant-0123456789', model: 'claude-haiku-4-5' },
		});
		expect(
			checkAiConnection({
				provider: 'compatible',
				apiKey: '0123456789',
				model: 'llama',
				baseUrl: ' https://ai.example.com/v1/ ',
			}),
		).toEqual({
			ok: true,
			value: { provider: 'compatible', apiKey: '0123456789', model: 'llama', baseUrl: 'https://ai.example.com/v1' },
		});
		expect(checkAiConnection({ provider: 'google', apiKey: 'k'.repeat(512), model: 'a/b:c@d.e_f-g' })).toMatchObject({
			ok: true,
		});
		expect(checkAiConnection({ provider: 'openai', apiKey: '0123456789', model: 'm', baseUrl: '' })).toMatchObject({
			ok: true,
		});
	});

	it('refuses what the Portal refuses, each with its field and never the key', () => {
		/** @type {Array<[unknown, string | undefined]>} */
		const refused = [
			[null, undefined],
			[[], undefined],
			['sk-test-0123456789', undefined],
			[{ ...KEY, extra: 1 }, 'extra'],
			[{ ...KEY, provider: 'x' }, 'provider'],
			[{ ...KEY, provider: 7 }, 'provider'],
			[{ ...KEY, apiKey: '1234567' }, 'apiKey'],
			[{ ...KEY, apiKey: 7 }, 'apiKey'],
			[{ ...KEY, apiKey: 'k'.repeat(513) }, 'apiKey'],
			[{ ...KEY, model: '' }, 'model'],
			[{ ...KEY, model: 'two words' }, 'model'],
			[{ ...KEY, model: 'm'.repeat(121) }, 'model'],
			[{ ...KEY, baseUrl: 7 }, 'baseUrl'],
			[{ ...KEY, baseUrl: 'https://ai.example.com' }, 'baseUrl'],
			[{ ...KEY, provider: 'compatible' }, 'baseUrl'],
			[{ ...KEY, provider: 'compatible', baseUrl: 'http://ai.example.com' }, 'baseUrl'],
			[{ ...KEY, provider: 'compatible', baseUrl: 'ai.example.com' }, 'baseUrl'],
			[{ ...KEY, provider: 'compatible', baseUrl: 'https://' }, 'baseUrl'],
			[{ ...KEY, provider: 'compatible', baseUrl: 'https://user:pw@ai.example.com' }, 'baseUrl'],
			[{ ...KEY, provider: 'compatible', baseUrl: 'https://ai.example.com/v1?x=1' }, 'baseUrl'],
			[{ ...KEY, provider: 'compatible', baseUrl: 'https://ai.example.com/v1#x' }, 'baseUrl'],
			[{ ...KEY, provider: 'compatible', baseUrl: `https://ai.example.com/${'a'.repeat(2048)}` }, 'baseUrl'],
		];
		for (const [value, field] of refused) {
			const checked = checkAiConnection(value);
			expect([value, checked.ok]).toEqual([value, false]);
			if (checked.ok) continue;
			expect(checked.field).toBe(field);
			expect(checked.message).not.toContain(KEY.apiKey);
		}
	});

	it('a server also asks the outbound policy about a compatible service’s address', () => {
		const value = { provider: 'compatible', apiKey: '0123456789', model: 'llama', baseUrl: 'https://ai.example.com/v1' };
		expect(checkAiConnection(value, () => true)).toMatchObject({ ok: true });
		expect(checkAiConnection(value, () => false)).toMatchObject({ ok: false, field: 'baseUrl' });
		// the policy is not asked about the built-in providers
		expect(checkAiConnection(KEY, () => false)).toMatchObject({ ok: true });
	});
});

describe('the AI client', () => {
	/**
	 * @param {(url: string, init: any) => { status: number, body?: unknown } | Error} answer
	 */
	const clientWith = (answer) => {
		/** @type {Array<{ url: string, init: any }>} */
		const calls = [];
		const send = /** @type {any} */ (
			async (/** @type {string} */ url, /** @type {any} */ init) => {
				calls.push({ url, init });
				const result = answer(url, init);
				if (result instanceof Error) throw result;
				return { status: result.status, headers: {}, body: Buffer.from(JSON.stringify(result.body ?? {})), url };
			}
		);
		return { ai: createAiClient({ send }), calls };
	};
	const REQUEST = {
		messages: [{ role: /** @type {const} */ ('user'), content: 'Hi' }],
		tools: [],
		temperature: 0.2,
		maxTokens: 30,
	};

	it('knows each provider’s address and authentication', () => {
		expect(endpointOf({ provider: 'openai', apiKey: 'k', model: 'm' })).toEqual({
			base: 'https://api.openai.com/v1',
			headers: { authorization: 'Bearer k' },
		});
		expect(endpointOf({ provider: 'anthropic', apiKey: 'k', model: 'm' }).headers).toEqual({
			'x-api-key': 'k',
			'anthropic-version': '2023-06-01',
		});
		expect(endpointOf({ provider: 'google', apiKey: 'k', model: 'm' }).headers).toEqual({ 'x-goog-api-key': 'k' });
		expect(endpointOf({ provider: 'compatible', apiKey: 'k', model: 'm', baseUrl: 'https://ai.example.com/v1' }).base).toBe(
			'https://ai.example.com/v1',
		);
	});

	it('sends one completion to the provider and parses its answer', async () => {
		const { ai, calls } = clientWith(() => ({
			status: 200,
			body: {
				choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }],
				usage: { prompt_tokens: 3, completion_tokens: 1 },
			},
		}));
		const result = await ai.chat(/** @type {any} */ (KEY), REQUEST);
		expect(result).toEqual({
			ok: true,
			value: { text: 'Hello', toolCalls: [], usage: { input: 3, output: 1 }, finish: 'stop' },
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
		expect(calls[0]?.init).toMatchObject({
			method: 'POST',
			redirect: 'error',
			headers: { authorization: 'Bearer sk-test-0123456789', 'content-type': 'application/json' },
		});
		expect(JSON.parse(calls[0]?.init.body)).toMatchObject({ model: 'gpt-4.1-mini', max_tokens: 30 });
		await ai.chat({ provider: 'google', apiKey: 'sk-test-0123456789', model: 'gemini-2.5-flash' }, REQUEST);
		expect(calls[1]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
	});

	it('answers rate_limited, or provider_error for any other failure, never throwing', async () => {
		expect(await clientWith(() => ({ status: 429 })).ai.chat(/** @type {any} */ (KEY), REQUEST)).toEqual({
			ok: false,
			code: 'rate_limited',
		});
		expect(await clientWith(() => ({ status: 500 })).ai.chat(/** @type {any} */ (KEY), REQUEST)).toEqual({
			ok: false,
			code: 'provider_error',
		});
		expect(await clientWith(() => new Error('down')).ai.chat(/** @type {any} */ (KEY), REQUEST)).toEqual({
			ok: false,
			code: 'provider_error',
		});
	});

	it('tests a key with a read-only call to the model list, after its shape', async () => {
		const { ai, calls } = clientWith(() => ({ status: 200 }));
		expect(await ai.test({ ...KEY, apiKey: 'short' })).toEqual({ ok: false, message: 'Enter the API key.' });
		expect(calls).toHaveLength(0);
		expect(await ai.test(KEY)).toEqual({ ok: true });
		expect(calls[0]?.url).toBe('https://api.openai.com/v1/models');
		expect(calls[0]?.init.method).toBeUndefined();
		expect(await clientWith(() => ({ status: 401 })).ai.test(KEY)).toEqual({
			ok: false,
			message: 'The provider refused the key.',
		});
		expect(await clientWith(() => ({ status: 403 })).ai.test(KEY)).toEqual({
			ok: false,
			message: 'The provider refused the key.',
		});
		expect(await clientWith(() => ({ status: 503 })).ai.test(KEY)).toEqual({
			ok: false,
			message: 'The provider answered 503.',
		});
		expect(await clientWith(() => new Error('down')).ai.test(KEY)).toEqual({
			ok: false,
			message: 'The provider cannot be reached.',
		});
	});

	it('vets a compatible service’s address with the product’s outbound policy', async () => {
		const compatible = { provider: 'compatible', apiKey: '0123456789', model: 'llama', baseUrl: 'https://ai.example.com/v1' };
		const send = /** @type {any} */ (async () => ({ status: 200, headers: {}, body: Buffer.from('{}'), url: '' }));
		const strict = createAiClient({ send, policy: createOutboundPolicy() });
		expect(await strict.test(compatible)).toEqual({ ok: true });
		expect(await strict.test({ ...compatible, baseUrl: 'https://10.0.0.5/v1' })).toEqual({
			ok: false,
			message: 'Enter the public https base URL of the service.',
		});
		// the default policy is the strict one too
		expect(await createAiClient({ send }).test({ ...compatible, baseUrl: 'https://localhost/v1' })).toMatchObject({
			ok: false,
		});
	});
});
