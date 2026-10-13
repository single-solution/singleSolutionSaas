import { MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { createProduct, created, defineRoute } from '../src/index.js';
import { OFFLINE_GRACE_MS } from '../src/status.js';
import { createMemoryStore } from '../src/testing.js';
import { BASE, DOMAIN, ENCRYPTION_KEY, SECRET, T0, manifest, productRoutes, setup } from './helpers.js';

const SITE = `https://${DOMAIN}`;

describe('browser tokens', () => {
	it('work only from the exact https domain or a local origin, with CORS for that origin', async () => {
		const { call, browser, switchOn } = await setup();
		await switchOn(['notes']);
		const ok = await call('GET', '/v1/notes', { token: browser.token, origin: SITE });
		expect(ok.status).toBe(200);
		expect(ok.headers.get('access-control-allow-origin')).toBe(SITE);
		expect((await call('GET', '/v1/notes', { token: browser.token, origin: 'http://localhost:5173' })).status).toBe(200);
		for (const origin of [
			'https://www.shop.example.com',
			`http://${DOMAIN}`,
			`${SITE}:8443`,
			'https://evil.example.com',
			'null',
		]) {
			const refused = await call('GET', '/v1/notes', { token: browser.token, origin });
			expect(refused.status).toBe(401);
			expect(refused.headers.get('access-control-allow-origin')).toBeNull();
			expect(await refused.json()).toMatchObject({ type: 'https://notes.example.dev/problems/invalid_token' });
		}
		expect((await call('GET', '/v1/notes', { token: browser.token })).status).toBe(401);
	});

	it('refuse server tokens, other products, revoked ids and garbage with the same error', async () => {
		const { call, portal, websiteId, browser, server, switchOn, clock } = await setup();
		await switchOn(['notes']);
		const other = await portal.issueToken({ websiteId, productId: 'chat', kind: 'browser' });
		for (const token of [server.token, other.token, 'nope', 'a.b.c']) {
			const response = await call('GET', '/v1/notes', { token, origin: SITE });
			expect(response.status).toBe(401);
		}
		portal.revoke(browser.jti);
		clock.advance(5 * 60_000);
		expect((await call('GET', '/v1/notes', { token: browser.token, origin: SITE })).status).toBe(401);
	});

	it('are never read from the query string', async () => {
		const { call, browser, switchOn } = await setup();
		await switchOn(['notes']);
		expect((await call('GET', `/v1/notes?token=${browser.token}`, { origin: SITE })).status).toBe(401);
		expect((await call('GET', '/widget.js')).status).toBe(200);
	});

	it('record the widget as installed only from the real domain', async () => {
		const { call, browser, websiteId, switchOn, settle, store } = await setup();
		await switchOn(['notes']);
		await call('GET', '/v1/notes', { token: browser.token, origin: 'http://localhost:3000' });
		await settle();
		expect(await store.get('widget', websiteId)).toBeNull();
		await call('GET', '/v1/notes', { token: browser.token, origin: SITE });
		await settle();
		expect(await store.get('widget', websiteId)).toMatchObject({ websiteId });
	});
});

describe('server tokens', () => {
	it('work without an Origin, send no CORS and are refused with one', async () => {
		const { call, server, browser } = await setup();
		const ok = await call('GET', '/v1/server/open', { token: server.token });
		expect(ok.status).toBe(200);
		expect(ok.headers.get('access-control-allow-origin')).toBeNull();
		expect((await call('GET', '/v1/server/open', { token: server.token, origin: SITE })).status).toBe(401);
		expect((await call('GET', '/v1/server/open', { token: browser.token })).status).toBe(401);
	});
});

describe('status on use', () => {
	it('obeys active, grace, stopped, suspended and removed', async () => {
		const { call, server, portal, websiteId, clock } = await setup();
		const expectStatus = async (/** @type {number} */ code, /** @type {string} */ reason = '') => {
			clock.advance(5 * 60_000);
			const response = await call('GET', '/v1/server/open', { token: server.token });
			expect(response.status).toBe(code);
			if (reason)
				expect(await response.json()).toMatchObject({
					reason,
					type: 'https://notes.example.dev/problems/product_unavailable',
				});
		};
		await expectStatus(200);
		portal.setStatus(websiteId, { status: 'grace', graceEndsAt: new Date(clock.now() + 60 * 60_000).toISOString() });
		await expectStatus(200);
		portal.setStatus(websiteId, { status: 'stopped', graceEndsAt: null });
		await expectStatus(403, 'stopped');
		portal.setStatus(websiteId, { status: 'suspended' });
		await expectStatus(403, 'suspended');
		portal.setStatus(websiteId, { status: 'removed' });
		await expectStatus(403, 'removed');
	});

	it('treats a passed graceEndsAt as stopped and caches the status for at most 5 minutes', async () => {
		const { call, server, portal, websiteId, clock } = await setup();
		portal.setStatus(websiteId, { status: 'grace', graceEndsAt: new Date(clock.now() + 60_000).toISOString() });
		expect((await call('GET', '/v1/server/open', { token: server.token })).status).toBe(200);
		const statusCalls = () => portal.calls.filter((c) => c.path.endsWith('/status')).length;
		const before = statusCalls();
		clock.advance(61_000);
		const stopped = await call('GET', '/v1/server/open', { token: server.token });
		expect(stopped.status).toBe(403);
		expect(statusCalls()).toBe(before);
	});

	it('keeps the last status 6 hours while the Portal is unreachable, then answers 503 (K-21)', async () => {
		const { call, server, portal, clock } = await setup();
		expect(OFFLINE_GRACE_MS).toBe(6 * 60 * 60_000);
		expect((await call('GET', '/v1/server/open', { token: server.token })).status).toBe(200);
		portal.setReachable(false);
		clock.advance(OFFLINE_GRACE_MS - 60_000);
		expect((await call('GET', '/v1/server/open', { token: server.token })).status).toBe(200);
		clock.advance(60_000);
		const response = await call('GET', '/v1/server/open', { token: server.token });
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ type: 'https://notes.example.dev/problems/portal_unreachable' });
		// back as soon as the Portal answers
		portal.setReachable(true);
		expect((await call('GET', '/v1/server/open', { token: server.token })).status).toBe(200);
	});

	it('refuses every use while the revocation list could not be fetched for longer than the grace, even with a status (K-21)', async () => {
		const { store, portal, clock, server } = await setup();
		let failing = false;
		const product = createProduct({
			manifest: manifest(),
			config: { mongodbUri: '', connectSecret: SECRET, encryptionKey: ENCRYPTION_KEY },
			store,
			now: clock.now,
			nodeEnv: 'test',
			fetch: (url, init) =>
				failing && String(url).includes('/v1/product/revocations')
					? Promise.reject(new TypeError('fetch failed'))
					: portal.fetch(url, init),
		});
		const handler = product.handler(productRoutes());
		const use = async () =>
			(await handler(new Request(`${BASE}/v1/server/open`, { headers: { authorization: `Bearer ${server.token}` } }))).status;
		expect(await use()).toBe(200);
		failing = true;
		clock.advance(OFFLINE_GRACE_MS - 6 * 60_000);
		expect(await use()).toBe(200); // a fresh status, the list still within the grace
		clock.advance(6 * 60_000);
		expect(await use()).toBe(503);
		failing = false;
		clock.advance(5 * 60_000 + 1);
		expect(await use()).toBe(200);
	});

	it('answers invalid_token when the Portal does not know the website', async () => {
		const { call, server, portal, websiteId } = await setup();
		portal.deleteWebsite(websiteId);
		expect((await call('GET', '/v1/server/open', { token: server.token })).status).toBe(401);
	});
});

describe('features and the merchant database', () => {
	it('answers feature_off while a feature is off and database_not_connected until connected', async () => {
		const { call, server, browser, switchOn, connectDatabase } = await setup();
		const off = await call('GET', '/v1/server/notes', { token: server.token });
		expect(off.status).toBe(403);
		expect(await off.json()).toMatchObject({ type: 'https://notes.example.dev/problems/feature_off' });
		await switchOn(['notes']);
		expect((await call('GET', '/v1/server/notes', { token: server.token })).status).toBe(200);
		const noDb = await call('POST', '/v1/notes', { token: browser.token, origin: SITE, body: { text: 'hi' } });
		expect(noDb.status).toBe(403);
		expect(await noDb.json()).toMatchObject({ type: 'https://notes.example.dev/problems/database_not_connected' });
		await connectDatabase();
		expect((await call('POST', '/v1/notes', { token: browser.token, origin: SITE, body: { text: 'hi' } })).status).toBe(200);
	});

	it('limits rates per website and per visitor and answers a repeated Idempotency-Key with the first answer', async () => {
		const { call, browser, switchOn, connectDatabase } = await setup();
		await switchOn(['notes']);
		await connectDatabase();
		const post = (/** @type {Record<string, string>} */ headers = {}) =>
			call('POST', '/v1/notes', { token: browser.token, origin: SITE, body: { text: 'x' }, headers });
		expect((await post({ 'idempotency-key': 'k1' })).status).toBe(200);
		const repeat = await post({ 'idempotency-key': 'k1' });
		expect([repeat.status, repeat.headers.get('idempotent-replayed')]).toEqual([200, 'true']);
		expect(repeat.headers.get('access-control-allow-origin')).toBe(SITE);
		expect(await repeat.json()).toEqual({ saved: true });
		expect((await post()).status).toBe(200);
		const limited = await post();
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
	});
});

describe('idempotent routes (K-14)', () => {
	/** Wait (real time) until a condition holds. @param {() => boolean} done */
	const until = async (done) => {
		while (!done()) await new Promise((resolve) => setTimeout(resolve, 1));
	};
	/** A gate a test opens. */
	const gate = () => {
		/** @type {() => void} */
		let open = () => {};
		const opened = new Promise((resolve) => {
			open = () => resolve(undefined);
		});
		return { open, opened };
	};

	it('replay the first answer to a repeat, refuse another request under the key and free it after a failure', async () => {
		let runs = 0;
		let failNext = false;
		let wait = gate();
		wait.open();
		const routes = [
			...productRoutes(),
			defineRoute({
				method: 'POST',
				path: '/v1/orders',
				auth: 'server',
				database: false,
				idempotent: true,
				handler: async (ctx) => {
					runs += 1;
					const { opened } = wait;
					await opened;
					if (failNext) {
						failNext = false;
						throw new Error('lost');
					}
					return created(
						{ n: runs, text: /** @type {any} */ (ctx.body).text },
						{ location: `/v1/orders/${runs}`, headers: { 'Set-Cookie': 'x=1' } },
					);
				},
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/big',
				auth: 'server',
				database: false,
				idempotent: true,
				handler: () => {
					runs += 1;
					return { text: 'x'.repeat(70_000) };
				},
			}),
		];
		const { call, server, clock } = await setup({ routes });
		const post = (/** @type {string} */ path, /** @type {string} */ key, /** @type {unknown} */ body = { text: 'a' }) =>
			call('POST', path, { token: server.token, body, headers: { 'idempotency-key': key } });

		const first = await post('/v1/orders', 'k1');
		expect([first.status, first.headers.get('location'), first.headers.get('set-cookie')]).toEqual([
			201,
			'/v1/orders/1',
			'x=1',
		]);
		expect(first.headers.get('idempotent-replayed')).toBeNull();
		const again = await post('/v1/orders', 'k1');
		expect([again.status, again.headers.get('location'), again.headers.get('idempotent-replayed')]).toEqual([
			201,
			'/v1/orders/1',
			'true',
		]);
		expect(again.headers.get('set-cookie')).toBeNull();
		expect(await again.json()).toEqual({ n: 1, text: 'a' });
		expect(runs).toBe(1);
		// another body, address or actor under the same key is another request
		const other = await post('/v1/orders', 'k1', { text: 'b' });
		expect([other.status, (await other.json()).type]).toEqual([409, 'https://notes.example.dev/problems/duplicate_request']);
		const otherActor = await call('POST', '/v1/orders', {
			token: server.token,
			body: { text: 'a' },
			headers: { 'idempotency-key': 'k1', 'ss-actor-id': 'usr_1', 'ss-actor-name': 'Ana' },
		});
		expect(otherActor.status).toBe(409);
		expect(runs).toBe(1);

		// a repeat while the first still runs: 409 in_progress, then the answer once it finished
		wait = gate();
		const running = post('/v1/orders', 'k2');
		await until(() => runs === 2);
		const early = await post('/v1/orders', 'k2');
		expect([early.status, early.headers.get('retry-after')]).toEqual([409, '1']);
		expect((await early.json()).type).toBe('https://notes.example.dev/problems/in_progress');
		wait.open();
		expect((await running).status).toBe(201);
		expect(await (await post('/v1/orders', 'k2')).json()).toEqual({ n: 2, text: 'a' });

		// a failure frees the key: the retry runs again
		failNext = true;
		expect((await post('/v1/orders', 'k3')).status).toBe(500);
		expect(await (await post('/v1/orders', 'k3')).json()).toEqual({ n: 4, text: 'a' });

		// an answer too large to keep: a repeat is refused as before
		expect((await post('/v1/big', 'k4')).status).toBe(200);
		expect((await post('/v1/big', 'k4')).status).toBe(409);
		expect(runs).toBe(5);

		// a request that never finished (its function stopped) holds the key 5 minutes; answers are kept 24 hours
		wait = gate();
		void post('/v1/orders', 'k5');
		await until(() => runs === 6);
		expect((await post('/v1/orders', 'k5')).status).toBe(409);
		clock.advance(5 * 60_000);
		wait = gate();
		wait.open();
		expect((await post('/v1/orders', 'k5')).status).toBe(201);
		expect(runs).toBe(7);
		clock.advance(24 * 60 * 60_000);
		expect(await (await post('/v1/orders', 'k1')).json()).toEqual({ n: 8, text: 'a' });
	});
});

describe('databases that cannot be reached (K-16)', () => {
	it('answer 503 database_unavailable, never 500, for the merchant and the product database', async () => {
		let down = false;
		let productDown = false;
		const base = createMemoryStore({ now: () => T0 });
		/** @type {any} */
		const store = {
			...base,
			get: async (/** @type {any} */ collection, /** @type {string} */ id) => {
				if (productDown) throw Object.assign(new Error('connection timed out'), { name: 'MongoNetworkTimeoutError' });
				return base.get(collection, id);
			},
		};
		const routes = [
			...productRoutes(),
			defineRoute({
				method: 'GET',
				path: '/v1/orders',
				auth: 'server',
				handler: async (ctx) => {
					await (await ctx.data()).collection('orders').findOne({ websiteId: ctx.websiteId });
					return { ok: true };
				},
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/slow',
				auth: 'server',
				database: false,
				handler: () => {
					throw Object.assign(new Error('operation exceeded time limit'), { code: 50 });
				},
			}),
		];
		const { call, server, connectDatabase, entries } = await setup({
			routes,
			store,
			data: {
				createClient: (/** @type {string} */ uri, /** @type {any} */ options) =>
					new MongoClient(
						down ? 'mongodb://127.0.0.1:1/x' : uri,
						down ? { ...options, serverSelectionTimeoutMS: 200 } : options,
					),
			},
		});
		await connectDatabase();
		down = true;
		const merchant = await call('GET', '/v1/orders', { token: server.token });
		expect([merchant.status, merchant.headers.get('retry-after')]).toEqual([503, '5']);
		expect((await merchant.json()).type).toBe('https://notes.example.dev/problems/database_unavailable');
		const slow = await call('GET', '/v1/slow', { token: server.token });
		expect(slow.status).toBe(503);
		productDown = true;
		const product = await call('GET', '/v1/server/open', { token: server.token });
		expect([product.status, (await product.json()).type]).toEqual([
			503,
			'https://notes.example.dev/problems/database_unavailable',
		]);
		expect(entries.filter((e) => e.level === 'error')).toEqual([]);
	});
});

describe('request handling', () => {
	it('answers 404, 405, preflights, bad bodies and handler failures as problems', async () => {
		const { call } = await setup();
		expect((await call('GET', '/nowhere')).status).toBe(404);
		const notAllowed = await call('DELETE', '/docs');
		expect(notAllowed.status).toBe(405);
		expect(notAllowed.headers.get('allow')).toBe('GET');
		const preflight = await call('OPTIONS', '/v1/notes', { origin: SITE });
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get('access-control-allow-origin')).toBe(SITE);
		const serverPreflight = await call('OPTIONS', '/v1/server/open', { origin: SITE });
		expect(serverPreflight.headers.get('access-control-allow-origin')).toBeNull();
		expect((await call('OPTIONS', '/nowhere')).status).toBe(404);
		expect((await call('POST', '/v1/raw', { body: 'x'.repeat(20) })).status).toBe(413);
		expect(await (await call('POST', '/v1/raw', { body: 'abc', headers: { 'content-type': 'text/plain' } })).json()).toEqual({
			raw: 'abc',
		});
		expect((await call('POST', '/v1/echo', { body: 'not json' })).status).toBe(400);
		expect((await call('POST', '/v1/echo', { body: '{}', headers: { 'content-type': 'text/plain' } })).status).toBe(415);
		expect(await (await call('POST', '/v1/echo', { body: { a: 1 } })).json()).toEqual({ body: { a: 1 } });
		const failed = await call('GET', '/v1/fail', { headers: { 'x-request-id': 'req-1' } });
		expect(failed.status).toBe(500);
		expect(await failed.json()).toMatchObject({ requestId: 'req-1', instance: '/v1/fail' });
		expect((await call('HEAD', '/docs')).status).toBe(200);
	});
});
