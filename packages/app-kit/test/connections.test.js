import { describe, expect, it } from 'vitest';
import { createProduct, defineRoute } from '../src/index.js';
import { createSealer } from '../src/sealing.js';
import {
	BASE,
	ENCRYPTION_KEY,
	SECRET,
	createTestLogger,
	freshDb,
	manifest,
	mongoUri,
	openDb,
	productRoutes,
	setup,
} from './helpers.js';

/** @type {Record<string, import('../src/index.js').ConnectionDefinition>} */
const CONNECTIONS = {
	ai: {
		label: 'AI provider key',
		kind: 'secret',
		neededBy: ['notes'],
		test: async (/** @type {any} */ value) => (value === 'bad-key-0000' ? { ok: false, message: 'Key refused' } : { ok: true }),
	},
	smtp: { label: 'SMTP', kind: 'secret', neededBy: ['inbox'], secretField: 'password' },
	storage: { label: 'Storage', kind: 'storage', neededBy: ['notes'] },
	accounts: { label: 'Accounts token', kind: 'token', productId: 'accounts', neededBy: ['notes'] },
};

/** @type {{ product: any }} */
const holder = { product: null };

/** Routes that use the kit inside requests. */
const routes = () => [
	...productRoutes(),
	defineRoute({
		method: 'POST',
		path: '/v1/actions',
		auth: 'server',
		handler: async (ctx) => {
			await holder.product.activity.record(ctx, {
				actor: { kind: 'merchant', id: 'srv' },
				action: 'note.created',
				target: 'note_1',
				values: { kind: 'quick', words: 2, pinned: false },
			});
			return { done: true };
		},
	}),
];

const KEY_B = 'encryption-key-b-0123456789-abcdefghij';

/**
 * A dashboard call on another instance of the product (another `ENCRYPTION_KEY`), sharing the store.
 * @param {(request: Request) => Promise<Response>} handler
 * @param {string} cookie
 * @param {string} method
 * @param {string} path
 */
const dashOn = (handler, cookie, method, path) =>
	handler(new Request(`${BASE}${path}`, { method, headers: { cookie, ...(method === 'GET' ? {} : { origin: BASE }) } }));

describe('sealing', () => {
	it('opens only with the same key and place', () => {
		const sealer = createSealer({ encryptionKey: 'k'.repeat(32), randomBytes: (n) => new Uint8Array(n).fill(1) });
		const sealed = sealer.seal('secret', 'a');
		expect(sealed.startsWith(`ss2.${sealer.keyId}.`)).toBe(true);
		expect(sealer.open(sealed, 'a')).toBe('secret');
		expect(sealer.open(sealed, 'b')).toBeNull();
		expect(createSealer({ encryptionKey: 'j'.repeat(32) }).open(sealed, 'a')).toBeNull();
		expect(sealer.open('v2.x.y.z', 'a')).toBeNull();
		expect(sealer.open(42, 'a')).toBeNull();
		expect(() => createSealer({ encryptionKey: 'short' })).toThrow(/ENCRYPTION_KEY/);
	});
});

describe('connections', () => {
	it('are write-only, tested when saved, encrypted and recorded in Recent changes', async () => {
		const { session, dash, websiteId, store } = await setup({ connections: CONNECTIONS });
		const cookie = await session({ kind: 'merchant' });
		const path = `/v1/dashboard/websites/${websiteId}/connections`;
		const listed = await (await dash(cookie, 'GET', path)).json();
		expect(listed.connections.map((/** @type {{ name: string }} */ c) => c.name)).toEqual([
			'ai',
			'smtp',
			'storage',
			'accounts',
			'database',
		]);
		expect(listed.connections[4]).toEqual({
			name: 'database',
			label: 'Database (MongoDB)',
			kind: 'database',
			neededBy: ['notes', 'inbox'],
			status: 'not_connected',
			last4: '',
			testedAt: null,
		});
		const saved = await (await dash(cookie, 'PUT', `${path}/ai`, { value: 'sk-live-abcdef1234' })).json();
		expect(saved).toMatchObject({ name: 'ai', status: 'connected', last4: '1234' });
		expect(JSON.stringify(await store.list('connections', { websiteId }))).not.toContain('sk-live');
		const failed = await (await dash(cookie, 'PUT', `${path}/ai`, { value: 'bad-key-0000' })).json();
		expect(failed).toMatchObject({ status: 'test_failed', message: 'Key refused', last4: '0000' });
		const smtp = await (
			await dash(cookie, 'PUT', `${path}/smtp`, { value: { host: 'smtp.example.com', password: 'pw-9876' } })
		).json();
		expect(smtp.last4).toBe('9876');
		for (const [name, value] of /** @type {Array<[string, unknown]>} */ ([
			['ai', ''],
			['smtp', { nested: { a: 1 } }],
			['database', 'postgres://x'],
			['accounts', ''],
			['storage', { bucket: 'b' }],
		])) {
			expect((await dash(cookie, 'PUT', `${path}/${name}`, { value })).status).toBe(422);
		}
		expect((await dash(cookie, 'PUT', `${path}/nope`, { value: 'x' })).status).toBe(404);
		expect((await dash(cookie, 'POST', `${path}/nope/test`)).status).toBe(404);
		expect((await dash(cookie, 'POST', `${path}/storage/test`)).status).toBe(404);
		expect(await (await dash(cookie, 'POST', `${path}/ai/test`)).json()).toMatchObject({ status: 'test_failed' });
		expect((await dash(cookie, 'DELETE', `${path}/ai`)).status).toBe(204);
		expect((await dash(cookie, 'DELETE', `${path}/nope`)).status).toBe(404);
		const overview = await (await dash(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/overview`)).json();
		expect(overview.recentChanges.map((/** @type {{ detail: string }} */ c) => c.detail)).toContain('AI provider key: removed');
	});

	it('show not_connected when ENCRYPTION_KEY changed', async () => {
		const { session, dash, websiteId, store, portal, clock } = await setup({ connections: CONNECTIONS });
		const cookie = await session({ kind: 'merchant' });
		await dash(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/connections/ai`, { value: 'sk-live-abcdef1234' });
		const other = createProduct({
			manifest: manifest(),
			config: { mongodbUri: '', connectSecret: SECRET, encryptionKey: 'another-encryption-key-0123456789abcdef' },
			store,
			fetch: portal.fetch,
			now: clock.now,
			connections: CONNECTIONS,
		});
		expect(await other.connections.value(websiteId, 'ai')).toBeNull();
		const handler = other.handler([]);
		// its product key does not open either (K-21): the owner connects it again from the Portal (a new key)
		await portal.connect({ handler, baseUrl: BASE, secret: SECRET });
		const response = await handler(
			new Request(`${BASE}/v1/dashboard/websites/${websiteId}/connections`, { headers: { cookie: String(cookie) } }),
		);
		const ai = (await response.json()).connections.find((/** @type {{ name: string }} */ c) => c.name === 'ai');
		expect(ai).toMatchObject({ status: 'not_connected', last4: '' });
		expect(ENCRYPTION_KEY).not.toBe('another-encryption-key-0123456789abcdef');
	});

	it('survive a key change: B with A as previous opens them, the Owner re-seals them to B, then A can go (RT-14)', async () => {
		const { session, dash, websiteId, store, portal, clock, connectDatabase } = await setup({ connections: CONNECTIONS });
		const { logger } = createTestLogger();
		const merchant = await session({ kind: 'merchant' });
		await dash(merchant, 'PUT', `/v1/dashboard/websites/${websiteId}/connections/ai`, { value: 'sk-live-abcdef1234' });
		await connectDatabase();
		/** @type {string[]} */
		const reached = [];
		/** @param {string} encryptionKey @param {string | null} previousEncryptionKey @param {any} [hooks] */
		const instance = (encryptionKey, previousEncryptionKey, hooks) =>
			createProduct({
				manifest: manifest(),
				config: { mongodbUri: '', connectSecret: SECRET, encryptionKey, previousEncryptionKey },
				store,
				fetch: portal.fetch,
				now: clock.now,
				logger,
				connections: CONNECTIONS,
				outbound: { allowHosts: ['127.0.0.1', 'localhost'] },
				...(hooks ? { hooks } : {}),
			});
		const changing = instance(KEY_B, ENCRYPTION_KEY, {
			resealProduct: async () => ({ resealed: 1, current: 0, unreadable: 0 }),
			resealWebsite: async (/** @type {any} */ data) => {
				reached.push(data.websiteId);
				return { resealed: 0, current: 2, unreadable: 1 };
			},
		});
		expect(await changing.connections.value(websiteId, 'ai')).toBe('sk-live-abcdef1234');
		const owner = await session();
		const handler = changing.handler([]);
		expect((await dashOn(handler, await session({ role: 'support' }), 'POST', '/v1/dashboard/reseal')).status).toBe(403);
		expect((await dashOn(handler, merchant, 'POST', '/v1/dashboard/reseal')).status).toBe(403);
		const first = await (await dashOn(handler, owner, 'POST', '/v1/dashboard/reseal')).json();
		// Connections (ai, database) and the product key (K-21), the product's own (1), the website's (2 current, 1 not)
		expect(first).toEqual({
			keyId: expect.any(String),
			previousKeyId: expect.any(String),
			resealed: 4,
			current: 2,
			unreadable: 1,
			failedWebsites: [],
			unreadableIn: { product: 1 },
		});
		expect(reached).toEqual([websiteId]);
		const again = await (await dashOn(handler, owner, 'POST', '/v1/dashboard/reseal')).json();
		expect(again).toMatchObject({ resealed: 1, current: 5, unreadable: 1 });
		// the previous key is removed: everything still opens with B alone, nothing with A alone
		expect(await instance(KEY_B, null).connections.value(websiteId, 'ai')).toBe('sk-live-abcdef1234');
		expect(await instance(KEY_B, null).connections.value(websiteId, 'database')).toEqual(expect.stringMatching(/^mongodb:/));
		expect(await instance(ENCRYPTION_KEY, null).connections.value(websiteId, 'ai')).toBeNull();
		// a website whose merchant database is not reached is named, not hidden
		const failing = instance(KEY_B, null, {
			resealWebsite: async () => {
				throw new Error('unreachable');
			},
		});
		expect(await (await dashOn(failing.handler([]), owner, 'POST', '/v1/dashboard/reseal')).json()).toMatchObject({
			resealed: 0,
			current: 3,
			failedWebsites: [websiteId],
		});
		await Promise.all([changing.close(), failing.close()]);
	});

	it('refuse definitions that do not fit the manifest', () => {
		const make = (/** @type {any} */ connections) =>
			createProduct({
				manifest: manifest(),
				config: { mongodbUri: '', connectSecret: SECRET, encryptionKey: ENCRYPTION_KEY },
				connections,
			});
		expect(() => make({ 'Bad Name': { label: 'x', kind: 'secret', neededBy: [] } })).toThrow(/name/);
		expect(() => make({ x: { label: 'x', kind: 'other', neededBy: [] } })).toThrow(/kind/);
		expect(() => make({ x: { label: 'x', kind: 'secret', neededBy: ['nope'] } })).toThrow(/neededBy/);
		expect(() => make({ x: { label: 'x', kind: 'token', neededBy: [] } })).toThrow(/productId/);
		expect(() => make({ db2: { label: 'x', kind: 'database', neededBy: [] } })).toThrow(/database/);
		expect(() => make({ database: { label: 'My database', kind: 'database', neededBy: ['notes'] } })).not.toThrow();
	});
});

describe('storage', () => {
	it('tests the bucket with a signed HEAD and presigns uploads', async () => {
		const { session, dash, websiteId, handlers, product } = await setup({ connections: CONNECTIONS });
		/** @type {string[]} */
		const seen = [];
		let status = 404;
		handlers['https://files.example.com'] = async (request) => {
			seen.push(`${request.method} ${new URL(request.url).pathname} ${request.headers.get('authorization')?.slice(0, 16)}`);
			return new Response(null, { status });
		};
		const cookie = await session({ kind: 'merchant' });
		const value = {
			endpoint: 'https://files.example.com',
			region: 'auto',
			bucket: 'shop',
			accessKeyId: 'AKID',
			secretAccessKey: 'secret-key-5678',
		};
		const saved = await (
			await dash(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/connections/storage`, { value })
		).json();
		expect(saved).toMatchObject({ status: 'connected', last4: '5678' });
		expect(seen[0]).toMatch(/^HEAD \/shop\/notes\/.+\/ss-connection-test AWS4-HMAC-SHA256/);
		status = 403;
		expect(
			await (await dash(cookie, 'POST', `/v1/dashboard/websites/${websiteId}/connections/storage/test`)).json(),
		).toMatchObject({ status: 'test_failed' });
		const storage = await product.connections.storage(websiteId);
		const upload = storage?.presignPut({ key: 'a/b.png', contentType: 'image/png', contentLength: 10 });
		expect(upload?.url).toContain('X-Amz-Signature=');
		expect(await product.connections.storage(websiteId, 'ai')).toBeNull();
	});
});

describe('pasted tokens', () => {
	it('are saved only as a server token of the expected product for the same website', async () => {
		const { session, dash, websiteId, portal } = await setup({ connections: CONNECTIONS });
		const cookie = await session({ kind: 'merchant' });
		const path = `/v1/dashboard/websites/${websiteId}/connections/accounts`;
		const other = portal.addWebsite({ domain: 'other.example.com' });
		for (const token of [
			(await portal.issueToken({ websiteId, productId: 'accounts', kind: 'browser' })).token,
			(await portal.issueToken({ websiteId, productId: 'chat', kind: 'server' })).token,
			(await portal.issueToken({ websiteId: other, productId: 'accounts', kind: 'server' })).token,
			'garbage',
		]) {
			expect((await dash(cookie, 'PUT', path, { value: token })).status).toBe(422);
		}
		const good = await portal.issueToken({ websiteId, productId: 'accounts', kind: 'server' });
		expect(await (await dash(cookie, 'PUT', path, { value: good.token })).json()).toMatchObject({ status: 'connected' });
		portal.revoke(good.jti);
		await portal.sendNotice('notes', { type: 'token.revoked', websiteId });
		expect(await (await dash(cookie, 'POST', `${path}/test`)).json()).toMatchObject({ status: 'test_failed' });
	});

	it('call the other product at its directory address and report failures as typed results', async () => {
		const { session, dash, websiteId, portal, product, accounts, handlers } = await setup({ connections: CONNECTIONS });
		expect(await product.callProduct(websiteId, 'accounts', '/v1/activity-copies')).toEqual({
			ok: false,
			reason: 'not_connected',
		});
		const cookie = await session({ kind: 'merchant' });
		const token = (await portal.issueToken({ websiteId, productId: 'accounts', kind: 'server' })).token;
		await dash(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/connections/accounts`, { value: token });
		const copy = {
			websiteId,
			productId: 'notes',
			actor: { kind: 'staff', id: 'u1' },
			action: 'a',
			target: 't',
			at: '2026-10-01T10:00:00Z',
		};
		expect(await product.callProduct(websiteId, 'accounts', '/v1/activity-copies', { method: 'POST', body: copy })).toEqual({
			ok: true,
			status: 201,
			body: { received: true },
		});
		expect(accounts.copies[0]?.token).toBe(token);
		accounts.setFailing(true);
		expect(
			await product.callProduct(websiteId, 'accounts', '/v1/activity-copies', { method: 'POST', body: copy }),
		).toMatchObject({ ok: false, reason: 'unreachable', status: 503 });
		expect(await product.callProduct(websiteId, 'accounts', '/v1/elsewhere', { method: 'POST', body: copy })).toMatchObject({
			ok: false,
			reason: 'failed',
			status: 404,
		});
		handlers[accounts.url] = async () =>
			new Response(JSON.stringify({ type: 'https://a/problems/invalid_token' }), { status: 401 });
		expect(await product.callProduct(websiteId, 'accounts', '/x')).toMatchObject({ ok: false, reason: 'refused' });
		handlers[accounts.url] = async () =>
			new Response(JSON.stringify({ type: 'https://a/problems/product_unavailable', reason: 'stopped' }), { status: 403 });
		expect(await product.callProduct(websiteId, 'accounts', '/x')).toMatchObject({ ok: false, reason: 'unavailable' });
		handlers[accounts.url] = async () => new Response('not json', { status: 200 });
		expect(await product.callProduct(websiteId, 'accounts', '/x')).toEqual({ ok: true, status: 200, body: null });
		delete handlers[accounts.url];
		expect(await product.callProduct(websiteId, 'accounts', '/x')).toMatchObject({ ok: false, reason: 'unreachable' });
		const list = await (await dash(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/connections`)).json();
		expect(list.connections.find((/** @type {{ name: string }} */ c) => c.name === 'accounts')).toMatchObject({
			status: 'connected',
		});
	});

	it('list every connected product through the Portal directory: kept 5 minutes, the last copy while it is down', async () => {
		const { product, portal, clock, accounts, notifications, entries } = await setup();
		const first = await product.products();
		expect(first).toEqual([
			{ productId: 'accounts', name: 'accounts', baseUrl: accounts.url },
			{ productId: 'notes', name: 'Notes', baseUrl: BASE },
			{ productId: 'notifications', name: 'notifications', baseUrl: notifications.url },
		]);
		// a product connected later (one this product never heard of) is listed once the copy is 5 minutes old
		portal.addProduct({ productId: 'bookings', name: 'Bookings', baseUrl: 'https://bookings.example.dev' });
		expect(await product.products()).toBe(first);
		clock.advance(5 * 60_000);
		expect((await product.products()).map((entry) => entry.productId)).toEqual([
			'accounts',
			'bookings',
			'notes',
			'notifications',
		]);
		// its addresses answer addressOf without another directory call
		const calls = portal.calls.length;
		expect(await product.addressOf('bookings')).toBe('https://bookings.example.dev');
		expect(portal.calls.length).toBe(calls);
		// the Portal cannot answer: the last copy, with a warning; it is asked again only after a minute, so callers (a
		// Notifications send) do not each wait for a Portal that is down
		portal.setReachable(false);
		clock.advance(5 * 60_000);
		const warned = () => entries.filter((entry) => entry.msg === 'product directory not read: the last copy is used').length;
		expect((await product.products()).map((entry) => entry.productId)).toContain('bookings');
		expect(warned()).toBe(1);
		expect((await product.products()).map((entry) => entry.productId)).toContain('bookings');
		expect(warned()).toBe(1);
		clock.advance(60_000);
		await product.products();
		expect(warned()).toBe(2);
		// never read: it throws, and the Portal is asked again only after a minute
		const fresh = await setup();
		fresh.portal.setReachable(false);
		await expect(fresh.product.products()).rejects.toMatchObject({ code: 'portal_unreachable' });
		fresh.portal.setReachable(true);
		await expect(fresh.product.products()).rejects.toMatchObject({ code: 'portal_unreachable' });
		fresh.clock.advance(60_000);
		expect((await fresh.product.products()).length).toBe(3);
	});

	it('mark the connection broken when the directory does not know the product', async () => {
		const { session, dash, websiteId, portal, product } = await setup({
			connections: {
				...CONNECTIONS,
				payments: { label: 'Payments token', kind: 'token', productId: 'payments', neededBy: ['notes'] },
			},
		});
		const cookie = await session({ kind: 'merchant' });
		const token = (await portal.issueToken({ websiteId, productId: 'payments', kind: 'server' })).token;
		await dash(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/connections/payments`, { value: token });
		expect(await product.callProduct(websiteId, 'payments', '/v1/x')).toEqual({ ok: false, reason: 'unavailable' });
		const list = await (await dash(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/connections`)).json();
		expect(list.connections.find((/** @type {{ name: string }} */ c) => c.name === 'payments')).toMatchObject({
			status: 'test_failed',
			message: 'payments is not available.',
		});
	});
});

describe('activity log and data rights', () => {
	it('logs to the merchant database, forwards copies to Accounts and retries unsent ones', async () => {
		const ctx = await setup({ connections: CONNECTIONS, routes: routes() });
		holder.product = ctx.product;
		const { session, dash, websiteId, portal, accounts, call, server, settle, connectDatabase } = ctx;
		const dbName = await connectDatabase();
		expect((await call('POST', '/v1/actions', { token: server.token })).status).toBe(200);
		await settle();
		expect(accounts.copies).toHaveLength(0);
		const cookie = await session({ kind: 'merchant' });
		await dash(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/connections/accounts`, {
			value: (await portal.issueToken({ websiteId, productId: 'accounts', kind: 'server' })).token,
		});
		accounts.setFailing(true);
		await call('POST', '/v1/actions', { token: server.token });
		await settle();
		const { client, db } = await openDb(dbName);
		const log = db.collection('ss_notes_activity');
		expect(await log.countDocuments({ copy: 'pending' })).toBe(1);
		expect(await log.countDocuments({ copy: 'none' })).toBe(1);
		accounts.setFailing(false);
		await call('GET', '/v1/server/open', { token: server.token });
		await settle();
		expect(await log.countDocuments({ copy: 'pending' })).toBe(1);
		await call('POST', '/v1/actions', { token: server.token });
		await settle();
		expect(await log.countDocuments({ copy: 'sent' })).toBe(2);
		expect(accounts.copies.map((c) => c.copy.action)).toEqual(['note.created', 'note.created']);
		// A8: what changed travels as values (codes, numbers, yes/no), never as a sentence
		expect(accounts.copies[0]?.copy.values).toEqual({ kind: 'quick', words: 2, pinned: false });
		const listed = await call('GET', '/v1/activity', { token: server.token });
		expect((await listed.json()).items[0]).toMatchObject({ detail: null, values: { kind: 'quick', words: 2, pinned: false } });
		expect(await log.findOne({ copy: 'sent' })).toMatchObject({
			websiteId,
			merchantId: 'mer_0123456789abcdefghjkmnpq',
			actor: { kind: 'merchant', id: 'srv' },
		});
		await client.close();
		await expect(
			ctx.product.activity.record(
				{ websiteId, merchantId: null, after: () => {} },
				{ actor: /** @type {any} */ ({}), action: 'x', target: 'y' },
			),
		).rejects.toMatchObject({ code: 'invalid_argument' });
		await expect(
			ctx.product.activity.record(
				{ websiteId, merchantId: null, after: () => {} },
				{ actor: { kind: 'merchant', id: 'srv' }, action: 'x', target: 'y', values: { 'not a key': 1 } },
			),
		).rejects.toMatchObject({ code: 'invalid_argument' });
	});

	it('drops copies Accounts refuses after 3 refusals, pausing the website 15 minutes after each (RT-5)', async () => {
		const ctx = await setup({ connections: CONNECTIONS, routes: routes() });
		holder.product = ctx.product;
		const { session, dash, websiteId, portal, accounts, handlers, call, server, settle, connectDatabase, clock, entries } = ctx;
		const dbName = await connectDatabase();
		const cookie = await session({ kind: 'merchant' });
		await dash(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/connections/accounts`, {
			value: (await portal.issueToken({ websiteId, productId: 'accounts', kind: 'server' })).token,
		});
		let refusing = true;
		let asked = 0;
		const original = /** @type {(request: Request) => Promise<Response>} */ (handlers[accounts.url]);
		handlers[accounts.url] = async (request) => {
			asked += 1;
			return refusing
				? new Response(JSON.stringify({ type: `${accounts.url}/problems/feature_off`, status: 403 }), { status: 403 })
				: original(request);
		};
		const act = async () => {
			expect((await call('POST', '/v1/actions', { token: server.token })).status).toBe(200);
			await settle();
		};
		await act();
		await act();
		await act();
		expect(asked).toBe(1);
		const { client, db } = await openDb(dbName);
		const log = db.collection('ss_notes_activity');
		const state = async () =>
			(await log.find({}, { sort: { at: 1, _id: 1 } }).toArray()).map((e) => [e.copy, e.copyTries ?? 0]);
		expect(await state()).toEqual([
			['pending', 1],
			['pending', 0],
			['pending', 0],
		]);
		clock.advance(15 * 60_000);
		await call('GET', '/v1/activity', { token: server.token });
		await settle();
		expect(asked).toBe(2);
		clock.advance(15 * 60_000);
		await act();
		expect(asked).toBe(3);
		expect(await state()).toEqual([
			['dropped', 3],
			['pending', 2],
			['pending', 2],
			['pending', 1],
		]);
		refusing = false;
		clock.advance(15 * 60_000);
		await call('GET', '/v1/activity', { token: server.token });
		await settle();
		expect(accounts.copies).toHaveLength(3);
		expect((await state()).map(([copy]) => copy)).toEqual(['dropped', 'sent', 'sent', 'sent']);
		expect(entries.filter((e) => e.msg.startsWith('activity copies refused by Accounts'))).toHaveLength(1);
		await client.close();
	});

	it('retries unsent copies on the next request of a fresh instance', async () => {
		const ctx = await setup({ connections: CONNECTIONS, routes: routes() });
		holder.product = ctx.product;
		const { session, dash, websiteId, portal, accounts, call, server, settle, connectDatabase } = ctx;
		await connectDatabase();
		const cookie = await session({ kind: 'merchant' });
		await dash(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/connections/accounts`, {
			value: (await portal.issueToken({ websiteId, productId: 'accounts', kind: 'server' })).token,
		});
		accounts.setFailing(true);
		await call('POST', '/v1/actions', { token: server.token });
		await settle();
		accounts.setFailing(false);
		await call('GET', '/v1/server/open', { token: server.token });
		await settle();
		expect(accounts.copies).toHaveLength(0);
		// a route without the database never looks
		await call('POST', '/v1/data-rights/export', { token: server.token, body: { user: { id: 'u9' } } });
		await settle();
		expect(accounts.copies).toHaveLength(1);
	});

	it('exports and deletes one user through the hooks and the kit’s staff records', async () => {
		/** @type {any[]} */
		const seen = [];
		const hooks = {
			exportUser: async (/** @type {any} */ ctx, /** @type {any} */ user) => {
				seen.push(['export', ctx.websiteId, user]);
				return { notes: [{ text: 'hi' }] };
			},
			deleteUser: async (/** @type {any} */ ctx, /** @type {any} */ user) => {
				seen.push(['delete', ctx.websiteId, user]);
				return { deleted: 2, anonymised: 1 };
			},
		};
		const { accounts, handler, server, websiteId, switchOn, connectDatabase, call } = await setup({ hooks });
		expect((await accounts.exportUser({ handler, baseUrl: BASE, token: server.token, user: { id: 'u1' } })).status).toBe(403);
		await connectDatabase();
		await switchOn(['notes', 'inbox']);
		const ticket = await (
			await call('POST', '/v1/tickets', {
				token: server.token,
				body: {
					user: { id: 'u1', name: 'Sam', email: 'sam@x.com' },
					permissions: ['notes.read'],
					origin: 'https://admin.example.com',
				},
			})
		).json();
		await call('GET', '/v1/inbox', { token: ticket.ticket, origin: 'https://admin.example.com' });
		const exported = await accounts.exportUser({ handler, baseUrl: BASE, token: server.token, user: { email: 'sam@x.com' } });
		expect(exported).toEqual({ status: 200, body: { records: { notes: [{ text: 'hi' }] } } });
		const deleted = await accounts.deleteUser({ handler, baseUrl: BASE, token: server.token, user: { id: 'u1' } });
		expect(deleted).toEqual({ status: 200, body: { deleted: 2, anonymised: 1 } });
		expect(seen[0]).toEqual(['export', websiteId, { email: 'sam@x.com' }]);
		expect((await accounts.exportUser({ handler, baseUrl: BASE, token: server.token, user: {} })).status).toBe(422);
	});

	it('include staff records and answer empty without hooks', async () => {
		const { accounts, handler, server, switchOn, connectDatabase, call, settle } = await setup();
		await connectDatabase();
		await switchOn(['notes', 'inbox']);
		const origin = 'https://admin.example.com';
		const ticket = await (
			await call('POST', '/v1/tickets', {
				token: server.token,
				body: { user: { id: 'u1', name: 'Sam', email: 'sam@x.com' }, permissions: ['notes.read'], origin },
			})
		).json();
		await call('GET', '/v1/inbox', { token: ticket.ticket, origin });
		await settle();
		const exported = await accounts.exportUser({
			handler,
			baseUrl: BASE,
			token: server.token,
			user: { email: 'sam@x.com', phone: '+15550100' },
		});
		expect(exported.body.records.staff).toEqual([
			{ id: 'u1', name: 'Sam', email: 'sam@x.com', lastSeenAt: expect.any(String) },
		]);
		expect(
			(await accounts.exportUser({ handler, baseUrl: BASE, token: server.token, user: { phone: '+15550100' } })).body,
		).toEqual({ records: {} });
		expect((await accounts.deleteUser({ handler, baseUrl: BASE, token: server.token, user: { id: 'u1' } })).body).toEqual({
			deleted: 1,
			anonymised: 0,
		});
		expect(
			(await accounts.deleteUser({ handler, baseUrl: BASE, token: server.token, user: { phone: '+15550100' } })).body,
		).toEqual({ deleted: 0, anonymised: 0 });
	});
});

describe('merchant database connection', () => {
	it('fails the live test for unreachable or refused addresses', async () => {
		const { session, dash, websiteId } = await setup();
		const cookie = await session({ kind: 'merchant' });
		const path = `/v1/dashboard/websites/${websiteId}/connections/database`;
		const refused = await (await dash(cookie, 'PUT', path, { value: 'mongodb://10.0.0.1:27017/shop' })).json();
		expect(refused).toMatchObject({ status: 'test_failed', message: expect.stringMatching(/not allowed/) });
		const good = await (await dash(cookie, 'PUT', path, { value: mongoUri(freshDb('conn')) })).json();
		expect(good).toMatchObject({ status: 'connected' });
	});
});
