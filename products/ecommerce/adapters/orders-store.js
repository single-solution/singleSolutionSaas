/**
 * Checkout's queries in the merchant database: the catalog records a cart is priced with, the shopper's orders, the
 * waiting orders whose window ended, payment rechecks, customer records, booked slots, licence keys and download
 * counts. Stock, offer uses, points and slots are changed only by the ledger (`adapters/ledger.js`).
 * @module
 */
import { COLLECTIONS } from '../core/model.js';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').CustomerRecord} CustomerRecord */

/** Merchant database indexes of checkout. @type {import('@ss/app-kit').IndexDefinition[]} */
export const INDEXES = [
	{
		collection: COLLECTIONS.orders,
		keys: { websiteId: 1, 'customer.userId': 1, placedAt: -1, id: -1 },
		name: 'by_customer',
	},
	{ collection: COLLECTIONS.orders, keys: { websiteId: 1, role: 1, holdUntil: 1 }, name: 'by_role_hold' },
	{ collection: COLLECTIONS.orders, keys: { websiteId: 1, 'payment.paymentId': 1 }, name: 'by_payment' },
	{ collection: COLLECTIONS.licences, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: COLLECTIONS.licences, keys: { websiteId: 1, productId: 1, key: 1 }, name: 'one_key', unique: true },
	{ collection: COLLECTIONS.licences, keys: { websiteId: 1, productId: 1, status: 1 }, name: 'by_status' },
	{ collection: COLLECTIONS.licences, keys: { websiteId: 1, orderId: 1 }, name: 'by_order' },
];

const NO_ID = Object.freeze({ projection: { _id: 0 } });

/** Waiting orders handled per sweep, and waiting payments rechecked per use. */
const SWEEP_BATCH = 20;
const RECHECK_BATCH = 10;

/**
 * @param {WebsiteData} data
 */
export const createOrdersStore = (data) => {
	const { websiteId } = data;
	const orders = data.collection(COLLECTIONS.orders);

	return Object.freeze({
		// ---------------------------------------------------------------------------------------------- catalog
		/** @param {string[]} ids @returns {Promise<Map<string, ProductRecord>>} */
		products: async (ids) => {
			const found = /** @type {ProductRecord[]} */ (
				await data
					.collection(COLLECTIONS.products)
					.find({ websiteId, id: { $in: [...new Set(ids)] } }, NO_ID)
					.toArray()
			);
			return new Map(found.map((product) => [product.id, product]));
		},
		/** @param {string} id @returns {Promise<ProductRecord | null>} */
		product: async (id) =>
			/** @type {ProductRecord | null} */ (await data.collection(COLLECTIONS.products).findOne({ websiteId, id }, NO_ID)),
		/**
		 * The ancestors of categories (`path`), by category id.
		 * @param {string[]} ids @returns {Promise<Map<string, string[]>>}
		 */
		categoryPaths: async (ids) => {
			if (ids.length === 0) return new Map();
			const found = await data
				.collection(COLLECTIONS.categories)
				.find({ websiteId, id: { $in: [...new Set(ids)] } }, { projection: { _id: 0, id: 1, path: 1 } })
				.toArray();
			return new Map(found.map((category) => [String(category.id), Array.isArray(category.path) ? category.path : []]));
		},
		/** Stock locations, in their order. @returns {Promise<import('../core/model.js').LocationRecord[]>} */
		locations: async () =>
			/** @type {any[]} */ (
				await data.collection(COLLECTIONS.locations).find({ websiteId }, NO_ID).sort({ sort: 1, id: 1 }).limit(200).toArray()
			),
		/** Available licence keys per product. @param {string[]} productIds @returns {Promise<Map<string, number>>} */
		availableLicences: async (productIds) => {
			/** @type {Map<string, number>} */
			const counts = new Map();
			for (const productId of new Set(productIds))
				counts.set(
					productId,
					await data.collection(COLLECTIONS.licences).countDocuments({ websiteId, productId, status: 'available' }),
				);
			return counts;
		},
		/**
		 * Booked slot starts of products between two instants: `<productId>|<start ms>`.
		 * @param {string[]} productIds @param {number} from @param {number} to
		 */
		booked: async (productIds, from, to) => {
			if (productIds.length === 0) return new Set();
			const found = await data
				.collection(COLLECTIONS.slots)
				.find(
					{ websiteId, productId: { $in: [...new Set(productIds)] }, start: { $gte: new Date(from), $lt: new Date(to) } },
					{ projection: { _id: 0, productId: 1, start: 1 } },
				)
				.toArray();
			return new Set(found.map((slot) => `${slot.productId}|${new Date(slot.start).getTime()}`));
		},

		// ---------------------------------------------------------------------------------------------- customers
		/** @param {string} userId @returns {Promise<CustomerRecord | null>} */
		customer: async (userId) =>
			/** @type {CustomerRecord | null} */ (
				await data.collection(COLLECTIONS.customers).findOne({ websiteId, userId }, NO_ID)
			),
		/**
		 * Keep the customer's latest details and count the order.
		 * @param {{ id: string, name: string, email: string, phone: string }} shopper
		 */
		recordCustomer: async (shopper) => {
			await data.collection(COLLECTIONS.customers).updateOne(
				{ websiteId, userId: shopper.id },
				{
					$set: { name: shopper.name, email: shopper.email, phone: shopper.phone },
					$inc: { orderCount: 1 },
					$setOnInsert: { userId: shopper.id, blocked: false, blockedReason: '', rtoCount: 0, note: '' },
				},
				{ upsert: true },
			);
		},
		/** Uses of a coupon by a customer. @param {string} couponId @param {string} userId */
		couponUses: (couponId, userId) => data.collection(COLLECTIONS.couponUses).countDocuments({ websiteId, couponId, userId }),

		// -------------------------------------------------------------------------------------------------- orders
		/** @param {string} id @returns {Promise<OrderRecord | null>} */
		order: async (id) => /** @type {OrderRecord | null} */ (await orders.findOne({ websiteId, id }, NO_ID)),
		/** @param {string} userId @param {string} id @returns {Promise<OrderRecord | null>} */
		customerOrder: async (userId, id) =>
			/** @type {OrderRecord | null} */ (await orders.findOne({ websiteId, id, 'customer.userId': userId }, NO_ID)),
		/**
		 * A customer's orders, newest first (keyset after `[placedAt ISO, id]`).
		 * @param {string} userId @param {{ after: unknown, limit: number }} page
		 * @returns {Promise<OrderRecord[]>}
		 */
		customerOrders: async (userId, { after, limit }) => {
			const [time, id] = Array.isArray(after) ? after : [];
			const keyset =
				typeof time === 'string' && typeof id === 'string'
					? { $or: [{ placedAt: { $lt: new Date(time) } }, { placedAt: new Date(time), id: { $lt: id } }] }
					: {};
			return /** @type {OrderRecord[]} */ (
				await orders
					.find({ websiteId, 'customer.userId': userId, ...keyset }, NO_ID)
					.sort({ placedAt: -1, id: -1 })
					.limit(limit)
					.toArray()
			);
		},
		/** Orders of a customer still waiting (payment or confirmation). @param {string} userId @param {ReadonlyArray<string>} roles */
		countWaiting: (userId, roles) => orders.countDocuments({ websiteId, 'customer.userId': userId, role: { $in: [...roles] } }),
		/**
		 * Waiting orders whose window ended, oldest first.
		 * @param {ReadonlyArray<string>} roles @param {number} now
		 * @returns {Promise<OrderRecord[]>}
		 */
		expired: async (roles, now) =>
			/** @type {OrderRecord[]} */ (
				await orders
					.find({ websiteId, role: { $in: [...roles] }, holdUntil: { $lte: new Date(now) } }, NO_ID)
					.sort({ holdUntil: 1 })
					.limit(SWEEP_BATCH)
					.toArray()
			),
		/**
		 * Orders awaiting a Payments payment that was not checked in the last `everyMs`, least recently checked first.
		 * @param {number} now @param {number} everyMs
		 * @returns {Promise<OrderRecord[]>}
		 */
		toRecheck: async (now, everyMs) =>
			/** @type {OrderRecord[]} */ (
				await orders
					.find(
						{
							websiteId,
							role: 'awaiting_payment',
							'payment.state': 'pending',
							'payment.paymentId': { $ne: null },
							$or: [{ 'payment.checkedAt': null }, { 'payment.checkedAt': { $lte: new Date(now - everyMs) } }],
						},
						NO_ID,
					)
					.sort({ 'payment.checkedAt': 1 })
					.limit(RECHECK_BATCH)
					.toArray()
			),
		/**
		 * Change an order's fields, only while it is in a status (`status`), and return it.
		 * @param {OrderRecord} order @param {Record<string, unknown>} set
		 * @param {{ push?: Record<string, unknown>, where?: Record<string, unknown>, session?: import('mongodb').ClientSession }} [options]
		 *   `where`: more conditions the order must meet
		 * @returns {Promise<OrderRecord | null>} null when the order moved meanwhile
		 */
		change: async (order, set, { push, where = {}, session } = {}) =>
			/** @type {OrderRecord | null} */ (
				await orders.findOneAndUpdate(
					{ ...where, websiteId, id: order.id, status: order.status },
					{ $set: set, ...(push ? { $push: push } : {}) },
					{ returnDocument: 'after', projection: { _id: 0 }, ...(session ? { session } : {}) },
				)
			),
		/**
		 * Count a download of an order line, only while it is under `limit` (0 = no limit).
		 * @param {string} orderId @param {string} lineId @param {number} limit
		 */
		countDownload: async (orderId, lineId, limit) => {
			const under = limit > 0 ? { $or: [{ downloads: { $exists: false } }, { downloads: { $lt: limit } }] } : {};
			const result = await orders.updateOne(
				{ websiteId, id: orderId, lines: { $elemMatch: { id: lineId, ...under } } },
				{ $inc: { 'lines.$.downloads': 1 } },
			);
			return result.modifiedCount === 1;
		},

		// ------------------------------------------------------------------------------------------------ licences
		/**
		 * Add licence keys to a product (keys it already has are skipped).
		 * @param {string} productId @param {Array<{ id: string, key: string }>} keys
		 * @returns {Promise<number>} how many were added
		 */
		addLicences: async (productId, keys) => {
			if (keys.length === 0) return 0;
			try {
				const result = await data.collection(COLLECTIONS.licences).insertMany(
					keys.map(({ id, key }) => ({ id, productId, key, status: 'available', orderId: null, lineId: null })),
					{ ordered: false },
				);
				return result.insertedCount;
			} catch (error) {
				const inserted = /** @type {any} */ (error)?.result?.insertedCount ?? /** @type {any} */ (error)?.insertedCount;
				if (/** @type {any} */ (error)?.code === 11000 || Array.isArray(/** @type {any} */ (error)?.writeErrors))
					return Number(inserted ?? 0);
				throw error;
			}
		},
		/** @param {string} productId */
		countLicences: (productId) =>
			data.collection(COLLECTIONS.licences).countDocuments({ websiteId, productId, status: 'available' }),
		/**
		 * Give an order line up to `count` available licence keys of a product (each to one line only).
		 * @param {{ productId: string, orderId: string, lineId: string, count: number }} give
		 * @returns {Promise<string[]>} the licence ids given
		 */
		assignLicences: async ({ productId, orderId, lineId, count }) => {
			/** @type {string[]} */
			const ids = [];
			for (let n = 0; n < count; n += 1) {
				const taken = await data
					.collection(COLLECTIONS.licences)
					.findOneAndUpdate(
						{ websiteId, productId, status: 'available' },
						{ $set: { status: 'assigned', orderId, lineId } },
						{ returnDocument: 'after', projection: { _id: 0, id: 1 } },
					);
				if (!taken) break;
				ids.push(String(taken.id));
			}
			return ids;
		},
		/** Record licences given to an order line. @param {string} orderId @param {string} lineId @param {string[]} ids */
		addLineLicences: async (orderId, lineId, ids) => {
			if (ids.length === 0) return;
			await orders.updateOne(
				{ websiteId, id: orderId, 'lines.id': lineId },
				{ $push: { 'lines.$.licences': { $each: ids } } },
			);
		},
		/**
		 * Keep a product's digital files.
		 * @param {string} productId @param {import('../core/model.js').ProductRecord['digital']} digital
		 */
		setDigital: (productId, digital) =>
			data.collection(COLLECTIONS.products).updateOne({ websiteId, id: productId }, { $set: { digital } }),
		/** The keys of licences. @param {string[]} ids @returns {Promise<Map<string, string>>} id → key */
		licenceKeys: async (ids) => {
			if (ids.length === 0) return new Map();
			const found = await data
				.collection(COLLECTIONS.licences)
				.find({ websiteId, id: { $in: ids } }, { projection: { _id: 0, id: 1, key: 1 } })
				.toArray();
			return new Map(found.map((licence) => [String(licence.id), String(licence.key)]));
		},
	});
};

/** @typedef {ReturnType<typeof createOrdersStore>} OrdersStore */
