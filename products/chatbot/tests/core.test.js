/** Pure core: text, language, moderation, knowledge, providers, the answer loop, budgets and time. */
import { describe, expect, it } from 'vitest';
import { runAssistant } from '../core/assistant.js';
import { alertCrossed, outputCap, remainingTokens } from '../core/budget.js';
import { defaultsOf, effectiveConfig } from '../core/config.js';
import {
	catalogLanguage,
	detectLanguage,
	dominantScript,
	isAllowed,
	isLanguageNeutral,
	languageName,
	markerScores,
	replyMatchesLanguage,
	scriptOf,
} from '../core/language.js';
import {
	chunkText,
	decodeEntities,
	faqChunks,
	htmlToText,
	pageChunks,
	passages,
	queryTerms,
	rank,
	termsOf,
	validateEntry,
} from '../core/knowledge.js';
import {
	applyBlockedTerms,
	applyLinkPolicy,
	ibanValid,
	leakCheck,
	linkAllowed,
	luhn,
	moderateInbound,
	moderateOutbound,
	redact,
	splitBubbles,
	tidy,
} from '../core/moderation.js';
import {
	estimateTokens,
	fromAnthropic,
	fromGoogle,
	fromOpenAi,
	parseArguments,
	resolveModel,
	toAnthropic,
	toGoogle,
	toOpenAi,
	WIRE,
} from '../core/providers.js';
import { createTranslator } from '../core/strings.js';
import { containsPhrase, fill, isText, length, normalise, pathMatches, tokenize, truncate } from '../core/text.js';
import {
	addWorkingMinutes,
	dayKey,
	isOpenAt,
	isTimeZone,
	iso,
	localParts,
	minutesOf,
	monthKey,
	nextOpenAt,
	zoneOr,
} from '../core/time.js';
import windowSchema from '../schemas/window.features.json' with { type: 'json' };

const markers = /** @type {any} */ (windowSchema.properties.language_markers.default);
const labels = { card: '[card]', iban: '[iban]', email: '[email]', phone: '[phone]', ip: '[ip]' };

describe('text', () => {
	it('normalises and tokenises any script', () => {
		expect(normalise('  Ça  VA?  ')).toBe('ca va?');
		expect(normalise(42)).toBe('');
		expect(tokenize('Where is my order #1042?')).toEqual(['where', 'is', 'my', 'order', '1042']);
		expect(tokenize('配送料金')).toEqual(['配送', '送料', '料金']);
		expect(tokenize('猫')).toEqual(['猫']);
		expect(tokenize('a b c', { minLength: 1, max: 2 })).toEqual(['a', 'b']);
		expect(containsPhrase('Can I talk to someone please?', 'talk to someone')).toBe(true);
		expect(containsPhrase('I want to talk', 'talk to someone')).toBe(false);
		expect(containsPhrase('anything', '')).toBe(false);
	});
	it('fills, truncates and matches paths', () => {
		expect(
			fill('Hi {name}, {vars.order.id} {missing} {vars.list}', { name: 'Ana', vars: { order: { id: 7 }, list: [1] } }),
		).toBe('Hi Ana, 7 {missing} [1]');
		expect(fill('{a}', { a: null })).toBe('');
		expect(truncate('abcdef', 4)).toBe('abc…');
		expect(truncate('ab', 4)).toBe('ab');
		expect(truncate(undefined, 3)).toBe('');
		expect(length('👍🏽')).toBe(2);
		expect(isText(' x ')).toBe(true);
		expect(isText('  ')).toBe(false);
		expect(pathMatches('/products/*', '/products/sofa')).toBe(true);
		expect(pathMatches('/products/*', '/products/sofa/red')).toBe(false);
		expect(pathMatches('/products/**', '/products/sofa/red?x=1')).toBe(true);
		expect(pathMatches('/blog/post-*', '/blog/post-12/')).toBe(true);
		expect(pathMatches('/blog/post-*', '/blog/news')).toBe(false);
		expect(pathMatches('/a', '/')).toBe(false);
		expect(pathMatches('/', '/')).toBe(true);
	});
	it('translates with placeholders', () => {
		const t = createTranslator({ hi: 'Hi {name}' });
		expect(t('hi', { name: 'Ana' })).toBe('Hi Ana');
		expect(t('hi')).toBe('Hi {name}');
		expect(t('missing')).toBe('missing');
	});
});

describe('language (detection and lock, without regional assumptions)', () => {
	const fallback = 'en';
	it('detects non-Latin scripts from Unicode', () => {
		expect(detectLanguage('مرحبا، أين طلبي؟', { fallback })).toMatchObject({
			language: 'ar',
			script: 'Arabic',
			confident: true,
		});
		expect(detectLanguage('Привет, где мой заказ?', { fallback })).toMatchObject({ language: 'ru' });
		expect(detectLanguage('注文はどこですか', { fallback })).toMatchObject({ language: 'ja' });
		expect(detectLanguage('我的订单在哪里', { fallback })).toMatchObject({ language: 'zh' });
		expect(detectLanguage('주문이 어디에 있나요', { fallback })).toMatchObject({ language: 'ko' });
		expect(detectLanguage('สวัสดีครับ', { fallback })).toMatchObject({ language: 'th' });
		// an allowed language of the same script wins (Urdu is written in Arabic script)
		expect(detectLanguage('میرا آرڈر کہاں ہے', { fallback: 'en', allowed: ['en', 'ur'] })).toMatchObject({ language: 'ur' });
		// a script whose languages are not allowed falls back
		expect(detectLanguage('Привет', { fallback: 'en', allowed: ['en', 'de'] })).toMatchObject({
			language: 'en',
			confident: false,
		});
	});
	it('tells Latin-script languages apart by marker words', () => {
		expect(detectLanguage('Hola, quiero saber dónde está mi pedido por favor', { fallback, markers })).toMatchObject({
			language: 'es',
		});
		expect(detectLanguage('Bonjour, je ne trouve pas ma commande', { fallback, markers })).toMatchObject({ language: 'fr' });
		expect(detectLanguage('Hallo, ich habe eine Frage und bitte um Hilfe', { fallback, markers })).toMatchObject({
			language: 'de',
		});
		expect(detectLanguage('Where is my order and how can I track it?', { fallback: 'de', markers })).toMatchObject({
			language: 'en',
		});
		expect(detectLanguage('gracias', { fallback, markers })).toMatchObject({ language: 'es' });
		expect(detectLanguage('ok', { fallback: 'pt', markers })).toMatchObject({ language: 'pt', confident: false });
		// romanised languages are just more marker sets
		const roman = [...markers, { language: 'ur-Latn', words: ['kya', 'hai', 'mera', 'kahan'] }];
		expect(detectLanguage('mera order kahan hai', { fallback, markers: roman, allowed: ['en', 'ur-Latn'] })).toMatchObject({
			language: 'ur-Latn',
		});
		expect(scriptOf('ur-Latn')).toBe('Latin');
		expect(scriptOf('sr-Cyrl')).toBe('Cyrillic');
		expect(scriptOf('zh-Hant-TW')).toBe('Han');
	});
	it('checks that answers match the required language', () => {
		expect(replyMatchesLanguage('Your order ships tomorrow.', 'en', { markers })).toBe(true);
		expect(replyMatchesLanguage('Tu pedido se envía mañana, gracias por la espera y por tu compra', 'en', { markers })).toBe(
			false,
		);
		expect(replyMatchesLanguage('تم شحن طلبك', 'ar')).toBe(true);
		expect(replyMatchesLanguage('Your order shipped', 'ar')).toBe(false);
		expect(replyMatchesLanguage('ご注文は明日発送されます', 'ja')).toBe(true);
		expect(replyMatchesLanguage('Привет мир', 'en')).toBe(false);
		expect(replyMatchesLanguage('| SKU | Qty |\n| --- | --- |\n| A1 | 2 |', 'fr')).toBe(true);
		expect(replyMatchesLanguage('12345', 'fr')).toBe(true);
		expect(replyMatchesLanguage('', 'en')).toBe(false);
		expect(replyMatchesLanguage('Gracias por la espera', 'es', { markers })).toBe(true);
	});
	it('helpers', () => {
		expect(scriptOf('pt-BR')).toBe('Latin');
		expect(scriptOf('uk')).toBe('Cyrillic');
		expect(dominantScript('abc')).toBeNull();
		expect(dominantScript('')).toBeNull();
		expect(isAllowed('pt-BR', ['pt'])).toBe(true);
		expect(isAllowed('de', ['pt'])).toBe(false);
		expect(isAllowed('de', [])).toBe(true);
		expect(isLanguageNeutral('hello')).toBe(false);
		expect(markerScores('the the and', markers)[0]).toEqual({ language: 'en', hits: 3 });
		expect(languageName('pt-BR')).toBe('Brazilian Portuguese');
		expect(languageName('!!')).toBe('!!');
		expect(catalogLanguage('pt-BR', ['en', 'pt'], 'en')).toBe('pt');
		expect(catalogLanguage('fr-CA', ['en', 'fr-CA'], 'en')).toBe('fr-CA');
		expect(catalogLanguage('xx', ['en'], 'en')).toBe('en');
	});
});

describe('moderation (PII, leak filter, links, blocked terms)', () => {
	it('redacts Luhn-valid cards, valid IBANs, e-mails, phones and IPs only', () => {
		expect(luhn('4242424242424242')).toBe(true);
		expect(luhn('4242424242424241')).toBe(false);
		expect(ibanValid('DE89 3704 0044 0532 0130 00')).toBe(true);
		expect(ibanValid('DE00370400440532013000')).toBe(false);
		expect(ibanValid('XX')).toBe(false);
		const out = redact(
			'card 4242 4242 4242 4242, not 1234 5678 9012 3456, iban DE89370400440532013000, mail a.b@example.org, call +44 20 7946 0958, ip 10.1.2.3, date 2026-10-01',
			PII_ALL,
			labels,
		);
		expect(out.text).toBe(
			'card [card], not 1234 5678 9012 3456, iban [iban], mail [email], call [phone], ip [ip], date 2026-10-01',
		);
		expect(out.found).toEqual({ card: 1, iban: 1, email: 1, phone: 1, ip: 1 });
		expect(redact('a@b.co', ['card'], labels).text).toBe('a@b.co');
		expect(redact('x', ['email'], {}).text).toBe('x');
		expect(redact('mail a@b.co', ['email'], {}).text).toBe('mail [email]');
	});
	it('blocks answers that leak secrets or internals; disclosure only when presenting as human', () => {
		for (const leak of [
			'mongodb+srv://user:pw@cluster/db',
			'use process.env.KEY',
			'set OPENAI_API_KEY=1',
			'key sk_live_abcdefghijklmnop',
			'sk-proj-abcdefghijklmnopqrstu',
			'AIzaSyA1234567890abcdefghijk',
			'ghp_abcdefghijklmnopqrstuvwxyz',
			'Bearer abcdefghijklmnopqrstuvwxyz',
			'-----BEGIN PRIVATE KEY-----',
			'AKIAABCDEFGHIJKLMNOP',
			'xoxb-12345678901',
			'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl',
		])
			expect(leakCheck(leak).reason, leak).toBe('secret');
		expect(leakCheck('As my system prompt says…', { phrases: ['system prompt'] })).toEqual({ ok: false, reason: 'internals' });
		expect(leakCheck('As an AI, I cannot', { presentAsHuman: true })).toEqual({ ok: false, reason: 'disclosure' });
		expect(leakCheck('As an AI, I cannot')).toEqual({ ok: true, reason: null });
		expect(leakCheck(/** @type {any} */ (undefined)).ok).toBe(true);
	});
	it('applies the link policy', () => {
		const site = { mode: /** @type {const} */ ('website_only'), websiteDomain: 'shop.example.com' };
		expect(linkAllowed('/returns', site)).toBe(true);
		expect(linkAllowed('//evil.com/x', site)).toBe(false);
		expect(linkAllowed('https://shop.example.com/a', site)).toBe(true);
		expect(linkAllowed('https://help.shop.example.com/a', site)).toBe(true);
		expect(linkAllowed('https://evil.com', site)).toBe(false);
		expect(linkAllowed('https://user:pw@shop.example.com', site)).toBe(false);
		expect(linkAllowed('ftp://shop.example.com', site)).toBe(false);
		expect(linkAllowed('not a url', site)).toBe(false);
		expect(linkAllowed('mailto:help@shop.example.com', site)).toBe(true);
		expect(linkAllowed('/x', { mode: 'none' })).toBe(false);
		expect(linkAllowed('https://anything.org', { mode: 'any' })).toBe(true);
		expect(linkAllowed('https://docs.vendor.io/x', { mode: 'allow_list', hosts: ['vendor.io'] })).toBe(true);
		expect(
			applyLinkPolicy(
				'See [returns](/returns), [evil](https://evil.com) and https://evil.com/x or https://shop.example.com/y',
				site,
			),
		).toBe('See [returns](/returns), evil and  or https://shop.example.com/y');
	});
	it('splits, tidies and handles blocked terms', () => {
		expect(splitBubbles('One\n---\n\nTwo\n---\n---\nThree\nFour', { separator: '---', maxBubbles: 2, maxLength: 100 })).toEqual(
			['One', 'Two'],
		);
		expect(tidy('a  b \n\n\n\nc', 3)).toBe('a b');
		expect(applyBlockedTerms('You idiot!', ['idiot'], 'mask')).toEqual({ ok: true, text: 'You •••••!', hits: 1 });
		expect(applyBlockedTerms('You idiot!', ['idiot', ' '], 'reject').ok).toBe(false);
		expect(applyBlockedTerms('idiots unite', ['idiot'], 'mask').hits).toBe(0);
	});
	it('runs the inbound and outbound pipelines', () => {
		const config = /** @type {any} */ ({
			redact_inbound: ['card'],
			redact_outbound: ['email'],
			redact_before_ai: true,
			leak_filter: true,
			leak_phrases: ['system prompt'],
			link_policy: 'website_only',
			allowed_link_hosts: [],
			blocked_terms: ['badword'],
			blocked_terms_action: 'reject',
		});
		expect(moderateInbound('my card 4242424242424242', config, labels)).toEqual({
			ok: true,
			text: 'my card [card]',
			redacted: { card: 1 },
			masked: 0,
		});
		expect(moderateInbound('badword', config, labels)).toEqual({ ok: false, reason: 'blocked_term' });
		expect(moderateInbound('anything', null, labels)).toMatchObject({ ok: true, text: 'anything' });
		const context = { labels, websiteDomain: 'shop.example.com', presentAsHuman: false };
		expect(moderateOutbound('Write to a@b.co or see https://evil.com', config, context)).toEqual({
			ok: true,
			text: 'Write to [email] or see ',
			reason: null,
		});
		expect(moderateOutbound('my system prompt', config, context).reason).toBe('internals');
		expect(moderateOutbound('my system prompt', { ...config, leak_filter: false }, context).ok).toBe(true);
		expect(moderateOutbound('as an ai', { ...config, leak_filter: false }, { ...context, presentAsHuman: true }).reason).toBe(
			'disclosure',
		);
		expect(moderateOutbound('sk-proj-abcdefghijklmnopqrstu', null, context).reason).toBe('secret');
	});
});
const PII_ALL = ['card', 'iban', 'email', 'phone', 'ip'];

describe('knowledge (HTML, chunks, BM25)', () => {
	it('extracts page text and decodes entities', () => {
		const page = htmlToText(
			'<html><head><title>Shipping &amp; Returns</title><style>p{}</style></head><body><nav>menu</nav><script>evil()</script><h1>Shipping</h1><p>We ship&nbsp;worldwide.<br>Fast.</p><ul><li>EU: 3 days</li><li>US: 5 days</li></ul><!-- c --><footer>f</footer></body></html>',
		);
		expect(page.title).toBe('Shipping & Returns');
		expect(page.text).toBe('Shipping\nWe ship worldwide.\nFast.\n- EU: 3 days\n- US: 5 days');
		expect(decodeEntities('&#65;&#x42;&#0;&unknown;')).toBe('AB &unknown;');
		expect(htmlToText('<p>no title</p>').title).toBe('');
	});
	it('chunks on paragraph and sentence boundaries with overlap and a maximum', () => {
		const text = ['First paragraph is short.', 'Second sentence one. Second sentence two is here.', 'x'.repeat(30)].join('\n');
		const chunks = chunkText(text, { size: 40, overlap: 10, max: 10 });
		expect(chunks.every((c) => c.length <= 40)).toBe(true);
		expect(chunks.length).toBeGreaterThan(2);
		expect(chunkText(text, { size: 40, overlap: 0, max: 1 })).toHaveLength(1);
		expect(chunkText('', { size: 40, overlap: 0, max: 5 })).toEqual([]);
	});
	it('ranks with BM25, coverage and priority', () => {
		const faq = faqChunks(
			{ id: 'e1', question: 'Do you ship internationally?', answer: 'Yes, worldwide in 5 days.', tags: ['shipping'] },
			{ priority: 2 },
		).map((c) => ({ ...c, id: 'c1' }));
		const pages = pageChunks(
			{ id: 'p1', url: 'https://x.test/returns', title: 'Returns', text: 'Returns are free within 30 days.', priority: 0 },
			{ size: 200, overlap: 0, max: 5 },
		).map((c, i) => ({ ...c, id: `p${i}` }));
		const chunks = [...faq, ...pages];
		const terms = queryTerms('how long does international shipping take?');
		const df = Object.fromEntries(terms.map((t) => [t, chunks.filter((c) => c.tf[t]).length]));
		const ranked = rank({
			terms,
			chunks,
			stats: { count: chunks.length, avgLength: 10, df },
			k1: 1.2,
			b: 0.75,
			minMatch: 0.1,
			topK: 3,
		});
		expect(ranked[0]?.chunk.id).toBe('c1');
		expect(rank({ terms, chunks, stats: { count: 2, avgLength: 0, df }, k1: 1.2, b: 0.75, minMatch: 0.9, topK: 3 })).toEqual(
			[],
		);
		expect(rank({ terms: [], chunks, stats: { count: 2, avgLength: 1, df: {} }, k1: 1, b: 1, minMatch: 0, topK: 1 })).toEqual(
			[],
		);
		expect(passages(ranked, { maxChars: 10 })[0]).toMatchObject({ ref: 1, title: 'Do you ship internationally?', url: null });
		expect(termsOf('ab cd', { boost: 'cd' }).tf).toEqual({ ab: 1, cd: 3 });
	});
	it('validates FAQ entries', () => {
		expect(validateEntry({ question: 'Q?', answer: 'A.' })).toEqual([]);
		expect(validateEntry(null)).toEqual([{ path: '', code: 'object_required' }]);
		expect(
			validateEntry({ question: ' ', answer: 'x'.repeat(8001), tags: 'x', enabled: 'y', priority: 11, extra: 1 }).map(
				(p) => p.code,
			),
		).toEqual(['required', 'too_long', 'invalid', 'invalid', 'invalid', 'unknown_field']);
		expect(validateEntry({ answer: 'ok' }, { partial: true })).toEqual([]);
	});
});

describe('AI provider wire formats', () => {
	const tools = [
		{ name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
		{ name: 'noargs', description: 'No args', parameters: { type: 'object', properties: {} } },
	];
	const messages = /** @type {any[]} */ ([
		{ role: 'system', content: 'sys' },
		{ role: 'user', content: 'hi' },
		{ role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'lookup', arguments: { q: 'x' } }] },
		{ role: 'tool', toolCallId: 't1', toolName: 'lookup', content: 'result' },
		{ role: 'tool', toolCallId: 't2', toolName: 'noargs', content: 'r2' },
		{ role: 'assistant', content: 'done' },
	]);
	const request = { model: 'm', messages, tools, temperature: 0.2, maxTokens: 100 };
	it('OpenAI / OpenAI-compatible', () => {
		const built = toOpenAi(request);
		expect(built.path).toBe('/chat/completions');
		expect(built.body).toMatchObject({ model: 'm', tool_choice: 'auto', max_tokens: 100 });
		expect(/** @type {any} */ (built.body).messages[2]).toEqual({
			role: 'assistant',
			content: null,
			tool_calls: [{ id: 't1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
		});
		expect(/** @type {any} */ (built.body).messages[3]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'result' });
		expect(toOpenAi({ ...request, tools: [] }).body.tools).toBeUndefined();
		expect(
			fromOpenAi({
				choices: [
					{
						message: {
							content: ' hi ',
							tool_calls: [{ function: { name: 'lookup', arguments: '{"q":1}' } }, { function: {} }],
						},
						finish_reason: 'stop',
					},
				],
				usage: { prompt_tokens: 3, completion_tokens: 2 },
			}),
		).toEqual({
			text: 'hi',
			toolCalls: [{ id: 'call_0', name: 'lookup', arguments: { q: 1 } }],
			usage: { input: 3, output: 2 },
			finish: 'stop',
		});
		expect(fromOpenAi({})).toEqual({ text: '', toolCalls: [], usage: { input: 0, output: 0 }, finish: null });
	});
	it('Anthropic', () => {
		const built = /** @type {any} */ (toAnthropic(request));
		expect(built.path).toBe('/messages');
		expect(built.body.system).toBe('sys');
		expect(built.body.messages.map((/** @type {any} */ m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
		expect(built.body.messages[2].content).toHaveLength(2);
		expect(built.body.tools[0]).toEqual({ name: 'lookup', description: 'Look up', input_schema: tools[0]?.parameters });
		expect(
			fromAnthropic({
				content: [
					{ type: 'text', text: 'a' },
					{ type: 'tool_use', id: 'x', name: 'lookup', input: { q: 'y' } },
					{ type: 'tool_use', name: 'n' },
				],
				usage: { input_tokens: 4, output_tokens: 1 },
				stop_reason: 'tool_use',
			}),
		).toEqual({
			text: 'a',
			toolCalls: [
				{ id: 'x', name: 'lookup', arguments: { q: 'y' } },
				{ id: 'n', name: 'n', arguments: {} },
			],
			usage: { input: 4, output: 1 },
			finish: 'tool_use',
		});
		expect(fromAnthropic(null).text).toBe('');
		expect(
			/** @type {any} */ (toAnthropic({ ...request, messages: [{ role: 'user', content: 'x' }], tools: [] })).body.system,
		).toBeUndefined();
	});
	it('Google Gemini', () => {
		const built = /** @type {any} */ (toGoogle(request));
		expect(built.path).toBe('/models/m:generateContent');
		expect(built.body.systemInstruction.parts[0].text).toBe('sys');
		expect(built.body.contents.map((/** @type {any} */ c) => c.role)).toEqual(['user', 'model', 'user', 'model']);
		expect(built.body.tools[0].functionDeclarations[1]).toEqual({ name: 'noargs', description: 'No args' });
		expect(
			fromGoogle({
				candidates: [
					{
						content: { parts: [{ text: 'hi' }, { functionCall: { name: 'lookup', args: { q: 1 } } }] },
						finishReason: 'STOP',
					},
				],
				usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
			}),
		).toEqual({
			text: 'hi',
			toolCalls: [{ id: 'lookup-1', name: 'lookup', arguments: { q: 1 } }],
			usage: { input: 5, output: 2 },
			finish: 'STOP',
		});
		expect(fromGoogle({}).finish).toBeNull();
		expect(
			/** @type {any} */ (toGoogle({ ...request, messages: [{ role: 'user', content: 'x' }], tools: [] })).body
				.systemInstruction,
		).toBeUndefined();
	});
	it('helpers', () => {
		expect(parseArguments('{bad')).toEqual({});
		expect(parseArguments('[1]')).toEqual({});
		expect(parseArguments('')).toEqual({});
		expect(parseArguments({ a: 1 })).toEqual({ a: 1 });
		expect(WIRE.generic.build).toBe(toOpenAi);
		expect(
			estimateTokens(
				/** @type {any} */ ([
					{ role: 'user', content: 'abcdefgh' },
					{ role: 'assistant', content: '', toolCalls: [{ id: 'a' }] },
				]),
				'abcd',
			),
		).toEqual({ input: 5, output: 1 });
		expect(resolveModel({ provider: 'openai', override: ' ', connectorModel: null, defaults: { openai: 'gpt' } })).toBe('gpt');
		expect(resolveModel({ provider: 'openai', override: 'mine', connectorModel: 'c', defaults: {} })).toBe('mine');
		expect(resolveModel({ provider: 'x', override: '', connectorModel: 'c', defaults: {} })).toBe('c');
		expect(resolveModel({ provider: 'x', override: '', defaults: {} })).toBe('');
	});
});

describe('the answer loop', () => {
	const ok = (/** @type {any} */ value) => ({
		ok: /** @type {const} */ (true),
		value: { text: '', toolCalls: [], usage: { input: 10, output: 5 }, finish: null, ...value },
	});
	/** @param {any[]} script */
	const deps = (script, extra = {}) => {
		const calls = /** @type {any[]} */ ([]);
		const spent = /** @type {any[]} */ ([]);
		return {
			calls,
			spent,
			deps: {
				call: async (/** @type {any} */ request) => {
					calls.push(request);
					return script.shift() ?? ok({ text: 'fallback' });
				},
				execute: async (/** @type {any} */ call) =>
					call.name === 'escalate'
						? { content: 'escalated', escalate: { reason: 'upset' } }
						: { content: `result of ${call.name}`, ok: call.name !== 'broken' },
				remainingTokens: () => 1000,
				spend: (/** @type {any} */ usage) => {
					spent.push(usage);
				},
				expired: () => false,
				...extra,
			},
		};
	};
	const messages = /** @type {any[]} */ ([{ role: 'user', content: 'hi' }]);
	const tools = /** @type {any[]} */ ([{ name: 'lookup', description: '', parameters: {} }]);
	it('runs tools for at most maxRounds, then asks for text without tools', async () => {
		const run = deps([
			ok({
				toolCalls: [
					{ id: '1', name: 'lookup', arguments: {} },
					{ id: '2', name: 'broken', arguments: {} },
				],
			}),
			ok({ toolCalls: [{ id: '3', name: 'escalate', arguments: {} }] }),
			ok({ text: 'final answer' }),
		]);
		const result = await runAssistant({ messages, tools, maxRounds: 2 }, run.deps);
		expect(result).toMatchObject({
			text: 'final answer',
			failure: null,
			calls: 3,
			escalation: { reason: 'upset' },
			usage: { input: 30, output: 15 },
		});
		expect(result.tools).toEqual([
			{ name: 'lookup', ok: true },
			{ name: 'broken', ok: false },
			{ name: 'escalate', ok: true },
		]);
		expect(run.calls[2].tools).toEqual([]);
		expect(run.calls[2].messages.filter((/** @type {any} */ m) => m.role === 'tool')).toHaveLength(3);
	});
	it('estimates usage when the provider reports none', async () => {
		const run = deps([{ ok: true, value: { text: 'abcdefgh', toolCalls: [], usage: { input: 0, output: 0 }, finish: null } }]);
		const result = await runAssistant({ messages, tools: [], maxRounds: 0 }, run.deps);
		expect(result.usage).toEqual({ input: 1, output: 2 });
	});
	it('reports provider errors, timeouts, budgets and empty answers', async () => {
		expect(
			(await runAssistant({ messages, tools, maxRounds: 1 }, deps([{ ok: false, code: 'upstream_error' }]).deps)).failure,
		).toBe('provider_error');
		expect((await runAssistant({ messages, tools, maxRounds: 1 }, deps([], { expired: () => true }).deps)).failure).toBe(
			'timeout',
		);
		expect((await runAssistant({ messages, tools, maxRounds: 1 }, deps([], { remainingTokens: () => 0 }).deps)).failure).toBe(
			'budget',
		);
		expect((await runAssistant({ messages, tools, maxRounds: 1 }, deps([ok({ text: '  ' })]).deps)).failure).toBe('empty');
	});
	it('retries once in the right language, then gives up', async () => {
		const languageOk = (/** @type {string} */ text) => text.startsWith('Hola');
		const fixed = deps([ok({ text: 'Hello' }), ok({ text: 'Hola' })]);
		expect(
			await runAssistant({ messages, tools: [], maxRounds: 0, languageOk, retryInstruction: 'Spanish please' }, fixed.deps),
		).toMatchObject({ text: 'Hola', retried: true, failure: null });
		expect(fixed.calls[1].messages.at(-1)).toEqual({ role: 'user', content: 'Spanish please' });
		const stubborn = deps([ok({ text: 'Hello' }), ok({ text: 'Hello again' })]);
		expect(
			await runAssistant({ messages, tools: [], maxRounds: 0, languageOk, retryInstruction: 'Spanish please' }, stubborn.deps),
		).toMatchObject({ text: '', failure: 'language', retried: true });
		expect(
			(await runAssistant({ messages, tools: [], maxRounds: 0, languageOk }, deps([ok({ text: 'Hello' })]).deps)).failure,
		).toBe('language');
		const failing = deps([ok({ text: 'Hello' }), { ok: false, code: 'upstream_error' }]);
		expect(
			(await runAssistant({ messages, tools: [], maxRounds: 0, languageOk, retryInstruction: 'x' }, failing.deps)).failure,
		).toBe('language');
	});
});

describe('budgets, configuration and time', () => {
	it('token budgets', () => {
		expect(remainingTokens({ conversationUsed: 100, perConversation: 1000, monthUsed: 0, monthly: 0 })).toBe(900);
		expect(remainingTokens({ conversationUsed: 0, perConversation: 0, monthUsed: 990, monthly: 1000 })).toBe(10);
		expect(remainingTokens({ conversationUsed: 0, perConversation: 0, monthUsed: 0, monthly: 0 })).toBe(
			Number.POSITIVE_INFINITY,
		);
		expect(remainingTokens({ conversationUsed: 2000, perConversation: 1000, monthUsed: 0, monthly: 0 })).toBe(0);
		expect(alertCrossed({ before: 70, after: 85, monthly: 100, percent: 80 })).toBe(true);
		expect(alertCrossed({ before: 85, after: 90, monthly: 100, percent: 80 })).toBe(false);
		expect(alertCrossed({ before: 0, after: 90, monthly: 0, percent: 80 })).toBe(false);
		expect(outputCap(500, 120.7)).toBe(120);
		expect(outputCap(500, Number.POSITIVE_INFINITY)).toBe(500);
		expect(outputCap(500, 0)).toBe(1);
	});
	it('effective configuration from schemas', () => {
		const schema = {
			properties: {
				a: { type: 'integer', default: 1 },
				b: { type: 'array', default: [1] },
				c: { type: 'object', default: { x: 1 } },
				d: { type: 'number', default: 0.5 },
				e: { type: 'boolean', default: true },
				f: { type: 'string', default: '' },
				g: { default: null },
			},
		};
		expect(defaultsOf(schema)).toEqual({ a: 1, b: [1], c: { x: 1 }, d: 0.5, e: true, f: '', g: null });
		expect(effectiveConfig(schema, { a: 'x', b: [2], c: [], d: Number.NaN, e: false, f: 'y', g: 3, h: 1 })).toEqual({
			a: 1,
			b: [2],
			c: { x: 1 },
			d: 0.5,
			e: false,
			f: 'y',
			g: 3,
		});
		expect(effectiveConfig({}, null)).toEqual({});
	});
	it('working hours, overnight windows and SLA working time', () => {
		const windows = [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '17:00' }];
		const mondayMorning = Date.parse('2026-10-05T08:30:00Z'); // a Monday
		expect(isOpenAt(windows, mondayMorning, 'UTC')).toBe(false);
		expect(isOpenAt(windows, mondayMorning + 3_600_000, 'UTC')).toBe(true);
		expect(isOpenAt([], mondayMorning, 'UTC')).toBe(true);
		expect(isOpenAt([{ days: ['mon'], start: 'bad', end: '10:00' }], mondayMorning, 'UTC')).toBe(false);
		expect(new Date(/** @type {number} */ (nextOpenAt(windows, mondayMorning, 'UTC'))).toISOString()).toBe(
			'2026-10-05T09:00:00.000Z',
		);
		expect(nextOpenAt(windows, mondayMorning + 3_600_000, 'UTC')).toBe(mondayMorning + 3_600_000);
		expect(nextOpenAt([{ days: ['mon'], start: '25:00', end: '26:00' }], mondayMorning, 'UTC')).toBeNull();
		// overnight: Friday 22:00 → Saturday 02:00 belongs to Friday
		const night = [{ days: ['fri'], start: '22:00', end: '02:00' }];
		expect(isOpenAt(night, Date.parse('2026-10-10T01:00:00Z'), 'UTC')).toBe(true);
		expect(isOpenAt(night, Date.parse('2026-10-09T23:00:00Z'), 'UTC')).toBe(true);
		expect(isOpenAt(night, Date.parse('2026-10-10T03:00:00Z'), 'UTC')).toBe(false);
		// zones: 09:00 in Tokyo is 00:00 UTC
		expect(isOpenAt(windows, Date.parse('2026-10-05T00:30:00Z'), 'Asia/Tokyo')).toBe(true);
		expect(new Date(addWorkingMinutes(windows, Date.parse('2026-10-05T16:30:00Z'), 60, 'UTC')).toISOString()).toBe(
			'2026-10-06T09:30:00.000Z',
		);
		expect(addWorkingMinutes([], 0, 10, 'UTC')).toBe(600_000);
		expect(addWorkingMinutes(windows, 0, -5, 'UTC')).toBe(0);
		expect(addWorkingMinutes([{ days: ['mon'], start: '25:00', end: '26:00' }], 0, 5, 'UTC')).toBe(300_000);
	});
	it('zone helpers and keys', () => {
		expect(isTimeZone('Europe/Lisbon')).toBe(true);
		expect(isTimeZone('Mars/Base')).toBe(false);
		expect(isTimeZone('')).toBe(false);
		expect(zoneOr('Mars/Base', 'Europe/Paris')).toBe('Europe/Paris');
		expect(zoneOr('x', 'y')).toBe('UTC');
		expect(minutesOf('24:00')).toBe(1440);
		expect(minutesOf('24:30')).toBeNull();
		expect(minutesOf(9)).toBeNull();
		expect(localParts(Date.parse('2026-10-05T00:30:00Z'), 'Asia/Tokyo')).toMatchObject({
			year: 2026,
			month: 10,
			day: 5,
			hour: 9,
			minute: 30,
			weekday: 1,
		});
		expect(monthKey(Date.parse('2026-10-31T23:30:00Z'), 'Asia/Tokyo')).toBe('2026-11');
		expect(dayKey(Date.parse('2026-10-31T23:30:00Z'), 'UTC')).toBe('2026-10-31');
		expect(iso(0)).toBe('1970-01-01T00:00:00.000Z');
	});
});
