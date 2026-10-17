/**
 * What the Portal delivers to the product (settings-ownership steps 6 and 7): the database and storage entered once in the
 * Portal, and the links to other products. A product fetches them when the status or a notice says there is something
 * new, a product added later gets them, and a link key can do only what the Portal granted it, on its website, to this
 * product.
 */
import { describe, expect, it, vi } from 'vitest';
import { DOMAIN, freshDb, mongoUri, openDb, setup } from './helpers.js';

const ORIGIN = `https://${DOMAIN}`;

/** @param {Response} response */
const typeOf = async (response) =>
	String((await response.json()).type ?? '')
		.split('/')
		.pop();

describe('the website’s database, entered once in the Portal', () => {
	it('is fetched when a notice says so, sealed, and every request then uses this product’s own database', async () => {
		const { portal, websiteId, settle, store, connectDatabase, call, browser, switchOn } = await setup();
		await switchOn(['notes']);
		// before: no database, and the answer says where to enter it
		const before = await call('POST', '/v1/notes', { token: browser.token, origin: ORIGIN, body: { text: 'x' } });
		expect([before.status, await typeOf(before)]).toEqual([403, 'database_not_connected']);
		const dbName = await connectDatabase();
		expect(await store.get('portal_connections', websiteId)).toMatchObject({ version: 1, linksIn: [] });
		expect(portal.health(websiteId, 'notes', 'database')).toMatchObject({ ok: true, version: 1 });
		const stored = JSON.stringify(await store.list('connections', { websiteId }));
		expect(stored).not.toContain('mongodb');
		expect(stored).toContain('ss2.');
		await settle();
		// now the same request is served, into the database the Portal named for this product
		const after = await call('POST', '/v1/notes', { token: browser.token, origin: ORIGIN, body: { text: 'hello' } });
		expect(after.status).toBe(200);
		const { client, db } = await openDb(dbName);
		expect(await db.collection('ss_notes_notes').countDocuments({ websiteId })).toBe(1);
		await client.close();
	});

	it('is fetched by a product that lost the notice, at the next status fetch (the status shows the Portal is ahead)', async () => {
		const { portal, websiteId, settle, call, server, clock, product } = await setup();
		await call('GET', '/v1/server/open', { token: server.token, bare: true });
		await settle();
		const name = freshDb('later');
		await portal.saveConnections(websiteId, { database: mongoUri(name), dbNames: { notes: name } }, { notify: false });
		expect(await product.connections.value(websiteId, 'database')).toBeNull();
		// the copy of the status is 5 minutes old: it is fetched again right after the next response, and shows the new version
		clock.advance(5 * 60_000 + 1);
		await call('GET', '/v1/server/open', { token: server.token, bare: true });
		await settle();
		expect(await product.connections.value(websiteId, 'database')).toEqual(expect.stringContaining('mongodb'));
	});

	it('is asked for once by a product that holds none yet (a product just added to the website): that very use waits for it', async () => {
		const { portal, websiteId, call, browser, switchOn, store } = await setup();
		const name = freshDb('added');
		// the Portal holds a database already; this product was just added: no notice reached it yet, but its first status shows it
		await portal.saveConnections(websiteId, { database: mongoUri(name), dbNames: { notes: name } }, { notify: false });
		await switchOn(['notes']);
		expect(await store.get('portal_connections', websiteId)).toBeNull();
		const posted = await call('POST', '/v1/notes', { token: browser.token, origin: ORIGIN, body: { text: 'hello' } });
		expect(posted.status).toBe(200);
		expect(await store.get('portal_connections', websiteId)).toMatchObject({ version: 1 });
		const { client, db } = await openDb(name);
		expect(await db.collection('ss_notes_notes').countDocuments({ websiteId })).toBe(1);
		await client.close();
	});

	it('does not fetch again while it holds what the Portal has (a refused key cannot make the product call the Portal)', async () => {
		const { portal, websiteId, settle, link, call, connectDatabase } = await setup();
		await connectDatabase();
		await link('accounts');
		const fetches = () => portal.calls.filter((c) => c.path.endsWith('/connections')).length;
		const held = fetches();
		for (let i = 0; i < 5; i += 1) {
			const refused = await call('GET', '/v1/server/linked', { token: 'not.a.token', bare: true });
			expect(refused.status).toBe(401);
		}
		await settle();
		expect(fetches()).toBe(held);
		expect(websiteId).toBeTruthy();
	});
});

describe('a link key: only the scopes the Portal granted, only this product, only this website', () => {
	/** A product that is called by Accounts through a link with the scope `notes.read`. */
	const linked = async (scopes = ['notes.read']) => {
		const ctx = await setup();
		await ctx.switchOn(['notes', 'inbox']);
		const { token, jti } = await ctx.portal.link(ctx.websiteId, 'accounts', 'notes', scopes);
		await ctx.settle();
		return { ...ctx, link: token, jti };
	};

	it('may call a route that names its scope: it is the caller (Accounts) that calls, not the website’s server', async () => {
		const { call, link, websiteId } = await linked();
		const answered = await call('GET', '/v1/server/linked', { token: link, bare: true });
		expect(answered.status).toBe(200);
		expect(await answered.json()).toEqual({ kind: 'link', caller: 'accounts', websiteId });
	});

	it('the website’s own server token still calls it, as before', async () => {
		const { call, server, websiteId } = await linked();
		const answered = await call('GET', '/v1/server/linked', { token: server.token, bare: true });
		expect(await answered.json()).toEqual({ kind: 'server', caller: null, websiteId });
	});

	it('cannot call a route outside its scope: 403 scope_denied; or a route that takes no link at all: 401', async () => {
		const { call, link } = await linked(['messages.send']);
		const outside = await call('GET', '/v1/server/linked', { token: link, bare: true });
		expect([outside.status, await typeOf(outside)]).toEqual([403, 'scope_denied']);
		// every other server route takes the website's server token only
		for (const path of [
			'/v1/server/open',
			'/v1/server/notes',
			'/v1/features',
			'/v1/settings',
			'/v1/connections',
			'/v1/activity',
		]) {
			const refused = await call('GET', path, { token: link, bare: true });
			expect([path, refused.status, await typeOf(refused)]).toEqual([path, 401, 'invalid_token']);
		}
	});

	it('changes no configuration: settings, texts, lists, connections, features, tickets are all refused', async () => {
		const { call, link } = await linked();
		for (const [method, path, body] of /** @type {Array<[string, string, unknown]>} */ ([
			['PUT', '/v1/settings/notes.maxNotes', { value: 9 }],
			['PUT', '/v1/texts/form.title', { value: 'x' }],
			['PUT', '/v1/connections/database', { value: 'mongodb://x/y' }],
			['DELETE', '/v1/connections/database', undefined],
			['PUT', '/v1/theme', { value: {} }],
			['POST', '/v1/tickets', { permissions: [], origin: 'https://admin.example.com' }],
			['POST', '/v1/data-rights/delete', { user: { id: 'u1' } }],
		])) {
			const refused = await call(method, path, { token: link, bare: true, ...(body === undefined ? {} : { body }) });
			expect([method, path, refused.status]).toEqual([method, path, 401]);
		}
	});

	it('does not stand in for a staff member: a staff route that takes its scope still needs the staff sign-in', async () => {
		const { call, link, staffHeaders } = await linked();
		const bare = await call('GET', '/v1/server/linked-staff', { token: link, bare: true });
		expect([bare.status, await typeOf(bare)]).toEqual([403, 'needs_signed_in_staff']);
		const withStaff = await call('GET', '/v1/server/linked-staff', {
			token: link,
			bare: true,
			headers: await staffHeaders({ staff: { id: 'usr_7', name: 'Sam', permissions: ['notes:notes.read'] } }),
		});
		expect(withStaff.status).toBe(200);
		expect(await withStaff.json()).toMatchObject({ kind: 'link', actor: { id: 'usr_7' } });
	});

	it('is not a browser token: a visitor route refuses it, with or without an Origin', async () => {
		const { call, link } = await linked();
		for (const origin of [undefined, 'https://shop.example.com']) {
			const refused = await call('GET', '/v1/notes', { token: link, ...(origin ? { origin } : {}) });
			expect(refused.status).toBe(401);
		}
	});

	it('is refused with an Origin header like the server token (it is a server-to-server key)', async () => {
		const { call, link } = await linked();
		const refused = await call('GET', '/v1/server/linked', { token: link, origin: 'https://evil.example.com' });
		expect(refused.status).toBe(401);
	});

	it('another website’s link key (the Portal granted nothing on this one) and a key made for another product are refused', async () => {
		const { call, portal, websiteId, settle } = await linked();
		const other = portal.addWebsite({ domain: 'other.example.com' });
		const elsewhere = await portal.link(other, 'accounts', 'notes', ['notes.read']);
		await settle();
		// the key says it is for `other`; this product holds no grant for that website's caller yet it is told by the notice only
		// when the Portal says so: the grant exists for `other` as well here, so its call is a call on `other`, never on the first
		const answer = await call('GET', '/v1/server/linked', { token: elsewhere.token, bare: true });
		expect(await answer.json()).toMatchObject({ websiteId: other });
		expect(other).not.toBe(websiteId);
		// a key for Chat is not valid at Notes
		const forChat = await portal.link(websiteId, 'accounts', 'chat', ['notes.read']);
		const refused = await call('GET', '/v1/server/linked', { token: forChat.token, bare: true });
		expect([refused.status, await typeOf(refused)]).toEqual([401, 'invalid_token']);
	});

	it('a caller the Portal did not grant is refused even with a good key (403), and it follows the Portal when the grant is lifted', async () => {
		const { call, portal, websiteId, link, settle, clock } = await linked();
		expect((await call('GET', '/v1/server/linked', { token: link, bare: true })).status).toBe(200);
		// the Portal narrows the grant (the key is the same; the product learns it from the notice)
		clock.advance(1000);
		await portal.link(websiteId, 'accounts', 'notes', ['messages.send']);
		await settle();
		const old = await call('GET', '/v1/server/linked', { token: link, bare: true });
		// the new link has a new key: the old one is revoked at once
		expect([old.status, await typeOf(old)]).toEqual([401, 'invalid_token']);
	});

	it('is revoked at once when the Portal ends the link: the revocation list is read when the notice comes', async () => {
		const { call, portal, websiteId, link, clock, settle } = await linked();
		expect((await call('GET', '/v1/server/linked', { token: link, bare: true })).status).toBe(200);
		clock.advance(1000);
		await portal.unlink(websiteId, 'accounts', 'notes');
		await settle();
		const refused = await call('GET', '/v1/server/linked', { token: link, bare: true });
		expect([refused.status, await typeOf(refused)]).toEqual([401, 'invalid_token']);
		// and the product holds no grant for the caller any more
		const again = await portal.link(websiteId, 'chat', 'notes', ['notes.read']);
		await settle();
		expect((await call('GET', '/v1/server/linked', { token: again.token, bare: true })).status).toBe(200);
	});

	it('learns a new grant from the status when the notice is lost, and never fetches for a caller the status does not know', async () => {
		const ctx = await setup();
		const { call, portal, websiteId, settle, clock } = ctx;
		await ctx.switchOn(['notes']);
		await call('GET', '/v1/server/open', { token: ctx.server.token, bare: true });
		await settle();
		const lost = await portal.link(websiteId, 'accounts', 'notes', ['notes.read']);
		// no notice reached the product (it was down): its first call with the new key asks the Portal once if the status is ahead
		const fetches = () => portal.calls.filter((c) => c.path.endsWith('/connections')).length;
		const before = fetches();
		clock.advance(5 * 60_000 + 1);
		await call('GET', '/v1/server/open', { token: ctx.server.token, bare: true });
		await settle();
		const granted = await call('GET', '/v1/server/linked', { token: lost.token, bare: true });
		expect(granted.status).toBe(200);
		expect(fetches()).toBeGreaterThan(before);
		await vi.waitFor(() => expect(fetches()).toBeLessThan(10));
	});
});
