/**
 * Notifications' records in the merchant database (collections `ss_notifications_<name>`, through the kit's tenant
 * guard: every query carries the website id, inserts are stamped with `websiteId`, `merchantId` and `createdAt`).
 * The delivery log is kept forever by default (PLAN 0.8.5); with the setting "keep the delivery log for N days" (PLAN
 * 0.8.10 D11) a finished message or webhook event gets `expireAt`, and the database's expiry index removes it then.
 * No timer runs.
 *
 * - `templates`: one per key × channel × language
 * - `off_messages`: the product messages the merchant switched off, one per key × channel (parity P1)
 * - `messages`: the delivery log, one record per message with every attempt
 * - `optouts`: addresses unsubscribed from every optional message
 * - `topic_optouts`: addresses unsubscribed from one topic (fixed-choices N2), one per address × topic
 * - `recipients`: the unsubscribe code of each address that got an optional message
 * - `subscriptions`: browser push subscriptions of visitors and of the merchant's staff
 * - `webhook_events`: outgoing webhook events and their attempts
 * @module
 */
import { createId } from '@ss/contracts';
import { randomToken } from '@ss/protocol';
import { LEASE_MS } from '../core/timing.js';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/templates.js').Template} Template */
/** @typedef {import('../core/channels.js').Channel} Channel */
/** @typedef {import('../core/channels.js').Recipient} Recipient */
/** @typedef {import('../core/log.js').LogFilters} LogFilters */
/**
 * @typedef {object} Attempt
 * @property {Channel} channel
 * @property {string} provider
 * @property {Date} at
 * @property {'sent' | 'failed'} outcome
 * @property {string} [reason] a failed attempt: why, as a code (`core/gateway.js`), never a sentence
 * @property {Record<string, string>} [reasonValues] the values of its reason (for example `{ status: '503' }`)
 * @property {string} [detail] the provider's own answer, short technical text (secrets removed)
 */
/**
 * @typedef {object} MessageRecord
 * @property {string} id
 * @property {string | null} template the template key (null for a one-off message from the merchant's staff)
 * @property {string | null} fallbackTemplate the key whose website template is used when the website has none of its
 *   own for `template`, before the defaults (a product's message per status falls back to its general message)
 * @property {'api' | 'staff'} source
 * @property {Channel} channel the channel now (after a fallback, the fallback channel)
 * @property {Recipient} to
 * @property {string} address the address on `channel`
 * @property {Record<string, string>} values the values as the delivery log keeps them (hidden ones replaced)
 * @property {string} language the template version used (`''` = default)
 * @property {string} subject
 * @property {string} text
 * @property {string[]} parameters
 * @property {string} providerTemplate
 * @property {import('../core/templates.js').Button[]} buttons a WhatsApp template's buttons, values filled (PLAN 0.8.10
 *   N1)
 * @property {string[]} hidden the values the delivery log hides (PLAN 0.8.10 D11): `values`, the subject, text,
 *   parameters and buttons show them replaced
 * @property {string | null} [sealed] the real values and words of a message with hidden values, sealed, while it still
 *   has attempts to make; null once it is sent, failed or skipped. Never in a delivery-log read
 * @property {Partial<Record<Channel, import('../core/templates.js').DefaultTemplate>> | null} [defaults] a product's message: the defaults its send carried,
 *   kept while it may still move to its fallback channel (parity P1); null once it is sent, failed, skipped or moved
 * @property {string[]} [longValues] a product's message with long values: their names (they are cut to fit on a channel
 *   with a shorter limit, the fallback channel too)
 * @property {boolean} required
 * @property {boolean} urgent
 * @property {import('../core/log.js').MessageStatus} status
 * @property {string | null} reason why it failed or was skipped, as a code (`core/gateway.js`), never a sentence
 * @property {Record<string, string> | null} reasonValues the values of its reason (for example the template keys of
 *   `not_set_up`)
 * @property {Attempt[]} attempts every attempt, on every channel
 * @property {number} channelAttempts failed attempts on `channel`
 * @property {number[]} retryDelays the retry waits (ms) on `channel`, kept from when the message was accepted (or moved
 *   to a fallback channel; fixed-choices N8)
 * @property {boolean} fellBack it moved to a fallback channel
 * @property {Channel[]} fallbackChain the fallback channels still left, in order (fixed-choices N7)
 * @property {string | null} topic its unsubscribe topic (fixed-choices N2), null: none
 * @property {boolean} capped send limits count it and may hold it back (fixed-choices N5)
 * @property {Date} dueAt
 * @property {Date | null} leaseUntil
 * @property {Date | null} sentAt
 * @property {Date | null} [expireAt] when the database removes it (set once it is sent, failed or skipped, by the
 *   delivery log's setting); null or missing: kept forever
 * @property {Date} createdAt
 */
/**
 * @typedef {{ id: string, kind: 'visitor' | 'staff', staffId: string | null, endpoint: string,
 *   keys: { p256dh: string, auth: string } }} SubscriptionRecord
 */
/**
 * @typedef {{ id: string, type: string, url: string, body: string, attempts: number, status: 'pending' | 'delivered' | 'failed',
 *   lastError: import('../core/gateway.js').Failure | null, dueAt: Date, leaseUntil: Date | null, expireAt?: Date | null }} WebhookEventRecord
 */

const TEMPLATES = 'templates';
const OFF_MESSAGES = 'off_messages';
const MESSAGES = 'messages';
const OPTOUTS = 'optouts';
const TOPIC_OPTOUTS = 'topic_optouts';
const RECIPIENTS = 'recipients';
const SUBSCRIPTIONS = 'subscriptions';
const WEBHOOK_EVENTS = 'webhook_events';

/** Merchant database indexes (created on a website's first use). @type {import('@ss/app-kit').IndexDefinition[]} */
export const INDEXES = [
	{ collection: TEMPLATES, keys: { websiteId: 1, key: 1, channel: 1, language: 1 }, name: 'template', unique: true },
	{ collection: OFF_MESSAGES, keys: { websiteId: 1, key: 1, channel: 1 }, name: 'by_message', unique: true },
	{ collection: MESSAGES, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: MESSAGES, keys: { websiteId: 1, createdAt: -1, id: -1 }, name: 'newest' },
	{ collection: MESSAGES, keys: { websiteId: 1, status: 1, dueAt: 1 }, name: 'due' },
	{ collection: MESSAGES, keys: { websiteId: 1, address: 1, sentAt: -1 }, name: 'by_address' },
	{ collection: OPTOUTS, keys: { websiteId: 1, address: 1 }, name: 'by_address', unique: true },
	{ collection: TOPIC_OPTOUTS, keys: { websiteId: 1, address: 1, topic: 1 }, name: 'by_address_topic', unique: true },
	{ collection: RECIPIENTS, keys: { websiteId: 1, address: 1 }, name: 'by_address', unique: true },
	{ collection: RECIPIENTS, keys: { websiteId: 1, code: 1 }, name: 'by_code', unique: true },
	{ collection: SUBSCRIPTIONS, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: SUBSCRIPTIONS, keys: { websiteId: 1, staffId: 1 }, name: 'by_staff' },
	{ collection: WEBHOOK_EVENTS, keys: { websiteId: 1, status: 1, dueAt: 1 }, name: 'due' },
	{ collection: MESSAGES, keys: { expireAt: 1 }, name: 'expire', expireAfterSeconds: 0 },
	{ collection: WEBHOOK_EVENTS, keys: { expireAt: 1 }, name: 'expire', expireAfterSeconds: 0 },
];

/** What delivery-log reads return of a message: never the sealed real words, nor the product's defaults it keeps. */
const LOG_PROJECTION = { _id: 0, sealed: 0, defaults: 0 };

/** Most templates a website keeps (the system cap of the setting `templates.maxTemplates`). */
const MAX_TEMPLATES = 5000;
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
	buttons: 1,
	sensitive: 1,
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
	const offMessages = data.collection(OFF_MESSAGES);
	const messages = data.collection(MESSAGES);
	const optouts = data.collection(OPTOUTS);
	const topicOptouts = data.collection(TOPIC_OPTOUTS);
	const recipients = data.collection(RECIPIENTS);
	const subscriptions = data.collection(SUBSCRIPTIONS);
	const events = data.collection(WEBHOOK_EVENTS);
	/** @param {unknown} doc */
	const as = (doc) => /** @type {any} */ (doc);
	/**
	 * The Mongo filter of the delivery log: the list and its counts share it.
	 * @param {LogFilters} filters
	 * @returns {Record<string, unknown>}
	 */
	const logFilter = ({ status, channel, address }) => ({
		websiteId,
		...(status ? { status } : {}),
		...(channel ? { channel } : {}),
		...(address ? { address } : {}),
	});

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
			/**
			 * Save a template (one with the same key, channel and language is replaced).
			 * @param {Template} template
			 * @param {{ max: number }} limits the setting `templates.maxTemplates`
			 * @returns {Promise<(Template & { updatedAt: Date }) | 'full'>} the template as saved, or `full` at `max` templates
			 */
			save: async (template, { max }) => {
				const existing = await templates.countDocuments({
					websiteId,
					key: template.key,
					channel: template.channel,
					language: template.language,
				});
				if (existing === 0 && (await templates.countDocuments({ websiteId })) >= Math.min(max, MAX_TEMPLATES)) return 'full';
				await templates.updateOne(
					{ websiteId, key: template.key, channel: template.channel, language: template.language },
					{ $set: { ...template }, $setOnInsert: { createdAt: at() } },
					{ upsert: true },
				);
				return as(
					await templates.findOne(
						{ websiteId, key: template.key, channel: template.channel, language: template.language },
						{ projection: TEMPLATE_PROJECTION },
					),
				);
			},
			/** @param {string} key @param {Channel} channel @param {string} language @returns {Promise<boolean>} */
			remove: async (key, channel, language) =>
				(await templates.deleteOne({ websiteId, key, channel, language })).deletedCount === 1,
		}),

		/** Product messages switched off per channel (parity P1): such a message is skipped, never sent. */
		off: Object.freeze({
			/** @param {string} key @param {Channel} channel @returns {Promise<boolean>} */
			has: async (key, channel) => (await offMessages.countDocuments({ websiteId, key, channel }, { limit: 1 })) > 0,
			/** @returns {Promise<Array<{ key: string, channel: Channel }>>} */
			list: async () =>
				as(
					await offMessages
						.find(
							{ websiteId },
							{ projection: { _id: 0, key: 1, channel: 1 }, sort: { key: 1, channel: 1 }, limit: MAX_TEMPLATES },
						)
						.toArray(),
				),
			/**
			 * Switch a message off (`true`) or on again on a channel.
			 * @param {string} key @param {Channel} channel @param {boolean} off
			 * @returns {Promise<boolean>} whether it changed
			 */
			set: async (key, channel, off) =>
				off
					? (
							await offMessages.updateOne(
								{ websiteId, key, channel },
								{ $setOnInsert: { createdAt: at() } },
								{ upsert: true },
							)
						).upsertedCount === 1
					: (await offMessages.deleteOne({ websiteId, key, channel })).deletedCount === 1,
		}),

		messages: Object.freeze({
			/** @param {Omit<MessageRecord, 'id' | 'createdAt'>} message @returns {Promise<MessageRecord>} */
			add: async (message) => {
				const id = createId('msg');
				await messages.insertOne({ ...message, id });
				return as(await messages.findOne({ websiteId, id }, { projection: { _id: 0 } }));
			},
			/** @param {string} id @returns {Promise<MessageRecord | null>} */
			get: async (id) => as(await messages.findOne({ websiteId, id }, { projection: LOG_PROJECTION })),
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
			 * Messages send limits count (`capped`) sent to an address since a time.
			 * @param {string} address @param {number} since
			 */
			sentSince: (address, since) =>
				messages.countDocuments({ websiteId, address, capped: true, sentAt: { $gte: new Date(since) } }),
			/**
			 * Newest first, keyset-paged by `[createdAt, id]`; optional filters.
			 * @param {LogFilters & { after: unknown, limit: number }} page
			 * @returns {Promise<MessageRecord[]>}
			 */
			list: async ({ after, limit, ...filters }) => {
				const [time, id] = Array.isArray(after) ? after : [];
				const filter = logFilter(filters);
				if (typeof time === 'string' && typeof id === 'string')
					filter.$or = [{ createdAt: { $lt: new Date(time) } }, { createdAt: new Date(time), id: { $lt: id } }];
				return as(
					await messages.find(filter, { projection: LOG_PROJECTION, sort: { createdAt: -1, id: -1 }, limit }).toArray(),
				);
			},
			/**
			 * What the delivery log's counts count: the collection and exactly the list's filter (PLAN 0.8.10 K4).
			 * @param {LogFilters} filters
			 */
			countSource: (filters) => ({ collection: messages, filter: logFilter(filters) }),
			/** @param {string[]} addresses @returns {Promise<MessageRecord[]>} */
			byAddresses: async (addresses) => {
				/** @type {MessageRecord[]} */
				const out = [];
				for (const address of addresses)
					out.push(
						...as(
							await messages
								.find({ websiteId, address }, { projection: LOG_PROJECTION, sort: { createdAt: -1 } })
								.toArray(),
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
			/**
			 * Lift "every optional message" (the recipient chose topics again on the hosted page).
			 * @param {string} address
			 */
			remove: async (address) => (await optouts.deleteOne({ websiteId, address })).deletedCount === 1,
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

		/** Addresses unsubscribed from one topic (fixed-choices N2). */
		topicOptouts: Object.freeze({
			/** @param {string} address @param {string} topic */
			has: async (address, topic) => (await topicOptouts.countDocuments({ websiteId, address, topic }, { limit: 1 })) > 0,
			/**
			 * The topics an address unsubscribed from.
			 * @param {string} address
			 * @returns {Promise<string[]>}
			 */
			of: async (address) =>
				(await topicOptouts.find({ websiteId, address }, { projection: { _id: 0, topic: 1 }, limit: 100 }).toArray()).map(
					(doc) => String(doc.topic),
				),
			/**
			 * Unsubscribe an address from topics; with `only`, every other topic is subscribed again.
			 * @param {string} address @param {string[]} topics @param {'link' | 'keyword'} via
			 * @param {{ only: boolean }} options
			 * @returns {Promise<string[]>} the topics newly unsubscribed
			 */
			set: async (address, topics, via, { only }) => {
				if (only) await topicOptouts.deleteMany({ websiteId, address, topic: { $nin: topics } });
				/** @type {string[]} */
				const added = [];
				for (const topic of topics) {
					const result = await topicOptouts.updateOne(
						{ websiteId, address, topic },
						{ $setOnInsert: { via, createdAt: at() } },
						{ upsert: true },
					);
					if (result.upsertedCount === 1) added.push(topic);
				}
				return added;
			},
			/** @param {string[]} addresses */
			byAddresses: async (addresses) => {
				/** @type {Array<{ address: string, topic: string, via: string, createdAt: Date }>} */
				const out = [];
				for (const address of addresses)
					out.push(
						...as(
							await topicOptouts
								.find({ websiteId, address }, { projection: { _id: 0, address: 1, topic: 1, via: 1, createdAt: 1 } })
								.toArray(),
						),
					);
				return out;
			},
			/** @param {string[]} addresses */
			deleteByAddresses: async (addresses) => {
				let deleted = 0;
				for (const address of addresses) deleted += (await topicOptouts.deleteMany({ websiteId, address })).deletedCount;
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
				const code = randomToken(18);
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
