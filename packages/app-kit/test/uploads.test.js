import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { guardCollection } from '../src/data.js';
import { SWEEP_MAX_LIMIT, isKitError, sweepStaleUploads } from '../src/index.js';
import { startMongo } from './mongo.js';

const SITE = 'web_1';
const NOW = Date.parse('2026-05-01T12:00:00Z');
const MIN = 60_000;

/**
 * A fake in-memory bucket (relative keys).
 * @param {string[]} [keys]
 */
const fakeStorage = (keys = []) => {
	const objects = new Set(keys);
	return {
		objects,
		headObject: vi.fn(async ({ key }) => ({ exists: objects.has(key) })),
		deleteObject: vi.fn(async ({ key }) => {
			objects.delete(key);
			return { deleted: true };
		}),
	};
};

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
let run = 0;

beforeAll(async () => {
	mongo = await startMongo();
});

afterAll(async () => {
	await mongo.stop();
});

/** A guarded collection over a fresh real collection. */
const freshCollection = () => {
	run += 1;
	const raw = mongo.client.db('uploads_test').collection(`slots_${run}`);
	const guarded = guardCollection(raw, { websiteId: SITE, now: () => NOW, schemaVersion: () => 1, stamp: {} });
	return { raw, guarded };
};

/**
 * @param {ReturnType<typeof freshCollection>['guarded']} collection
 * @param {Array<Record<string, unknown>>} docs
 */
const seed = async (collection, docs) => {
	for (const doc of docs) await collection.insertOne(doc);
};

describe('sweepStaleUploads', () => {
	it('deletes stale objects and their records, counts missing ones and keeps fresh or other-status records', async () => {
		const { raw, guarded } = freshCollection();
		await seed(guarded, [
			{ id: 'a', key: 'photos/a', status: 'pending', staleAt: new Date(NOW - 10 * MIN) },
			{ id: 'b', key: 'photos/b', status: 'pending', staleAt: new Date(NOW - 5 * MIN) },
			{ id: 'c', key: 'photos/c', status: 'pending', staleAt: new Date(NOW + 5 * MIN) },
			{ id: 'd', key: 'photos/d', status: 'stored', staleAt: new Date(NOW - 10 * MIN) },
		]);
		await raw.insertOne({ id: 'x', key: 'photos/x', status: 'pending', websiteId: 'web_other', staleAt: new Date(0) });
		const storage = fakeStorage(['photos/a', 'photos/c', 'photos/d', 'photos/x']);
		const onDeleted = vi.fn();
		const result = await sweepStaleUploads({
			collection: guarded,
			websiteId: SITE,
			storage,
			now: () => NOW,
			filter: { status: 'pending' },
			onDeleted,
		});
		expect(result).toEqual({ scanned: 2, deleted: 1, missing: 1, failed: 0 });
		expect([...storage.objects].sort()).toEqual(['photos/c', 'photos/d', 'photos/x']);
		expect((await raw.find({}).toArray()).map((doc) => doc.id).sort()).toEqual(['c', 'd', 'x']);
		expect(onDeleted).toHaveBeenCalledTimes(2);
		expect(onDeleted.mock.calls[0]?.[1]).toEqual({ existed: true });
		expect(onDeleted.mock.calls[1]?.[1]).toEqual({ existed: false });

		// idempotent: a second run finds nothing and never resolves storage
		const lazy = vi.fn(async () => storage);
		expect(
			await sweepStaleUploads({
				collection: guarded,
				websiteId: SITE,
				storage: lazy,
				now: () => NOW,
				filter: { status: 'pending' },
			}),
		).toEqual({ scanned: 0, deleted: 0, missing: 0, failed: 0 });
		expect(lazy).not.toHaveBeenCalled();
	});

	it('honours the grace, the custom field, keyOf, the per-run limit and a lazily resolved storage', async () => {
		const { raw, guarded } = freshCollection();
		await seed(
			guarded,
			Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, path: `k/${i}`, expiresOn: new Date(NOW - (60 - i) * MIN) })),
		);
		const storage = fakeStorage(['k/0', 'k/1', 'k/2', 'k/3', 'k/4']);
		const input = {
			collection: guarded,
			websiteId: SITE,
			storage: async () => storage,
			now: () => NOW,
			field: 'expiresOn',
			olderThanMs: 57.5 * MIN,
			keyOf: (/** @type {any} */ record) => record.path,
			limit: 2,
		};
		expect(await sweepStaleUploads(input)).toEqual({ scanned: 2, deleted: 2, missing: 0, failed: 0 });
		expect([...storage.objects]).toEqual(['k/2', 'k/3', 'k/4']); // oldest first
		expect(await sweepStaleUploads(input)).toEqual({ scanned: 1, deleted: 1, missing: 0, failed: 0 }); // k/3, k/4 in grace
		expect(await raw.countDocuments({})).toBe(2);
	});

	it('marks records instead of deleting them, and a marked record is not swept again', async () => {
		const { raw, guarded } = freshCollection();
		await seed(guarded, [{ id: 'm', key: 'photos/m', status: 'pending', staleAt: new Date(NOW - MIN) }]);
		const storage = fakeStorage(['photos/m']);
		const input = { collection: guarded, websiteId: SITE, storage, now: () => NOW, mark: { status: 'expired' } };
		expect(await sweepStaleUploads(input)).toEqual({ scanned: 1, deleted: 1, missing: 0, failed: 0 });
		const doc = await raw.findOne({ id: 'm' });
		expect(doc).toMatchObject({ status: 'expired' });
		expect(doc).not.toHaveProperty('staleAt');
		expect(await sweepStaleUploads(input)).toMatchObject({ scanned: 0 });
	});

	it('treats a record without a key as missing', async () => {
		const { raw, guarded } = freshCollection();
		await seed(guarded, [{ id: 'n', staleAt: new Date(NOW - MIN) }]);
		const storage = fakeStorage();
		expect(await sweepStaleUploads({ collection: guarded, websiteId: SITE, storage, now: () => NOW })).toEqual({
			scanned: 1,
			deleted: 0,
			missing: 1,
			failed: 0,
		});
		expect(storage.headObject).not.toHaveBeenCalled();
		expect(await raw.countDocuments({})).toBe(0);
	});

	it('keeps records whose object could not be deleted and reports storage that cannot be resolved', async () => {
		const { raw, guarded } = freshCollection();
		await seed(guarded, [
			{ id: 'f1', key: 'photos/f1', staleAt: new Date(NOW - 2 * MIN) },
			{ id: 'f2', key: 'photos/f2', staleAt: new Date(NOW - MIN) },
		]);
		const storage = fakeStorage(['photos/f1', 'photos/f2']);
		storage.deleteObject.mockRejectedValueOnce(new Error('bucket down'));
		const onError = vi.fn();
		const onDeleted = vi.fn(() => {
			throw new Error('hook failed');
		});
		const result = await sweepStaleUploads({
			collection: guarded,
			websiteId: SITE,
			storage,
			now: () => NOW,
			onError,
			onDeleted,
		});
		expect(result).toEqual({ scanned: 2, deleted: 1, missing: 0, failed: 1 });
		expect(onError).toHaveBeenCalledTimes(2); // the storage failure, then the hook failure
		expect((await raw.find({}).toArray()).map((doc) => doc.id)).toEqual(['f1']);

		const unresolved = vi.fn();
		const down = await sweepStaleUploads({
			collection: guarded,
			websiteId: SITE,
			storage: async () => {
				throw new Error('no storage');
			},
			now: () => NOW,
			onError: unresolved,
		});
		expect(down).toEqual({ scanned: 1, deleted: 0, missing: 0, failed: 1 });
		expect(unresolved).toHaveBeenCalledWith(null, expect.any(Error));
		// the default onError swallows failures
		expect(
			await sweepStaleUploads({
				collection: guarded,
				websiteId: SITE,
				storage: async () => {
					throw new Error('no storage');
				},
				now: () => NOW,
			}),
		).toMatchObject({ failed: 1 });
	});

	it('only removes a record that is still stale (compare-and-set)', async () => {
		const { raw, guarded } = freshCollection();
		await seed(guarded, [{ id: 'r', key: 'photos/r', status: 'pending', staleAt: new Date(NOW - MIN) }]);
		const storage = fakeStorage(['photos/r']);
		storage.deleteObject.mockImplementationOnce(async () => {
			await raw.updateOne({ id: 'r' }, { $set: { status: 'stored' } }); // confirmed concurrently
			return { deleted: true };
		});
		await sweepStaleUploads({ collection: guarded, websiteId: SITE, storage, now: () => NOW, filter: { status: 'pending' } });
		expect(await raw.findOne({ id: 'r' })).toMatchObject({ status: 'stored' });
	});

	it('clamps the limit', async () => {
		const find = vi.fn(() => ({ toArray: async () => [] }));
		const collection = { find, deleteOne: vi.fn(), updateOne: vi.fn() };
		const storage = fakeStorage();
		await sweepStaleUploads({ collection, websiteId: SITE, storage, limit: 1e9 });
		await sweepStaleUploads({ collection, websiteId: SITE, storage, limit: Number.NaN });
		await sweepStaleUploads({ collection, websiteId: SITE, storage, limit: -3 });
		expect(find.mock.calls.map((call) => /** @type {any[]} */ (call)[1].limit)).toEqual([SWEEP_MAX_LIMIT, 100, 1]);
	});

	it('refuses invalid input as a bug', async () => {
		const collection = { find: vi.fn(), deleteOne: vi.fn(), updateOne: vi.fn() };
		const storage = fakeStorage();
		const base = { collection, websiteId: SITE, storage };
		/** @type {Array<Record<string, unknown>>} */
		const bad = [
			{ collection: null },
			{ websiteId: '' },
			{ storage: null },
			{ field: '' },
			{ field: 'websiteId' },
			{ filter: { websiteId: 'other' } },
			{ filter: { staleAt: 1 } },
			{ filter: [] },
			{ olderThanMs: -1 },
			{ olderThanMs: Number.POSITIVE_INFINITY },
			{ mark: { websiteId: 'x' } },
			{ mark: { staleAt: null } },
			{ mark: 'expired' },
		];
		for (const override of bad) {
			const error = await sweepStaleUploads(/** @type {any} */ ({ ...base, ...override })).catch((caught) => caught);
			expect(isKitError(error, 'invalid_argument')).toBe(true);
		}
		expect(collection.find).not.toHaveBeenCalled();
	});
});
