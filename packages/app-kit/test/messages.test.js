import { describe, expect, it } from 'vitest';
import { defineRoute } from '../src/index.js';
import { createMessages } from '../src/messages.js';
import { productRoutes, setup } from './helpers.js';

/** The sample product's messages: a staff alert with defaults by email and SMS, and a code sent on WhatsApp only. */
const DECLARATION = Object.freeze({
	messages: [
		{
			key: 'notes.staff_note_created',
			name: 'New note',
			description: 'Tells the staff about a new note.',
			values: ['noteId', 'preview', 'link'],
			required: true,
			channels: {
				email: { subject: 'New note {noteId}', text: '{preview}{?link}\n\nOpen it: {link}{/link}' },
				sms: { text: 'New note: {preview}' },
				whatsapp: null,
			},
		},
		{ key: 'notes.code', name: 'Code', values: ['code'], channels: { whatsapp: null } },
	],
});

/** The defaults the kit attaches for the staff alert. */
const ALERT_DEFAULTS = {
	email: {
		subject: 'New note {noteId}',
		text: '{preview}{?link}\n\nOpen it: {link}{/link}',
		required: true,
		urgent: false,
		sensitive: false,
	},
	sms: { text: 'New note: {preview}', required: true, urgent: false, sensitive: false },
};

describe('message defaults (parity P1)', () => {
	it('checks the declaration with the contract and the product id', () => {
		const none = createMessages({ productId: 'notes' });
		expect(none.declaration).toEqual({ productId: 'notes', messages: [] });
		expect(none.defaultsFor('notes.code')).toBeNull();
		const declared = createMessages({ productId: 'notes', declaration: DECLARATION });
		expect(declared.declaration.productId).toBe('notes');
		expect(declared.declaration.messages).toEqual(DECLARATION.messages);
		expect(Object.isFrozen(declared.declaration.messages[0]?.channels.email)).toBe(true);
		expect(declared.defaultsFor('notes.staff_note_created')).toEqual(ALERT_DEFAULTS);
		// WhatsApp never has a default: a message sent only there has none
		expect(declared.defaultsFor('notes.code')).toBeNull();
		expect(declared.defaultsFor('notes.unknown')).toBeNull();
		expect(() => createMessages({ productId: 'other', declaration: DECLARATION })).toThrow(/must start with 'other\.'/);
		expect(() => createMessages({ productId: 'notes', declaration: { messages: [{ key: 'notes.x' }] } })).toThrow(
			/messages are invalid/,
		);
		expect(() =>
			createMessages({
				productId: 'notes',
				declaration: { messages: [{ key: 'notes.x', name: 'X', values: [], channels: { whatsapp: { text: 'Hi' } } }] },
			}),
		).toThrow(/channels\/whatsapp/);
		expect(() =>
			createMessages({
				productId: 'notes',
				declaration: { messages: [{ key: 'notes.x', name: 'X', values: [], channels: { sms: { text: 'Hi {name}' } } }] },
			}),
		).toThrow(/is not one of the message's values/);
		expect(() => createMessages({ productId: 'notes', declaration: [] })).toThrow(/messages are invalid/);
	});

	it('attaches the defaults to sends to Notifications only', () => {
		const { attach } = createMessages({ productId: 'notes', declaration: DECLARATION });
		const send = { method: 'POST', body: { template: 'notes.staff_note_created', to: { email: 'a@b.example' } } };
		expect(attach('notifications', '/v1/messages/email', send)).toEqual({
			...send,
			body: { ...send.body, defaults: ALERT_DEFAULTS },
		});
		expect(attach('notifications', '/v1/messages/staff-push', send).body).toHaveProperty('defaults');
		// the caller's own defaults, another product, another route, a read, no template or one without defaults: as given
		const own = { ...send, body: { ...send.body, defaults: {} } };
		expect(attach('notifications', '/v1/messages/email', own)).toBe(own);
		expect(attach('accounts', '/v1/messages/email', send)).toBe(send);
		expect(attach('notifications', '/v1/events', send)).toBe(send);
		expect(attach('notifications', '/v1/messages/fax', send)).toBe(send);
		const read = { body: send.body };
		expect(attach('notifications', '/v1/messages/email', read)).toBe(read);
		const text = { method: 'POST', body: 'text' };
		expect(attach('notifications', '/v1/messages/email', text)).toBe(text);
		const untitled = { method: 'POST', body: { to: {} } };
		expect(attach('notifications', '/v1/messages/email', untitled)).toBe(untitled);
		const whatsappOnly = { method: 'POST', body: { template: 'notes.code' } };
		expect(attach('notifications', '/v1/messages/whatsapp', whatsappOnly)).toBe(whatsappOnly);
	});

	it('serves the declaration publicly and sends the defaults with every message to Notifications', async () => {
		/** @type {{ product: any }} */
		const holder = { product: null };
		const ctx = await setup({
			messages: DECLARATION,
			routes: [
				...productRoutes(),
				defineRoute({
					method: 'POST',
					path: '/v1/server/notify',
					auth: 'server',
					feature: 'notes',
					database: false,
					handler: async (request) => {
						const answer = await holder.product.callProduct(request.websiteId, 'notifications', '/v1/messages/sms', {
							method: 'POST',
							body: { template: 'notes.staff_note_created', to: { phone: '+447700900123' }, values: { preview: 'Hi' } },
						});
						return { ok: answer.ok };
					},
				}),
			],
			connections: {
				notifications: { label: 'Notifications token', kind: 'token', productId: 'notifications', neededBy: [] },
			},
		});
		holder.product = ctx.product;
		const response = await ctx.call('GET', '/v1/message-defaults');
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('public, max-age=300');
		expect(await response.json()).toEqual({ productId: 'notes', ...DECLARATION });
		expect(ctx.product.messages.declaration).toEqual({ productId: 'notes', ...DECLARATION });
		expect(ctx.product.messages.defaultsFor('notes.staff_note_created')).toEqual(ALERT_DEFAULTS);
		expect(await ctx.product.addressOf('notifications')).toBe(ctx.notifications.url);

		await ctx.switchOn(['notes']);
		const cookie = await ctx.session({ kind: 'merchant' });
		const token = (await ctx.portal.issueToken({ websiteId: ctx.websiteId, productId: 'notifications', kind: 'server' })).token;
		await ctx.dash(cookie, 'PUT', `/v1/dashboard/websites/${ctx.websiteId}/connections/notifications`, { value: token });
		const sent = await ctx.call('POST', '/v1/server/notify', { token: ctx.server.token, body: {} });
		expect(await sent.json()).toEqual({ ok: true });
		expect(ctx.notifications.messages.at(-1)?.body).toEqual({
			template: 'notes.staff_note_created',
			to: { phone: '+447700900123' },
			values: { preview: 'Hi' },
			defaults: ALERT_DEFAULTS,
		});
	});

	it('a product without a declaration answers no messages', async () => {
		const ctx = await setup();
		const response = await ctx.call('GET', '/v1/message-defaults');
		expect(await response.json()).toEqual({ productId: 'notes', messages: [] });
	});
});
