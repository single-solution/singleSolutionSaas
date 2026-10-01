import { describe, expect, it } from 'vitest';
import { scopeGranted } from '../src/index.js';
import { WEBSITE, setup, websiteKey } from './helpers.js';

const origin = 'https://shop.example.com';

describe('keys.verify', () => {
	it('verifies a pk_ key offline and returns the website binding', async () => {
		const { portal, product } = await setup();
		const key = await websiteKey(portal);
		const result = await product.keys.verify(`Bearer ${key}`, { origin, requiredScopes: ['coupons.read'] });
		expect(result).toEqual({
			ok: true,
			website: {
				websiteId: WEBSITE,
				merchantId: 'mer_0123456789abcdefghjkmnpq',
				domain: 'shop.example.com',
				allowSubdomains: false,
				env: 'live',
				scopes: ['coupons.read'],
				kind: 'pk',
				keyId: 'key_1',
			},
		});
	});

	it('enforces origins for pk_ (Referer only without Origin) but not for sk_', async () => {
		const { portal, product } = await setup();
		const pk = await websiteKey(portal);
		expect(await product.keys.verify(`Bearer ${pk}`, { origin: 'https://evil.example' })).toMatchObject({
			ok: false,
			code: 'origin_not_allowed',
		});
		expect(await product.keys.verify(`Bearer ${pk}`, {})).toMatchObject({ ok: false, code: 'origin_not_allowed' });
		expect(await product.keys.verify(`Bearer ${pk}`, { referer: 'https://shop.example.com/cart' })).toMatchObject({ ok: true });
		expect(await product.keys.verify(`Bearer ${pk}`, { origin: 'http://shop.example.com' })).toMatchObject({ ok: false });
		const sk = await websiteKey(portal, { kind: 'sk', keyId: 'key_2' });
		expect(await product.keys.verify(`Bearer ${sk}`, {})).toMatchObject({ ok: true, website: { kind: 'sk' } });
		expect(await product.keys.verify(`Bearer ${pk}`, { origin, expectedKind: 'sk' })).toMatchObject({
			ok: false,
			code: 'forbidden',
		});
	});

	it('requires scopes (exact or glob)', async () => {
		const { portal, product } = await setup();
		const key = await websiteKey(portal, { kind: 'sk', scopes: ['coupons.*'] });
		expect(await product.keys.verify(`Bearer ${key}`, { requiredScopes: ['coupons.write'] })).toMatchObject({ ok: true });
		expect(await product.keys.verify(`Bearer ${key}`, { requiredScopes: ['orders.read'] })).toMatchObject({
			ok: false,
			code: 'scope_missing',
		});
		expect(scopeGranted(['a'], 'a')).toBe(true);
		expect(scopeGranted(['a.*'], 'a.b.c')).toBe(true);
		expect(scopeGranted(['a.b'], 'a')).toBe(false);
	});

	it('rejects missing, malformed, tampered, expired and foreign keys', async () => {
		const { portal, product, clock } = await setup();
		expect(await product.keys.verify(undefined)).toMatchObject({ ok: false, code: 'unauthorized' });
		expect(await product.keys.verify('Basic abc')).toMatchObject({ ok: false, code: 'unauthorized' });
		expect(await product.keys.verify('Bearer sk_live_not.a.jws')).toMatchObject({ ok: false, code: 'invalid_credentials' });
		const key = await websiteKey(portal, { kind: 'sk', expiresAt: Math.floor(clock.now() / 1000) + 60 });
		expect(await product.keys.verify(`Bearer ${key.replace('sk_live_', 'sk_test_')}`)).toMatchObject({
			ok: false,
			code: 'invalid_credentials',
		});
		clock.advance(120_000);
		expect(await product.keys.verify(`Bearer ${key}`)).toMatchObject({ ok: false, code: 'invalid_credentials' });
	});

	it('pulls revocations and applies pushed ones immediately', async () => {
		const { portal, product, clock } = await setup();
		const key = await websiteKey(portal, { kind: 'sk' });
		expect(await product.keys.verify(`Bearer ${key}`)).toMatchObject({ ok: true });
		portal.revoke('key_1');
		// still cached within the sync interval
		expect(await product.keys.verify(`Bearer ${key}`)).toMatchObject({ ok: true });
		clock.advance(5 * 60_000);
		expect(await product.keys.verify(`Bearer ${key}`)).toMatchObject({ ok: false, code: 'invalid_credentials' });
		const other = await websiteKey(portal, { kind: 'sk', keyId: 'key_9' });
		await product.keys.revoke(['key_9']);
		expect(product.keys.isRevoked('key_9')).toBe(true);
		expect(await product.keys.verify(`Bearer ${other}`)).toMatchObject({ ok: false });
		const revocationCalls = portal.calls.filter((c) => c.path === '/v1/product/revocations');
		expect(revocationCalls).toHaveLength(2);
	});

	it('fails closed when revocations cannot be synced (cold start or beyond the grace)', async () => {
		const { portal, product, clock, logs } = await setup();
		const key = await websiteKey(portal, { kind: 'sk' });
		portal.setDown(true);
		expect(await product.keys.verify(`Bearer ${key}`)).toMatchObject({ ok: false, code: 'unavailable' });
		expect(logs.some((l) => l.msg === 'revocation sync failed')).toBe(true);
		portal.setDown(false);
		clock.advance(60_000);
		expect(await product.keys.verify(`Bearer ${key}`)).toMatchObject({ ok: true });
		portal.setDown(true);
		clock.advance(12 * 60 * 60_000);
		expect(await product.keys.verify(`Bearer ${key}`)).toMatchObject({ ok: true }); // within 24 h grace
		clock.advance(13 * 60 * 60_000);
		expect(await product.keys.verify(`Bearer ${key}`)).toMatchObject({ ok: false, code: 'unavailable' });
	});

	it('concurrent cold requests await the in-flight revocation sync (single-flight) instead of failing closed', async () => {
		const { portal, product } = await setup();
		const key = await websiteKey(portal, { kind: 'sk' });
		const results = await Promise.all(Array.from({ length: 8 }, () => product.keys.verify(`Bearer ${key}`)));
		expect(results.every((r) => r.ok)).toBe(true);
		expect(portal.calls.filter((c) => c.path === '/v1/product/revocations')).toHaveLength(1);
	});

	it('reports unavailable Portal keys', async () => {
		const { portal, product, clock } = await setup();
		const key = await websiteKey(portal, { kind: 'sk' });
		expect(await product.keys.verify(`Bearer ${key}`)).toMatchObject({ ok: true });
		portal.setJwks([]);
		clock.advance(4 * 60_000);
		portal.setDown(true);
		clock.advance(25 * 60 * 60_000);
		// revocations are stale too, which is checked first
		expect(await product.keys.verify(`Bearer ${key}`)).toMatchObject({ ok: false, code: 'unavailable' });
	});

	it('refuses a sync interval above 5 minutes', async () => {
		await expect(setup({ overrides: { cache: { revocationSyncMs: 10 * 60_000 } } })).rejects.toThrow(RangeError);
	});
});
