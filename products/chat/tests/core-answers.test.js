/**
 * The pure parts of PLAN 0.8.10 Chat: markdown and bubbles (C2), fallback answers (C3), "never disclose" (C1), the
 * strict language check (C14), the website's own contact (C15), fuller shop requests and answers and the store
 * context (C13, C1), and the answer checks.
 */
import { describe, expect, it } from 'vitest';
import { runAssistant } from '../core/assistant.js';
import {
	budgetOf,
	checkFallbackAnswers,
	fillFallback,
	matchingFallbacks,
	placeholdersOf,
	productList,
	tableOf,
} from '../core/fallback.js';
import { replyMatchesLanguage } from '../core/language.js';
import { keepLinks, parseInline, parseMarkdown, plainOf, safeHref, splitBubbles } from '../core/markdown.js';
import { applyLinkPolicy, redact } from '../core/moderation.js';
import { buildSystemPrompt, disclosesBot } from '../core/prompt.js';
import { cardsOf, contextPath, contextText, needsCurrency, shopAnswer, shopRequest } from '../core/shop.js';

describe('markdown and bubbles (C2)', () => {
	it('splits on --- lines into at most the bubbles', () => {
		expect(splitBubbles('a\n---\nb\n ---- \nc', 2)).toEqual(['a', 'b\n\nc']);
		expect(splitBubbles('a\n---\n\n---\nb', 5)).toEqual(['a', 'b']);
		expect(splitBubbles('one', 0)).toEqual(['one']);
	});

	it('keeps links on the website or allowed; checks targets', () => {
		expect(
			keepLinks('[a](/x) [b](https://shop.example.com/y) [c](https://www.shop.example.com) [d](https://e.example) [e](bad)', {
				websiteDomain: 'shop.example.com',
			}),
		).toBe('[a](/x) [b](https://shop.example.com/y) [c](https://www.shop.example.com) d e');
		expect(keepLinks('[d](https://e.example)', { websiteDomain: '', allowed: () => true })).toBe('[d](https://e.example)');
		expect(safeHref('//evil.example')).toBeNull();
		expect(safeHref('mailto:a@b.co')).toBe('mailto:a@b.co');
		expect(safeHref('javascript:alert(1)')).toBeNull();
		expect(safeHref('https://u:p@x.example')).toBeNull();
		expect(safeHref('not a url')).toBeNull();
	});

	it('parses bold, italic, links, lists, tables and headings', () => {
		expect(parseInline('**b** *i* _u_ __B__ [l](/p) [x](javascript:1) snake_case_word')).toEqual([
			{ t: 'b', c: [{ t: 'text', v: 'b' }] },
			{ t: 'text', v: ' ' },
			{ t: 'i', c: [{ t: 'text', v: 'i' }] },
			{ t: 'text', v: ' ' },
			{ t: 'i', c: [{ t: 'text', v: 'u' }] },
			{ t: 'text', v: ' ' },
			{ t: 'b', c: [{ t: 'text', v: 'B' }] },
			{ t: 'text', v: ' ' },
			{ t: 'a', href: '/p', c: [{ t: 'text', v: 'l' }] },
			{ t: 'text', v: ' ' },
			{ t: 'text', v: 'x' },
			{ t: 'text', v: ' snake_case_word' },
		]);
		const blocks = parseMarkdown(
			'# Title\nline one\nline two\n\n- a\n- b\n1. c\n\n| A | B |\n| --- | :---: |\n| 1 | 2 |\n| 3 | 4 |\n---\nend',
		);
		expect(blocks.map((b) => b.kind)).toEqual(['p', 'p', 'ul', 'ol', 'table', 'p']);
		expect(blocks[1]).toEqual({ kind: 'p', lines: [[{ t: 'text', v: 'line one' }], [{ t: 'text', v: 'line two' }]] });
		expect(blocks[4]).toMatchObject({
			kind: 'table',
			head: [[{ v: 'A' }], [{ v: 'B' }]],
			rows: [
				[[{ v: '1' }], [{ v: '2' }]],
				[[{ v: '3' }], [{ v: '4' }]],
			],
		});
		expect(parseMarkdown('- a\n\n- b')).toHaveLength(2);
		expect(plainOf('**Hi** [x](/y)\n---\n# T\n| a |\n| --- |\n*i*')).toBe('Hi x\n\nT\n| a |\n\ni');
	});
});

describe('fallback answers (C3)', () => {
	it('checks the list', () => {
		expect(checkFallbackAnswers('x')).toEqual({ ok: false, errors: ['Send a list of fallback answers.'] });
		expect(checkFallbackAnswers(Array.from({ length: 51 }, () => ({}))).ok).toBe(false);
		const bad = checkFallbackAnswers([1, { intent: 'x', language: 'english', keywords: ['k'.repeat(101)], text: '' }]);
		expect(bad.ok).toBe(false);
		expect(checkFallbackAnswers([{ intent: 'other', language: ' ur-Latn ', keywords: [' hi ', '', 3], text: ' ok ' }])).toEqual(
			{
				ok: true,
				value: [{ intent: 'other', language: 'ur-Latn', keywords: ['hi'], text: 'ok' }],
			},
		);
	});

	it('matches by language and keywords, finds budgets and fills placeholders', () => {
		const items = /** @type {any[]} */ ([
			{ intent: 'greeting', language: 'ur', keywords: ['salam'], text: 'a' },
			{ intent: 'other', language: '', keywords: ['hi there'], text: 'b' },
			{ intent: 'other', language: '', keywords: [], text: 'c' },
		]);
		expect(matchingFallbacks(items, { message: 'Salam!', language: 'ur-Latn' }).map((i) => i.text)).toEqual(['a', 'c']);
		expect(matchingFallbacks(items, { message: 'well hi there', language: null }).map((i) => i.text)).toEqual(['b', 'c']);
		expect(matchingFallbacks(items, { message: 'this', language: null }).map((i) => i.text)).toEqual(['c']);
		expect(budgetOf('under 15,000')).toBe(15000);
		expect(budgetOf('around 20k')).toBe(20000);
		expect(budgetOf('1.5k max')).toBe(1500);
		expect(budgetOf('12 500 please')).toBe(12500);
		expect(budgetOf('no number')).toBeNull();
		expect(placeholdersOf('{deals_table} {my_orders} {other}')).toEqual(['deals_table', 'my_orders']);
		expect(fillFallback('x {top_products}', { top_products: 'T' })).toBe('x T');
		expect(fillFallback('x {top_products}', { top_products: null })).toBeNull();
		expect(tableOf(['A|B'], [['x\ny']])).toBe('| A/B |\n| --- |\n| x y |');
		expect(
			productList(
				[
					{ name: 'F[1]', price: 'Rs 1', link: '/f', inStock: false },
					{ name: 'G', price: 'Rs 2' },
				],
				{ outOfStock: 'sold out' },
			),
		).toBe('- [F1](/f) — Rs 1 (sold out)\n- G — Rs 2');
	});
});

describe('never disclose, strict language and the own contact (C1, C14, C15)', () => {
	it('spots answers that reveal a bot and builds the prompt', () => {
		expect(disclosesBot('As an AI, I can help')).toBe(true);
		expect(disclosesBot('I’m a virtual assistant')).toBe(true);
		expect(disclosesBot('I am not a real person')).toBe(true);
		expect(disclosesBot('Our fans are made with care.')).toBe(false);
		const prompt = buildSystemPrompt({
			botName: 'Ali',
			business: { name: 'Shop' },
			instructions: null,
			dontKnow: 'Say so.',
			language: null,
			passages: [],
			visitor: { signedIn: false, name: null },
			page: null,
			handoff: false,
			neverDisclose: true,
			bubbles: 3,
			context: 'Policies here',
			reassure: true,
		});
		expect(prompt).toContain('Never say or suggest that you are a bot');
		expect(prompt).toContain('at most 3 messages');
		expect(prompt).toContain('Only reassure them');
		expect(prompt).toContain('Store information (live):\nPolicies here');
	});

	it('checks marker words strictly; keeps the website’s own contact; allows website links in an allow-list', () => {
		const markers = [
			{ language: 'ur-Latn', words: ['hai', 'kya', 'yeh', 'ji', 'haan'] },
			{ language: 'tl', words: ['po', 'ako', 'salamat'] },
		];
		expect(replyMatchesLanguage('Yes, it is in stock.', 'ur-Latn', { markers })).toBe(true);
		expect(replyMatchesLanguage('Yes, it is in stock.', 'ur-Latn', { markers, strict: true })).toBe(false);
		expect(replyMatchesLanguage('Ji haan, yeh stock mein hai.', 'ur-Latn', { markers, strict: true })).toBe(true);
		expect(replyMatchesLanguage('Ji po ako salamat po', 'ur-Latn', { markers, strict: true })).toBe(false);
		expect(replyMatchesLanguage('Hello there', 'en', { markers, strict: true })).toBe(true);
		const own = { email: 'Hello@Shop.example.com', phone: '+92 300 1234567' };
		expect(redact('hello@shop.example.com 0300 1234567 a@b.co +44 20 7946 0958', ['email', 'phone'], {}, own).text).toBe(
			'hello@shop.example.com 0300 1234567 [email] [phone]',
		);
		expect(redact('0300 1234567', ['phone'], {}, { phone: '12' }).text).toBe('[phone]');
		expect(
			applyLinkPolicy('[a](https://shop.example.com) [b](https://x.example)', {
				mode: 'allow_list',
				hosts: [],
				websiteDomain: 'shop.example.com',
			}),
		).toBe('[a](https://shop.example.com) b');
	});

	it('asks again once when a check fails, and drops a second failure', async () => {
		/** @param {string[]} answers @returns {import('../core/assistant.js').AssistantDeps} */
		const deps = (answers) => ({
			call: async () => ({
				ok: /** @type {const} */ (true),
				value: { text: answers.shift() ?? '', toolCalls: [], usage: { input: 1, output: 1 }, finish: 'stop' },
			}),
			execute: async () => ({ content: '' }),
			remainingTokens: () => 100,
			spend: () => undefined,
			expired: () => false,
		});
		const checks = [{ ok: (/** @type {string} */ t) => !t.includes('bot'), retry: 'again', failure: 'disclosed' }];
		const input = { messages: [{ role: /** @type {const} */ ('user'), content: 'hi' }], tools: [], maxRounds: 0, checks };
		expect((await runAssistant(input, deps(['a bot', 'fine']))).text).toBe('fine');
		expect((await runAssistant(input, deps(['a bot', 'still a bot']))).failure).toBe('disclosed');
		const once = checks.map((check) => ({ ...check, retry: '' }));
		expect((await runAssistant({ ...input, checks: once }, deps(['a bot']))).failure).toBe('disclosed');
		expect((await runAssistant(input, deps(['a bot', '']))).failure).toBe('disclosed');
	});
});

describe('fuller shop tools and the store context (C13, C1)', () => {
	it('builds requests with filters, sizes and quote options', () => {
		expect(shopRequest('search_catalog', { query: '  ', inStock: 'true' }, { limit: 20 })).toEqual({
			ok: true,
			signIn: false,
			path: '/v1/chat/products?inStock=1&limit=12',
		});
		expect(shopRequest('search_catalog', { minPrice: 'abc', maxPrice: -1 })).toEqual({
			ok: false,
			content: 'Say what to search for, or give a filter.',
		});
		expect(
			shopRequest('search_catalog', { maxPrice: 99.5 }).ok && shopRequest('search_catalog', { maxPrice: 99.5 }),
		).toMatchObject({
			path: '/v1/chat/products?maxPrice=9950&limit=5',
		});
		expect(needsCurrency('search_catalog', { maxPrice: 5 })).toBe(true);
		expect(needsCurrency('get_top_products', { maxPrice: 5 })).toBe(false);
		expect(shopRequest('quote_product_savings', { productId: 'p1', quantity: 0, paymentMethod: 'bad method' })).toMatchObject({
			path: '/v1/chat/products/p1/quote',
		});
		expect(contextPath('prd 1')).toBe('/v1/chat/context');
		expect(contextPath('prd_1')).toBe('/v1/chat/context?productId=prd_1');
		expect(contextText({ text: 'x'.repeat(7000) })?.length).toBe(6000);
		expect(contextText({ context: ' ok ' })).toBe('ok');
		expect(contextText({ policies: ['a'] })).toBe('{"policies":["a"]}');
		expect(contextText({})).toBeNull();
		expect(contextText('x')).toBeNull();
	});

	it('answers orders with lines and dates, accounts with the city, deals with their offer; keeps 12 cards', () => {
		const look = { format: { locale: 'en-GB' }, timeZone: 'UTC' };
		const orders = shopAnswer(
			'get_my_orders',
			{
				items: [
					{
						number: 'A-1',
						status: 'Shipped',
						total: 1000,
						currency: 'USD',
						placedAt: '2026-10-01T10:00:00Z',
						expectedDate: '2026-10-09',
						trackingNote: 'With the courier',
						dispatchVideo: 'https://cdn.example.com/v.mp4',
						lines: [{ name: 'Fan', variant: 'White', quantity: 2, totalText: '$10.00' }, 'x'],
					},
				],
			},
			look,
		);
		expect(orders.content).toMatchObject({
			orders: [
				{
					number: 'A-1',
					total: 'USD 10.00',
					items: ['Fan White × 2 $10.00'],
					expected: '9 Oct 2026',
					trackingNote: 'With the courier',
					dispatchVideo: 'https://cdn.example.com/v.mp4',
				},
			],
		});
		expect(shopAnswer('get_my_account', { name: 'A', loyaltyPoints: 3, city: 'Lahore', area: 'DHA' }).content).toEqual({
			name: 'A',
			loyaltyPoints: 3,
			city: 'Lahore',
			area: 'DHA',
		});
		expect(
			shopAnswer('list_active_deals', { items: [{ name: 'D', offerText: '10% off', appliesTo: 'Fans' }] }).content,
		).toEqual({
			deals: [{ name: 'D', description: null, offer: '10% off', appliesTo: 'Fans', endsAt: null }],
		});
		const card = { productId: 'p', name: 'n', price: 1, currency: 'USD' };
		expect(cardsOf(Array.from({ length: 14 }, () => card))).toHaveLength(12);
		expect(
			shopAnswer('get_product_details', { id: 'p', name: 'n', price: 1, currency: 'USD', warranty: { months: 6 } }).content,
		).toMatchObject({
			warranty: '6 months',
		});
	});
});
