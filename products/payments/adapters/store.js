/**
 * Payments' records in the merchant database (collections `ss_payments_<name>`, through the kit's tenant guard: every
 * query carries the website id; inserts are stamped with `websiteId`, `merchantId`, `createdAt` and `updatedAt`).
 * Payment records are kept; nothing expires (PLAN 0.8.7).
 *
 * - `payments`: one per payment, with its refunds and its history
 * - `links`: payment links
 * - `subscriptions`: gateway-managed subscriptions as Payments mirrors them
 * - `events`: payment events, listed by the API and sent to the merchant through Notifications
 * @module
 */
import { createId } from '@ss/contracts';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {{ at: Date, event: string, detail?: string, by?: string }} HistoryEntry */
/**
 * @typedef {object} PaymentRecord
 * @property {string} id
 * @property {string} websiteId
 * @property {'api' | 'link'} source
 * @property {string | null} linkId
 * @property {number} amount minor units
 * @property {string} currency
 * @property {string} description
 * @property {string} reference the merchant's own reference
 * @property {import('../core/payments.js').Customer} customer
 * @property {Record<string, string>} metadata
 * @property {string | null} returnUrl
 * @property {string | null} cancelUrl
 * @property {import('../core/gateways.js').Gateway | null} gateway
 * @property {import('../core/payments.js').PaymentStatus} status
 * @property {string | null} gatewayRef the gateway's session, order or transaction reference
 * @property {string | null} captureRef what refunds name (Stripe payment intent, PayPal capture, PayFast payment id …)
 * @property {{ kind: 'redirect', url: string } | { kind: 'form', action: string, fields: Array<[string, string]> } | null} checkout
 * @property {number} refunded minor units refunded so far
 * @property {Array<{ id: string, amount: number, reason: string, manual: boolean, by: string, at: Date, gatewayRef: string | null }>} refunds
 * @property {{ key: string, type: string, size: number, at: Date } | null} proof bank-transfer proof in the merchant's storage
 * @property {HistoryEntry[]} history
 * @property {Date | null} paidAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */
/**
 * @typedef {{ id: string, title: string, description: string, amount: number | null, minAmount: number | null, currency: string,
 *   gateways: string[], returnUrl: string | null, reference: string, active: boolean, paidCount: number, createdAt: Date }} LinkRecord
 */
/**
 * @typedef {{ id: string, gateway: 'stripe' | 'paypal', plan: string, customer: import('../core/payments.js').Customer,
 *   reference: string, returnUrl: string, cancelUrl: string | null, status: import('../core/payments.js').SubscriptionStatus,
 *   gatewayRef: string | null, checkoutUrl: string | null, history: HistoryEntry[], createdAt: Date, updatedAt: Date }} SubscriptionRecord
 */
/**
 * @typedef {{ id: string, type: string, data: Record<string, unknown>, delivery: 'pending' | 'sent' | 'not_connected' | 'failed',
 *   attempts: number, dueAt: Date, createdAt: Date }} EventRecord
 */

export const PAYMENTS = 'payments';
export const LINKS = 'links';
export const SUBSCRIPTIONS = 'subscriptions';
export const EVENTS = 'events';

/** Merchant database indexes (created on a website's first use). @type {import('@ss/app-kit').IndexDefinition[]} */
export const INDEXES = [
	{ collection: PAYMENTS, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: PAYMENTS, keys: { websiteId: 1, createdAt: -1, id: -1 }, name: 'newest' },
	{ collection: PAYMENTS, keys: { websiteId: 1, 'customer.email': 1 }, name: 'by_email' },
	{ collection: PAYMENTS, keys: { websiteId: 1, 'customer.phone': 1 }, name: 'by_phone' },
	{ collection: PAYMENTS, keys: { websiteId: 1, 'customer.id': 1 }, name: 'by_user' },
	{ collection: LINKS, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: LINKS, keys: { websiteId: 1, createdAt: -1, id: -1 }, name: 'newest' },
	{ collection: SUBSCRIPTIONS, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: SUBSCRIPTIONS, keys: { websiteId: 1, gatewayRef: 1 }, name: 'by_ref' },
	{ collection: SUBSCRIPTIONS, keys: { websiteId: 1, createdAt: -1, id: -1 }, name: 'newest' },
	{ collection: EVENTS, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: EVENTS, keys: { websiteId: 1, createdAt: -1, id: -1 }, name: 'newest' },
	{ collection: EVENTS, keys: { websiteId: 1, delivery: 1, dueAt: 1 }, name: 'due' },
];

const NO_ID = { projection: { _id: 0 } };

/**
 * Keyset filter for newest-first pages by `[createdAt, id]`.
 * @param {unknown} after the cursor key
 */
const pageFilter = (after) => {
	const [time, id] = Array.isArray(after) ? after : [];
	return typeof time === 'string' && typeof id === 'string'
		? { $or: [{ createdAt: { $lt: new Date(time) } }, { createdAt: new Date(time), id: { $lt: id } }] }
		: {};
};

/** @param {string} text */
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {WebsiteData} data the website's guarded merchant database
 * @param {{ now: () => number }} clock
 */
export const createStore = (data, { now }) => {
	const websiteId = data.websiteId;
	const at = () => new Date(now());
	const payments = data.collection(PAYMENTS);
	const links = data.collection(LINKS);
	const subscriptions = data.collection(SUBSCRIPTIONS);
	const events = data.collection(EVENTS);
	/** @param {unknown} doc */
	const as = (doc) => /** @type {any} */ (doc);

	/** @param {{ id?: string, email?: string, phone?: string }} user */
	const personFilter = (user) => {
		const or = [];
		if (user.id) or.push({ 'customer.id': user.id });
		if (user.email) or.push({ 'customer.email': user.email.trim().toLowerCase() });
		if (user.phone) or.push({ 'customer.phone': user.phone.replace(/[\s()-]/g, '') });
		return or.length === 0 ? null : { websiteId, $or: or };
	};

	return Object.freeze({
		payments: Object.freeze({
			/**
			 * @param {Omit<PaymentRecord, 'id' | 'websiteId' | 'createdAt' | 'updatedAt' | 'status' | 'refunded' | 'refunds' | 'proof' | 'history' | 'paidAt' | 'gatewayRef' | 'captureRef' | 'checkout'>} input
			 * @returns {Promise<PaymentRecord>}
			 */
			add: async (input) => {
				const id = createId('pay');
				await payments.insertOne({
					...input,
					id,
					status: 'pending',
					gatewayRef: null,
					captureRef: null,
					checkout: null,
					refunded: 0,
					refunds: [],
					proof: null,
					history: [{ at: at(), event: 'created' }],
					paidAt: null,
				});
				return as(await payments.findOne({ websiteId, id }, NO_ID));
			},
			/** @param {string} id @returns {Promise<PaymentRecord | null>} */
			get: async (id) => as(await payments.findOne({ websiteId, id }, NO_ID)),
			/**
			 * Change a payment only while its status is one of `from` (so two confirmations never both apply).
			 * @param {string} id
			 * @param {readonly string[]} from
			 * @param {Partial<PaymentRecord>} set
			 * @param {Omit<HistoryEntry, 'at'> | null} [entry]
			 * @returns {Promise<PaymentRecord | null>} null when the status was not one of `from`
			 */
			change: async (id, from, set, entry = null) =>
				as(
					await payments.findOneAndUpdate(
						{ websiteId, id, status: { $in: [...from] } },
						{ $set: set, ...(entry ? { $push: { history: { ...entry, at: at() } } } : {}) },
						{ returnDocument: 'after', ...NO_ID },
					),
				),
			/**
			 * Add a refund while nothing else was refunded meanwhile.
			 * @param {string} id
			 * @param {number} refundedBefore
			 * @param {PaymentRecord['refunds'][number]} refund
			 * @param {'refunded' | 'partially_refunded'} status
			 * @returns {Promise<PaymentRecord | null>}
			 */
			addRefund: async (id, refundedBefore, refund, status) =>
				as(
					await payments.findOneAndUpdate(
						{ websiteId, id, refunded: refundedBefore, status: { $in: ['paid', 'partially_refunded'] } },
						{
							$set: { status, refunded: refundedBefore + refund.amount },
							$push: {
								refunds: refund,
								history: {
									at: at(),
									event: 'refunded',
									detail: `${refund.amount}${refund.manual ? ' (recorded)' : ''}`,
									by: refund.by,
								},
							},
						},
						{ returnDocument: 'after', ...NO_ID },
					),
				),
			/**
			 * Newest first, keyset-paged; `q` matches the id, reference or payer e-mail exactly or a reference prefix.
			 * @param {{ after: unknown, limit: number, status?: string, q?: string }} page
			 * @returns {Promise<PaymentRecord[]>}
			 */
			list: async ({ after, limit, status, q }) => {
				/** @type {Record<string, unknown>[]} */
				const and = [pageFilter(after)];
				if (q) {
					const term = q.trim().slice(0, 120);
					and.push({
						$or: [
							{ id: term },
							{ 'customer.email': term.toLowerCase() },
							{ reference: { $regex: `^${escapeRegex(term)}` } },
						],
					});
				}
				const filter = { websiteId, ...(status ? { status } : {}), $and: and };
				return as(await payments.find(filter, { ...NO_ID, sort: { createdAt: -1, id: -1 }, limit }).toArray());
			},
			/** @param {{ id?: string, email?: string, phone?: string }} user @returns {Promise<PaymentRecord[]>} */
			ofPerson: async (user) => {
				const filter = personFilter(user);
				return filter ? as(await payments.find(filter, { ...NO_ID, sort: { createdAt: -1 } }).toArray()) : [];
			},
			/**
			 * Remove a person's details from their payments (the amounts stay: they are the merchant's money records).
			 * @param {{ id?: string, email?: string, phone?: string }} user
			 */
			anonymise: async (user) => {
				const filter = personFilter(user);
				return filter ? (await payments.updateMany(filter, { $set: { customer: {} } })).modifiedCount : 0;
			},
		}),

		links: Object.freeze({
			/** @param {Omit<LinkRecord, 'id' | 'createdAt' | 'active' | 'paidCount'>} input @returns {Promise<LinkRecord>} */
			add: async (input) => {
				const id = createId('link');
				await links.insertOne({ ...input, id, active: true, paidCount: 0 });
				return as(await links.findOne({ websiteId, id }, NO_ID));
			},
			/** @param {string} id @returns {Promise<LinkRecord | null>} */
			get: async (id) => as(await links.findOne({ websiteId, id }, NO_ID)),
			/** @param {string} id @param {boolean} active @returns {Promise<LinkRecord | null>} */
			setActive: async (id, active) =>
				as(await links.findOneAndUpdate({ websiteId, id }, { $set: { active } }, { returnDocument: 'after', ...NO_ID })),
			/** @param {string} id */
			countPaid: async (id) => {
				await links.updateOne({ websiteId, id }, { $inc: { paidCount: 1 } });
			},
			/** @param {{ after: unknown, limit: number }} page @returns {Promise<LinkRecord[]>} */
			list: async ({ after, limit }) =>
				as(
					await links
						.find({ websiteId, ...pageFilter(after) }, { ...NO_ID, sort: { createdAt: -1, id: -1 }, limit })
						.toArray(),
				),
		}),

		subscriptions: Object.freeze({
			/** @param {Omit<SubscriptionRecord, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'gatewayRef' | 'checkoutUrl' | 'history'>} input */
			add: async (input) => {
				const id = createId('sub');
				await subscriptions.insertOne({
					...input,
					id,
					status: 'pending',
					gatewayRef: null,
					checkoutUrl: null,
					history: [{ at: at(), event: 'created' }],
				});
				return /** @type {SubscriptionRecord} */ (as(await subscriptions.findOne({ websiteId, id }, NO_ID)));
			},
			/** @param {string} id @returns {Promise<SubscriptionRecord | null>} */
			get: async (id) => as(await subscriptions.findOne({ websiteId, id }, NO_ID)),
			/** @param {string} ref @returns {Promise<SubscriptionRecord | null>} */
			byRef: async (ref) => as(await subscriptions.findOne({ websiteId, gatewayRef: ref }, NO_ID)),
			/**
			 * @param {string} id @param {Partial<SubscriptionRecord>} set @param {Omit<HistoryEntry, 'at'> | null} [entry]
			 * @returns {Promise<SubscriptionRecord | null>}
			 */
			update: async (id, set, entry = null) =>
				as(
					await subscriptions.findOneAndUpdate(
						{ websiteId, id },
						{ $set: set, ...(entry ? { $push: { history: { ...entry, at: at() } } } : {}) },
						{ returnDocument: 'after', ...NO_ID },
					),
				),
			/** @param {{ after: unknown, limit: number, status?: string }} page @returns {Promise<SubscriptionRecord[]>} */
			list: async ({ after, limit, status }) =>
				as(
					await subscriptions
						.find(
							{ websiteId, ...pageFilter(after), ...(status ? { status } : {}) },
							{ ...NO_ID, sort: { createdAt: -1, id: -1 }, limit },
						)
						.toArray(),
				),
			/** @param {{ id?: string, email?: string, phone?: string }} user @returns {Promise<SubscriptionRecord[]>} */
			ofPerson: async (user) => {
				const filter = personFilter(user);
				return filter ? as(await subscriptions.find(filter, NO_ID).toArray()) : [];
			},
			/** @param {{ id?: string, email?: string, phone?: string }} user */
			anonymise: async (user) => {
				const filter = personFilter(user);
				return filter ? (await subscriptions.updateMany(filter, { $set: { customer: {} } })).modifiedCount : 0;
			},
		}),

		events: Object.freeze({
			/** @param {string} type @param {Record<string, unknown>} payload @returns {Promise<EventRecord>} */
			add: async (type, payload) => {
				const id = createId('evt');
				await events.insertOne({ id, type, data: payload, delivery: 'pending', attempts: 0, dueAt: at() });
				return as(await events.findOne({ websiteId, id }, NO_ID));
			},
			/** @param {{ after: unknown, limit: number }} page @returns {Promise<EventRecord[]>} */
			list: async ({ after, limit }) =>
				as(
					await events
						.find({ websiteId, ...pageFilter(after) }, { ...NO_ID, sort: { createdAt: -1, id: -1 }, limit })
						.toArray(),
				),
			/**
			 * Claim the oldest event due for sending (moves its due time on, so a parallel request skips it).
			 * @param {number} leaseMs
			 * @returns {Promise<EventRecord | null>}
			 */
			claimDue: async (leaseMs) =>
				as(
					await events.findOneAndUpdate(
						{ websiteId, delivery: 'pending', dueAt: { $lte: at() } },
						{ $set: { dueAt: new Date(now() + leaseMs) } },
						{ sort: { dueAt: 1 }, returnDocument: 'after', ...NO_ID },
					),
				),
			/** @param {string} id @param {Partial<EventRecord>} set */
			update: async (id, set) => {
				await events.updateOne({ websiteId, id }, { $set: set });
			},
		}),
	});
};

/** @typedef {ReturnType<typeof createStore>} Store */
