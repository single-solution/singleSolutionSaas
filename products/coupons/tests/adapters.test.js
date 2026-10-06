import { describe, expect, it } from 'vitest';
import { generateSigningKey } from '@ss/protocol';
import { base32, randomBytes, randomId, stableId } from '../adapters/crypto.js';
import { createPlatform, loadStrings } from '../adapters/platform.js';
import { createRepositories, isDuplicateKey } from '../adapters/repositories.js';
import { mongoUri, ROOT } from './harness.js';

describe('adapters/crypto', () => {
	it('derives stable ids and random ids', () => {
		expect(stableId('a')).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
		expect(stableId('a')).toBe(stableId('a'));
		expect(stableId('a')).not.toBe(stableId('b'));
		expect(base32(new Uint8Array(17))).toBe('0'.repeat(26));
		expect(randomBytes(8)).toHaveLength(8);
		expect(randomId('cpn')).toMatch(/^cpn_[0-9a-hjkmnp-tv-z]{26}$/);
		expect(randomId('x', (n) => new Uint8Array(n).fill(255))).toBe(`x_${'z'.repeat(26)}`);
	});
});

describe('adapters/repositories', () => {
	it('requires a website and recognises duplicate keys', () => {
		expect(() => createRepositories(/** @type {any} */ ({ websiteId: '', collection: () => ({}) }))).toThrow(TypeError);
		expect(isDuplicateKey({ code: 11000 })).toBe(true);
		expect(isDuplicateKey(new Error('x'))).toBe(false);
	});

	it('rethrows unexpected database errors and reports bulk duplicates', async () => {
		const boom = Object.assign(new Error('boom'), { code: 1 });
		const failing = {
			insertOne: async () => {
				throw boom;
			},
			insertMany: async () => {
				throw boom;
			},
			updateOne: async () => {
				throw boom;
			},
			findOneAndUpdate: async () => {
				throw boom;
			},
		};
		const repos = createRepositories(/** @type {any} */ ({ websiteId: 'web_1', collection: () => failing }));
		await expect(repos.coupons.insert({ id: 'c' })).rejects.toThrow('boom');
		await expect(repos.codes.insertMany([{ code: 'A' }])).rejects.toThrow('boom');
		await expect(repos.usage.claim({ couponId: 'c', kind: 'customer', key: 'k', max: 1 })).rejects.toThrow('boom');
		await expect(repos.velocity.hit('k', 0, 1)).rejects.toThrow('boom');
		expect(await repos.codes.insertMany([])).toEqual({ inserted: 0, duplicates: [] });
		const duplicate = Object.assign(new Error('dup'), { code: 11000, writeErrors: [{ code: 11000, index: 1 }] });
		const dupes = {
			insertMany: async () => {
				throw duplicate;
			},
			updateOne: async () => {
				throw Object.assign(new Error('dup'), { code: 11000 });
			},
			findOneAndUpdate: async () => {
				throw Object.assign(new Error('dup'), { code: 11000 });
			},
		};
		const racing = createRepositories(/** @type {any} */ ({ websiteId: 'web_1', collection: () => dupes }));
		expect(await racing.codes.insertMany([{ code: 'A' }, { code: 'B' }])).toEqual({ inserted: 1, duplicates: ['B'] });
		expect(await racing.usage.claim({ couponId: 'c', kind: 'customer', key: 'k', max: 1 })).toBe(false);
		expect(await racing.velocity.hit('k', 0, 1)).toBe(Number.MAX_SAFE_INTEGER);
	});
});

describe('adapters/platform', () => {
	it('loads string catalogs and refuses to start without the required environment', async () => {
		expect((await loadStrings(ROOT)).en?.['apply_box.title']).toBe('Coupon code');
		// no environment at all: an unconnected product (in-memory control store) that only serves /setup
		const unconnected = await createPlatform({ env: {}, root: ROOT });
		expect(unconnected.product.connected()).toBe(false);
		await unconnected.close?.();
	});

	it('uses the product control database when DATABASE_URI is set', async () => {
		const { privateJwk } = await generateSigningKey({ kid: 'k' });
		const app = await createPlatform({
			env: {
				DATABASE_URI: mongoUri('coupons_control_test'),
			},
			overrides: { portalUrl: 'https://portal.test', signingKey: `${privateJwk.kid}:${privateJwk.d}` },
			root: ROOT,
		});
		expect(app.randomId('rsv')).toMatch(/^rsv_/);
		await app.close();
	});
});
