/**
 * The reviews application service: orchestrates `core/` decisions over the `adapters/` repositories for one website at
 * a time. Handlers (REST, events, dashboard, jobs) stay thin and call these functions; every rule lives in `core/`.
 *
 * Exactly-once: a review's id derives from the request's Idempotency-Key (and an imported one from its external id or
 * row), a request's id from its order, a message's provider idempotency key from the request and the send number, and
 * the usage record (`review`) and published events from the review id — so retries converge.
 */
import { analyticsRange, assembleAnalytics } from '../core/analytics.js';
import { mapImportRows, parseCsv } from '../core/csv.js';
import { decide, moderationContext } from '../core/moderation.js';
import { orderFacts } from '../core/orders.js';
import { averageOf, emptyRollup, summaryView, starsView } from '../core/ratings.js';
import {
	afterFailure,
	afterSent,
	buildRequest,
	itemEligibility,
	nextStep,
	pendingItems,
	pickChannel,
	reviewUrl,
} from '../core/requests.js';
import { buildReview, dedupeKeyOf, submissionRefusal } from '../core/reviews.js';
import { productJsonLd, selectReviews } from '../core/structured.js';
import { displayName, sanitizeText } from '../core/text.js';
import { DAY_MS, MINUTE_MS, inWindow, iso, toMs } from '../core/time.js';
import { STALE_BACKSTOP_MS } from '../adapters/db.js';
import { customerRequestView, ownerReview, publicReview, questionView, requestView } from '../core/views.js';

/** @typedef {import('../adapters/db.js').Repositories} Repositories */
/** @typedef {import('./settings.js').Settings} Settings */
/** @typedef {{ websiteId: string, settings: Settings, repos: Repositories }} Site */
/** @typedef {import('../core/views.js').StoredReview} StoredReview */
/** @typedef {import('../core/requests.js').ReviewRequest} ReviewRequest */
/** @typedef {{ type: string, id?: string }} Actor */
/** @typedef {{ ok: false, reason: string, detail?: string, errors?: Array<{ path: string, code: string }> }} Failure */

/**
 * @typedef {object} ServiceDeps
 * @property {(event: { websiteId: string, type: string, data: Record<string, unknown>, idempotencyKey: string }) => Promise<unknown>} [publish]
 * @property {(usage: { websiteId: string, unit: string, quantity: number, idempotencyKey: string, occurredAt?: string }) => Promise<unknown> | unknown} [recordUsage]
 * @property {(entry: { websiteId: string, actor: Actor, action: string, target?: Record<string, unknown>, before?: unknown, after?: unknown }) => Promise<unknown>} [audit]
 * @property {(websiteId: string) => Promise<any>} [storage] the merchant's storage connector
 * @property {(websiteId: string) => Promise<any>} [messaging] the merchant's messaging connector
 * @property {import('../adapters/tokens.js').LinkTokens} tokens
 * @property {(text: string) => string} hash stable 26-char id material from a key
 * @property {{ requests: number, orders: number, photos: number }} retention days
 * @property {Record<string, Record<string, string>>} strings catalogs by language
 * @property {() => number} [now]
 */

/** Published event types. */
export const EVENTS = Object.freeze({ submitted: 'reviews.submitted@1', approved: 'reviews.approved@1' });

/** Unit metered per collected review. */
export const METERED_UNIT = 'review';

/** Grace after a photo slot's `staleAt` before the sweep deletes it (covers submissions in flight). */
const SWEEP_GRACE_MS = 10 * MINUTE_MS;

/** Stale photo slots swept when the website creates a new upload slot. */
export const UPLOAD_SWEEP_LIMIT = 25;

/** How long a claimed request delivery is held before another run may retry it. */
const CLAIM_LEASE_MS = 15 * MINUTE_MS;
/** Errors returned by an import (the rest are counted). */
const MAX_IMPORT_ERRORS = 200;

/**
 * @param {string} template
 * @param {Record<string, string | number>} params
 */
const fill = (template, params) =>
	template.replace(/\{([A-Za-z_]\w*)\}/g, (match, name) => (Object.hasOwn(params, name) ? String(params[name]) : match));

/**
 * @param {ServiceDeps} deps
 */
export const createReviewsService = ({
	publish = async () => {},
	recordUsage = () => {},
	audit = async () => {},
	storage = async () => {
		throw new Error('no storage connector');
	},
	messaging = async () => {
		throw new Error('no messaging connector');
	},
	tokens,
	hash,
	retention,
	strings,
	now = Date.now,
}) => {
	/** @param {string} websiteId @param {string} prefix @param {string} key */
	const idFor = (websiteId, prefix, key) => `${prefix}_${hash(`${websiteId}|${prefix}|${key}`)}`;
	/** @param {string} lang */
	const catalog = (lang) => ({ ...(strings.en ?? {}), ...(strings[lang] ?? {}) });
	const anonymous = () => catalog('en')['reviews.author.anonymous'] ?? 'Anonymous';

	/**
	 * Publish best effort (the change is stored either way; the Portal dedupes on the idempotency key).
	 * @param {Parameters<NonNullable<ServiceDeps['publish']>>[0]} event
	 */
	const emit = async (event) => {
		try {
			await publish(event);
		} catch {
			// an unreachable Event Hub never fails a review
		}
	};

	/** @param {Site} site @param {Actor} actor @param {string} action @param {Record<string, unknown>} target @param {unknown} [after] */
	const record = async (site, actor, action, target, after) => {
		try {
			await audit({ websiteId: site.websiteId, actor, action, target, ...(after === undefined ? {} : { after }) });
		} catch {
			// audit is best effort here: the merchant database already holds the change
		}
	};

	// ── rollups ─────────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Recompute an item's approved-review rollup from the reviews (exact and idempotent).
	 * @param {Site} site
	 * @param {string} itemId
	 */
	const refreshRollup = async (site, itemId) => {
		const rollup = await site.repos.reviews.rollup(itemId);
		const summary = averageOf(rollup, site.settings.content.rating_scale);
		await site.repos.items.saveRollup(itemId, rollup, summary);
		return summary;
	};

	/**
	 * Summary of an item (rollup on the current scale).
	 * @param {Site} site
	 * @param {string} itemId
	 */
	const summary = async (site, itemId) => {
		const item = await site.repos.items.get(itemId);
		return {
			itemId,
			title: item?.title ?? null,
			...summaryView(item?.rollup ?? emptyRollup(), {
				scale: site.settings.content.rating_scale,
				attributes: site.settings.content.attributes,
			}),
		};
	};

	/**
	 * Compact stars of several items (product lists).
	 * @param {Site} site
	 * @param {string[]} itemIds
	 */
	const stars = async (site, itemIds) => {
		const docs = await site.repos.items.getMany(itemIds);
		const byId = new Map(docs.map((/** @type {any} */ doc) => [doc.itemId, doc]));
		return itemIds.map((itemId) => starsView(itemId, byId.get(itemId)?.rollup ?? null, site.settings.content.rating_scale));
	};

	// ── photos ──────────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * How photo links are made for a website: the public base URL, presigned GETs from the merchant's bucket, or none
	 * (photos off or the connector unavailable — reviews still render).
	 * @param {Site} site
	 * @returns {Promise<import('../core/views.js').PhotoUrl | null>}
	 */
	const photoLinks = async (site) => {
		const config = site.settings.photos;
		if (!config) return null;
		if (config.public_base_url) {
			const base = config.public_base_url.replace(/\/+$/, '');
			return (photo) => `${base}/${(photo.objectKey ?? photo.key).split('/').map(encodeURIComponent).join('/')}`;
		}
		try {
			const bucket = await storage(site.websiteId);
			return (photo) => {
				try {
					return bucket.presignGet({ key: photo.key, expiresIn: config.view_ttl_seconds }).url;
				} catch {
					return null;
				}
			};
		} catch {
			return null;
		}
	};

	/**
	 * A presigned upload slot in the merchant's bucket.
	 * @param {Site} site
	 * @param {{ contentType: string, size: number, customerId: string | null, key: string }} input
	 * @returns {Promise<{ ok: true, photo: Record<string, unknown> } | Failure>}
	 */
	const createUpload = async (site, { contentType, size, customerId, key }) => {
		const config = /** @type {NonNullable<Settings['photos']>} */ (site.settings.photos);
		let bucket;
		try {
			bucket = await storage(site.websiteId);
		} catch {
			return { ok: false, reason: 'storage_unavailable' };
		}
		const id = idFor(site.websiteId, 'rph', key);
		const existing = await site.repos.photos.get(id);
		// a retried request re-signs the slot it created first: same key, type and declared size
		const declared = { contentType: existing?.contentType ?? contentType, size: existing?.size ?? size };
		// `content-length` is a signed header: the bucket refuses a body of any other size than the declared one
		const slot = bucket.presignPut({
			key: `photos/${id}`,
			contentType: declared.contentType,
			contentLength: declared.size,
			expiresIn: config.upload_ttl_seconds,
		});
		if (!existing) {
			await site.repos.photos.insert({
				id,
				key: slot.key,
				objectKey: bucket.fullKey(slot.key),
				contentType,
				size,
				customerId,
				status: 'pending',
				reviewId: null,
				// past `staleAt` the sweep deletes the object and the slot; the TTL on `purgeAt` is only a backstop
				staleAt: new Date(now() + retention.photos * DAY_MS),
				purgeAt: new Date(now() + retention.photos * DAY_MS + STALE_BACKSTOP_MS),
			});
			await sweepOnUpload(site, bucket);
		}
		return {
			ok: true,
			photo: {
				id,
				status: existing?.status ?? 'pending',
				upload: { method: slot.method, url: slot.url, headers: slot.headers },
				expiresAt: slot.expiresAt,
				maxBytes: config.max_photo_bytes,
			},
		};
	};

	/**
	 * A pending slot past its `staleAt` can no longer be attached (the sweep may delete its object at any time).
	 * @param {{ staleAt?: unknown }} photo
	 */
	const isStale = (photo) =>
		photo.staleAt !== undefined && photo.staleAt !== null && new Date(/** @type {any} */ (photo.staleAt)).getTime() <= now();

	/**
	 * Delete the objects and records of this website's stale photo slots (bounded and idempotent): on the website's next
	 * upload and from the dashboard's "Clean up photo uploads".
	 * @param {Site} site
	 * @param {{ limit?: number, bucket?: any }} [options] slots per run (default: the sweep's); `bucket`: the storage
	 *   connector already resolved
	 * @returns {Promise<{ scanned: number, deleted: number, missing: number, failed: number }>}
	 */
	const sweepPhotos = (site, { limit, bucket } = {}) =>
		site.repos.photos.sweepStale({
			storage: bucket ? async () => bucket : () => storage(site.websiteId),
			olderThanMs: SWEEP_GRACE_MS,
			...(limit === undefined ? {} : { limit }),
		});

	/**
	 * A new upload slot sweeps a few of the website's stale ones (best effort: a failure never fails the upload).
	 * @param {Site} site
	 * @param {any} bucket
	 */
	const sweepOnUpload = async (site, bucket) => {
		try {
			await sweepPhotos(site, { limit: UPLOAD_SWEEP_LIMIT, bucket });
		} catch {
			// retried on the next upload or from the dashboard
		}
	};

	/**
	 * Check photos before they are attached: pending, owned by the submitter, uploaded, of an allowed type and exactly the
	 * declared size. The presigned PUT already signs type and size; this HEAD check stays as defence in depth (some
	 * S3-compatible stores do not enforce signed headers) and is needed anyway to know the upload happened.
	 * @param {Site} site
	 * @param {string[]} ids
	 * @param {string | null} customerId
	 * @returns {Promise<{ ok: true, photos: import('../core/views.js').StoredPhoto[] } | Failure>}
	 */
	const checkPhotos = async (site, ids, customerId) => {
		if (ids.length === 0) return { ok: true, photos: [] };
		const config = /** @type {NonNullable<Settings['photos']>} */ (site.settings.photos);
		let bucket;
		try {
			bucket = await storage(site.websiteId);
		} catch {
			return { ok: false, reason: 'storage_unavailable' };
		}
		/** @type {import('../core/views.js').StoredPhoto[]} */
		const out = [];
		for (const [index, id] of ids.entries()) {
			const photo = await site.repos.photos.get(id);
			const invalid = {
				ok: /** @type {const} */ (false),
				reason: 'photo_invalid',
				errors: [{ path: `/photoIds/${index}`, code: 'photo_invalid' }],
			};
			if (!photo || photo.status !== 'pending' || (photo.customerId ?? null) !== customerId || isStale(photo)) return invalid;
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
			if (
				!head.exists ||
				!(Number(head.size) > 0 && Number(head.size) <= config.max_photo_bytes) ||
				(typeof photo.size === 'number' && Number(head.size) !== photo.size) ||
				!config.allowed_types.includes(type ?? '') ||
				type !== photo.contentType
			)
				return invalid;
			out.push({ id, key: photo.key, objectKey: photo.objectKey, contentType: photo.contentType, size: Number(head.size) });
		}
		return { ok: true, photos: out };
	};

	// ── orders → requests ───────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Create (once per order) the review request of a completed order. With the request flow on and
	 * `collection.send_on_completion`, the website's request flow runs right away (`sendOnCompletion`): the new request
	 * is sent now — there is no delayed send — together with the website's other due requests and reminders.
	 * @param {Site} site
	 * @param {import('../core/orders.js').OrderFacts} facts
	 * @param {{ completedAt: number, locale?: string | null, source: 'event' | 'api' }} input a completion reported
	 *   in the future counts as now
	 * @returns {Promise<{ ok: true, request: ReviewRequest, created: boolean } | Failure>}
	 */
	const createRequest = async (site, facts, { completedAt, locale = null, source }) => {
		if (!facts.customerId) return { ok: false, reason: 'no_customer' };
		if (facts.lines.length === 0) return { ok: false, reason: 'no_items' };
		const { collection } = site.settings;
		const at = Math.min(completedAt, now());
		const request = buildRequest({
			id: idFor(site.websiteId, 'rrq', facts.orderId),
			order: { ...facts, customerId: facts.customerId },
			completedAt: at,
			windowDays: collection.review_window_days,
			locale,
			source,
		});
		const created = await site.repos.requests.insert({
			...request,
			purgeAt: new Date(at + retention.requests * DAY_MS),
		});
		for (const line of facts.lines) await site.repos.items.remember({ itemId: line.itemId, title: line.title, sku: line.sku });
		if (created && (await sendOnCompletion(site)))
			return { ok: true, request: /** @type {ReviewRequest} */ (await site.repos.requests.get(request.id)), created };
		return {
			ok: true,
			request: created ? request : /** @type {ReviewRequest} */ (await site.repos.requests.byOrder(facts.orderId)),
			created,
		};
	};

	/**
	 * After an order completed: run the website's request flow when it is on and sends on completion (best effort — a
	 * failure leaves the requests due for the next completion or a manual run).
	 * @param {Site} site
	 * @returns {Promise<boolean>} whether the flow ran
	 */
	const sendOnCompletion = async (site) => {
		if (!site.settings.requestFlow || !site.settings.collection.send_on_completion) return false;
		try {
			await runRequests(site);
			return true;
		} catch {
			return false;
		}
	};

	/**
	 * The envelope's acting customer, when any.
	 * @param {any} event
	 * @returns {string | null}
	 */
	const actorOf = (event) => (event.actor?.type === 'customer' && typeof event.actor.id === 'string' ? event.actor.id : null);

	/**
	 * `order.placed@1`: remember who bought what (completion events may carry less).
	 * @param {Site} site
	 * @param {any} event
	 */
	const orderPlaced = async (site, event) => {
		const previous = await site.repos.orders.get(event.data.orderId);
		const facts = orderFacts(event.data, { actorId: actorOf(event), previous });
		await site.repos.orders.save(facts, new Date(now() + retention.orders * DAY_MS));
		return { ok: true, facts };
	};

	/**
	 * `order.completed@1`: the purchase is verified — open the review request.
	 * @param {Site} site
	 * @param {any} event
	 */
	const orderCompleted = async (site, event) => {
		const previous = await site.repos.orders.get(event.data.orderId);
		const facts = orderFacts(event.data, { actorId: actorOf(event), previous });
		await site.repos.orders.save(facts, new Date(now() + retention.orders * DAY_MS));
		const at = toMs(event.occurredAt);
		return createRequest(site, facts, { completedAt: Number.isFinite(at) ? at : now(), source: 'event' });
	};

	/**
	 * `order.cancelled@1` closes the request; `order.refunded@1` removes the refunded items (all of them without lines).
	 * @param {Site} site
	 * @param {any} event
	 */
	const orderReversed = async (site, event) => {
		const request = /** @type {ReviewRequest | null} */ (await site.repos.requests.byOrder(event.data.orderId));
		if (!request || request.status !== 'open') return { ok: true, changed: false };
		const refunded = Array.isArray(event.data.lines)
			? new Set(event.data.lines.map((/** @type {{ itemId: string }} */ line) => line.itemId))
			: null;
		const keep =
			event.type.startsWith('order.refunded') && refunded
				? request.items.filter((item) => item.reviewId || !refunded.has(item.itemId))
				: request.items.filter((item) => item.reviewId);
		const open = keep.some((item) => !item.reviewId);
		const changed = await site.repos.requests.update(
			request.id,
			open
				? { items: keep }
				: {
						items: keep,
						status: keep.length > 0 ? 'completed' : 'cancelled',
						'delivery.state': 'done',
						'delivery.nextAt': null,
					},
			['open'],
		);
		return { ok: true, changed };
	};

	// ── submissions ─────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * The open request that verifies a customer's review of an item (optionally of one order), or why there is none:
	 * `already_reviewed` when every request with the item already has its review.
	 * @param {Site} site
	 * @param {{ customerId: string, itemId: string, orderId: string | null }} input
	 * @returns {Promise<ReviewRequest | 'already_reviewed' | null>}
	 */
	const verifyingRequest = async (site, { customerId, itemId, orderId }) => {
		const candidates = /** @type {ReviewRequest[]} */ (
			await site.repos.requests.forCustomer([customerId], { statuses: ['open', 'completed'], itemId, fetchLimit: 20 })
		).filter((request) => !orderId || request.orderId === orderId);
		const eligible = candidates.find((request) => itemEligibility(request, itemId, now()) === 'ok');
		if (eligible) return eligible;
		return candidates.some((request) => itemEligibility(request, itemId, now()) === 'already_reviewed')
			? 'already_reviewed'
			: null;
	};

	/**
	 * Store a review once per idempotency key, moderated, metered and announced.
	 * @param {Site} site
	 * @param {{ value: import('../core/validate.js').ReviewValue, submitter: { via: 'server' | 'identity' | 'token' | 'guest',
	 *   customerId: string | null }, key: string }} input
	 * @returns {Promise<{ ok: true, review: StoredReview, duplicate: boolean } | Failure>}
	 */
	const submit = async (site, { value, submitter, key }) => {
		const { settings, repos } = site;
		const id = idFor(site.websiteId, 'rev', key);
		const replay = /** @type {StoredReview | null} */ (await repos.reviews.get(id));
		if (replay) return { ok: true, review: replay, duplicate: true };
		let customerId = submitter.via === 'server' ? value.customerId : submitter.customerId;
		/** @type {ReviewRequest | null} */
		let request = null;
		if (submitter.via === 'token') {
			const requestId = tokens.verify(value.token, site.websiteId);
			request = requestId ? /** @type {ReviewRequest | null} */ (await repos.requests.get(requestId)) : null;
			if (!request) return { ok: false, reason: 'invalid_token' };
			const eligibility = itemEligibility(request, value.itemId, now());
			if (eligibility === 'already_reviewed') return { ok: false, reason: 'already_reviewed' };
			if (eligibility === 'not_in_order')
				return { ok: false, reason: 'not_verified', detail: 'The item is not part of this order.' };
			if (eligibility !== 'ok') return { ok: false, reason: 'request_closed' };
			customerId = request.customerId;
		} else if (customerId) {
			const found = await verifyingRequest(site, { customerId, itemId: value.itemId, orderId: value.orderId });
			if (found === 'already_reviewed') return { ok: false, reason: 'already_reviewed' };
			request = found;
		}
		const verified = request !== null;
		const refusal = submissionRefusal({ via: submitter.via, customerId }, { who: settings.collection.who, verified });
		if (refusal) return { ok: false, reason: refusal };
		if (submitter.via === 'guest' && !value.author.name)
			return { ok: false, reason: 'validation_failed', errors: [{ path: '/author/name', code: 'required' }] };
		const at = now();
		const reviewsToday = customerId ? await repos.reviews.countByCustomerSince(customerId, iso(at - DAY_MS)) : 0;
		if (reviewsToday >= settings.collection.max_reviews_per_customer_per_day) return { ok: false, reason: 'review_limit' };
		const orderId = request?.orderId ?? (submitter.via === 'server' ? value.orderId : null);
		const dedupeKey = dedupeKeyOf({ customerId, itemId: value.itemId, orderId }, settings.collection.one_review_per);
		if (dedupeKey && (await repos.reviews.byDedupeKey(dedupeKey))) return { ok: false, reason: 'already_reviewed' };
		const photos = await checkPhotos(site, value.photoIds, submitter.via === 'server' ? null : customerId);
		if (!photos.ok) return photos;
		const item = await repos.items.get(value.itemId);
		const itemSummary = averageOf(item?.rollup ?? emptyRollup(), settings.content.rating_scale);
		const submission = { rating: value.rating, title: value.title, body: value.body, verified, photos: photos.photos.length };
		const source = submitter.via === 'token' ? 'request_link' : submitter.via === 'server' ? 'api' : 'storefront';
		const decision = decide({
			review: submission,
			settings: settings.moderation,
			context: moderationContext({
				review: {
					...submission,
					itemId: value.itemId,
					attributes: value.attributes,
					source,
					locale: value.locale,
					scale: settings.content.rating_scale,
				},
				customer: {
					id: customerId,
					identified: submitter.via !== 'guest',
					reviewsToday,
				},
				item: { id: value.itemId, count: itemSummary.count, average: itemSummary.average },
				flags: [],
			}),
			now: at,
			timeZone: settings.timeZone,
		});
		const review = buildReview({
			id,
			value,
			customerId,
			orderId,
			requestId: request?.id ?? null,
			verified,
			source,
			scale: settings.content.rating_scale,
			photos: photos.photos,
			decision,
			dedupeKey,
			now: iso(at),
			authorName: value.author.name ?? request?.contact.name ?? null,
			authorEmail: value.author.email,
		});
		const stored = await repos.reviews.insert(review);
		if (stored === 'duplicate') return { ok: false, reason: 'already_reviewed' };
		if (stored === 'replay')
			return { ok: true, review: /** @type {StoredReview} */ (await repos.reviews.get(id)), duplicate: true };
		if (request) await repos.requests.markReviewed(request.id, value.itemId, id);
		if (photos.photos.length > 0)
			await repos.photos.attach(
				photos.photos.map((photo) => photo.id),
				id,
			);
		await repos.items.remember({ itemId: value.itemId, title: null, sku: null });
		const rollup = decision.status === 'approved' ? await refreshRollup(site, value.itemId) : null;
		await recordUsage({
			websiteId: site.websiteId,
			unit: METERED_UNIT,
			quantity: 1,
			idempotencyKey: `review:${id}`,
			occurredAt: review.submittedAt,
		});
		await emit({
			websiteId: site.websiteId,
			type: EVENTS.submitted,
			idempotencyKey: `submitted:${id}`,
			data: {
				reviewId: id,
				itemId: review.itemId,
				rating: review.rating,
				ratingScale: review.scale,
				status: review.status,
				verifiedPurchase: verified,
				source: /** @type {'storefront' | 'request_link' | 'api'} */ (source),
				hasPhotos: review.photoCount > 0,
				...(customerId ? { customerId } : {}),
				...(orderId ? { orderId } : {}),
				...(review.requestId ? { requestId: review.requestId } : {}),
				submittedAt: review.submittedAt,
			},
		});
		if (rollup) await announceApproved(site, review, rollup, decision.by === 'rule' ? 'rule' : 'default');
		return { ok: true, review, duplicate: false };
	};

	/**
	 * @param {Site} site
	 * @param {StoredReview} review
	 * @param {{ count: number, average: number }} rollup
	 * @param {'rule' | 'default' | 'person'} decidedBy
	 */
	const announceApproved = (site, review, rollup, decidedBy) =>
		emit({
			websiteId: site.websiteId,
			type: EVENTS.approved,
			idempotencyKey: `approved:${review.id}`,
			data: {
				reviewId: review.id,
				itemId: review.itemId,
				rating: review.rating,
				ratingScale: review.scale,
				verifiedPurchase: review.verifiedPurchase,
				decidedBy,
				...(decidedBy === 'rule' && review.moderation.ruleId ? { ruleId: review.moderation.ruleId } : {}),
				...(review.customerId ? { customerId: review.customerId } : {}),
				...(review.orderId ? { orderId: review.orderId } : {}),
				summary: rollup,
			},
		});

	// ── moderation ──────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Approve a pending (or previously rejected) review.
	 * @param {Site} site
	 * @param {string} id
	 * @param {{ actor: Actor, note?: string | null }} input
	 * @returns {Promise<{ ok: true, review: StoredReview } | Failure>}
	 */
	const approve = async (site, id, { actor, note = null }) => {
		const before = /** @type {StoredReview | null} */ (await site.repos.reviews.get(id));
		if (!before || before.deletedAt) return { ok: false, reason: 'not_found' };
		const at = iso(now());
		const changed = await site.repos.reviews.transition(id, ['pending', 'rejected'], {
			status: 'approved',
			publishedAt: before.publishedAt ?? at,
			'moderation.by': 'person',
			'moderation.decidedAt': at,
			'moderation.actor': actor.id ?? actor.type,
			'moderation.note': note ? sanitizeText(note, 500) : null,
			'moderation.reason': null,
		});
		if (!changed) return { ok: false, reason: 'not_pending' };
		const review = /** @type {StoredReview} */ (await site.repos.reviews.get(id));
		const rollup = await refreshRollup(site, review.itemId);
		await record(site, actor, 'review.approved', { reviewId: id, itemId: review.itemId }, { status: 'approved' });
		await announceApproved(site, review, rollup, 'person');
		return { ok: true, review };
	};

	/**
	 * Reject a pending (or published) review with a reason code.
	 * @param {Site} site
	 * @param {string} id
	 * @param {{ actor: Actor, reason: string, note?: string | null }} input
	 * @returns {Promise<{ ok: true, review: StoredReview } | Failure>}
	 */
	const reject = async (site, id, { actor, reason, note = null }) => {
		const before = /** @type {StoredReview | null} */ (await site.repos.reviews.get(id));
		if (!before || before.deletedAt) return { ok: false, reason: 'not_found' };
		const changed = await site.repos.reviews.transition(id, ['pending', 'approved'], {
			status: 'rejected',
			'moderation.by': 'person',
			'moderation.decidedAt': iso(now()),
			'moderation.actor': actor.id ?? actor.type,
			'moderation.reason': reason,
			'moderation.note': note ? sanitizeText(note, 500) : null,
		});
		if (!changed) return { ok: false, reason: 'not_pending' };
		if (before.status === 'approved') await refreshRollup(site, before.itemId);
		await record(site, actor, 'review.rejected', { reviewId: id, itemId: before.itemId }, { status: 'rejected', reason });
		return { ok: true, review: /** @type {StoredReview} */ (await site.repos.reviews.get(id)) };
	};

	/**
	 * Set (or with `body: null`, remove) the public merchant reply.
	 * @param {Site} site
	 * @param {string} id
	 * @param {{ actor: Actor, body: string | null }} input
	 * @returns {Promise<{ ok: true, review: StoredReview } | Failure>}
	 */
	const reply = async (site, id, { actor, body }) => {
		const moderation = site.settings.moderation;
		if (!moderation?.replies_enabled) return { ok: false, reason: 'replies_disabled' };
		const text = body === null ? null : sanitizeText(body, moderation.reply_max_length);
		const changed = await site.repos.reviews.update(id, {
			reply: text ? { body: text, at: iso(now()), by: actor.id ?? actor.type } : null,
		});
		if (!changed) return { ok: false, reason: 'not_found' };
		await record(site, actor, text ? 'review.replied' : 'review.reply_removed', { reviewId: id });
		return { ok: true, review: /** @type {StoredReview} */ (await site.repos.reviews.get(id)) };
	};

	/**
	 * Soft-delete a review (it leaves the rollup).
	 * @param {Site} site
	 * @param {string} id
	 * @param {Actor} actor
	 * @returns {Promise<{ ok: true, review: StoredReview } | Failure>}
	 */
	const remove = async (site, id, actor) => {
		const before = /** @type {StoredReview | null} */ (await site.repos.reviews.get(id));
		if (!before || before.deletedAt) return { ok: false, reason: 'not_found' };
		await site.repos.reviews.update(id, { deletedAt: iso(now()), dedupeKey: null });
		if (before.status === 'approved') await refreshRollup(site, before.itemId);
		await record(site, actor, 'review.deleted', { reviewId: id, itemId: before.itemId });
		return { ok: true, review: { ...before, deletedAt: iso(now()) } };
	};

	// ── requests: links and the request flow ────────────────────────────────────────────────────────────────────

	/**
	 * A signed review link for a request (for merchants who send their own messages).
	 * @param {Site} site
	 * @param {ReviewRequest} request
	 */
	const linkFor = (site, request) => {
		const issued = tokens.issue({
			websiteId: site.websiteId,
			requestId: request.id,
			ttlDays: site.settings.collection.link_ttl_days,
		});
		const template = site.settings.requestFlow?.review_url ?? '';
		return {
			requestId: request.id,
			token: issued.token,
			expiresAt: issued.expiresAt,
			url: reviewUrl(template, { token: issued.token, orderId: request.orderId, requestId: request.id }),
		};
	};

	/**
	 * Resolve a review link token to its request (customer view).
	 * @param {Site} site
	 * @param {string} token
	 */
	const openRequest = async (site, token) => {
		const requestId = tokens.verify(token, site.websiteId);
		const request = requestId ? /** @type {ReviewRequest | null} */ (await site.repos.requests.get(requestId)) : null;
		if (request?.status === 'open' && toMs(request.expiresAt) <= now()) await expireRequest(site, request.id);
		return request
			? { ok: /** @type {const} */ (true), request: customerRequestView(request, now()), contactName: request.contact.name }
			: null;
	};

	/**
	 * Mark an open request past its `expiresAt` as expired (it already reads as expired; this settles it when touched).
	 * @param {Site} site
	 * @param {string} id
	 */
	const expireRequest = (site, id) =>
		site.repos.requests.update(id, { status: 'expired', 'delivery.state': 'done', 'delivery.nextAt': null }, ['open']);

	/**
	 * Send one due request (or reminder) through the merchant's messaging connector.
	 * @param {Site} site
	 * @param {ReviewRequest} request
	 * @param {any} channelAdapter
	 * @param {'request' | 'reminder'} kind
	 * @returns {Promise<'sent' | 'failed' | 'no_contact' | 'no_url'>}
	 */
	const deliver = async (site, request, channelAdapter, kind) => {
		const flow = /** @type {Record<string, any>} */ (site.settings.requestFlow);
		const at = now();
		const target = pickChannel(request.contact, flow.channels);
		if (!target) {
			await site.repos.requests.update(request.id, {
				delivery: { ...request.delivery, state: 'off', nextAt: null, lastError: 'no_contact' },
			});
			return 'no_contact';
		}
		const link = linkFor(site, request);
		if (!link.url) {
			await site.repos.requests.update(request.id, {
				delivery: { ...request.delivery, nextAt: iso(at + DAY_MS), lastError: 'review_url_missing' },
			});
			return 'no_url';
		}
		const lang = request.locale ?? flow.language;
		const t = catalog(lang);
		const items = pendingItems(request)
			.map((item) => item.title ?? item.itemId)
			.join(', ');
		const params = {
			name: request.contact.name ?? t['reviews.request.customer'] ?? '',
			number: request.number ?? request.orderId,
			url: link.url,
			items,
		};
		try {
			await channelAdapter.send({
				channel: target.channel,
				to: target.to,
				template: kind === 'request' ? flow.request_template : flow.reminder_template,
				locale: lang,
				idempotencyKey: `review-request:${request.id}:${request.delivery.sends}`,
				subject: fill(t[`reviews.${kind}.subject`] ?? '', params),
				text: fill(t[`reviews.${kind}.message`] ?? '', params),
				data: { kind, requestId: request.id, orderId: request.orderId, ...params },
			});
		} catch (error) {
			const status = /** @type {{ details?: { status?: number }, status?: number }} */ (error)?.details?.status;
			await site.repos.requests.update(request.id, {
				delivery: afterFailure(request, {
					now: at,
					maxAttempts: flow.max_attempts,
					error: /** @type {Error} */ (error)?.message ?? 'send_failed',
					permanent: typeof status === 'number' && status >= 400 && status < 500 && status !== 429,
				}),
			});
			return 'failed';
		}
		await site.repos.requests.update(request.id, {
			delivery: afterSent(request, { now: at, reminders: flow.reminders, channel: target.channel }),
		});
		return 'sent';
	};

	/**
	 * The request flow for one website: expire, send and remind due requests (bounded per run, quiet hours honoured).
	 * Runs when an order completes (`send_on_completion`), from `POST /v1/request-flow:run` and from the dashboard.
	 * @param {Site} site
	 * @returns {Promise<Record<string, number | boolean>>}
	 */
	const runRequests = async (site) => {
		const flow = site.settings.requestFlow;
		const counts = { due: 0, sent: 0, reminded: 0, failed: 0, expired: 0, skipped: 0, quiet: false };
		if (!flow) return counts;
		const at = now();
		const quiet = inWindow(at, flow.quiet_hours, site.settings.timeZone);
		const due = /** @type {ReviewRequest[]} */ (await site.repos.requests.due(iso(at), flow.max_per_run));
		counts.due = due.length;
		/** @type {any} */
		let adapter = null;
		for (const request of due) {
			const step = nextStep(request, { now: at, reminders: flow.reminders, quiet });
			if (step.action === 'wait') {
				counts.quiet = true;
				continue;
			}
			if (
				!(await site.repos.requests.claim(
					request.id,
					/** @type {string} */ (request.delivery.nextAt),
					iso(at + CLAIM_LEASE_MS),
				))
			) {
				counts.skipped += 1;
				continue;
			}
			if (step.action === 'expire') {
				await expireRequest(site, request.id);
				counts.expired += 1;
				continue;
			}
			if (step.action === 'done') {
				await site.repos.requests.update(request.id, { 'delivery.state': 'done', 'delivery.nextAt': null });
				continue;
			}
			if (!adapter) {
				try {
					adapter = await messaging(site.websiteId);
				} catch {
					// connector unavailable: count an attempt (back-off) and try again on a later run
					await site.repos.requests.update(request.id, {
						delivery: afterFailure(request, { now: at, maxAttempts: flow.max_attempts, error: 'messaging_unavailable' }),
					});
					counts.failed += 1;
					continue;
				}
			}
			const outcome = await deliver(site, request, adapter, step.kind);
			if (outcome === 'sent') counts[step.kind === 'request' ? 'sent' : 'reminded'] += 1;
			else if (outcome === 'failed') counts.failed += 1;
			else counts.skipped += 1;
		}
		return counts;
	};

	/**
	 * Request flow status (counts by status and delivery state, next due instant).
	 * @param {Site} site
	 */
	const flowStatus = async (site) => {
		const rows = await site.repos.requests.stats();
		/** @type {Record<string, number>} */
		const byStatus = {};
		/** @type {Record<string, number>} */
		const byDelivery = {};
		for (const row of rows) {
			byStatus[row.status] = (byStatus[row.status] ?? 0) + row.count;
			if (row.status === 'open') byDelivery[row.state] = (byDelivery[row.state] ?? 0) + row.count;
		}
		return {
			enabled: site.settings.requestFlow !== null,
			reviewUrlConfigured: Boolean(site.settings.requestFlow?.review_url),
			requests: byStatus,
			delivery: byDelivery,
			nextDueAt: await site.repos.requests.nextDue(),
		};
	};

	// ── questions & answers ─────────────────────────────────────────────────────────────────────────────────────

	/**
	 * @param {Site} site
	 * @param {{ itemId: string, body: string, author: { name?: string, email?: string } | null, customerId: string | null,
	 *   locale: string | null, key: string, server: boolean }} input
	 */
	const ask = async (site, { itemId, body, author, customerId, locale, key, server }) => {
		const { qna } = site.settings;
		const at = now();
		if (customerId && !server) {
			const recent = await site.repos.questions.countByCustomerSince(customerId, iso(at - DAY_MS));
			if (recent >= qna.max_questions_per_customer_per_day)
				return { ok: /** @type {const} */ (false), reason: 'question_limit' };
		}
		const question = {
			id: idFor(site.websiteId, 'rqn', key),
			itemId,
			body: sanitizeText(body, qna.question_max_length),
			author: { name: author?.name ?? null, email: author?.email ?? null },
			customerId,
			status: qna.moderate_questions && !server ? 'pending' : 'published',
			answers: [],
			locale,
			askedAt: iso(at),
			answeredAt: null,
		};
		await site.repos.questions.insert(question);
		return {
			ok: /** @type {const} */ (true),
			question: /** @type {import('../core/views.js').StoredQuestion} */ (await site.repos.questions.get(question.id)),
		};
	};

	/**
	 * Answer a question: the merchant always; customers per `qna.who_can_answer`.
	 * @param {Site} site
	 * @param {string} questionId
	 * @param {{ body: string, author: { name?: string } | null, customerId: string | null, merchant: boolean, key: string }} input
	 * @returns {Promise<{ ok: true, question: import('../core/views.js').StoredQuestion } | Failure>}
	 */
	const answer = async (site, questionId, { body, author, customerId, merchant, key }) => {
		const { qna } = site.settings;
		const question = /** @type {import('../core/views.js').StoredQuestion | null} */ (
			await site.repos.questions.get(questionId)
		);
		if (!question || question.status === 'rejected') return { ok: false, reason: 'not_found' };
		let verifiedBuyer = false;
		if (!merchant) {
			if (qna.who_can_answer === 'merchant' || !customerId) return { ok: false, reason: 'answers_closed' };
			const purchases = await site.repos.requests.forCustomer([customerId], { itemId: question.itemId, fetchLimit: 1 });
			verifiedBuyer = purchases.length > 0;
			if (qna.who_can_answer === 'verified_buyers' && !verifiedBuyer) return { ok: false, reason: 'not_verified' };
		}
		await site.repos.questions.addAnswer(questionId, {
			id: idFor(site.websiteId, 'ran', key),
			body: sanitizeText(body, qna.answer_max_length),
			author: merchant ? null : { name: author?.name ?? null },
			customerId: merchant ? null : customerId,
			by: merchant ? 'merchant' : 'customer',
			verifiedBuyer,
			status: merchant || !qna.moderate_answers ? 'published' : 'pending',
			answeredAt: iso(now()),
		});
		return {
			ok: true,
			question: /** @type {import('../core/views.js').StoredQuestion} */ (await site.repos.questions.get(questionId)),
		};
	};

	/**
	 * Publish or reject a question, or one of its pending answers.
	 * @param {Site} site
	 * @param {{ questionId: string, answerId?: string | null, decision: 'published' | 'rejected', actor: Actor }} input
	 * @returns {Promise<{ ok: true, question: import('../core/views.js').StoredQuestion } | Failure>}
	 */
	const decideQuestion = async (site, { questionId, answerId = null, decision, actor }) => {
		const changed = answerId
			? await site.repos.questions.decideAnswer(questionId, answerId, decision, iso(now()))
			: await site.repos.questions.transition(questionId, ['pending', ...(decision === 'rejected' ? ['published'] : [])], {
					status: decision,
				});
		if (!changed)
			return (await site.repos.questions.get(questionId))
				? { ok: false, reason: 'not_pending' }
				: { ok: false, reason: 'not_found' };
		await record(site, actor, `question.${answerId ? 'answer_' : ''}${decision}`, {
			questionId,
			...(answerId ? { answerId } : {}),
		});
		return {
			ok: true,
			question: /** @type {import('../core/views.js').StoredQuestion} */ (await site.repos.questions.get(questionId)),
		};
	};

	// ── import ──────────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Import reviews from CSV (validated per row; duplicates by external id are skipped). Imports are not metered and
	 * publish no events (they are history, not new reviews).
	 * @param {Site} site
	 * @param {{ csv: string, dryRun: boolean, key: string, actor: Actor }} input
	 */
	const importCsv = async (site, { csv, dryRun, key, actor }) => {
		const { importing, content } = site.settings;
		const parsed = parseCsv(csv, { delimiter: importing.delimiter, maxRows: importing.max_rows + 1 });
		if (!parsed.ok)
			return {
				ok: /** @type {const} */ (false),
				reason: 'csv_invalid',
				errors: [{ path: `/csv`, code: parsed.code, row: parsed.line }],
			};
		const at = now();
		const mapped = mapImportRows(parsed.rows, {
			columns: importing.columns,
			scale: content.rating_scale,
			titleMax: Math.max(content.title_max_length, 0),
			bodyMax: content.body_max_length,
			authorMax: content.author_name_max_length,
			trustVerified: importing.trust_verified_column,
			now: at,
		});
		const report = {
			dryRun,
			rows: parsed.rows.length - 1,
			valid: mapped.records.length,
			imported: 0,
			duplicates: 0,
			invalid: new Set(mapped.errors.map((error) => error.row)).size,
			errors: mapped.errors.slice(0, MAX_IMPORT_ERRORS),
		};
		if (dryRun) return { ok: /** @type {const} */ (true), report };
		/** @type {Set<string>} */
		const touched = new Set();
		for (const row of mapped.records) {
			const submittedAt = row.submittedAt ?? iso(at);
			const decision =
				importing.imported_status === 'approved'
					? /** @type {import('../core/moderation.js').Decision} */ ({
							status: 'approved',
							by: 'default',
							ruleId: null,
							reason: null,
							flags: [],
							terms: [],
						})
					: decide({
							review: { rating: row.rating, title: row.title, body: row.body, verified: row.verified, photos: 0 },
							settings: site.settings.moderation,
							context: moderationContext({
								review: {
									rating: row.rating,
									title: row.title,
									body: row.body,
									verified: row.verified,
									photos: 0,
									itemId: row.itemId,
									source: 'import',
									scale: content.rating_scale,
								},
								flags: [],
							}),
							now: at,
							timeZone: site.settings.timeZone,
						});
			const doc = {
				...buildReview({
					id: idFor(site.websiteId, 'rev', `import:${row.externalId ?? `${key}:${row.row}`}`),
					value: {
						itemId: row.itemId,
						variantId: null,
						rating: row.rating,
						title: row.title,
						body: row.body,
						attributes: {},
						photoIds: [],
						author: { name: row.author, email: null },
						customerId: row.customerId,
						orderId: row.orderId,
						token: null,
						locale: null,
						externalId: row.externalId,
						custom: null,
					},
					customerId: row.customerId,
					orderId: row.orderId,
					requestId: null,
					verified: row.verified,
					source: 'import',
					scale: content.rating_scale,
					photos: [],
					decision,
					dedupeKey: null,
					now: submittedAt,
					authorName: row.author,
					authorEmail: null,
				}),
				reply: row.reply ? { body: row.reply, at: submittedAt, by: 'import' } : null,
			};
			const stored = await site.repos.reviews.insert(doc);
			if (stored === 'created') {
				report.imported += 1;
				touched.add(row.itemId);
				await site.repos.items.remember({ itemId: row.itemId, title: null, sku: null });
			} else report.duplicates += 1;
		}
		for (const itemId of touched) await refreshRollup(site, itemId);
		await record(
			site,
			actor,
			'reviews.imported',
			{ rows: report.rows },
			{ imported: report.imported, duplicates: report.duplicates },
		);
		return { ok: /** @type {const} */ (true), report };
	};

	// ── analytics, structured data, overview ────────────────────────────────────────────────────────────────────

	/**
	 * @param {Site} site
	 * @param {{ from?: unknown, to?: unknown, bucket?: unknown }} query
	 */
	const analytics = async (site, query) => {
		const config = site.settings.analytics;
		const range = analyticsRange(query, {
			now: now(),
			defaultDays: config.default_range_days,
			maxDays: config.max_range_days,
			defaultBucket: config.bucket,
		});
		if (!range.ok) return range;
		const bounds = { from: iso(range.from), to: iso(range.to) };
		const [rows, requests, timing, topItems] = await Promise.all([
			site.repos.reviews.dayRows({ ...bounds, timeZone: site.settings.timeZone }),
			site.repos.requests.conversion(bounds),
			site.repos.reviews.timing(bounds),
			site.repos.reviews.topItems({ ...bounds, limit: config.top_items }),
		]);
		return {
			ok: /** @type {const} */ (true),
			value: assembleAnalytics({
				rows,
				from: range.from,
				to: range.to,
				bucket: range.bucket,
				timeZone: site.settings.timeZone,
				scale: site.settings.content.rating_scale,
				requests,
				timing,
				topItems,
			}),
		};
	};

	/**
	 * Product JSON-LD of an item from approved reviews.
	 * @param {Site} site
	 * @param {string} itemId
	 * @param {{ name?: string | null, url?: string | null, image?: string | null, sku?: string | null }} meta
	 * @returns {Promise<{ ok: true, value: Record<string, unknown> } | Failure>}
	 */
	const jsonLd = async (site, itemId, meta) => {
		const { structured, content, collection } = site.settings;
		const item = await site.repos.items.get(itemId);
		const name = meta.name ?? item?.title ?? null;
		if (!name) return { ok: false, reason: 'name_required', detail: 'Pass ?name= (the item has no stored title yet).' };
		const itemSummary = averageOf(item?.rollup ?? emptyRollup(), content.rating_scale);
		const wanted = structured.include_reviews;
		const approved =
			wanted > 0 && itemSummary.count >= structured.min_reviews
				? /** @type {StoredReview[]} */ (
						await site.repos.reviews.list({
							filter: { itemId, statuses: ['approved'] },
							sort: { submittedAt: -1, id: -1 },
							after: null,
							fetchLimit: structured.review_selection === 'most_detailed' ? Math.min(100, wanted * 10) : wanted,
						})
					)
				: [];
		return {
			ok: true,
			value: productJsonLd({
				item: { itemId, name, url: meta.url ?? null, image: meta.image ?? null, sku: meta.sku ?? item?.sku ?? null },
				brand: structured.brand || null,
				summary: { ...itemSummary, scale: content.rating_scale },
				reviews: selectReviews(approved, { limit: wanted, selection: structured.review_selection }).map((review) => ({
					rating: review.rating,
					scale: review.scale,
					title: review.title,
					body: review.body,
					authorName: displayName(review.author?.name, collection.reviewer_name) ?? anonymous(),
					submittedAt: review.submittedAt,
				})),
				minReviews: structured.min_reviews,
			}),
		};
	};

	/**
	 * Dashboard KPIs.
	 * @param {Site} site
	 */
	const overview = async (site) => {
		const [counts, questions, flow] = await Promise.all([
			site.repos.reviews.countByStatus(),
			site.settings.enabled('qna') ? site.repos.questions.counts() : Promise.resolve({ pending: 0, unanswered: 0 }),
			flowStatus(site),
		]);
		return { reviews: counts, questions, requests: flow.requests, delivery: flow.delivery };
	};

	/**
	 * View helpers bound to a website's settings.
	 * @param {Site} site
	 */
	const viewsFor = async (site) => {
		const links = await photoLinks(site);
		const { display, collection } = site.settings;
		return {
			public: (/** @type {StoredReview} */ review) =>
				publicReview(review, {
					nameFormat: collection.reviewer_name,
					showReply: display.show_replies,
					showVerified: display.show_verified_badge,
					photoUrl: links,
				}),
			owner: (/** @type {StoredReview} */ review) => ownerReview(review, { photoUrl: links }),
			question: (/** @type {import('../core/views.js').StoredQuestion} */ question, owner = false) =>
				questionView(question, { nameFormat: collection.reviewer_name, owner }),
			request: (/** @type {ReviewRequest} */ request, owner = false) =>
				owner ? requestView(request, now()) : customerRequestView(request, now()),
		};
	};

	return Object.freeze({
		sweepPhotos,
		submit,
		approve,
		reject,
		reply,
		remove,
		summary,
		stars,
		refreshRollup,
		createUpload,
		createRequest,
		orderPlaced,
		orderCompleted,
		orderReversed,
		linkFor,
		openRequest,
		runRequests,
		flowStatus,
		ask,
		answer,
		decideQuestion,
		importCsv,
		analytics,
		jsonLd,
		overview,
		viewsFor,
		now,
	});
};

/** @typedef {ReturnType<typeof createReviewsService>} ReviewsService */
