/**
 * Graded units, their inspections, inspection photos in the merchant's own bucket and shareable report links. Part
 * of the Grades service (service.js passes the shared helpers in); the rules live in core/inspection.js.
 *
 * Photos: the API hands out a presigned PUT whose `content-type` and `content-length` are signed headers, so the
 * bucket accepts exactly the declared type and size; completion HEAD-checks every pending photo (defence in depth for
 * stores that do not enforce signed headers, and proof the upload happened) before it counts towards the checklist.
 */
import {
	completionProblems,
	criticalFailed,
	mergeResults,
	pickChecklist,
	reportView,
	scoreOf,
	suggestTier,
	validateResults,
} from '../core/inspection.js';
import { fill } from '../core/text.js';
import { STALE_BACKSTOP_MS } from '../adapters/db.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').Actor} Actor */
/** @typedef {import('./service.js').Failure} Failure */

/** Event published when an inspection completes. */
export const UNIT_INSPECTED = 'grades.unit_inspected@1';

const DAY_MS = 86_400_000;
/** Grace after a photo slot's `staleAt` before the sweep deletes it (covers completions in flight). */
const SWEEP_GRACE_MS = 10 * 60_000;
/** Stale slots swept on each new photo slot of a website (the dashboard button sweeps up to the sweep's default). */
export const UPLOAD_SWEEP_LIMIT = 25;

/**
 * Owner view of a unit.
 * @param {Record<string, any>} unit
 */
export const unitView = (unit) => ({
	id: unit.id,
	itemId: unit.itemId,
	variantId: unit.variantId ?? null,
	serial: unit.serial ?? null,
	tier: unit.tier ?? null,
	note: unit.note ?? null,
	available: unit.available !== false,
	lastInspectionId: unit.lastInspectionId ?? null,
	inspectedAt: unit.inspectedAt ?? null,
	score: unit.score ?? null,
	report: unit.report ? { expiresAt: unit.report.expiresAt, issuedAt: unit.report.issuedAt } : null,
	addedAt: unit.addedAt,
});

/**
 * Owner view of an inspection.
 * @param {Record<string, any>} inspection
 * @param {Array<Record<string, any>>} [photos]
 */
export const inspectionView = (inspection, photos = []) => ({
	id: inspection.id,
	unitId: inspection.unitId,
	itemId: inspection.itemId,
	checklist: inspection.checklist,
	status: inspection.status,
	results: inspection.results ?? [],
	score: inspection.score ?? null,
	suggestedTier: inspection.suggestedTier ?? null,
	criticalFailed: inspection.criticalFailed === true,
	tier: inspection.tier ?? null,
	inspector: inspection.inspector ?? null,
	photos: photos.map((photo) => ({ id: photo.id, item: photo.item, status: photo.status, contentType: photo.contentType })),
	startedAt: inspection.startedAt,
	completedAt: inspection.completedAt ?? null,
});

/**
 * @param {{ storage: (websiteId: string) => Promise<any>, reports: import('../adapters/tokens.js').ReportTokens,
 *   idFor: (websiteId: string, prefix: string, key: string) => string, now: () => number,
 *   emit: (event: any) => Promise<void>, record: (site: Site, actor: Actor, action: string, target: Record<string, unknown>, after?: unknown) => Promise<void>,
 *   refreshItem: (site: Site, itemId: string) => Promise<string[]>,
 *   tierProblem: (site: Site, tier: string, itemId: string, path: string) => Promise<Failure | null>,
 *   tierChanged: (site: Site, change: any) => Promise<void> }} deps
 */
export const createInspectionService = ({
	storage,
	reports,
	idFor,
	now,
	emit,
	record,
	refreshItem,
	tierProblem,
	tierChanged,
}) => {
	const iso = () => new Date(now()).toISOString();

	/**
	 * A pending slot past its `staleAt` (the sweep may delete its object at any time).
	 * @param {{ staleAt?: unknown }} photo
	 */
	const isStale = (photo) =>
		photo.staleAt !== undefined && photo.staleAt !== null && new Date(/** @type {any} */ (photo.staleAt)).getTime() <= now();

	/**
	 * Delete the objects and records of this website's stale photo slots (bounded and idempotent): on the website's
	 * next photo upload and from the dashboard's "Clean up stale photos" button — never on a timer.
	 * @param {Site} site
	 * @param {{ limit?: number, bucket?: any }} [options] slots per run (default: the sweep's); an already resolved bucket
	 * @returns {Promise<{ scanned: number, deleted: number, missing: number, failed: number }>}
	 */
	const sweepPhotos = (site, { limit, bucket } = {}) =>
		site.repos.photos.sweepStale({
			storage: bucket ? async () => bucket : () => storage(site.websiteId),
			olderThanMs: SWEEP_GRACE_MS,
			...(limit === undefined ? {} : { limit }),
		});

	/** @param {Site} site */
	const bucketOf = async (site) => {
		try {
			return await storage(site.websiteId);
		} catch {
			return null;
		}
	};

	// ── units ───────────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Register a graded unit (a serial, a lot, a room…) of an item. Retried requests return the first result.
	 * @param {Site} site
	 * @param {{ itemId: string, variantId?: string | null, serial?: string | null, tier?: string | null, note?: string | null,
	 *   available?: boolean, key: string, actor: Actor }} input
	 * @returns {Promise<{ ok: true, unit: ReturnType<typeof unitView>, created: boolean } | Failure>}
	 */
	const createUnit = async (
		site,
		{ itemId, variantId = null, serial = null, tier = null, note = null, available = true, key, actor },
	) => {
		const id = idFor(site.websiteId, 'unt', key);
		const replay = await site.repos.units.get(id);
		if (replay) return { ok: true, unit: unitView(replay), created: false };
		if (tier) {
			const problem = await tierProblem(site, tier, itemId, '/tier');
			if (problem) return problem;
		}
		const limit = Number(site.settings.tiersConfig.max_units_per_item);
		if ((await site.repos.units.countForItem(itemId)) >= limit)
			return { ok: false, reason: 'unit_limit', detail: `An item may hold ${limit} graded units.` };
		await site.repos.items.ensure(itemId);
		const doc = {
			id,
			itemId,
			variantId,
			serial,
			tier,
			note,
			available,
			lastInspectionId: null,
			inspectedAt: null,
			score: null,
			report: null,
			addedAt: iso(),
		};
		const outcome = await site.repos.units.insert(doc);
		if (outcome === 'duplicate')
			return { ok: false, reason: 'serial_taken', errors: [{ path: '/serial', code: 'serial_taken' }] };
		const stored = /** @type {Record<string, any>} */ (await site.repos.units.get(id));
		if (outcome === 'created') {
			await refreshItem(site, itemId);
			if (tier) await tierChanged(site, { itemId, variantId, unitId: id, tier, previousTier: null, source: 'api' });
			await record(site, actor, 'unit.create', { unitId: id, itemId }, { tier });
		}
		return { ok: true, unit: unitView(stored), created: outcome === 'created' };
	};

	/**
	 * Change a unit's tier, note, serial or availability.
	 * @param {Site} site
	 * @param {string} id
	 * @param {{ tier?: string | null, note?: string | null, serial?: string | null, available?: boolean }} patch
	 * @param {Actor} actor
	 * @param {string} [source]
	 * @returns {Promise<{ ok: true, unit: ReturnType<typeof unitView> } | Failure>}
	 */
	const updateUnit = async (site, id, patch, actor, source = 'api') => {
		const unit = await site.repos.units.get(id);
		if (!unit) return { ok: false, reason: 'not_found', detail: 'No such unit.' };
		if (typeof patch.tier === 'string') {
			const problem = await tierProblem(site, patch.tier, unit.itemId, '/tier');
			if (problem) return problem;
		}
		/** @type {Record<string, unknown>} */
		const set = {};
		for (const field of /** @type {const} */ (['tier', 'note', 'serial', 'available']))
			if (patch[field] !== undefined) set[field] = patch[field];
		const outcome = await site.repos.units.update(id, set);
		if (outcome === 'duplicate')
			return { ok: false, reason: 'serial_taken', errors: [{ path: '/serial', code: 'serial_taken' }] };
		if (outcome === 'missing') return { ok: false, reason: 'not_found', detail: 'No such unit.' };
		await refreshItem(site, unit.itemId);
		if (patch.tier !== undefined && patch.tier !== unit.tier)
			await tierChanged(site, {
				itemId: unit.itemId,
				variantId: unit.variantId ?? null,
				unitId: id,
				tier: patch.tier,
				previousTier: unit.tier ?? null,
				source,
			});
		await record(site, actor, 'unit.update', { unitId: id }, set);
		return { ok: true, unit: unitView(/** @type {Record<string, any>} */ (await site.repos.units.get(id))) };
	};

	/**
	 * Remove a unit (soft: kept with its inspections, out of listings, its report link stops working).
	 * @param {Site} site
	 * @param {string} id
	 * @param {Actor} actor
	 */
	const deleteUnit = async (site, id, actor) => {
		const unit = await site.repos.units.get(id);
		if (!unit || !(await site.repos.units.softDelete(id))) return false;
		await refreshItem(site, unit.itemId);
		await record(site, actor, 'unit.delete', { unitId: id });
		return true;
	};

	// ── inspections ─────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Score and suggestion of results.
	 * @param {Site} site
	 * @param {import('../core/inspection.js').Checklist} checklist
	 * @param {import('../core/inspection.js').Result[]} results
	 */
	const evaluate = (site, checklist, results) => {
		const score = scoreOf(checklist, results);
		const critical = criticalFailed(checklist, results);
		return {
			score,
			criticalFailed: critical,
			suggestedTier: suggestTier({
				score,
				critical,
				thresholds: site.settings.inspection.thresholds,
				index: site.settings.index,
				criticalFailTier: String(site.settings.inspection.critical_fail_tier ?? ''),
			}),
		};
	};

	/**
	 * Verify pending photos with the bucket; stored photos per checklist item.
	 * @param {Site} site
	 * @param {Array<Record<string, any>>} photos
	 * @returns {Promise<{ ok: true, counts: Map<string, number> } | Failure>}
	 */
	const verifyPhotos = async (site, photos) => {
		/** @type {Map<string, number>} */
		const counts = new Map();
		// a slot past its `staleAt` never counts: the sweep may delete its object at any time
		const pending = photos.filter((photo) => photo.status === 'pending' && !isStale(photo));
		const bucket = pending.length > 0 ? await bucketOf(site) : null;
		if (pending.length > 0 && !bucket) return { ok: false, reason: 'storage_unavailable' };
		for (const photo of photos) {
			let stored = photo.status === 'stored';
			if (!stored && pending.includes(photo)) {
				/** @type {{ exists: boolean, size?: number, contentType?: string }} */
				let head;
				try {
					head = await bucket.headObject({ key: photo.key });
				} catch {
					return { ok: false, reason: 'storage_unavailable' };
				}
				const type = String(head.contentType ?? '')
					.split(';')[0]
					?.trim();
				stored = head.exists && Number(head.size) === photo.size && type === photo.contentType;
				if (stored)
					await site.repos.photos.update(photo.id, { status: 'stored', storedAt: iso(), purgeAt: null, staleAt: null });
			}
			if (stored) counts.set(photo.item, (counts.get(photo.item) ?? 0) + 1);
		}
		return { ok: true, counts };
	};

	/**
	 * Complete a draft: required answers and photos present, then the unit takes its tier.
	 * @param {Site} site
	 * @param {Record<string, any>} inspection
	 * @param {import('../core/inspection.js').Checklist} checklist
	 * @param {{ tier?: string | null, actor: Actor }} input
	 * @returns {Promise<{ ok: true } | Failure>}
	 */
	const complete = async (site, inspection, checklist, { tier = null, actor }) => {
		const photos = await site.repos.photos.forInspection(inspection.id);
		const verified = await verifyPhotos(site, photos);
		if (!verified.ok) return verified;
		const problems = completionProblems(checklist, inspection.results, verified.counts);
		if (problems.length > 0) return { ok: false, reason: 'inspection_incomplete', errors: problems };
		const unit = await site.repos.units.get(inspection.unitId);
		if (!unit) return { ok: false, reason: 'not_found', detail: 'The unit was removed.' };
		const finalTier =
			tier ??
			(site.settings.inspection.apply_suggestion === true || !unit.tier ? inspection.suggestedTier : unit.tier) ??
			unit.tier ??
			null;
		if (finalTier) {
			const problem = await tierProblem(site, finalTier, unit.itemId, '/tier');
			if (problem) return problem;
		}
		const at = iso();
		if (!(await site.repos.inspections.updateDraft(inspection.id, { status: 'completed', completedAt: at, tier: finalTier })))
			return { ok: false, reason: 'inspection_completed' };
		await site.repos.units.update(unit.id, {
			tier: finalTier,
			lastInspectionId: inspection.id,
			inspectedAt: at,
			score: inspection.score ?? null,
		});
		await refreshItem(site, unit.itemId);
		if (finalTier !== (unit.tier ?? null))
			await tierChanged(site, {
				itemId: unit.itemId,
				variantId: unit.variantId ?? null,
				unitId: unit.id,
				tier: finalTier,
				previousTier: unit.tier ?? null,
				source: 'inspection',
			});
		await emit({
			websiteId: site.websiteId,
			type: UNIT_INSPECTED,
			idempotencyKey: inspection.id,
			data: {
				inspectionId: inspection.id,
				unitId: unit.id,
				itemId: unit.itemId,
				...(unit.variantId ? { variantId: unit.variantId } : {}),
				checklist: checklist.key,
				score: inspection.score ?? null,
				suggestedTier: inspection.suggestedTier ?? null,
				tier: finalTier,
				criticalFailed: inspection.criticalFailed === true,
			},
		});
		await record(site, actor, 'inspection.complete', { inspectionId: inspection.id, unitId: unit.id }, { tier: finalTier });
		return { ok: true };
	};

	/**
	 * Start an inspection of a unit (optionally completing it at once). Retried requests return the first result.
	 * @param {Site} site
	 * @param {{ unitId: string, checklist?: string | null, results?: unknown, inspector?: string | null, complete?: boolean,
	 *   tier?: string | null, key: string, actor: Actor }} input
	 * @returns {Promise<{ ok: true, inspection: ReturnType<typeof inspectionView>, created: boolean } | Failure>}
	 */
	const startInspection = async (site, input) => {
		const id = idFor(site.websiteId, 'ins', input.key);
		const existing = await site.repos.inspections.get(id);
		if (existing)
			return { ok: true, inspection: inspectionView(existing, await site.repos.photos.forInspection(id)), created: false };
		const unit = await site.repos.units.get(input.unitId);
		if (!unit) return { ok: false, reason: 'not_found', detail: 'No such unit.' };
		const item = await site.repos.items.get(unit.itemId);
		const checklist = pickChecklist(site.settings.checklists, {
			key: input.checklist ?? null,
			unit,
			item,
			now: now(),
			timeZone: site.settings.timeZone,
		});
		if (!checklist) return { ok: false, reason: 'checklist_missing' };
		const validated = validateResults(checklist, input.results ?? []);
		if (validated.problems.length > 0) return { ok: false, reason: 'validation_failed', errors: validated.problems };
		const results = mergeResults([], validated.results, checklist);
		const doc = {
			id,
			unitId: unit.id,
			itemId: unit.itemId,
			checklist: checklist.key,
			status: 'draft',
			results,
			...evaluate(site, checklist, results),
			tier: null,
			inspector: input.inspector ?? null,
			startedAt: iso(),
			completedAt: null,
		};
		await site.repos.inspections.insert(doc);
		await record(site, input.actor, 'inspection.start', { inspectionId: id, unitId: unit.id });
		if (input.complete === true) {
			const done = await complete(site, doc, checklist, { tier: input.tier ?? null, actor: input.actor });
			if (!done.ok) return done;
		}
		const stored = /** @type {Record<string, any>} */ (await site.repos.inspections.get(id));
		return { ok: true, inspection: inspectionView(stored, await site.repos.photos.forInspection(id)), created: true };
	};

	/**
	 * Add or change results of a draft, and optionally complete it.
	 * @param {Site} site
	 * @param {string} id
	 * @param {{ results?: unknown, inspector?: string | null, complete?: boolean, tier?: string | null, actor: Actor }} patch
	 * @returns {Promise<{ ok: true, inspection: ReturnType<typeof inspectionView> } | Failure>}
	 */
	const updateInspection = async (site, id, patch) => {
		const inspection = await site.repos.inspections.get(id);
		if (!inspection) return { ok: false, reason: 'not_found', detail: 'No such inspection.' };
		if (inspection.status !== 'draft') return { ok: false, reason: 'inspection_completed' };
		const checklist = site.settings.checklists.find((entry) => entry.key === inspection.checklist);
		if (!checklist) return { ok: false, reason: 'checklist_missing' };
		const validated = validateResults(checklist, patch.results ?? []);
		if (validated.problems.length > 0) return { ok: false, reason: 'validation_failed', errors: validated.problems };
		const results = mergeResults(inspection.results ?? [], validated.results, checklist);
		const set = {
			results,
			...evaluate(site, checklist, results),
			...(patch.inspector !== undefined ? { inspector: patch.inspector } : {}),
		};
		if (!(await site.repos.inspections.updateDraft(id, set))) return { ok: false, reason: 'inspection_completed' };
		if (patch.complete === true) {
			const done = await complete(site, { ...inspection, ...set }, checklist, {
				tier: patch.tier ?? null,
				actor: patch.actor,
			});
			if (!done.ok) return done;
		}
		const stored = /** @type {Record<string, any>} */ (await site.repos.inspections.get(id));
		return { ok: true, inspection: inspectionView(stored, await site.repos.photos.forInspection(id)) };
	};

	/**
	 * A presigned upload slot for one photo of a checklist item (retries re-sign the first slot).
	 * @param {Site} site
	 * @param {string} inspectionId
	 * @param {{ item: string, contentType: string, size: number, key: string }} input
	 * @returns {Promise<{ ok: true, photo: Record<string, unknown> } | Failure>}
	 */
	const photoUpload = async (site, inspectionId, { item, contentType, size, key }) => {
		const config = site.settings.inspection;
		const inspection = await site.repos.inspections.get(inspectionId);
		if (!inspection) return { ok: false, reason: 'not_found', detail: 'No such inspection.' };
		if (inspection.status !== 'draft') return { ok: false, reason: 'inspection_completed' };
		const checklist = site.settings.checklists.find((entry) => entry.key === inspection.checklist);
		if (!checklist?.items.some((entry) => entry.key === item))
			return { ok: false, reason: 'validation_failed', errors: [{ path: '/item', code: 'item_unknown' }] };
		const id = idFor(site.websiteId, 'iph', `${inspectionId}|${key}`);
		const existing = await site.repos.photos.get(id);
		if (!existing && (await site.repos.photos.countForItem(inspectionId, item)) >= Number(config.max_photos_per_item))
			return { ok: false, reason: 'photo_limit' };
		const bucket = await bucketOf(site);
		if (!bucket) return { ok: false, reason: 'storage_unavailable' };
		const declared = { contentType: existing?.contentType ?? contentType, size: existing?.size ?? size };
		// `content-length` is a signed header: the bucket refuses a body of any other size than the declared one
		const slot = bucket.presignPut({
			key: `inspections/${inspectionId}/${id}`,
			contentType: declared.contentType,
			contentLength: declared.size,
			expiresIn: config.upload_ttl_seconds,
		});
		if (!existing) {
			// a new upload is the moment to clean up this website's abandoned slots (best effort: the TTL is the backstop)
			await sweepPhotos(site, { limit: UPLOAD_SWEEP_LIMIT, bucket }).catch(() => null);
			await site.repos.photos.insert({
				id,
				inspectionId,
				item,
				key: slot.key,
				objectKey: bucket.fullKey(slot.key),
				contentType,
				size,
				status: 'pending',
				addedAt: iso(),
				// past `staleAt` the next upload (or the dashboard) deletes the object and the slot; the TTL on `purgeAt`
				// is only a backstop
				staleAt: new Date(now() + Number(config.upload_ttl_seconds) * 1000 + DAY_MS),
				purgeAt: new Date(now() + Number(config.upload_ttl_seconds) * 1000 + DAY_MS + STALE_BACKSTOP_MS),
			});
		}
		return {
			ok: true,
			photo: {
				id,
				item,
				status: existing?.status ?? 'pending',
				upload: { method: slot.method, url: slot.url, headers: slot.headers },
				expiresAt: slot.expiresAt,
				maxBytes: config.max_photo_bytes,
			},
		};
	};

	// ── report links ────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * A new shareable report link for a unit (replaces the previous one).
	 * @param {Site} site
	 * @param {string} unitId
	 * @param {{ days?: number, actor: Actor }} input
	 * @returns {Promise<{ ok: true, link: { token: string, url: string | null, expiresAt: string } } | Failure>}
	 */
	const issueReportLink = async (site, unitId, { days, actor }) => {
		const unit = await site.repos.units.get(unitId);
		if (!unit) return { ok: false, reason: 'not_found', detail: 'No such unit.' };
		if (!unit.lastInspectionId) return { ok: false, reason: 'not_inspected' };
		const config = site.settings.inspection;
		const { token, hash } = reports.issue();
		const at = now();
		const expiresAt = new Date(at + (days ?? Number(config.report_link_days)) * DAY_MS).toISOString();
		await site.repos.units.update(unitId, { report: { tokenHash: hash, expiresAt, issuedAt: new Date(at).toISOString() } });
		await record(site, actor, 'report.issue', { unitId }, { expiresAt });
		const template = String(config.report_url_template ?? '');
		return {
			ok: true,
			link: { token, url: template ? fill(template, { token: encodeURIComponent(token) }) : null, expiresAt },
		};
	};

	/**
	 * @param {Site} site
	 * @param {string} unitId
	 * @param {Actor} actor
	 */
	const revokeReportLink = async (site, unitId, actor) => {
		const unit = await site.repos.units.get(unitId);
		if (!unit) return false;
		await site.repos.units.update(unitId, { report: null });
		await record(site, actor, 'report.revoke', { unitId });
		return true;
	};

	/**
	 * The buyer-facing report behind a token (null when unknown, revoked or expired).
	 * @param {Site} site
	 * @param {unknown} token
	 */
	const report = async (site, token) => {
		const hash = reports.hashOf(token);
		if (!hash) return null;
		const unit = await site.repos.units.byReportToken(hash);
		if (!unit?.report || !unit.lastInspectionId || Date.parse(unit.report.expiresAt) <= now()) return null;
		const inspection = await site.repos.inspections.get(unit.lastInspectionId);
		if (!inspection || inspection.status !== 'completed') return null;
		const config = site.settings.inspection;
		/** @type {Array<{ item: string, url: string | null, contentType: string }>} */
		let photos = [];
		if (config.report_shows_photos === true) {
			const stored = (await site.repos.photos.forInspection(inspection.id)).filter((photo) => photo.status === 'stored');
			const base = String(config.public_base_url ?? '').replace(/\/+$/, '');
			const bucket = stored.length > 0 && !base ? await bucketOf(site) : null;
			photos = stored.map((photo) => {
				/** @type {string | null} */
				let url = null;
				if (base) url = `${base}/${String(photo.objectKey).split('/').map(encodeURIComponent).join('/')}`;
				else if (bucket)
					try {
						url = bucket.presignGet({ key: photo.key, expiresIn: config.view_ttl_seconds }).url;
					} catch {
						url = null;
					}
				return { item: photo.item, url, contentType: photo.contentType };
			});
		}
		return {
			...reportView({
				unit,
				inspection,
				checklist: site.settings.checklists.find((entry) => entry.key === inspection.checklist) ?? null,
				index: site.settings.index,
				badgeStyle: site.settings.badgeStyle,
				photos,
				showInspector: config.report_shows_inspector === true,
			}),
			expiresAt: unit.report.expiresAt,
		};
	};

	return {
		createUnit,
		updateUnit,
		deleteUnit,
		startInspection,
		updateInspection,
		photoUpload,
		sweepPhotos,
		issueReportLink,
		revokeReportLink,
		report,
	};
};
