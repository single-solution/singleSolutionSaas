/**
 * Checkout's queries in the merchant database: the catalog records a cart is priced with, the shopper's orders, the
 * waiting orders whose window ended, payment rechecks, customer records, booked slots, license keys and download
 * counts. Stock, offer uses, points and slots are changed only by the ledger (`adapters/ledger.js`).
 * @module
 */
import { createId } from '@ss/contracts';
import { phoneDigitsOf } from '../core/guests.js';
import { COLLECTIONS, ID_PREFIX, NO_ID } from '../core/model.js';
import { VIA_PAYMENTS } from '../core/payment-methods.js';

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
	{
		collection: COLLECTIONS.orders,
		keys: { websiteId: 1, 'customer.customerId': 1, placedAt: -1 },
		name: 'by_customer_record',
	},
	{ collection: COLLECTIONS.orders, keys: { websiteId: 1, number: 1, id: 1 }, name: 'by_number_id' },
	{ collection: COLLECTIONS.orders, keys: { websiteId: 1, role: 1, holdUntil: 1 }, name: 'by_role_hold' },
	{
		collection: COLLECTIONS.customers,
		keys: { websiteId: 1, id: 1 },
		name: 'by_id',
		unique: true,
		partialFilterExpression: { id: { $type: 'string' } },
	},
	// one record per guest: by `p:<phone>` or `e:<email>` (dynamic model §5)
	{
		collection: COLLECTIONS.customers,
		keys: { websiteId: 1, guestKey: 1 },
		name: 'one_guest_per_key',
		unique: true,
		partialFilterExpression: { guestKey: { $type: 'string' } },
	},
	{ collection: COLLECTIONS.orders, keys: { websiteId: 1, 'payment.paymentId': 1 }, name: 'by_payment' },
	// orders per status and role (the order flow's save guard counts them from the index alone, one $group; restatus)
	// and refunds a transition left pending (tried again on use)
	{ collection: COLLECTIONS.orders, keys: { websiteId: 1, status: 1, role: 1 }, name: 'by_status_role' },
	{
		collection: COLLECTIONS.orders,
		keys: { websiteId: 1, 'effects.state': 1 },
		name: 'by_pending_effect',
		partialFilterExpression: { 'effects.state': 'pending' },
	},
	// cancels Payments could not take yet, and canceled orders watched for money paid after (K-13)
	{
		collection: COLLECTIONS.orders,
		keys: { websiteId: 1, 'payment.voidPendingAt': 1 },
		name: 'by_void_pending',
		partialFilterExpression: { 'payment.voidPendingAt': { $type: 'date' } },
	},
	{ collection: COLLECTIONS.orders, keys: { websiteId: 1, role: 1, 'payment.voidedAt': 1 }, name: 'by_role_voided' },
	{ collection: COLLECTIONS.licenses, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: COLLECTIONS.licenses, keys: { websiteId: 1, productId: 1, key: 1 }, name: 'one_key', unique: true },
	{ collection: COLLECTIONS.licenses, keys: { websiteId: 1, productId: 1, status: 1 }, name: 'by_status' },
	{ collection: COLLECTIONS.licenses, keys: { websiteId: 1, orderId: 1 }, name: 'by_order' },
];

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
		/** Available license keys per product. @param {string[]} productIds @returns {Promise<Map<string, number>>} */
		availableLicenses: async (productIds) => {
			/** @type {Map<string, number>} */
			const counts = new Map();
			for (const productId of new Set(productIds))
				counts.set(
					productId,
					await data.collection(COLLECTIONS.licenses).countDocuments({ websiteId, productId, status: 'available' }),
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
		/** A customer record by its id. @param {string} id @returns {Promise<CustomerRecord | null>} */
		customerById: async (id) =>
			/** @type {CustomerRecord | null} */ (await data.collection(COLLECTIONS.customers).findOne({ websiteId, id }, NO_ID)),
		/**
		 * A guest's record by its key (`p:<E.164>` or `e:<email>`, E21, dynamic model §5).
		 * @param {string} guestKey @returns {Promise<CustomerRecord | null>}
		 */
		guestCustomer: async (guestKey) =>
			guestKey
				? /** @type {CustomerRecord | null} */ (
						await data.collection(COLLECTIONS.customers).findOne({ websiteId, guestKey }, NO_ID)
					)
				: null,
		/**
		 * The member's record a guest key names: the member with that normalized phone or email address (a returning
		 * customer ordering as a guest, K-6), the latest to order first.
		 * @param {string} guestKey @returns {Promise<CustomerRecord | null>}
		 */
		memberByKey: async (guestKey) => {
			const contact = guestKey.startsWith('p:')
				? { phone: guestKey.slice(2) }
				: guestKey.startsWith('e:')
					? { email: guestKey.slice(2) }
					: null;
			if (!contact) return null;
			return /** @type {CustomerRecord | null} */ (
				await data
					.collection(COLLECTIONS.customers)
					.findOne({ websiteId, ...contact, userId: { $type: 'string', $ne: '' } }, { ...NO_ID, sort: { lastOrderAt: -1 } })
			);
		},
		/**
		 * The customer record of a member or a guest, made when missing (its `cus_` id is kept for good, and when it was
		 * made, CU-4), with their latest details (`refresh: false`: only when it is made). A member is found by user id, a
		 * guest by its key (E21, `guestKey`).
		 * @param {{ userId: string | null, name: string, email: string, phone: string, guestKey?: string }} who
		 * @param {{ at: Date, refresh?: boolean }} when `at`: the record's `createdAt` when it is made
		 * @returns {Promise<CustomerRecord>}
		 */
		ensureCustomer: async (who, { at, refresh = true }) => {
			const customers = data.collection(COLLECTIONS.customers);
			if (!who.userId && !who.guestKey) throw new Error('A guest customer record needs its key.');
			const filter = who.userId ? { websiteId, userId: who.userId } : { websiteId, guestKey: who.guestKey };
			const set = {
				name: who.name,
				...(who.email || who.userId ? { email: who.email } : {}),
				phone: who.phone,
				phoneDigits: phoneDigitsOf(who.phone),
			};
			const insert = {
				id: createId(ID_PREFIX.customer),
				userId: who.userId ?? null,
				guest: !who.userId,
				blocked: false,
				blockedReason: '',
				rtoCount: 0,
				orderCount: 0,
				note: '',
				city: '',
				seenBy: [],
				...(who.email || who.userId ? {} : { email: '' }),
				...(who.userId ? {} : { guestKey: who.guestKey }),
				createdAt: at,
			};
			/** @returns {Promise<any>} */
			const write = () =>
				customers.findOneAndUpdate(
					filter,
					refresh ? { $set: set, $setOnInsert: insert } : { $setOnInsert: { ...set, ...insert } },
					{
						upsert: true,
						returnDocument: 'after',
						projection: { _id: 0 },
					},
				);
			let found;
			try {
				found = await write();
			} catch (error) {
				// two first orders at once: the other made the record
				if (/** @type {any} */ (error)?.code !== 11000) throw error;
				found = await write();
			}
			return /** @type {CustomerRecord} */ (found);
		},
		/**
		 * Count an order on its customer record, with the delivery city, the loyalty member flag (E47) and the addresses
		 * it keeps after the order (E46; null: unchanged).
		 * @param {string} customerId
		 * @param {{ city: string, at: Date, member: boolean, addresses: import('../core/checkout.js').Address[] | null }} order
		 */
		countOrder: async (customerId, { city, at, member, addresses }) => {
			await data.collection(COLLECTIONS.customers).updateOne(
				{ websiteId, id: customerId },
				{
					$inc: { orderCount: 1 },
					$set: {
						lastOrderAt: at,
						...(city ? { city } : {}),
						...(member ? { loyaltyMember: true } : {}),
						...(addresses ? { addresses } : {}),
					},
				},
			);
		},
		/** Uses of a coupon by a customer. @param {string} couponId @param {string} userId */
		couponUses: (couponId, userId) => data.collection(COLLECTIONS.couponUses).countDocuments({ websiteId, couponId, userId }),

		// -------------------------------------------------------------------------------------------------- orders
		/** @param {string} id @returns {Promise<OrderRecord | null>} */
		order: async (id) => /** @type {OrderRecord | null} */ (await orders.findOne({ websiteId, id }, NO_ID)),
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
		/**
		 * Orders of a customer still waiting (payment or confirmation): a member's by user id, and every order of their
		 * customer record (a guest's, or one placed as a guest on a member's phone, K-6).
		 * @param {{ userId: string | null, customerId: string | null }} who @param {ReadonlyArray<string>} roles
		 */
		countWaiting: (who, roles) => {
			const whose = [
				...(who.userId ? [{ 'customer.userId': who.userId }] : []),
				...(who.customerId ? [{ 'customer.customerId': who.customerId }] : []),
			];
			if (whose.length === 0) return Promise.resolve(0);
			return orders.countDocuments({
				websiteId,
				...(whose.length === 1 ? whose[0] : { $or: whose }),
				role: { $in: [...roles] },
			});
		},
		/**
		 * Orders a customer placed since a time (`ORDER_BURST_LIMIT`): a member's by user id, and every order of their
		 * customer record (a guest's, or one placed as a guest on a member's phone).
		 * @param {{ userId: string | null, customerId: string | null }} who @param {Date} since @param {number} limit
		 */
		countPlacedSince: (who, since, limit) => {
			const whose = [
				...(who.userId ? [{ 'customer.userId': who.userId }] : []),
				...(who.customerId ? [{ 'customer.customerId': who.customerId }] : []),
			];
			if (whose.length === 0) return Promise.resolve(0);
			return orders.countDocuments(
				{ websiteId, ...(whose.length === 1 ? whose[0] : { $or: whose }), placedAt: { $gt: since } },
				{ limit },
			);
		},
		/**
		 * How many orders each status has, with their role (the order flow's save guard).
		 * @returns {Promise<Array<{ status: string, role: string, count: number }>>}
		 */
		statusCounts: async () =>
			(
				await orders
					.aggregate(
						[{ $match: { websiteId } }, { $group: { _id: { status: '$status', role: '$role' }, count: { $sum: 1 } } }],
						// counted from the index alone (no order is read)
						{ hint: 'by_status_role' },
					)
					.toArray()
			).map((row) => ({ status: String(row._id?.status ?? ''), role: String(row._id?.role ?? ''), count: Number(row.count) })),
		/**
		 * Move every order of a status and role to another status of that role, with a history entry each
		 * (`POST /v1/orders/restatus`).
		 * @param {{ from: string, to: string, role: string, entry: Record<string, unknown> }} move
		 * @returns {Promise<number>} how many moved
		 */
		restatus: async ({ from, to, role, entry }) =>
			(await orders.updateMany({ websiteId, status: from, role }, { $set: { status: to }, $push: { history: entry } }))
				.modifiedCount,
		/** An order by its number (E21 order pages). @param {string} number @returns {Promise<OrderRecord | null>} */
		byNumber: async (number) => /** @type {OrderRecord | null} */ (await orders.findOne({ websiteId, number }, NO_ID)),
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
		 * Orders canceled while Payments could not take the cancel of their payment (K-13), within `windowMs` of the
		 * cancel and not tried in the last `everyMs`, least recently tried first.
		 * @param {number} now @param {number} everyMs @param {number} windowMs
		 * @returns {Promise<OrderRecord[]>}
		 */
		voidsPending: async (now, everyMs, windowMs) =>
			/** @type {OrderRecord[]} */ (
				await orders
					.find(
						{
							websiteId,
							'payment.voidPendingAt': { $gte: new Date(now - windowMs) },
							$or: [{ 'payment.checkedAt': null }, { 'payment.checkedAt': { $lte: new Date(now - everyMs) } }],
						},
						NO_ID,
					)
					.sort({ 'payment.checkedAt': 1 })
					.limit(RECHECK_BATCH)
					.toArray()
			),
		/**
		 * Canceled orders whose Payments payment was canceled within `windowMs` and that hold no money from it, not
		 * checked in the last `everyMs`, least recently checked first (money may still arrive, K-13).
		 * @param {number} now @param {number} everyMs @param {number} windowMs
		 * @returns {Promise<OrderRecord[]>}
		 */
		toWatch: async (now, everyMs, windowMs) =>
			/** @type {OrderRecord[]} */ (
				await orders
					.find(
						{
							websiteId,
							role: 'canceled',
							'payment.voidedAt': { $gte: new Date(now - windowMs) },
							'payment.paymentId': { $ne: null },
							payments: { $not: { $elemMatch: { method: VIA_PAYMENTS } } },
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
			const under = limit > 0 ? { downloads: { $lt: limit } } : {};
			const result = await orders.updateOne(
				{ websiteId, id: orderId, lines: { $elemMatch: { id: lineId, ...under } } },
				{ $inc: { 'lines.$.downloads': 1 } },
			);
			return result.modifiedCount === 1;
		},

		// ------------------------------------------------------------------------------------------------ licenses
		/**
		 * Add license keys to a product (keys it already has are skipped).
		 * @param {string} productId @param {Array<{ id: string, key: string }>} keys
		 * @returns {Promise<number>} how many were added
		 */
		addLicenses: async (productId, keys) => {
			if (keys.length === 0) return 0;
			try {
				const result = await data.collection(COLLECTIONS.licenses).insertMany(
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
		/**
		 * Remove license keys of a product that no order was given (keys given to an order stay with it).
		 * @param {string} productId @param {string[]} keys
		 * @returns {Promise<{ removed: number, given: number }>} given: how many of them an order has
		 */
		removeLicenses: async (productId, keys) => {
			const licenses = data.collection(COLLECTIONS.licenses);
			const removed = (await licenses.deleteMany({ websiteId, productId, key: { $in: keys }, status: 'available' }))
				.deletedCount;
			const given = await licenses.countDocuments({ websiteId, productId, key: { $in: keys }, status: 'assigned' });
			return { removed: Number(removed ?? 0), given };
		},
		/**
		 * Whether any order has a line of the product (its files then stay for those orders when removed).
		 * @param {string} productId
		 */
		productOrdered: async (productId) =>
			(await orders.countDocuments({ websiteId, 'lines.productId': productId }, { limit: 1 })) > 0,
		/** @param {string} productId */
		countLicenses: (productId) =>
			data.collection(COLLECTIONS.licenses).countDocuments({ websiteId, productId, status: 'available' }),
		/**
		 * Give an order line up to `count` available license keys of a product (each to one line only).
		 * @param {{ productId: string, orderId: string, lineId: string, count: number }} give
		 * @returns {Promise<string[]>} the license ids given
		 */
		assignLicenses: async ({ productId, orderId, lineId, count }) => {
			/** @type {string[]} */
			const ids = [];
			for (let n = 0; n < count; n += 1) {
				const taken = await data
					.collection(COLLECTIONS.licenses)
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
		/** Record licenses given to an order line. @param {string} orderId @param {string} lineId @param {string[]} ids */
		addLineLicenses: async (orderId, lineId, ids) => {
			if (ids.length === 0) return;
			await orders.updateOne(
				{ websiteId, id: orderId, 'lines.id': lineId },
				{ $push: { 'lines.$.licenses': { $each: ids } } },
			);
		},
		/**
		 * Keep a product's digital files.
		 * @param {string} productId @param {import('../core/model.js').ProductRecord['digital']} digital
		 */
		setDigital: (productId, digital) =>
			data.collection(COLLECTIONS.products).updateOne({ websiteId, id: productId }, { $set: { digital } }),
		/** The keys of licenses. @param {string[]} ids @returns {Promise<Map<string, string>>} id → key */
		licenseKeys: async (ids) => {
			if (ids.length === 0) return new Map();
			const found = await data
				.collection(COLLECTIONS.licenses)
				.find({ websiteId, id: { $in: ids } }, { projection: { _id: 0, id: 1, key: 1 } })
				.toArray();
			return new Map(found.map((license) => [String(license.id), String(license.key)]));
		},
	});
};

/** @typedef {ReturnType<typeof createOrdersStore>} OrdersStore */
