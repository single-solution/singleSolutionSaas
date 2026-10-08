/**
 * Notifications' records in the merchant database (collections `ss_notifications_<name>`, through the kit's tenant
 * guard: every query carries the website id, inserts are stamped with `websiteId`, `merchantId` and `createdAt`).
 * Nothing here expires: the delivery log is kept forever (PLAN 0.8.5).
 *
 * - `templates`: one per key × channel × language
 * - `messages`: the delivery log, one record per message with every attempt
 * - `optouts`: unsubscribed addresses
 * - `recipients`: the unsubscribe code of each address that got an optional message
 * - `subscriptions`: browser push subscriptions of visitors and of the merchant's staff
 * - `webhook_events`: outgoing webhook events and their attempts
 * @module
 */
import { randomBytes } from 'node:crypto';
import { createId } from '@ss/contracts';
import { LEASE_MS } from '../core/timing.js';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/templates.js').Template} Template */
/** @typedef {import('../core/channels.js').Channel} Channel */
/** @typedef {import('../core/channels.js').Recipient} Recipient */
/**
 * @typedef {object} Attempt
 * @property {Channel} channel
 * @property {string} provider
 * @property {Date} at
 * @property {'sent' | 'failed'} outcome
 * @property {string} [error]
 */
/**
 * @typedef {object} MessageRecord
 * @property {string} id
 * @property {string | null} template the template key (null for a one-off message from the merchant's staff)
 * @property {'api' | 'staff'} source
 * @property {Channel} channel the channel now (after a fallback, the fallback channel)
 * @property {Recipient} to
 * @property {string} address the address on `channel`
 * @property {Record<string, string>} values
 * @property {string} language the template version used (`''` = default)
 * @property {string} subject
 * @property {string} text
 * @property {string[]} parameters
 * @property {string} providerTemplate
 * @property {boolean} required
 * @property {boolean} urgent
 * @property {'queued' | 'retrying' | 'sent' | 'failed' | 'skipped'} status
 * @property {string | null} reason why it failed or was skipped
 * @property {Attempt[]} attempts every attempt, on every channel
 * @property {number} channelAttempts failed attempts on `channel`
 * @property {boolean} fellBack
 * @property {Date} dueAt
 * @property {Date | null} leaseUntil
 * @property {Date | null} sentAt
 * @property {Date} createdAt
 */
/**
 * @typedef {{ id: string, kind: 'visitor' | 'staff', staffId: string | null, endpoint: string,
 *   keys: { p256dh: string, auth: string } }} SubscriptionRecord
 */
/**
 * @typedef {{ id: string, type: string, url: string, body: string, attempts: number, status: 'pending' | 'delivered' | 'failed',
 *   lastError: string | null, dueAt: Date, leaseUntil: Date | null }} WebhookEventRecord
 */

const TEMPLATES = 'templates';
const MESSAGES = 'messages';
const OPTOUTS = 'optouts';
const RECIPIENTS = 'recipients';
const SUBSCRIPTIONS = 'subscriptions';
const WEBHOOK_EVENTS = 'webhook_events';

/** Merchant database indexes (created on a website's first use). @type {import('@ss/app-kit').IndexDefinition[]} */
export const INDEXES = [
	{ collection: TEMPLATES, keys: { websiteId: 1, key: 1, channel: 1, language: 1 }, name: 'template', unique: true },
	{ collection: MESSAGES, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: MESSAGES, keys: { websiteId: 1, createdAt: -1, id: -1 }, name: 'newest' },
	{ collection: MESSAGES, keys: { websiteId: 1, status: 1, dueAt: 1 }, name: 'due' },
	{ collection: MESSAGES, keys: { websiteId: 1, address: 1, sentAt: -1 }, name: 'by_address' },
	{ collection: OPTOUTS, keys: { websiteId: 1, address: 1 }, name: 'by_address', unique: true },
	{ collection: RECIPIENTS, keys: { websiteId: 1, address: 1 }, name: 'by_address', unique: true },
	{ collection: RECIPIENTS, keys: { websiteId: 1, code: 1 }, name: 'by_code', unique: true },
	{ collection: SUBSCRIPTIONS, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: SUBSCRIPTIONS, keys: { websiteId: 1, staffId: 1 }, name: 'by_staff' },
	{ collection: WEBHOOK_EVENTS, keys: { websiteId: 1, status: 1, dueAt: 1 }, name: 'due' },
];

const MAX_TEMPLATES = 1000;
const TEMPLATE_PROJECTION = {
	_id: 0,
	key: 1,
	channel: 1,
	language: 1,
	subject: 1,
	text: 1,
	required: 1,
	urgent: 1,
	providerTemplate: 1,
	updatedAt: 1,
};

/**
 * @param {WebsiteData} data the website's guarded merchant database
 * @param {{ now: () => number }} clock
 */
export const createStore = (data, { now }) => {
	const websiteId = data.websiteId;
	const at = () => new Date(now());
	const templates = data.collection(TEMPLATES);
	const messages = data.collection(MESSAGES);
	const optouts = data.collection(OPTOUTS);
	const recipients = data.collection(RECIPIENTS);
	const subscriptions = data.collection(SUBSCRIPTIONS);
	const events = data.collection(WEBHOOK_EVENTS);
	/** @param {unknown} doc */
	const as = (doc) => /** @type {any} */ (doc);

	return Object.freeze({
		templates: Object.freeze({
			/** @returns {Promise<Array<Template & { updatedAt: Date }>>} */
			list: async () =>
				as(
					await templates
						.find(
							{ websiteId },
							{ projection: TEMPLATE_PROJECTION, sort: { key: 1, channel: 1, language: 1 }, limit: MAX_TEMPLATES },
						)
						.toArray(),
				),
			/** @param {string} key @param {Channel} channel @returns {Promise<Template[]>} */
			versions: async (key, channel) =>
				as(await templates.find({ websiteId, key, channel }, { projection: TEMPLATE_PROJECTION }).toArray()),
			/** @param {Template} template @returns {Promise<'saved' | 'full'>} */
			save: async (template) => {
				const existing = await templates.countDocuments({
					websiteId,
					key: template.key,
					channel: template.channel,
					language: template.language,
				});
				if (existing === 0 && (await templates.countDocuments({ websiteId })) >= MAX_TEMPLATES) return 'full';
				await templates.updateOne(
					{ websiteId, key: template.key, channel: template.channel, language: template.language },
					{ $set: { ...template }, $setOnInsert: { createdAt: at() } },
					{ upsert: true },
				);
				return 'saved';
			},
			/** @param {string} key @param {Channel} channel @param {string} language @returns {Promise<boolean>} */
			remove: async (key, channel, language) =>
				(await templates.deleteOne({ websiteId, key, channel, language })).deletedCount === 1,
		}),

		messages: Object.freeze({
			/** @param {Omit<MessageRecord, 'id' | 'createdAt'>} message @returns {Promise<MessageRecord>} */
			add: async (message) => {
				const id = createId('msg');
				await messages.insertOne({ ...message, id });
				return as(await messages.findOne({ websiteId, id }, { projection: { _id: 0 } }));
			},
			/** @param {string} id @returns {Promise<MessageRecord | null>} */
			get: async (id) => as(await messages.findOne({ websiteId, id }, { projection: { _id: 0 } })),
			/**
			 * Save a message's new state.
			 * @param {string} id @param {Partial<MessageRecord>} patch
			 * @returns {Promise<MessageRecord>}
			 */
			update: async (id, patch) =>
				as(
					await messages.findOneAndUpdate(
						{ websiteId, id },
						{ $set: patch },
						{ returnDocument: 'after', projection: { _id: 0 } },
					),
				),
			/**
			 * Claim the next due message (queued or retrying, due now, not claimed by another request).
			 * @returns {Promise<MessageRecord | null>}
			 */
			claimDue: async () =>
				as(
					await messages.findOneAndUpdate(
						{
							websiteId,
							status: { $in: ['queued', 'retrying'] },
							dueAt: { $lte: at() },
							$or: [{ leaseUntil: null }, { leaseUntil: { $lt: at() } }],
						},
						{ $set: { leaseUntil: new Date(now() + LEASE_MS) } },
						{ sort: { dueAt: 1 }, returnDocument: 'after', projection: { _id: 0 } },
					),
				),
			/**
			 * Messages sent to an address since a time.
			 * @param {string} address @param {number} since
			 */
			sentSince: (address, since) => messages.countDocuments({ websiteId, address, sentAt: { $gte: new Date(since) } }),
			/**
			 * Newest first, keyset-paged by `[createdAt, id]`; optional filters.
			 * @param {{ after: unknown, limit: number, status?: string, channel?: string, address?: string }} page
			 * @returns {Promise<MessageRecord[]>}
			 */
			list: async ({ after, limit, status, channel, address }) => {
				const [time, id] = Array.isArray(after) ? after : [];
				/** @type {Record<string, unknown>} */
				const filter = { websiteId };
				if (status) filter.status = status;
				if (channel) filter.channel = channel;
				if (address) filter.address = address;
				if (typeof time === 'string' && typeof id === 'string')
					filter.$or = [{ createdAt: { $lt: new Date(time) } }, { createdAt: new Date(time), id: { $lt: id } }];
				return as(await messages.find(filter, { projection: { _id: 0 }, sort: { createdAt: -1, id: -1 }, limit }).toArray());
			},
			/** @param {string[]} addresses @returns {Promise<MessageRecord[]>} */
			byAddresses: async (addresses) => {
				/** @type {MessageRecord[]} */
				const out = [];
				for (const address of addresses)
					out.push(
						...as(
							await messages.find({ websiteId, address }, { projection: { _id: 0 }, sort: { createdAt: -1 } }).toArray(),
						),
					);
				return out;
			},
			/** @param {string[]} addresses @returns {Promise<number>} */
			deleteByAddresses: async (addresses) => {
				let deleted = 0;
				for (const address of addresses) deleted += (await messages.deleteMany({ websiteId, address })).deletedCount;
				return deleted;
			},
		}),

		optouts: Object.freeze({
			/** @param {string} address */
			has: async (address) => (await optouts.countDocuments({ websiteId, address })) > 0,
			/** @param {string} address @param {'link' | 'keyword'} via @returns {Promise<boolean>} true when newly unsubscribed */
			add: async (address, via) => {
				const result = await optouts.updateOne(
					{ websiteId, address },
					{ $setOnInsert: { via, createdAt: at() } },
					{ upsert: true },
				);
				return result.upsertedCount === 1;
			},
			/** @param {string[]} addresses */
			byAddresses: async (addresses) => {
				/** @type {Array<{ address: string, via: string, createdAt: Date }>} */
				const out = [];
				for (const address of addresses)
					out.push(
						...as(
							await optouts
								.find({ websiteId, address }, { projection: { _id: 0, address: 1, via: 1, createdAt: 1 } })
								.toArray(),
						),
					);
				return out;
			},
			/** @param {string[]} addresses */
			deleteByAddresses: async (addresses) => {
				let deleted = 0;
				for (const address of addresses) deleted += (await optouts.deleteMany({ websiteId, address })).deletedCount;
				return deleted;
			},
		}),

		recipients: Object.freeze({
			/**
			 * The unsubscribe code of an address (created on first use): random, so a link names no address.
			 * @param {string} address @returns {Promise<string>}
			 */
			codeOf: async (address) => {
				const found = as(await recipients.findOne({ websiteId, address }, { projection: { _id: 0, code: 1 } }));
				if (found) return found.code;
				const code = randomBytes(18).toString('base64url');
				await recipients.updateOne({ websiteId, address }, { $setOnInsert: { code, createdAt: at() } }, { upsert: true });
				return as(await recipients.findOne({ websiteId, address }, { projection: { _id: 0, code: 1 } })).code;
			},
			/** @param {string} code @returns {Promise<string | null>} the address */
			addressOf: async (code) =>
				as(await recipients.findOne({ websiteId, code }, { projection: { _id: 0, address: 1 } }))?.address ?? null,
			/** @param {string[]} addresses */
			deleteByAddresses: async (addresses) => {
				let deleted = 0;
				for (const address of addresses) deleted += (await recipients.deleteMany({ websiteId, address })).deletedCount;
				return deleted;
			},
		}),

		subscriptions: Object.freeze({
			/**
			 * Save a browser's subscription (the same endpoint keeps its id).
			 * @param {{ kind: 'visitor' | 'staff', staffId: string | null, endpoint: string, keys: { p256dh: string, auth: string } }} input
			 * @returns {Promise<string>} the subscriber id
			 */
			save: async ({ kind, staffId, endpoint, keys }) => {
				const found = as(await subscriptions.findOne({ websiteId, endpoint }, { projection: { _id: 0, id: 1 } }));
				const id = found?.id ?? createId('sub');
				await subscriptions.updateOne(
					{ websiteId, endpoint },
					{ $set: { kind, staffId, keys }, $setOnInsert: { id, createdAt: at() } },
					{ upsert: true },
				);
				return id;
			},
			/** @param {string} id @returns {Promise<SubscriptionRecord | null>} */
			get: async (id) => as(await subscriptions.findOne({ websiteId, id, kind: 'visitor' }, { projection: { _id: 0 } })),
			/** @param {string} staffId @returns {Promise<SubscriptionRecord[]>} */
			ofStaff: async (staffId) =>
				as(await subscriptions.find({ websiteId, kind: 'staff', staffId }, { projection: { _id: 0 }, limit: 20 }).toArray()),
			/** @param {string} id @param {string} [endpoint] the browser proves it holds the subscription */
			remove: async (id, endpoint) =>
				(await subscriptions.deleteOne({ websiteId, id, ...(endpoint === undefined ? {} : { endpoint }) })).deletedCount ===
				1,
		}),

		events: Object.freeze({
			/** @param {Array<{ type: string, url: string, body: string }>} list */
			add: async (list) => {
				if (list.length === 0) return;
				await events.insertMany(
					list.map((event) => ({
						...event,
						id: createId('evt'),
						attempts: 0,
						status: 'pending',
						lastError: null,
						dueAt: at(),
						leaseUntil: null,
					})),
				);
			},
			/** @returns {Promise<WebhookEventRecord | null>} */
			claimDue: async () =>
				as(
					await events.findOneAndUpdate(
						{
							websiteId,
							status: 'pending',
							dueAt: { $lte: at() },
							$or: [{ leaseUntil: null }, { leaseUntil: { $lt: at() } }],
						},
						{ $set: { leaseUntil: new Date(now() + LEASE_MS) } },
						{ sort: { dueAt: 1 }, returnDocument: 'after', projection: { _id: 0 } },
					),
				),
			/** @param {string} id @param {Partial<WebhookEventRecord>} patch */
			update: async (id, patch) => {
				await events.updateOne({ websiteId, id }, { $set: { ...patch, leaseUntil: null } });
			},
		}),
	});
};

/** @typedef {ReturnType<typeof createStore>} Store */
