import { describe, expect, it } from 'vitest';
import { generateSigningKey } from '@ss/protocol';
import { createPlatform } from '../adapters/platform.js';
import { createWalletTokens, MIN_SECRET_LENGTH, stableId, walletSecret } from '../adapters/tokens.js';
import { mongoUri, ROOT } from './harness.js';

describe('adapters/tokens', () => {
	it('derives stable ids and wallet secrets', async () => {
		expect(stableId('a')).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
		expect(stableId('a')).toBe(stableId('a'));
		expect(stableId('a')).not.toBe(stableId('b'));
		const configured = walletSecret({ secret: 'x'.repeat(MIN_SECRET_LENGTH) });
		expect(configured.toString()).toBe('x'.repeat(MIN_SECRET_LENGTH));
		const { privateJwk } = await generateSigningKey({ kid: 'k' });
		const derived = walletSecret({ secret: 'short', signingKey: `${privateJwk.kid}:${privateJwk.d}` });
		expect(derived).toHaveLength(32);
		expect(walletSecret({ signingKey: /** @type {any} */ (privateJwk) }).equals(derived)).toBe(true);
		expect(() => walletSecret({ signingKey: null })).toThrow(/generated secret/);
	});

	it('issues website-bound, expiring wallet tokens and refuses tampering', () => {
		let now = Date.parse('2026-10-01T00:00:00Z');
		const tokens = createWalletTokens({ secret: Buffer.alloc(32, 1), now: () => now });
		const { token, expiresAt } = tokens.issue({ websiteId: 'web_1', customerId: 'cus_1', ttlMinutes: 5 });
		expect(expiresAt).toBe('2026-10-01T00:05:00.000Z');
		expect(tokens.verify(token, 'web_1')).toBe('cus_1');
		expect(tokens.verify(token, 'web_2')).toBeNull();
		expect(tokens.verify(`${token.slice(0, -2)}xx`, 'web_1')).toBeNull();
		expect(tokens.verify('wt1.e30.c2ln', 'web_1')).toBeNull();
		expect(tokens.verify('wt2.a.b', 'web_1')).toBeNull();
		expect(tokens.verify(42, 'web_1')).toBeNull();
		const other = createWalletTokens({ secret: Buffer.alloc(32, 1) });
		const forgedPayload = `wt1.${Buffer.from('not json').toString('base64url')}`;
		const signature = other.issue({ websiteId: 'w', customerId: 'c', ttlMinutes: 1 }).token.split('.')[2];
		expect(tokens.verify(`${forgedPayload}.${signature}`, 'web_1')).toBeNull();
		now += 6 * 60_000;
		expect(tokens.verify(token, 'web_1')).toBeNull();
	});
});

describe('adapters/platform', () => {
	it('refuses to start without the required environment', async () => {
		// no environment at all: an unconnected product (in-memory control store) that only serves its connect endpoint
		const unconnected = await createPlatform({ env: {}, root: ROOT });
		expect(unconnected.product.connected()).toBe(false);
		await unconnected.close?.();
	});

	it('uses the product control database when MONGODB_URI is set', async () => {
		const { privateJwk } = await generateSigningKey({ kid: 'k' });
		const app = await createPlatform({
			root: ROOT,
			env: {
				MONGODB_URI: mongoUri(`loyalty_control_${Date.now()}`),
				OUTBOUND_DEV_ALLOW_HOSTS: '127.0.0.1',
			},
			overrides: { portalUrl: 'https://portal.test', signingKey: `${privateJwk.kid}:${privateJwk.d}` },
		});
		expect(app.strings.en?.['wallet.title']).toBe('Your rewards');
		await app.close();
	});
});
