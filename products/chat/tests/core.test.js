/**
 * Pure logic: AI wire formats, the answer loop, flows, fields and leads, tools, handoff and office hours, caps,
 * reports, moderation, language, knowledge, prompt and AI connection checks.
 */
import { describe, expect, it } from 'vitest';
import { runAssistant } from '../core/assistant.js';
import { alertCrossed, capReached } from '../core/caps.js';
import { deviceOf, limitNext, messageText, pageContext, statusAfter } from '../core/conversation.js';
import { checkCustomFields, checkFieldValue, checkLead, checkPageRules } from '../core/fields.js';
import { advance, answerStep, checkFlows, waitingView } from '../core/flows.js';
import { handoffReason, officeState, parseOfficeHours } from '../core/handoff.js';
import { checkEntry, chunkText, decodeEntities, htmlToText } from '../core/knowledge.js';
import { detectLanguage, isLanguageNeutral, replyMatchesLanguage } from '../core/language.js';
import { checkAiConnection } from '../core/models.js';
import { applyLinkPolicy, ibanValid, leakCheck, moderateInbound, moderateOutbound, redact } from '../core/moderation.js';
import { buildSystemPrompt } from '../core/prompt.js';
import { WIRE, estimateTokens, parseArguments } from '../core/providers.js';
import { reportRange, summarise } from '../core/reports.js';
import { pathMatches, truncate } from '../core/text.js';
import { dayStart, isOpenAt, nextOpenAt, zoneOr } from '../core/time.js';
import { checkArguments, checkTools, slotRange, toolOutput } from '../core/tools.js';
import { endpointOf } from '../adapters/ai.js';

const MESSAGES = /** @type {import('../core/providers.js').ChatMessage[]} */ ([
	{ role: 'system', content: 'Rules' },
	{ role: 'user', content: 'Hi' },
	{ role: 'assistant', content: 'Let me check', toolCalls: [{ id: 'c1', name: 'stock', arguments: { sku: 'A' } }] },
	{ role: 'tool', toolCallId: 'c1', toolName: 'stock', content: '3' },
	{ role: 'tool', toolCallId: 'c2', toolName: 'price', content: '9' },
	{ role: 'assistant', content: '' },
]);
const TOOLS = [
	{ name: 'stock', description: 'Stock', parameters: { type: 'object', properties: { sku: { type: 'string' } } } },
	{ name: 'ping', description: 'Ping', parameters: { type: 'object', properties: {} } },
];

describe('AI wire formats', () => {
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
		expect(WIRE.openai.parse({})).toMatchObject({ text: '', toolCalls: [] });
		expect(parseArguments('not json')).toEqual({});
		expect(parseArguments('[1]')).toEqual({});
		expect(estimateTokens(MESSAGES, 'abcd').output).toBe(1);
	});

	it('the answer loop: deadline, budget, provider errors, empty and language failures', async () => {
		/** @param {string} text @returns {{ ok: true, value: import('../core/providers.js').ChatResult }} */
		const ok = (text) => ({ ok: true, value: { text, toolCalls: [], usage: { input: 0, output: 0 }, finish: null } });
		/** @type {import('../core/assistant.js').AssistantDeps} */
		const deps = {
			call: async () => ok('Hi'),
			execute: async () => ({ content: '' }),
			remainingTokens: () => 10,
			spend: () => undefined,
			expired: () => false,
		};
		expect(
			(await runAssistant({ messages: MESSAGES, tools: [], maxRounds: 0 }, { ...deps, expired: () => true })).failure,
		).toBe('timeout');
		expect(
			(await runAssistant({ messages: MESSAGES, tools: [], maxRounds: 0 }, { ...deps, remainingTokens: () => 0 })).failure,
		).toBe('budget');
		expect(
			(
				await runAssistant(
					{ messages: MESSAGES, tools: [], maxRounds: 0 },
					{ ...deps, call: async () => /** @type {const} */ ({ ok: false, code: 'x' }) },
				)
			).failure,
		).toBe('provider_error');
		expect(
			(await runAssistant({ messages: MESSAGES, tools: [], maxRounds: 0 }, { ...deps, call: async () => ok(' ') })).failure,
		).toBe('empty');
		expect((await runAssistant({ messages: MESSAGES, tools: [], maxRounds: 0, languageOk: () => false }, deps)).failure).toBe(
			'language',
		);
		const retried = await runAssistant(
			{ messages: MESSAGES, tools: [], maxRounds: 0, languageOk: () => false, retryInstruction: 'again' },
			deps,
		);
		expect(retried).toMatchObject({ failure: 'language', retried: true });
	});

	it('provider endpoints and AI connection checks', () => {
		expect(endpointOf({ provider: 'anthropic', apiKey: 'k', model: 'm' }).headers).toHaveProperty('x-api-key', 'k');
		expect(endpointOf({ provider: 'google', apiKey: 'k', model: 'm' }).headers).toEqual({ 'x-goog-api-key': 'k' });
		expect(endpointOf({ provider: 'compatible', apiKey: 'k', model: 'm', baseUrl: 'https://ai.example.com/v1' }).base).toBe(
			'https://ai.example.com/v1',
		);
		expect(checkAiConnection(null)).toMatchObject({ ok: false });
		expect(checkAiConnection({ provider: 'x' })).toMatchObject({ ok: false });
		expect(checkAiConnection({ provider: 'openai', apiKey: '0123456789', model: '' })).toMatchObject({ ok: false });
		expect(
			checkAiConnection({ provider: 'compatible', apiKey: '0123456789', model: 'llama', baseUrl: 'http://x' }),
		).toMatchObject({ ok: false });
		expect(
			checkAiConnection({
				provider: 'compatible',
				apiKey: '0123456789',
				model: 'llama',
				baseUrl: 'https://ai.example.com/v1/',
			}),
		).toEqual({
			ok: true,
			value: { provider: 'compatible', apiKey: '0123456789', model: 'llama', baseUrl: 'https://ai.example.com/v1' },
		});
	});
});

describe('conversations, flows and fields', () => {
	it('statuses, texts, pages and devices', () => {
		expect(statusAfter('resolved', 'visitor')).toBe('open');
		expect(statusAfter('open', 'staff')).toBe('awaiting_visitor');
		expect(statusAfter('open', 'ai')).toBe('open');
		expect(limitNext({ signedInChat: true, signInUrl: '', leads: false })).toBe('none');
		expect(messageText(undefined, { allowEmpty: true })).toBe('');
		expect(messageText('   ', { allowEmpty: true })).toBe('');
		expect(messageText(5)).toBeNull();
		expect(messageText('x'.repeat(4001))).toBeNull();
		expect(pageContext('x')).toBeNull();
		expect(pageContext({ url: 'javascript:alert(1)', kind: 'weird' })).toEqual({
			url: '',
			title: '',
			kind: 'other',
			productId: null,
			productName: null,
		});
		expect(deviceOf('Mozilla/5.0 (iPhone) Mobile Safari/604.1')).toBe('Phone · Safari');
		expect(deviceOf('Mozilla/5.0 (iPad) Chrome/120.0')).toBe('Tablet · Chrome');
		expect(deviceOf('Firefox/120.0')).toBe('Computer · Firefox');
		expect(deviceOf('Edg/120.0')).toBe('Computer · Edge');
		expect(deviceOf(null)).toBe('Computer · Browser');
	});

	it('checks flows and runs their steps', () => {
		expect(checkFlows('x')).toMatchObject({ ok: false });
		const bad = checkFlows([
			'x',
			{ id: 'Bad id' },
			{ id: 'a', name: 'A', start: { kind: 'page', path: 'no-slash' }, steps: [] },
			{
				id: 'b',
				name: 'B',
				start: { kind: 'keyword', keywords: ['k'] },
				steps: [
					'x',
					{ kind: 'message' },
					{ kind: 'question', text: 'Q', buttons: [] },
					{ kind: 'collect', field: 'shoe', text: 'Size?' },
					{ kind: 'dance', text: 'x' },
				],
			},
		]);
		expect(bad.ok ? [] : bad.errors).toHaveLength(9);
		const flow = /** @type {import('../core/flows.js').Flow} */ ({
			id: 'f',
			name: 'F',
			start: { kind: 'keyword', keywords: ['k'] },
			steps: [
				{ kind: 'handoff' },
				{ kind: 'message', text: 'Hi' },
				{ kind: 'collect', field: 'text', text: 'Why?' },
				{ kind: 'collect', field: 'phone', text: 'Phone?' },
			],
		});
		expect(advance(flow, 0, { handoff: false })).toEqual({
			messages: [{ text: 'Hi' }, { text: 'Why?' }],
			waitAt: 2,
			handoff: false,
		});
		expect(advance(flow, 4, { handoff: true })).toEqual({ messages: [], waitAt: null, handoff: false });
		expect(answerStep(flow, 2, 'Because', [])).toEqual({ ok: true, key: 'f:3', value: 'Because' });
		expect(answerStep(flow, 3, 'abc', [])).toEqual({ ok: false });
		expect(answerStep(flow, 1, 'x', [])).toEqual({ ok: false });
		expect(answerStep({ ...flow, steps: [{ kind: 'collect', field: 'custom:gone', text: '?' }] }, 0, 'x', [])).toEqual({
			ok: false,
		});
		expect(waitingView({ kind: 'message', text: 'x' }, [])).toBeNull();
		expect(waitingView(undefined, [])).toEqual({ kind: 'question', buttons: [] });
	});

	it('custom fields, values, leads and page rules', () => {
		expect(checkCustomFields('x')).toMatchObject({ ok: false });
		const bad = checkCustomFields([
			{ key: 'name', label: 'Name', type: 'text' },
			{ key: 'c', label: 'C', type: 'choice', options: [] },
		]);
		expect(bad.ok ? [] : bad.errors).toHaveLength(2);
		const field = { key: 'k', label: 'K', options: [] };
		expect(checkFieldValue({ ...field, type: 'yes_no' }, true)).toEqual({ ok: true, value: true });
		expect(checkFieldValue({ ...field, type: 'yes_no' }, 'no')).toEqual({ ok: true, value: false });
		expect(checkFieldValue({ ...field, type: 'yes_no' }, 'maybe')).toEqual({ ok: false });
		expect(checkFieldValue({ ...field, type: 'number' }, '')).toEqual({ ok: false });
		expect(checkFieldValue({ ...field, type: 'text' }, 5)).toEqual({ ok: false });
		const lead = checkLead(
			{ fields: { email: 'bad', size: 'XL' } },
			{
				fields: ['email'],
				customKeys: ['size', 'gone'],
				customFields: [{ key: 'size', label: 'Size', type: 'choice', options: ['S'] }],
				consentRequired: false,
			},
		);
		expect(lead.ok ? [] : lead.errors).toEqual([
			'email is not valid.',
			'email is required.',
			'Leave an e-mail address or a phone number.',
			'Size is not valid.',
		]);
		expect(checkLead(null, { fields: [], customKeys: [], customFields: [], consentRequired: false })).toMatchObject({
			ok: true,
		});
		expect(checkPageRules('x')).toMatchObject({ ok: false });
		expect(checkPageRules([{ path: '/', delay: -1, message: 'm' }])).toMatchObject({ ok: false });
	});

	it('webhook tools, arguments and slot ranges', () => {
		expect(checkTools('x')).toMatchObject({ ok: false });
		const bad = checkTools([
			'x',
			{ name: 'escalate_to_human' },
			{
				name: 'ok_tool',
				description: '',
				url: 'http://x',
				parameters: [{ name: '1bad' }, ...Array.from({ length: 11 }, (_, i) => ({ name: `p${i}`, type: 'string' }))],
			},
		]);
		expect(bad.ok ? [] : bad.errors.length).toBeGreaterThanOrEqual(5);
		const tool = /** @type {import('../core/tools.js').WebhookTool} */ ({
			name: 't',
			description: 'd',
			url: 'https://x.example.com',
			includeVisitor: false,
			parameters: [
				{ name: 'n', type: 'number', description: '', required: false },
				{ name: 'b', type: 'boolean', description: '', required: false },
				{ name: 's', type: 'string', description: '', required: true },
			],
		});
		expect(checkArguments(tool, { n: '3', b: true, s: 'x' })).toEqual({ ok: true, value: { n: 3, b: true, s: 'x' } });
		expect(checkArguments(tool, { n: 'x', s: 'x' })).toEqual({ ok: false });
		expect(checkArguments(tool, { b: 'yes', s: 'x' })).toEqual({ ok: false });
		expect(checkArguments(tool, {})).toEqual({ ok: false });
		expect(slotRange({}, { today: '2026-10-05', daysAhead: 2 })).toEqual({ from: '2026-10-05', to: '2026-10-07' });
		expect(slotRange({ from: '2026-12-01' }, { today: '2026-10-05', daysAhead: 2 })).toBeNull();
		expect(toolOutput('x'.repeat(5000))).toHaveLength(4001);
	});
});

describe('handoff, time, caps and reports', () => {
	it('handoff reasons, office hours and their next opening', () => {
		expect(handoffReason('connect me to an agent', { askPhrases: ['agent'], keywords: [] })).toBe('asked');
		expect(handoffReason('refund please', { askPhrases: [], keywords: ['refund'] })).toBe('keyword');
		expect(handoffReason('hello', { askPhrases: [], keywords: [] })).toBeNull();
		const windows = parseOfficeHours(['sat-mon 22:00-02:00', 'bad line', 'xyz 09:00-10:00']);
		expect(windows).toEqual([{ days: ['sat', 'sun', 'mon'], start: '22:00', end: '02:00' }]);
		const sundayLate = Date.parse('2026-10-04T23:00:00Z');
		expect(officeState(windows, sundayLate, 'UTC')).toEqual({ open: true, backAt: null });
		expect(isOpenAt(windows, Date.parse('2026-10-05T01:00:00Z'), 'UTC')).toBe(true);
		expect(nextOpenAt([{ days: [], start: '09:00', end: '10:00' }], 0, 'UTC')).toBeNull();
		expect(zoneOr('Not/AZone', 'Also/Bad')).toBe('UTC');
		expect(new Date(dayStart('2026-07-01', 'America/New_York')).toISOString()).toBe('2026-07-01T04:00:00.000Z');
	});

	it('caps, alerts and report ranges', () => {
		expect(capReached({ day: 10, month: 10 }, { dailyTokens: 10, monthlyTokens: 0 })).toBe(true);
		expect(capReached({ day: 0, month: 0 }, { dailyTokens: 0, monthlyTokens: 0 })).toBe(false);
		expect(alertCrossed({ before: 0, after: 100, monthlyTokens: 0, percent: 50 })).toBe(false);
		expect(reportRange({ from: 'x' }, 0, 'UTC')).toBeNull();
		expect(reportRange({ from: '2020-01-01', to: '2026-01-01' }, 0, 'UTC')).toBeNull();
		const report = summarise({
			rows: [
				{
					createdAt: new Date('2026-10-01T00:00:00Z'),
					visitorMessages: 1,
					aiReplies: 0,
					staffReplied: true,
					handedOffAt: null,
					firstVisitorAt: new Date('2026-10-01T00:00:00Z'),
					firstStaffReplyAt: new Date('2026-10-01T00:01:00Z'),
					status: 'open',
					rating: null,
				},
				{
					createdAt: new Date('2026-09-01T00:00:00Z'),
					visitorMessages: 1,
					aiReplies: 0,
					staffReplied: true,
					handedOffAt: null,
					firstVisitorAt: new Date('2026-09-01T00:00:00Z'),
					firstStaffReplyAt: new Date('2026-09-01T00:03:00Z'),
					status: 'open',
					rating: null,
				},
			],
			dates: ['2026-10-01'],
			timeZone: 'UTC',
			leads: 0,
			aiTokens: 0,
		});
		expect(report).toMatchObject({ medianFirstReplySeconds: 120, rating: { average: null, count: 0 } });
	});
});

describe('moderation, language, knowledge and the prompt', () => {
	it('redacts, filters links and leaks', () => {
		expect(
			redact(
				'card 4111 1111 1111 1111, iban GB82 WEST 1234 5698 7654 32, ip 10.0.0.1, call +44 20 7946 0958',
				['card', 'iban', 'ip', 'phone'],
				{},
			).text,
		).toBe('card [card], iban [iban], ip [ip], call [phone]');
		expect(ibanValid('GB00WEST12345698765432')).toBe(false);
		expect(
			applyLinkPolicy('[a](https://evil.example.com) https://shop.example.com/x [b](/p) mailto:x', {
				mode: 'website',
				websiteDomain: 'shop.example.com',
			}),
		).toBe('a https://shop.example.com/x [b](/p) mailto:x');
		expect(applyLinkPolicy('[a](https://x.example.com)', { mode: 'none' })).toBe('a');
		expect(
			applyLinkPolicy('[a](https://x.example.com) [c](ftp://x) [d](https://u:p@x.example.com) [e](notaurl)', { mode: 'any' }),
		).toBe('[a](https://x.example.com) c d e');
		expect(applyLinkPolicy('[a](https://docs.example.com)', { mode: 'allow_list', hosts: ['example.com'] })).toBe(
			'[a](https://docs.example.com)',
		);
		expect(leakCheck('our internal codename', { phrases: ['Internal Codename'] })).toEqual({ ok: false, reason: 'internals' });
		expect(moderateInbound('x', null, {})).toEqual({ ok: true, text: 'x' });
		expect(moderateOutbound('MONGODB_URI is set', null, { labels: {}, websiteDomain: 'x' }).ok).toBe(false);
	});

	it('detects languages and checks answers', () => {
		const markers = [
			{ language: 'tl', words: ['hai', 'kya', 'mein'] },
			{ language: 'en', words: ['the', 'is', 'and'] },
		];
		expect(detectLanguage('kya hai', { fallback: 'en', markers })).toMatchObject({ language: 'tl', confident: true });
		expect(detectLanguage('hello', { fallback: 'en', markers })).toMatchObject({ language: 'en', confident: false });
		expect(detectLanguage('Привет', { fallback: 'en', allowed: ['en'] })).toMatchObject({ language: 'en', confident: false });
		expect(replyMatchesLanguage('| a | b |\n|---|---|', 'ar')).toBe(true);
		expect(replyMatchesLanguage('', 'en')).toBe(false);
		expect(replyMatchesLanguage('123', 'en')).toBe(true);
		expect(replyMatchesLanguage('Привет мир', 'en')).toBe(false);
		expect(replyMatchesLanguage('the cat is here and kya', 'en', { markers })).toBe(true);
		expect(replyMatchesLanguage('yeh kya hai mein bahut acha', 'en', { markers })).toBe(false);
		expect(isLanguageNeutral('')).toBe(false);
	});

	it('extracts page text, chunks and checks entries; builds the prompt', () => {
		expect(decodeEntities('&amp;&#65;&#x42;&#0;&bogus;')).toBe('&AB &bogus;');
		expect(htmlToText('<p>No title</p>').title).toBe('');
		expect(
			chunkText(`${'a '.repeat(600)}\n${'b. '.repeat(400)}\n${'c'.repeat(2000)}`, { size: 900, overlap: 100, max: 3 }),
		).toHaveLength(3);
		expect(checkEntry({ kind: 'x', title: '', text: '' })).toMatchObject({ ok: false });
		expect(checkEntry(null)).toMatchObject({ ok: false });
		const prompt = buildSystemPrompt({
			botName: 'Bo',
			business: { name: 'Shop', phone: '+1 555', address: 'Main St' },
			instructions: null,
			dontKnow: 'Say so.',
			language: null,
			passages: [{ title: 'FAQ', url: 'https://shop.example.com/faq', text: 'Answer' }],
			visitor: { signedIn: true, name: null },
			page: { url: '', title: '', kind: 'cart', productName: null },
			handoff: false,
		});
		expect(prompt).toContain('phone +1 555, address Main St');
		expect(prompt).toContain('The visitor is signed in.');
		expect(prompt).toContain('viewing a cart page.');
		expect(truncate('abc', 2)).toBe('a…');
		expect(pathMatches('/a/*/c', '/a/b/c')).toBe(true);
		expect(pathMatches('/a/**', '/b')).toBe(false);
	});
});
