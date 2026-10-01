import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateSigningKey, issueWebsiteKey, verifyWebsiteKey } from '@ss/protocol';
import { C } from '../../../src/modules/identity/schema.js';
import { boot, PORTAL_URL, setupMongo, teardownMongo } from './boot.js';

vi.setConfig({ testTimeout: 60_000 });
beforeAll(setupMongo, 120_000);
afterAll(teardownMongo, 60_000);

/** @param {Awaited<ReturnType<typeof boot>>} h */
const site = async (h, domain = 'shop.example.com') => {
	const owner = await h.signupOwner(`owner@${domain}`);
	const created = await owner.client.post(`/v1/merchants/${owner.merchantId}/websites`, { domain });
	const websiteId = created.json.website.websiteId;
	const base = `/v1/merchants/${owner.merchantId}/websites/${websiteId}/keys`;
	return { ...owner, websiteId, twinId: created.json.twin.websiteId, base };
};

/** @param {Awaited<ReturnType<typeof boot>>} h @param {string} key @param {Record<string, string>} [headers] */
const whoami = (h, key, headers = {}) =>
	h.call('GET', '/v1/system/whoami', { headers: { authorization: `Bearer ${key}`, ...headers } });

/** @param {Awaited<ReturnType<typeof boot>>} h @param {string} [since] */
const revocations = async (h, since) =>
	h.call('GET', `/v1/product/revocations${since ? `?since=${encodeURIComponent(since)}` : ''}`, {
		headers: { authorization: `Bearer ${await h.catalog.assertion(PORTAL_URL, h.clock.now)}` },
	});

describe('website keys', () => {
	it('issues pk_/sk_ verifiable with @ss/protocol; stores only the sk_ HMAC; lists metadata only', async () => {
		const h = await boot();
		const s = await site(h);
		const sk = await s.client.post(s.base, { kind: 'sk', scopes: ['events.publish', 'config.*'] });
		expect(sk.status).toBe(201);
		expect(sk.json.key).toMatch(/^sk_live_/);
		expect(sk.json).toMatchObject({
			kind: 'sk',
			env: 'live',
			status: 'active',
			websiteId: s.websiteId,
			scopes: ['events.publish', 'config.*'],
		});
		expect(sk.headers.get('idempotent-replayed')).toBeNull();
		const claims = await verifyWebsiteKey({
			key: sk.json.key,
			keyResolver: h.service.websiteKeyResolver(),
			revocations: [],
			now: h.clock.now,
		});
		expect(claims).toMatchObject({
			kind: 'sk',
			env: 'live',
			websiteId: s.websiteId,
			merchantId: s.merchantId,
			domain: 'shop.example.com',
			keyId: sk.json.keyId,
			allowSubdomains: false,
		});
		expect(h.service.websiteKeySigningSource()).toBe('infra');
		expect(h.service.websiteKeyJwks().keys.length).toBeGreaterThan(0);

		const pk = await s.client.post(`/v1/merchants/${s.merchantId}/websites/${s.twinId}/keys`, {
			kind: 'pk',
			scopes: ['events.publish'],
			allowSubdomains: true,
			expiresAt: new Date(h.clock.now() + 3600_000).toISOString(),
		});
		expect(pk.json.key).toMatch(/^pk_test_/);
		expect(pk.json.expiresAt).toBe(new Date(h.clock.now() + 3600_000).toISOString());

		// at rest: no key material, only the HMAC of the sk_
		const docs = await h.portal.modules.context('identity').collection(C.keys).acrossMerchants().find({}).toArray();
		expect(JSON.stringify(docs)).not.toContain(sk.json.key.slice(8));
		expect(JSON.stringify(docs)).not.toContain(pk.json.key.slice(8));
		const skDoc = docs.find((/** @type {any} */ d) => d._id === sk.json.keyId);
		expect(h.portal.shared.secretHasher.verify(sk.json.key, skDoc.secretHash)).toBe(true);
		expect(docs.find((/** @type {any} */ d) => d._id === pk.json.keyId).secretHash).toBeNull();

		const list = await s.client.get(s.base);
		expect(list.json.items).toHaveLength(1);
		expect(Object.keys(list.json.items[0]).sort()).toEqual(
			[
				'allowSubdomains',
				'createdAt',
				'env',
				'expiresAt',
				'hint',
				'keyId',
				'kid',
				'kind',
				'replacedBy',
				'revokeAt',
				'revokeReason',
				'rotatedFrom',
				'scopes',
				'status',
				'websiteId',
			].sort(),
		);
		expect(list.json.items[0].hint).toMatch(/^sk_live_…/);

		// the infra websiteKey authenticator accepts them (port: record + revocation check)
		const who = await whoami(h, sk.json.key);
		expect(who.json).toMatchObject({ authMode: 'websiteKey', website: { websiteId: s.websiteId, kind: 'sk', env: 'live' } });
		expect((await whoami(h, pk.json.key, { origin: 'https://www.shop.example.com' })).status).toBe(200);
		expect((await whoami(h, pk.json.key, { origin: 'https://evil.example.org' })).status).toBe(403);

		// validation
		expect((await s.client.post(s.base, { kind: 'xk', scopes: ['a'] })).status).toBe(422);
		expect((await s.client.post(s.base, { kind: 'pk', scopes: [] })).status).toBe(422);
		expect((await s.client.post(s.base, { kind: 'pk', scopes: ['a', 'a'] })).status).toBe(422);
		expect(
			(await s.client.post(s.base, { kind: 'pk', scopes: ['a'], expiresAt: new Date(h.clock.now() - 1000).toISOString() }))
				.status,
		).toBe(422);
		expect((await s.client.post(s.base, { kind: 'pk', scopes: ['a'], expiresAt: 'tomorrow' })).status).toBe(422);
		await expect(
			h.service.issueKey({ websiteId: s.websiteId, kind: 'pk', scopes: ['a'], expiresAt: 'garbage' }),
		).rejects.toMatchObject({ code: 'validation_failed' });
		const viaService = await h.service.issueKey({
			websiteId: s.websiteId,
			kind: 'pk',
			scopes: ['a'],
			expiresAt: h.clock.now() + 7200_000,
		});
		expect(viaService).toMatchObject({ kind: 'pk', status: 'active' });

		// expired keys
		h.clock.advance(3700_000);
		expect((await whoami(h, pk.json.key, { origin: 'https://shop.example.com' })).status).toBe(401);
	});

	it('revokes immediately: authenticator, revocation list, key.revoked@1, idempotent', async () => {
		const h = await boot();
		const s = await site(h);
		const sk = (await s.client.post(s.base, { kind: 'sk', scopes: ['events.publish'] })).json;
		const first = await revocations(h);
		expect(first.status).toBe(200);
		expect(first.json.keyIds).toEqual([]);
		expect(typeof first.json.cursor).toBe('string');

		const revoked = await s.client.post(`${s.base}/${sk.keyId}/revoke`, { reason: 'leaked in a repo' });
		expect(revoked.json).toMatchObject({ keyId: sk.keyId, status: 'revoked', revokeReason: 'leaked in a repo' });
		expect((await whoami(h, sk.key)).status).toBe(401);
		expect(h.integration.events).toEqual([
			{
				type: 'key.revoked@1',
				data: { keyIds: [sk.keyId], revokedAt: new Date(h.clock.now()).toISOString() },
				options: { websiteId: s.websiteId },
			},
		]);
		const next = await revocations(h, first.json.cursor);
		expect(next.json.keyIds).toEqual([sk.keyId]);
		expect((await revocations(h)).json.keyIds).toEqual([sk.keyId]);
		expect((await s.client.post(`${s.base}/${sk.keyId}/revoke`, {})).json.status).toBe('revoked');
		expect(h.integration.events).toHaveLength(1);
		h.clock.advance(60_000);
		expect((await revocations(h, next.json.cursor)).json.keyIds).toEqual([sk.keyId]); // inside the lag window: repeated
		const later = await revocations(h, (await revocations(h, next.json.cursor)).json.cursor);
		expect(later.json.keyIds).toEqual([]);
		expect((await revocations(h, 'not+a+cursor')).status).toBe(400);
		expect((await revocations(h, '2026-01-01T00:00:00Z')).json.keyIds).toEqual([sk.keyId]);
		expect((await h.call('GET', '/v1/product/revocations')).status).toBe(401);
		expect((await h.call('GET', '/v1/product/revocations', { cookie: s.client.cookie })).status).toBe(401);
		expect(await h.service.revocationsSince(null)).toMatchObject({ keyIds: [sk.keyId] });
		await expect(h.service.revokeKey({ keyId: 'key_00000000000000000000000000', reason: 'x' })).rejects.toMatchObject({
			code: 'not_found',
		});
		const k2 = await h.service.issueKey({ websiteId: s.websiteId, kind: 'pk', scopes: ['a'] });
		expect((await h.service.revokeKey({ keyId: k2.keyId, reason: 'service' })).status).toBe('revoked');
		const audit = await h.portal.shared.audit.list({ targetId: sk.keyId });
		expect(audit.map((e) => [e.action, e.reason])).toEqual(
			expect.arrayContaining([
				['key.revoked', 'leaked in a repo'],
				['key.issued', null],
			]),
		);
	});

	it('rotates with a grace period, then revokes the old key (scheduled job)', async () => {
		const h = await boot();
		const s = await site(h);
		const old = (await s.client.post(s.base, { kind: 'sk', scopes: ['events.publish'] })).json;
		const rotated = await s.client.post(`${s.base}/${old.keyId}/rotate`, { graceSeconds: 3600 });
		expect(rotated.status).toBe(201);
		expect(rotated.json).toMatchObject({
			kind: 'sk',
			rotatedFrom: old.keyId,
			status: 'active',
			previous: { keyId: old.keyId, status: 'revoking', replacedBy: rotated.json.keyId },
		});
		expect(rotated.json.key).toMatch(/^sk_live_/);
		expect((await whoami(h, old.key)).status).toBe(200); // still valid during the grace
		expect((await whoami(h, rotated.json.key)).status).toBe(200);
		expect((await s.client.post(`${s.base}/${old.keyId}/rotate`, {})).status).toBe(409);
		expect((await revocations(h)).json.keyIds).toEqual([]);
		h.clock.advance(3600_000);
		expect((await whoami(h, old.key)).status).toBe(401);
		expect((await revocations(h)).json.keyIds).toEqual([old.keyId]);
		expect(h.integration.events).toEqual([]);
		const drained = await h.call('POST', '/cron/drain', { headers: { authorization: `Bearer ${h.config.cronSecret}` } });
		expect(drained.status).toBe(200);
		expect(h.integration.events).toEqual([
			expect.objectContaining({ type: 'key.revoked@1', data: expect.objectContaining({ keyIds: [old.keyId] }) }),
		]);
		const list = (await s.client.get(s.base)).json.items;
		expect(list.map((/** @type {any} */ k) => [k.keyId, k.status])).toEqual(
			expect.arrayContaining([
				[old.keyId, 'revoked'],
				[rotated.json.keyId, 'active'],
			]),
		);

		// zero grace: immediate
		const now = await s.client.post(`${s.base}/${rotated.json.keyId}/rotate`, { graceSeconds: 0 });
		expect((await whoami(h, rotated.json.key)).status).toBe(401);
		expect(h.integration.events.at(-1)?.data.keyIds).toEqual([rotated.json.keyId]);
		expect((await s.client.post(`${s.base}/${now.json.keyId}/rotate`, { graceSeconds: 99_999_999 })).status).toBe(422);

		// the job tolerates early runs, unknown keys and unscheduled keys
		await expect(
			h.service.keys.onScheduledRevocation({ keyId: 'key_00000000000000000000000000', merchantId: s.merchantId }),
		).resolves.toEqual({ skipped: true });
		const pending = await s.client.post(`${s.base}/${now.json.keyId}/rotate`, { graceSeconds: 600 });
		await expect(h.service.keys.onScheduledRevocation({ keyId: now.json.keyId, merchantId: s.merchantId })).rejects.toThrow(
			/not yet/,
		);
		await expect(
			h.service.keys.onScheduledRevocation({ keyId: pending.json.keyId, merchantId: s.merchantId }),
		).resolves.toEqual({ skipped: true });
		// expiry is carried over on rotation when still ahead
		const expiring = await s.client.post(s.base, {
			kind: 'pk',
			scopes: ['a'],
			expiresAt: new Date(h.clock.now() + 86_400_000).toISOString(),
		});
		const carried = await s.client.post(`${s.base}/${expiring.json.keyId}/rotate`, {});
		expect(carried.json.expiresAt).toBe(expiring.json.expiresAt);
	});

	it('the websiteKeyRevoked port fails closed for unknown, relabelled or mismatched keys', async () => {
		const h = await boot();
		const s = await site(h);
		const sk = (await s.client.post(s.base, { kind: 'sk', scopes: ['a'] })).json;
		const claims = await verifyWebsiteKey({
			key: sk.key,
			keyResolver: h.service.websiteKeyResolver(),
			revocations: [],
			now: h.clock.now,
		});
		expect(await h.service.isKeyRevoked(claims)).toBe(false);
		expect(await h.service.isKeyRevoked(claims, sk.key)).toBe(false);
		expect(await h.service.isKeyRevoked(claims, `${sk.key}x`)).toBe(true); // HMAC mismatch
		expect(await h.service.isKeyRevoked({ ...claims, websiteId: s.twinId })).toBe(true);
		expect(await h.service.isKeyRevoked({ ...claims, env: 'test' })).toBe(true);
		// a key signed with the website-key signer but never issued (no record) is refused
		const forged = await issueWebsiteKey({
			signer: h.portal.shared.keys.websiteKeySigner,
			kind: 'sk',
			websiteId: s.websiteId,
			merchantId: s.merchantId,
			domain: 'shop.example.com',
			env: 'live',
			scopes: ['*'],
			keyId: 'key_forged000000000000000000',
			now: h.clock.now,
		});
		expect((await whoami(h, forged.key)).status).toBe(401);
	});

	it('uses a dedicated website-key signer when configured', async () => {
		const { privateJwk } = await generateSigningKey({ kid: 'website-keys-2026-10' });
		const h = await boot({ identity: { websiteKeySigningKeys: [privateJwk] } });
		const s = await site(h);
		const pk = (await s.client.post(s.base, { kind: 'pk', scopes: ['a'] })).json;
		expect(pk.kid).toBe('website-keys-2026-10');
		expect(h.service.websiteKeySigningSource()).toBe('option');
		expect(h.service.websiteKeyJwks().keys.map((k) => k.kid)).toEqual(['website-keys-2026-10']);
		const claims = await verifyWebsiteKey({
			key: pk.key,
			keyResolver: h.service.websiteKeyResolver(),
			revocations: [],
			now: h.clock.now,
		});
		expect(claims.kid).toBe('website-keys-2026-10');
		// the Portal key resolver does not know the dedicated key: the infra must publish it (reported infra change)
		await expect(
			verifyWebsiteKey({ key: pk.key, keyResolver: h.portal.shared.keys.keyResolver, revocations: [], now: h.clock.now }),
		).rejects.toThrow();
	});

	it('works without the integration module and survives a failing one', async () => {
		const solo = await boot({ integration: false });
		const s = await site(solo);
		const key = (await s.client.post(s.base, { kind: 'pk', scopes: ['a'] })).json;
		expect((await s.client.post(`${s.base}/${key.keyId}/revoke`, {})).json.status).toBe('revoked');
		const broken = await boot({ integration: { fail: true } });
		const b = await site(broken);
		const k2 = (await b.client.post(b.base, { kind: 'pk', scopes: ['a'] })).json;
		expect((await b.client.post(`${b.base}/${k2.keyId}/revoke`, {})).json.status).toBe('revoked');
		expect(broken.entries.some((e) => e.msg === 'key.revoked@1 could not be emitted')).toBe(true);
	});
});
