import { describe, expect, it } from 'vitest';
import { SERVER_VISITOR_LIMIT } from '../src/http/handler.js';
import { actorOf, defineRoute } from '../src/index.js';
import { DOMAIN, openDb, productRoutes, setup } from './helpers.js';

const SITE = `https://${DOMAIN}`;
const SERVER = { kind: 'server', id: 'server', name: 'Server' };

/** @type {{ product: any }} */
const holder = { product: null };

/** Routes that show what the kit put on the request. */
const routes = () => [
	...productRoutes(),
	defineRoute({
		method: 'POST',
		path: '/v1/server/actions',
		auth: 'server',
		permission: 'notes.read',
		handler: async (ctx) => {
			const actor = actorOf(ctx, SERVER);
			await holder.product.activity.record(ctx, { actor, action: 'note.moved', target: 'not_1', label: 'Note 1' });
			return { actor };
		},
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/visitor/whoami',
		auth: 'browser',
		feature: 'notes',
		database: false,
		rateLimit: [
			{ limit: 2, windowSeconds: 60, per: 'website' },
			{ limit: 3, windowSeconds: 60, per: 'visitor' },
		],
		handler: (ctx) => ({ kind: ctx.token.kind, visitor: ctx.visitor, clientIp: ctx.clientIp }),
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/visitor/whoami',
		auth: 'browser',
		feature: 'notes',
		database: false,
		handler: (ctx) => ({ visitor: ctx.visitor, actor: ctx.actor }),
	}),
];

describe('the acting user is the staff member of a verified sign-in (K2)', () => {
	it('names who acts: the ticket user first, then the verified staff member, then the fallback', () => {
		const ticket = { user: { id: 'staff_1', name: 'Tia', email: 'tia@shop.example.com' } };
		expect(actorOf({ ticket }, SERVER)).toEqual({ kind: 'staff', id: 'staff_1', name: 'Tia', email: 'tia@shop.example.com' });
		expect(actorOf({ ticket: { user: { id: 's', name: 'S' } } }, SERVER)).toEqual({ kind: 'staff', id: 's', name: 'S' });
		const actor = /** @type {const} */ ({ kind: 'user', id: 'u1', name: 'Sam', role: 'Owner' });
		expect(actorOf({ ticket: null, actor }, SERVER)).toBe(actor);
		expect(actorOf({}, SERVER)).toBe(SERVER);
	});

	it('reaches the product from the sign-in only and records the staff member', async () => {
		const ctx = await setup({ routes: routes() });
		holder.product = ctx.product;
		const { call, server, settle, connectDatabase, websiteId, switchOn } = ctx;
		await switchOn(['notes', 'inbox']);
		const dbName = await connectDatabase();
		const named = await call('POST', '/v1/server/actions', {
			token: server.token,
			staff: { id: 'usr_7', name: 'Alex M.', role: 'Owner', email: 'alex@shop.example.com' },
		});
		expect(named.status).toBe(200);
		expect((await named.json()).actor).toEqual({
			kind: 'user',
			id: 'usr_7',
			name: 'Alex M.',
			role: 'Owner',
			email: 'alex@shop.example.com',
		});
		await settle();
		// actor headers are never taken as a person: not alone, and not next to a sign-in of someone else
		const forged = await call('POST', '/v1/server/actions', {
			token: server.token,
			bare: true,
			headers: { 'ss-actor-id': 'usr_7', 'ss-actor-name': 'Alex%20M.', 'ss-actor-role': 'Owner' },
		});
		expect(forged.status).toBe(403);
		expect(await forged.json()).toMatchObject({ type: 'https://notes.example.dev/problems/needs_signed_in_staff' });
		const signIn = await ctx.accounts.signIn({
			websiteId,
			sub: 'usr_real',
			name: 'Real Rita',
			role: 'owner',
			permissions: ['*'],
		});
		const next = await call('POST', '/v1/server/actions', {
			token: server.token,
			bare: true,
			headers: { 'ss-sign-in': signIn, 'ss-actor-id': 'usr_boss', 'ss-actor-name': 'The%20Boss', 'ss-actor-role': 'Owner' },
		});
		expect(next.status).toBe(200);
		expect((await next.json()).actor).toMatchObject({ kind: 'user', id: 'usr_real', name: 'Real Rita' });
		// a malformed set of actor headers is no longer a thing: they are ignored
		const malformed = await call('POST', '/v1/server/actions', {
			token: server.token,
			bare: true,
			headers: { 'ss-sign-in': signIn, 'ss-actor-id': 'usr_7' },
		});
		expect(malformed.status).toBe(200);
		await settle();
		const { client, db } = await openDb(dbName);
		expect(
			await db.collection('ss_notes_staff').findOne({ id: 'usr_7' }, { projection: { _id: 0, lastSeenAt: 0 } }),
		).toMatchObject({
			websiteId,
			id: 'usr_7',
			name: 'Alex M.',
			role: 'Owner',
			email: 'alex@shop.example.com',
		});
		expect(await db.collection('ss_notes_staff').countDocuments({ id: 'usr_boss' })).toBe(0);
		const entries = await db.collection('ss_notes_activity').find({}).sort({ at: 1 }).toArray();
		expect(entries.map((entry) => entry.actor)).toEqual([
			{ kind: 'user', id: 'usr_7', name: 'Alex M.', role: 'Owner' },
			{ kind: 'user', id: 'usr_real', name: 'Real Rita', role: 'owner' },
			{ kind: 'user', id: 'usr_real', name: 'Real Rita', role: 'owner' },
		]);
		expect(entries[0]).toMatchObject({ label: 'Note 1', action: 'note.moved' });
		await client.close();
	});

	it('records the staff member of a route without the database only once one is connected', async () => {
		const ctx = await setup();
		const { call, server, settle, connectDatabase, switchOn } = ctx;
		await switchOn(['notes', 'inbox']);
		const staff = { id: 'usr_8', name: 'Noor' };
		expect((await call('GET', '/v1/inbox/open', { token: server.token, staff })).status).toBe(200);
		await settle();
		const dbName = await connectDatabase();
		expect((await call('GET', '/v1/inbox/open', { token: server.token, staff })).status).toBe(200);
		await settle();
		const { client, db } = await openDb(dbName);
		expect(await db.collection('ss_notes_staff').countDocuments({ id: 'usr_8', name: 'Noor' })).toBe(1);
		await client.close();
	});
});

describe('visitor calls from the merchant’s server (K3)', () => {
	it('take the server token without an Origin and answer as for the visitor', async () => {
		const { call, server, browser, switchOn, store, websiteId, settle } = await setup({ routes: routes() });
		await switchOn(['notes']);
		const fromServer = await call('GET', '/v1/visitor/whoami', {
			token: server.token,
			headers: { 'ss-visitor-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1' },
		});
		expect(fromServer.status).toBe(200);
		expect(fromServer.headers.get('access-control-allow-origin')).toBeNull();
		expect(await fromServer.json()).toEqual({
			kind: 'server',
			visitor: { server: true, ip: '203.0.113.9' },
			clientIp: '203.0.113.9',
		});
		const noIp = await call('GET', '/v1/visitor/whoami', { token: server.token, headers: { 'ss-visitor-ip': 'nope' } });
		expect(await noIp.json()).toEqual({ kind: 'server', visitor: { server: true, ip: null }, clientIp: 'unknown' });
		// a browser cannot claim to be a visitor of the server
		const fromBrowser = await call('GET', '/v1/visitor/whoami', {
			token: browser.token,
			origin: SITE,
			headers: { 'ss-visitor-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1' },
		});
		expect(await fromBrowser.json()).toEqual({
			kind: 'browser',
			visitor: { server: false, ip: null },
			clientIp: '198.51.100.1',
		});
		// still refused: a server token with an Origin, a browser token without one
		expect((await call('GET', '/v1/visitor/whoami', { token: server.token, origin: SITE })).status).toBe(401);
		expect((await call('GET', '/v1/visitor/whoami', { token: browser.token })).status).toBe(401);
		// never counts as the widget installed
		await settle();
		expect(await store.get('widget', websiteId)).toMatchObject({ websiteId });
		await store.delete('widget', websiteId);
		await call('GET', '/v1/visitor/whoami', { token: server.token, headers: { 'ss-visitor-ip': '203.0.113.9' } });
		await settle();
		expect(await store.get('widget', websiteId)).toBeNull();
	});

	it("need the visitor's IP on writes and never take actor headers", async () => {
		const { call, server, switchOn } = await setup({ routes: routes() });
		await switchOn(['notes']);
		const missing = await call('POST', '/v1/visitor/whoami', { token: server.token, body: {} });
		expect(missing.status).toBe(400);
		expect(await missing.json()).toMatchObject({ type: 'https://notes.example.dev/problems/visitor_ip_required' });
		const named = await call('POST', '/v1/visitor/whoami', {
			token: server.token,
			body: {},
			headers: { 'ss-visitor-ip': '2001:db8::1', 'ss-actor-id': 'u1', 'ss-actor-name': 'Sam' },
		});
		expect(named.status).toBe(200);
		// a visitor call has no staff member: the actor headers are ignored
		expect(await named.json()).toEqual({ visitor: { server: true, ip: '2001:db8::1' }, actor: null });
	});

	it('count in their own window per route per website, plus the per-visitor limits', async () => {
		const { call, server, browser, switchOn, store, websiteId, clock } = await setup({ routes: routes() });
		await switchOn(['notes']);
		const visit = (/** @type {string} */ ip) =>
			call('GET', '/v1/visitor/whoami', { token: server.token, headers: { 'ss-visitor-ip': ip } });
		// the browser window is 2 per website: the server's calls do not count in it, nor it in theirs
		for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4']) expect((await visit(ip)).status).toBe(200);
		expect((await call('GET', '/v1/visitor/whoami', { token: browser.token, origin: SITE })).status).toBe(200);
		expect((await call('GET', '/v1/visitor/whoami', { token: browser.token, origin: SITE })).status).toBe(200);
		expect((await call('GET', '/v1/visitor/whoami', { token: browser.token, origin: SITE })).status).toBe(429);
		expect((await visit('203.0.113.5')).status).toBe(200);
		// per visitor: 3 a minute by the visitor's address (the first call of .1 was counted above)
		expect((await visit('203.0.113.1')).status).toBe(200);
		expect((await visit('203.0.113.1')).status).toBe(200);
		expect((await visit('203.0.113.1')).status).toBe(429);
		// without an address only the server window counts
		for (let i = 0; i < 4; i += 1) expect((await call('GET', '/v1/visitor/whoami', { token: server.token })).status).toBe(200);
		// the server window: 3,000 a minute per route per website
		expect(SERVER_VISITOR_LIMIT).toEqual({ limit: 3000, windowSeconds: 60 });
		const windowMs = SERVER_VISITOR_LIMIT.windowSeconds * 1000;
		for (let i = 0; i < SERVER_VISITOR_LIMIT.limit; i += 1)
			await store.hit(`server|GET /v1/visitor/whoami|website|w:${websiteId}`, windowMs, clock.now());
		const limited = await visit('203.0.113.6');
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
		// another route has its own window
		expect(
			(
				await call('POST', '/v1/visitor/whoami', {
					token: server.token,
					body: {},
					headers: { 'ss-visitor-ip': '203.0.113.6' },
				})
			).status,
		).toBe(200);
	});
});
