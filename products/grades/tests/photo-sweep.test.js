/**
 * Stale inspection photo slots without any timer: they stop counting once stale, and are deleted (object, then record)
 * on the website's next photo upload or from the dashboard's "Clean up stale photos" button; the slot migration.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS, STALE_BACKSTOP_MS } from '../adapters/db.js';
import { UPLOAD_SWEEP_LIMIT } from '../api/inspections.js';
import { DAY, HOUR, T0, WEBSITE, createHarness } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;

beforeAll(async () => {
	h = await createHarness();
}, 60_000);

afterAll(async () => {
	await h?.close();
});

/** A draft inspection of a new unit, and a function that opens photo slots on it. @param {string} itemId */
const draftOf = async (itemId) => {
	const unit = (await h.call('POST', '/v1/units', { body: { itemId } })).json;
	const draft = (await h.call('POST', '/v1/inspections', { body: { unitId: unit.id } })).json;
	/** @param {number} size */
	const slot = async (size) =>
		(
			await h.call('POST', `/v1/inspections/${draft.id}/photos`, {
				body: { item: 'appearance', contentType: 'image/jpeg', size },
			})
		).json;
	return { draft, slot };
};

/** @param {string} id */
const photo = (id) => h.collection('photos').findOne({ websiteId: WEBSITE, id });

const RESULTS = [
	{ item: 'appearance', value: 5 },
	{ item: 'function', value: true },
	{ item: 'completeness', value: true },
];

describe('stale photo slots (no timer)', () => {
	it('stop counting once stale and are deleted on the next upload: the object from the bucket, then the record', async () => {
		const { draft, slot } = await draftOf('itm_sweep');
		const uploaded = await slot(100);
		const never = await slot(200);
		const doc = await photo(uploaded.id);
		expect(doc?.staleAt).toBeInstanceOf(Date);
		expect(doc?.purgeAt.getTime() - doc?.staleAt.getTime()).toBe(STALE_BACKSTOP_MS);
		h.bucket.upload(String(doc?.objectKey), 100, 'image/jpeg');

		// past the stale date (upload link lifetime + 1 day) the slot no longer counts towards the checklist
		h.clock.advance(600_000 + DAY + 1_000);
		await h.entitle();
		expect((await h.call('GET', `/v1/inspections/${draft.id}`)).json.photos).toHaveLength(2);
		const complete = await h.call('PATCH', `/v1/inspections/${draft.id}`, { body: { results: RESULTS, complete: true } });
		expect(complete.status).toBe(422);
		expect(complete.json.errors.map((/** @type {any} */ e) => e.path)).toContain('/photos/appearance');
		// nothing ran by itself
		expect(await photo(uploaded.id)).not.toBeNull();
		expect(h.bucket.objects.has(String(doc?.objectKey))).toBe(true);

		// the website's next new slot sweeps the stale ones
		h.clock.advance(HOUR);
		await h.entitle();
		const next = await draftOf('itm_next');
		const fresh = await next.slot(300);
		expect(fresh.status).toBe('pending');
		expect(h.bucket.objects.has(String(doc?.objectKey))).toBe(false);
		expect(await photo(uploaded.id)).toBeNull();
		expect(await photo(never.id)).toBeNull();
		expect(await photo(fresh.id)).not.toBeNull();
		expect(UPLOAD_SWEEP_LIMIT).toBe(25);
	});

	it('are deleted from the dashboard button (merchants only), and a bucket failure leaves them for later', async () => {
		const { slot } = await draftOf('itm_button');
		const stale = await slot(400);
		const doc = await photo(stale.id);
		h.bucket.upload(String(doc?.objectKey), 400, 'image/jpeg');
		h.clock.advance(600_000 + DAY + HOUR);
		await h.entitle();
		const session = await h.session('merchant');
		/** @param {string | null} key */
		const press = (key) => h.call('POST', '/v1/dashboard/photos:sweep', { key, idempotencyKey: null });
		expect((await press(await h.session('demo'))).status).toBe(403);
		h.bucket.fail(true);
		const failed = (await press(session)).json;
		expect(failed.scanned).toBeGreaterThanOrEqual(1);
		expect(failed).toMatchObject({ deleted: 0, missing: 0, failed: failed.scanned });
		h.bucket.fail(false);
		expect(await photo(stale.id)).not.toBeNull();
		const swept = (await press(session)).json;
		expect(swept).toMatchObject({ scanned: failed.scanned, failed: 0 });
		expect(swept.deleted).toBeGreaterThanOrEqual(1);
		expect(await photo(stale.id)).toBeNull();
		expect(h.bucket.objects.has(String(doc?.objectKey))).toBe(false);
		expect((await press(session)).json).toEqual({ scanned: 0, deleted: 0, missing: 0, failed: 0 });
		expect((await press(await h.session('merchant', { scope: { merchantId: 'mer_0123456789abcdefghjkmnpq' } }))).status).toBe(
			400,
		);
	});

	it('declares the TTL backstop on pending slots', async () => {
		const { INDEXES } = await import('../adapters/db.js');
		expect(
			INDEXES.find((/** @type {any} */ index) => index.collection === 'photos' && index.expireAfterSeconds !== undefined),
		).toMatchObject({ keys: { purgeAt: 1 }, expireAfterSeconds: 0 });
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
});
