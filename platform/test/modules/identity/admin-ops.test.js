/**
 * Admin operations APIs: impersonation (one-time exchange token → merchant session with `via`, time box, single use,
 * audits on both chains, ending), merchant notes (append-only, audited), merchant search (`?q=` name / e-mail
 * prefix, migration backfill), platform health and the audit log (search, cursor, verification).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { COLLECTIONS } from '../../../src/infra/schema.js';
import { nameKey, parseMerchantQuery, prefixPattern } from '../../../src/modules/identity/core/search.js';
import { identityModule } from '../../../src/modules/identity/index.js';
import { C } from '../../../src/modules/identity/schema.js';
import { parseAuditQuery, presentAuditEntry } from '../../../src/modules/system/ops.js';
import { boot, setupMongo, teardownMongo } from './boot.js';

vi.setConfig({ testTimeout: 60_000 });
beforeAll(setupMongo, 120_000);
afterAll(teardownMongo, 60_000);

/** @param {string[]} setCookies */
const cookieOf = (setCookies) => {
	const [pair = ''] = String(setCookies[0] ?? '').split(';');
	return pair;
};

describe('impersonation', () => {
	it('mints a one-time token, exchanges it for a time-boxed merchant session with via, audits and ends it', async () => {
		const h = await boot();
		const root = await h.staffUser('root@example.com');
		const support = await h.staffUser('support@example.com', ['support'], { creator: root.client });
		const { merchantId, userId } = await h.signupOwner('owner@example.com', { merchantName: 'Acme' });
		const base = `/v1/admin/merchants/${merchantId}/impersonate`;

		// permission, validation, unknown members
		expect((await support.client.post(base, { userId, minutes: 15, reason: 'ticket' })).status).toBe(403);
		const invalid = await root.client.post(base, { userId, minutes: 61, reason: 'ticket' });
		expect(invalid.status).toBe(422);
		expect(invalid.json.errors.map((/** @type {any} */ e) => e.path)).toContain('/minutes');
		expect((await root.client.post(base, { userId, minutes: 15 })).status).toBe(422);
		expect((await root.client.post(base, { userId: 'usr_0000000000000000000000000z', minutes: 15, reason: 'x' })).status).toBe(
			404,
		);
		expect(
			(
				await root.client.post('/v1/admin/merchants/mer_0000000000000000000000000z/impersonate', {
					userId,
					minutes: 15,
					reason: 'x',
				})
			).status,
		).toBe(404);

		const started = await root.client.post(base, { userId, minutes: 15, reason: 'ticket 42' });
		expect(started.status).toBe(200);
		expect(started.json).toMatchObject({ exchangePath: '/v1/auth/impersonation/exchange' });
		expect(started.json.exchangeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(started.setCookies).toEqual([]);
		// the token is not replayable through the idempotency store
		const key = { headers: { 'idempotency-key': 'imp-1' } };
		await root.client.post(base, { userId, minutes: 15, reason: 'again' }, key);
		const replay = await root.client.post(base, { userId, minutes: 15, reason: 'again' }, key);
		expect(replay.status).toBe(409);

		// only the staff member who minted it can redeem it (and a foreign attempt does not burn it)
		const exchange = '/v1/auth/impersonation/exchange';
		const foreign = await support.client.post(exchange, { token: started.json.exchangeToken });
		expect(foreign.status).toBe(400);
		expect((await h.call('POST', exchange, { body: { token: started.json.exchangeToken } })).status).toBe(401);
		const redeemed = await h.call('POST', exchange, {
			body: { token: started.json.exchangeToken },
			cookie: root.client.cookie,
			headers: { 'idempotency-key': 'x-1' },
		});
		expect(redeemed.status).toBe(200);
		expect(redeemed.json).toMatchObject({ merchantId, userId });
		const merchantCookie = cookieOf(redeemed.setCookies);
		expect(merchantCookie).toMatch(/^__Host-ss_merchant=/);
		expect(redeemed.setCookies[0]).toMatch(/Max-Age=900/);
		expect(Date.parse(redeemed.json.expiresAt)).toBeLessThanOrEqual(h.clock.now() + 15 * 60_000);
		// single use
		expect(
			(await h.call('POST', exchange, { body: { token: started.json.exchangeToken }, cookie: root.client.cookie })).status,
		).toBe(400);
		// tokens expire after a minute
		const late = await root.client.post(base, { userId, minutes: 5, reason: 'late' });
		h.clock.advance(61_000);
		expect((await root.client.post(exchange, { token: late.json.exchangeToken })).status).toBe(400);

		// the merchant session carries via (with the staff name) and is MFA-complete
		const who = await h.call('GET', '/v1/system/whoami', { cookie: merchantCookie });
		expect(who.status).toBe(200);
		expect(who.json.actor).toMatchObject({
			type: 'merchant_user',
			id: userId,
			merchantId,
			via: { type: 'staff', id: root.staffId, name: 'root@example.com' },
		});
		expect(who.json.session.mfa).toBe(true);

		// mutations under impersonation are audited as the user, via the staff member
		const renamed = await h.call('PATCH', `/v1/merchants/${merchantId}`, { body: { name: 'Acme 2' }, cookie: merchantCookie });
		expect(renamed.status).toBe(200);
		const audit = h.db.collection(COLLECTIONS.audit);
		expect(await audit.findOne({ action: 'merchant.renamed', 'actor.via.id': root.staffId })).toMatchObject({
			actor: { type: 'merchant_user', id: userId },
			scope: `merchant:${merchantId}`,
		});
		// the start is on both chains, with the reason
		expect(await audit.findOne({ action: 'staff.impersonation_started' })).toMatchObject({
			scope: 'global',
			reason: 'ticket 42',
			actor: { type: 'staff', id: root.staffId },
		});
		expect(await audit.findOne({ action: 'merchant.impersonation_started' })).toMatchObject({
			scope: `merchant:${merchantId}`,
			target: { type: 'user', id: userId },
		});

		// ending: the merchant sign-out revokes the session and is audited on both chains
		expect((await h.call('POST', '/v1/auth/merchant/logout', { cookie: merchantCookie })).status).toBe(204);
		expect((await h.call('GET', '/v1/me', { cookie: merchantCookie })).status).toBe(401);
		expect(await audit.findOne({ action: 'staff.impersonation_ended', scope: 'global' })).toBeTruthy();
		expect(await audit.findOne({ action: 'merchant.impersonation_ended', 'actor.via.id': root.staffId })).toBeTruthy();
		// the staff session is untouched
		expect((await root.client.get('/v1/me')).status).toBe(200);

		// the time box: a 1-minute impersonation ends by itself
		const short = await root.client.post(base, { userId, minutes: 1, reason: 'short' });
		const shortSession = await h.call('POST', exchange, {
			body: { token: short.json.exchangeToken },
			cookie: root.client.cookie,
		});
		const shortCookie = cookieOf(shortSession.setCookies);
		expect((await h.call('GET', '/v1/me', { cookie: shortCookie })).status).toBe(200);
		h.clock.advance(61_000);
		expect((await h.call('GET', '/v1/me', { cookie: shortCookie })).status).toBe(401);

		// deactivated users cannot be impersonated
		await h.db.collection(C.users).updateOne({ _id: /** @type {any} */ (userId) }, { $set: { status: 'disabled' } });
		expect((await root.client.post(base, { userId, minutes: 5, reason: 'x' })).status).toBe(409);
	});
});

describe('merchant notes and search', () => {
	it('appends audited notes and searches merchants by name or e-mail prefix', async () => {
		const h = await boot();
		const root = await h.staffUser('root@example.com');
		const support = await h.staffUser('support@example.com', ['support'], { creator: root.client });
		const a = await h.signupOwner('anna@shop.test', { merchantName: 'Café Ölmühle' });
		const b = await h.signupOwner('bob@else.test', { merchantName: 'Cafeteria Bob' });
		await h.signupOwner('carl@third.test', { merchantName: 'Zeta' });

		// notes
		const notes = `/v1/admin/merchants/${a.merchantId}/notes`;
		expect((await root.client.get(notes)).json).toEqual({ items: [] });
		expect((await root.client.post(notes, { body: '' })).status).toBe(422);
		expect((await support.client.post(notes, { body: 'hi' })).status).toBe(403);
		const added = await root.client.post(notes, { body: 'Called about invoices.' });
		expect(added.status).toBe(201);
		expect(added.json).toMatchObject({
			body: 'Called about invoices.',
			by: { staffId: root.staffId, email: 'root@example.com' },
		});
		h.clock.advance(1000);
		await root.client.post(notes, { body: 'Second note.' });
		const listed = await support.client.get(notes);
		expect(listed.json.items.map((/** @type {any} */ n) => n.body)).toEqual(['Second note.', 'Called about invoices.']);
		expect((await root.client.get(`${notes}?limit=1`)).json.items).toHaveLength(1);
		expect((await root.client.get('/v1/admin/merchants/mer_0000000000000000000000000z/notes')).status).toBe(404);
		const entry = await h.db.collection(COLLECTIONS.audit).findOne({ action: 'merchant.note_added' }, { sort: { seq: 1 } });
		expect(entry).toMatchObject({ scope: `merchant:${a.merchantId}`, after: { length: 22 } });
		expect(JSON.stringify(entry)).not.toContain('Called about invoices');

		// search
		/** @param {string} q */
		const search = async (q) =>
			(await root.client.get(`/v1/admin/merchants?q=${encodeURIComponent(q)}`)).json.items
				.map((/** @type {any} */ m) => m.name)
				.sort();
		expect(await search('cafe')).toEqual(['Cafeteria Bob', 'Café Ölmühle']);
		expect(await search('CAFÉ Ö')).toEqual(['Café Ölmühle']);
		expect(await search('caf.*')).toEqual([]);
		expect(await search('bob@')).toEqual(['Cafeteria Bob']);
		expect(await search('ANNA@shop')).toEqual(['Café Ölmühle']);
		expect(await search('nobody@')).toEqual([]);
		expect(await search('zeta')).toEqual(['Zeta']);
		expect((await root.client.get(`/v1/admin/merchants?q=${'x'.repeat(121)}`)).status).toBe(400);
		const paged = await root.client.get('/v1/admin/merchants?q=caf&limit=1');
		expect(paged.json.items).toHaveLength(1);
		const next = await root.client.get(`/v1/admin/merchants?q=caf&limit=1&cursor=${paged.json.nextCursor}`);
		expect(next.json.items).toHaveLength(1);
		expect(next.json.items[0].merchantId).not.toBe(paged.json.items[0].merchantId);
		// renames keep the search key in sync
		await b.client.patch(`/v1/merchants/${b.merchantId}`, { name: 'Bistro Bob' });
		expect(await search('bistro')).toEqual(['Bistro Bob']);
		expect(await search('cafeteria')).toEqual([]);

		// migration: merchants created before nameKey existed are backfilled
		await h.db.collection(C.merchants).updateOne({ _id: /** @type {any} */ (a.merchantId) }, { $unset: { nameKey: '' } });
		expect(await search('café')).toEqual([]);
		const migration = /** @type {any} */ (identityModule).migrations.find((/** @type {any} */ m) => m.id.includes('name-key'));
		expect(await migration.plan()).toHaveLength(1);
		await migration.up({ db: h.db });
		expect(await search('café')).toEqual(['Café Ölmühle']);
	});

	it('search helpers', () => {
		expect(nameKey('  Café   Ölmühle ')).toBe('cafe olmuhle');
		expect(nameKey(null)).toBe('');
		expect(prefixPattern('a.b*(c)')).toBe('^a\\.b\\*\\(c\\)');
		expect(parseMerchantQuery('Bob@X')).toEqual({ kind: 'email', prefix: 'bob@x' });
		expect(parseMerchantQuery(' Café ')).toEqual({ kind: 'name', prefix: 'cafe' });
		expect(parseMerchantQuery('')).toBeNull();
		expect(parseMerchantQuery('́')).toBeNull();
		expect(parseMerchantQuery(5)).toBeNull();
		expect(parseMerchantQuery('x'.repeat(121))).toBeNull();
	});
});

describe('platform health and audit log', () => {
	it('reports the job queue; searches and verifies the audit log', async () => {
		const h = await boot();
		const root = await h.staffUser('root@example.com');
		const finance = await h.staffUser('fin@example.com', ['finance'], { creator: root.client });
		const owner = await h.signupOwner('owner@example.com', { merchantName: 'Acme' });

		// health before anything ran
		const before = await root.client.get('/v1/admin/system/health');
		expect(before.status).toBe(200);
		expect(before.json.jobs).toEqual({ queued: 0, leased: 0, retrying: 0, dead: 0 });
		expect(before.json).toEqual({ jobs: { queued: 0, leased: 0, retrying: 0, dead: 0 } });
		expect((await finance.client.get('/v1/admin/system/health')).status).toBe(403);
		expect((await owner.client.get('/v1/admin/system/health')).status).toBe(401);

		// jobs in every state
		const jobs = h.portal.shared.jobs;
		await jobs.enqueue({ name: 'test.queued' });
		await jobs.enqueue({ name: 'test.retry', maxAttempts: 3 });
		await jobs.enqueue({ name: 'test.dead', maxAttempts: 1 });
		await jobs.enqueue({ name: 'test.leased' });
		/** @param {string} name */
		const leaseNamed = async (name) => {
			for (;;) {
				const job = await jobs.lease({ names: [name], leaseMs: 60_000 });
				if (!job || job.name === name) return job;
			}
		};
		const retry = await leaseNamed('test.retry');
		if (retry) await jobs.fail(retry, new Error('boom'));
		const dead = await leaseNamed('test.dead');
		if (dead) await jobs.fail(dead, new Error('boom'));
		await leaseNamed('test.leased');
		const after = await root.client.get('/v1/admin/system/health');
		expect(after.json.jobs).toEqual({ queued: 1, leased: 1, retrying: 1, dead: 1 });

		// audit search
		const all = await finance.client.get('/v1/admin/audit');
		expect(all.status).toBe(200);
		expect(all.json.items.length).toBeGreaterThan(2);
		expect(all.json.items[0]).not.toHaveProperty('ip');
		const ats = all.json.items.map((/** @type {any} */ e) => e.at);
		expect([...ats].sort().reverse()).toEqual(ats);
		const merchantScope = await root.client.get(`/v1/admin/audit?scope=merchant:${owner.merchantId}`);
		expect(merchantScope.json.items.every((/** @type {any} */ e) => e.scope === `merchant:${owner.merchantId}`)).toBe(true);
		expect(merchantScope.json.items.length).toBeGreaterThan(0);
		const byActor = await root.client.get(`/v1/admin/audit?actorId=${root.staffId}`);
		expect(byActor.json.items.every((/** @type {any} */ e) => e.actor.id === root.staffId)).toBe(true);
		const byAction = await root.client.get('/v1/admin/audit?action=staff.created');
		expect(byAction.json.items.map((/** @type {any} */ e) => e.action)).toEqual(['staff.created']);
		const byPrefix = await root.client.get('/v1/admin/audit?action=staff.*');
		expect(byPrefix.json.items.length).toBeGreaterThan(1);
		expect(byPrefix.json.items.every((/** @type {any} */ e) => e.action.startsWith('staff.'))).toBe(true);
		const byTarget = await root.client.get(`/v1/admin/audit?targetId=${owner.merchantId}`);
		expect(byTarget.json.items.every((/** @type {any} */ e) => e.target.id === owner.merchantId)).toBe(true);
		expect((await root.client.get('/v1/admin/audit?scope=nope')).status).toBe(422);
		expect((await root.client.get('/v1/admin/audit?action=Bad Action')).status).toBe(422);
		// cursor pagination covers everything exactly once
		const seen = [];
		let cursor = '';
		for (let i = 0; i < 50; i += 1) {
			const page = await root.client.get(`/v1/admin/audit?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
			seen.push(...page.json.items.map((/** @type {any} */ e) => e.auditId));
			if (!page.json.nextCursor) break;
			cursor = page.json.nextCursor;
		}
		expect(new Set(seen).size).toBe(seen.length);
		expect(seen).toHaveLength((await root.client.get('/v1/admin/audit?limit=100')).json.items.length);
		expect((await root.client.get('/v1/admin/audit?cursor=bad!')).status).toBe(400);
		expect((await owner.client.get('/v1/admin/audit')).status).toBe(401);

		// verification
		const ok = await root.client.get('/v1/admin/audit/verification?scope=global');
		expect(ok.json).toMatchObject({ scope: 'global', ok: true, broken: null });
		expect(ok.json.entries).toBeGreaterThan(0);
		await h.db
			.collection(COLLECTIONS.audit)
			.updateOne({ scope: `merchant:${owner.merchantId}`, seq: 1 }, { $set: { action: 'tampered.entry' } });
		const broken = await root.client.get(`/v1/admin/audit/verification?scope=merchant:${owner.merchantId}`);
		expect(broken.json).toMatchObject({ ok: false, broken: { seq: 1, reason: 'hash' } });
		expect((await root.client.get('/v1/admin/audit/verification?scope=x')).status).toBe(400);
		expect((await root.client.get('/v1/admin/audit/verification')).status).toBe(400);
	});

	it('audit query parsing and presentation', () => {
		expect(parseAuditQuery({ scope: 'global', action: 'credits.*', actorId: 'stf_1', targetId: '', x: 'y' })).toEqual({
			ok: true,
			value: { scope: 'global', action: 'credits.*', actorId: 'stf_1' },
		});
		expect(parseAuditQuery({ scope: 'merchant:x', targetId: 'a b' })).toMatchObject({
			ok: false,
			errors: [{ path: '/scope' }, { path: '/targetId' }],
		});
		expect(
			presentAuditEntry({
				_id: 'a',
				at: new Date(0),
				action: 'x.y',
				actor: { type: 'system', id: 's' },
				target: {},
				ip: '1.2.3.4',
			}),
		).toEqual({
			auditId: 'a',
			at: '1970-01-01T00:00:00.000Z',
			scope: null,
			seq: null,
			hash: null,
			action: 'x.y',
			actor: { type: 'system', id: 's' },
			target: {},
			merchantId: null,
			reason: null,
			before: null,
			after: null,
			requestId: null,
		});
	});
});

describe('staff API tokens (F.18)', () => {
	it('mints a bearer token for tooling (ss pack publish), listed and revocable, never usable as a cookie', async () => {
		const h = await boot();
		const root = await h.staffUser('root@example.com');
		const support = await h.staffUser('support@example.com', ['support'], { creator: root.client });
		expect((await support.client.post('/v1/admin/api-tokens', { minutes: 30 })).status).toBe(403);
		expect((await root.client.post('/v1/admin/api-tokens', { minutes: 721 })).status).toBe(422);
		const minted = await root.client.post('/v1/admin/api-tokens', { minutes: 30, label: 'ci' });
		expect(minted.status).toBe(201);
		expect(minted.json.token).toMatch(/^sst_[A-Za-z0-9_-]{43}$/);
		expect(Date.parse(minted.json.expiresAt) - h.clock.now()).toBe(30 * 60_000);
		const bearer = { authorization: `Bearer ${minted.json.token}` };
		// a bearer needs no CSRF headers and acts as the staff member
		const listedStaff = await h.call('GET', '/v1/admin/staff', { headers: { ...bearer, origin: 'https://elsewhere.example' } });
		expect(listedStaff.status).toBe(200);
		// a token cannot mint another, a session token is no bearer, an API token is no cookie
		const again = await h.call('POST', '/v1/admin/api-tokens', {
			headers: { ...bearer, 'idempotency-key': 'x1' },
			body: { minutes: 5 },
		});
		expect(again.status).toBe(403);
		const [cookieName, sessionToken] = root.client.cookie.split('=');
		expect((await h.call('GET', '/v1/admin/staff', { headers: { authorization: `Bearer sst_${sessionToken}` } })).status).toBe(
			401,
		);
		expect((await h.call('GET', '/v1/admin/staff', { cookie: `${cookieName}=${minted.json.token.slice(4)}` })).status).toBe(
			401,
		);
		expect((await h.call('GET', '/v1/admin/staff', { headers: { authorization: 'Bearer sst_short' } })).status).toBe(401);
		const sessions = await root.client.get('/v1/me/sessions');
		const listed = sessions.json.items.find((/** @type {any} */ s) => s.sessionId === minted.json.sessionId);
		expect(listed).toMatchObject({ api: true, mfa: true });
		expect((await root.client.del(`/v1/me/sessions/${minted.json.sessionId}`)).status).toBe(204);
		expect((await h.call('GET', '/v1/admin/staff', { headers: bearer })).status).toBe(401);
		const audit = h.db.collection(COLLECTIONS.audit);
		expect(await audit.findOne({ action: 'staff.api_token_created' })).toMatchObject({
			actor: { type: 'staff', id: root.staffId },
		});
	});
});
