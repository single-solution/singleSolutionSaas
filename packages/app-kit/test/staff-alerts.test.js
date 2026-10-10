import { describe, expect, it } from 'vitest';
import { defineRoute } from '../src/index.js';
import { MAX_RECIPIENTS, recipientOf } from '../src/staff-alerts.js';
import { manifest, productRoutes, setup } from './helpers.js';

/** The sample product with a staff-alerts feature (its settings as K6 names them). */
const alertsManifest = () => {
	const base = manifest();
	return {
		...base,
		features: [
			...base.features,
			{
				key: 'alerts',
				name: 'Staff alerts',
				description: 'Tell the staff about new notes.',
				dependsOn: ['notes'],
				settings: {
					type: 'object',
					additionalProperties: false,
					properties: {
						recipients: { type: 'array', title: 'Recipients', default: [], items: { type: 'string', maxLength: 320 } },
						staffPermission: { type: 'string', title: 'Staff with this permission', default: '', maxLength: 64 },
						phoneChannel: { type: 'string', title: 'Phones get', default: 'whatsapp', enum: ['whatsapp', 'sms'] },
						adminUrl: { type: 'string', title: 'Admin link', default: '', maxLength: 500 },
					},
				},
			},
		],
	};
};

/** @type {{ product: any }} */
const holder = { product: null };

const routes = () => [
	...productRoutes(),
	defineRoute({
		method: 'POST',
		path: '/v1/server/alert',
		auth: 'server',
		feature: 'notes',
		database: false,
		handler: async (ctx) => {
			const body = /** @type {any} */ (ctx.body);
			return {
				queued: await holder.product.staffAlerts.send(ctx, {
					feature: 'alerts',
					event: body.event ?? 'note_created',
					values: { noteId: 'not_42', preview: 'Hello' },
					assignee: body.assignee ?? null,
				}),
			};
		},
	}),
];

const start = async () => {
	const ctx = await setup({
		manifest: alertsManifest(),
		routes: routes(),
		connections: {
			notifications: { label: 'Notifications token', kind: 'token', productId: 'notifications', neededBy: [] },
			accounts: { label: 'Accounts token', kind: 'token', productId: 'accounts', neededBy: [] },
		},
	});
	holder.product = ctx.product;
	await ctx.switchOn(['notes', 'alerts']);
	const cookie = await ctx.session({ kind: 'merchant' });
	for (const productId of ['notifications', 'accounts']) {
		const token = (await ctx.portal.issueToken({ websiteId: ctx.websiteId, productId, kind: 'server' })).token;
		expect(
			(await ctx.dash(cookie, 'PUT', `/v1/dashboard/websites/${ctx.websiteId}/connections/${productId}`, { value: token }))
				.status,
		).toBe(200);
	}
	/** @param {string} key @param {unknown} value */
	const set = async (key, value) =>
		expect(
			(await ctx.dash(cookie, 'PUT', `/v1/dashboard/websites/${ctx.websiteId}/settings/alerts.${key}`, { value })).status,
		).toBe(204);
	/** @param {unknown} [body] */
	const alert = async (body = {}) => {
		const response = await ctx.call('POST', '/v1/server/alert', { token: ctx.server.token, body });
		await ctx.settle();
		return (await response.json()).queued;
	};
	return { ...ctx, set, alert };
};

describe('staff alerts (K6)', () => {
	it('reads addresses as e-mail or phone recipients', () => {
		expect(recipientOf(' Ops@Shop.Example.com ')).toEqual({
			key: 'e:ops@shop.example.com',
			to: { email: 'ops@shop.example.com' },
		});
		expect(recipientOf('+92 300 1234567')).toEqual({ key: 'p:923001234567', to: { phone: '+923001234567' } });
		expect(recipientOf('0300-1234567')).toEqual({ key: 'p:03001234567', to: { phone: '03001234567' } });
		expect(recipientOf('nope')).toBeNull();
		expect(recipientOf('12-3')).toBeNull();
		expect(recipientOf(7)).toBeNull();
	});

	it('go to the recipients, the staff with the permission and the assignee, once per address', async () => {
		const { set, alert, notifications, accounts, clock } = await start();
		expect(await alert()).toBe(0);
		await set('recipients', ['ops@shop.example.com', '+92 300 1234567', 'OPS@shop.example.com', 'not an address']);
		await set('adminUrl', 'https://admin.shop.example.com/notes/{noteId}');
		accounts.setUsers([
			{ id: 'u1', email: 'sana@shop.example.com', permissions: ['notes:notes.read'] },
			{ id: 'u2', phone: '+92 321 7654321', permissions: ['notes:notes.read'] },
			{ id: 'u3', email: 'blocked@shop.example.com', blocked: true, permissions: ['notes:notes.read'] },
			{ id: 'u4', email: 'owner@shop.example.com', permissions: ['*'] },
			{ id: 'u5', email: 'other@shop.example.com', permissions: ['notes:other'] },
		]);
		await set('staffPermission', 'notes.read');
		expect(await alert({ assignee: { email: 'sana@shop.example.com', phone: '+92 333 0000000' } })).toBe(6);
		expect(notifications.messages.map((m) => [m.channel, m.body.to])).toEqual([
			['email', { email: 'ops@shop.example.com' }],
			['whatsapp', { phone: '+923001234567' }],
			['email', { email: 'sana@shop.example.com' }],
			['whatsapp', { phone: '+923217654321' }],
			['email', { email: 'owner@shop.example.com' }],
			['whatsapp', { phone: '+923330000000' }],
		]);
		expect(notifications.messages[0]?.body).toEqual({
			template: 'notes.staff_note_created',
			to: { email: 'ops@shop.example.com' },
			values: { noteId: 'not_42', preview: 'Hello', link: 'https://admin.shop.example.com/notes/not_42' },
		});
		expect(accounts.userReads).toEqual(['notes:notes.read']);
		// cached for 5 minutes; then asked again
		await set('phoneChannel', 'sms');
		notifications.messages.length = 0;
		await alert();
		expect(accounts.userReads).toHaveLength(1);
		expect(notifications.messages.filter((m) => m.channel === 'sms')).toHaveLength(2);
		clock.advance(5 * 60_000);
		accounts.setFailing(true);
		await alert();
		expect(accounts.userReads).toHaveLength(1);
		accounts.setFailing(false);
		await alert();
		expect(accounts.userReads).toHaveLength(2);
		expect(await alert({ event: 'Bad-Event' })).toBe(0);
	});

	it('keep working without Accounts and log what Notifications refuses', async () => {
		const { set, alert, notifications, accounts } = await start();
		await set(
			'recipients',
			Array.from({ length: MAX_RECIPIENTS + 5 }, (_, i) => `s${i}@shop.example.com`),
		);
		await set('staffPermission', 'notes.read');
		accounts.setFailing(true);
		notifications.setFailing(true);
		expect(await alert()).toBe(MAX_RECIPIENTS);
		expect(notifications.messages).toHaveLength(0);
	});
});
