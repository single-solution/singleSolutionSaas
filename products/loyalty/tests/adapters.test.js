import { describe, expect, it } from 'vitest';
import { generateSigningKey, hashRegistrationToken } from '@ss/protocol';
import { createPlatform } from '../adapters/platform.js';
import { createSiteRegistry } from '../adapters/registry.js';
import { createWalletTokens, MIN_SECRET_LENGTH, stableId, walletSecret } from '../adapters/tokens.js';
import { cronAuthorized, runExpiryJob } from '../jobs/expiry.js';
import { mongoUri, ROOT } from './harness.js';

describe('adapters/tokens', () => {
	it('derives stable ids and wallet secrets', async () => {
		expect(stableId('a')).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
		expect(stableId('a')).toBe(stableId('a'));
		expect(stableId('a')).not.toBe(stableId('b'));
		const configured = walletSecret({ secret: 'x'.repeat(MIN_SECRET_LENGTH) });
		expect(configured.toString()).toBe('x'.repeat(MIN_SECRET_LENGTH));
		const { privateJwk } = await generateSigningKey({ kid: 'k' });
		const derived = walletSecret({ secret: 'short', signingKey: JSON.stringify(privateJwk) });
		expect(derived).toHaveLength(32);
		expect(walletSecret({ signingKey: /** @type {any} */ (privateJwk) }).equals(derived)).toBe(true);
		expect(() => walletSecret({ signingKey: null })).toThrow(/LOYALTY_WALLET_SECRET/);
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

describe('adapters/registry', () => {
	it('remembers websites in memory or in the control database (ids only)', async () => {
		const memory = createSiteRegistry();
		await memory.remember('web_b');
		await memory.remember('web_a');
		await memory.remember('web_a');
		expect(await memory.list()).toEqual(['web_a', 'web_b']);
		/** @type {any[]} */
		const writes = [];
		let fail = true;
		const collection = {
			updateOne: async (/** @type {any} */ filter) => {
				if (fail) {
					fail = false;
					throw new Error('down');
				}
				writes.push(filter._id);
			},
			find: () => ({ toArray: async () => [{ _id: 'web_z' }, ...writes.map((id) => ({ _id: id }))] }),
		};
		const stored = createSiteRegistry({ collection });
		await stored.remember('web_1'); // fails: forgotten, retried next time
		await stored.remember('web_1');
		expect(writes).toEqual(['web_1']);
		expect(await stored.list()).toEqual(['web_1', 'web_z']);
	});
});

describe('jobs/expiry', () => {
	it('runs every wanted website and isolates failures', async () => {
		/** @type {Array<[string, unknown]>} */
		const errors = [];
		const result = await runExpiryJob({
			websiteIds: ['web_ok', 'web_off', 'web_none', 'web_boom'],
			siteFor: async (id) => (id === 'web_none' ? null : { id }),
			wants: (site) => site.id !== 'web_off',
			run: async (site) => {
				if (site.id === 'web_boom') throw new Error('boom');
				return { expired: 3 };
			},
			onError: (websiteId, error) => errors.push([websiteId, /** @type {Error} */ (error).message]),
		});
		expect(result).toEqual({
			websites: 2,
			results: [
				{ websiteId: 'web_ok', expired: 3 },
				{ websiteId: 'web_boom', error: 'failed' },
			],
		});
		expect(errors).toEqual([['web_boom', 'boom']]);
		expect(
			(
				await runExpiryJob({
					websiteIds: ['x'],
					siteFor: async () => {
						throw new Error('x');
					},
					wants: () => true,
					run: async () => ({}),
				})
			).results,
		).toEqual([{ websiteId: 'x', error: 'failed' }]);
	});

	it('compares cron secrets in constant time', () => {
		expect(cronAuthorized('Bearer abc', 'abc')).toBe(true);
		expect(cronAuthorized('Bearer abd', 'abc')).toBe(false);
		expect(cronAuthorized('Bearer ab', 'abc')).toBe(false);
		expect(cronAuthorized(null, 'abc')).toBe(false);
		expect(cronAuthorized('Bearer abc', null)).toBe(false);
	});
});

describe('adapters/platform', () => {
	it('refuses to start without the required environment', async () => {
		await expect(createPlatform({ env: {}, root: ROOT })).rejects.toThrow(
			/SS_PORTAL_URL, SS_APP_SIGNING_KEY, SS_REGISTRATION_TOKEN_HASH/,
		);
	});

	it('uses the product control database when SS_PRODUCT_DB_URI is set', async () => {
		const { privateJwk } = await generateSigningKey({ kid: 'k' });
		const app = await createPlatform({
			root: ROOT,
			env: {
				SS_PORTAL_URL: 'https://portal.test',
				SS_APP_SIGNING_KEY: JSON.stringify(privateJwk),
				SS_REGISTRATION_TOKEN_HASH: hashRegistrationToken('rt_0123456789abcdef0123'),
				SS_PRODUCT_DB_URI: mongoUri(`loyalty_control_${Date.now()}`),
				SS_OUTBOUND_ALLOW_HOSTS: '127.0.0.1',
				CRON_SECRET: 'x'.repeat(16),
			},
		});
		expect(app.cronSecret).toBe('x'.repeat(16));
		await app.registry.remember('web_1');
		expect(await app.registry.list()).toEqual(['web_1']);
		expect(app.strings.en?.['wallet.title']).toBe('Your rewards');
		await app.close();
	});
});
