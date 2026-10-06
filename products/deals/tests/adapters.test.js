import { describe, expect, it } from 'vitest';
import { createPlatform } from '../adapters/platform.js';
import { createLockTokens, lockSecret, MAX_TOKEN_LENGTH } from '../adapters/locks.js';
import { lockClaims } from '../core/locks.js';
import { ROOT } from './harness.js';

const claims = lockClaims({
	websiteId: 'web_1',
	currency: 'EUR',
	itemId: 'i',
	variantId: null,
	unitAmount: 1000,
	unitPrice: 800,
	units: 1,
	dealIds: ['dl_1'],
	classes: ['item'],
	customerId: null,
	ttlMinutes: 5,
	now: Date.parse('2026-10-02T12:00:00Z'),
});

describe('price-lock tokens', () => {
	it('signs and verifies, refusing tampering and other secrets', () => {
		const tokens = createLockTokens({ secret: lockSecret({ secret: 's'.repeat(32) }) });
		const token = tokens.sign(claims);
		expect(tokens.verify(token)).toEqual(claims);
		const [prefix, payload, signature] = token.split('.');
		expect(tokens.verify(`${prefix}.${payload}.${signature?.slice(0, -2)}aa`)).toBeNull();
		expect(
			tokens.verify(`${prefix}.${Buffer.from(JSON.stringify({ ...claims, p: 1 })).toString('base64url')}.${signature}`),
		).toBeNull();
		expect(tokens.verify(`${token}.extra`)).toBeNull();
		expect(tokens.verify('xx1.a.b')).toBeNull();
		expect(tokens.verify(5)).toBeNull();
		expect(tokens.verify('x'.repeat(MAX_TOKEN_LENGTH + 1))).toBeNull();
		const other = createLockTokens({ secret: lockSecret({ secret: 't'.repeat(32) }) });
		expect(other.verify(token)).toBeNull();
		// authentic but not lock claims
		const junk = createLockTokens({ secret: lockSecret({ secret: 's'.repeat(32) }) }).sign(/** @type {any} */ ({ v: 2 }));
		expect(tokens.verify(junk)).toBeNull();
		const notJson = `pl1.${Buffer.from('nope').toString('base64url')}`;
		const signer = createLockTokens({ secret: lockSecret({ secret: 's'.repeat(32) }) });
		const forgedSig = signer.sign(claims).split('.')[2];
		expect(tokens.verify(`${notJson}.${forgedSig}`)).toBeNull();
	});
	it('derives the secret from the signing key when none is configured', () => {
		const key = { kty: 'OKP', crv: 'Ed25519', d: Buffer.from('k'.repeat(32)).toString('base64url'), x: 'x' };
		expect(lockSecret({ signingKey: JSON.stringify(key) })).toEqual(lockSecret({ signingKey: key }));
		expect(lockSecret({ secret: 'short', signingKey: key }).length).toBe(32);
		expect(() => lockSecret({ signingKey: null })).toThrow(/DEALS_LOCK_SECRET/);
	});
});

describe('platform', () => {
	it('refuses to start without the required environment', async () => {
		await expect(createPlatform({ env: {}, root: ROOT })).rejects.toThrow(
			/SS_PORTAL_URL, SS_APP_SIGNING_KEY, SS_REGISTRATION_TOKEN_HASH/,
		);
	});
});
