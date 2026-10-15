/**
 * Accounts' messages and their default templates (parity P1): every message Accounts sends through Notifications is
 * declared in `schemas/messages.json` with US-English default words, and every send carries them, so a new website
 * gets its sign-in codes, reset links and invites before the merchant writes a template.
 */
import { validateMessageDefaults } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import declaration from '../schemas/messages.json' with { type: 'json' };
import { MESSAGE_TEMPLATES } from '../core/widgets.js';
import { ALL, ORIGIN, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

/**
 * The defaults the kit attaches to a send of a message: each channel with words, with the message's flags.
 * @param {string} key
 */
const defaultsOf = (key) => {
	const message = declaration.messages.find((each) => each.key === key);
	if (!message) throw new Error(`${key} is not declared`);
	return Object.fromEntries(
		Object.entries(message.channels)
			.filter(([, words]) => words !== null)
			.map(([channel, words]) => [channel, { ...words, required: true, urgent: true, sensitive: true }]),
	);
};

beforeAll(async () => {
	env = await setup();
	await env.switchOn(ALL.filter((key) => !['terms', 'approval', 'two_step', 'risk_checks'].includes(key)));
	await env.connectDatabase();
	await env.paste('notifications');
});
afterAll(async () => {
	await env.product.close();
});

describe('Accounts’ messages and their defaults (parity P1)', () => {
	it('declares every message it sends, with the values each gets, as the contract wants', async () => {
		expect(validateMessageDefaults({ productId: 'accounts', ...declaration })).toMatchObject({ ok: true });
		expect(Object.fromEntries(declaration.messages.map((message) => [message.key, message.values]))).toEqual(
			Object.fromEntries(Object.entries(MESSAGE_TEMPLATES).map(([key, values]) => [key, [...values]])),
		);
		// sign-in messages are required, urgent and sensitive; WhatsApp never has a default
		for (const message of declaration.messages) {
			expect(message).toMatchObject({ required: true, urgent: true, sensitive: true });
			expect(Object.values(message.channels).every((words) => words === null || typeof words.text === 'string')).toBe(true);
		}
		expect(Object.keys(declaration.messages.find((m) => m.key === 'accounts.phone_code')?.channels ?? {})).toEqual([
			'sms',
			'whatsapp',
		]);
		const served = await env.call('GET', '/v1/message-defaults');
		expect(served.json).toEqual({ productId: 'accounts', ...declaration });
	});

	it('every send carries the message’s defaults: a reset link, an email code and a phone code', async () => {
		await env.visitor('POST', '/v1/sign-up/password', {
			email: 'rea@example.com',
			password: 'correct horse battery',
			name: 'Rea Der',
		});
		expect((await env.visitor('POST', '/v1/password/forgot', { email: 'rea@example.com', returnTo: ORIGIN })).status).toBe(202);
		expect(env.messages().at(-1)).toMatchObject({
			channel: 'email',
			template: 'accounts.password_reset',
			defaults: defaultsOf('accounts.password_reset'),
		});
		expect((await env.visitor('POST', '/v1/sign-in/email/code', { email: 'rea@example.com' })).status).toBe(202);
		expect(env.messages().at(-1)).toMatchObject({
			channel: 'email',
			template: 'accounts.email_code',
			defaults: defaultsOf('accounts.email_code'),
		});
		await env.setting('phone', 'channel', 'whatsapp');
		expect((await env.visitor('POST', '/v1/sign-in/phone/code', { phone: '+447700900123' })).status).toBe(202);
		// on WhatsApp too: Notifications uses the SMS words only for a fallback to SMS
		expect(env.messages().at(-1)).toMatchObject({
			channel: 'whatsapp',
			template: 'accounts.phone_code',
			defaults: { sms: defaultsOf('accounts.phone_code').sms },
		});
		await env.setting('phone', 'channel', 'sms');
	});
});
