/** Mode C: checklists, inspections, photos in the merchant's bucket, report links and reports; the dashboard API. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY, MERCHANT, WEBSITE, createHarness } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;

beforeAll(async () => {
	h = await createHarness();
}, 60_000);

afterAll(async () => {
	await h?.close();
});

/** A new unit. @param {Record<string, unknown>} [body] */
const unit = async (body = {}) => (await h.call('POST', '/v1/units', { body: { itemId: 'itm_insp', ...body } })).json;

/**
 * Request a photo slot and upload it as a browser would (exact type and size).
 * @param {string} inspectionId
 * @param {string} item
 * @param {{ upload?: boolean, size?: number, type?: string, actualSize?: number }} [options]
 */
const photo = async (inspectionId, item, { upload = true, size = 2048, type = 'image/jpeg', actualSize = size } = {}) => {
	const slot = await h.call('POST', `/v1/inspections/${inspectionId}/photos`, { body: { item, contentType: type, size } });
	expect(slot.status, JSON.stringify(slot.json)).toBe(201);
	const doc = await h.collection('photos').findOne({ websiteId: WEBSITE, id: slot.json.id });
	if (upload) h.bucket.upload(String(doc?.objectKey), actualSize, type);
	return slot.json;
};

const passing = [
	{ item: 'appearance', value: 5 },
	{ item: 'function', value: true },
	{ item: 'completeness', value: true, note: 'All accessories' },
	{ item: 'notes', value: 'Like new.' },
];

describe('checklists', () => {
	it('lists checklists for servers only', async () => {
		const list = await h.call('GET', '/v1/checklists');
		expect(list.json.items[0]).toMatchObject({ key: 'standard', name: 'Standard inspection' });
		expect(list.json.items[0].items.map((/** @type {any} */ i) => i.key)).toEqual([
			'appearance',
			'function',
			'completeness',
			'notes',
		]);
		expect((await h.call('GET', '/v1/checklists/standard')).json.items[1]).toMatchObject({ kind: 'pass_fail', critical: true });
		expect((await h.call('GET', '/v1/checklists/nope')).status).toBe(404);
		expect((await h.call('GET', '/v1/checklists', { key: h.pk })).status).toBe(403);
	});
});

describe('inspections', () => {
	it('scores a draft, requires answers and photos, completes with the suggested tier and publishes', async () => {
		const u = await unit({ serial: 'INSP-1' });
		const started = await h.call('POST', '/v1/inspections', {
			body: { unitId: u.id, results: [{ item: 'appearance', value: 4 }], inspector: 'Sam' },
			idempotencyKey: 'insp-1',
		});
		expect(started.status).toBe(201);
		expect(started.json).toMatchObject({
			status: 'draft',
			checklist: 'standard',
			score: 80,
			suggestedTier: 'good',
			inspector: 'Sam',
		});
		const replay = await h.call('POST', '/v1/inspections', {
			body: { unitId: u.id, results: [{ item: 'appearance', value: 4 }], inspector: 'Sam' },
			idempotencyKey: 'insp-1',
		});
		expect(replay.json.id).toBe(started.json.id);
		const otherUnit = await unit({ serial: 'INSP-1-OTHER' });
		const misused = await h.call('POST', '/v1/inspections', { body: { unitId: otherUnit.id }, idempotencyKey: 'insp-1' });
		expect(misused.json.type).toMatch(/duplicate_request$/);
		const other = await h.call('POST', '/v1/inspections', {
			body: { unitId: otherUnit.id },
			key: await h.key('sk'),
			idempotencyKey: 'insp-1',
		});
		expect(other.status).toBe(201);
		expect(other.json.id).not.toBe(started.json.id);
		const id = started.json.id;
		const early = await h.call('PATCH', `/v1/inspections/${id}`, { body: { complete: true } });
		expect(early.status).toBe(422);
		expect(early.json.type).toContain('inspection_incomplete');
		expect(early.json.errors.map((/** @type {any} */ e) => e.path).sort()).toEqual(
			['/photos/appearance', '/results/completeness', '/results/function'].sort(),
		);
		const answered = await h.call('PATCH', `/v1/inspections/${id}`, { body: { results: passing } });
		expect(answered.json).toMatchObject({ score: 100, suggestedTier: 'new', criticalFailed: false });
		// a slot that is never uploaded does not count; one of the wrong size neither
		await photo(id, 'appearance', { upload: false });
		const missing = await h.call('PATCH', `/v1/inspections/${id}`, { body: { complete: true } });
		expect(missing.json.errors).toEqual([{ path: '/photos/appearance', code: 'photos_missing', message: 'photos missing' }]);
		await photo(id, 'appearance', { size: 4096, actualSize: 10 });
		expect((await h.call('PATCH', `/v1/inspections/${id}`, { body: { complete: true } })).status).toBe(422);
		const good = await photo(id, 'appearance', { size: 3000 });
		expect(good.upload.method).toBe('PUT');
		expect(good.upload.headers['content-length']).toBe('3000');
		expect(good.upload.url).toContain('X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost');
		const done = await h.call('PATCH', `/v1/inspections/${id}`, { body: { complete: true } });
		expect(done.status, JSON.stringify(done.json)).toBe(200);
		expect(done.json).toMatchObject({ status: 'completed', tier: 'new' });
		expect(done.json.photos.filter((/** @type {any} */ p) => p.status === 'stored')).toHaveLength(1);
		const graded = await h.call('GET', `/v1/units/${u.id}`);
		expect(graded.json).toMatchObject({ tier: 'new', score: 100, lastInspectionId: id });
		expect((await h.call('GET', '/v1/items/itm_insp', { key: h.pk })).json.tiers.map((/** @type {any} */ t) => t.key)).toEqual([
			'new',
		]);
		await h.grades.product.flush();
		const [event] = h.published('grades.unit_inspected@1');
		expect(event?.data).toEqual({
			inspectionId: id,
			unitId: u.id,
			itemId: 'itm_insp',
			checklist: 'standard',
			score: 100,
			suggestedTier: 'new',
			tier: 'new',
			criticalFailed: false,
		});
		expect(h.published('grades.tier_assigned@1').some((e) => e.data.unitId === u.id && e.data.source === 'inspection')).toBe(
			true,
		);
		expect((await h.call('PATCH', `/v1/inspections/${id}`, { body: { results: passing } })).status).toBe(409);
		expect(
			(
				await h.call('POST', `/v1/inspections/${id}/photos`, {
					body: { item: 'appearance', contentType: 'image/png', size: 5 },
				})
			).status,
		).toBe(409);
		const listed = await h.call('GET', `/v1/inspections?filter[unitId]=${u.id}&filter[status]=completed`);
		expect(listed.json.items.map((/** @type {any} */ i) => i.id)).toEqual([id]);
		expect((await h.call('GET', `/v1/inspections/${id}`)).json.photos).toHaveLength(3);
	});

	it('caps the tier after a critical fail and honours an explicit tier and apply_suggestion', async () => {
		const u = await unit({ tier: 'good' });
		const failed = await h.call('POST', '/v1/inspections', {
			body: {
				unitId: u.id,
				results: [
					{ item: 'appearance', value: 5 },
					{ item: 'function', value: false },
					{ item: 'completeness', value: true },
				],
			},
		});
		expect(failed.json).toMatchObject({ criticalFailed: true, suggestedTier: 'fair' });
		await photo(failed.json.id, 'appearance');
		const explicit = await h.call('PATCH', `/v1/inspections/${failed.json.id}`, {
			body: { complete: true, tier: 'excellent' },
		});
		expect(explicit.json.tier).toBe('excellent');
		await h.entitle({ config: { inspection: { apply_suggestion: false, critical_fail_tier: 'good' } } });
		const kept = await unit({ tier: 'excellent' });
		const second = await h.call('POST', '/v1/inspections', {
			body: {
				unitId: kept.id,
				results: [
					{ item: 'appearance', value: 1 },
					{ item: 'function', value: false },
					{ item: 'completeness', value: false },
				],
			},
		});
		expect(second.json.suggestedTier).toBe('good');
		await photo(second.json.id, 'appearance');
		const completed = await h.call('PATCH', `/v1/inspections/${second.json.id}`, {
			body: { complete: true, inspector: 'Kim' },
		});
		expect(completed.json).toMatchObject({ tier: 'excellent', inspector: 'Kim' });
		const fresh = await unit();
		const inspected = await h.call('POST', '/v1/inspections', {
			body: {
				unitId: fresh.id,
				checklist: 'standard',
				results: [
					{ item: 'appearance', value: 4 },
					{ item: 'function', value: true },
					{ item: 'completeness', value: true },
				],
			},
		});
		await photo(inspected.json.id, 'appearance');
		const auto = await h.call('PATCH', `/v1/inspections/${inspected.json.id}`, { body: { complete: true } });
		expect(auto.json.tier).toBe('excellent');
		await h.entitle();
	});

	it('completes in one request, picks checklists by tier and rules, and validates everything', async () => {
		await h.entitle({
			config: {
				inspection: {
					checklists: [
						{
							key: 'quick',
							name: 'Quick check',
							tiers: ['fair'],
							items: [{ key: 'works', label: 'Works', kind: 'pass_fail', weight: 1, required: true }],
						},
						{
							key: 'rooms',
							name: 'Room check',
							applies_when: "unit.serial == 'R-101'",
							items: [{ key: 'clean', label: 'Clean', kind: 'score', max: 3, weight: 1, required: true }],
						},
					],
				},
			},
		});
		const fair = await unit({ tier: 'fair' });
		const quick = await h.call('POST', '/v1/inspections', {
			body: { unitId: fair.id, results: [{ item: 'works', value: true }], complete: true },
		});
		expect(quick.status, JSON.stringify(quick.json)).toBe(201);
		expect(quick.json).toMatchObject({ checklist: 'quick', status: 'completed', score: 100, tier: 'new' });
		const room = await unit({ serial: 'R-101' });
		const roomCheck = await h.call('POST', '/v1/inspections', {
			body: { unitId: room.id, results: [{ item: 'clean', value: 2 }] },
		});
		expect(roomCheck.json).toMatchObject({ checklist: 'rooms', score: 67, suggestedTier: 'fair' });
		const other = await unit();
		const none = await h.call('POST', '/v1/inspections', { body: { unitId: other.id } });
		expect(none.status).toBe(422);
		expect(none.json.type).toContain('checklist_missing');
		expect((await h.call('POST', '/v1/inspections', { body: { unitId: other.id, checklist: 'nope' } })).status).toBe(422);
		expect((await h.call('POST', '/v1/inspections', { body: { unitId: 'unt_missing' } })).status).toBe(404);
		const invalid = await h.call('POST', '/v1/inspections', {
			body: {
				unitId: room.id,
				results: [
					{ item: 'clean', value: 9 },
					{ item: 'ghost', value: true },
					{ item: 'clean', value: 1 },
					{ item: 'clean', value: 1, note: 5 },
				],
			},
		});
		expect(invalid.json.errors.map((/** @type {any} */ e) => e.code)).toEqual([
			'value_invalid',
			'item_unknown',
			'item_duplicate',
			'item_duplicate',
		]);
		const note = await h.call('POST', '/v1/inspections', {
			body: { unitId: room.id, results: [{ item: 'clean', value: 1, note: 5 }] },
		});
		expect(note.json.errors.map((/** @type {any} */ e) => e.code)).toEqual(['note_invalid']);
		expect(
			(await h.call('POST', '/v1/inspections', { body: { unitId: room.id, results: 'x', complete: 'yes', extra: 1 } })).status,
		).toBe(422);
		expect((await h.call('POST', '/v1/inspections', { body: [] })).status).toBe(422);
		expect((await h.call('PATCH', `/v1/inspections/${roomCheck.json.id}`, { body: {} })).status).toBe(422);
		expect(
			(await h.call('PATCH', `/v1/inspections/${roomCheck.json.id}`, { body: { results: [{ item: 'x', value: 1 }] } })).status,
		).toBe(422);
		expect((await h.call('PATCH', '/v1/inspections/ins_missing', { body: { complete: true } })).status).toBe(404);
		expect((await h.call('GET', '/v1/inspections/ins_missing')).status).toBe(404);
		expect((await h.call('GET', '/v1/inspections?filter[status]=open')).status).toBe(422);
		expect((await h.call('GET', '/v1/inspections?filter[unitId]=a%20b')).status).toBe(422);
		const page = await h.call('GET', '/v1/inspections?limit=1');
		const next = await h.call('GET', `/v1/inspections?limit=1&cursor=${encodeURIComponent(page.json.nextCursor)}`);
		expect(next.json.items[0].id).not.toBe(page.json.items[0].id);
		// checklists removed from the settings leave drafts unfinishable
		await h.entitle();
		expect((await h.call('PATCH', `/v1/inspections/${roomCheck.json.id}`, { body: { complete: true } })).status).toBe(422);
		expect(
			(
				await h.call('POST', `/v1/inspections/${roomCheck.json.id}/photos`, {
					body: { item: 'clean', contentType: 'image/png', size: 9 },
				})
			).status,
		).toBe(422);
	});

	it('limits photo slots, validates uploads and reports an unavailable bucket', async () => {
		const u = await unit();
		const draft = (await h.call('POST', '/v1/inspections', { body: { unitId: u.id } })).json;
		const bad = await h.call('POST', `/v1/inspections/${draft.id}/photos`, {
			body: { item: 'Appearance', contentType: 'image/gif', size: 0, extra: true },
		});
		expect(bad.json.errors.map((/** @type {any} */ e) => e.code).sort()).toEqual(
			['field_unknown', 'item_invalid', 'size_invalid', 'type_not_allowed'].sort(),
		);
		expect(
			(
				await h.call('POST', `/v1/inspections/${draft.id}/photos`, {
					body: { item: 'appearance', contentType: 'image/png', size: 9e9 },
				})
			).status,
		).toBe(422);
		expect(
			(
				await h.call('POST', '/v1/inspections/ins_missing/photos', {
					body: { item: 'appearance', contentType: 'image/png', size: 9 },
				})
			).status,
		).toBe(404);
		const retry = await h.call('POST', `/v1/inspections/${draft.id}/photos`, {
			body: { item: 'appearance', contentType: 'image/png', size: 10 },
			idempotencyKey: 'same-photo',
		});
		const again = await h.call('POST', `/v1/inspections/${draft.id}/photos`, {
			body: { item: 'appearance', contentType: 'image/png', size: 10 },
			idempotencyKey: 'same-photo',
		});
		expect(again.json.id).toBe(retry.json.id);
		for (let i = 0; i < 3; i += 1)
			await h.call('POST', `/v1/inspections/${draft.id}/photos`, {
				body: { item: 'appearance', contentType: 'image/png', size: 10 },
			});
		const limited = await h.call('POST', `/v1/inspections/${draft.id}/photos`, {
			body: { item: 'appearance', contentType: 'image/png', size: 10 },
		});
		expect(limited.status, JSON.stringify(limited.json)).toBe(409);
		expect(limited.json.type).toContain('photo_limit');
		h.bucket.fail(true);
		const broken = await h.call('PATCH', `/v1/inspections/${draft.id}`, { body: { results: passing, complete: true } });
		expect(broken.status).toBe(503);
		h.bucket.fail(false);
	});

	it('answers 503 storage_unavailable for photo slots when the storage connector is missing', async () => {
		const bare = await createHarness({ storage: false });
		try {
			const u = (await bare.call('POST', '/v1/units', { body: { itemId: 'itm_bare' } })).json;
			const draft = (await bare.call('POST', '/v1/inspections', { body: { unitId: u.id } })).json;
			const res = await bare.call('POST', `/v1/inspections/${draft.id}/photos`, {
				body: { item: 'appearance', contentType: 'image/png', size: 9 },
			});
			expect(res.status).toBe(503);
			expect(res.json.type).toContain('storage_unavailable');
		} finally {
			await bare.close();
		}
	});
});

describe('report links', () => {
	it('issues a shareable link per unit; the report shows the latest completed inspection; revocation and expiry', async () => {
		await h.entitle({
			config: {
				inspection: {
					report_url_template: 'https://shop.example.com/report?r={token}',
					report_shows_inspector: true,
				},
			},
		});
		const u = await unit({ serial: 'REP-1' });
		expect((await h.call('POST', `/v1/units/${u.id}/report-link`, { body: {} })).json.type).toContain('not_inspected');
		const draft = (await h.call('POST', '/v1/inspections', { body: { unitId: u.id, results: passing, inspector: 'Ana' } }))
			.json;
		await photo(draft.id, 'appearance', { type: 'image/webp', size: 512 });
		await h.call('PATCH', `/v1/inspections/${draft.id}`, { body: { complete: true } });
		const link = await h.call('POST', `/v1/units/${u.id}/report-link`, { body: { days: 7 } });
		expect(link.status).toBe(201);
		expect(link.json.token).toMatch(/^grr_[A-Za-z0-9_-]{43}$/);
		expect(link.json.url).toBe(`https://shop.example.com/report?r=${encodeURIComponent(link.json.token)}`);
		const stored = await h.collection('units').findOne({ websiteId: WEBSITE, id: u.id });
		expect(JSON.stringify(stored)).not.toContain(link.json.token);
		expect((await h.call('GET', `/v1/units/${u.id}`)).json.report.expiresAt).toBe(link.json.expiresAt);
		const report = await h.call('GET', `/v1/inspection-reports/${link.json.token}`, { key: h.pk });
		expect(report.status).toBe(200);
		expect(report.headers.get('cache-control')).toBe('private, no-store');
		expect(report.json).toMatchObject({
			itemId: 'itm_insp',
			serial: 'REP-1',
			tier: { key: 'new', label: 'New' },
			score: 100,
			checklist: { key: 'standard', name: 'Standard inspection' },
			inspector: 'Ana',
			expiresAt: link.json.expiresAt,
		});
		const appearance = report.json.results.find((/** @type {any} */ r) => r.item === 'appearance');
		expect(appearance).toMatchObject({ label: 'Appearance', kind: 'score', max: 5, value: 5 });
		expect(appearance.photos[0].url).toContain('X-Amz-Signature=');
		expect(report.json.results.find((/** @type {any} */ r) => r.item === 'completeness').note).toBe('All accessories');
		await h.entitle({
			config: { inspection: { public_base_url: 'https://cdn.example.com/media', report_shows_photos: true } },
		});
		const publicPhotos = await h.call('GET', `/v1/inspection-reports/${link.json.token}`, { key: h.pk });
		expect(publicPhotos.json.results[0].photos[0].url).toMatch(/^https:\/\/cdn\.example\.com\/media\//);
		expect(publicPhotos.json.inspector).toBeNull();
		await h.entitle({ config: { inspection: { report_shows_photos: false } } });
		expect(
			(await h.call('GET', `/v1/inspection-reports/${link.json.token}`, { key: h.pk })).json.results.every(
				(/** @type {any} */ r) => r.photos.length === 0,
			),
		).toBe(true);
		await h.entitle();
		// a new link replaces the old one
		const second = await h.call('POST', `/v1/units/${u.id}/report-link`, { body: {} });
		expect((await h.call('GET', `/v1/inspection-reports/${link.json.token}`, { key: h.pk })).status).toBe(404);
		expect(second.json.url).toBeNull();
		expect((await h.call('POST', `/v1/units/${u.id}/report-link`, { body: { days: 0 } })).status).toBe(422);
		expect((await h.call('POST', '/v1/units/unt_missing/report-link', { body: {} })).status).toBe(404);
		expect((await h.call('GET', '/v1/inspection-reports/not-a-token', { key: h.pk })).status).toBe(404);
		h.clock.advance(366 * DAY);
		expect((await h.call('GET', `/v1/inspection-reports/${second.json.token}`, { key: h.pk })).status).toBe(404);
		const third = await h.call('POST', `/v1/units/${u.id}/report-link`, { idempotencyKey: 'no-body' });
		expect(third.status).toBe(201);
		expect((await h.call('DELETE', `/v1/units/${u.id}/report-link`)).status).toBe(204);
		expect((await h.call('GET', `/v1/inspection-reports/${third.json.token}`, { key: h.pk })).status).toBe(404);
		expect((await h.call('DELETE', '/v1/units/unt_missing/report-link')).status).toBe(404);
	});
});

describe('dashboard', () => {
	it('shows the overview, re-grades units and creates report links for merchants', async () => {
		const session = await h.session('merchant');
		const overview = await h.call('GET', '/v1/dashboard/overview', { key: session });
		expect(overview.status).toBe(200);
		expect(overview.json.inspections.completed).toBeGreaterThan(0);
		expect(overview.json.tiers.map((/** @type {any} */ t) => t.key)).toEqual(['new', 'excellent', 'good', 'fair']);
		const u = await unit({ serial: 'DASH-1' });
		const regraded = await h.call('POST', `/v1/dashboard/units/${u.id}/tier`, {
			key: session,
			idempotencyKey: null,
			body: { tier: 'good' },
		});
		expect(regraded.json.tier).toBe('good');
		expect(
			(await h.call('POST', `/v1/dashboard/units/${u.id}/tier`, { key: session, idempotencyKey: null, body: { tier: 'BAD' } }))
				.status,
		).toBe(422);
		const audit = await h.db
			.collection('ss_grades_audit')
			.findOne({ websiteId: WEBSITE, action: 'unit.update', 'target.unitId': u.id });
		expect(audit?.actor).toMatchObject({ type: 'merchant', id: 'usr_merchant' });
		expect(
			(await h.call('POST', `/v1/dashboard/units/${u.id}/report-link`, { key: session, idempotencyKey: null, body: {} }))
				.status,
		).toBe(409);
		const check = await h.call('POST', '/v1/dashboard/conditions:check', {
			key: session,
			idempotencyKey: null,
			body: { source: 'item.title ==', kind: 'tier' },
		});
		expect(check.json.ok).toBe(false);
		expect(
			(
				await h.call('POST', '/v1/dashboard/conditions:check', {
					key: session,
					idempotencyKey: null,
					body: { source: '', kind: 'filter' },
				})
			).json.ok,
		).toBe(true);
		expect(
			(
				await h.call('POST', '/v1/dashboard/conditions:check', {
					key: session,
					idempotencyKey: null,
					body: { source: 'x', kind: 'nope' },
				})
			).status,
		).toBe(422);
		expect(
			(await h.call('POST', '/v1/dashboard/conditions:check', { key: session, idempotencyKey: null, body: {} })).status,
		).toBe(422);
		const noWebsite = await h.session('merchant', { scope: { merchantId: MERCHANT } });
		expect((await h.call('GET', '/v1/dashboard/overview', { key: noWebsite })).status).toBe(400);
		expect((await h.call('GET', '/v1/session', { key: session })).json).toMatchObject({ kind: 'merchant', role: 'merchant' });
	});
});
