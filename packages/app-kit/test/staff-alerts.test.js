import { describe, expect, it } from 'vitest';
import { defineRoute } from '../src/index.js';
import { noopLogger } from '../src/logger.js';
import { ALERT_KEEP_MS, MAX_RECIPIENTS, RETRY_MS, alertOutcome, createStaffAlerts, recipientOf } from '../src/staff-alerts.js';
import { manifest, openDb, productRoutes, setup } from './helpers.js';

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
	defineRoute({ method: 'GET', path: '/v1/server/ping', auth: 'server', handler: () => ({ pong: true }) }),
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
					values: body.values ?? { noteId: 'not_42', preview: 'Hello' },
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
		expect(recipientOf('0092 300 1234567')).toEqual({ key: 'p:923001234567', to: { phone: '+923001234567' } });
		// the shared normaliser: a trunk 0 after the calling code is dropped, so one number has one key
		expect(recipientOf('+92 (0)300-1234567')).toEqual({ key: 'p:923001234567', to: { phone: '+923001234567' } });
		expect(recipientOf('+44 020 7946 0018')).toEqual({ key: 'p:442079460018', to: { phone: '+442079460018' } });
		expect(recipientOf('+999 1234 5678')).toBeNull();
		// Notifications sends to international numbers only: a local number is left out
		expect(recipientOf('0300-1234567')).toBeNull();
		expect(recipientOf('+0300 1234567')).toBeNull();
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
			required: true,
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

	it('save what Notifications did not take and try it again with the same key on later uses, for a day (K-17)', async () => {
		const { set, alert, notifications, handlers, connectDatabase, call, server, settle, clock, entries } = await start();
		const dbName = await connectDatabase();
		await set('recipients', ['ops@shop.example.com', '+92 300 1234567']);
		/** @type {Array<string | null>} */
		const keys = [];
		const original = /** @type {(request: Request) => Promise<Response>} */ (handlers[notifications.url]);
		handlers[notifications.url] = async (request) => {
			keys.push(request.headers.get('idempotency-key'));
			return original(request);
		};
		const use = async () => {
			await call('GET', '/v1/server/ping', { token: server.token });
			await settle();
		};
		const { client, db } = await openDb(dbName);
		const saved = db.collection('ss_notes_staff_alerts');
		try {
			notifications.setFailing(true);
			expect(await alert()).toBe(2);
			expect(await saved.countDocuments({})).toBe(2);
			expect((await saved.indexes()).map((i) => i.name)).toContain('kit_staff_alerts_expiry');
			expect(keys).toHaveLength(2);
			expect(new Set(keys).size).toBe(2);
			// not due yet; then the first retry a minute later, with the same keys
			notifications.setFailing(false);
			await use();
			expect(notifications.messages).toHaveLength(0);
			clock.advance(RETRY_MS[0] ?? 0);
			await use();
			expect(notifications.messages.map((m) => [m.channel, m.body.required])).toEqual([
				['email', true],
				['whatsapp', true],
			]);
			expect(keys.slice(2)).toEqual(keys.slice(0, 2));
			expect(keys[0]).toMatch(/^notes-sal_[0-9a-z]{26}$/);
			expect(await saved.countDocuments({})).toBe(0);

			// still not taken: 1, 5, 15, 60 minutes, then every 3 hours, given up a day after the first try
			notifications.messages.length = 0;
			notifications.setFailing(true);
			await alert();
			const tries = async () => (await saved.find({}).toArray()).map((row) => row.tries);
			for (const wait of [RETRY_MS[0], RETRY_MS[1], RETRY_MS[2], RETRY_MS[3]]) {
				clock.advance(wait ?? 0);
				await use();
			}
			expect(await tries()).toEqual([5, 5]);
			const tried = keys.length;
			// an instance looks at most once a minute
			clock.advance((RETRY_MS[4] ?? 0) - 61_000);
			await use();
			expect(keys).toHaveLength(tried);
			clock.advance(61_000);
			await use();
			expect(keys).toHaveLength(tried + 2);
			clock.advance(ALERT_KEEP_MS);
			await use();
			expect(await saved.countDocuments({})).toBe(0);
			expect(entries.filter((e) => e.msg === 'staff alert given up')).toHaveLength(2);
			expect(notifications.messages).toHaveLength(0);
		} finally {
			await client.close();
		}
	});

	it('a data-rights deletion removes the saved messages that hold the person’s details (as Ecommerce’s outbox, E63)', async () => {
		const { set, alert, notifications, connectDatabase, call, server, settle, clock, websiteId } = await start();
		const dbName = await connectDatabase();
		await set('recipients', ['ops@shop.example.com', '+92 300 1234567']);
		const { client, db } = await openDb(dbName);
		const saved = db.collection('ss_notes_staff_alerts');
		/** @param {{ email?: string, phone?: string }} user */
		const remove = async (user) => {
			const response = await call('POST', '/v1/data-rights/delete', { token: server.token, body: { user } });
			expect(response.status).toBe(200);
			return (await response.json()).deleted;
		};
		const left = async () =>
			(await saved.find({}, { sort: { 'values.noteId': 1 } }).toArray()).map((row) => [row.values.noteId, row.to]);
		try {
			notifications.setFailing(true);
			await alert({ values: { noteId: 'not_1', visitor: 'Sara@Example.com', preview: 'Hi' } });
			await alert({ values: { noteId: 'not_2', visitor: 'Omar', phone: '+92 321 7654321' } });
			await alert({ values: { noteId: 'not_3', visitor: 'Guest', preview: 'Hello' } });
			expect(await saved.countDocuments({})).toBe(6);
			// a value naming the person (an e-mail address without case, a phone in any form)
			expect(await remove({ email: 'sara@example.com' })).toBe(2);
			expect(await remove({ phone: '+923217654321' })).toBe(2);
			// messages to the person (a staff member who is a recipient)
			expect(await remove({ phone: '0092 300 1234567' })).toBe(1);
			expect(await left()).toEqual([['not_3', { email: 'ops@shop.example.com' }]]);
			// the product names the others by a value
			expect(await holder.product.staffAlerts.forget({ websiteId }, { values: { noteId: ['not_9'] } })).toBe(0);
			expect(await holder.product.staffAlerts.forget({ websiteId }, { values: { noteId: [] } })).toBe(0);
			expect(await holder.product.staffAlerts.forget({ websiteId }, { values: { noteId: ['not_3'] } })).toBe(1);
			expect(await remove({ email: 'nobody@example.com' })).toBe(0);
			// nothing left to try again
			notifications.setFailing(false);
			clock.advance(RETRY_MS[0] ?? 0);
			await call('GET', '/v1/server/ping', { token: server.token });
			await settle();
			expect(notifications.messages).toHaveLength(0);
		} finally {
			await client.close();
		}
	});

	it('are never looked for in a product without a Notifications token connection', async () => {
		let looked = 0;
		const alerts = createStaffAlerts({
			productId: 'notes',
			settings: /** @type {any} */ ({}),
			connections: /** @type {any} */ ({ definitions: { database: { kind: 'database' } } }),
			data: /** @type {any} */ ({
				forWebsite: async () => {
					looked += 1;
					throw new Error('not expected');
				},
			}),
			now: () => 0,
			logger: noopLogger,
		});
		await alerts.retry('web_0123456789abcdefghjkmnpq', null);
		expect(await alerts.forget({ websiteId: 'web_0123456789abcdefghjkmnpq' }, { addresses: ['ops@shop.example.com'] })).toBe(0);
		expect(looked).toBe(0);
	});

	it('read the answers of Notifications: taken, not connected, again or refused', () => {
		expect(alertOutcome({ ok: true, status: 202, body: {} })).toBe('sent');
		expect(alertOutcome({ ok: false, reason: 'not_connected' })).toBe('not_connected');
		expect(alertOutcome({ ok: false, reason: 'failed', status: 409, body: { type: 'x/duplicate_request' } })).toBe('sent');
		expect(alertOutcome({ ok: false, reason: 'failed', status: 409, body: { type: 'x/in_progress' } })).toBe('retry');
		for (const reason of /** @type {const} */ (['unreachable', 'unavailable', 'refused']))
			expect(alertOutcome({ ok: false, reason })).toBe('retry');
		expect(alertOutcome({ ok: false, reason: 'failed', status: 429 })).toBe('retry');
		expect(alertOutcome({ ok: false, reason: 'failed', status: 408, body: null })).toBe('retry');
		expect(alertOutcome({ ok: false, reason: 'failed', status: 422, body: { type: 'x/template_not_found' } })).toBe('failed');
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
