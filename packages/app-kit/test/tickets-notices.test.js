import { describe, expect, it } from 'vitest';
import { openDb, setup } from './helpers.js';

const ADMIN = 'https://admin.shop.example.com';
const USER = { id: 'u1', name: 'Sam Staff', email: 'sam@shop.example.com' };

describe('tickets', () => {
	it('are issued with the server token for permissions of switched-on features only', async () => {
		const { call, server, switchOn } = await setup();
		const ask = (/** @type {unknown} */ body) => call('POST', '/v1/tickets', { token: server.token, body });
		const off = await ask({ user: USER, permissions: ['notes.read'], origin: ADMIN });
		expect(off.status).toBe(200);
		expect(await off.json()).toMatchObject({ ticket: expect.any(String), expiresAt: '2026-10-01T10:15:00.000Z' });
		await switchOn(['notes', 'inbox']);
		const issued = await (await ask({ user: USER, permissions: ['notes.read', 'notes.read'], origin: ADMIN })).json();
		const inbox = await call('GET', '/v1/inbox', { token: issued.ticket, origin: ADMIN });
		expect(inbox.status).toBe(403); // database not connected yet
		for (const body of [
			{ user: USER, permissions: ['notes.read'], origin: 'http://admin.shop.example.com' },
			{ user: USER, permissions: ['unknown'], origin: ADMIN },
			{ user: { id: 'u1' }, permissions: [], origin: ADMIN },
			'"nope"',
		]) {
			expect((await ask(body)).status).toBe(422);
		}
		expect(
			(
				await call('POST', '/v1/tickets', {
					token: server.token,
					origin: ADMIN,
					body: { user: USER, permissions: [], origin: ADMIN },
				})
			).status,
		).toBe(401);
	});

	it('work only from their origin, with the permission, until the server token is revoked', async () => {
		const { call, server, switchOn, connectDatabase, settle, portal, clock } = await setup();
		await switchOn(['notes', 'inbox']);
		const dbName = await connectDatabase();
		const { ticket } = await (
			await call('POST', '/v1/tickets', {
				token: server.token,
				body: { user: USER, permissions: ['notes.read'], origin: ADMIN },
			})
		).json();
		const ok = await call('GET', '/v1/inbox', { token: ticket, origin: ADMIN });
		expect(ok.status).toBe(200);
		expect(ok.headers.get('access-control-allow-origin')).toBe(ADMIN);
		expect(await ok.json()).toEqual({ user: USER });
		await settle();
		const { client, db } = await openDb(dbName);
		expect(await db.collection('ss_notes_staff').findOne({ id: 'u1' })).toMatchObject({ name: 'Sam Staff', email: USER.email });
		await client.close();
		expect((await call('GET', '/v1/inbox', { token: ticket, origin: 'https://other.example.com' })).status).toBe(401);
		expect((await call('GET', '/v1/inbox', { token: ticket })).status).toBe(401);
		// a ticket never yields another ticket
		expect(
			(await call('POST', '/v1/tickets', { token: ticket, body: { user: USER, permissions: [], origin: ADMIN } })).status,
		).toBe(401);
		const bare = await (
			await call('POST', '/v1/tickets', { token: server.token, body: { user: USER, permissions: [], origin: ADMIN } })
		).json();
		expect((await call('GET', '/v1/inbox', { token: bare.ticket, origin: ADMIN })).status).toBe(403);
		portal.revoke(server.jti);
		clock.advance(5 * 60_000);
		expect((await call('GET', '/v1/inbox', { token: ticket, origin: ADMIN })).status).toBe(401);
	});

	it('are refused while the product is stopped', async () => {
		const { call, server, portal, websiteId } = await setup();
		portal.setStatus(websiteId, { status: 'stopped' });
		const response = await call('POST', '/v1/tickets', {
			token: server.token,
			body: { user: USER, permissions: [], origin: ADMIN },
		});
		expect(response.status).toBe(403);
	});
});

describe('notices', () => {
	it('status.changed refetches the status at once', async () => {
		const { call, server, portal, websiteId } = await setup();
		expect((await call('GET', '/v1/server/open', { token: server.token })).status).toBe(200);
		portal.setStatus(websiteId, { status: 'suspended' });
		expect((await call('GET', '/v1/server/open', { token: server.token })).status).toBe(200);
		expect((await portal.sendNotice('notes', { type: 'status.changed', websiteId })).status).toBe(204);
		expect((await call('GET', '/v1/server/open', { token: server.token })).status).toBe(403);
		// the stale copy is kept for offline grace
		portal.setReachable(false);
		await portal.sendNotice('notes', { type: 'status.changed', websiteId });
		expect((await call('GET', '/v1/server/open', { token: server.token })).status).toBe(403);
	});

	it('status.changed fetches the status right after answering; removed turns the switches off for a re-add', async () => {
		const { call, server, portal, websiteId, switchOn, settle, product, store, clock } = await setup();
		await switchOn(['notes']);
		expect((await call('GET', '/v1/server/notes', { token: server.token })).status).toBe(200);
		const fetched = portal.calls.filter((c) => c.path.endsWith('/status')).length;
		portal.setStatus(websiteId, { status: 'removed' });
		expect((await portal.sendNotice('notes', { type: 'status.changed', websiteId })).status).toBe(204);
		await settle();
		expect(portal.calls.filter((c) => c.path.endsWith('/status')).length).toBe(fetched + 1);
		expect(await product.featuresOn(websiteId)).toEqual([]);
		expect(await store.get('switches', websiteId)).toMatchObject({ on: [], featuresVersion: 1 });
		// added again: every feature is off until an admin switches it on
		portal.setStatus(websiteId, { status: 'active' });
		clock.advance(1000); // the same notice in the same second is a replay
		expect((await portal.sendNotice('notes', { type: 'status.changed', websiteId })).status).toBe(204);
		await settle();
		expect((await call('GET', '/v1/server/notes', { token: server.token })).status).toBe(403);
		await switchOn(['notes']);
		expect((await call('GET', '/v1/server/notes', { token: server.token })).status).toBe(200);
	});

	it('token.revoked refetches the revocation list', async () => {
		const { call, server, portal, clock } = await setup();
		expect((await call('GET', '/v1/server/open', { token: server.token })).status).toBe(200);
		portal.revoke(server.jti);
		expect((await portal.sendNotice('notes', { type: 'token.revoked', websiteId: 'web_x' })).status).toBe(204);
		expect((await call('GET', '/v1/server/open', { token: server.token })).status).toBe(401);
		portal.setReachable(false);
		clock.advance(1000);
		expect((await portal.sendNotice('notes', { type: 'token.revoked', websiteId: 'web_x' })).status).toBe(503);
	});

	it('sessions.revoked ends the person’s dashboard sessions', async () => {
		const { portal, session, dash } = await setup();
		const cookie = await session({ kind: 'admin' });
		expect((await dash(cookie, 'GET', '/v1/dashboard/session')).status).toBe(200);
		await portal.sendNotice('notes', { type: 'sessions.revoked', subject: 'adm_0123456789abcdefghjkmnpq' });
		expect((await dash(cookie, 'GET', '/v1/dashboard/session')).status).toBe(401);
	});

	it('website.deleted deletes what the product database holds for the website', async () => {
		const { portal, websiteId, session, dash, switchOn, store, call, server } = await setup();
		await switchOn(['notes']);
		const merchant = await session({ kind: 'merchant' });
		await dash(merchant, 'PUT', `/v1/dashboard/websites/${websiteId}/texts/form.title`, { value: 'Schreib uns' });
		await call('GET', '/v1/server/open', { token: server.token });
		expect(await store.get('switches', websiteId)).not.toBeNull();
		expect((await portal.sendNotice('notes', { type: 'website.deleted', websiteId })).status).toBe(204);
		for (const collection of ['switches', 'settings', 'changes', 'status'])
			expect(await store.list(collection, { websiteId })).toEqual([]);
		expect((await dash(merchant, 'GET', '/v1/dashboard/session')).status).toBe(401);
	});

	it('refuses unsigned and replayed notices', async () => {
		const { call, portal, websiteId, handler } = await setup();
		expect((await call('POST', '/.well-known/ss-events', { body: { type: 'status.changed', websiteId } })).status).toBe(401);
		const signed = await portal.signNotice({ type: 'status.changed', websiteId });
		const send = () =>
			handler(
				new Request('https://notes.example.dev/.well-known/ss-events', {
					method: 'POST',
					headers: signed.headers,
					body: signed.body,
				}),
			);
		expect((await send()).status).toBe(204);
		expect((await send()).status).toBe(401);
	});
});
