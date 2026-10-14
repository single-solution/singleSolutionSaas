/**
 * The orders part's (fulfillment) queries in the merchant database: the staff order list and search, customers with
 * what they spent, and the data-rights look-ups. Every query pins `websiteId` (the kit's tenant guard). Writes that
 * move stock, offer uses, points or slots go through `adapters/ledger.js`; the order moves themselves are in
 * `server/orders-moves.js`.
 * @module
 */
import { createId } from '@ss/contracts';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import { isCustomerId } from '../core/orders.js';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */
/** @typedef {import('../core/model.js').CustomerRecord} CustomerRecord */
/** @typedef {{ id?: string, email?: string, phone?: string }} Person */
/** Whose orders (K-6): a member's by Accounts user id, a guest's by customer id. @typedef {{ userId: string } | { customerId: string }} Owner */

/**
 * The orders of an owner: a member's by user id; a guest's by customer id (orders placed as that guest).
 * @param {Owner} owner
 */
export const ownerOrders = (owner) =>
	'userId' in owner ? { 'customer.userId': owner.userId } : { 'customer.customerId': owner.customerId, 'customer.userId': '' };

/** Merchant database indexes of this part. @type {import('@ss/app-kit').IndexDefinition[]} */
export const INDEXES = [
	{ collection: COLLECTIONS.orders, keys: { websiteId: 1, createdAt: -1, id: -1 }, name: 'fulfil_recent' },
	{ collection: COLLECTIONS.orders, keys: { websiteId: 1, status: 1, createdAt: -1, id: -1 }, name: 'fulfil_by_status' },
	{ collection: COLLECTIONS.orders, keys: { websiteId: 1, 'customer.email': 1 }, name: 'fulfil_by_email' },
	{ collection: COLLECTIONS.orders, keys: { websiteId: 1, 'customer.phone': 1 }, name: 'fulfil_by_phone' },
	{ collection: COLLECTIONS.customers, keys: { websiteId: 1, name: 1, userId: 1 }, name: 'fulfil_by_name' },
	{ collection: COLLECTIONS.customers, keys: { websiteId: 1, email: 1 }, name: 'fulfil_by_email' },
	{ collection: COLLECTIONS.customers, keys: { websiteId: 1, phone: 1 }, name: 'fulfil_by_phone' },
];

const NO_ID = Object.freeze({ projection: { _id: 0 } });

/** @param {string} text */
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The page filter of a `[time, id]` cursor (newest first).
 * @param {unknown} after
 * @param {string} timeField
 * @param {string} idField
 */
const newerPage = (after, timeField, idField) => {
	const [time, id] = Array.isArray(after) ? after : [];
	return typeof time === 'string' && typeof id === 'string'
		? { $or: [{ [timeField]: { $lt: new Date(time) } }, { [timeField]: new Date(time), [idField]: { $lt: id } }] }
		: {};
};

/**
 * The page filter of a `[name, userId]` cursor (A to Z).
 * @param {unknown} after
 */
const namePage = (after) => {
	const [name, id] = Array.isArray(after) ? after : [];
	return typeof name === 'string' && typeof id === 'string'
		? { $or: [{ name: { $gt: name } }, { name, userId: { $gt: id } }] }
		: {};
};

/**
 * @typedef {{ q: string, blocked: boolean | null, segment?: 'loyalty' | 'active' | 'guest' | null,
 *   loyalty?: { userIds: string[], customerIds: string[] } | null, seenBy?: string, unseen?: boolean,
 *   createdAfter?: Date | null, userIds?: string[] | null }} CustomerQuery `loyalty`: the owners of loyalty accounts
 *   (segment `loyalty`); `userIds`: only these Accounts users (a page of the store's own member list, CU-2)
 */

/**
 * The staff customer list's filter: a search (name, start of the email, the user or customer id, 4 or more digits of
 * the phone, matched on its last digits), blocked or not, a segment, not yet opened by the acting staff member,
 * created after a time (E31) and given Accounts users. The list and its counts share it (PLAN 0.8.10 K4).
 * @param {string} websiteId
 * @param {CustomerQuery} input
 * @returns {Record<string, unknown>}
 */
export const customerFilter = (
	websiteId,
	{ q, blocked, segment = null, loyalty = null, seenBy = '', unseen = false, createdAfter = null, userIds = null },
) => {
	/** @type {Record<string, unknown>} */
	const filter = {
		websiteId,
		...(blocked === null ? {} : { blocked }),
		...(userIds === null ? {} : { userId: { $in: userIds } }),
	};
	/** @type {Record<string, unknown>[]} */
	const and = [];
	// segments (E31): guests have no Accounts user (every write stores `guest`); active customers ordered at least once;
	// loyalty customers have points
	if (segment === 'guest') and.push({ guest: true });
	if (segment === 'active') and.push({ orderCount: { $gte: 1 } });
	if (segment === 'loyalty')
		and.push({ $or: [{ userId: { $in: loyalty?.userIds ?? [] } }, { id: { $in: loyalty?.customerIds ?? [] } }] });
	if (unseen && seenBy) and.push({ seenBy: { $ne: seenBy } });
	if (createdAfter) and.push({ createdAt: { $gt: createdAfter } });
	if (q) {
		const term = escapeRegex(q);
		const digits = q.replace(/\D/g, '');
		and.push({
			$or: [
				{ name: { $regex: term, $options: 'i' } },
				{ email: { $regex: `^${term}`, $options: 'i' } },
				{ userId: q },
				{ id: q },
				...(digits.length >= 4
					? [
							// the last digits of a phone, whatever its format (E31)
							{ phoneDigits: { $regex: `${escapeRegex(digits.slice(-10))}$` } },
							{ phone: { $regex: escapeRegex(digits) } },
						]
					: []),
			],
		});
	}
	if (and.length > 0) filter.$and = and;
	return filter;
};

/** An order or customer keeps the staff who opened it, at most this many (E31). */
const MAX_SEEN = 50;

/**
 * Mark a record seen by a staff member (E31): their id goes last in `seenBy`, which keeps the latest {@link MAX_SEEN}.
 * @param {WebsiteData} data
 * @param {string} collection
 * @param {Record<string, unknown>} match the record (without `websiteId`)
 * @param {string} staffId
 */
export const markSeenBy = (data, collection, match, staffId) =>
	data.collection(collection).updateOne({ websiteId: data.websiteId, ...match }, [
		{
			$set: {
				seenBy: {
					$slice: [
						{
							$concatArrays: [
								{ $filter: { input: { $ifNull: ['$seenBy', []] }, cond: { $ne: ['$$this', staffId] } } },
								[staffId],
							],
						},
						-MAX_SEEN,
					],
				},
			},
		},
	]);

/**
 * @param {WebsiteData} data the website's guarded merchant database
 */
export const createFulfilmentStore = (data) => {
	const websiteId = data.websiteId;
	const orders = data.collection(COLLECTIONS.orders);
	const customers = data.collection(COLLECTIONS.customers);
	/** @param {unknown} doc */
	const as = (doc) => /** @type {any} */ (doc);

	/**
	 * Who a data-rights request is about, as an `$or` over the given fields.
	 * @param {Person} person
	 * @param {{ id: string, email: string, phone: string }} fields
	 */
	const personOr = (person, fields) => {
		const or = [];
		if (person.id) or.push({ [fields.id]: person.id });
		if (person.email) or.push({ [fields.email]: { $in: [...new Set([person.email, person.email.trim().toLowerCase()])] } });
		if (person.phone) or.push({ [fields.phone]: person.phone });
		return or;
	};

	return Object.freeze({
		orders: Object.freeze({
			/**
			 * A page of orders, newest first.
			 * @param {{ filter: Record<string, unknown>, after: unknown, limit: number }} input
			 * @returns {Promise<OrderRecord[]>}
			 */
			list: async ({ filter, after, limit }) =>
				as(
					await orders
						.find(
							{ websiteId, ...filter, $and: [newerPage(after, 'createdAt', 'id')] },
							{ ...NO_ID, sort: { createdAt: -1, id: -1 }, limit },
						)
						.toArray(),
				),
			/** @param {string} id @returns {Promise<OrderRecord | null>} */
			get: async (id) => as(await orders.findOne({ websiteId, id }, NO_ID)),
			/** @param {string[]} ids @returns {Promise<OrderRecord[]>} */
			many: async (ids) => as(await orders.find({ websiteId, id: { $in: ids } }, NO_ID).toArray()),
			/**
			 * A customer's latest orders.
			 * @param {Owner} owner @param {number} limit
			 * @returns {Promise<OrderRecord[]>}
			 */
			ofCustomer: async (owner, limit) =>
				as(
					await orders
						.find({ websiteId, ...ownerOrders(owner) }, { ...NO_ID, sort: { createdAt: -1, id: -1 }, limit })
						.toArray(),
				),
			/**
			 * What customers paid (paid − refunded) and how many orders they placed: a member's orders by user id, a
			 * guest's by customer id (K-6, CU-5), keyed as `spentKey` (`core/orders.js`) keys them.
			 * @param {Array<Partial<CustomerRecord>>} customers
			 * @returns {Promise<Map<string, { total: number, count: number }>>}
			 */
			spent: async (customers) => {
				const userIds = customers.map((row) => row.userId).filter((id) => typeof id === 'string' && id !== '');
				const customerIds = customers
					.filter((row) => !row.userId && typeof row.id === 'string' && row.id !== '')
					.map((row) => /** @type {string} */ (row.id));
				if (userIds.length === 0 && customerIds.length === 0) return new Map();
				const rows = await orders
					.aggregate([
						{
							$match: {
								websiteId,
								$or: [
									{ 'customer.userId': { $in: userIds } },
									{ 'customer.userId': '', 'customer.customerId': { $in: customerIds } },
								],
							},
						},
						{
							$group: {
								_id: {
									$cond: [
										{ $gt: ['$customer.userId', ''] },
										{ $concat: ['u:', '$customer.userId'] },
										{ $concat: ['c:', '$customer.customerId'] },
									],
								},
								total: { $sum: { $subtract: ['$payment.paid', '$payment.refunded'] } },
								count: { $sum: 1 },
							},
						},
					])
					.toArray();
				return new Map(rows.map((row) => [String(row._id), { total: Number(row.total), count: Number(row.count) }]));
			},
			/** @param {Person} person @returns {Promise<OrderRecord[]>} */
			ofPerson: async (person) => {
				const or = personOr(person, { id: 'customer.userId', email: 'customer.email', phone: 'customer.phone' });
				return or.length === 0
					? []
					: as(await orders.find({ websiteId, $or: or }, { ...NO_ID, sort: { createdAt: -1 } }).toArray());
			},
			/**
			 * Remove a person's details from their orders (the amounts stay: they are the merchant's money records).
			 * @param {Person} person
			 */
			anonymise: async (person) => {
				const or = personOr(person, { id: 'customer.userId', email: 'customer.email', phone: 'customer.phone' });
				if (or.length === 0) return 0;
				const result = await orders.updateMany(
					{ websiteId, $or: or },
					{ $set: { 'customer.name': '', 'customer.email': '', 'customer.phone': '', address: null, note: '' } },
				);
				return result.modifiedCount;
			},
		}),

		customers: Object.freeze({
			/**
			 * A page of customers, A to Z.
			 * @param {CustomerQuery & { after: unknown, limit: number }} input
			 * @returns {Promise<Array<CustomerRecord & { createdAt?: Date, updatedAt?: Date }>>}
			 */
			list: async ({ after, limit, ...query }) =>
				as(
					await customers
						.find(
							(() => {
								const filter = customerFilter(websiteId, query);
								return { ...filter, $and: [.../** @type {any[]} */ (filter.$and ?? []), namePage(after)] };
							})(),
							{ ...NO_ID, sort: { name: 1, userId: 1 }, limit },
						)
						.toArray(),
				),
			/** @param {string} userId @returns {Promise<(CustomerRecord & { createdAt?: Date, updatedAt?: Date }) | null>} */
			get: async (userId) => as(await customers.findOne({ websiteId, userId }, NO_ID)),
			/**
			 * A customer by customer id (`cus_…`, members and guests) or Accounts user id (K-6).
			 * @param {string} ref
			 * @returns {Promise<(CustomerRecord & { createdAt?: Date, updatedAt?: Date }) | null>}
			 */
			find: async (ref) =>
				as(await customers.findOne({ websiteId, ...(isCustomerId(ref) ? { id: ref } : { userId: ref }) }, NO_ID)),
			/**
			 * Change a customer record: a member's by user id (created when missing, with the details of their latest
			 * order), any customer's by customer id (K-6).
			 * @param {{ userId: string } | { id: string }} key
			 * @param {Record<string, unknown>} set
			 * @param {{ name: string, email: string, phone: string }} details used only when the record is created
			 * @param {Date} at the record's `createdAt` when it is created (CU-4)
			 */
			update: async (key, set, details, at) => {
				if ('id' in key) {
					await customers.updateOne({ websiteId, id: key.id }, { $set: set });
					return as(await customers.findOne({ websiteId, id: key.id }, NO_ID));
				}
				const { userId } = key;
				await customers.updateOne(
					{ websiteId, userId },
					{
						$set: set,
						$setOnInsert: {
							id: createId(ID_PREFIX.customer),
							userId,
							createdAt: at,
							...details,
							...Object.fromEntries(
								Object.entries({ blocked: false, blockedReason: '', rtoCount: 0, orderCount: 0, note: '' }).filter(
									([key]) => !(key in set),
								),
							),
						},
					},
					{ upsert: true },
				);
				return as(await customers.findOne({ websiteId, userId }, NO_ID));
			},
			/** @param {Person} person @returns {Promise<CustomerRecord[]>} */
			ofPerson: async (person) => {
				const or = personOr(person, { id: 'userId', email: 'email', phone: 'phone' });
				return or.length === 0 ? [] : as(await customers.find({ websiteId, $or: or }, NO_ID).toArray());
			},
			/** @param {Person} person */
			remove: async (person) => {
				const or = personOr(person, { id: 'userId', email: 'email', phone: 'phone' });
				return or.length === 0 ? 0 : (await customers.deleteMany({ websiteId, $or: or })).deletedCount;
			},
		}),
	});
};

/** @typedef {ReturnType<typeof createFulfilmentStore>} FulfilmentStore */
