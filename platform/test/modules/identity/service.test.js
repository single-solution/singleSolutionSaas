import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateSigningKey } from '@ss/protocol';
import { createPortalKeys } from '../../../src/infra/crypto.js';
import { websiteKeySigning } from '../../../src/modules/identity/service.js';
import { C } from '../../../src/modules/identity/schema.js';
import { PRODUCTION_ENV } from '../../helpers.js';
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

	it('defaults: the platform mailer (logging outside production; in production without SMTP e-mails are skipped)', async () => {
		const dev = await boot({ identity: { mailer: undefined } });
		const o = await dev.owner();
		const created = await o.client.post('/v1/admin/merchants', { name: 'D', ownerName: 'D', email: 'dev@example.com' });
		expect(created.json.setup.mailed).toBe(true);
		expect(dev.entries.find((e) => e.msg === 'mail (development mailer)')?.fields).toMatchObject({
			to: 'dev@example.com',
			template: 'merchant_setup',
		});

		const prod = await boot({ identity: { mailer: undefined }, env: { ...PRODUCTION_ENV } });
		const p = await prod.owner();
		const skipped = await p.client.post('/v1/admin/merchants', { name: 'P', ownerName: 'P', email: 'p@example.com' });
		expect([skipped.status, skipped.json.setup.mailed]).toEqual([201, false]);
		// the Overview warns while e-mail sending is not set up
		expect((await p.client.get('/v1/admin/overview')).json).toMatchObject({ mailConfigured: false, merchants: 1, websites: 0 });
	});

	it('sessionActor: the live role and name; removed admins and suspended or deleted merchants are signed out', async () => {
		const h = await boot();
		const m = await h.merchant('o@example.com');
		const o = await h.owner();
		const { token } = await h.portal.shared.sessions.create({ kind: 'merchant', subject: m.merchantId });
		const session = /** @type {any} */ (await h.portal.shared.sessions.get(token));
		expect(await h.service.sessionActor(session)).toEqual({ type: 'merchant', id: m.merchantId, merchantId: m.merchantId });
		expect(await h.service.sessionActor({ ...session, subject: 'mer_00000000000000000000000000' })).toBeNull();
		expect(await h.service.sessionActor({ ...session, kind: 'admin', subject: o.adminId })).toEqual({
			type: 'admin',
			id: o.adminId,
			role: 'owner',
			name: 'Olivia Owner',
			twoStepRequired: false,
		});
		expect(await h.service.sessionActor({ ...session, kind: 'admin', subject: 'adm_ghost' })).toBeNull();
		const merchants = h.portal.modules.context('identity').collection(C.merchants);
		await merchants.updateOne({ _id: m.merchantId }, { $set: { status: 'suspended' } });
		expect(await h.service.sessionActor(session)).toBeNull();
		await merchants.updateOne({ _id: m.merchantId }, { $set: { status: 'deleted' } });
		expect(await h.service.sessionActor(session)).toBeNull();
	});

	it('re-hashes weaker password hashes on sign-in; website keys are signed by the dedicated signer', async () => {
		const h = await boot();
		const m = await h.merchantWithWebsite('o@example.com', 'x.example.com');
		const { hashPassword } = await import('../../../src/infra/auth.js');
		const merchants = h.portal.modules.context('identity').collection(C.merchants);
		await merchants.updateOne(
			{ _id: m.merchantId },
			{ $set: { passwordHash: await hashPassword(m.password, { params: { N: 2 ** 14 } }) } },
		);
		expect((await h.call('POST', '/v1/auth/sign-in', { body: { email: 'o@example.com', password: m.password } })).status).toBe(
			200,
		);
		expect((await merchants.findOne({ _id: m.merchantId }))?.passwordHash).toMatch(/^scrypt\$32768\$/);
		const base = `/v1/merchants/${m.merchantId}/websites/${m.websiteId}/keys`;
		const issued = await m.client.post(base, { kind: 'pk', scopes: ['events.write'] });
		const header =
			String(issued.json.key)
				.replace(/^pk_(live|test)_/, '')
				.split('.')[0] ?? '';
		const { kid } = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
		expect(kid).toBe(h.portal.shared.keys.websiteKeySigner.kid);
		expect(h.portal.shared.keys.signers.some((s) => s.kid === kid)).toBe(false);
	});
});
