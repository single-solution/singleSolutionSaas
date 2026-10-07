import { describe, expect, it } from 'vitest';
import { DOMAIN, setup } from './helpers.js';

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

	it('keeps the last status 24 hours while the Portal is unreachable, then answers 503', async () => {
		const { call, server, portal, clock } = await setup();
		expect((await call('GET', '/v1/server/open', { token: server.token })).status).toBe(200);
		portal.setReachable(false);
		clock.advance(23 * 60 * 60_000);
		expect((await call('GET', '/v1/server/open', { token: server.token })).status).toBe(200);
		clock.advance(2 * 60 * 60_000);
		const response = await call('GET', '/v1/server/open', { token: server.token });
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ type: 'https://notes.example.dev/problems/portal_unreachable' });
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

	it('limits rates per website and per visitor and refuses repeated Idempotency-Keys', async () => {
		const { call, browser, switchOn, connectDatabase } = await setup();
		await switchOn(['notes']);
		await connectDatabase();
		const post = (/** @type {Record<string, string>} */ headers = {}) =>
			call('POST', '/v1/notes', { token: browser.token, origin: SITE, body: { text: 'x' }, headers });
		expect((await post({ 'idempotency-key': 'k1' })).status).toBe(200);
		const repeat = await post({ 'idempotency-key': 'k1' });
		expect(repeat.status).toBe(409);
		expect(await repeat.json()).toMatchObject({ type: 'https://notes.example.dev/problems/duplicate_request' });
		expect((await post()).status).toBe(200);
		const limited = await post();
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
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
