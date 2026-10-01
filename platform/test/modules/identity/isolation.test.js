import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { boot, setupMongo, teardownMongo } from './boot.js';

vi.setConfig({ testTimeout: 120_000 });
beforeAll(setupMongo, 120_000);
afterAll(teardownMongo, 60_000);

/** Bodies that would be valid, so a refusal is about tenancy, never validation. */
const BODIES = /** @type {Record<string, (ids: any) => unknown>} */ ({
	'PATCH /v1/merchants/:merchantId': () => ({ name: 'pwned' }),
	'PATCH /v1/merchants/:merchantId/websites/:websiteId': () => ({ timeZone: 'Europe/Berlin' }),
	'POST /v1/merchants/:merchantId/team/invites': () => ({ email: 'intruder@example.com', roles: ['admin'] }),
	'PATCH /v1/merchants/:merchantId/team/members/:userId': () => ({ roles: ['admin'] }),
	'POST /v1/merchants/:merchantId/owner/transfer': (ids) => ({ userId: ids.userId, password: 'correct horse battery' }),
	'POST /v1/merchants/:merchantId/websites': () => ({ domain: 'intruder.example.com' }),
	'POST /v1/merchants/:merchantId/websites/:websiteId/keys': () => ({ kind: 'sk', scopes: ['events.*'] }),
	'POST /v1/merchants/:merchantId/websites/:websiteId/keys/:keyId/rotate': () => ({ graceSeconds: 0 }),
	'POST /v1/merchants/:merchantId/websites/:websiteId/keys/:keyId/revoke': () => ({ reason: 'x' }),
});

/**
 * @param {string} path
 * @param {Record<string, string>} ids
 */
const fill = (path, ids) => path.replace(/:([a-zA-Z]+)/g, (_, name) => ids[name] ?? `missing-${name}`);

/** @param {Awaited<ReturnType<typeof boot>>} h @param {string} email @param {string} domain */
const tenant = async (h, email, domain) => {
	const owner = await h.signupOwner(email);
	const site = await owner.client.post(`/v1/merchants/${owner.merchantId}/websites`, { domain });
	const websiteId = site.json.website.websiteId;
	const key = await owner.client.post(`/v1/merchants/${owner.merchantId}/websites/${websiteId}/keys`, {
		kind: 'sk',
		scopes: ['events.write'],
	});
	await owner.client.post(`/v1/merchants/${owner.merchantId}/team/invites`, { email: `member.${email}`, roles: ['editor'] });
	const member = h.client();
	const accepted = await member.post('/v1/auth/invites/accept', {
		token: h.mailer.token(`member.${email}`, 'invite'),
		password: 'member password',
	});
	const invite = await owner.client.post(`/v1/merchants/${owner.merchantId}/team/invites`, {
		email: `pending.${email}`,
		roles: ['editor'],
	});
	return {
		...owner,
		ids: {
			merchantId: owner.merchantId,
			websiteId,
			keyId: key.json.keyId,
			userId: accepted.json.user.userId,
			inviteId: invite.json.inviteId,
		},
	};
};

/** @param {Awaited<ReturnType<typeof tenant>>} t */
const snapshot = async (t) => ({
	merchant: (await t.client.get(`/v1/merchants/${t.merchantId}`)).json,
	team: (await t.client.get(`/v1/merchants/${t.merchantId}/team`)).json,
	websites: (await t.client.get(`/v1/merchants/${t.merchantId}/websites`)).json,
	keys: (await t.client.get(`/v1/merchants/${t.merchantId}/websites/${t.ids.websiteId}/keys`)).json,
});

describe('tenant isolation', () => {
	it('merchant A can neither read nor modify anything of merchant B, on every route', async () => {
		const h = await boot();
		const a = await tenant(h, 'a@example.com', 'a.example.com');
		const b = await tenant(h, 'b@example.com', 'b.example.com');
		const before = await snapshot(b);
		const routes = h.portal.modules.routes;
		const merchantRoutes = routes.filter((r) => r.path.startsWith('/v1/merchants/'));
		expect(merchantRoutes.length).toBeGreaterThanOrEqual(16);

		/** @type {string[]} */
		const tested = [];
		for (const route of merchantRoutes) {
			const id = `${route.method} ${route.path}`;
			const body = BODIES[id]?.(b.ids);
			// 1. B's merchant in the path: refused before any lookup
			const direct = await a.client.send(route.method, fill(route.path, b.ids), body);
			expect(direct.status, `${id} with B's merchant`).toBe(403);
			// 2. A's own merchant with B's object ids: not found (never B's data)
			if (/:(websiteId|keyId|userId|inviteId)/.test(route.path) || id === 'POST /v1/merchants/:merchantId/owner/transfer') {
				const mixed = {
					...b.ids,
					merchantId: a.merchantId,
					...(route.path.includes(':keyId') ? { websiteId: a.ids.websiteId } : {}),
				};
				const crossed = await a.client.send(route.method, fill(route.path, mixed), body);
				expect(crossed.status, `${id} with A's merchant and B's ids`).toBe(404);
			}
			tested.push(id);
		}
		expect(tested.sort()).toEqual(merchantRoutes.map((r) => `${r.method} ${r.path}`).sort());

		// B's member (not owner) of B is equally confined
		const memberOfB = await h.login(`member.b@example.com`, 'member password');
		expect((await memberOfB.get(`/v1/merchants/${a.merchantId}/websites`)).status).toBe(403);
		expect((await memberOfB.get(`/v1/merchants/${a.merchantId}/websites/${a.ids.websiteId}`)).status).toBe(403);

		// staff-only and product routes are closed to merchant sessions
		for (const route of routes.filter((r) => r.path.startsWith('/v1/admin/') || r.path.startsWith('/v1/product/'))) {
			const res = await a.client.send(route.method, fill(route.path, b.ids), route.method === 'GET' ? undefined : {});
			expect(res.status, `${route.method} ${route.path}`).toBe(401);
		}

		// sessions of another user cannot be revoked
		const bSessions = await b.client.get('/v1/me/sessions');
		const theirs = bSessions.json.items[0].sessionId;
		expect((await a.client.del(`/v1/me/sessions/${theirs}`)).status).toBe(404);
		expect((await b.client.get('/v1/me')).status).toBe(200);

		// nothing of B changed; B's key still authenticates
		expect(await snapshot(b)).toEqual(before);
		expect(
			await h.service.isKeyRevoked(
				/** @type {any} */ ({
					keyId: b.ids.keyId,
					websiteId: b.ids.websiteId,
					merchantId: b.merchantId,
					kind: 'sk',
					env: 'live',
				}),
			),
		).toBe(false);
		// and the service guards the same way when given a merchant scope
		await expect(h.service.websites.getWebsite(b.ids.websiteId, a.merchantId)).rejects.toMatchObject({ code: 'not_found' });
		await expect(
			h.service.revokeKey({
				keyId: b.ids.keyId,
				merchantId: a.merchantId,
				actor: { type: 'merchant_user', id: a.userId, merchantId: a.merchantId },
			}),
		).rejects.toMatchObject({ code: 'not_found' });
		await expect(
			h.service.issueKey({ websiteId: b.ids.websiteId, merchantId: a.merchantId, kind: 'sk', scopes: ['events.*'] }),
		).rejects.toMatchObject({ code: 'not_found' });
	});
});
