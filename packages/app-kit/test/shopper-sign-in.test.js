import { describe, expect, it } from 'vitest';
import { defineRoute } from '../src/index.js';
import { createAccountsDouble } from '../src/testing.js';
import { DOMAIN, productRoutes, setup } from './helpers.js';

const SITE = `https://${DOMAIN}`;
const IP = { 'ss-visitor-ip': '203.0.113.9' };

/** Routes that show who the request acts for. */
const routes = () => [
	...productRoutes(),
	defineRoute({
		method: 'GET',
		path: '/v1/visitor/me',
		auth: 'browser',
		feature: 'notes',
		database: false,
		handler: async (ctx) => {
			const found = await ctx.signIn();
			return {
				signIn: found === null ? null : found.ok ? { id: found.user.id, email: found.user.email ?? null } : found,
				actor: ctx.actor,
			};
		},
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/visitor/claims',
		auth: 'browser',
		feature: 'notes',
		database: false,
		handler: async (ctx) => {
			const found = await ctx.signIn();
			if (!found?.ok) return { signedIn: false };
			return {
				phoneVerified: found.claims.phone_verified === true,
				emailVerified: found.claims.email_verified === true,
				token: found.token,
			};
		},
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/visitor/orders',
		auth: 'browser',
		feature: 'notes',
		database: false,
		idempotent: true,
		handler: async (ctx) => {
			const found = await ctx.signIn();
			return { placedBy: found?.ok ? found.user.id : null };
		},
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/server/me',
		auth: 'server',
		runtime: true,
		database: false,
		handler: async (ctx) => ({ signIn: (await ctx.signIn()) === null ? null : 'read' }),
	}),
];

/** A connected product whose website is linked to Accounts by the Portal (the keys of the sign-ins). */
const connected = async () => {
	const ctx = await setup({ routes: routes() });
	await ctx.switchOn(['notes']);
	await ctx.link('accounts');
	return ctx;
};

describe('acting as a signed-in shopper from the website’s server (SS-Sign-In on a server-token call)', () => {
	it('acts as the shopper of a valid sign-in, exactly as a browser call with that sign-in would', async () => {
		const { call, server, browser, accounts, websiteId } = await connected();
		const signIn = await accounts.signIn({ websiteId, sub: 'usr_shopper1', email: 'sana@example.com' });
		const fromServer = await call('GET', '/v1/visitor/me', { token: server.token, headers: { ...IP, 'ss-sign-in': signIn } });
		expect(fromServer.status).toBe(200);
		expect(await fromServer.json()).toEqual({ signIn: { id: 'usr_shopper1', email: 'sana@example.com' }, actor: null });
		const fromBrowser = await call('GET', '/v1/visitor/me', {
			token: browser.token,
			origin: SITE,
			headers: { 'ss-sign-in': signIn },
		});
		expect((await fromBrowser.json()).signIn).toEqual({ id: 'usr_shopper1', email: 'sana@example.com' });
		const write = await call('POST', '/v1/visitor/orders', {
			token: server.token,
			body: {},
			headers: { ...IP, 'ss-sign-in': signIn },
		});
		expect(await write.json()).toEqual({ placedBy: 'usr_shopper1' });
	});

	it('hands the verified claims and the sign-in itself to the route', async () => {
		const { call, server, accounts, websiteId } = await connected();
		const signIn = await accounts.signIn({ websiteId, sub: 'usr_a', phone: '+15550100', phone_verified: true });
		const body = await (
			await call('GET', '/v1/visitor/claims', { token: server.token, headers: { ...IP, 'ss-sign-in': signIn } })
		).json();
		expect(body).toEqual({ phoneVerified: true, emailVerified: false, token: signIn });
	});

	it('answers a call without a sign-in as a visitor who is not signed in', async () => {
		const { call, server } = await connected();
		const none = await call('GET', '/v1/visitor/me', { token: server.token, headers: IP });
		expect(none.status).toBe(200);
		expect(await none.json()).toEqual({ signIn: null, actor: null });
		const empty = await call('GET', '/v1/visitor/me', { token: server.token, headers: { ...IP, 'ss-sign-in': '  ' } });
		expect((await empty.json()).signIn).toBeNull();
	});

	it('refuses a sign-in made for another website', async () => {
		const { call, server, accounts } = await connected();
		const other = await accounts.signIn({ websiteId: 'web_someone_else', sub: 'usr_shopper1' });
		const refused = await call('GET', '/v1/visitor/me', { token: server.token, headers: { ...IP, 'ss-sign-in': other } });
		expect(refused.status).toBe(401);
		expect(await refused.json()).toMatchObject({
			type: 'https://notes.example.dev/problems/invalid_sign_in',
			status: 401,
			cause: 'audience',
		});
		const write = await call('POST', '/v1/visitor/orders', {
			token: server.token,
			body: {},
			headers: { ...IP, 'ss-sign-in': other },
		});
		expect(write.status).toBe(401);
	});

	it('refuses an expired sign-in', async () => {
		const { call, server, accounts, websiteId, clock } = await connected();
		const signIn = await accounts.signIn({ websiteId, sub: 'usr_shopper1' });
		expect(
			(await call('GET', '/v1/visitor/me', { token: server.token, headers: { ...IP, 'ss-sign-in': signIn } })).status,
		).toBe(200);
		clock.advance(16 * 60_000);
		const refused = await call('GET', '/v1/visitor/me', { token: server.token, headers: { ...IP, 'ss-sign-in': signIn } });
		expect(refused.status).toBe(401);
		expect(await refused.json()).toMatchObject({ cause: 'expired' });
	});

	it('refuses a sign-in signed by another key, a forged one and one that is not a token', async () => {
		const { call, server, websiteId, clock } = await connected();
		const stranger = createAccountsDouble({ now: clock.now });
		const forged = await stranger.signIn({ websiteId, sub: 'usr_shopper1' });
		for (const [value, cause] of /** @type {const} */ ([
			[forged, 'signature'],
			['usr_shopper1', 'malformed'],
			['a.b.c', 'malformed'],
		])) {
			const refused = await call('GET', '/v1/visitor/me', { token: server.token, headers: { ...IP, 'ss-sign-in': value } });
			expect(refused.status).toBe(401);
			expect(await refused.json()).toMatchObject({ cause });
		}
	});

	it('never takes a bare user id: only a verified sign-in names the shopper', async () => {
		const { call, server } = await connected();
		const bare = await call('POST', '/v1/visitor/orders', {
			token: server.token,
			body: { userId: 'usr_shopper1' },
			headers: { ...IP, 'ss-user-id': 'usr_shopper1', 'ss-shopper-id': 'usr_shopper1' },
		});
		expect(await bare.json()).toEqual({ placedBy: null });
	});

	it('is refused while the Portal has not linked the product to Accounts', async () => {
		const ctx = await setup({ routes: routes() });
		await ctx.switchOn(['notes']);
		const signIn = await ctx.accounts.signIn({ websiteId: ctx.websiteId, sub: 'usr_shopper1' });
		const refused = await ctx.call('GET', '/v1/visitor/me', {
			token: ctx.server.token,
			headers: { ...IP, 'ss-sign-in': signIn },
		});
		expect(refused.status).toBe(401);
		expect(await refused.json()).toMatchObject({ cause: 'accounts_not_connected' });
	});

	it('answers 503 while Accounts cannot be asked for its keys', async () => {
		const { call, server, accounts, websiteId, clock } = await connected();
		const first = await accounts.signIn({ websiteId, sub: 'usr_a' });
		expect((await call('GET', '/v1/visitor/me', { token: server.token, headers: { ...IP, 'ss-sign-in': first } })).status).toBe(
			200,
		);
		accounts.setFailing(true);
		clock.advance(11 * 60_000);
		const fresh = await accounts.signIn({ websiteId, sub: 'usr_b' });
		const down = await call('GET', '/v1/visitor/me', { token: server.token, headers: { ...IP, 'ss-sign-in': fresh } });
		expect(down.status).toBe(503);
		expect(await down.json()).toMatchObject({ type: 'https://notes.example.dev/problems/accounts_unavailable' });
	});

	it('leaves a browser call alone: a wrong or expired sign-in counts as none, as before', async () => {
		const { call, browser, accounts } = await connected();
		const other = await accounts.signIn({ websiteId: 'web_someone_else', sub: 'usr_shopper1' });
		const browserCall = await call('GET', '/v1/visitor/me', {
			token: browser.token,
			origin: SITE,
			headers: { 'ss-sign-in': other },
		});
		expect(browserCall.status).toBe(200);
		expect((await browserCall.json()).signIn).toMatchObject({ ok: false, code: 'audience' });
	});

	it('never takes actor headers as a person: the shopper is the sign-in, nobody else is named', async () => {
		const { call, server, accounts, websiteId } = await connected();
		const signIn = await accounts.signIn({ websiteId, sub: 'usr_shopper1' });
		const named = await call('GET', '/v1/visitor/me', {
			token: server.token,
			headers: { ...IP, 'ss-sign-in': signIn, 'ss-actor-id': 'usr_staff1', 'ss-actor-name': 'Alex' },
		});
		expect(await named.json()).toEqual({ signIn: { id: 'usr_shopper1', email: null }, actor: null });
		// a half set of them is no longer an error: they mean nothing
		const half = await call('GET', '/v1/visitor/me', {
			token: server.token,
			headers: { ...IP, 'ss-sign-in': signIn, 'ss-actor-id': 'usr_staff1' },
		});
		expect(half.status).toBe(200);
		expect((await half.json()).actor).toBeNull();
		// a shopper's sign-in is no staff: a staff route refuses it
		const staff = await call('GET', '/v1/inbox/open', { token: server.token, bare: true, headers: { 'ss-sign-in': signIn } });
		expect(staff.status).toBe(403);
	});

	it('is read on server routes only when asked for: SS-Sign-In never changes a staff call', async () => {
		const { call, server, accounts, websiteId } = await connected();
		const signIn = await accounts.signIn({ websiteId, sub: 'usr_shopper1' });
		const staff = await call('GET', '/v1/server/me', { token: server.token, headers: { 'ss-sign-in': signIn } });
		expect(staff.status).toBe(200);
		const bad = await call('GET', '/v1/server/me', { token: server.token, headers: { 'ss-sign-in': 'junk' } });
		expect(bad.status).toBe(200);
	});

	it('counts a repeated Idempotency-Key by the shopper, so a retry with a renewed sign-in gets the first answer', async () => {
		const { call, server, accounts, websiteId, clock } = await connected();
		const post = async (/** @type {string} */ sub) =>
			call('POST', '/v1/visitor/orders', {
				token: server.token,
				body: {},
				headers: { ...IP, 'ss-sign-in': await accounts.signIn({ websiteId, sub }), 'idempotency-key': 'order-1' },
			});
		const first = await post('usr_a');
		expect(first.status).toBe(200);
		clock.advance(60_000);
		const retry = await post('usr_a');
		expect([retry.status, retry.headers.get('idempotent-replayed')]).toEqual([200, 'true']);
		expect((await post('usr_b')).status).toBe(409);
	});

	it('takes sign-ins only once the website’s Accounts token is pasted: a product declares the connection by itself', async () => {
		const { call, server, switchOn } = await setup({ routes: routes() });
		await switchOn(['notes']);
		const sign = { ...IP, 'ss-sign-in': 'a-sign-in-of-the-product-itself' };
		const found = await call('GET', '/v1/visitor/me', { token: server.token, headers: sign });
		expect(found.status).toBe(401);
		expect(await found.json()).toMatchObject({ cause: 'accounts_not_connected' });
	});
});
