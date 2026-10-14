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

	it('parses code: no marks inside, fenced lines kept as they are (to the end when not closed)', () => {
		expect(parseInline('run `a*b*_c_ [x](/y)` now **`k`**')).toEqual([
			{ t: 'text', v: 'run ' },
			{ t: 'code', v: 'a*b*_c_ [x](/y)' },
			{ t: 'text', v: ' now ' },
			{ t: 'b', c: [{ t: 'code', v: 'k' }] },
		]);
		expect(parseMarkdown('Try:\n```js\nconst a = **1**;\n\n- x\n---\n```\nafter\n```\nopen')).toEqual([
			{ kind: 'p', lines: [[{ t: 'text', v: 'Try:' }]] },
			{ kind: 'code', text: 'const a = **1**;\n\n- x\n---' },
			{ kind: 'p', lines: [[{ t: 'text', v: 'after' }]] },
			{ kind: 'code', text: 'open' },
		]);
		expect(plainOf('Use `CODE10` today\n```\nx\n```')).toBe('Use CODE10 today\n\nx');
	});

	it('keeps _ inside words (also after a letter beyond one UTF-16 unit) as text', () => {
		expect(parseInline('size_a_ x𝐀_b_ (_c_)')).toEqual([
			{ t: 'text', v: 'size_a_ x𝐀_b_ (' },
			{ t: 'i', c: [{ t: 'text', v: 'c' }] },
			{ t: 'text', v: ')' },
		]);
	});
});

describe('fallback answers (C3)', () => {
	it('checks the list', () => {
		expect(checkFallbackAnswers('x')).toEqual({ ok: false, errors: ['Send a list of fallback answers.'] });
		expect(checkFallbackAnswers(Array.from({ length: 51 }, () => ({}))).ok).toBe(false);
		const bad = checkFallbackAnswers([1, { intent: 'x', language: 'english', keywords: ['k'.repeat(101)], text: '' }]);
		expect(bad.ok).toBe(false);
		expect(checkFallbackAnswers([{ intent: 'other', language: ' pt-BR ', keywords: [' hi ', '', 3], text: ' ok ' }])).toEqual({
			ok: true,
			value: [{ intent: 'other', language: 'pt-BR', keywords: ['hi'], text: 'ok' }],
		});
	});

	it('matches by language and keywords, finds budgets and fills placeholders', () => {
		const items = /** @type {any[]} */ ([
			{ intent: 'greeting', language: 'fr', keywords: ['bonjour'], text: 'a' },
			{ intent: 'other', language: '', keywords: ['hi there'], text: 'b' },
			{ intent: 'other', language: '', keywords: [], text: 'c' },
		]);
		expect(matchingFallbacks(items, { message: 'Bonjour !', language: 'fr-CA' }).map((i) => i.text)).toEqual(['a', 'c']);
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
					{ name: 'F[1]', price: '€1', link: '/f', inStock: false },
					{ name: 'G', price: '€2' },
				],
				{ outOfStock: 'sold out' },
			),
		).toBe('- [F1](/f) — €1 (sold out)\n- G — €2');
	});
});

describe('never disclose, strict language and the own contact (C1, C14, C15)', () => {
	it('spots answers that reveal a bot and builds the prompt', () => {
		expect(disclosesBot('As an AI, I can help')).toBe(true);
		expect(disclosesBot('I’m a virtual assistant')).toBe(true);
		expect(disclosesBot('I am not a real person')).toBe(true);
		expect(disclosesBot('Our lamps are made with care.')).toBe(false);
		const prompt = buildSystemPrompt({
			botName: 'Sam',
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
		const spanish = [...markers, { language: 'es', words: ['sí', 'está', 'hay', 'tienen'] }];
		expect(replyMatchesLanguage('Sí, está en stock.', 'es', { markers: spanish, strict: true })).toBe(true);
		expect(replyMatchesLanguage('Yes, it is in stock.', 'es', { markers: spanish, strict: true })).toBe(false);
		const own = { email: 'Hello@Shop.example.com', phone: '+44 20 7946 0123' };
		expect(redact('hello@shop.example.com 020 7946 0123 a@b.co +1 415 555 0100', ['email', 'phone'], {}, own).text).toBe(
			'hello@shop.example.com 020 7946 0123 [email] [phone]',
		);
		expect(redact('07700 900123', ['phone'], {}, { phone: '12' }).text).toBe('[phone]');
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
		// only what Ecommerce takes: its payment methods, its variant ids and its product ids or slugs
		expect(
			shopRequest('quote_product_savings', { productId: 'p1', variantId: 'var.1', paymentMethod: ' Bank_Transfer ' }),
		).toMatchObject({ path: '/v1/chat/products/p1/quote?paymentMethod=bank_transfer' });
		expect(shopRequest('quote_product_savings', { productId: 'p1', paymentMethod: 'card' })).toMatchObject({
			path: '/v1/chat/products/p1/quote',
		});
		expect(shopRequest('get_product_details', { productId: 'p.1' })).toEqual({
			ok: false,
			content: 'Give the product id from a search result.',
		});
		expect(contextPath('prd 1')).toBe('/v1/chat/context');
		expect(contextPath('prd.1')).toBe('/v1/chat/context');
		expect(contextPath('prd_1')).toBe('/v1/chat/context?productId=prd_1');
		expect(contextText({ text: 'x'.repeat(7000) })?.length).toBe(6000);
		expect(contextText({ text: ' ok ' })).toBe('ok');
		// only Ecommerce's text becomes the context, never the rest of its answer
		expect(contextText({ text: ' ', policies: [{ key: 'returns', text: 'a' }] })).toBeNull();
		expect(contextText({})).toBeNull();
		expect(contextText('x')).toBeNull();
	});

	it('reads Ecommerce’s documented answers: details with specs and warranties, a quote with its payment methods', () => {
		const look = { format: { locale: 'en-GB' }, timeZone: 'UTC' };
		const card = {
			id: 'prd_lamp',
			name: 'Desk lamp',
			price: 4500,
			priceText: '€45.00',
			priceMax: 5200,
			priceMaxText: '€52.00',
			currency: 'EUR',
			image: 'https://cdn.example.com/lamp.jpg',
			url: 'https://shop.example.com/products/desk-lamp',
			inStock: true,
			variantId: 'var_black',
			grade: null,
			stockLeft: 3,
		};
		const variant = {
			id: 'var_black',
			options: { Colour: 'Black' },
			price: 4500,
			priceText: '€45.00',
			compareAtPrice: null,
			compareAtPriceText: null,
			grade: 'New',
			gradeKey: 'new',
			inStock: true,
			soldOut: false,
			stockLeft: 3,
			warrantyDays: 730,
		};
		const details = shopAnswer(
			'get_product_details',
			{
				...card,
				summary: 'A steady light for long evenings.',
				description: 'Brushed steel, warm white.',
				brand: 'Northlight',
				options: [{ name: 'Colour', values: ['Black', 'White'] }],
				priceRange: { min: 4500, max: 5200, minText: '€45.00', maxText: '€52.00' },
				specs: [
					{ name: 'Height', value: 42, unit: 'cm' },
					{ name: 'Dimmable', value: true, unit: '' },
					{ name: 'Bulbs', value: ['E27', 'E14'], unit: '' },
					{ name: 'Cable', value: 'Fabric', unit: '' },
				],
				variants: [
					variant,
					{
						...variant,
						id: 'var_white',
						options: { Colour: 'White' },
						price: 5200,
						priceText: '€52.00',
						grade: null,
						gradeKey: null,
						inStock: false,
						soldOut: true,
						stockLeft: null,
						warrantyDays: null,
					},
				],
			},
			look,
		);
		expect(details.content).toEqual({
			id: 'prd_lamp',
			name: 'Desk lamp',
			price: '€45.00 – €52.00',
			inStock: true,
			stockLeft: 3,
			link: 'https://shop.example.com/products/desk-lamp',
			brand: 'Northlight',
			summary: 'A steady light for long evenings.',
			description: 'Brushed steel, warm white.',
			options: [{ name: 'Colour', values: ['Black', 'White'] }],
			specs: ['Height: 42 cm', 'Dimmable: yes', 'Bulbs: E27, E14', 'Cable: Fabric'],
			variants: [
				{
					id: 'var_black',
					options: 'Colour: Black',
					price: '€45.00',
					grade: 'New',
					gradeKey: 'new',
					inStock: true,
					stockLeft: 3,
					warranty: '730 days',
				},
				{ id: 'var_white', options: 'Colour: White', price: '€52.00', inStock: false },
			],
		});
		expect(details.products).toEqual([expect.objectContaining({ id: 'prd_lamp', grade: null, variantId: 'var_black' })]);
		const quote = shopAnswer(
			'quote_product_savings',
			{
				productId: 'prd_lamp',
				variantId: 'var_black',
				quantity: 2,
				price: 4500,
				priceText: '€45.00',
				priceAfterDeals: 4050,
				priceAfterDealsText: '€40.50',
				savings: 450,
				savingsText: '€4.50',
				currency: 'EUR',
				deals: ['Autumn offer'],
				dealsApplied: [{ id: 'deal_1', name: 'Autumn offer', amount: 900, amountText: '€9.00' }],
				inStock: true,
				problems: [],
				paymentMethod: 'cod',
				paymentMethods: [
					{ method: 'online', available: true, reason: null, advance: 0, fee: 0, advanceText: '€0.00' },
					{ method: 'cod', available: true, reason: null, advance: 2000, fee: 150, advanceText: '€20.00' },
					{ method: 'bank_transfer', available: false, reason: 'not_ready', advance: 0, fee: 0, advanceText: '€0.00' },
					{ method: 'pickup', available: false, reason: 'needs_pickup', advance: 0, fee: 0, advanceText: '€0.00' },
				],
				subtotal: 9000,
				subtotalText: '€90.00',
				discount: 900,
				discountText: '€9.00',
				roleDiscount: 0,
				roleDiscountText: '€0.00',
				fee: 150,
				feeText: '€1.50',
				tax: 0,
				taxText: '€0.00',
				delivery: { method: 'delivery', name: 'Standard', fee: 0, feeText: '€0.00', minDays: null, maxDays: null },
				freeDeliveryOver: null,
				freeDeliveryOverText: '',
				total: 8250,
				totalText: '€82.50',
			},
			look,
		);
		expect(quote.content).toEqual({
			productId: 'prd_lamp',
			variantId: 'var_black',
			quantity: 2,
			paymentMethod: 'cod',
			price: '€45.00',
			priceAfterDeals: '€40.50',
			savings: '€4.50',
			deals: ['Autumn offer'],
			subtotal: '€90.00',
			discount: '€9.00',
			fee: '€1.50',
			total: '€82.50',
			delivery: 'Standard, €0.00',
			// in the merchant's order, with why one cannot be used; the advance and the fee as the website shows money
			paymentMethods: [
				{ method: 'online', available: true },
				{ method: 'cod', available: true, advance: '€20.00', fee: 'EUR 1.50' },
				{ method: 'bank_transfer', available: false, reason: 'not_ready' },
				{ method: 'pickup', available: false, reason: 'needs_pickup' },
			],
		});
	});

	it('answers orders with lines and dates, accounts with the city, deals with their offer; keeps 12 cards', () => {
		const look = { format: { locale: 'en-GB' }, timeZone: 'UTC' };
		const line = {
			name: 'Desk lamp',
			variantName: 'Black',
			gradeLabel: 'New',
			quantity: 2,
			unitPrice: 500,
			unitPriceText: '$5.00',
			total: 1000,
			totalText: '$10.00',
			warrantyDays: 30,
		};
		const orders = shopAnswer(
			'get_my_orders',
			{
				items: [
					{
						id: 'ord_1',
						number: 'SH-1042',
						status: 'Shipped',
						statusKey: 'shipped',
						total: 1000,
						totalText: '$10.00',
						currency: 'USD',
						placedAt: '2026-10-01T10:00:00.000Z',
						paymentMethod: 'cod',
						paid: 500,
						paidText: '$5.00',
						balanceDue: 500,
						balanceDueText: '$5.00',
						lines: [
							line,
							{
								...line,
								name: 'Canvas tote',
								variantName: '',
								gradeLabel: '',
								quantity: 1,
								totalText: '$0.00',
								warrantyDays: null,
							},
						],
						courier: 'UPS',
						trackingNumber: 'T1',
						trackingUrl: 'https://t.example.com/T1',
						trackingNote: 'With the courier',
						expectedAt: '2026-10-09T08:00:00.000Z',
						dispatchVideo: { kind: 'file', url: 'https://cdn.example.com/v.mp4' },
					},
				],
				loyaltyPoints: 0,
				name: 'Sam Lee',
			},
			look,
		);
		expect(orders.content).toMatchObject({
			name: 'Sam Lee',
			loyaltyPoints: 0,
			orders: [
				{
					number: 'SH-1042',
					status: 'Shipped',
					total: '$10.00',
					placedAt: '1 Oct 2026',
					paymentMethod: 'cod',
					balanceDue: '$5.00',
					items: ['Desk lamp Black New × 2 $10.00 warranty 30 days', 'Canvas tote × 1 $0.00'],
					courier: 'UPS',
					trackingNumber: 'T1',
					trackingLink: 'https://t.example.com/T1',
					expected: '9 Oct 2026',
					trackingNote: 'With the courier',
					dispatchVideo: 'https://cdn.example.com/v.mp4',
				},
			],
		});
		// no shipment yet: no courier, tracking or video
		const placed = /** @type {any} */ (
			shopAnswer('get_my_orders', {
				items: [
					{
						.../** @type {any} */ (orders.content).orders[0],
						number: 'SH-1043',
						courier: '',
						trackingNumber: '',
						trackingUrl: '',
						trackingNote: '',
						expectedAt: null,
						dispatchVideo: null,
						balanceDue: 0,
						lines: [],
					},
				],
			}).content
		).orders[0];
		expect(Object.keys(placed)).toEqual(['number', 'status', 'total', 'placedAt', 'paymentMethod']);
		expect(
			shopAnswer('get_my_account', {
				name: 'Alex Morgan',
				firstName: 'Alex',
				loyaltyPoints: 3,
				city: 'Manchester',
				area: 'Didsbury',
			}).content,
		).toEqual({ name: 'Alex Morgan', firstName: 'Alex', loyaltyPoints: 3, city: 'Manchester', area: 'Didsbury' });
		const deal = {
			id: 'deal_1',
			name: 'Weekend offer',
			description: '',
			slug: 'weekend-offer',
			type: 'percent',
			value: 10,
			valueText: '10%',
			badgeLabel: 'Hot',
			discountLabel: '10% off',
			color: '',
			bannerUrl: null,
			minQuantity: 2,
			days: [5, 6, 7],
			timeFrom: '10:00',
			timeTo: '12:00',
			endsAt: '2026-10-09T00:00:00.000Z',
			endsText: 'Oct 9',
		};
		const always = {
			...deal,
			name: 'Spend more',
			description: 'Off orders over $50',
			type: 'fixed',
			valueText: '$5.00',
			badgeLabel: '',
			discountLabel: '',
			minQuantity: null,
			days: [],
			timeFrom: '',
			timeTo: '',
			endsAt: null,
			endsText: '',
		};
		expect(shopAnswer('list_active_deals', { items: [deal, always] }).content).toEqual({
			deals: [
				{
					name: 'Weekend offer',
					description: null,
					offer: '10% off',
					badge: 'Hot',
					minQuantity: 2,
					when: 'Friday, Saturday 10:00–12:00',
					endsAt: 'Oct 9',
				},
				{ name: 'Spend more', description: 'Off orders over $50', offer: '$5.00', endsAt: null },
			],
		});
		const shipped = shopAnswer(
			'track_shipment',
			{
				items: [
					{
						orderNumber: 'SH-1042',
						courier: 'UPS',
						trackingNumber: 'T1',
						trackingUrl: '',
						trackingNote: 'Out',
						expectedAt: '2026-10-09T00:00:00.000Z',
						status: 'In transit',
					},
				],
			},
			look,
		);
		expect(shipped.content).toEqual({
			shipments: [
				{
					orderNumber: 'SH-1042',
					courier: 'UPS',
					trackingNumber: 'T1',
					trackingLink: null,
					status: 'In transit',
					trackingNote: 'Out',
					expected: '9 Oct 2026',
				},
			],
		});
		const card = { productId: 'p', name: 'n', price: 1, currency: 'USD' };
		expect(cardsOf(Array.from({ length: 14 }, () => card))).toHaveLength(12);
	});
});
