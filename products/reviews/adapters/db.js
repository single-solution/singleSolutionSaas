/**
 * Repositories over the merchant's own database (Part E §7), reached through app-kit `data.forWebsite(websiteId)`:
 * collections are prefixed `ss_reviews_`, every query pins `websiteId` (app-kit's tenant guard rejects any that does
 * not) and inserts are stamped with `websiteId`, `merchantId`, `env`, `createdAt`, `updatedAt` and `schemaVersion`.
 *
 * - `reviews`: one document per review (status, moderation, reply, photos); unique on `id`, on the one-review-per
 *   `dedupeKey` and on imported `externalId`s.
 * - `items`: per item the approved-review rollup (recomputed exactly from approved reviews) and display metadata.
 * - `requests`: one review request per completed order (eligibility + request flow delivery state).
 * - `orders`: order snapshots from `order.placed@1` (items, customer) until completion.
 * - `photos`: upload slots in the merchant's bucket; a pending slot past its `staleAt` is swept by the jobs
 *   (object and record deleted), with a later TTL (`purgeAt`) as a backstop.
 * - `questions`: Q&A, answers embedded.
 * @module
 */
import { sweepStaleUploads } from '@ss/app-kit';

export const SCHEMA_VERSION = 1;

/** A pending photo slot is kept this long after its `staleAt` before the TTL index removes it (sweep backstop). */
export const STALE_BACKSTOP_MS = 7 * 24 * 60 * 60 * 1000;

export const COLLECTIONS = Object.freeze({
	reviews: 'reviews',
	items: 'items',
	requests: 'requests',
	orders: 'orders',
	photos: 'photos',
	questions: 'questions',
});

/**
 * Index definitions (websiteId first everywhere except TTL), created idempotently by app-kit on first use.
 * @type {Array<{ collection: string, keys: Record<string, 1 | -1>, name: string, unique?: boolean, expireAfterSeconds?: number,
 *   partialFilterExpression?: Record<string, unknown> }>}
 */
export const INDEXES = [
	{ collection: 'reviews', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{
		collection: 'reviews',
		keys: { websiteId: 1, dedupeKey: 1 },
		name: 'website_dedupe',
		unique: true,
		partialFilterExpression: { dedupeKey: { $type: 'string' } },
	},
	{
		collection: 'reviews',
		keys: { websiteId: 1, externalId: 1 },
		name: 'website_external',
		unique: true,
		partialFilterExpression: { externalId: { $type: 'string' } },
	},
	{ collection: 'reviews', keys: { websiteId: 1, itemId: 1, status: 1, submittedAt: -1, id: -1 }, name: 'website_item_time' },
	{
		collection: 'reviews',
		keys: { websiteId: 1, itemId: 1, status: 1, rating: -1, submittedAt: -1, id: -1 },
		name: 'website_item_rating',
	},
	{ collection: 'reviews', keys: { websiteId: 1, status: 1, submittedAt: -1, id: -1 }, name: 'website_status_time' },
	{ collection: 'reviews', keys: { websiteId: 1, customerId: 1, submittedAt: -1 }, name: 'website_customer_time' },
	{ collection: 'items', keys: { websiteId: 1, itemId: 1 }, name: 'website_item', unique: true },
	{ collection: 'requests', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'requests', keys: { websiteId: 1, orderId: 1 }, name: 'website_order', unique: true },
	{ collection: 'requests', keys: { websiteId: 1, customerKeys: 1, completedAt: -1 }, name: 'website_customer' },
	{ collection: 'requests', keys: { websiteId: 1, status: 1, 'delivery.nextAt': 1 }, name: 'website_due' },
	{ collection: 'requests', keys: { purgeAt: 1 }, name: 'retention', expireAfterSeconds: 0 },
	{ collection: 'orders', keys: { websiteId: 1, orderId: 1 }, name: 'website_order', unique: true },
	{ collection: 'orders', keys: { purgeAt: 1 }, name: 'retention', expireAfterSeconds: 0 },
	{ collection: 'photos', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{
		collection: 'photos',
		keys: { websiteId: 1, status: 1, staleAt: 1 },
		name: 'website_stale',
		partialFilterExpression: { status: 'pending' },
	},
	{
		collection: 'photos',
		keys: { purgeAt: 1 },
		name: 'pending_expiry',
		expireAfterSeconds: 0,
		partialFilterExpression: { status: 'pending' },
	},
	{ collection: 'questions', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'questions', keys: { websiteId: 1, itemId: 1, status: 1, askedAt: -1, id: -1 }, name: 'website_item_time' },
	{ collection: 'questions', keys: { websiteId: 1, status: 1, askedAt: -1, id: -1 }, name: 'website_status_time' },
	{ collection: 'questions', keys: { websiteId: 1, customerId: 1, askedAt: -1 }, name: 'website_customer_time' },
];

/**
 * Lazy, versioned migrations (app-kit runs them once per website under a lock).
 * @type {Array<{ version: number, name: string, up: (scope: any) => Promise<void> }>}
 */
export const MIGRATIONS = [
	{
		version: 1,
		name: 'review_defaults',
		up: async (scope) => {
			await scope
				.collection(COLLECTIONS.reviews)
				.updateMany({ websiteId: scope.websiteId, photoCount: { $exists: false } }, { $set: { photoCount: 0 } });
		},
	},
	{
		version: 2,
		name: 'photo_stale_dates',
		// pending slots written before the sweep: their `purgeAt` becomes `staleAt`, and the TTL moves back by the backstop
		up: async (scope) => {
			await scope
				.collection(COLLECTIONS.photos)
				.updateMany(
					{ websiteId: scope.websiteId, status: 'pending', staleAt: { $exists: false }, purgeAt: { $type: 'date' } },
					[{ $set: { staleAt: '$purgeAt', purgeAt: { $add: ['$purgeAt', STALE_BACKSTOP_MS] } } }],
				);
		},
	},
];

/** Fields the repositories never return. */
const INTERNAL = new Set(['_id', 'websiteId', 'merchantId', 'env', 'schemaVersion', 'createdAt', 'updatedAt', 'purgeAt']);

/**
 * @param {Record<string, any> | null} doc
 * @returns {any}
 */
const strip = (doc) => (doc ? Object.fromEntries(Object.entries(doc).filter(([key]) => !INTERNAL.has(key))) : null);

/** @param {unknown} error */
export const isDuplicateKey = (error) => /** @type {{ code?: number }} */ (error)?.code === 11000;

/**
 * Keyset filter on `(field, id)` descending: items strictly before the cursor `<value>|<id>`.
 * @param {string} field
 * @param {unknown} after
 * @returns {Record<string, unknown>}
 */
const beforePair = (field, after) => {
	const [value, id, extra] = typeof after === 'string' ? after.split('|') : [];
	return value && id && extra === undefined ? { $or: [{ [field]: { $lt: value } }, { [field]: value, id: { $lt: id } }] } : {};
};

/**
 * Query terms of one request status at an instant (see `requestStatusFilter`).
 * @param {string} status
 * @param {string} at
 * @returns {Array<Record<string, unknown>>}
 */
const termsOf = (status, at) => {
	if (status === 'open') return [{ status: 'open', expiresAt: { $gt: at } }];
	if (status === 'expired') return [{ status: 'expired' }, { status: 'open', expiresAt: { $lte: at } }];
	return [{ status }];
};

/**
 * Request status filter that sees through expiry: an `open` request past its `expiresAt` matches `expired`, not `open`,
 * even before the request job marks it.
 * @param {string[] | undefined} statuses
 * @param {string} at ISO instant
 * @returns {Record<string, unknown>}
 */
export const requestStatusFilter = (statuses, at) => {
	if (!statuses) return {};
	const terms = statuses.flatMap((status) => termsOf(status, at));
	return { $and: [{ $or: terms }] };
};

/**
 * @typedef {object} Scope app-kit website data scope (guarded collections)
 * @property {string} websiteId
 * @property {(name: string) => any} collection
 */

/**
 * @typedef {object} ReviewFilter
 * @property {string} [itemId]
 * @property {Array<'pending' | 'approved' | 'rejected'>} [statuses]
 * @property {number} [rating]
 * @property {boolean} [verified]
 * @property {boolean} [withPhotos]
 * @property {string} [customerId]
 */

/**
 * Repositories of one website.
 * @param {Scope} scope
 * @param {{ now?: () => number, stamp?: { merchantId?: string, env?: string } }} [options] `stamp` is added to upserted
 *   documents (app-kit stamps plain inserts itself)
 */
export const createRepositories = (scope, { now = Date.now, stamp = {} } = {}) => {
	const { websiteId } = scope;
	if (typeof websiteId !== 'string' || websiteId.length === 0) throw new TypeError('websiteId is required');
	const reviews = scope.collection(COLLECTIONS.reviews);
	const items = scope.collection(COLLECTIONS.items);
	const requests = scope.collection(COLLECTIONS.requests);
	const orders = scope.collection(COLLECTIONS.orders);
	const photos = scope.collection(COLLECTIONS.photos);
	const questions = scope.collection(COLLECTIONS.questions);
	/** @param {Record<string, unknown>} doc */
	const onInsert = (doc) => ({ ...stamp, createdAt: new Date(now()), schemaVersion: SCHEMA_VERSION, ...doc });
	const live = { websiteId, deletedAt: null };

	/** @param {ReviewFilter} filter */
	const reviewQuery = (filter) => ({
		...live,
		...(filter.itemId ? { itemId: filter.itemId } : {}),
		...(filter.statuses ? { status: filter.statuses.length === 1 ? filter.statuses[0] : { $in: filter.statuses } } : {}),
		...(filter.rating !== undefined ? { rating: filter.rating } : {}),
		...(filter.verified !== undefined ? { verifiedPurchase: filter.verified } : {}),
		...(filter.withPhotos === true ? { photoCount: { $gt: 0 } } : {}),
		...(filter.withPhotos === false ? { photoCount: 0 } : {}),
		...(filter.customerId ? { customerId: filter.customerId } : {}),
	});

	return Object.freeze({
		websiteId,
		reviews: Object.freeze({
			/**
			 * Store a new review. `created`; `replay` when this id exists (a retried request); `duplicate` when the
			 * one-review-per key or the external id is taken by another review.
			 * @param {Record<string, any> & { id: string }} doc
			 * @returns {Promise<'created' | 'replay' | 'duplicate'>}
			 */
			insert: async (doc) => {
				try {
					await reviews.insertOne({ ...doc });
					return 'created';
				} catch (error) {
					if (!isDuplicateKey(error)) throw error;
					return (await reviews.findOne({ websiteId, id: doc.id })) ? 'replay' : 'duplicate';
				}
			},
			/** @param {string} id */
			get: async (id) => strip(await reviews.findOne({ websiteId, id })),
			/** @param {string} key */
			byDedupeKey: async (key) => strip(await reviews.findOne({ websiteId, dedupeKey: key, deletedAt: null })),
			/**
			 * A page of reviews in a keyset order.
			 * @param {{ filter: ReviewFilter, sort: Record<string, 1 | -1>, after: Record<string, unknown> | null, fetchLimit: number }} page
			 */
			list: async ({ filter, sort, after, fetchLimit }) =>
				(await reviews.find({ ...reviewQuery(filter), ...(after ?? {}) }, { sort, limit: fetchLimit }).toArray()).map(strip),
			/** @param {ReviewFilter} filter */
			count: async (filter) => reviews.countDocuments(reviewQuery(filter)),
			/**
			 * Compare-and-set status change.
			 * @param {string} id
			 * @param {string[]} from
			 * @param {Record<string, unknown>} set
			 */
			transition: async (id, from, set) => {
				const result = await reviews.updateOne({ ...live, id, status: { $in: from } }, { $set: set });
				return (result.matchedCount ?? 0) > 0;
			},
			/**
			 * @param {string} id
			 * @param {Record<string, unknown>} set
			 */
			update: async (id, set) => {
				const result = await reviews.updateOne({ ...live, id }, { $set: set });
				return (result.matchedCount ?? 0) > 0;
			},
			/**
			 * Reviews by status (moderation queue counts).
			 * @returns {Promise<Record<'pending' | 'approved' | 'rejected', number>>}
			 */
			countByStatus: async () => {
				const rows = await reviews
					.aggregate([{ $match: live }, { $group: { _id: '$status', count: { $sum: 1 } } }])
					.toArray();
				const counts = { pending: 0, approved: 0, rejected: 0 };
				for (const row of rows) if (Object.hasOwn(counts, row._id)) counts[/** @type {'pending'} */ (row._id)] = row.count;
				return counts;
			},
			/**
			 * Reviews of a customer since an instant (rate limit).
			 * @param {string} customerId
			 * @param {string} since ISO
			 */
			countByCustomerSince: async (customerId, since) =>
				reviews.countDocuments({ websiteId, customerId, submittedAt: { $gte: since } }),
			/**
			 * The approved-review rollup of an item (exact, from the reviews themselves).
			 * @param {string} itemId
			 * @returns {Promise<import('../core/ratings.js').Rollup>}
			 */
			rollup: async (itemId) => {
				const match = { $match: { ...live, itemId, status: 'approved' } };
				const [ratings, attributes, extra] = await Promise.all([
					reviews
						.aggregate([match, { $group: { _id: { rating: '$rating', scale: '$scale' }, count: { $sum: 1 } } }])
						.toArray(),
					reviews
						.aggregate([
							match,
							{ $project: { pairs: { $objectToArray: { $ifNull: ['$attributes', {}] } } } },
							{ $unwind: '$pairs' },
							{ $group: { _id: '$pairs.k', count: { $sum: 1 }, sum: { $sum: '$pairs.v' } } },
						])
						.toArray(),
					reviews
						.aggregate([
							match,
							{
								$group: {
									_id: null,
									withPhotos: { $sum: { $cond: [{ $gt: ['$photoCount', 0] }, 1, 0] } },
									verified: { $sum: { $cond: ['$verifiedPurchase', 1, 0] } },
									last: { $max: '$submittedAt' },
								},
							},
						])
						.toArray(),
				]);
				return {
					ratings: ratings.map((/** @type {any} */ row) => ({
						rating: row._id.rating,
						scale: row._id.scale,
						count: row.count,
					})),
					attributes: Object.fromEntries(
						attributes.map((/** @type {any} */ row) => [row._id, { count: row.count, sum: row.sum }]),
					),
					withPhotos: extra[0]?.withPhotos ?? 0,
					verified: extra[0]?.verified ?? 0,
					lastReviewAt: extra[0]?.last ?? null,
				};
			},
			/**
			 * Per local day and status: counts and normalised rating sums (analytics).
			 * @param {{ from: string, to: string, timeZone: string }} range ISO bounds
			 * @returns {Promise<import('../core/analytics.js').DayRow[]>}
			 */
			dayRows: async ({ from, to, timeZone }) =>
				(
					await reviews
						.aggregate([
							{ $match: { ...live, submittedAt: { $gte: from, $lte: to }, source: { $ne: 'import' } } },
							{
								$group: {
									_id: {
										day: {
											$dateToString: {
												format: '%Y-%m-%d',
												date: { $dateFromString: { dateString: '$submittedAt' } },
												timezone: timeZone,
											},
										},
										status: '$status',
									},
									count: { $sum: 1 },
									normalisedSum: { $sum: { $divide: ['$rating', '$scale'] } },
									withPhotos: { $sum: { $cond: [{ $gt: ['$photoCount', 0] }, 1, 0] } },
									verified: { $sum: { $cond: ['$verifiedPurchase', 1, 0] } },
									replied: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$reply', null] }, null] }, 1, 0] } },
								},
							},
						])
						.toArray()
				).map((/** @type {any} */ row) => ({
					day: row._id.day,
					status: row._id.status,
					count: row.count,
					normalisedSum: row.normalisedSum,
					withPhotos: row.withPhotos,
					verified: row.verified,
					replied: row.replied,
				})),
			/**
			 * Average hours from submission to a decision, and from publication to a reply (analytics).
			 * @param {{ from: string, to: string }} range
			 * @returns {Promise<{ decisionHours: number | null, replyHours: number | null }>}
			 */
			timing: async ({ from, to }) => {
				const hours = (/** @type {string} */ a, /** @type {string} */ b) => ({
					$divide: [
						{ $subtract: [{ $dateFromString: { dateString: a } }, { $dateFromString: { dateString: b } }] },
						3_600_000,
					],
				});
				const [row] = await reviews
					.aggregate([
						{ $match: { ...live, submittedAt: { $gte: from, $lte: to }, source: { $ne: 'import' } } },
						{
							$group: {
								_id: null,
								decision: {
									$avg: {
										$cond: [
											{ $and: [{ $eq: ['$moderation.by', 'person'] }, { $ne: ['$moderation.decidedAt', null] }] },
											hours('$moderation.decidedAt', '$submittedAt'),
											null,
										],
									},
								},
								reply: {
									$avg: {
										$cond: [
											{ $and: [{ $ne: [{ $ifNull: ['$reply', null] }, null] }, { $ne: ['$publishedAt', null] }] },
											hours('$reply.at', '$publishedAt'),
											null,
										],
									},
								},
							},
						},
					])
					.toArray();
				const round = (/** @type {unknown} */ v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : null);
				return { decisionHours: round(row?.decision), replyHours: round(row?.reply) };
			},
			/**
			 * Items with the most approved reviews in a range (analytics).
			 * @param {{ from: string, to: string, limit: number }} range
			 */
			topItems: async ({ from, to, limit }) =>
				(
					await reviews
						.aggregate([
							{ $match: { ...live, status: 'approved', submittedAt: { $gte: from, $lte: to } } },
							{
								$group: {
									_id: '$itemId',
									count: { $sum: 1 },
									normalisedSum: { $sum: { $divide: ['$rating', '$scale'] } },
								},
							},
							{ $sort: { count: -1, _id: 1 } },
							{ $limit: limit },
						])
						.toArray()
				).map((/** @type {any} */ row) => ({ itemId: row._id, count: row.count, normalisedSum: row.normalisedSum })),
		}),
		items: Object.freeze({
			/** @param {string} itemId */
			get: async (itemId) => strip(await items.findOne({ websiteId, itemId })),
			/** @param {string[]} itemIds */
			getMany: async (itemIds) =>
				(await items.find({ websiteId, itemId: { $in: itemIds } }, { limit: itemIds.length }).toArray()).map(strip),
			/**
			 * Items with at least one approved review, by item id.
			 * @param {{ after: string | null, fetchLimit: number }} page
			 */
			listRated: async ({ after, fetchLimit }) =>
				(
					await items
						.find(
							{ websiteId, count: { $gt: 0 }, ...(after ? { itemId: { $gt: after } } : {}) },
							{ sort: { itemId: 1 }, limit: fetchLimit },
						)
						.toArray()
				).map(strip),
			/**
			 * Store an item's rollup (and its sortable count / average).
			 * @param {string} itemId
			 * @param {import('../core/ratings.js').Rollup} rollup
			 * @param {{ count: number, average: number }} summary
			 */
			saveRollup: async (itemId, rollup, summary) => {
				await items.updateOne(
					{ websiteId, itemId },
					{
						$set: { rollup, count: summary.count, average: summary.average },
						$setOnInsert: onInsert({ title: null, sku: null }),
					},
					{ upsert: true },
				);
			},
			/**
			 * Remember an item's display data (from order lines); never overwrites with empty values.
			 * @param {{ itemId: string, title: string | null, sku: string | null }} meta
			 */
			remember: async ({ itemId, title, sku }) => {
				/** @type {Record<string, unknown>} */
				const set = {};
				if (title) set.title = title;
				if (sku) set.sku = sku;
				await items.updateOne(
					{ websiteId, itemId },
					{
						...(Object.keys(set).length > 0 ? { $set: set } : {}),
						$setOnInsert: onInsert({
							count: 0,
							average: 0,
							rollup: null,
							...(title ? {} : { title: null }),
							...(sku ? {} : { sku: null }),
						}),
					},
					{ upsert: true },
				);
			},
		}),
		requests: Object.freeze({
			/**
			 * Store a request (one per order): true when this call created it.
			 * @param {import('../core/requests.js').ReviewRequest & { purgeAt: Date }} doc
			 */
			insert: async (doc) => {
				const result = await requests.updateOne(
					{ websiteId, orderId: doc.orderId },
					{ $setOnInsert: onInsert({ ...doc }) },
					{ upsert: true },
				);
				return (result.upsertedCount ?? 0) > 0;
			},
			/** @param {string} id */
			get: async (id) => strip(await requests.findOne({ websiteId, id })),
			/** @param {string} orderId */
			byOrder: async (orderId) => strip(await requests.findOne({ websiteId, orderId })),
			/**
			 * Requests of a customer (any of their keys), newest first.
			 * @param {string[]} keys
			 * @param {{ statuses?: string[], itemId?: string, after?: unknown, fetchLimit: number }} page
			 */
			forCustomer: async (keys, { statuses, itemId, after = null, fetchLimit }) =>
				(
					await requests
						.find(
							{
								websiteId,
								customerKeys: { $in: keys },
								...requestStatusFilter(statuses, new Date(now()).toISOString()),
								...(itemId ? { 'items.itemId': itemId } : {}),
								...beforePair('completedAt', after),
							},
							{ sort: { completedAt: -1, id: -1 }, limit: fetchLimit },
						)
						.toArray()
				).map(strip),
			/**
			 * Requests by status, newest first.
			 * @param {{ statuses?: string[], after?: unknown, fetchLimit: number }} page
			 */
			list: async ({ statuses, after = null, fetchLimit }) =>
				(
					await requests
						.find(
							{
								websiteId,
								...requestStatusFilter(statuses, new Date(now()).toISOString()),
								...beforePair('completedAt', after),
							},
							{ sort: { completedAt: -1, id: -1 }, limit: fetchLimit },
						)
						.toArray()
				).map(strip),
			/**
			 * Record a review of an item (once): then complete the request when every item is reviewed.
			 * @param {string} id
			 * @param {string} itemId
			 * @param {string} reviewId
			 */
			markReviewed: async (id, itemId, reviewId) => {
				const result = await requests.updateOne(
					{ websiteId, id, items: { $elemMatch: { itemId, reviewId: null } } },
					{ $set: { 'items.$.reviewId': reviewId } },
				);
				await requests.updateOne(
					{ websiteId, id, status: 'open', items: { $not: { $elemMatch: { reviewId: null } } } },
					{ $set: { status: 'completed', 'delivery.state': 'done', 'delivery.nextAt': null } },
				);
				return (result.matchedCount ?? 0) > 0;
			},
			/**
			 * Open requests whose next delivery is due.
			 * @param {string} at ISO
			 * @param {number} limit
			 */
			due: async (at, limit) =>
				(
					await requests
						.find({ websiteId, status: 'open', 'delivery.nextAt': { $lte: at } }, { sort: { 'delivery.nextAt': 1 }, limit })
						.toArray()
				).map(strip),
			/**
			 * Claim a due delivery (compare-and-set on the observed `nextAt`) by pushing it out by a lease.
			 * @param {string} id
			 * @param {string} observed
			 * @param {string} leaseUntil
			 */
			claim: async (id, observed, leaseUntil) => {
				const result = await requests.updateOne(
					{ websiteId, id, status: 'open', 'delivery.nextAt': observed },
					{ $set: { 'delivery.nextAt': leaseUntil } },
				);
				return (result.matchedCount ?? 0) > 0;
			},
			/**
			 * @param {string} id
			 * @param {Record<string, unknown>} set
			 * @param {string[]} [from] statuses the request must be in
			 */
			update: async (id, set, from) => {
				const result = await requests.updateOne({ websiteId, id, ...(from ? { status: { $in: from } } : {}) }, { $set: set });
				return (result.matchedCount ?? 0) > 0;
			},
			/**
			 * Requests by status and delivery state (request flow status).
			 */
			stats: async () => {
				const rows = await requests
					.aggregate([
						{ $match: { websiteId } },
						{ $group: { _id: { status: '$status', state: '$delivery.state' }, count: { $sum: 1 } } },
					])
					.toArray();
				return rows.map((/** @type {any} */ row) => ({ status: row._id.status, state: row._id.state, count: row.count }));
			},
			/**
			 * Next due delivery instant (ISO) of open requests.
			 */
			nextDue: async () => {
				const [doc] = await requests
					.find(
						{ websiteId, status: 'open', 'delivery.nextAt': { $ne: null } },
						{ sort: { 'delivery.nextAt': 1 }, limit: 1, projection: { delivery: 1 } },
					)
					.toArray();
				return doc?.delivery?.nextAt ?? null;
			},
			/**
			 * Requests created in a range and how many got at least one review (analytics).
			 * @param {{ from: string, to: string }} range
			 */
			conversion: async ({ from, to }) => {
				const [row] = await requests
					.aggregate([
						{ $match: { websiteId, completedAt: { $gte: from, $lte: to } } },
						{
							$group: {
								_id: null,
								created: { $sum: 1 },
								converted: {
									$sum: {
										$cond: [
											{
												$gt: [
													{ $size: { $filter: { input: '$items', cond: { $ne: ['$$this.reviewId', null] } } } },
													0,
												],
											},
											1,
											0,
										],
									},
								},
							},
						},
					])
					.toArray();
				return { created: row?.created ?? 0, converted: row?.converted ?? 0 };
			},
		}),
		orders: Object.freeze({
			/** @param {string} orderId */
			get: async (orderId) => strip(await orders.findOne({ websiteId, orderId })),
			/**
			 * @param {import('../core/orders.js').OrderFacts} facts
			 * @param {Date} purgeAt
			 */
			save: async (facts, purgeAt) => {
				await orders.updateOne(
					{ websiteId, orderId: facts.orderId },
					{ $set: { ...facts, purgeAt }, $setOnInsert: onInsert({}) },
					{ upsert: true },
				);
			},
		}),
		photos: Object.freeze({
			/** @param {Record<string, unknown> & { id: string }} doc */
			insert: async (doc) => {
				await photos.insertOne({ ...doc });
			},
			/** @param {string} id */
			get: async (id) => strip(await photos.findOne({ websiteId, id })),
			/**
			 * Attach pending photos to a review (compare-and-set per photo).
			 * @param {string[]} ids
			 * @param {string} reviewId
			 */
			attach: async (ids, reviewId) => {
				const result = await photos.updateMany(
					{ websiteId, id: { $in: ids }, status: 'pending' },
					{ $set: { status: 'attached', reviewId }, $unset: { purgeAt: '', staleAt: '' } },
				);
				return result.modifiedCount ?? 0;
			},
			/**
			 * Sweep pending slots past their `staleAt`: delete the object from the merchant's bucket when it was uploaded,
			 * then the record (app-kit `sweepStaleUploads`, bounded and idempotent).
			 * @param {{ storage: () => Promise<any>, olderThanMs?: number, limit?: number }} input
			 */
			sweepStale: ({ storage, olderThanMs = 0, limit }) =>
				sweepStaleUploads({
					collection: photos,
					websiteId,
					storage,
					now,
					olderThanMs,
					filter: { status: 'pending' },
					...(limit === undefined ? {} : { limit }),
				}),
		}),
		questions: Object.freeze({
			/** @param {Record<string, unknown> & { id: string }} doc */
			insert: async (doc) => {
				const result = await questions.updateOne(
					{ websiteId, id: doc.id },
					{ $setOnInsert: onInsert({ ...doc }) },
					{ upsert: true },
				);
				return (result.upsertedCount ?? 0) > 0;
			},
			/** @param {string} id */
			get: async (id) => strip(await questions.findOne({ websiteId, id })),
			/**
			 * Newest first.
			 * @param {{ itemId?: string, statuses?: string[], after?: unknown, fetchLimit: number }} page
			 */
			list: async ({ itemId, statuses, after = null, fetchLimit }) =>
				(
					await questions
						.find(
							{
								websiteId,
								...(itemId ? { itemId } : {}),
								...(statuses ? { status: { $in: statuses } } : {}),
								...beforePair('askedAt', after),
							},
							{ sort: { askedAt: -1, id: -1 }, limit: fetchLimit },
						)
						.toArray()
				).map(strip),
			/**
			 * @param {string} id
			 * @param {string[]} from
			 * @param {Record<string, unknown>} set
			 */
			transition: async (id, from, set) => {
				const result = await questions.updateOne({ websiteId, id, status: { $in: from } }, { $set: set });
				return (result.matchedCount ?? 0) > 0;
			},
			/**
			 * Append an answer once (by answer id).
			 * @param {string} id
			 * @param {Record<string, unknown> & { id: string, status: string, answeredAt: string }} answer
			 */
			addAnswer: async (id, answer) => {
				const result = await questions.updateOne(
					{ websiteId, id, 'answers.id': { $ne: answer.id } },
					{
						$push: { answers: answer },
						...(answer.status === 'published' ? { $set: { answeredAt: answer.answeredAt } } : {}),
					},
				);
				return (result.matchedCount ?? 0) > 0;
			},
			/**
			 * Publish or reject a pending answer.
			 * @param {string} id
			 * @param {string} answerId
			 * @param {'published' | 'rejected'} status
			 * @param {string} at ISO
			 */
			decideAnswer: async (id, answerId, status, at) => {
				const result = await questions.updateOne(
					{ websiteId, id, answers: { $elemMatch: { id: answerId, status: 'pending' } } },
					{ $set: { 'answers.$.status': status, ...(status === 'published' ? { answeredAt: at } : {}) } },
				);
				return (result.matchedCount ?? 0) > 0;
			},
			/**
			 * Questions of a customer since an instant (rate limit).
			 * @param {string} customerId
			 * @param {string} since ISO
			 */
			countByCustomerSince: async (customerId, since) =>
				questions.countDocuments({ websiteId, customerId, askedAt: { $gte: since } }),
			/** Questions waiting for approval or an answer. */
			counts: async () => {
				const [pending, unanswered] = await Promise.all([
					questions.countDocuments({ websiteId, status: 'pending' }),
					questions.countDocuments({ websiteId, status: 'published', answeredAt: null }),
				]);
				return { pending, unanswered };
			},
		}),
	});
};

/** @typedef {ReturnType<typeof createRepositories>} Repositories */

/**
 * Repositories for a website through app-kit (indexes and migrations are applied by app-kit on first use).
 * @param {{ data: { forWebsite: (websiteId: string, stamp?: { merchantId?: string, env?: string }) => Promise<Scope> } }} product
 * @param {{ now?: () => number }} [options]
 * @returns {(websiteId: string, stamp?: { merchantId?: string, env?: string }) => Promise<Repositories>}
 */
export const repositoriesFor =
	(product, options = {}) =>
	async (websiteId, stamp = {}) =>
		createRepositories(await product.data.forWebsite(websiteId, stamp), { ...options, stamp });
