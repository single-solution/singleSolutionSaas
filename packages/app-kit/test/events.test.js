import { describe, expect, it } from 'vitest';
import { defineRoute } from '../src/index.js';
import { EVENT_DATA_MAX_BYTES, EVENT_TTL_MS, createEvents } from '../src/events.js';
import { openDb, productRoutes, setup } from './helpers.js';

const NOTIFICATIONS = { label: 'Notifications token', kind: 'token', productId: 'notifications', neededBy: [] };

/** @type {{ product: any }} */
const holder = { product: null };

const routes = () => [
	...productRoutes(),
	defineRoute({
		method: 'POST',
		path: '/v1/server/notes',
		auth: 'server',
		feature: 'notes',
		handler: async (ctx) => {
			const body = /** @type {any} */ (ctx.body);
			return holder.product.events.emit(ctx, body.type ?? 'note.created', body.data ?? { noteId: 'not_1' });
		},
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/events',
		auth: 'server',
		feature: 'notes',
		handler: (ctx) => holder.product.events.list(ctx),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/events/count',
		auth: 'server',
		feature: 'notes',
		handler: (ctx) => holder.product.events.count(ctx),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/events/counts',
		auth: 'server',
		feature: 'notes',
		handler: (ctx) => holder.product.events.counts(ctx),
	}),
];

/** A product that publishes events, with its database and (optionally) the Notifications token pasted. */
const start = async ({ paste = true } = {}) => {
	const ctx = await setup({ routes: routes(), events: true, connections: { notifications: NOTIFICATIONS } });
	holder.product = ctx.product;
	await ctx.switchOn(['notes']);
	const dbName = await ctx.connectDatabase();
	if (paste) {
		const cookie = await ctx.session({ kind: 'merchant' });
		const token = (await ctx.portal.issueToken({ websiteId: ctx.websiteId, productId: 'notifications', kind: 'server' })).token;
		const saved = await ctx.dash(cookie, 'PUT', `/v1/dashboard/websites/${ctx.websiteId}/connections/notifications`, {
			value: token,
		});
		expect(saved.status).toBe(200);
	}
	/** @param {unknown} [body] */
	const emit = async (body = {}) => {
		const response = await ctx.call('POST', '/v1/server/notes', { token: ctx.server.token, body });
		await ctx.settle();
		return { status: response.status, json: await response.json() };
	};
	return { ...ctx, dbName, emit };
};

describe('events (K5)', () => {
	it('are kept 30 days, forwarded through Notifications right after the request and listed newest first', async () => {
		const { emit, notifications, call, server, clock, dbName } = await start();
		const first = await emit({ type: 'note.created', data: { noteId: 'not_1' } });
		expect(first.status).toBe(200);
		expect(first.json).toMatchObject({ type: 'notes.note.created', data: { noteId: 'not_1' }, delivery: 'pending' });
		expect(notifications.events).toHaveLength(1);
		expect(notifications.events[0]).toMatchObject({
			key: first.json.id,
			body: { id: first.json.id, type: 'notes.note.created', at: first.json.at, data: { noteId: 'not_1' } },
		});
		clock.advance(60_000);
		await emit({ type: 'note.deleted', data: { noteId: 'not_1' } });
		const listed = await (await call('GET', '/v1/events', { token: server.token })).json();
		expect(listed.items.map((/** @type {any} */ e) => [e.type, e.delivery])).toEqual([
			['notes.note.deleted', 'sent'],
			['notes.note.created', 'sent'],
		]);
		const since = await (
			await call('GET', `/v1/events?since=${encodeURIComponent(first.json.at)}`, { token: server.token })
		).json();
		expect(since.items.map((/** @type {any} */ e) => e.type)).toEqual(['notes.note.deleted']);
		const typed = await (await call('GET', '/v1/events?types=notes.note.created', { token: server.token })).json();
		expect(typed.items).toHaveLength(1);
		const both = await (
			await call('GET', '/v1/events?types=notes.note.created,notes.note.deleted&limit=1', { token: server.token })
		).json();
		expect(both.hasMore).toBe(true);
		const next = await (await call('GET', `/v1/events?limit=1&cursor=${both.nextCursor}`, { token: server.token })).json();
		expect(next.items.map((/** @type {any} */ e) => e.type)).toEqual(['notes.note.created']);
		for (const query of ['since=yesterday', 'types=payments.payment.paid', 'types=notes.BAD'])
			expect((await call('GET', `/v1/events?${query}`, { token: server.token })).status).toBe(422);
		expect(await (await call('GET', '/v1/events/count', { token: server.token })).json()).toEqual({ count: 2, capped: false });
		expect((await (await call('GET', '/v1/events/counts?by=type', { token: server.token })).json()).groups).toEqual({
			'notes.note.created': 1,
			'notes.note.deleted': 1,
		});
		const { client, db } = await openDb(dbName);
		const stored = await db.collection('ss_notes_events').findOne({ id: first.json.id });
		expect(stored?.expiresAt.getTime() - stored?.at.getTime()).toBe(EVENT_TTL_MS);
		expect(
			(await db.collection('ss_notes_events').indexes()).find((index) => index.name === 'kit_events_expiry'),
		).toMatchObject({
			expireAfterSeconds: 0,
		});
		await client.close();
	});

	it('stay readable without the Notifications token and are retried on later requests when it fails', async () => {
		const quiet = await start({ paste: false });
		await quiet.emit();
		expect(quiet.notifications.events).toHaveLength(0);
		const listed = await (await quiet.call('GET', '/v1/events', { token: quiet.server.token })).json();
		expect(listed.items[0].delivery).toBe('not_connected');

		const { emit, notifications, call, server, clock, settle, dbName } = await start();
		notifications.setFailing(true);
		const event = await emit();
		const { client, db } = await openDb(dbName);
		const events = db.collection('ss_notes_events');
		expect(await events.findOne({ id: event.json.id })).toMatchObject({ delivery: 'pending', attempts: 1 });
		// not due again for a minute
		await call('GET', '/v1/events', { token: server.token });
		await settle();
		expect(notifications.events).toHaveLength(0);
		for (const wait of [60_000, 5 * 60_000, 30 * 60_000]) {
			clock.advance(wait);
			await call('GET', '/v1/events', { token: server.token });
			await settle();
		}
		expect(await events.findOne({ id: event.json.id })).toMatchObject({ delivery: 'pending', attempts: 4 });
		clock.advance(2 * 3_600_000);
		await call('GET', '/v1/events', { token: server.token });
		await settle();
		expect(await events.findOne({ id: event.json.id })).toMatchObject({ delivery: 'failed', attempts: 5 });
		notifications.setFailing(false);
		await emit();
		expect(notifications.events).toHaveLength(1);
		await client.close();
	});

	it('count a repeated forward (Notifications already has it) as sent, and try one still running again (K-14)', async () => {
		/** @param {string} code the problem of Notifications' 409 answer */
		const forward = async (code) => {
			/** @type {Record<string, any>} */
			let stored = {};
			const collection = {
				insertOne: async (/** @type {any} */ doc) => {
					stored = { ...doc };
				},
				findOneAndUpdate: async () => (stored.delivery === 'pending' && stored.dueAt.getTime() <= 0 ? { ...stored } : null),
				updateOne: async (/** @type {any} */ _filter, /** @type {any} */ update) => {
					stored = { ...stored, ...update.$set };
				},
				countDocuments: async () => (stored.delivery === 'pending' ? 1 : 0),
			};
			/** @type {Array<() => Promise<unknown>>} */
			const after = [];
			const events = createEvents({
				productId: 'notes',
				enabled: true,
				data: /** @type {any} */ ({ forWebsite: async () => ({ collection: () => collection }) }),
				connections: /** @type {any} */ ({
					callProduct: async () => ({
						ok: false,
						reason: 'failed',
						status: 409,
						body: { type: `https://notifications.example.dev/problems/${code}` },
					}),
				}),
				now: () => 0,
				logger: /** @type {any} */ ({ info: () => {} }),
			});
			await events.emit({ websiteId: 'web_1', merchantId: null, after: (task) => void after.push(task) }, 'note.created', {});
			for (const task of after) await task();
			return stored;
		};
		expect(await forward('duplicate_request')).toMatchObject({ delivery: 'sent', attempts: 1 });
		// the earlier forward is still running and may yet fail: tried again a minute later
		expect(await forward('in_progress')).toMatchObject({ delivery: 'pending', attempts: 1, dueAt: new Date(60_000) });
		// a 409 that does not say the forward got through is not taken as delivered
		expect(await forward('conflict')).toMatchObject({ delivery: 'pending', attempts: 1 });
	});

	it('settings.changed tells the merchant’s server about settings, texts, theme and Format changes (SG-14)', async () => {
		const { call, server, session, dash, websiteId, settle, notifications } = await start();
		expect((await call('PUT', '/v1/settings/notes.maxNotes', { token: server.token, body: { value: 9 } })).status).toBe(200);
		expect((await call('PUT', '/v1/theme', { token: server.token, body: { radius: 12 } })).status).toBe(200);
		expect((await call('PUT', '/v1/theme', { token: server.token, body: { radius: 99 } })).status).toBe(422);
		const cookie = await session({ kind: 'merchant' });
		const site = `/v1/dashboard/websites/${websiteId}`;
		expect((await dash(cookie, 'PUT', `${site}/texts/form.title`, { value: 'Écrivez-nous' })).status).toBe(204);
		expect((await dash(cookie, 'PUT', `${site}/format`, { wholeUnits: true })).status).toBe(200);
		expect((await dash(cookie, 'PUT', `${site}/settings/notes.maxNotes`, { value: 7 })).status).toBe(204);
		await settle();
		const listed = await call('GET', '/v1/events?types=notes.settings.changed', { token: server.token });
		const changes = (await listed.json()).items.map((/** @type {any} */ e) => JSON.stringify(e.data)).sort();
		expect(changes).toEqual(
			[
				{ what: 'settings', key: 'notes.maxNotes' },
				{ what: 'settings', key: 'notes.maxNotes' },
				{ what: 'theme' },
				{ what: 'texts', key: 'form.title' },
				{ what: 'format' },
			]
				.map((change) => JSON.stringify(change))
				.sort(),
		);
		expect(notifications.events.filter((e) => e.body.type === 'notes.settings.changed')).toHaveLength(5);
		// without the merchant database the change is saved all the same (no event)
		const bare = await setup({ events: true });
		await bare.switchOn(['notes']);
		expect(
			(await bare.call('PUT', '/v1/settings/notes.maxNotes', { token: bare.server.token, body: { value: 3 } })).status,
		).toBe(200);
	});

	it('check their type and size, and exist only for products that publish them', async () => {
		const { emit, product, websiteId } = await start();
		expect((await emit({ type: 'Bad' })).status).toBe(500);
		expect((await emit({ data: { big: 'x'.repeat(EVENT_DATA_MAX_BYTES) } })).status).toBe(500);
		expect((await emit({ data: [] })).status).toBe(500);
		const quiet = await setup();
		await expect(
			quiet.product.events.emit({ websiteId: quiet.websiteId, merchantId: null, after: () => {} }, 'note.created', {}),
		).rejects.toMatchObject({ code: 'invalid_config' });
		await expect(
			product.events.emit({ websiteId, merchantId: null, after: () => {} }, 'note.created', {}),
		).resolves.toMatchObject({ type: 'notes.note.created' });
	});
});
