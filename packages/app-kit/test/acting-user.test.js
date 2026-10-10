import { describe, expect, it } from 'vitest';
import { SERVER_VISITOR_LIMIT } from '../src/http/handler.js';
import { ACTOR_HEADERS, actorOf, defineRoute, parseActor } from '../src/index.js';
import { DOMAIN, openDb, productRoutes, setup } from './helpers.js';

const SITE = `https://${DOMAIN}`;
const SERVER = { kind: 'server', id: 'server', name: 'Server' };

/** @param {Record<string, string>} values */
const headers = (values) => new Headers(values);

/** @type {{ product: any }} */
const holder = { product: null };

/** Routes that show what the kit put on the request. */
const routes = () => [
	...productRoutes(),
	defineRoute({
		method: 'POST',
		path: '/v1/server/actions',
		auth: 'server',
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

describe('acting user headers (K2)', () => {
	it('are parsed, decoded and checked', () => {
		expect(parseActor(headers({}))).toEqual({ ok: true, actor: null });
		expect(
			parseActor(
				headers({
					[ACTOR_HEADERS.id]: 'usr_01:ayesha@shop',
					[ACTOR_HEADERS.name]: encodeURIComponent('Ayesha Khān'),
					[ACTOR_HEADERS.role]: encodeURIComponent('Support staff'),
					[ACTOR_HEADERS.email]: 'Ayesha@Shop.Example.com',
				}),
			),
		).toEqual({
			ok: true,
			actor: {
				kind: 'user',
				id: 'usr_01:ayesha@shop',
				name: 'Ayesha Khān',
				role: 'Support staff',
				email: 'ayesha@shop.example.com',
			},
		});
		expect(parseActor(headers({ [ACTOR_HEADERS.id]: 'u1', [ACTOR_HEADERS.name]: 'Sam' }))).toEqual({
			ok: true,
			actor: { kind: 'user', id: 'u1', name: 'Sam' },
		});
		for (const bad of /** @type {Array<Record<string, string>>} */ ([
			{ [ACTOR_HEADERS.id]: 'u1' },
			{ [ACTOR_HEADERS.name]: 'Sam' },
			{ [ACTOR_HEADERS.role]: 'Owner' },
			{ [ACTOR_HEADERS.id]: 'has space', [ACTOR_HEADERS.name]: 'Sam' },
			{ [ACTOR_HEADERS.id]: 'x'.repeat(65), [ACTOR_HEADERS.name]: 'Sam' },
			{ [ACTOR_HEADERS.id]: 'u1', [ACTOR_HEADERS.name]: '%E0%A4%A' },
			{ [ACTOR_HEADERS.id]: 'u1', [ACTOR_HEADERS.name]: encodeURIComponent('a'.repeat(121)) },
			{ [ACTOR_HEADERS.id]: 'u1', [ACTOR_HEADERS.name]: '%0Aevil' },
			{ [ACTOR_HEADERS.id]: 'u1', [ACTOR_HEADERS.name]: '%20' },
			{ [ACTOR_HEADERS.id]: 'u1', [ACTOR_HEADERS.name]: 'Sam', [ACTOR_HEADERS.role]: encodeURIComponent('r'.repeat(41)) },
			{ [ACTOR_HEADERS.id]: 'u1', [ACTOR_HEADERS.name]: 'Sam', [ACTOR_HEADERS.email]: 'not-an-email' },
		]))
			expect(parseActor(headers(bad)).ok).toBe(false);
	});

	it('name who acts: the ticket user first, then the headers, then the fallback', () => {
		const ticket = { user: { id: 'staff_1', name: 'Tia', email: 'tia@shop.example.com' } };
		expect(actorOf({ ticket }, SERVER)).toEqual({ kind: 'staff', id: 'staff_1', name: 'Tia', email: 'tia@shop.example.com' });
		expect(actorOf({ ticket: { user: { id: 's', name: 'S' } } }, SERVER)).toEqual({ kind: 'staff', id: 's', name: 'S' });
		const actor = /** @type {const} */ ({ kind: 'user', id: 'u1', name: 'Sam', role: 'Owner' });
		expect(actorOf({ ticket: null, actor }, SERVER)).toBe(actor);
		expect(actorOf({}, SERVER)).toBe(SERVER);
	});

	it('reach the product on server-token calls, are refused when malformed and record the staff member', async () => {
		const ctx = await setup({ routes: routes() });
		holder.product = ctx.product;
		const { call, server, settle, connectDatabase, websiteId } = ctx;
		const dbName = await connectDatabase();
		const named = await call('POST', '/v1/server/actions', {
			token: server.token,
			headers: {
				'ss-actor-id': 'usr_7',
				'ss-actor-name': 'Bilal%20A.',
				'ss-actor-role': 'Owner',
				'ss-actor-email': 'b@shop.example.com',
			},
		});
		expect(named.status).toBe(200);
		expect((await named.json()).actor).toEqual({
			kind: 'user',
			id: 'usr_7',
			name: 'Bilal A.',
			role: 'Owner',
			email: 'b@shop.example.com',
		});
		await settle();
		const unnamed = await call('POST', '/v1/server/actions', { token: server.token });
		expect((await unnamed.json()).actor).toEqual(SERVER);
		const malformed = await call('POST', '/v1/server/actions', { token: server.token, headers: { 'ss-actor-id': 'usr_7' } });
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toMatchObject({ type: 'https://notes.example.dev/problems/invalid_actor', status: 400 });
		await settle();
		const { client, db } = await openDb(dbName);
		expect(
			await db.collection('ss_notes_staff').findOne({ id: 'usr_7' }, { projection: { _id: 0, lastSeenAt: 0 } }),
		).toMatchObject({
			websiteId,
			id: 'usr_7',
			name: 'Bilal A.',
			role: 'Owner',
			email: 'b@shop.example.com',
		});
		const entries = await db.collection('ss_notes_activity').find({}).sort({ at: 1 }).toArray();
		expect(entries.map((entry) => entry.actor)).toEqual([
			{ kind: 'user', id: 'usr_7', name: 'Bilal A.', role: 'Owner' },
			SERVER,
		]);
		expect(entries[0]).toMatchObject({ label: 'Note 1', action: 'note.moved' });
		await client.close();
	});

	it('record the staff member of a route without the database only once one is connected', async () => {
		const ctx = await setup();
		const { call, server, settle, connectDatabase } = ctx;
		const actor = { 'ss-actor-id': 'usr_8', 'ss-actor-name': 'Noor' };
		expect((await call('GET', '/v1/server/open', { token: server.token, headers: actor })).status).toBe(200);
		await settle();
		const dbName = await connectDatabase();
		expect((await call('GET', '/v1/server/open', { token: server.token, headers: actor })).status).toBe(200);
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

	it("need the visitor's IP on writes and take the actor headers", async () => {
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
		expect(await named.json()).toEqual({
			visitor: { server: true, ip: '2001:db8::1' },
			actor: { kind: 'user', id: 'u1', name: 'Sam' },
		});
		expect(
			(await call('POST', '/v1/visitor/whoami', { token: server.token, body: {}, headers: { 'ss-actor-id': 'u1' } })).status,
		).toBe(400);
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
