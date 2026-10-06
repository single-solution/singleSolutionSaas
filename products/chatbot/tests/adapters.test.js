/** Adapters without the router: TTL purge of deleted records, tokens and the platform's environment checks. */
import { describe, expect, it } from 'vitest';
import { generateSigningKey } from '@ss/protocol';
import { createPlatform, loadStrings } from '../adapters/platform.js';
import { DELETED_RETENTION_DAYS, INDEXES, MIGRATIONS, purgeDate } from '../adapters/db.js';
import { createTokens, rootSecret, stableId } from '../adapters/tokens.js';
import { retentionDays } from '../api/routes.js';
import { ROOT } from './harness.js';

describe('purge of soft-deleted records (TTL, no job)', () => {
	it('declares TTL indexes on purgeAt and backfills records deleted before it existed', async () => {
		for (const collection of ['entries', 'agents'])
			expect(INDEXES).toContainEqual({ collection, keys: { purgeAt: 1 }, name: 'purge_ttl', expireAfterSeconds: 0 });
		expect(purgeDate('2026-01-01T00:00:00.000Z', 0).toISOString()).toBe('2026-01-02T00:00:00.000Z');
		/** @type {Array<{ name: string, filter: any, update: any }>} */
		const updates = [];
		const scope = {
			websiteId: 'web_a',
			collection: (/** @type {string} */ name) => ({
				find: () => ({ toArray: async () => [{ id: `${name}_1`, deletedAt: '2026-01-01T00:00:00.000Z' }] }),
				updateOne: async (/** @type {any} */ filter, /** @type {any} */ update) => {
					updates.push({ name, filter, update });
				},
			}),
		};
		const migration = MIGRATIONS.find((m) => m.name === 'deleted_purge_at');
		await migration?.up(scope);
		expect(updates).toEqual([
			{
				name: 'entries',
				filter: { websiteId: 'web_a', id: 'entries_1' },
				update: { $set: { purgeAt: purgeDate('2026-01-01T00:00:00.000Z', DELETED_RETENTION_DAYS) } },
			},
			{
				name: 'agents',
				filter: { websiteId: 'web_a', id: 'agents_1' },
				update: { $set: { purgeAt: purgeDate('2026-01-01T00:00:00.000Z', DELETED_RETENTION_DAYS) } },
			},
		]);
	});
});

describe('tokens and platform', () => {
	it('derives secrets, signs markers per website and expires them', async () => {
		const { privateJwk } = await generateSigningKey({ kid: 't' });
		expect(rootSecret({ secret: 'x'.repeat(32) }).toString()).toBe('x'.repeat(32));
		expect(rootSecret({ signingKey: `${privateJwk.kid}:${privateJwk.d}` })).toHaveLength(32);
		expect(() => rootSecret({ signingKey: {} })).toThrow(/CHATBOT_TOKEN_SECRET/);
		let now = 0;
		const tokens = createTokens({ secret: Buffer.alloc(32, 1), now: () => now });
		const { token, expiresAt } = tokens.issueMarker({ websiteId: 'web_1', visitorId: 'vis_1', days: 1 });
		expect(expiresAt).toBe('1970-01-02T00:00:00.000Z');
		expect(tokens.verifyMarker(token, 'web_1')).toBe('vis_1');
		expect(tokens.verifyMarker(token, 'web_2')).toBeNull();
		expect(tokens.verifyMarker(`${token}x`, 'web_1')).toBeNull();
		expect(tokens.verifyMarker(`${token}.extra`, 'web_1')).toBeNull();
		expect(tokens.verifyMarker('cm1.e30.' + token.split('.')[2], 'web_1')).toBeNull();
		expect(tokens.verifyMarker(42, 'web_1')).toBeNull();
		const forged = createTokens({ secret: Buffer.alloc(32, 1) }).issueMarker({ websiteId: 'web_1', visitorId: 'v', days: 1 });
		expect(tokens.verifyMarker(forged.token.replace(/\.[^.]+$/, '.bad'), 'web_1')).toBeNull();
		now = 2 * 86_400_000;
		expect(tokens.verifyMarker(token, 'web_1')).toBeNull();
		expect(tokens.toolSecret('web_1', 1)).not.toBe(tokens.toolSecret('web_1', 2));
		expect(tokens.signTool({ websiteId: 'web_1', version: 1, body: '{}', timestamp: 5 })).toMatch(/^t=5,v1=[0-9a-f]{64},kv=1$/);
		expect(stableId('a')).toHaveLength(26);
		expect(retentionDays('P180D')).toBe(180);
		expect(retentionDays('P1Y')).toBe(30);
	});
	it('refuses to start without the required environment and loads the string catalogs', async () => {
		await expect(createPlatform({ env: {}, root: ROOT })).rejects.toThrow(/PORTAL_URL, SIGNING_KEY, REGISTRATION_TOKEN_HASH/);
		expect(Object.keys(await loadStrings(ROOT))).toContain('en');
	});
});
