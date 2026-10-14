/**
 * PLAN 0.8.10 build phase 4, Chat's "done when": Chat's store context, rich and fallback answers, handoff options,
 * alerts, imported guest keys and paging pass against the REAL Portal, Accounts, Notifications and Ecommerce, all in
 * this process. Chat's AI replies add Ecommerce's live `GET /v1/chat/context` (E37) for the product the visitor is
 * viewing, with the verified sign-in forwarded and cached 60 s (C1, with the 32,000-character instructions); AI answers
 * are markdown split into bubbles with off-site links dropped, and staff replies are markdown too (C2); when the AI
 * fails, the merchant's fallback answer is filled with the deals table from the real Ecommerce, else the on-failure
 * message (C3); the AI answers the message that asks for a person first, with no notice and no button, then stays quiet
 * and reassures after 3 minutes (C4); staff alerts go through the kit and the real Notifications to email addresses,
 * a phone (WhatsApp) and the Accounts staff whose role may reply, on every message and on handoff (C5); a staff reply
 * sends `chat.staff_reply` by WhatsApp to a visitor who left, once until they check again (C6); a store's own guest
 * cookie imported as a hash works as `SS-Guest`, a guest chat merges by time into the account's own conversation at
 * sign-in and guest chats with the verified phone move with `claimByPhone` (C7); older messages page back by sequence
 * for the visitor, the merchant's server and staff (C8). The AI provider (OpenAI), the email provider (Resend) and the
 * WhatsApp Cloud API (Meta) are fakes in this process; no real network call is made.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	createProductInstance as createAccounts,
	manifest as accountsManifest,
	strings as accountsStrings,
} from '@ss/product-accounts/product';
import { createRoutes as accountsRoutes } from '@ss/product-accounts/routes';
import { createProductInstance, manifest, strings } from '@ss/product-chat/product';
import { createRoutes } from '@ss/product-chat/routes';
import {
	createProductInstance as createEcommerce,
	manifest as shopManifest,
	strings as shopStrings,
} from '@ss/product-ecommerce/product';
import { createRoutes as shopRoutes } from '@ss/product-ecommerce/routes';
import {
	createProductInstance as createNotifications,
	manifest as notifyManifest,
	strings as notifyStrings,
} from '@ss/product-notifications/product';
import { createRoutes as notifyRoutes } from '@ss/product-notifications/routes';
import { DAY, startSystem } from './helpers.js';

const CHAT = 'https://chat-phase4.test';
const ACCOUNTS = 'https://accounts.test';
const NOTIFY = 'https://notifications.test';
const SHOP = 'https://ecommerce.test';
const DOMAIN = 'lamps.example.com';
const ORIGIN = `https://${DOMAIN}`;
const ADMIN_ORIGIN = 'https://admin.lamps.example.com';
const PASSWORD = 'a long enough password';
/** The page of the product the visitors look at. */
const PAGE_URL = `${ORIGIN}/products/lamp-max`;
/** The phone of the alert recipients list (WhatsApp) and its digits as Meta gets them. */
const TEAM_PHONE = '+44 20 7946 0958';
const TEAM_DIGITS = '442079460958';
/** Server calls as a named member of staff (K2). */
const STAFF = { 'ss-actor-id': 'usr_staff_42', 'ss-actor-name': encodeURIComponent('Alex Morgan') };

/** Emails the merchant's provider (Resend) received. @type {any[]} */
const mails = [];
/** WhatsApp messages the merchant's Cloud API (Meta) received. @type {any[]} */
const whatsapp = [];
/** Requests the merchant's AI provider (OpenAI) received. @type {any[]} */
const prompts = [];
/** What the AI answers next (text, else 'Happy to help.'). @type {string[]} */
const aiAnswers = [];
/** While true, the AI provider answers 500 to every completion. */
let aiDown = false;

/** @param {Request} request */
const resend = async (request) => {
	if (request.method === 'POST') mails.push(await request.json());
	return Response.json({ id: `re_${mails.length}` });
};
/** @param {Request} request */
const meta = async (request) => {
	if (request.method === 'POST') whatsapp.push(await request.json());
	return Response.json(request.method === 'POST' ? { messages: [{ id: `wamid.${whatsapp.length}` }] } : { id: '1234567890' });
};
/** @param {Request} request */
const openai = async (request) => {
	if (request.method === 'GET') return Response.json({ data: [] });
	prompts.push(await request.json());
	if (aiDown) return Response.json({ error: { message: 'down' } }, { status: 500 });
	return Response.json({
		choices: [{ message: { role: 'assistant', content: aiAnswers.shift() ?? 'Happy to help.' }, finish_reason: 'stop' }],
		usage: { prompt_tokens: 50, completion_tokens: 10 },
	});
};

/** @type {import('./helpers.js').System} */
let sys;
let websiteId = '';
/** @type {Record<string, { browser: string, server: string }>} */
const tokens = {};
/** @type {Record<string, string>} */
const BASES = { chat: CHAT, accounts: ACCOUNTS, notifications: NOTIFY, ecommerce: SHOP };
let productId = '';
/** Accounts users: a customer (Rea), a customer with a phone (Nadia) and a member of staff who may reply (Aga). */
const users = { rea: '', nadia: '', aga: '' };

beforeAll(async () => {
	/** @param {any} create @param {any} routes @param {any} productManifest @param {any} productStrings @param {string} url */
	const unit = (create, routes, productManifest, productStrings, url) => ({
		createProductInstance: create,
		createRoutes: routes,
		manifest: productManifest,
		strings: productStrings,
		url,
	});
	sys = await startSystem({
		unit: {
			...unit(createProductInstance, createRoutes, manifest, strings, CHAT),
			handlers: {
				'https://api.resend.com': resend,
				'https://graph.facebook.com': meta,
				'https://api.openai.com': openai,
			},
		},
		extras: [
			unit(createAccounts, accountsRoutes, accountsManifest, accountsStrings, ACCOUNTS),
			unit(createNotifications, notifyRoutes, notifyManifest, notifyStrings, NOTIFY),
			unit(createEcommerce, shopRoutes, shopManifest, shopStrings, SHOP),
		],
	});
});
afterAll(async () => {
	await sys?.stop();
});

/**
 * A dashboard write of an Owner on a product.
 * @param {string} productKey @param {string} path @param {unknown} body
 */
const setUp = async (productKey, path, body) => {
	const cookie = await sys.adminSession(await sys.owner(), websiteId, productKey);
	return sys.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}${path}`, body, BASES[productKey]);
};

/**
 * A call of the merchant's server to a product with its server token.
 * @param {string} productKey @param {string} method @param {string} path @param {unknown} [body]
 * @param {Record<string, string>} [headers]
 */
const server = (productKey, method, path, body, headers = {}) =>
	sys.call(method, path, {
		base: BASES[productKey],
		token: tokens[productKey]?.server,
		...(body === undefined ? {} : { body }),
		headers,
	});

/** Save settings through a product's settings API (K1). @param {string} productKey @param {Record<string, unknown>} values */
const configure = async (productKey, values) => {
	for (const [key, value] of Object.entries(values)) {
		const saved = await server(productKey, 'PUT', `/v1/settings/${key}`, { value });
		expect(saved.status, `${productKey} ${key}: ${JSON.stringify(saved.json)}`).toBe(200);
	}
};

/**
 * A visitor's device on the website: keeps the guest key Chat answers (or a key it already has) and sends the
 * Accounts sign-in when there is one.
 * @param {{ guestKey?: string, signIn?: string }} [who]
 */
const device = ({ guestKey = '', signIn = '' } = {}) => {
	let key = guestKey;
	/** @param {string} method @param {string} path @param {unknown} [body] */
	return async (method, path, body) => {
		const res = await sys.call(method, path, {
			token: tokens.chat?.browser,
			origin: ORIGIN,
			...(body === undefined ? {} : { body }),
			headers: { ...(key ? { 'ss-guest': key } : {}), ...(signIn ? { 'ss-sign-in': signIn } : {}) },
		});
		if (typeof res.json?.guestKey === 'string') key = res.json.guestKey;
		return res;
	};
};

/** A visitor's Accounts sign-in (email and password, from the website). @param {string} email */
const signIn = async (email) => {
	const res = await sys.call('POST', '/v1/sign-in/password', {
		base: ACCOUNTS,
		token: tokens.accounts?.browser,
		origin: ORIGIN,
		body: { email, password: PASSWORD },
	});
	expect(res.json.status, JSON.stringify(res.json)).toBe('signed_in');
	return String(res.json.signIn);
};

/** The system prompt of the AI's last request. */
const lastSystemPrompt = () => String(prompts.at(-1)?.messages?.[0]?.content ?? '');

/** @param {any} json the chat state @returns {Array<[string, string]>} */
const authors = (json) => json.messages.map((/** @type {any} */ m) => [m.author, m.text]);

/** @param {string} text */
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

describe('Chat phase 4 on the real Portal, Accounts, Notifications and Ecommerce', () => {
	it('sets up the four products: features, databases, providers, templates, people, a product, a deal and the tokens', async () => {
		for (const base of [CHAT, ACCOUNTS, NOTIFY, SHOP]) await sys.connect({ base });
		const m = await sys.merchant('lamps@shop.test', [DOMAIN]);
		websiteId = m.websiteIds[0] ?? '';
		for (const id of ['chat', 'accounts', 'notifications', 'ecommerce']) {
			await sys.addProduct(m.merchantId, websiteId, id);
			tokens[id] = await sys.tokens(m.merchantId, websiteId, id);
		}
		await sys.addCredits(m.merchantId, 100);
		/** @type {Record<string, string[]>} */
		const features = {
			chat: [
				'ai_instructions',
				'ai_replies',
				'fallback_answers',
				'guest_chat',
				'handoff',
				'inbox',
				'shop_context',
				'shop_deals',
				'signed_in_chat',
				'staff_alerts',
				'visitor_alerts',
				'visitor_chat',
			],
			accounts: ['email_password', 'roles'],
			notifications: ['email', 'whatsapp'],
			ecommerce: ['catalog', 'checkout', 'deals'],
		};
		for (const [id, on] of Object.entries(features)) {
			const cookie = await sys.adminSession(await sys.owner(), websiteId, id);
			expect((await setUp(id, '/features', { on })).status).toBe(200);
			await sys.connectDatabase(cookie, websiteId, BASES[id]);
		}

		// Notifications: email (Resend) and WhatsApp (Meta), with Chat's templates
		expect(
			(
				await setUp('notifications', '/connections/email', {
					value: { provider: 'resend', secret: 're_live_key_0044', from: 'Lamps <shop@lamps.example.com>' },
				})
			).json,
		).toMatchObject({ status: 'connected' });
		expect(
			(
				await setUp('notifications', '/connections/whatsapp', {
					value: { provider: 'meta', phoneNumberId: '1234567890', secret: 'meta-token-0044' },
				})
			).json,
		).toMatchObject({ status: 'connected' });
		for (const template of [
			{ key: 'chat.staff_new_message', channel: 'email', subject: 'New chat message', text: '{visitor}: {preview} {link}' },
			{ key: 'chat.staff_new_message', channel: 'whatsapp', text: 'New chat: {preview}' },
			{ key: 'chat.staff_needs_you', channel: 'email', subject: 'Chat needs you', text: '{visitor}: {preview} {link}' },
			{ key: 'chat.staff_needs_you', channel: 'whatsapp', text: 'Needs you: {preview}' },
			{ key: 'chat.staff_reply', channel: 'whatsapp', text: '{staff}: {preview} {link}' },
			{ key: 'chat.staff_reply', channel: 'email', subject: 'A reply from {business}', text: '{staff}: {preview}' },
		]) {
			const saved = await setUp('notifications', '/templates', { ...template, required: true });
			expect(saved.status, JSON.stringify(saved.json)).toBe(200);
		}

		// Accounts: two customers (one with a phone) and a member of staff whose ready-made role may reply in the inbox
		await configure('accounts', { 'email_password.breachedCheck': false });
		for (const [who, body] of /** @type {const} */ ([
			[
				'rea',
				{
					name: 'Rea Der',
					email: 'rea@example.com',
					password: PASSWORD,
					addresses: [{ line1: '5 Rue Cler', city: 'Paris', area: '7th arrondissement' }],
				},
			],
			['nadia', { name: 'Nadia Noor', email: 'nadia@example.com', phone: '+33612345678', password: PASSWORD }],
			['aga', { name: 'Aga Agent', email: 'agent@lamps.example.com', role: 'support_staff' }],
		])) {
			const created = await server('accounts', 'POST', '/v1/users', body);
			expect(created.status, JSON.stringify(created.json)).toBe(201);
			users[who] = String(created.json.id);
		}

		// Ecommerce: the Accounts token (sign-ins), a policy, a lamp and a deal with its display fields
		expect((await setUp('ecommerce', '/connections/accounts', { value: tokens.accounts?.server })).json).toMatchObject({
			status: 'connected',
		});
		await configure('ecommerce', { 'checkout.policyShipping': 'We deliver nationwide in 2 days.' });
		const lamp = await server('ecommerce', 'POST', '/v1/products', {
			name: 'Lamp Max',
			slug: 'lamp-max',
			status: 'active',
			summary: 'A dimmable desk lamp',
			price: 1_250_000,
			sku: 'LAMP-MAX',
			stock: 4,
		});
		expect(lamp.status, JSON.stringify(lamp.json)).toBe(201);
		productId = String(lamp.json.id);
		const deal = await server('ecommerce', 'POST', '/v1/deals', {
			name: 'Lamp week',
			type: 'percent',
			value: 10,
			badgeLabel: 'Sale',
			discountLabel: '10% off lamps',
		});
		expect(deal.status, JSON.stringify(deal.json)).toBe(201);

		// Chat: the AI provider (faked) and the three pasted tokens
		expect(
			(
				await setUp('chat', '/connections/ai', {
					value: { provider: 'openai', apiKey: 'sk-merchant-000444', model: 'gpt-4.1-mini' },
				})
			).json,
		).toMatchObject({ status: 'connected' });
		for (const id of ['accounts', 'notifications', 'ecommerce']) {
			const pasted = await setUp('chat', `/connections/${id}`, { value: tokens[id]?.server });
			expect(pasted.json, id).toMatchObject({ status: 'connected' });
		}
		await configure('chat', { 'ai_replies.onFailure': 'message', 'staff_alerts.inboxUrl': `${ADMIN_ORIGIN}/inbox` });
	});

	it('C1: 32,000 characters of instructions, and each AI reply adds Ecommerce’s live store context, cached 60 s', async () => {
		await configure('chat', { 'ai_instructions.instructions': `Be kind. ${'x'.repeat(31_991)}` });
		const tooLong = await server('chat', 'PUT', '/v1/settings/ai_instructions.instructions', { value: 'x'.repeat(32_001) });
		expect(tooLong.status).toBe(422);
		await configure('chat', { 'ai_instructions.instructions': 'Be kind and short.' });

		const guest = device();
		const page = { url: PAGE_URL, kind: 'product', productId, productName: 'Lamp Max' };
		expect((await guest('POST', '/v1/chat/messages', { text: 'Is this lamp dimmable?', page })).status).toBe(201);
		let prompt = lastSystemPrompt();
		expect(prompt).toContain('Be kind and short.');
		expect(prompt).toContain('Store information (live):');
		expect(prompt).toContain('live store facts');
		expect(prompt).toContain('Delivery: We deliver nationwide in 2 days.');
		expect(prompt).toContain('## Newest products');
		expect(prompt).toContain('| Lamp week (Sale) | 10% off lamps |');
		expect(prompt).toContain('## Product the visitor is viewing');
		expect(prompt).toMatch(/## Product the visitor is viewing\nLamp Max \(/);
		expect(prompt).not.toContain('## Signed-in visitor');

		// a policy changed in Ecommerce shows only once the 60 s cache has passed
		await configure('ecommerce', { 'checkout.policyShipping': 'We deliver nationwide in 1 day.' });
		await guest('POST', '/v1/chat/messages', { text: 'And the colors?' });
		expect(lastSystemPrompt()).toContain('in 2 days.');
		sys.clock.advance(61_000);
		await guest('POST', '/v1/chat/messages', { text: 'And the size?' });
		prompt = lastSystemPrompt();
		expect(prompt).toContain('Delivery: We deliver nationwide in 1 day.');
		// the page the later messages came from is still the product's
		expect(prompt).toContain('## Product the visitor is viewing');

		// a signed-in visitor: the verified sign-in is forwarded, and Ecommerce adds who they are
		const rea = device({ signIn: await signIn('rea@example.com') });
		const sent = await rea('POST', '/v1/chat/messages', { text: 'Hello again', page });
		expect(sent.json.chat.visitor).toMatchObject({ kind: 'user', name: 'Rea Der' });
		prompt = lastSystemPrompt();
		expect(prompt).toContain('## Signed-in visitor');
		expect(prompt).toContain('first name Rea');
		expect(prompt).toContain('city Paris');
	});

	it('C2: AI answers are markdown split into bubbles, with links only on the website; staff replies are markdown', async () => {
		await configure('chat', { 'ai_replies.bubbles': 2 });
		aiAnswers.push(
			[
				'**Lamp Max** is in stock.',
				'---',
				'| Size | Price |',
				'| --- | --- |',
				'| 56 in | USD 12,500.00 |',
				'',
				`[See it](${PAGE_URL}) or [compare](https://elsewhere.example.org/lamps).`,
			].join('\n'),
		);
		const guest = device();
		const sent = await guest('POST', '/v1/chat/messages', { text: 'Tell me about Lamp Max' });
		const state = await guest('GET', '/v1/chat');
		const answers = state.json.messages.filter((/** @type {any} */ m) => m.author === 'ai');
		expect(answers).toHaveLength(2);
		expect(answers.every((/** @type {any} */ m) => m.format === 'markdown')).toBe(true);
		expect(answers[0].text).toBe('**Lamp Max** is in stock.');
		expect(answers[1].text).toContain('| 56 in | USD 12,500.00 |');
		expect(answers[1].text).toContain(`[See it](${PAGE_URL})`);
		expect(answers[1].text).toContain('or compare.');
		expect(answers[1].text).not.toContain('elsewhere.example.org');
		const replied = await server(
			'chat',
			'POST',
			`/v1/conversations/${sent.json.chat.conversation.id}/messages`,
			{ text: 'It is **very** quiet.' },
			STAFF,
		);
		expect(replied.status).toBe(201);
		expect((await guest('GET', '/v1/chat')).json.messages.at(-1)).toMatchObject({
			author: 'staff',
			name: 'Alex Morgan',
			text: 'It is **very** quiet.',
			format: 'markdown',
		});
		await configure('chat', { 'ai_replies.bubbles': 1 });
	});

	it('C3: when the AI fails, the merchant’s fallback answer is filled with the real deals; else the on-failure message', async () => {
		const cookie = await sys.adminSession(await sys.owner(), websiteId);
		const list = await sys.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/lists/fallback_answers`, {
			items: [
				{ intent: 'deals', language: '', keywords: ['deal', 'offer'], text: 'Our deals:\n\n{deals_table}' },
				{ intent: 'other', language: '', keywords: ['hours'], text: 'We are open 9 to 5.' },
			],
		});
		expect(list.status, JSON.stringify(list.json)).toBeLessThan(300);
		aiDown = true;
		try {
			const guest = device();
			await guest('POST', '/v1/chat/messages', { text: 'any deal today?' });
			let last = (await guest('GET', '/v1/chat')).json.messages.at(-1);
			expect(last).toMatchObject({ author: 'ai', format: 'markdown' });
			expect(last.text).toMatch(
				/^Our deals:\n\n\| Deal \| Details \| Ends \|\n\| --- \| --- \| --- \|\n\| Lamp week \| 10% off lamps \|/,
			);
			await guest('POST', '/v1/chat/messages', { text: 'what are your hours' });
			expect(authors((await guest('GET', '/v1/chat')).json).at(-1)).toEqual(['ai', 'We are open 9 to 5.']);
			// nothing matches: the on-failure message
			await guest('POST', '/v1/chat/messages', { text: 'can you ship to Quetta?' });
			last = (await guest('GET', '/v1/chat')).json.messages.at(-1);
			expect(last.author).toBe('system');
			expect(last.text).toBe(strings['chat.aiUnavailable']);
		} finally {
			aiDown = false;
		}
	});

	it('C5: staff alerts go through the kit and the real Notifications to emails, a phone and Accounts staff', async () => {
		await configure('chat', {
			'staff_alerts.recipients': ['team@lamps.example.com', TEAM_PHONE],
			'staff_alerts.staffPermission': 'inbox.reply',
			'staff_alerts.frequency': 'every_message',
		});
		const mailsBefore = mails.length;
		const whatsappBefore = whatsapp.length;
		const guest = device();
		await guest('POST', '/v1/chat/messages', { text: 'one' });
		await guest('POST', '/v1/chat/messages', { text: 'two' });
		const alerts = mails.slice(mailsBefore).filter((mail) => mail.subject === 'New chat message');
		expect(alerts.map((mail) => mail.to[0]).sort()).toEqual([
			'agent@lamps.example.com',
			'agent@lamps.example.com',
			'team@lamps.example.com',
			'team@lamps.example.com',
		]);
		expect(alerts.at(-1).text).toContain('two');
		expect(alerts.at(-1).text).toContain(`${ADMIN_ORIGIN}/inbox?conversation=`);
		const phoned = whatsapp.slice(whatsappBefore).filter((message) => message.to === TEAM_DIGITS);
		expect(phoned.map((message) => message.text?.body)).toEqual(['New chat: one', 'New chat: two']);
		// the customers' own addresses are never alerted
		expect(mails.slice(mailsBefore).some((mail) => mail.to.includes('rea@example.com'))).toBe(false);
	});

	it('C4: the AI answers the message that asked for a person first, then stays quiet, then reassures after 3 minutes', async () => {
		await configure('chat', {
			'handoff.answerFirst': true,
			'handoff.notice': '',
			'handoff.showButton': false,
			'handoff.reassureAfterMinutes': 3,
		});
		const config = await sys.call('GET', '/v1/widget/config', { token: tokens.chat?.browser, origin: ORIGIN });
		expect(config.json.settings.handoff.showButton).toBe(false);
		const mailsBefore = mails.length;
		const whatsappBefore = whatsapp.length;
		aiAnswers.push('Our lamps come with a year of warranty.');
		const guest = device();
		const sent = await guest('POST', '/v1/chat/messages', { text: 'warranty? I want to talk to someone' });
		let state = await guest('GET', '/v1/chat');
		expect(authors(state.json).slice(0, 2)).toEqual([
			['visitor', 'warranty? I want to talk to someone'],
			['ai', 'Our lamps come with a year of warranty.'],
		]);
		expect(state.json.conversation.waiting).toBe(true);
		// no handoff notice (only the contact request a guest without contact details gets)
		expect(state.json.messages.some((/** @type {any} */ m) => m.text === 'A person from our team will reply here.')).toBe(
			false,
		);
		// `Chat needs you` to the same recipients through the real Notifications
		const needsYou = mails.slice(mailsBefore).filter((mail) => mail.subject === 'Chat needs you');
		expect(needsYou.map((mail) => mail.to[0]).sort()).toEqual(['agent@lamps.example.com', 'team@lamps.example.com']);
		expect(needsYou[0].text).toContain(`${ADMIN_ORIGIN}/inbox?conversation=${sent.json.chat.conversation.id}`);
		const needsYouPhoned = whatsapp
			.slice(whatsappBefore)
			.filter((message) => message.to === TEAM_DIGITS && String(message.text?.body).startsWith('Needs you: '));
		expect(needsYouPhoned).toHaveLength(1);

		// quiet until 3 minutes after the handoff, then reassurance only (no tools)
		const asked = prompts.length;
		await guest('POST', '/v1/chat/messages', { text: 'hello?' });
		expect(prompts).toHaveLength(asked);
		sys.clock.advance(3 * 60_000);
		aiAnswers.push('A person will reply here soon.');
		await guest('POST', '/v1/chat/messages', { text: 'anyone?' });
		state = await guest('GET', '/v1/chat');
		expect(authors(state.json).at(-1)).toEqual(['ai', 'A person will reply here soon.']);
		expect(lastSystemPrompt()).toContain('Only reassure them');
		expect(prompts.at(-1).tools ?? []).toEqual([]);
		await configure('chat', { 'handoff.answerFirst': false, 'handoff.reassureAfterMinutes': 0 });
	});

	it('C6: a staff reply sends `chat.staff_reply` by WhatsApp to a visitor who left, once until they check again', async () => {
		const guest = device();
		const sent = await guest('POST', '/v1/chat/messages', { text: 'call me about Lamp Max', page: { url: PAGE_URL } });
		expect((await guest('POST', '/v1/chat/contact', { name: 'Ann', phone: '+12025550199' })).status, 'contact').toBeLessThan(
			300,
		);
		const path = `/v1/conversations/${sent.json.chat.conversation.id}/messages`;
		/** WhatsApp messages to the visitor. */
		const toVisitor = () => whatsapp.filter((message) => message.to === '12025550199');
		// still here: no alert
		await server('chat', 'POST', path, { text: 'Hi Ann' }, STAFF);
		expect(toVisitor()).toHaveLength(0);
		sys.clock.advance(61_000);
		await server('chat', 'POST', path, { text: 'We have **two** colors.' }, STAFF);
		await server('chat', 'POST', path, { text: 'Anything else?' }, STAFF);
		expect(toVisitor().map((message) => message.text?.body)).toEqual([`Alex Morgan: We have two colors. ${PAGE_URL}`]);
		// the visitor checks the chat; away again, the next reply alerts once more
		await guest('GET', '/v1/chat');
		sys.clock.advance(61_000);
		await server('chat', 'POST', path, { text: 'Back?' }, STAFF);
		expect(toVisitor()).toHaveLength(2);
	});

	it('C7: an imported guest cookie works; a guest chat merges by time into the account’s; claims by phone', async () => {
		// a store's own guest cookie, imported as a hash into Chat's merchant database
		const cookie = 'storeGuest-1234567890abcdef';
		const data = await sys.product.data.forWebsite(websiteId);
		await data
			.collection('guests')
			.insertOne({ id: 'guest_imported', keyHash: sha256(cookie), expireAt: new Date(sys.clock.now() + DAY) });
		const imported = device({ guestKey: cookie });
		const first = await imported('POST', '/v1/chat/messages', { text: 'guest 1' });
		expect(first.status).toBe(201);
		expect(first.json.guestKey).toBeUndefined();
		expect(first.json.chat.guestMessagesLeft).toBe(4);
		expect((await device({ guestKey: 'short' })('GET', '/v1/chat')).json.conversation).toBeNull();

		// the account already has a conversation: the guest's merges into it by time
		const nadiaSignIn = await signIn('nadia@example.com');
		const nadia = device({ signIn: nadiaSignIn });
		await nadia('POST', '/v1/chat/messages', { text: 'user 1' });
		await imported('POST', '/v1/chat/messages', { text: 'guest 2' });
		const merged = await device({ guestKey: cookie, signIn: nadiaSignIn })('GET', '/v1/chat');
		const visitorTexts = (/** @type {any} */ json) =>
			json.messages.filter((/** @type {any} */ m) => m.author === 'visitor').map((/** @type {any} */ m) => m.text);
		expect(visitorTexts(merged.json)).toEqual(['guest 1', 'user 1', 'guest 2']);
		const seqs = merged.json.messages.map((/** @type {any} */ m) => m.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(new Set(seqs).size).toBe(seqs.length);
		expect(merged.json.guestMessagesLeft).toBeNull();

		// another device left Nadia's phone as a guest: it moves only with claim by phone
		const phoneGuest = device();
		await phoneGuest('POST', '/v1/chat/messages', { text: 'from my phone' });
		await phoneGuest('POST', '/v1/chat/contact', { phone: '+33612345678' });
		expect(visitorTexts((await nadia('GET', '/v1/chat')).json)).not.toContain('from my phone');
		await configure('chat', { 'signed_in_chat.claimByPhone': true });
		expect(visitorTexts((await nadia('GET', '/v1/chat')).json).at(-1)).toBe('from my phone');
		const conversations = await server('chat', 'GET', `/v1/conversations?userId=${users.nadia}`);
		expect(conversations.json.items).toHaveLength(1);
	});

	it('C8: older messages page back by sequence for the visitor, the merchant’s server and staff', async () => {
		const nadia = device({ signIn: await signIn('nadia@example.com') });
		const all = (await nadia('GET', '/v1/chat')).json;
		const seqs = all.messages.map((/** @type {any} */ m) => m.seq);
		expect(seqs.length).toBeGreaterThanOrEqual(7);
		expect(all.earlier).toBe(false);
		const id = String(all.conversation.id);
		const n = seqs.length;
		/** @param {any} json */
		const seqsOf = (json) => json.messages.map((/** @type {any} */ m) => m.seq);

		const latest = await nadia('GET', '/v1/chat?limit=3');
		expect(seqsOf(latest.json)).toEqual(seqs.slice(n - 3));
		expect(latest.json.earlier).toBe(true);
		const older = await nadia('GET', `/v1/chat?before=${seqs[n - 3]}&limit=3`);
		expect(seqsOf(older.json)).toEqual(seqs.slice(n - 6, n - 3));
		expect(older.json.earlier).toBe(true);
		const oldest = await nadia('GET', `/v1/chat?before=${seqs[1]}`);
		expect(seqsOf(oldest.json)).toEqual([seqs[0]]);
		expect(oldest.json.earlier).toBe(false);

		// the merchant's server (server token) and staff in the inbox widget (ticket)
		const fromServer = await server('chat', 'GET', `/v1/conversations/${id}?before=${seqs[n - 1]}&limit=2`);
		expect(seqsOf(fromServer.json)).toEqual(seqs.slice(n - 3, n - 1));
		const ticket = await server('chat', 'POST', '/v1/tickets', {
			user: { id: 'u_7', name: 'Sam Staff', email: 'sam@lamps.example.com' },
			permissions: ['inbox.read', 'inbox.reply'],
			origin: ADMIN_ORIGIN,
		});
		const staffPage = await sys.call('GET', `/v1/admin/conversations/${id}?before=${seqs[3]}&limit=50`, {
			token: String(ticket.json.ticket),
			origin: ADMIN_ORIGIN,
		});
		expect(seqsOf(staffPage.json)).toEqual(seqs.slice(0, 3));
		expect(staffPage.json.earlier).toBe(false);
		// the limit is 1–50
		expect(seqsOf((await nadia('GET', `/v1/chat?before=${seqs[n - 1]}&limit=500`)).json)).toEqual(seqs.slice(0, n - 1));
	});
});
