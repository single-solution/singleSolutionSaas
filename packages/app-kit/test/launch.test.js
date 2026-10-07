import { describe, expect, it } from 'vitest';
import { createProduct } from '../src/index.js';
import { APP_ID, PORTAL_URL, manifest, setup } from './helpers.js';

const user = { id: 'usr_1', email: 'a@example.com' };

describe('launch', () => {
	it.each([
		['merchant', 'merchant', { scope: { merchantId: 'mer_1', websiteIds: ['web_1'] } }],
		['admin', 'platform_admin', { scope: { merchantId: 'mer_1' } }],
	])('maps %s launches to the %s role', async (kind, role, extra) => {
		const { portal, product } = await setup();
		const { token } = await portal.issueLaunch({ subject: 'usr_1', kind: /** @type {any} */ (kind), user, ...extra });
		const result = await product.launch.verify(token);
		expect(result).toMatchObject({ ok: true, role });
	});

	it('is single use and rejects tampering, wrong audience and expiry', async () => {
		const { portal, product, clock } = await setup();
		const { token } = await portal.issueLaunch({ subject: 'usr_1', kind: 'merchant', user, scope: { merchantId: 'mer_1' } });
		expect((await product.launch.verify(token)).ok).toBe(true);
		expect(await product.launch.verify(token)).toEqual({ ok: false, code: 'replay' });
		const other = await portal.issueLaunch({
			subject: 'usr_1',
			kind: 'merchant',
			user,
			scope: { merchantId: 'mer_1' },
			audience: 'app_other',
		});
		expect(await product.launch.verify(other.token)).toEqual({ ok: false, code: 'audience' });
		const late = await portal.issueLaunch({ subject: 'usr_1', kind: 'merchant', user, scope: { merchantId: 'mer_1' } });
		clock.advance(120_000);
		expect(await product.launch.verify(late.token)).toEqual({ ok: false, code: 'expired' });
		expect(await product.launch.verify('garbage')).toMatchObject({ ok: false });
	});

	it('exchanges a launch for a session that expires', async () => {
		const { portal, product, clock } = await setup();
		const { token } = await portal.issueLaunch({ subject: 'usr_1', kind: 'admin', user, scope: { merchantId: 'mer_1' } });
		const exchanged = await product.launch.exchange(token, { ttlMs: 600_000 });
		if (!exchanged.ok) throw new Error('exchange failed');
		expect(exchanged.session).toMatchObject({ role: 'platform_admin', subject: 'usr_1', scope: { merchantId: 'mer_1' } });
		expect(exchanged.session.expiresAt).toBe(clock.now() + 600_000);
		const found = await product.launch.session(exchanged.session.id);
		expect(found).toMatchObject({ id: exchanged.session.id, role: 'platform_admin' });
		expect(await product.launch.session('nope')).toBeNull();
		expect(await product.launch.session(undefined)).toBeNull();
		clock.advance(601_000);
		expect(await product.launch.session(exchanged.session.id)).toBeNull();
		expect(await product.launch.exchange(token)).toEqual({ ok: false, code: 'expired' });
	});

	it('logs out', async () => {
		const { portal, product } = await setup();
		const { token } = await portal.issueLaunch({ subject: 'usr_1', kind: 'merchant', user, scope: { merchantId: 'mer_1' } });
		const exchanged = await product.launch.exchange(token, { ttlMs: 1000 });
		if (!exchanged.ok) throw new Error('exchange failed');
		await product.launch.logout(exchanged.session.id);
		expect(await product.launch.session(exchanged.session.id)).toBeNull();
	});

	it('can also burn launches at the Portal', async () => {
		const { portal, product, privateJwk, clock } = await setup({ overrides: { onlineLaunchConsume: true } });
		const { token } = await portal.issueLaunch({ subject: 'usr_1', kind: 'merchant', user, scope: { merchantId: 'mer_1' } });
		expect((await product.launch.verify(token)).ok).toBe(true);
		expect(portal.calls.some((c) => c.path === '/v1/product/launch/consume')).toBe(true);
		// a second instance with its own (empty) local store is still stopped by the Portal
		const second = createProduct({
			manifest: manifest(),
			portalUrl: PORTAL_URL,
			appId: APP_ID,
			signingKey: privateJwk,
			fetch: portal.fetch,
			now: clock.now,
			onlineLaunchConsume: true,
		});
		expect(await second.launch.verify(token)).toEqual({ ok: false, code: 'replay' });
	});

	it('fails when the product is not registered', async () => {
		const { portal, product } = await setup({ overrides: { appId: null } });
		const { token } = await portal.issueLaunch({ subject: 'usr_1', kind: 'merchant', user, scope: { merchantId: 'mer_1' } });
		expect(await product.launch.verify(token)).toEqual({ ok: false, code: 'not_registered' });
	});
});
