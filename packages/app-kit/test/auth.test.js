import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { describe, expect, it } from 'vitest';
import { PRODUCT_DATABASE_OPTIONS, createMongoStore, createProduct, created, defineRoute } from '../src/index.js';
import { createPortalClient } from '../src/portal-client.js';
import { OFFLINE_GRACE_MS, WAITED_FETCH_MS, createStatus } from '../src/status.js';
import { noopLogger } from '../src/logger.js';
import { createMemoryStore } from '../src/testing.js';
import { BASE, DOMAIN, ENCRYPTION_KEY, SECRET, T0, createClock, manifest, productRoutes, setup } from './helpers.js';

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
		const { call, portal, websiteId, browser, server, switchOn, clock, settle } = await setup();
		await switchOn(['notes']);
		const other = await portal.issueToken({ websiteId, productId: 'chat', kind: 'browser' });
		for (const token of [server.token, other.token, 'nope', 'a.b.c']) {
			const response = await call('GET', '/v1/notes', { token, origin: SITE });
			expect(response.status).toBe(401);
		}
		portal.revoke(browser.jti);
		clock.advance(5 * 60_000);
		// fetched with the old status copy, right after the next use (K-19); a token.revoked notice fetches it at once
		expect((await call('GET', '/v1/notes', { token: browser.token, origin: SITE })).status).toBe(200);
		await settle();
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
		const { call, server, portal, websiteId, clock, settle } = await setup();
		const expectStatus = async (/** @type {number} */ code, /** @type {string} */ reason = '') => {
			clock.advance(5 * 60_000);
			// an old copy answers once and is fetched again right after (K-19)
			await call('GET', '/v1/server/open', { token: server.token });
			await settle();
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
		/** @type {Array<() => Promise<unknown>>} */
		const tasks = [];
		const handler = product.handler(productRoutes(), { after: (task) => tasks.push(task) });
		const use = async () => {
			const { status } = await handler(
				new Request(`${BASE}/v1/server/open`, { headers: { authorization: `Bearer ${server.token}` } }),
			);
			while (tasks.length > 0) await /** @type {() => Promise<unknown>} */ (tasks.shift())();
			return status;
		};
		expect(await use()).toBe(200);
		failing = true;
		clock.advance(OFFLINE_GRACE_MS - 6 * 60_000);
		expect(await use()).toBe(200); // the status is fetched again after it, the list fails, still within the grace
		clock.advance(6 * 60_000);
		expect(await use()).toBe(503);
		// a failed fetch is not waited for again within 30 seconds; back as soon as the list is fetched
		failing = false;
		expect(await use()).toBe(503);
		clock.advance(30_000);
		expect(await use()).toBe(200);
	});

	it('answers invalid_token when the Portal does not know the website', async () => {
		const { call, server, portal, websiteId } = await setup();
		portal.deleteWebsite(websiteId);
		expect((await call('GET', '/v1/server/open', { token: server.token, bare: true })).status).toBe(401);
	});
});

describe('status copies never hold a request for the Portal (K-19)', () => {
	const WEBSITE = 'web_0123456789abcdefghjkmnpq';
	/** @param {number} at */
	const statusAt = (at) => ({
		websiteId: WEBSITE,
		merchantId: 'mer_0123456789abcdefghjkmnpq',
		merchantName: 'Shop',
		domain: DOMAIN,
		status: /** @type {const} */ ('active'),
		graceEndsAt: null,
		todayMillicredits: 0,
		featuresVersion: 1,
		validUntil: new Date(at + 5 * 60_000).toISOString(),
	});
	/** A Portal whose answers the test releases; it records each call and its deadline. */
	const slowPortal = () => {
		/** @type {Array<{ what: string, timeoutMs: number | undefined, answer: (value?: unknown) => void, refuse: (error: unknown) => void }>} */
		const calls = [];
		/** @param {string} what @param {{ timeoutMs?: number }} [options] */
		const pending = (what, options = {}) =>
			new Promise((answer, refuse) => {
				calls.push({ what, timeoutMs: options.timeoutMs, answer, refuse });
			});
		const client = /** @type {any} */ ({
			status: (/** @type {string} */ _id, /** @type {any} */ options) => pending('status', options),
			revocations: (/** @type {any} */ _cursor, /** @type {any} */ options) => pending('revocations', options),
		});
		return { calls, client };
	};
	const flush = () => new Promise((resolve) => setTimeout(resolve, 1));

	it('use an old copy at once and fetch it again after the response, one fetch per website at a time', async () => {
		const clock = createClock();
		const store = createMemoryStore({ now: clock.now });
		const portal = slowPortal();
		const status = createStatus({ store, client: () => portal.client, now: clock.now, logger: noopLogger });
		// no copy at all: the use waits, with the short deadline
		const first = status.serving(WEBSITE);
		await flush();
		expect(portal.calls.map((c) => [c.what, c.timeoutMs])).toEqual([['status', WAITED_FETCH_MS]]);
		expect(WAITED_FETCH_MS).toBe(5_000);
		portal.calls[0]?.answer(statusAt(clock.now()));
		expect(await first).toMatchObject({ ok: true });
		// the revocation list is fetched after it, never waited for
		await flush();
		expect(portal.calls.map((c) => c.what)).toEqual(['status', 'revocations']);
		portal.calls[1]?.answer({ tokenIds: [], cursor: 'c1' });

		// an old copy within the offline grace: answered at once, fetched again after the response
		clock.advance(10 * 60_000);
		/** @type {Array<() => Promise<unknown>>} */
		const after = [];
		const uses = await Promise.all([1, 2, 3].map(() => status.serving(WEBSITE, { after: (task) => after.push(task) })));
		expect(uses.every((use) => use.ok)).toBe(true);
		expect(after).toHaveLength(1);
		expect(portal.calls).toHaveLength(2);
		const refresh = Promise.all(after.map((task) => task()));
		// a use without `after` meanwhile shares the fetch already running
		const detached = status.lookup(WEBSITE, { wait: true });
		await flush();
		expect(portal.calls.slice(2).map((c) => [c.what, c.timeoutMs])).toEqual([['status', undefined]]);
		portal.calls[2]?.answer(statusAt(clock.now()));
		expect(await detached).toMatchObject({ ok: true, fetchedAt: clock.now() });
		await flush();
		portal.calls[3]?.answer({ tokenIds: [], cursor: 'c2' });
		await refresh;
		expect(portal.calls.map((c) => c.what)).toEqual(['status', 'revocations', 'status', 'revocations']);

		// the Portal down: a failed fetch is tried again after a later use, at most every 30 seconds per website
		clock.advance(10 * 60_000);
		after.length = 0;
		await status.serving(WEBSITE, { after: (task) => after.push(task) });
		await status.serving(WEBSITE, { after: (task) => after.push(task) });
		expect(after).toHaveLength(1);
		const failed = /** @type {() => Promise<unknown>} */ (after[0])();
		await flush();
		portal.calls[4]?.refuse(new Error('down'));
		await failed;
		clock.advance(30_000);
		expect((await status.serving(WEBSITE, { after: (task) => after.push(task) })).ok).toBe(true);
		expect(after).toHaveLength(2);
		// without `after` (a product calling serving itself) the fetch starts at once and is not waited for
		clock.advance(30_000);
		expect((await status.serving(WEBSITE)).ok).toBe(true);
		await flush();
		expect(portal.calls.map((c) => c.what).slice(5)).toEqual(['status']);
		portal.calls[5]?.refuse(
			Object.assign(new Error('gone'), { name: 'AppKitError', code: 'portal_refused', details: { status: 404 } }),
		);
		await flush();
		expect(await store.get('status', WEBSITE)).toBeNull();
	});

	it('give a Portal call the deadline it asks for', async () => {
		const portal = createPortalClient({
			portalUrl: 'https://portal.test',
			productId: 'notes',
			signer: { kid: 'k1', alg: 'EdDSA', sign: async () => new Uint8Array(64) },
			fetch: (_url, init) =>
				new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
		});
		const started = Date.now();
		await expect(portal.status(WEBSITE, { timeoutMs: 20 })).rejects.toMatchObject({ code: 'portal_unreachable' });
		await expect(portal.revocations(null, { timeoutMs: 20 })).rejects.toMatchObject({ code: 'portal_unreachable' });
		expect(Date.now() - started).toBeLessThan(2_000);
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

describe('repeated requests (K-14)', () => {
	it('never replays one signed-in shopper’s answer to another who sends the same Idempotency-Key', async () => {
		const { call, browser, switchOn, connectDatabase } = await setup();
		await switchOn(['notes']);
		await connectDatabase();
		const post = (/** @type {string} */ signIn) =>
			call('POST', '/v1/notes', {
				token: browser.token,
				origin: SITE,
				body: { text: 'x' },
				headers: { 'idempotency-key': 'k2', 'ss-sign-in': signIn },
			});
		expect((await post('shopper-a')).status).toBe(200);
		const other = await post('shopper-b');
		expect(other.status).toBe(409);
		expect(await other.json()).toMatchObject({ type: 'https://notes.example.dev/problems/duplicate_request' });
		const same = await post('shopper-a');
		expect([same.status, same.headers.get('idempotent-replayed')]).toEqual([200, 'true']);
	});

	it('never replays one anonymous visitor’s answer to another address that sends the same Idempotency-Key and body (SR-1-8)', async () => {
		const { call, browser, switchOn, connectDatabase, clock } = await setup();
		await switchOn(['notes']);
		await connectDatabase();
		/** @param {string} ip @param {Record<string, string>} [more] */
		const post = (ip, more = {}) =>
			call('POST', '/v1/notes', {
				token: browser.token,
				origin: SITE,
				body: { text: 'x' },
				headers: { 'idempotency-key': 'order-1', 'x-forwarded-for': ip, 'ss-guest': 'guest-1', ...more },
			});
		expect((await post('198.51.100.1')).status).toBe(200);
		// a guessable key, the same guest key and body, but another address: not the first visitor's stored answer
		const other = await post('198.51.100.2');
		expect(other.status).toBe(409);
		expect(await other.json()).toMatchObject({ type: 'https://notes.example.dev/problems/duplicate_request' });
		// the first visitor's own repeat still gets the first answer
		const same = await post('198.51.100.1');
		expect([same.status, same.headers.get('idempotent-replayed')]).toEqual([200, 'true']);
		// a signed-in shopper is named by the sign-in, so a changed network is still the same request
		clock.advance(61_000);
		expect((await post('198.51.100.1', { 'idempotency-key': 'order-2', 'ss-sign-in': 'shopper-a' })).status).toBe(200);
		const moved = await post('198.51.100.9', { 'idempotency-key': 'order-2', 'ss-sign-in': 'shopper-a' });
		expect([moved.status, moved.headers.get('idempotent-replayed')]).toEqual([200, 'true']);
	});
});

describe('request bodies (SR-1-3)', () => {
	const routes = [
		...productRoutes(),
		defineRoute({
			method: 'POST',
			path: '/v1/body/browser',
			auth: 'browser',
			database: false,
			handler: (ctx) => ({ got: ctx.body }),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/body/server',
			auth: 'server',
			runtime: true,
			database: false,
			handler: (ctx) => ({ got: ctx.body }),
		}),
		defineRoute({ method: 'POST', path: '/v1/body/ticket', auth: 'ticket', permission: 'notes.read', handler: () => ({}) }),
		defineRoute({ method: 'POST', path: '/v1/body/none', auth: 'none', handler: (ctx) => ({ got: ctx.body }) }),
	];
	/**
	 * A POST whose body is a stream that counts how often it was pulled (nothing is pulled until someone reads it).
	 * @param {(request: Request) => Promise<Response>} handler
	 * @param {string} path
	 * @param {Record<string, string>} headers
	 */
	const post = async (handler, path, headers) => {
		const chunk = new TextEncoder().encode(JSON.stringify({ a: 1 }));
		let pulls = 0;
		const body = new ReadableStream(
			{
				pull: (controller) => {
					pulls += 1;
					controller.enqueue(chunk);
					controller.close();
				},
			},
			{ highWaterMark: 0 },
		);
		const response = await handler(
			new Request(
				`${BASE}${path}`,
				/** @type {RequestInit} */ ({
					method: 'POST',
					headers: { 'content-type': 'application/json', ...headers },
					body,
					duplex: 'half',
				}),
			),
		);
		return { response, pulls: () => pulls };
	};

	it('are never read for a call with no or a bad token: the token is checked first', async () => {
		const { handler, browser } = await setup({ routes });
		/** @type {Array<Record<string, string>>} */
		const bad = [{}, { authorization: 'Bearer nonsense' }, { authorization: `Bearer ${browser.token}x` }];
		for (const route of ['/v1/body/browser', '/v1/body/server', '/v1/body/ticket']) {
			for (const headers of bad) {
				const refused = await post(handler, route, { origin: SITE, ...headers });
				expect([route, refused.response.status, refused.pulls()]).toEqual([route, 401, 0]);
			}
		}
		// a token of the wrong kind for the route is refused before the body as well
		const wrongKind = await post(handler, '/v1/body/server', { authorization: `Bearer ${browser.token}` });
		expect([wrongKind.response.status, wrongKind.pulls()]).toEqual([401, 0]);
		// an oversize declared body with a bad token is a 401 too, not a 413
		const big = await post(handler, '/v1/body/browser', {
			origin: SITE,
			authorization: 'Bearer nonsense',
			'content-length': '99999999',
		});
		expect([big.response.status, big.pulls()]).toEqual([401, 0]);
	});

	it('are still read, capped and parsed after a good token, and for routes without a token', async () => {
		const { handler, browser, server } = await setup({ routes });
		const browserCall = await post(handler, '/v1/body/browser', { origin: SITE, authorization: `Bearer ${browser.token}` });
		expect([browserCall.response.status, await browserCall.response.json(), browserCall.pulls()]).toEqual([
			200,
			{ got: { a: 1 } },
			1,
		]);
		const serverCall = await post(handler, '/v1/body/server', { authorization: `Bearer ${server.token}` });
		expect([serverCall.response.status, await serverCall.response.json()]).toEqual([200, { got: { a: 1 } }]);
		const tooBig = await post(handler, '/v1/body/browser', {
			origin: SITE,
			authorization: `Bearer ${browser.token}`,
			'content-length': '99999999',
		});
		expect([tooBig.response.status, tooBig.pulls()]).toEqual([413, 0]);
		// a route with no token reads its (small) body as before
		const open = await post(handler, '/v1/body/none', {});
		expect([open.response.status, await open.response.json(), open.pulls()]).toEqual([200, { got: { a: 1 } }, 1]);
	});
});

describe('rate limits (SE-2)', () => {
	it('one address flooding a route cannot lock out other visitors: the website window counts only what passed', async () => {
		const routes = [
			...productRoutes(),
			defineRoute({
				method: 'GET',
				path: '/v1/catalog',
				auth: 'browser',
				database: false,
				rateLimit: [
					{ limit: 5, windowSeconds: 60 },
					{ limit: 2, windowSeconds: 60, per: 'visitor' },
				],
				handler: () => ({ items: [] }),
			}),
		];
		const { call, browser } = await setup({ routes });
		const get = async (/** @type {string} */ ip) =>
			(await call('GET', '/v1/catalog', { token: browser.token, origin: SITE, headers: { 'x-forwarded-for': ip } })).status;
		const flood = [];
		for (let i = 0; i < 10; i += 1) flood.push(await get('198.51.100.7'));
		expect(flood).toEqual([200, 200, 429, 429, 429, 429, 429, 429, 429, 429]);
		expect(await get('203.0.113.9')).toBe(200);
		// the website window still holds: 5 passed requests in the minute, then every address waits
		expect(await get('203.0.113.10')).toBe(200);
		expect(await get('203.0.113.11')).toBe(200);
		expect(await get('203.0.113.12')).toBe(429);
	});

	it('the visitor is the address the hosting layer saw: a first X-Forwarded-For value the caller writes does not change the bucket (SR-1-1)', async () => {
		const routes = [
			...productRoutes(),
			defineRoute({
				method: 'GET',
				path: '/v1/catalog',
				auth: 'browser',
				database: false,
				rateLimit: { limit: 2, windowSeconds: 60, per: 'visitor' },
				handler: () => ({ items: [] }),
			}),
		];
		const { call, browser } = await setup({ routes });
		/** @param {Record<string, string>} headers */
		const get = async (headers) => (await call('GET', '/v1/catalog', { token: browser.token, origin: SITE, headers })).status;
		// the proxy appended the real address; the caller wrote a new first value on every request
		const statuses = [];
		for (let i = 0; i < 5; i += 1) statuses.push(await get({ 'x-forwarded-for': `10.250.0.${i}, 198.51.100.7` }));
		expect(statuses).toEqual([200, 200, 429, 429, 429]);
		// the hosting platform's own header wins over anything written in X-Forwarded-For
		const real = [];
		for (let i = 0; i < 4; i += 1) real.push(await get({ 'x-real-ip': '203.0.113.50', 'x-forwarded-for': `10.251.0.${i}` }));
		expect(real).toEqual([200, 200, 429, 429]);
		// another address is another bucket
		expect(await get({ 'x-real-ip': '203.0.113.51' })).toBe(200);
		// nothing present: one shared bucket
		expect([await get({}), await get({}), await get({})]).toEqual([200, 200, 429]);
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
				runtime: true,
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
				runtime: true,
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
				runtime: true,
				handler: async (ctx) => {
					await (await ctx.data()).collection('orders').findOne({ websiteId: ctx.websiteId });
					return { ok: true };
				},
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/slow',
				auth: 'server',
				runtime: true,
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

	it('use a product database that could not be reached when the instance started as soon as it is back', async () => {
		// a database of its own (the shared one serves every test file), stopped while the instance starts; its client
		// waits 0.3 s for a server, not 5 s
		const mongod = await MongoMemoryServer.create();
		const client = new MongoClient(mongod.getUri('kit_product'), {
			...PRODUCT_DATABASE_OPTIONS,
			serverSelectionTimeoutMS: 300,
		});
		try {
			await mongod.stop({ doCleanup: false });
			const { portal, handler, call, server, switchOn } = await setup({
				store: createMongoStore({ db: client.db(), now: () => T0 }),
				connect: false,
			});
			const connect = () => portal.connect({ handler, baseUrl: BASE, secret: SECRET });
			await expect(connect()).rejects.toThrow(/^connect failed with 503: .*database_unavailable/);
			await mongod.start(true);
			// the same request on the same instance, no restart (mongodb 6.x closed the client's first topology)
			await connect();
			await switchOn(['notes']);
			expect((await call('GET', '/v1/features', { token: server.token })).status).toBe(200);
		} finally {
			await client.close();
			await mongod.stop();
		}
	}, 30_000);
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
