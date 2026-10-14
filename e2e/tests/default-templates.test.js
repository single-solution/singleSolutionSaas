/**
 * Parity P1: default message templates against the REAL Portal, Notifications, Accounts and Chat, all in this process.
 * A merchant who writes no template at all still gets a password-reset email and a Chat staff alert: each product's
 * send carries its US-English default words and Notifications uses them; Notifications' dashboard lists every product's
 * messages through the Portal's directory; a message switched off on a channel is skipped. The email provider (Resend)
 * is a fake in this process; no real network call is made.
 */
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
	createProductInstance as createNotifications,
	manifest as notifyManifest,
	strings as notifyStrings,
} from '@ss/product-notifications/product';
import { createRoutes as notifyRoutes } from '@ss/product-notifications/routes';
import { startSystem } from './helpers.js';

const CHAT = 'https://chat-defaults.test';
const ACCOUNTS = 'https://accounts-defaults.test';
const NOTIFY = 'https://notifications-defaults.test';
const DOMAIN = 'defaults.example.com';
const ORIGIN = `https://${DOMAIN}`;
const PASSWORD = 'a long enough password';

/** Emails the merchant's provider (Resend) received. @type {any[]} */
const mails = [];

/** @param {Request} request */
const resend = async (request) => {
	if (request.method === 'POST') mails.push(await request.json());
	return Response.json({ id: `re_${mails.length}` });
};

/** @type {import('./helpers.js').System} */
let sys;
let websiteId = '';
/** @type {Record<string, { browser: string, server: string }>} */
const tokens = {};
/** @type {Record<string, string>} */
const BASES = { chat: CHAT, accounts: ACCOUNTS, notifications: NOTIFY };

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
			handlers: { 'https://api.resend.com': resend },
		},
		extras: [
			unit(createAccounts, accountsRoutes, accountsManifest, accountsStrings, ACCOUNTS),
			unit(createNotifications, notifyRoutes, notifyManifest, notifyStrings, NOTIFY),
		],
	});
});
afterAll(async () => {
	await sys?.stop();
});

/**
 * A dashboard call of an Owner on a product.
 * @param {string} productKey @param {string} method @param {string} path @param {unknown} [body]
 */
const dash = async (productKey, method, path, body) => {
	const cookie = await sys.adminSession(await sys.owner(), websiteId, productKey);
	return sys.dashboard(cookie, method, `/v1/dashboard/websites/${websiteId}${path}`, body, BASES[productKey]);
};

/** A visitor's message in the chat widget (a new guest each time). @param {string} text */
const visitorSays = (text) =>
	sys.call('POST', '/v1/chat/messages', { token: tokens.chat?.browser, origin: ORIGIN, body: { text } });

describe('default templates: no template written, messages still go (parity P1)', () => {
	it('sets up Notifications (email by Resend), Accounts and Chat without writing a single template', async () => {
		for (const base of [CHAT, ACCOUNTS, NOTIFY]) await sys.connect({ base });
		const m = await sys.merchant('defaults@shop.test', [DOMAIN]);
		websiteId = m.websiteIds[0] ?? '';
		for (const id of ['chat', 'accounts', 'notifications']) {
			await sys.addProduct(m.merchantId, websiteId, id);
			tokens[id] = await sys.tokens(m.merchantId, websiteId, id);
		}
		await sys.addCredits(m.merchantId, 100);
		/** @type {Record<string, string[]>} */
		const features = {
			chat: ['visitor_chat', 'guest_chat', 'inbox', 'staff_alerts'],
			accounts: ['email_password'],
			notifications: ['email'],
		};
		for (const [id, on] of Object.entries(features)) {
			expect((await dash(id, 'PUT', '/features', { on })).status).toBe(200);
			await sys.connectDatabase(await sys.adminSession(await sys.owner(), websiteId, id), websiteId, BASES[id]);
		}
		expect(
			(
				await dash('notifications', 'PUT', '/connections/email', {
					value: { provider: 'resend', secret: 're_live_key_0101', from: 'Shop <shop@defaults.example.com>' },
				})
			).json,
		).toMatchObject({ status: 'connected' });
		for (const id of ['accounts', 'chat'])
			expect(
				(await dash(id, 'PUT', '/connections/notifications', { value: tokens.notifications?.server })).json,
			).toMatchObject({ status: 'connected' });
		expect(
			(await dash('chat', 'PUT', '/settings/staff_alerts.recipients', { value: ['ops@defaults.example.com'] })).status,
		).toBe(204);
		const saved = await dash('notifications', 'GET', '/templates');
		expect(saved.json.items).toEqual([]);
	});

	it('a password reset reaches the mail outbox with Accounts’ default words', async () => {
		const up = await sys.call('POST', '/v1/sign-up/password', {
			base: ACCOUNTS,
			token: tokens.accounts?.browser,
			origin: ORIGIN,
			body: { email: 'rea@example.com', password: PASSWORD, name: 'Rea Der' },
		});
		expect(up.json.status, JSON.stringify(up.json)).toBe('signed_in');
		const before = mails.length;
		const forgot = await sys.call('POST', '/v1/password/forgot', {
			base: ACCOUNTS,
			token: tokens.accounts?.browser,
			origin: ORIGIN,
			body: { email: 'rea@example.com', returnTo: `${ORIGIN}/reset` },
		});
		expect(forgot.status).toBe(202);
		const mail = mails.slice(before).find((each) => String(each.subject).startsWith('Reset your password for'));
		expect(mail, JSON.stringify(mails.slice(before))).toBeDefined();
		expect(mail.to).toEqual(['rea@example.com']);
		expect(mail.subject).toBe(`Reset your password for ${DOMAIN}`);
		expect(mail.text).toMatch(
			new RegExp(`^We got a request to reset the password of your ${DOMAIN.replaceAll('.', '\\.')} account`),
		);
		expect(mail.text).toContain(`${ORIGIN}/reset#ss_accounts_reset=`);
		expect(mail.text).toContain('The link works for 60 minutes.');
	});

	it('a Chat staff alert reaches the mail outbox with Chat’s default words', async () => {
		const before = mails.length;
		const sent = await visitorSays('Is the blue lamp in stock?');
		expect(sent.status, JSON.stringify(sent.json)).toBe(201);
		const alerts = mails.slice(before).filter((each) => String(each.subject).startsWith('New chat message from'));
		expect(alerts).toHaveLength(1);
		expect(alerts[0].to).toEqual(['ops@defaults.example.com']);
		expect(alerts[0].subject).toBe('New chat message from Guest');
		expect(alerts[0].text).toBe(`Guest wrote on ${DOMAIN}:\n\nIs the blue lamp in stock?`);
	});

	it('Notifications’ dashboard lists both products’ messages through the Portal directory; a switched-off one is skipped', async () => {
		const listed = await dash('notifications', 'GET', '/messages');
		expect(listed.status).toBe(200);
		const keys = listed.json.items.map((/** @type {any} */ m) => `${m.productId}:${m.key}`);
		expect(keys).toEqual(
			expect.arrayContaining([
				'accounts:accounts.password_reset',
				'accounts:accounts.phone_code',
				'chat:chat.staff_new_message',
				'chat:chat.transcript',
			]),
		);
		const reset = listed.json.items.find((/** @type {any} */ m) => m.key === 'accounts.password_reset');
		expect(reset.channels.email.subject).toBe('Reset your password for {business}');
		// Ecommerce, Payments and Growth are not in this system: named, never a failure of the list
		expect(listed.json.unavailable).toEqual(['ecommerce', 'payments', 'growth']);

		expect((await dash('notifications', 'PUT', '/messages/chat.staff_new_message/email', { off: true })).status).toBe(200);
		const before = mails.length;
		expect((await visitorSays('Do you ship abroad?')).status).toBe(201);
		expect(mails.slice(before).filter((each) => String(each.subject).startsWith('New chat message from'))).toEqual([]);
		// Accounts' sign-in messages are always sent
		expect((await dash('notifications', 'PUT', '/messages/accounts.password_reset/email', { off: true })).status).toBe(422);
		expect((await dash('notifications', 'PUT', '/messages/chat.staff_new_message/email', { off: false })).status).toBe(200);
		expect((await visitorSays('And to Canada?')).status).toBe(201);
		expect(mails.slice(before).filter((each) => String(each.subject).startsWith('New chat message from'))).toHaveLength(1);
	});
});
