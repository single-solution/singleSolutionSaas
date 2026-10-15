/**
 * PLAN 0.8.10 Chat, the answers: longer instructions, "never disclose" and the store context (C1), rich answers in
 * bubbles (C2), fallback answers filled from the shop (C3) with the comparison answer (C18), the AI reply in the same
 * request (C10), fuller shop tools (C13), the strict language check and the current page (C14), and the website's own
 * contact kept by moderation (C15).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { AI_KEY, ECOMMERCE, ready } from './helpers.js';

/** @type {Array<Awaited<ReturnType<typeof ready>>>} */
const systems = [];
afterAll(async () => {
	for (const sys of systems) await sys.product.close();
});
/** @param {string[]} on */
const start = async (on) => {
	const sys = await ready(on);
	systems.push(sys);
	await sys.connect('ai', AI_KEY);
	return sys;
};
/** @param {any} json */
const texts = (json) => json.messages.map((/** @type {any} */ m) => [m.author, m.text]);

/** The deal in the lamp's price, with what it takes off one unit. */
const LAMP_DEAL = { id: 'deal_1', name: 'Autumn sale', savings: 450, savingsText: '$4.50' };

/** A product card as Ecommerce answers it (ChatProduct): the price on the product page, after its 10% deal. */
const PRODUCT = {
	id: 'prd_lamp',
	name: 'Desk Lamp',
	price: 4050,
	priceText: '$40.50',
	compareAtPrice: 4500,
	compareAtPriceText: '$45.00',
	deal: LAMP_DEAL,
	priceMax: 4050,
	priceMaxText: '$40.50',
	currency: 'USD',
	image: 'https://cdn.shop.example.com/lamp.jpg',
	url: 'https://shop.example.com/lighting/desk-lamp',
	inStock: true,
	variantId: 'var_black',
	grade: 'New',
	stockLeft: 3,
};

/** A deal as Ecommerce answers it (ChatDeal). */
const DEAL = {
	id: 'deal_1',
	name: 'Autumn sale',
	description: '10% off lamps',
	slug: 'autumn-sale',
	type: 'percent',
	value: 10,
	valueText: '10%',
	badgeLabel: '',
	discountLabel: '10% off',
	color: '',
	bannerUrl: null,
	minQuantity: null,
	days: [],
	timeFrom: '',
	timeTo: '',
	endsAt: null,
	endsText: '',
};

/** An order as Ecommerce answers it (ChatOrder). */
const ORDER = {
	id: 'ord_1',
	number: 'SH-1001',
	status: 'Shipped',
	statusKey: 'shipped',
	total: 5000,
	totalText: '$50.00',
	currency: 'USD',
	placedAt: '2026-10-01T09:00:00.000Z',
	paymentMethod: 'online',
	paid: 5000,
	paidText: '$50.00',
	balanceDue: 0,
	balanceDueText: '$0.00',
	lines: [],
	courier: '',
	trackingNumber: '',
	trackingUrl: '',
	trackingNote: '',
	expectedAt: null,
	dispatchVideo: null,
};

describe('instructions, never disclose and rich answers (C1, C2)', () => {
	it('takes 32,000 characters of instructions; never says it is a bot; hides the label', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'ai_instructions']);
		await sys.setting('ai_instructions', 'instructions', 'x'.repeat(30_000));
		await sys.setting('ai_replies', 'neverDisclose', true);
		sys.ai({ text: 'As an AI language model I cannot say.' }, { text: 'We ship in two days.' });
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'When do you ship?' });
		expect(texts((await v('GET', '/v1/chat')).json)).toEqual([
			['visitor', 'When do you ship?'],
			['ai', 'We ship in two days.'],
		]);
		const [first, retry] = sys.aiCalls();
		expect(first.messages[0].content).toContain('Never say or suggest that you are a bot');
		expect(first.messages[0].content).toContain('x'.repeat(30_000));
		expect(retry.messages.at(-1).content).toContain('without saying that');
		const config = await sys.call('GET', '/v1/widget/config', { token: sys.browser, origin: 'https://shop.example.com' });
		expect(config.json.settings.ai.showLabel).toBe(false);
		// still disclosing after the retry: refused, the on-failure message answers
		sys.ai({ text: 'I am a bot.' }, { text: 'I am a chatbot, sorry.' });
		await v('POST', '/v1/chat/messages', { text: 'Are you real?' });
		expect(texts((await v('GET', '/v1/chat')).json).at(-1)).toEqual(['system', 'Sorry, I cannot answer right now.']);
		// the phrases that give a bot away are the merchant's, in each language the AI answers in (C17)
		await sys.setting('ai_replies', 'botPhrases', ['je suis une IA', 'robot']);
		sys.ai({ text: 'Je suis une IA, désolé.' }, { text: 'Nous livrons en deux jours.' });
		await v('POST', '/v1/chat/messages', { text: 'Vous livrez quand ?' });
		expect(texts((await v('GET', '/v1/chat')).json).at(-1)).toEqual(['ai', 'Nous livrons en deux jours.']);
		// English phrases the list no longer has pass
		sys.ai({ text: 'As an AI I ship in two days.' });
		await v('POST', '/v1/chat/messages', { text: 'Shipping?' });
		expect(texts((await v('GET', '/v1/chat')).json).at(-1)).toEqual(['ai', 'As an AI I ship in two days.']);
	});

	it('answers in markdown, split into bubbles, with links only on the website or as moderation allows', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'moderation']);
		await sys.setting('ai_replies', 'bubbles', 2);
		await sys.setting('moderation', 'linkPolicy', 'allow_list');
		await sys.setting('moderation', 'allowedLinkHosts', ['docs.example.org']);
		sys.ai({
			text: 'Hello **there**\n---\nSee [the lamp](/lamps/1), [our page](https://shop.example.com/a), [docs](https://docs.example.org/x) and [elsewhere](https://evil.example.net)\n---\nBye',
		});
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'hi' });
		const ai = (await v('GET', '/v1/chat')).json.messages.filter((/** @type {any} */ m) => m.author === 'ai');
		expect(ai.map((/** @type {any} */ m) => [m.format, m.text])).toEqual([
			['markdown', 'Hello **there**'],
			[
				'markdown',
				'See [the lamp](/lamps/1), [our page](https://shop.example.com/a), [docs](https://docs.example.org/x) and elsewhere\n\nBye',
			],
		]);
		expect(sys.aiCalls()[0].messages[0].content).toContain('at most 2 messages');
		// visitor messages stay plain text
		expect((await v('GET', '/v1/chat')).json.messages[0].format).toBe('text');
	});

	it('without moderation only website links stay links; a staff reply is markdown too', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'inbox']);
		sys.ai({ text: '[a](https://other.example.com) and [b](https://www.shop.example.com/b)' });
		const v = sys.visitor();
		const sent = await v('POST', '/v1/chat/messages', { text: 'links?' });
		const ai = (await v('GET', '/v1/chat')).json.messages.at(-1);
		expect(ai.text).toBe('a and [b](https://www.shop.example.com/b)');
		const ticket = await sys.ticket();
		const reply = await sys.admin(ticket, 'POST', `/v1/admin/conversations/${sent.json.chat.conversation.id}/messages`, {
			text: '**Done** — see [x](https://x.example.com)',
		});
		expect(reply.json.message).toMatchObject({ format: 'markdown', text: '**Done** — see x' });
	});
});

describe('fallback answers (C3)', () => {
	it('answers from the merchant’s list, filled from the shop, when the AI fails; else the on-failure message', async () => {
		const sys = await start([
			'visitor_chat',
			'guest_chat',
			'signed_in_chat',
			'ai_replies',
			'fallback_answers',
			'shop_search',
			'shop_deals',
			'shop_top',
			'shop_my_orders',
			'language_lock',
		]);
		await sys.paste('ecommerce');
		await sys.paste('accounts');
		await sys.setting('language_lock', 'allowedLanguages', ['en', 'ar']);
		await sys.setting('guest_chat', 'messageLimit', 0);
		// the words of the deals table and of the "was" price are the merchant's widget texts
		for (const [key, value] of Object.entries({
			'chat.dealName': 'Offer',
			'chat.dealDetails': 'What',
			'chat.dealEnds': 'Until',
			'chat.wasPrice': 'before {price}',
		})) {
			const saved = await sys.dashboard(
				await sys.adminSession(),
				'PUT',
				`/v1/dashboard/websites/${sys.websiteId}/texts/${key}`,
				{
					value,
				},
			);
			expect(saved.status, saved.text).toBe(204);
		}
		expect(
			(
				await sys.dashboard(
					await sys.adminSession(),
					'PUT',
					`/v1/dashboard/websites/${sys.websiteId}/lists/fallback_answers`,
					{
						value: [{ language: 'english', keywords: 'x', text: '' }],
					},
				)
			).status,
		).toBe(422);
		await sys.list('fallback_answers', [
			{ language: 'ar', keywords: [], text: 'مرحبا' },
			{ language: '', keywords: ['order'], text: 'Your orders:\n{my_orders}' },
			{ language: '', keywords: ['deal', 'offer'], text: 'Our deals:\n\n{deals_table}' },
			{ language: '', keywords: ['under', 'budget'], text: 'Within your budget:\n{products_under}' },
			{ language: '', keywords: ['best'], text: 'Popular:\n{top_products}' },
			{ language: '', keywords: ['hours'], text: 'We are open 9 to 5.' },
		]);
		sys.responders.set(`${ECOMMERCE}/v1/chat/deals`, () => ({ status: 200, body: { items: [DEAL] } }));
		sys.responders.set(`${ECOMMERCE}/v1/chat/products`, () => ({ status: 200, body: { items: [PRODUCT] } }));
		sys.responders.set(`${ECOMMERCE}/v1/chat/products/top`, () => ({ status: 200, body: { items: [PRODUCT] } }));
		const v = sys.visitor();
		const fail = { status: 500 };
		sys.ai(fail);
		await v('POST', '/v1/chat/messages', { text: 'any deal today?' });
		let last = (await v('GET', '/v1/chat')).json.messages.at(-1);
		expect(last).toMatchObject({ author: 'ai', format: 'markdown' });
		expect(last.text).toBe('Our deals:\n\n| Offer | What | Until |\n| --- | --- | --- |\n| Autumn sale | 10% off |  |');
		sys.ai(fail);
		await v('POST', '/v1/chat/messages', { text: 'something under 1,500 please' });
		last = (await v('GET', '/v1/chat')).json.messages.at(-1);
		expect(last.text).toBe(
			'Within your budget:\n- [Desk Lamp](https://shop.example.com/lighting/desk-lamp) — $40.50 (before $45.00)',
		);
		const search = sys.shopCalls().find((c) => c.url.includes('/v1/chat/products?'));
		expect(new URL(String(search?.url)).searchParams.get('maxPrice')).toBe('150000');
		// the multiplier words are the merchant's (C18); a number in a product's name is no budget
		await sys.setting('fallback_answers', 'budgetWords', ['k = 1000', 'mil = 1000']);
		sys.ai(fail);
		await v('POST', '/v1/chat/messages', { text: 'an iPhone 15 under 2 mil' });
		expect(new URL(String(sys.shopCalls().at(-1)?.url)).searchParams.get('maxPrice')).toBe('200000');
		sys.ai(fail);
		await v('POST', '/v1/chat/messages', { text: 'is the iPhone 15 within budget' });
		expect(texts((await v('GET', '/v1/chat')).json).at(-1)).toEqual(['system', 'Sorry, I cannot answer right now.']);
		// a guest's order question skips the my-orders entry (no sign-in): nothing else matches
		sys.ai(fail);
		await v('POST', '/v1/chat/messages', { text: 'where is my order' });
		expect(texts((await v('GET', '/v1/chat')).json).at(-1)).toEqual(['system', 'Sorry, I cannot answer right now.']);
		// signed in: the visitor's own orders
		sys.responders.set(`${ECOMMERCE}/v1/chat/me/orders`, () => ({
			status: 200,
			body: { items: [ORDER], loyaltyPoints: 0, name: 'Ann' },
		}));
		const signIn = await sys.accounts.signIn({ websiteId: sys.websiteId, sub: 'usr_ann', name: 'Ann' });
		const user = sys.visitor({ signIn });
		sys.ai(fail);
		await user('POST', '/v1/chat/messages', { text: 'my order please' });
		expect((await user('GET', '/v1/chat')).json.messages.at(-1).text).toBe(
			'Your orders:\n- SH-1001 — Shipped — $50.00 — Oct 1, 2026',
		);
		// the language of an entry follows the language lock
		sys.ai(fail);
		await v('POST', '/v1/chat/messages', { text: 'مرحبا كيف حالك' });
		expect((await v('GET', '/v1/chat')).json.messages.at(-1).text).toBe('مرحبا');
		// a cap reached: the fallback too, without calling the AI
		sys.ai({ text: 'Fine, thanks.' });
		await v('POST', '/v1/chat/messages', { text: 'how are you' });
		await sys.switchOn([
			'visitor_chat',
			'guest_chat',
			'signed_in_chat',
			'ai_replies',
			'fallback_answers',
			'shop_top',
			'ai_caps',
		]);
		await sys.setting('ai_caps', 'dailyTokens', 1);
		const calls = sys.aiCalls().length;
		const best = await v('POST', '/v1/chat/messages', { text: 'what are your best lamps' });
		expect(best.status, best.text).toBe(201);
		expect((await v('GET', '/v1/chat')).json.messages.at(-1).text).toContain('Popular:\n- [Desk Lamp]');
		expect(sys.aiCalls()).toHaveLength(calls);
	});
});

describe('the comparison answer (C18)', () => {
	it('puts the two products a message names side by side when the AI fails', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'fallback_answers', 'shop_search']);
		await sys.paste('ecommerce');
		await sys.setting('guest_chat', 'messageLimit', 0);
		// {comparison} needs the words between the two products
		const refused = await sys.dashboard(
			await sys.adminSession(),
			'PUT',
			`/v1/dashboard/websites/${sys.websiteId}/lists/fallback_answers`,
			{ value: [{ language: '', keywords: [], text: '{comparison}' }] },
		);
		expect(refused.status).toBe(422);
		expect(refused.text).toContain('{comparison} needs keywords');
		await sys.list('fallback_answers', [{ language: '', keywords: ['vs', 'versus'], text: 'Side by side:\n\n{comparison}' }]);
		const max = { ...PRODUCT, id: 'prd_max', name: 'Lamp Max', url: 'https://shop.example.com/lamps/lamp-max' };
		const mini = {
			...PRODUCT,
			id: 'prd_mini',
			name: 'Lamp Mini',
			price: 2500,
			priceText: '$25.00',
			priceMax: 2500,
			priceMaxText: '$25.00',
			compareAtPrice: null,
			compareAtPriceText: null,
			deal: null,
			url: 'https://shop.example.com/lamps/lamp-mini',
			inStock: false,
			grade: null,
		};
		sys.responders.set(`${ECOMMERCE}/v1/chat/products`, (call) => {
			const terms = String(new URL(call.url).searchParams.get('q')).toLowerCase().split(' ');
			const items = [max, mini].filter((p) => terms.every((term) => p.name.toLowerCase().includes(term)));
			return { status: 200, body: { items } };
		});
		sys.responders.set(`${ECOMMERCE}/v1/chat/products/prd_max`, () => ({
			status: 200,
			body: {
				...max,
				brand: 'Northlight',
				options: [{ name: 'Color', values: ['Black', 'Gray'] }],
				specs: [
					{ name: 'Height', value: 42, unit: 'cm' },
					{ name: 'Dimmable', value: true, unit: null },
					{ name: 'Power', value: 9, unit: 'W' },
				],
			},
		}));
		sys.responders.set(`${ECOMMERCE}/v1/chat/products/prd_mini`, () => ({
			status: 200,
			body: {
				...mini,
				brand: 'Northlight',
				options: [{ name: 'Color', values: ['White'] }],
				specs: [
					{ name: 'height', value: 30, unit: 'cm' },
					{ name: 'Dimmable', value: false, unit: null },
				],
			},
		}));
		const v = sys.visitor();
		sys.ai({ status: 500 });
		await v('POST', '/v1/chat/messages', { text: 'Which is better: Lamp Max vs Lamp Mini?' });
		const last = (await v('GET', '/v1/chat')).json.messages.at(-1);
		expect(last).toMatchObject({ author: 'ai', format: 'markdown' });
		expect(last.text).toBe(
			[
				'Side by side:',
				'',
				'|  | [Lamp Max](https://shop.example.com/lamps/lamp-max) | [Lamp Mini](https://shop.example.com/lamps/lamp-mini) |',
				'| --- | --- | --- |',
				'| Price | $40.50 (was $45.00) | $25.00 |',
				'| Availability | In stock | Out of stock |',
				'| Brand | Northlight | Northlight |',
				'| Condition | New | — |',
				'| Color | Black, Gray | White |',
				'| Height | 42 cm | 30 cm |',
				'| Dimmable | Yes | No |',
				'| Power | 9 W | — |',
			].join('\n'),
		);
		// each side searched with its words, then fewer: the words nearest the keyword kept
		const queries = sys
			.shopCalls()
			.filter((c) => new URL(c.url).pathname === '/v1/chat/products')
			.map((c) => new URL(c.url).searchParams.get('q'));
		expect(queries).toEqual(['is better Lamp Max', 'better Lamp Max', 'Lamp Max', 'Lamp Mini']);
		// a side the catalog does not have: the answer is skipped, the on-failure message replies
		sys.ai({ status: 500 });
		await v('POST', '/v1/chat/messages', { text: 'Lamp Max versus a candle' });
		expect(texts((await v('GET', '/v1/chat')).json).at(-1)).toEqual(['system', 'Sorry, I cannot answer right now.']);
	});
});

describe('the AI reply in the same request (C10)', () => {
	it('waits for the reply with ?wait=1 and answers it with the visitor’s message', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'typing_receipts']);
		sys.ai({ text: 'One\n---\nTwo' });
		await sys.setting('ai_replies', 'bubbles', 3);
		const v = sys.visitor();
		const sent = await v('POST', '/v1/chat/messages?wait=1', { text: 'hello' });
		expect(sent.status).toBe(201);
		expect(sent.json.message.text).toBe('hello');
		expect(sent.json.replies.map((/** @type {any} */ m) => m.text)).toEqual(['One', 'Two']);
		expect(sent.json.chat.conversation.aiPending).toBe(false);
		const plain = await v('POST', '/v1/chat/messages', { text: 'again' });
		expect(plain.json.replies).toBeUndefined();
	});
});

describe('fuller shop tools and the store context (C13, C1)', () => {
	it('passes filters, the search size and quote options; answers grades, variants, stock, warranty and payment methods', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'shop_search', 'shop_deals']);
		await sys.paste('ecommerce');
		await sys.setting('shop_search', 'maxResults', 8);
		/** A variant as Ecommerce answers it (ChatVariant). */
		const variant = {
			id: 'var_black',
			options: { Color: 'Black' },
			price: 4050,
			priceText: '$40.50',
			compareAtPrice: 4500,
			compareAtPriceText: '$45.00',
			deal: LAMP_DEAL,
			grade: 'New',
			gradeKey: 'new',
			inStock: true,
			soldOut: false,
			stockLeft: 3,
			warrantyTime: { amount: 1, unit: 'years' },
		};
		sys.responders.set(`${ECOMMERCE}/v1/chat/products`, () => ({ status: 200, body: { items: [PRODUCT] } }));
		sys.responders.set(`${ECOMMERCE}/v1/chat/products/prd_lamp`, () => ({
			status: 200,
			body: {
				...PRODUCT,
				summary: 'A steady light for long evenings.',
				description: 'Brushed steel.',
				brand: 'Northlight',
				options: [{ name: 'Color', values: ['Black', 'Gray'] }],
				priceRange: { min: 3000, max: 4050, minText: '$30.00', maxText: '$40.50' },
				specs: [{ name: 'Height', value: 42, unit: 'cm' }],
				variants: [
					variant,
					{
						...variant,
						id: 'var_used',
						options: { Color: 'Gray' },
						price: 3000,
						priceText: '$30.00',
						compareAtPrice: null,
						compareAtPriceText: null,
						deal: null,
						grade: 'Used',
						gradeKey: 'used',
						inStock: false,
						soldOut: true,
						stockLeft: null,
						warrantyTime: { amount: 90, unit: 'days' },
					},
				],
			},
		}));
		sys.responders.set(`${ECOMMERCE}/v1/chat/products/prd_lamp/quote`, () => ({
			status: 200,
			body: {
				productId: 'prd_lamp',
				variantId: 'var_black',
				quantity: 2,
				price: 4500,
				priceText: '$45.00',
				compareAtPrice: null,
				compareAtPriceText: null,
				priceAfterDeals: 4000,
				priceAfterDealsText: '$40.00',
				savings: 500,
				savingsText: '$5.00',
				currency: 'USD',
				deals: ['Autumn sale'],
				dealsApplied: [{ ...DEAL, amount: 1000, amountText: '$10.00' }],
				inStock: true,
				problems: [],
				limits: { step: 1, min: 1, max: 99 },
				paymentMethod: 'cod',
				paymentMethods: [
					{ method: 'cod', available: true, reason: null, advance: 1000, fee: 100, advanceText: '$10.00' },
					{ method: 'online', available: true, reason: null, advance: 0, fee: 0, advanceText: '$0.00' },
					{ method: 'bank_transfer', available: false, reason: 'over_max', advance: 0, fee: 0, advanceText: '$0.00' },
				],
				subtotal: 9000,
				subtotalText: '$90.00',
				discount: 1000,
				discountText: '$10.00',
				roleDiscount: 0,
				roleDiscountText: '$0.00',
				fee: 100,
				feeText: '$1.00',
				tax: 0,
				taxText: '$0.00',
				delivery: { method: 'delivery', name: 'Courier', fee: 0, feeText: '$0.00', minDays: 2, maxDays: 4 },
				freeDeliveryOver: 10000,
				freeDeliveryOverText: '$100.00',
				total: 8100,
				totalText: '$81.00',
			},
		}));
		sys.ai(
			{
				tools: [
					{
						name: 'search_catalog',
						arguments: {
							query: 'lamp',
							category: 'Desk Lamps',
							grade: 'New, like new, !',
							minPrice: 20,
							maxPrice: '1,500',
							inStock: true,
						},
					},
					{ name: 'get_product_details', arguments: { productId: 'prd_lamp' } },
					{
						name: 'quote_product_savings',
						arguments: {
							productId: 'prd_lamp',
							variantId: 'var_black',
							quantity: 2.5,
							paymentMethod: 'cod',
							city: 'Leeds',
						},
					},
				],
			},
			{ text: 'Here you go.' },
		);
		await sys.visitor()('POST', '/v1/chat/messages', { text: 'a new desk lamp under 1500' });
		const paths = sys.shopCalls().map((c) => new URL(c.url).pathname + new URL(c.url).search);
		expect(paths).toContain(
			'/v1/chat/products?q=lamp&category=desk-lamps&grade=new%2Clike_new&minPrice=2000&maxPrice=150000&inStock=1&limit=8',
		);
		// any quantity, a decimal amount of an item's own unit too: Ecommerce checks its steps (C3)
		expect(paths).toContain('/v1/chat/products/prd_lamp/quote?variantId=var_black&quantity=2.5&paymentMethod=cod&city=Leeds');
		const results = sys
			.aiCalls()[1]
			.messages.filter((/** @type {any} */ m) => m.role === 'tool')
			.map((/** @type {any} */ m) => JSON.parse(m.content));
		expect(results[0].products[0]).toMatchObject({
			price: '$40.50',
			wasPrice: '$45.00',
			deal: { name: 'Autumn sale', savings: '$4.50' },
			grade: 'New',
			stockLeft: 3,
		});
		expect(results[1]).toMatchObject({
			brand: 'Northlight',
			specs: ['Height: 42 cm'],
			options: [{ name: 'Color', values: ['Black', 'Gray'] }],
			variants: [
				{
					id: 'var_black',
					options: 'Color: Black',
					price: '$40.50',
					wasPrice: '$45.00',
					deal: { name: 'Autumn sale', savings: '$4.50' },
					grade: 'New',
					gradeKey: 'new',
					inStock: true,
					stockLeft: 3,
					// as the merchant typed it (C8): 1 year stays 1 year
					warranty: '1 year',
				},
				{
					id: 'var_used',
					options: 'Color: Gray',
					price: '$30.00',
					grade: 'Used',
					inStock: false,
					warranty: '90 days',
				},
			],
		});
		expect(results[2]).toEqual({
			productId: 'prd_lamp',
			variantId: 'var_black',
			quantity: 2,
			// the quantities it is sold in (C3)
			limits: { step: 1, least: 1, most: 99 },
			paymentMethod: 'cod',
			price: '$45.00',
			priceAfterDeals: '$40.00',
			savings: '$5.00',
			deals: ['Autumn sale'],
			subtotal: '$90.00',
			discount: '$10.00',
			fee: '$1.00',
			freeDeliveryOver: '$100.00',
			total: '$81.00',
			delivery: 'Courier, $0.00, 2–4 days',
			// Ecommerce's payment options (ChatPaymentOption), in the merchant's order
			paymentMethods: [
				{ method: 'cod', available: true, advance: '$10.00', fee: 'USD 1.00' },
				{ method: 'online', available: true },
				{ method: 'bank_transfer', available: false, reason: 'over_max' },
			],
		});
		// the AI sees the payment methods a quote takes
		const quoteTool = sys.aiCalls()[0].tools.find((/** @type {any} */ t) => t.function.name === 'quote_product_savings');
		// any method of the website's own list (C1): no fixed keys
		expect(quoteTool.function.parameters.properties.paymentMethod.enum).toBeUndefined();
		expect(quoteTool.function.parameters.properties.paymentMethod.description).toContain('payment method key');
	});

	it('adds the store context for the viewed product, cached 60 s per website and sign-in', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'shop_context']);
		await sys.paste('ecommerce');
		sys.responders.set(`${ECOMMERCE}/v1/chat/context`, () => ({
			status: 200,
			body: {
				text: 'Policies: returns in 7 days.\nViewing: Desk Lamp, $45.00.',
				business: 'Shop',
				currency: 'USD',
				policies: [{ key: 'returns', text: 'Returns in 7 days.' }],
				products: [],
				deals: [],
				product: null,
				visitor: null,
			},
		}));
		const v = sys.visitor();
		const page = {
			url: 'https://shop.example.com/lighting/desk-lamp',
			kind: 'product',
			productId: 'prd_lamp',
			productName: 'Desk Lamp',
		};
		await v('POST', '/v1/chat/messages', { text: 'returns?', page });
		await v('POST', '/v1/chat/messages', { text: 'and warranty?', page });
		const contextCalls = sys.shopCalls().filter((c) => c.url.includes('/v1/chat/context'));
		expect(contextCalls.map((c) => new URL(c.url).search)).toEqual(['?productId=prd_lamp']);
		expect(sys.aiCalls()[1].messages[0].content).toContain('Store information (live):\nPolicies: returns in 7 days.');
		sys.advance(61_000);
		await v('POST', '/v1/chat/messages', { text: 'thanks', page: { ...page, productId: null, kind: 'other' } });
		expect(
			sys
				.shopCalls()
				.filter((c) => c.url.includes('/v1/chat/context'))
				.at(-1)?.url,
		).toMatch(/\/v1\/chat\/context$/);
		// the longest store information the AI gets is a setting (C22)
		await sys.setting('shop_context', 'maxCharacters', 500);
		sys.responders.set(`${ECOMMERCE}/v1/chat/context`, () => ({
			status: 200,
			body: { text: `Policies: ${'x'.repeat(900)}`, currency: 'USD' },
		}));
		sys.advance(61_000);
		await v('POST', '/v1/chat/messages', { text: 'one more' });
		const prompt = String(sys.aiCalls().at(-1).messages[0].content);
		expect(prompt.slice(prompt.indexOf('Policies:')).split('\n')[0]).toHaveLength(500);
	});
});

describe('the strict language check, the current page and the website’s own contact (C14, C15)', () => {
	it('a strict check wants the visitor’s marker words; later messages update the page', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'language_lock', 'moderation']);
		await sys.setting('language_lock', 'markerWords', ['es: hola sí tienen está esta hay precio gracias disponible']);
		await sys.setting('language_lock', 'strict', true);
		sys.ai({ text: 'Yes, it is available.' }, { text: 'Sí, está disponible.' });
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', {
			text: '¿Tienen esta lámpara disponible?',
			page: { url: 'https://shop.example.com/lamps/a', kind: 'product', productName: 'Lamp A' },
		});
		expect(texts((await v('GET', '/v1/chat')).json).at(-1)).toEqual(['ai', 'Sí, está disponible.']);
		sys.ai({ text: 'Sí.' });
		await v('POST', '/v1/chat/messages', {
			text: 'y esta, ¿hay precio?',
			page: { url: 'https://shop.example.com/lamps/b', kind: 'product', productName: 'Lamp B' },
		});
		expect(sys.aiCalls().at(-1).messages[0].content).toContain('Lamp B');
		// the website's own email and phone are never hidden; others are
		await sys.setting('moderation', 'redact', ['email', 'phone']);
		sys.responders.set('https://shop.example.com/.well-known/business.json', () => ({
			status: 200,
			body: { version: 1, name: 'Shop', email: 'hello@shop.example.com', phone: '+44 20 7946 0123', timeZone: 'UTC' },
		}));
		await sys.dashboard(await sys.adminSession(), 'POST', `/v1/dashboard/websites/${sys.websiteId}/business/refresh`);
		const sent = await v('POST', '/v1/chat/messages', {
			text: 'I wrote to hello@shop.example.com and 020 7946 0123, also me@x.com and +1 415 555 0100',
		});
		expect(sent.json.message.text).toBe('I wrote to hello@shop.example.com and 020 7946 0123, also [email] and [phone]');
	});
});
