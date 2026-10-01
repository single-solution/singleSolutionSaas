/**
 * Sessions and the website's identity issuer: EdDSA access tokens verified offline exactly as other products do
 * (app-kit `verifyIdentityToken` with the JWKS this product publishes), refresh-token rotation with reuse detection,
 * device list, revoke one / all, signing-key rotation with pre-publication, discovery, the issuer report and the
 * request to become the website's issuer (POST /v1/issuer:register, daily job, dashboard; the merchant approves).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyIdentityToken } from '@ss/app-kit';
import { CRON_SECRET, createHarness, WEBSITE } from './harness.js';

const HOUR = 3_600_000;

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
beforeAll(async () => {
	h = await createHarness();
});
afterAll(async () => h?.close());

/** The identity section a merchant registers in the Portal, built from the published JWKS. */
const sectionFor = async () => {
	const jwks = await h.call('GET', `/.well-known/jwks/${WEBSITE}.json`, { key: null });
	return {
		issuer: `https://signups.example.com/i/${WEBSITE}`,
		jwks: jwks.json.keys,
		audience: WEBSITE,
		claimMap: { subject: 'sub', email: 'email', phone: 'phone_number' },
	};
};

describe('identity issuer', () => {
	it('publishes a per-website JWKS and discovery document, and its tokens verify offline like any BYO issuer', async () => {
		const signedIn = await h.signIn('jwt@example.com');
		const jwks = await h.call('GET', `/.well-known/jwks/${WEBSITE}.json`, { key: null });
		expect(jwks.status).toBe(200);
		expect(jwks.headers.get('cache-control')).toBe('public, max-age=300');
		expect(jwks.json.keys).toHaveLength(1);
		expect(jwks.json.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' });
		expect(jwks.json.keys[0]).not.toHaveProperty('d');
		const discovery = await h.call('GET', `/i/${WEBSITE}/.well-known/openid-configuration`, { key: null });
		expect(discovery.json).toMatchObject({
			issuer: `https://signups.example.com/i/${WEBSITE}`,
			jwks_uri: `https://signups.example.com/.well-known/jwks/${WEBSITE}.json`,
		});
		const verified = verifyIdentityToken(signedIn.json.tokens.accessToken, await sectionFor(), { now: h.clock.now });
		expect(verified).toEqual({
			ok: true,
			identity: {
				subject: signedIn.json.customer.id,
				email: 'jwt@example.com',
				issuer: `https://signups.example.com/i/${WEBSITE}`,
				claims: expect.objectContaining({ sub: signedIn.json.customer.id, email: 'jwt@example.com' }),
			},
		});
		// tokens of this website are not valid for another website's issuer
		const other = verifyIdentityToken(signedIn.json.tokens.accessToken, {
			...(await sectionFor()),
			issuer: 'https://signups.example.com/i/web_other',
		});
		expect(other).toEqual({ ok: false, code: 'issuer' });
		// unknown websites and malformed names have no issuer
		expect((await h.call('GET', '/.well-known/jwks/web_unknown0000000000000000000.json', { key: null })).status).toBe(404);
		expect((await h.call('GET', '/.well-known/jwks/evil.json', { key: null })).status).toBe(404);
		expect((await h.call('GET', '/i/nope/.well-known/openid-configuration', { key: null })).status).toBe(404);
	});

	it('reports the issuer and the exact Portal registration (sk only), and notices once the Portal carries it', async () => {
		expect((await h.call('GET', '/v1/issuer')).status).toBe(403);
		const report = await h.call('GET', '/v1/issuer', { key: h.sk });
		expect(report.json).toMatchObject({
			issuer: `https://signups.example.com/i/${WEBSITE}`,
			audience: WEBSITE,
			registered: false,
			portal: { method: 'PUT', path: `/v1/merchants/mer_0123456789abcdefghjkmnpq/websites/${WEBSITE}/identity` },
		});
		await h.entitle({ identity: await sectionFor() });
		expect((await h.call('GET', '/v1/issuer', { key: h.sk })).json.registered).toBe(true);
		await h.entitle();
	});

	it('rotates keys with pre-publication: the next key is published before it signs, the old one until its tokens expire', async () => {
		const before = await h.signIn('rotate@example.com');
		const rotated = await h.call('POST', '/v1/issuer:rotate', { key: h.sk });
		expect(rotated.status).toBe(200);
		expect(rotated.json.keys).toHaveLength(2);
		expect(rotated.json.keys.filter((/** @type {any} */ k) => k.signing)).toHaveLength(1);
		// still signing with the old key during the pre-publication window
		const during = await h.signIn('rotate@example.com');
		const kid = (/** @type {string} */ token) => JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString()).kid;
		expect(kid(during.json.tokens.accessToken)).toBe(kid(before.json.tokens.accessToken));
		h.clock.advance(2 * HOUR + 1000);
		const after = await h.signIn('rotate@example.com');
		expect(kid(after.json.tokens.accessToken)).not.toBe(kid(before.json.tokens.accessToken));
		expect((await sectionFor()).jwks.map((/** @type {any} */ k) => k.kid)).toContain(kid(before.json.tokens.accessToken));
		// after the retention window the superseded key disappears and is pruned by the daily job
		h.clock.advance(2 * HOUR);
		expect((await sectionFor()).jwks.map((/** @type {any} */ k) => k.kid)).not.toContain(kid(before.json.tokens.accessToken));
	});
});

describe('identity issuer request (the merchant approves in the Portal)', () => {
	/** @type {Awaited<ReturnType<typeof createHarness>>} */
	let r;
	beforeAll(async () => {
		r = await createHarness();
	});
	afterAll(async () => r?.close());
	const job = () => r.call('GET', '/cron/maintenance', { key: null, headers: { authorization: `Bearer ${CRON_SECRET}` } });
	const ours = (/** @type {any} */ result) => result.json.results.find((/** @type {any} */ x) => x.websiteId === WEBSITE);
	const portalPath = `/v1/product/websites/${WEBSITE}/identity`;

	it('the daily job asks once, never fails on a Portal error, and retries the next day', async () => {
		expect((await r.call('GET', '/v1/issuer', { key: r.sk })).json.request).toBeNull(); // the website is now known
		r.portal.failNext(portalPath, 503);
		const failed = await job();
		expect(failed.status).toBe(200);
		expect(ours(failed)).toMatchObject({ issuerRequested: 0 });
		expect(r.portal.identityRequests.size).toBe(0);
		expect((await r.call('GET', '/v1/issuer', { key: r.sk })).json.request).toBeNull();
		const sent = await job();
		expect(ours(sent)).toMatchObject({ issuerRequested: 1 });
		expect(r.portal.identityRequests.get(WEBSITE)).toMatchObject({
			status: 'pending',
			input: {
				issuer: `https://signups.example.com/i/${WEBSITE}`,
				jwksUrl: `https://signups.example.com/.well-known/jwks/${WEBSITE}.json`,
				audience: WEBSITE,
				claimMap: { subject: 'sub', email: 'email', phone: 'phone_number' },
			},
		});
		// already requested for this configuration: not asked again (a rejection is not repeated on its own)
		const calls = r.portal.calls.filter((c) => c.path === portalPath).length;
		expect(ours(await job())).toMatchObject({ issuerRequested: 0 });
		expect(r.portal.calls.filter((c) => c.path === portalPath)).toHaveLength(calls);
		expect((await r.call('GET', '/v1/issuer', { key: r.sk })).json.request).toEqual({
			status: 'pending',
			requestedAt: new Date(r.clock.now()).toISOString(),
		});
	});

	it('POST /v1/issuer:register (sk only) answers 202 pending, then 200 active once the merchant approved', async () => {
		expect((await r.call('POST', '/v1/issuer:register')).status).toBe(403);
		const pending = await r.call('POST', '/v1/issuer:register', { key: r.sk });
		expect(pending.status).toBe(202);
		expect(pending.json).toMatchObject({
			status: 'pending',
			registered: false,
			issuer: `https://signups.example.com/i/${WEBSITE}`,
		});
		expect(r.portal.decideIdentityRequest(WEBSITE, 'approve')).toMatchObject({ status: 'approved' });
		const active = await r.call('POST', '/v1/issuer:register', { key: r.sk });
		expect(active.status).toBe(200);
		expect(active.json).toMatchObject({ status: 'active', registered: true });
		expect((await r.call('GET', '/v1/issuer', { key: r.sk })).json.request).toMatchObject({ status: 'active' });
		const audit = await r.collection('audit').find({ websiteId: WEBSITE, action: 'issuer.registration_requested' }).toArray();
		expect(audit.map((entry) => entry.after?.status)).toEqual(['pending', 'pending', 'active']);
	});

	it('maps Portal refusals and outages to problems', async () => {
		r.portal.failNext(portalPath, 429);
		expect((await r.call('POST', '/v1/issuer:register', { key: r.sk })).json.type).toMatch(/rate_limited$/);
		r.portal.failNext(portalPath, 500);
		expect((await r.call('POST', '/v1/issuer:register', { key: r.sk })).status).toBe(502);
		r.portal.setDown(true);
		const down = await r.call('POST', '/v1/issuer:register', { key: r.sk });
		r.portal.setDown(false);
		expect(down.status).toBe(503);
		r.portal.refuseIdentityRequests(WEBSITE);
		const refused = await r.call('POST', '/v1/issuer:register', { key: r.sk });
		expect(refused.status).toBe(403);
		expect(refused.json.detail).toMatch(/identityIssuer/);
	});

	it('the dashboard sends the request for merchant launches, not for the demo', async () => {
		/** @param {Awaited<ReturnType<typeof createHarness>>} harness @param {'merchant' | 'demo'} kind @param {Record<string, unknown>} scope */
		const sessionOf = async (harness, kind, scope) => {
			const { token } = await harness.portal.issueLaunch({
				kind,
				subject: 'usr_1',
				user: { id: 'usr_1' },
				scope,
				subscriptions: [],
			});
			const sso = await harness.handle(new Request(`https://signups.example.com/sso?launch=${token}`));
			return /ss_session=(ses_[^;]+)/.exec(sso.headers.get('set-cookie') ?? '')?.[1];
		};
		/** @param {Awaited<ReturnType<typeof createHarness>>} harness @param {string | undefined} session */
		const press = (harness, session) =>
			harness.call('POST', '/v1/dashboard/issuer:register', { key: null, headers: { authorization: `Bearer ${session}` } });
		const fresh = await createHarness(); // a website Signups has not asked for yet
		try {
			const session = await sessionOf(fresh, 'merchant', { merchantId: 'mer_0123456789abcdefghjkmnpq', websiteId: WEBSITE });
			const sent = await press(fresh, session);
			expect(sent.status, JSON.stringify(sent.json)).toBe(202);
			expect(fresh.portal.identityRequests.get(WEBSITE)?.status).toBe('pending');
			const audit = await fresh.collection('audit').findOne({ websiteId: WEBSITE, action: 'issuer.registration_requested' });
			expect(audit?.actor).toEqual({ type: 'merchant', id: 'usr_1' });
		} finally {
			await fresh.close();
		}
		expect((await press(r, await sessionOf(r, 'demo', {}))).status).toBe(403);
	});
});

describe('refresh tokens', () => {
	it('rotate on every use; a replayed token ends the session (reuse detection) after the grace window', async () => {
		const signedIn = await h.signIn('refresh@example.com');
		const first = signedIn.json.tokens.refreshToken;
		const refreshed = await h.call('POST', '/v1/sessions:refresh', { body: { refreshToken: first } });
		expect(refreshed.status).toBe(200);
		const second = refreshed.json.tokens.refreshToken;
		expect(second).not.toBe(first);
		expect(refreshed.json.tokens.sessionId).toBe(signedIn.json.tokens.sessionId);
		// two tabs racing: the old token within the grace window is a conflict, nothing is revoked
		const race = await h.call('POST', '/v1/sessions:refresh', { body: { refreshToken: first } });
		expect(race.status).toBe(409);
		expect(race.json.type).toMatch(/refresh_conflict$/);
		h.clock.advance(11_000);
		const replay = await h.call('POST', '/v1/sessions:refresh', { body: { refreshToken: first } });
		expect(replay.status).toBe(401);
		expect(replay.json.type).toMatch(/refresh_reused$/);
		// the whole session is gone, including for the legitimate holder of the newest token
		expect((await h.call('POST', '/v1/sessions:refresh', { body: { refreshToken: second } })).json.type).toMatch(
			/session_ended$/,
		);
		expect((await h.call('GET', '/v1/profile', { token: refreshed.json.tokens.accessToken })).status).toBe(401);
		const events = await h.call('GET', '/v1/risk-events', { key: h.sk });
		expect(events.json.items.some((/** @type {any} */ e) => e.type === 'refresh_reuse')).toBe(true);
	});

	it('refuses garbage, expired and idle sessions; logout ends the session', async () => {
		expect((await h.call('POST', '/v1/sessions:refresh', { body: { refreshToken: 'nope' } })).json.type).toMatch(
			/refresh_invalid$/,
		);
		expect(
			(
				await h.call('POST', '/v1/sessions:refresh', {
					body: { refreshToken: 'rt1.ses_00000000000000000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
				})
			).json.type,
		).toMatch(/refresh_invalid$/);
		const signedIn = await h.signIn('idle@example.com');
		h.clock.advance(15 * 24 * HOUR);
		await h.entitle(); // a fresh entitlement document (the old one expired with the clock)
		const idle = await h.call('POST', '/v1/sessions:refresh', { body: { refreshToken: signedIn.json.tokens.refreshToken } });
		expect(idle.json.type).toMatch(/session_ended$/);
		const fresh = await h.signIn('idle@example.com');
		const out = await h.call('POST', '/v1/sessions:logout', { body: { refreshToken: fresh.json.tokens.refreshToken } });
		expect(out.status).toBe(204);
		expect(
			(await h.call('POST', '/v1/sessions:refresh', { body: { refreshToken: fresh.json.tokens.refreshToken } })).status,
		).toBe(401);
		expect((await h.call('POST', '/v1/sessions:logout', { body: { refreshToken: 'garbage' } })).status).toBe(204);
	});
});

describe('sessions and devices', () => {
	it('lists devices, ends one, ends all (session version) and caps sessions per customer', async () => {
		await h.entitle({ config: { sessions: { max_sessions_per_customer: 2 } } });
		const a = await h.signIn('devices@example.com', { deviceId: 'device-aaaa-0001' });
		const b = await h.signIn('devices@example.com', { deviceId: 'device-bbbb-0002' });
		const list = await h.call('GET', '/v1/sessions', { token: b.json.tokens.accessToken });
		expect(list.json.items).toHaveLength(2);
		expect(list.json.items.find((/** @type {any} */ s) => s.current)?.id).toBe(b.json.tokens.sessionId);
		expect(list.json.items[0].device).toEqual({ label: 'Firefox on Android', browser: 'Firefox', os: 'Android' });
		// a third device ends the least recently used session
		const c = await h.signIn('devices@example.com', { deviceId: 'device-cccc-0003' });
		expect((await h.call('GET', '/v1/profile', { token: a.json.tokens.accessToken })).status).toBe(401);
		const ended = await h.call('DELETE', `/v1/sessions/${b.json.tokens.sessionId}`, { token: c.json.tokens.accessToken });
		expect(ended.status).toBe(204);
		expect(
			(await h.call('DELETE', `/v1/sessions/${b.json.tokens.sessionId}`, { token: c.json.tokens.accessToken })).status,
		).toBe(404);
		const all = await h.call('POST', '/v1/sessions:revoke-all', { token: c.json.tokens.accessToken, body: {} });
		expect(all.status).toBe(200);
		expect(all.json.revoked).toBe(1);
		expect((await h.call('GET', '/v1/sessions', { token: c.json.tokens.accessToken })).status).toBe(401);
		// server keys manage any customer
		const d = await h.signIn('devices@example.com');
		const viaServer = await h.call('GET', `/v1/sessions?customerId=${d.json.customer.id}`, { key: h.sk });
		expect(viaServer.json.items).toHaveLength(1);
		expect(
			(await h.call('POST', '/v1/sessions:revoke-all', { key: h.sk, body: { customerId: d.json.customer.id } })).json.revoked,
		).toBe(1);
		expect((await h.call('GET', '/v1/sessions', { key: h.sk })).status).toBe(422);
		expect((await h.call('GET', '/v1/sessions?customerId=cus_missing', { key: h.sk })).status).toBe(404);
		await h.entitle();
	});

	it('refuses missing, forged and other-website tokens on customer routes', async () => {
		expect((await h.call('GET', '/v1/profile')).json.type).toMatch(/identity_required$/);
		expect((await h.call('GET', '/v1/profile', { token: 'a.b.c' })).json.type).toMatch(/identity_invalid$/);
		const signedIn = await h.signIn('forge@example.com');
		const [head, , sig] = signedIn.json.tokens.accessToken.split('.');
		const forgedClaims = Buffer.from(JSON.stringify({ sub: 'cus_other', iss: 'x' })).toString('base64url');
		expect((await h.call('GET', '/v1/profile', { token: `${head}.${forgedClaims}.${sig}` })).status).toBe(401);
		h.clock.advance(16 * 60_000);
		expect((await h.call('GET', '/v1/profile', { token: signedIn.json.tokens.accessToken })).status).toBe(401);
	});

	it('sends a new-device notice on a sign-in from an unknown device', async () => {
		await h.signIn('notice@example.com', { deviceId: 'device-known-0001' });
		const before = h.gateway.messages.length;
		await h.signIn('notice@example.com', { deviceId: 'device-known-0001' });
		expect(h.gateway.messages.slice(before).filter((m) => m.purpose === 'new_device')).toHaveLength(0);
		const result = await h.signIn('notice@example.com', { deviceId: 'device-new-00002' });
		const notice = h.gateway.messages.filter((m) => m.purpose === 'new_device').at(-1);
		expect(notice).toMatchObject({ to: 'notice@example.com', channel: 'email', reference: result.json.tokens.sessionId });
		expect(notice?.text).toContain('Firefox on Android');
		expect(h.published('signups.signed_in@1').at(-1)?.data).toMatchObject({ newDevice: true });
	});
});
