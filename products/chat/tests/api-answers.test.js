/**
 * PLAN 0.8.10 Chat, the answers: longer instructions, "never disclose" and the store context (C1), rich answers in
 * bubbles (C2), fallback answers filled from the shop (C3), the AI reply in the same request (C10), fuller shop tools
 * (C13), the strict language check and the current page (C14), and the website's own contact kept by moderation (C15).
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

const PRODUCT = {
	id: 'prd_fan',
	name: 'Ceiling Fan',
	price: 1250000,
	priceText: 'Rs 12,500',
	currency: 'PKR',
	image: 'https://cdn.shop.example.com/fan.jpg',
	url: 'https://shop.example.com/fans/ceiling-fan',
	inStock: true,
	variantId: 'var_white',
	grade: { label: 'New' },
	stockLeft: 3,
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
	});

	it('answers in markdown, split into bubbles, with links only on the website or as moderation allows', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'moderation']);
		await sys.setting('ai_replies', 'bubbles', 2);
		await sys.setting('moderation', 'linkPolicy', 'allow_list');
		await sys.setting('moderation', 'allowedLinkHosts', ['docs.example.org']);
		sys.ai({
			text: 'Hello **there**\n---\nSee [the fan](/fans/1), [our page](https://shop.example.com/a), [docs](https://docs.example.org/x) and [elsewhere](https://evil.example.net)\n---\nBye',
		});
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'hi' });
		const ai = (await v('GET', '/v1/chat')).json.messages.filter((/** @type {any} */ m) => m.author === 'ai');
		expect(ai.map((/** @type {any} */ m) => [m.format, m.text])).toEqual([
			['markdown', 'Hello **there**'],
			[
				'markdown',
				'See [the fan](/fans/1), [our page](https://shop.example.com/a), [docs](https://docs.example.org/x) and elsewhere\n\nBye',
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
		expect(
			(
				await sys.dashboard(
					await sys.adminSession(),
					'PUT',
					`/v1/dashboard/websites/${sys.websiteId}/lists/fallback_answers`,
					{
						items: [{ intent: 'nope', language: 'english', keywords: 'x', text: '' }],
					},
				)
			).status,
		).toBe(422);
		await sys.list('fallback_answers', [
			{ intent: 'greeting', language: 'ar', keywords: [], text: 'مرحبا' },
			{ intent: 'my_orders', language: '', keywords: ['order'], text: 'Your orders:\n{my_orders}' },
			{ intent: 'deals', language: '', keywords: ['deal', 'offer'], text: 'Our deals:\n\n{deals_table}' },
			{ intent: 'budget', language: '', keywords: ['under', 'budget'], text: 'Within your budget:\n{products_under}' },
			{ intent: 'products', language: '', keywords: ['best'], text: 'Popular:\n{top_products}' },
			{ intent: 'other', language: '', keywords: ['hours'], text: 'We are open 9 to 5.' },
		]);
		sys.responders.set(`${ECOMMERCE}/v1/chat/deals`, () => ({
			status: 200,
			body: { items: [{ id: 'deal_1', name: 'Eid sale', description: '10% off fans', offerText: '10% off', endsAt: null }] },
		}));
		sys.responders.set(`${ECOMMERCE}/v1/chat/products`, () => ({ status: 200, body: { items: [PRODUCT] } }));
		sys.responders.set(`${ECOMMERCE}/v1/chat/products/top`, () => ({ status: 200, body: { items: [PRODUCT] } }));
		const v = sys.visitor();
		const fail = { status: 500 };
		sys.ai(fail);
		await v('POST', '/v1/chat/messages', { text: 'any deal today?' });
		let last = (await v('GET', '/v1/chat')).json.messages.at(-1);
		expect(last).toMatchObject({ author: 'ai', format: 'markdown' });
		expect(last.text).toBe('Our deals:\n\n| Deal | Details | Ends |\n| --- | --- | --- |\n| Eid sale | 10% off |  |');
		sys.ai(fail);
		await v('POST', '/v1/chat/messages', { text: 'something under 15,000 please' });
		last = (await v('GET', '/v1/chat')).json.messages.at(-1);
		expect(last.text).toBe('Within your budget:\n- [Ceiling Fan](https://shop.example.com/fans/ceiling-fan) — Rs 12,500');
		const search = sys.shopCalls().find((c) => c.url.includes('/v1/chat/products?'));
		expect(new URL(String(search?.url)).searchParams.get('maxPrice')).toBe('1500000');
		// a guest's order question skips the my-orders entry (no sign-in): nothing else matches
		sys.ai(fail);
		await v('POST', '/v1/chat/messages', { text: 'where is my order' });
		expect(texts((await v('GET', '/v1/chat')).json).at(-1)).toEqual(['system', 'Sorry, I cannot answer right now.']);
		// signed in: the visitor's own orders
		sys.responders.set(`${ECOMMERCE}/v1/chat/me/orders`, () => ({
			status: 200,
			body: {
				items: [
					{
						number: 'CT-1',
						status: 'Shipped',
						total: 500000,
						totalText: 'Rs 5,000',
						currency: 'PKR',
						placedAt: '2026-10-01',
					},
				],
				name: 'Ann',
			},
		}));
		const signIn = await sys.accounts.signIn({ websiteId: sys.websiteId, sub: 'usr_ann', name: 'Ann' });
		const user = sys.visitor({ signIn });
		sys.ai(fail);
		await user('POST', '/v1/chat/messages', { text: 'my order please' });
		expect((await user('GET', '/v1/chat')).json.messages.at(-1).text).toBe(
			'Your orders:\n- CT-1 — Shipped — Rs 5,000 — Oct 1, 2026',
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
		const best = await v('POST', '/v1/chat/messages', { text: 'what are your best fans' });
		expect(best.status, best.text).toBe(201);
		expect((await v('GET', '/v1/chat')).json.messages.at(-1).text).toContain('Popular:\n- [Ceiling Fan]');
		expect(sys.aiCalls()).toHaveLength(calls);
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
	it('passes filters, the search size and quote options; answers grades, variants, stock and warranty', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'shop_search', 'shop_deals']);
		await sys.paste('ecommerce');
		await sys.setting('shop_search', 'maxResults', 8);
		sys.responders.set(`${ECOMMERCE}/v1/chat/products`, () => ({ status: 200, body: { items: [PRODUCT] } }));
		sys.responders.set(`${ECOMMERCE}/v1/chat/products/prd_fan`, () => ({
			status: 200,
			body: {
				...PRODUCT,
				warranty: { text: '1 year' },
				variants: [
					{
						id: 'var_white',
						options: { Colour: 'White' },
						price: 1250000,
						priceText: 'Rs 12,500',
						grade: 'New',
						stockLeft: 3,
					},
					{
						id: 'var_used',
						options: { Colour: 'Grey' },
						price: 900000,
						grade: { label: 'Used' },
						inStock: false,
						warranty: '3 months',
					},
				],
			},
		}));
		sys.responders.set(`${ECOMMERCE}/v1/chat/products/prd_fan/quote`, () => ({
			status: 200,
			body: {
				productId: 'prd_fan',
				variantId: 'var_white',
				quantity: 2,
				paymentMethod: 'cod',
				price: 2500000,
				priceAfterDeals: 2400000,
				savings: 100000,
				fees: 10000,
				feesText: 'Rs 100',
				delivery: 0,
				freeDeliveryThreshold: 500000,
				total: 2410000,
				currency: 'PKR',
				deals: ['Eid sale'],
			},
		}));
		sys.ai(
			{
				tools: [
					{
						name: 'search_catalog',
						arguments: { query: 'fan', category: 'Fans', grade: 'New', minPrice: 5000, maxPrice: '15,000', inStock: true },
					},
					{ name: 'get_product_details', arguments: { productId: 'prd_fan' } },
					{
						name: 'quote_product_savings',
						arguments: { productId: 'prd_fan', variantId: 'var_white', quantity: 9, paymentMethod: 'cod' },
					},
				],
			},
			{ text: 'Here you go.' },
		);
		await sys.visitor()('POST', '/v1/chat/messages', { text: 'a new fan under 15000' });
		const paths = sys.shopCalls().map((c) => new URL(c.url).pathname + new URL(c.url).search);
		expect(paths).toContain(
			'/v1/chat/products?q=fan&category=Fans&grade=New&minPrice=500000&maxPrice=1500000&inStock=1&limit=8',
		);
		expect(paths).toContain('/v1/chat/products/prd_fan/quote?variantId=var_white&quantity=5&paymentMethod=cod');
		const results = sys
			.aiCalls()[1]
			.messages.filter((/** @type {any} */ m) => m.role === 'tool')
			.map((/** @type {any} */ m) => JSON.parse(m.content));
		expect(results[0].products[0]).toMatchObject({ price: 'Rs 12,500', grade: 'New', stockLeft: 3 });
		expect(results[1]).toMatchObject({
			warranty: '1 year',
			variants: [
				{ id: 'var_white', options: 'Colour: White', price: 'Rs 12,500', grade: 'New', inStock: true, stockLeft: 3 },
				{
					id: 'var_used',
					options: 'Colour: Grey',
					price: 'PKR 9,000.00',
					grade: 'Used',
					inStock: false,
					warranty: '3 months',
				},
			],
		});
		expect(results[2]).toMatchObject({
			quantity: 2,
			paymentMethod: 'cod',
			fees: 'Rs 100',
			delivery: 'PKR 0.00',
			total: 'PKR 24,100.00',
		});
	});

	it('adds the store context for the viewed product, cached 60 s per website and sign-in', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'shop_context']);
		await sys.paste('ecommerce');
		sys.responders.set(`${ECOMMERCE}/v1/chat/context`, () => ({
			status: 200,
			body: { text: 'Policies: returns in 7 days.\nViewing: Ceiling Fan, Rs 12,500.' },
		}));
		const v = sys.visitor();
		const page = {
			url: 'https://shop.example.com/fans/ceiling-fan',
			kind: 'product',
			productId: 'prd_fan',
			productName: 'Fan',
		};
		await v('POST', '/v1/chat/messages', { text: 'returns?', page });
		await v('POST', '/v1/chat/messages', { text: 'and warranty?', page });
		const contextCalls = sys.shopCalls().filter((c) => c.url.includes('/v1/chat/context'));
		expect(contextCalls.map((c) => new URL(c.url).search)).toEqual(['?productId=prd_fan']);
		expect(sys.aiCalls()[1].messages[0].content).toContain('Store information (live):\nPolicies: returns in 7 days.');
		sys.advance(61_000);
		await v('POST', '/v1/chat/messages', { text: 'thanks', page: { ...page, productId: null, kind: 'other' } });
		expect(
			sys
				.shopCalls()
				.filter((c) => c.url.includes('/v1/chat/context'))
				.at(-1)?.url,
		).toMatch(/\/v1\/chat\/context$/);
	});
});

describe('the strict language check, the current page and the website’s own contact (C14, C15)', () => {
	it('a strict check wants the visitor’s marker words; later messages update the page', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'language_lock', 'moderation']);
		await sys.setting('language_lock', 'markerWords', ['ur-Latn: hai kya mein aap ji haan yeh nahi']);
		await sys.setting('language_lock', 'strict', true);
		sys.ai({ text: 'Yes, it is available.' }, { text: 'Ji haan, yeh available hai.' });
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', {
			text: 'kya yeh fan available hai',
			page: { url: 'https://shop.example.com/fans/a', kind: 'product', productName: 'Fan A' },
		});
		expect(texts((await v('GET', '/v1/chat')).json).at(-1)).toEqual(['ai', 'Ji haan, yeh available hai.']);
		sys.ai({ text: 'Ji haan.' });
		await v('POST', '/v1/chat/messages', {
			text: 'aur yeh wala kya hai',
			page: { url: 'https://shop.example.com/fans/b', kind: 'product', productName: 'Fan B' },
		});
		expect(sys.aiCalls().at(-1).messages[0].content).toContain('Fan B');
		// the website's own e-mail and phone are never hidden; others are
		await sys.setting('moderation', 'redact', ['email', 'phone']);
		sys.responders.set('https://shop.example.com/.well-known/business.json', () => ({
			status: 200,
			body: { version: 1, name: 'Shop', email: 'hello@shop.example.com', phone: '+92 300 1234567', timeZone: 'UTC' },
		}));
		await sys.dashboard(await sys.adminSession(), 'POST', `/v1/dashboard/websites/${sys.websiteId}/business/refresh`);
		const sent = await v('POST', '/v1/chat/messages', {
			text: 'I wrote to hello@shop.example.com and 0300-1234567, also me@x.com and +44 20 7946 0958',
		});
		expect(sent.json.message.text).toBe('I wrote to hello@shop.example.com and 0300-1234567, also [e-mail] and [phone]');
	});
});
