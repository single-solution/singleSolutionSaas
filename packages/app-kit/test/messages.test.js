import { describe, expect, it } from 'vitest';
import { defineRoute } from '../src/index.js';
import { createMessages } from '../src/messages.js';
import { productRoutes, setup } from './helpers.js';

/**
 * The sample product's messages: a staff alert with defaults by email and SMS, a code sent on WhatsApp only, and a
 * copy of a note with its long body (a long value).
 */
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
		{
			key: 'notes.copy',
			name: 'Copy of a note',
			values: ['title', 'body'],
			longValues: ['body'],
			required: true,
			channels: { email: { subject: 'Your note {title}', text: '{body}' } },
		},
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
		const alertSend = { method: 'POST', body: { template: 'notes.staff_note_created' } };
		expect(none.attach('notifications', '/v1/messages/email', alertSend)).toBe(alertSend);
		const declared = createMessages({ productId: 'notes', declaration: DECLARATION });
		expect(declared.declaration.productId).toBe('notes');
		expect(declared.declaration.messages).toEqual(DECLARATION.messages);
		expect(Object.isFrozen(declared.declaration.messages[0]?.channels.email)).toBe(true);
		expect(declared.attach('notifications', '/v1/messages/email', alertSend).body).toEqual({
			...alertSend.body,
			defaults: ALERT_DEFAULTS,
		});
		// WhatsApp never has a default: a message sent only there has none
		for (const template of ['notes.code', 'notes.unknown']) {
			const send = { method: 'POST', body: { template } };
			expect(declared.attach('notifications', '/v1/messages/email', send)).toBe(send);
		}
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
		expect(() =>
			createMessages({
				productId: 'notes',
				declaration: {
					messages: [{ key: 'notes.x', name: 'X', values: ['a'], longValues: ['b'], channels: { sms: { text: '{a}' } } }],
				},
			}),
		).toThrow(/longValues\/0 'b' is not one of the message's values/);
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
		// the declared words always win over a body's own; another product, another route, a read, no template or one
		// without defaults: as given
		const own = { ...send, body: { ...send.body, defaults: {} } };
		expect(attach('notifications', '/v1/messages/email', own).body).toEqual({ ...send.body, defaults: ALERT_DEFAULTS });
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

	it('attaches a message’s words in other languages to the channel they belong to (fixed-choices N11)', () => {
		const { attach } = createMessages({
			productId: 'notes',
			declaration: {
				messages: [
					{
						...DECLARATION.messages[0],
						translations: { fr: { email: { subject: 'Nouvelle note {noteId}', text: '{preview}' } } },
					},
				],
			},
		});
		const send = { method: 'POST', body: { template: 'notes.staff_note_created', to: { email: 'a@b.example' } } };
		expect(/** @type {any} */ (attach('notifications', '/v1/messages/email', send).body).defaults).toEqual({
			...ALERT_DEFAULTS,
			email: { ...ALERT_DEFAULTS.email, translations: { fr: { subject: 'Nouvelle note {noteId}', text: '{preview}' } } },
		});
	});

	it('names a message’s long values on every send of it, so Notifications takes them whole', () => {
		const { attach } = createMessages({ productId: 'notes', declaration: DECLARATION });
		const copy = { method: 'POST', body: { template: 'notes.copy', to: { email: 'a@b.example' } } };
		expect(attach('notifications', '/v1/messages/email', copy).body).toEqual({
			...copy.body,
			defaults: { email: { subject: 'Your note {title}', text: '{body}', required: true, urgent: false, sensitive: false } },
			longValues: ['body'],
		});
		// the declared words and long values win over a body's own
		const own = { ...copy, body: { ...copy.body, defaults: {}, longValues: [] } };
		expect(attach('notifications', '/v1/messages/email', own).body).toEqual(
			attach('notifications', '/v1/messages/email', copy).body,
		);
		// a key made per case carries those of the message it falls back to; a message without long values names none
		const perCase = { method: 'POST', body: { template: 'notes.copy.weekly', fallbackTemplate: 'notes.copy' } };
		expect(attach('notifications', '/v1/messages/email', perCase).body).toMatchObject({ longValues: ['body'] });
		const alert = { method: 'POST', body: { template: 'notes.staff_note_created' } };
		expect(attach('notifications', '/v1/messages/email', alert).body).not.toHaveProperty('longValues');
	});

	it('a key made per case carries the defaults of the declared message it falls back to', () => {
		const { attach } = createMessages({ productId: 'notes', declaration: DECLARATION });
		const perCase = {
			method: 'POST',
			body: { template: 'notes.staff_note_created.urgent', fallbackTemplate: 'notes.staff_note_created', to: {} },
		};
		expect(attach('notifications', '/v1/messages/email', perCase)).toEqual({
			...perCase,
			body: { ...perCase.body, defaults: ALERT_DEFAULTS },
		});
		// a declared key keeps its own defaults; an undeclared fallback, or one that is not a key, adds none
		const declared = { method: 'POST', body: { template: 'notes.staff_note_created', fallbackTemplate: 'notes.code' } };
		expect(attach('notifications', '/v1/messages/email', declared).body).toMatchObject({ defaults: ALERT_DEFAULTS });
		const unknown = { method: 'POST', body: { template: 'notes.a', fallbackTemplate: 'notes.b' } };
		expect(attach('notifications', '/v1/messages/email', unknown)).toBe(unknown);
		const odd = { method: 'POST', body: { template: 'notes.a', fallbackTemplate: 42 } };
		expect(attach('notifications', '/v1/messages/email', odd)).toBe(odd);
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
