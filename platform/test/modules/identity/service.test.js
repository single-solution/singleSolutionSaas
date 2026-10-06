import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateSigningKey } from '@ss/protocol';
import { createPortalKeys } from '../../../src/infra/crypto.js';
import { websiteKeySigning } from '../../../src/modules/identity/service.js';
import { C } from '../../../src/modules/identity/schema.js';
import { boot, setupMongo, teardownMongo } from './boot.js';

vi.setConfig({ testTimeout: 60_000 });
beforeAll(setupMongo, 120_000);
afterAll(teardownMongo, 60_000);

describe('identity service wiring', () => {
	it('selects the website-key signer: option › the infra dedicated signer', async () => {
		const { privateJwk: portal } = await generateSigningKey({ kid: 'portal' });
		const { privateJwk: dedicated } = await generateSigningKey({ kid: 'website-keys' });
		const { privateJwk: option } = await generateSigningKey({ kid: 'website-option' });
		const keys = createPortalKeys([portal], [dedicated]);
		const ctx = /** @type {any} */ ({ keys });
		const selected = websiteKeySigning(ctx, {});
		expect([selected.source, selected.signer.kid, selected.jwks().keys.map((k) => k.kid)]).toEqual([
			'infra',
			'website-keys',
			['website-keys'],
		]);
		expect(selected.keyResolver).toBe(keys.websiteKeyResolver);
		const chosen = websiteKeySigning(ctx, { websiteKeySigningKeys: [option] });
		expect([chosen.source, chosen.signer.kid, chosen.jwks().keys[0]?.kid]).toEqual([
			'option',
			'website-option',
			'website-option',
		]);
	});

	it('defaults: the platform mailer (logging outside production, none in production without SMTP)', async () => {
		const dev = await boot({ identity: { mailer: undefined } });
		const res = await dev.call('POST', '/v1/auth/merchant/signup', {
			body: { email: 'dev@example.com', password: 'a long password', merchantName: 'D' },
		});
		expect(res.status).toBe(202);
		expect(dev.entries.find((e) => e.msg === 'mail (development mailer)')?.fields).toMatchObject({
			to: 'dev@example.com',
			template: 'verify_email',
		});

		const prod = await boot({ identity: { mailer: undefined }, env: { NODE_ENV: 'production' } });
		expect(
			(
				await prod.call('POST', '/v1/auth/merchant/signup', {
					body: { email: 'p@example.com', password: 'a long password', merchantName: 'P' },
				})
			).status,
		).toBe(503);
	});

	it('sessionActor: live roles, removed members and deactivated accounts', async () => {
		const h = await boot();
		const owner = await h.signupOwner('o@example.com');
		const { token } = await h.portal.shared.sessions.create({ kind: 'merchant', subject: owner.userId, merchantId: null });
		const session = /** @type {any} */ (await h.portal.shared.sessions.get(token));
		expect(await h.service.sessionActor(session)).toEqual({ type: 'merchant_user', id: owner.userId, roles: [], grants: [] });
		const impersonated = { ...session, merchantId: owner.merchantId, via: { type: 'staff', id: 'stf_1' } };
		expect(await h.service.sessionActor(impersonated)).toMatchObject({
			merchantId: owner.merchantId,
			roles: ['owner'],
			via: { id: 'stf_1' },
		});
		expect(await h.service.sessionActor({ ...session, merchantId: 'mer_00000000000000000000000000' })).toBeNull();
		const users = h.portal.modules.context('identity').collection(C.users);
		await users.updateOne({ _id: owner.userId }, { $set: { status: 'disabled' } });
		expect(await h.service.sessionActor(session)).toBeNull();
		expect((await owner.client.get('/v1/me')).status).toBe(401);
		expect(await h.service.sessionActor({ ...session, kind: 'staff', subject: 'stf_ghost' })).toBeNull();
		// a disabled account cannot log in, reset or accept invites
		expect(
			(await h.call('POST', '/v1/auth/merchant/login', { body: { email: 'o@example.com', password: owner.password } })).status,
		).toBe(401);
		await h.call('POST', '/v1/auth/merchant/password-reset', { body: { email: 'o@example.com' } });
		expect(h.mailer.sent.filter((m) => m.template === 'password_reset')).toHaveLength(0);
	});

	it('re-hashes weaker password hashes on login; website keys are signed by the dedicated signer', async () => {
		const h = await boot();
		const owner = await h.signupOwner('o@example.com');
		const { hashPassword } = await import('../../../src/infra/auth.js');
		const users = h.portal.modules.context('identity').collection(C.users);
		await users.updateOne(
			{ _id: owner.userId },
			{ $set: { passwordHash: await hashPassword(owner.password, { params: { N: 2 ** 14 } }) } },
		);
		expect(
			(await h.call('POST', '/v1/auth/merchant/login', { body: { email: 'o@example.com', password: owner.password } })).status,
		).toBe(200);
		expect((await users.findOne({ _id: owner.userId }))?.passwordHash).toMatch(/^scrypt\$32768\$/);
		const site = await owner.client.post(`/v1/merchants/${owner.merchantId}/websites`, { domain: 'x.example.com' });
		const base = `/v1/merchants/${owner.merchantId}/websites/${site.json.website.websiteId}/keys`;
		const issued = await owner.client.post(base, { kind: 'pk', scopes: ['events.write'] });
		const header =
			String(issued.json.key)
				.replace(/^pk_(live|test)_/, '')
				.split('.')[0] ?? '';
		const { kid } = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
		expect(kid).toBe(h.portal.shared.keys.websiteKeySigner.kid);
		expect(h.portal.shared.keys.signers.some((s) => s.kid === kid)).toBe(false);
	});
});
