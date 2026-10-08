/**
 * The orders part's (fulfilment) queries in the merchant database: the staff order list and search, customers with
 * what they spent, and the data-rights look-ups. Every query pins `websiteId` (the kit's tenant guard). Writes that
 * move stock, offer uses, points or slots go through `adapters/ledger.js`; the order moves themselves are in
 * `api/orders-moves.js`.
 * @module
 */
import { COLLECTIONS } from '../core/model.js';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */
/** @typedef {import('../core/model.js').CustomerRecord} CustomerRecord */
/** @typedef {{ id?: string, email?: string, phone?: string }} Person */

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
			 * @param {string} userId @param {number} limit
			 * @returns {Promise<OrderRecord[]>}
			 */
			ofCustomer: async (userId, limit) =>
				as(
					await orders
						.find({ websiteId, 'customer.userId': userId }, { ...NO_ID, sort: { createdAt: -1, id: -1 }, limit })
						.toArray(),
				),
			/**
			 * What customers paid (paid − refunded) and how many orders they placed.
			 * @param {string[]} userIds
			 * @returns {Promise<Map<string, { total: number, count: number }>>}
			 */
			spent: async (userIds) => {
				if (userIds.length === 0) return new Map();
				const rows = await orders
					.aggregate([
						{ $match: { websiteId, 'customer.userId': { $in: userIds } } },
						{
							$group: {
								_id: '$customer.userId',
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
			 * @param {{ q: string, blocked: boolean | null, after: unknown, limit: number }} input
			 * @returns {Promise<Array<CustomerRecord & { createdAt?: Date, updatedAt?: Date }>>}
			 */
			list: async ({ q, blocked, after, limit }) => {
				/** @type {Record<string, unknown>[]} */
				const and = [namePage(after)];
				if (q) {
					const term = escapeRegex(q);
					const digits = q.replace(/\D/g, '');
					and.push({
						$or: [
							{ name: { $regex: term, $options: 'i' } },
							{ email: { $regex: `^${term}`, $options: 'i' } },
							{ userId: q },
							...(digits.length >= 4 ? [{ phone: { $regex: escapeRegex(digits) } }] : []),
						],
					});
				}
				return as(
					await customers
						.find(
							{ websiteId, ...(blocked === null ? {} : { blocked }), $and: and },
							{ ...NO_ID, sort: { name: 1, userId: 1 }, limit },
						)
						.toArray(),
				);
			},
			/** @param {string} userId @returns {Promise<(CustomerRecord & { createdAt?: Date, updatedAt?: Date }) | null>} */
			get: async (userId) => as(await customers.findOne({ websiteId, userId }, NO_ID)),
			/**
			 * Change a customer record (created when missing, with the details of their latest order).
			 * @param {string} userId
			 * @param {Record<string, unknown>} set
			 * @param {{ name: string, email: string, phone: string }} details used only when the record is created
			 */
			update: async (userId, set, details) => {
				await customers.updateOne(
					{ websiteId, userId },
					{
						$set: set,
						$setOnInsert: {
							userId,
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
