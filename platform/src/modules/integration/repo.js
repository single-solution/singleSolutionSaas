/**
 * Data access of the `integration` module (its own collections only). No function here accepts or stores an event
 * payload except the sealed DLQ copy.
 * @module
 */

/** @typedef {import('../../infra/db.js').MutableOps} MutableOps */

/** @param {unknown} error */
const isDuplicateKey = (error) => typeof error === 'object' && error !== null && /** @type {any} */ (error).code === 11000;

/**
 * @typedef {object} EventRecord
 * @property {string} _id
 * @property {string} eventId
 * @property {string} type
 * @property {string | null} websiteId null for platform-scoped events (`scope: 'platform'`, e.g. manifest.accepted@1)
 * @property {string | null} merchantId
 * @property {string} env
 * @property {'website' | 'product' | 'portal'} source
 * @property {string | null} publisherAppId
 * @property {string} idempotencyKey
 * @property {Date} receivedAt
 * @property {'pending' | 'done'} fanout
 * @property {{ total: number, delivered: number, dead: number }} deliveries
 */

/**
 * @param {{ events: MutableOps, deliveries: MutableOps, deadLetters: MutableOps, now: () => number }} options
 */
export const createIntegrationRepo = ({ events, deliveries, deadLetters, now }) => {
	/** @param {string} eventRecordId @param {Record<string, number>} inc */
	const bump = (eventRecordId, inc) =>
		events.updateOne(
			{ _id: eventRecordId },
			{ $inc: Object.fromEntries(Object.entries(inc).map(([k, v]) => [`deliveries.${k}`, v])) },
		);

	return Object.freeze({
		/**
		 * Insert routing metadata; `null` when `(websiteId, idempotencyKey)` already exists.
		 * @param {EventRecord} record
		 * @returns {Promise<EventRecord | null>}
		 */
		insertEvent: async (record) => {
			try {
				await events.insertOne(record);
				return record;
			} catch (error) {
				if (isDuplicateKey(error)) return null;
				throw error;
			}
		},
		/**
		 * @param {string | null} websiteId
		 * @param {string} idempotencyKey
		 * @returns {Promise<EventRecord | null>}
		 */
		eventByKey: async (websiteId, idempotencyKey) =>
			/** @type {EventRecord | null} */ (await events.findOne({ websiteId, idempotencyKey })),
		/**
		 * @param {string} eventRecordId
		 * @param {number} total
		 */
		fanoutDone: (eventRecordId, total) =>
			events.updateOne({ _id: eventRecordId }, { $set: { fanout: 'done', 'deliveries.total': total } }),
		bump,

		/**
		 * Create (or find) the delivery record of (website, event, app).
		 * @param {{ _id: string, eventRecordId: string, eventId: string, type: string, kind: 'event' | 'control',
		 *   websiteId: string | null, merchantId: string | null, appId: string }} input
		 * @returns {Promise<{ deliveryId: string, inserted: boolean, status: string }>}
		 */
		ensureDelivery: async (input) => {
			const filter = { websiteId: input.websiteId, eventId: input.eventId, appId: input.appId };
			const set = { ...input, status: 'pending', attempts: 0, replays: 0, lastErrorCode: null };
			for (let attempt = 0; ; attempt += 1) {
				try {
					const doc = await deliveries.findOneAndUpdate(
						filter,
						{ $setOnInsert: set },
						{ upsert: true, returnDocument: 'after', includeResultMetadata: false },
					);
					const found = /** @type {Record<string, any>} */ (doc);
					return { deliveryId: String(found._id), inserted: found._id === input._id, status: found.status };
				} catch (error) {
					if (!isDuplicateKey(error) || attempt > 0) throw error;
				}
			}
		},
		/** @param {string} deliveryId */
		getDelivery: (deliveryId) => deliveries.findOne({ _id: deliveryId }),
		/**
		 * @param {string} deliveryId
		 * @param {Record<string, unknown>} update update operators
		 * @param {Record<string, unknown>} [where] extra conditions
		 * @returns {Promise<boolean>} whether the record changed
		 */
		updateDelivery: async (deliveryId, update, where = {}) =>
			(await deliveries.updateOne({ _id: deliveryId, ...where }, update)).modifiedCount === 1,
		/**
		 * @param {Record<string, unknown>} filter
		 * @param {{ after: { at: Date, id: string } | null, limit: number }} page
		 */
		listDeliveries: (filter, { after, limit }) =>
			deliveries
				.find({
					...filter,
					...(after ? { $or: [{ createdAt: { $lt: after.at } }, { createdAt: after.at, _id: { $lt: after.id } }] } : {}),
				})
				.sort({ createdAt: -1, _id: -1 })
				.limit(limit)
				.toArray(),
		/** @param {Record<string, unknown>} match */
		countByStatus: (match) =>
			deliveries.aggregate([{ $match: match }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),

		/**
		 * @param {{ _id: string, websiteId: string | null, merchantId: string | null, appId: string, eventId: string, type: string,
		 *   sealed: string, attempts: number, lastErrorCode: string, expireAt: Date }} entry
		 */
		putDeadLetter: async (entry) => {
			const t = new Date(now());
			await deadLetters.replaceOne({ _id: entry._id }, { ...entry, deadAt: t, createdAt: t }, { upsert: true });
		},
		/** @param {string} deliveryId */
		getDeadLetter: (deliveryId) => deadLetters.findOne({ _id: deliveryId }),
		/** @param {string} deliveryId */
		deleteDeadLetter: (deliveryId) => deadLetters.deleteOne({ _id: deliveryId }),
		/**
		 * @param {Record<string, unknown>} filter
		 * @param {{ after: { at: Date, id: string } | null, limit: number }} page
		 */
		listDeadLetters: (filter, { after, limit }) =>
			deadLetters
				.find(
					{
						...filter,
						...(after ? { $or: [{ deadAt: { $lt: after.at } }, { deadAt: after.at, _id: { $lt: after.id } }] } : {}),
					},
					{ projection: { sealed: 0 } },
				)
				.sort({ deadAt: -1, _id: -1 })
				.limit(limit)
				.toArray(),
		/** @param {Record<string, unknown>} filter */
		countDeadLetters: (filter) => deadLetters.countDocuments(filter),
	});
};
/** @typedef {ReturnType<typeof createIntegrationRepo>} IntegrationRepo */
