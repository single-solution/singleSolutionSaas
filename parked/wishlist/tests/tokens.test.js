import { describe, expect, it } from 'vitest';
import { generateSigningKey } from '@ss/protocol';
import { createTokens, hashShareToken, randomId, tokenSecret } from '../adapters/tokens.js';

describe('tokens', () => {
	it('issues and verifies website-bound, expiring guest tokens', () => {
		let now = Date.parse('2026-10-01T00:00:00Z');
		const tokens = createTokens({ secret: Buffer.alloc(32, 1), now: () => now });
		const { token, guestId, expiresAt } = tokens.issueGuest({ websiteId: 'web_a', ttlDays: 1 });
		expect(token.startsWith('wg1.')).toBe(true);
		expect(guestId).toMatch(/^gst_[0-9a-z]{26}$/);
		expect(tokens.verifyGuest(token, 'web_a')).toEqual({ guestId, expiresAt });
		expect(tokens.verifyGuest(token, 'web_b')).toBeNull();
		expect(tokens.issueGuest({ websiteId: 'web_a', guestId, ttlDays: 2 }).guestId).toBe(guestId);
		const [prefix, payload] = token.split('.');
		expect(tokens.verifyGuest(`${prefix}.${payload}.forged`, 'web_a')).toBeNull();
		expect(tokens.verifyGuest(`${token}.x`, 'web_a')).toBeNull();
		expect(tokens.verifyGuest(`wg1.${Buffer.from('nope').toString('base64url')}.x`, 'web_a')).toBeNull();
		expect(tokens.verifyGuest('x'.repeat(600), 'web_a')).toBeNull();
		expect(tokens.verifyGuest(42, 'web_a')).toBeNull();
		const other = createTokens({ secret: Buffer.alloc(32, 2), now: () => now });
		expect(other.verifyGuest(token, 'web_a')).toBeNull();
		now += 2 * 86_400_000;
		expect(tokens.verifyGuest(token, 'web_a')).toBeNull();
	});

	it('refuses a correctly signed but malformed payload', async () => {
		const secret = Buffer.alloc(32, 3);
		const tokens = createTokens({ secret });
		const { createHmac } = await import('node:crypto');
		const payload = Buffer.from('not json').toString('base64url');
		const sig = createHmac('sha256', secret).update(`wg1.${payload}`).digest('base64url');
		expect(tokens.verifyGuest(`wg1.${payload}.${sig}`, 'web_a')).toBeNull();
	});

	it('makes opaque share tokens and hashes them for storage', () => {
		const tokens = createTokens({ secret: Buffer.alloc(32, 1) });
		const token = tokens.newShareToken();
		expect(tokens.isShareToken(token)).toBe(true);
		expect(tokens.isShareToken('ILOU'.repeat(7).slice(0, 26))).toBe(false);
		expect(tokens.isShareToken(5)).toBe(false);
		expect(hashShareToken(token)).not.toContain(token);
		expect(hashShareToken(token)).toBe(hashShareToken(token));
		expect(randomId('wl')).toMatch(/^wl_[0-9a-z]{26}$/);
	});

	it('derives the secret from the signing key unless one is configured', async () => {
		const { privateJwk } = await generateSigningKey({ kid: 'k' });
		expect(tokenSecret({ secret: 's'.repeat(32), signingKey: null }).toString()).toBe('s'.repeat(32));
		const derived = tokenSecret({ secret: 'short', signingKey: `${privateJwk.kid}:${privateJwk.d}` });
		expect(derived).toHaveLength(32);
		expect(tokenSecret({ signingKey: privateJwk }).equals(derived)).toBe(true);
		expect(() => tokenSecret({ signingKey: { kty: 'OKP' } })).toThrow(/generated secret/);
	});
});
