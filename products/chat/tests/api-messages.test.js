/**
 * Chat's messages and their default templates, and the staff alert option all_staff (parity P1): every message Chat
 * sends through Notifications is declared in `schemas/messages.json` with US-English default words and every send
 * carries them; `staffPermission: all_staff` alerts every unblocked Accounts user whose role may see the inbox; a
 * transcript goes whole in its one long value.
 */
import { validateMessageDefaults } from '@ss/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import declaration from '../schemas/messages.json' with { type: 'json' };
import { MESSAGE_TEMPLATES } from '../core/conversation.js';
import { ALL_STAFF_PERMISSION } from '../server/service.js';
import { ready } from './helpers.js';

/** @type {Array<Awaited<ReturnType<typeof ready>>>} */
const systems = [];
afterAll(async () => {
	for (const sys of systems) await sys.product.close();
});
/** @param {string[]} on */
const start = async (on) => {
	const sys = await ready(on);
	systems.push(sys);
	return sys;
};

/**
 * The defaults the kit attaches to a send of a message: each channel with words, with the message's flags.
 * @param {string} key
 */
const defaultsOf = (key) => {
	const message = /** @type {any} */ (declaration.messages.find((each) => each.key === key));
	return Object.fromEntries(
		Object.entries(message.channels)
			.filter(([, words]) => words !== null)
			.map(([channel, words]) => [
				channel,
				{
					...words,
					required: message.required === true,
					urgent: message.urgent === true,
					sensitive: message.sensitive === true,
				},
			]),
	);
};

describe('Chat’s messages and their defaults (parity P1)', () => {
	it('declares every message it sends, with the values each gets, as the contract wants', async () => {
		expect(validateMessageDefaults({ productId: 'chat', ...declaration })).toMatchObject({ ok: true });
		expect(Object.fromEntries(declaration.messages.map((message) => [message.key, message.values]))).toEqual(
			Object.fromEntries(Object.entries(MESSAGE_TEMPLATES).map(([key, values]) => [key, [...values]])),
		);
		// staff alerts go by email, or to phones by WhatsApp or SMS; the transcript by email only
		for (const message of declaration.messages.filter((m) => m.key.startsWith('chat.staff_')))
			expect(Object.keys(message.channels)).toEqual(['email', 'sms', 'whatsapp']);
		expect(Object.keys(declaration.messages.find((m) => m.key === 'chat.transcript')?.channels ?? {})).toEqual(['email']);
		const sys = await start(['visitor_chat']);
		expect((await sys.call('GET', '/v1/message-defaults')).json).toEqual({ productId: 'chat', ...declaration });
	});

	it('all_staff alerts every unblocked Accounts user who may see the inbox, and every alert carries its defaults', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'inbox', 'staff_alerts', 'transcripts']);
		await sys.paste('notifications');
		await sys.paste('accounts');
		sys.accounts.setUsers([
			{ id: 'usr_a', email: 'reader@shop.example.com', permissions: ['chat:inbox.read'] },
			{ id: 'usr_b', email: 'replier@shop.example.com', permissions: ['chat:inbox.read', 'chat:inbox.reply'] },
			{ id: 'usr_c', email: 'owner@shop.example.com', permissions: ['*'] },
			{ id: 'usr_d', email: 'blocked@shop.example.com', blocked: true, permissions: ['chat:inbox.read'] },
			{ id: 'usr_e', email: 'shop@shop.example.com', permissions: ['ecommerce:orders.read'] },
		]);
		await sys.setting('staff_alerts', 'staffPermission', 'all_staff');
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'Is the blue lamp in stock?' });
		const sent = sys.messages();
		expect(sent.map((m) => m.to)).toEqual([
			{ email: 'reader@shop.example.com' },
			{ email: 'replier@shop.example.com' },
			{ email: 'owner@shop.example.com' },
		]);
		expect(sys.accounts.userReads).toEqual([`chat:${ALL_STAFF_PERMISSION}`]);
		expect(sent[0]).toMatchObject({
			channel: 'email',
			template: 'chat.staff_new_message',
			required: true,
			defaults: defaultsOf('chat.staff_new_message'),
		});
		// the transcript too, naming its long value
		expect((await v('POST', '/v1/chat/transcript', { email: 'me@example.com' })).status).toBe(202);
		expect(sys.messages().at(-1)).toMatchObject({
			template: 'chat.transcript',
			defaults: defaultsOf('chat.transcript'),
			longValues: ['transcript'],
		});
	});
});

describe('transcripts as one long value', () => {
	it('send the whole chat within Notifications’ long value limit; a longer chat sends its latest messages and says so', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'transcripts']);
		await sys.paste('notifications');
		await sys.setting('guest_chat', 'messageLimit', 0);
		const v = sys.visitor();
		const texts = Array.from({ length: 13 }, (_, i) => `${String.fromCharCode(65 + i)}${'x'.repeat(3999)}`);
		for (const text of texts.slice(0, 12)) await v('POST', '/v1/chat/messages', { text });
		/** The transcript of the last send, with what Notifications got. */
		const sent = async () => {
			expect((await v('POST', '/v1/chat/transcript', { email: 'me@example.com' })).status).toBe(202);
			const { values } = sys.messages().at(-1);
			expect(Object.keys(values).sort()).toEqual([...MESSAGE_TEMPLATES['chat.transcript']].sort());
			expect(String(values.transcript).length).toBeLessThanOrEqual(50_000);
			return values.transcript;
		};
		// 12 messages: 48,071 characters, more than the 45,000 of the old parts, whole
		expect(await sent()).toBe(
			texts
				.slice(0, 12)
				.map((text) => `You: ${text}`)
				.join('\n'),
		);
		await v('POST', '/v1/chat/messages', { text: texts[12] });
		expect(await sent()).toBe(
			[
				'This copy has the latest 12 messages; earlier ones are left out.',
				...texts.slice(1).map((text) => `You: ${text}`),
			].join('\n'),
		);
	});
});
