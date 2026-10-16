/**
 * The orders part's (fulfillment) queries in the merchant database: the staff order list and search, customers with
 * what they spent, and the data-rights look-ups. Every query pins `websiteId` (the kit's tenant guard). Writes that
 * move stock, offer uses, points or slots go through `adapters/ledger.js`; the order moves themselves are in
 * `server/orders-moves.js`.
 * @module
 */
import { phoneSearchOf } from '../core/guests.js';
import { COLLECTIONS, NO_ID } from '../core/model.js';
import { isCustomerId, spentKey } from '../core/orders.js';
import { escapeRegex } from '../core/search.js';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */
/** @typedef {import('../core/model.js').CustomerRecord} CustomerRecord */
/** @typedef {{ id?: string, email?: string, phone?: string }} Person */
/**
 * Whose orders (K-6): a member's by Accounts user id (with their customer id: also the guest orders placed on their
 * phone that no sign-in proved theirs yet), a guest's by customer id.
 * @typedef {{ userId: string, customerId?: string } | { customerId: string }} Owner
 */

/**
 * The orders of an owner: a member's by user id (and, given their customer id, the guest orders linked to their record);
 * a guest's by customer id (orders placed as that guest).
 * @param {Owner} owner
 */
export const ownerOrders = (owner) => {
	const linked = { 'customer.customerId': owner.customerId, 'customer.userId': '' };
	if (!('userId' in owner)) return linked;
	return owner.customerId ? { $or: [{ 'customer.userId': owner.userId }, linked] } : { 'customer.userId': owner.userId };
};

/** Merchant database indexes of this part. @type {import('@ss/app-kit').IndexDefinition[]} */
export const INDEXES = [
	{ collection: COLLECTIONS.orders, keys: { websiteId: 1, createdAt: -1, id: -1 }, name: 'fulfill_recent' },
	{ collection: COLLECTIONS.orders, keys: { websiteId: 1, status: 1, createdAt: -1, id: -1 }, name: 'fulfill_by_status' },
	{ collection: COLLECTIONS.orders, keys: { websiteId: 1, 'customer.email': 1 }, name: 'fulfill_by_email' },
	{ collection: COLLECTIONS.orders, keys: { websiteId: 1, 'customer.phone': 1 }, name: 'fulfill_by_phone' },
	{ collection: COLLECTIONS.customers, keys: { websiteId: 1, name: 1, id: 1 }, name: 'fulfill_by_name' },
	{ collection: COLLECTIONS.customers, keys: { websiteId: 1, createdAt: -1, id: -1 }, name: 'fulfill_newest' },
	{ collection: COLLECTIONS.customers, keys: { websiteId: 1, email: 1 }, name: 'fulfill_by_email' },
	{ collection: COLLECTIONS.customers, keys: { websiteId: 1, phone: 1 }, name: 'fulfill_by_phone' },
];

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
	return typeof name === 'string' && typeof id === 'string' ? { $or: [{ name: { $gt: name } }, { name, id: { $gt: id } }] } : {};
};

/**
 * The customers after a page's last one, newest first (keyset after `[createdAt ISO, id]`).
 * @param {unknown} after
 */
const newestPage = (after) => {
	const [time, id] = Array.isArray(after) ? after : [];
	return typeof time === 'string' && typeof id === 'string' && !Number.isNaN(Date.parse(time))
		? { $or: [{ createdAt: { $lt: new Date(time) } }, { createdAt: new Date(time), id: { $lt: id } }] }
		: {};
};

/**
 * @typedef {{ q: string, blocked: boolean | null, segment?: Record<string, unknown> | null, tags?: string[] | null,
 *   seenBy?: string, unseen?: boolean, createdAfter?: Date | null, userIds?: string[] | null,
 *   phoneDigits?: string[] }} CustomerQuery `segment`: a saved segment's filter (`core/customer-segments.js`
 *   `segmentFilter`, E11); `tags`: any of these tags; `userIds`: only these Accounts users (a page of the store's own
 *   member list, CU-2); `phoneDigits`: the digit runs of `q` to find in phones, read by the website's phone rules
 *   (`core/guests.js` `phoneSearchOf`; without them, the digits typed and without leading zeros)
 */

/**
 * The staff customer list's filter: a search (name, start of the email, the user or customer id, 4 or more digits of
 * the phone, found anywhere in its whole number), blocked or not, a saved segment and tags (E11), not yet opened by the
 * acting staff member, created after a time (E31) and given Accounts users. The list and its counts share it (PLAN
 * 0.8.10 K4).
 * @param {string} websiteId
 * @param {CustomerQuery} input
 * @returns {Record<string, unknown>}
 */
export const customerFilter = (
	websiteId,
	{
		q,
		blocked,
		segment = null,
		tags = null,
		seenBy = '',
		unseen = false,
		createdAfter = null,
		userIds = null,
		phoneDigits = undefined,
	},
) => {
	/** @type {Record<string, unknown>} */
	const filter = {
		websiteId,
		...(blocked === null ? {} : { blocked }),
		...(userIds === null ? {} : { userId: { $in: userIds } }),
	};
	/** @type {Record<string, unknown>[]} */
	const and = [];
	if (segment) and.push(segment);
	if (tags && tags.length > 0) and.push({ tags: { $in: tags } });
	if (unseen && seenBy) and.push({ seenBy: { $ne: seenBy } });
	if (createdAfter) and.push({ createdAt: { $gt: createdAfter } });
	if (q) {
		const term = escapeRegex(q);
		const digits = phoneDigits ?? phoneSearchOf(q, null);
		and.push({
			$or: [
				{ name: { $regex: term, $options: 'i' } },
				{ email: { $regex: `^${term}`, $options: 'i' } },
				{ userId: q },
				{ id: q },
				// the phone's digits anywhere in its whole number, whatever its format (E31)
				...digits.flatMap((run) => [{ phoneDigits: { $regex: escapeRegex(run) } }, { phone: { $regex: escapeRegex(run) } }]),
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
							$concatArrays: [{ $filter: { input: '$seenBy', cond: { $ne: ['$$this', staffId] } } }, [staffId]],
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
export const createFulfillmentStore = (data) => {
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
			 * What customers paid (paid − refunded) and how many orders they placed: a member's orders by user id and the
			 * guest orders linked to their record, a guest's by customer id (K-6, CU-5), keyed as `spentKey`
			 * (`core/orders.js`) keys them.
			 * @param {Array<Partial<CustomerRecord>>} customers
			 * @returns {Promise<Map<string, { total: number, count: number }>>}
			 */
			spent: async (customers) => {
				const userIds = customers.map((row) => row.userId).filter((id) => typeof id === 'string' && id !== '');
				/** each record's key, by customer id (a member's guest orders count as theirs) */
				const keys = new Map(
					customers
						.filter((row) => typeof row.id === 'string' && row.id !== '')
						.map((row) => [/** @type {string} */ (row.id), spentKey(row)]),
				);
				const customerIds = [...keys.keys()];
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
				/** @type {Map<string, { total: number, count: number }>} */
				const spent = new Map();
				for (const row of rows) {
					const id = String(row._id);
					const key = id.startsWith('c:') ? (keys.get(id.slice(2)) ?? id) : id;
					const sum = spent.get(key) ?? { total: 0, count: 0 };
					spent.set(key, { total: sum.total + Number(row.total), count: sum.count + Number(row.count) });
				}
				return spent;
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
			anonymize: async (person) => {
				const or = personOr(person, { id: 'customer.userId', email: 'customer.email', phone: 'customer.phone' });
				if (or.length === 0) return 0;
				// the order fields go too: what the shopper gave at checkout may name them (a gift message, a tax number)
				const result = await orders.updateMany(
					{ websiteId, $or: or },
					{
						$set: { 'customer.name': '', 'customer.email': '', 'customer.phone': '', address: null, note: '' },
						$unset: { fields: '' },
					},
				);
				return result.modifiedCount;
			},
		}),

		customers: Object.freeze({
			/**
			 * A page of customers, A to Z (by name, then customer id), or the newest first (`sort: newest`).
			 * @param {CustomerQuery & { after: unknown, limit: number, sort: 'name' | 'newest' }} input
			 * @returns {Promise<Array<CustomerRecord & { createdAt?: Date, updatedAt?: Date }>>}
			 */
			list: async ({ after, limit, sort, ...query }) => {
				const filter = customerFilter(websiteId, query);
				const page = sort === 'newest' ? newestPage(after) : namePage(after);
				return as(
					await customers
						.find(
							{ ...filter, $and: [.../** @type {any[]} */ (filter.$and ?? []), page] },
							{ ...NO_ID, sort: sort === 'newest' ? { createdAt: -1, id: -1 } : { name: 1, id: 1 }, limit },
						)
						.toArray(),
				);
			},
			/**
			 * Add a customer record (a guest staff add, E46); false when one is there already for the same person: the same
			 * guest key, phone, or email address of an email guest (E15; an empty phone or email address matches nothing).
			 * @param {CustomerRecord & { createdAt: Date }} record
			 */
			create: async (record) => {
				const same = [
					...(record.guestKey ? [{ guestKey: record.guestKey }] : []),
					...(record.phone ? [{ phone: record.phone }] : []),
					...(record.email && record.guestKey?.startsWith('e:') ? [{ email: record.email }] : []),
				];
				const taken = await customers.findOne({ websiteId, $or: same }, { projection: { _id: 0, id: 1 } });
				if (taken) return false;
				try {
					await customers.insertOne({ ...record });
					return true;
				} catch (error) {
					if (/** @type {any} */ (error)?.code === 11000) return false;
					throw error;
				}
			},
			/**
			 * Delete a customer record by customer id while no order names it (E46): 'deleted', 'ordered' or 'missing'.
			 * @param {string} id
			 * @returns {Promise<'deleted' | 'ordered' | 'missing'>}
			 */
			remove: async (id) => {
				const record = /** @type {CustomerRecord | null} */ (
					await customers.findOne({ websiteId, id }, { projection: { _id: 0 } })
				);
				if (!record) return 'missing';
				const owner = record.userId ? { userId: record.userId, customerId: id } : { customerId: id };
				if ((await orders.countDocuments({ websiteId, ...ownerOrders(owner) }, { limit: 1 })) > 0) return 'ordered';
				return (await customers.deleteOne({ websiteId, id, orderCount: { $in: [0, null] } })).deletedCount === 1
					? 'deleted'
					: 'ordered';
			},
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
			 * Change a customer record, by customer id (K-6).
			 * @param {string} id @param {Record<string, unknown>} set
			 */
			update: async (id, set) => {
				await customers.updateOne({ websiteId, id }, { $set: set });
			},
			/** @param {Person} person @returns {Promise<CustomerRecord[]>} */
			ofPerson: async (person) => {
				const or = personOr(person, { id: 'userId', email: 'email', phone: 'phone' });
				return or.length === 0 ? [] : as(await customers.find({ websiteId, $or: or }, NO_ID).toArray());
			},
			/** @param {Person} person */
			forget: async (person) => {
				const or = personOr(person, { id: 'userId', email: 'email', phone: 'phone' });
				return or.length === 0 ? 0 : (await customers.deleteMany({ websiteId, $or: or })).deletedCount;
			},
		}),
	});
};

/** @typedef {ReturnType<typeof createFulfillmentStore>} FulfillmentStore */
