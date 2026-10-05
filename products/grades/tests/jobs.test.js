/** jobs/: the hourly sweep of stale inspection photo slots (GET /cron/sweep) and the slot migration. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS, STALE_BACKSTOP_MS } from '../adapters/db.js';
import { cronAuthorized, runSweepJob } from '../jobs/sweep.js';
import { CRON_SECRET, DAY, HOUR, T0, WEBSITE, createHarness } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;

beforeAll(async () => {
	h = await createHarness();
}, 60_000);

afterAll(async () => {
	await h?.close();
});

/** @param {string} [secret] */
const cron = (secret = CRON_SECRET) => h.call('GET', '/cron/sweep', { key: secret });

/** @param {any} response */
const rowOf = (response) => response.json.results.find((/** @type {any} */ row) => row.websiteId === WEBSITE);

describe('photo slot sweep', () => {
	it('deletes slots that were never confirmed: the object from the bucket, then the record', async () => {
		const unit = (await h.call('POST', '/v1/units', { body: { itemId: 'itm_sweep' } })).json;
		const draft = (await h.call('POST', '/v1/inspections', { body: { unitId: unit.id } })).json;
		/** @param {number} size */
		const slot = async (size) =>
			(
				await h.call('POST', `/v1/inspections/${draft.id}/photos`, {
					body: { item: 'appearance', contentType: 'image/jpeg', size },
				})
			).json;
		const uploaded = await slot(100);
		const never = await slot(200);
		const doc = await h.collection('photos').findOne({ websiteId: WEBSITE, id: uploaded.id });
		expect(doc?.staleAt).toBeInstanceOf(Date);
		expect(doc?.purgeAt.getTime() - doc?.staleAt.getTime()).toBe(STALE_BACKSTOP_MS);
		h.bucket.upload(String(doc?.objectKey), 100, 'image/jpeg');

		expect((await cron('wrong-secret-0123456789')).status).toBe(401);
		expect(rowOf(await cron())).toEqual({ websiteId: WEBSITE, photos: { scanned: 0, deleted: 0, missing: 0, failed: 0 } });

		// past the stale date (upload link lifetime + 1 day) the slot no longer counts towards the checklist
		h.clock.advance(600_000 + DAY + 1_000);
		const done = await h.call('GET', `/v1/inspections/${draft.id}`);
		expect(done.json.photos).toHaveLength(2);
		const complete = await h.call('PATCH', `/v1/inspections/${draft.id}`, {
			body: {
				results: [
					{ item: 'appearance', value: 5 },
					{ item: 'function', value: true },
					{ item: 'completeness', value: true },
				],
				complete: true,
			},
		});
		expect(complete.status).toBe(422);
		expect(complete.json.errors.map((/** @type {any} */ e) => e.path)).toContain('/photos/appearance');

		h.clock.advance(HOUR);
		const swept = await cron();
		expect(swept.status).toBe(200);
		expect(swept.headers.get('cache-control')).toBe('no-store');
		expect(rowOf(swept)).toEqual({ websiteId: WEBSITE, photos: { scanned: 2, deleted: 1, missing: 1, failed: 0 } });
		expect(h.bucket.objects.has(String(doc?.objectKey))).toBe(false);
		expect(await h.collection('photos').countDocuments({ websiteId: WEBSITE, id: { $in: [uploaded.id, never.id] } })).toBe(0);
		expect(rowOf(await cron()).photos.scanned).toBe(0);

		// a website without inspection is skipped
		await h.entitle({ elements: { inspection: false } });
		expect(rowOf(await cron())).toBeUndefined();
		await h.entitle();
	});

	it('migrates pending slots written before the sweep (purgeAt → staleAt, TTL moved back)', async () => {
		const purgeAt = new Date(T0 + DAY);
		await h.collection('photos').insertOne({ websiteId: WEBSITE, id: 'iph_legacy', status: 'pending', purgeAt });
		const migration = MIGRATIONS.find((step) => step.name === 'photo_stale_dates');
		await migration?.up({ websiteId: WEBSITE, collection: (/** @type {string} */ name) => h.collection(name) });
		const legacy = await h.collection('photos').findOne({ websiteId: WEBSITE, id: 'iph_legacy' });
		expect(legacy?.staleAt).toEqual(purgeAt);
		expect(legacy?.purgeAt).toEqual(new Date(purgeAt.getTime() + STALE_BACKSTOP_MS));
	});

	it('runs websites independently and compares the cron secret in constant time', async () => {
		/** @type {string[]} */
		const errors = [];
		const result = await runSweepJob({
			websiteIds: ['a', 'b', 'c'],
			siteFor: async (id) => (id === 'c' ? null : { id }),
			wants: () => true,
			run: async (site) => {
				if (site.id === 'a') throw new Error('boom');
				return { photos: { scanned: 0 } };
			},
			onError: (id) => errors.push(id),
		});
		expect(result).toEqual({
			websites: 2,
			results: [
				{ websiteId: 'a', error: 'failed' },
				{ websiteId: 'b', photos: { scanned: 0 } },
			],
		});
		expect(errors).toEqual(['a']);
		expect(
			(await runSweepJob({ websiteIds: ['x'], siteFor: async () => ({}), wants: () => false, run: async () => ({}) }))
				.websites,
		).toBe(0);
		expect(
			(
				await runSweepJob({
					websiteIds: ['x'],
					siteFor: async () => {
						throw new Error('down');
					},
					wants: () => true,
					run: async () => ({}),
				})
			).results,
		).toEqual([{ websiteId: 'x', error: 'failed' }]);
		expect(cronAuthorized(`Bearer ${CRON_SECRET}`, CRON_SECRET)).toBe(true);
		expect(cronAuthorized('Bearer short', CRON_SECRET)).toBe(false);
		expect(cronAuthorized(null, CRON_SECRET)).toBe(false);
		expect(cronAuthorized(`Bearer ${CRON_SECRET}`, null)).toBe(false);
	});
});
