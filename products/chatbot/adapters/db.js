/**
 * Repositories over the merchant's own database (Part E §7), reached through app-kit `data.forWebsite(websiteId)`:
 * collections are prefixed `ss_chatbot_`, every query pins `websiteId` (app-kit's tenant guard rejects any that does
 * not), inserts are stamped with `websiteId`, `merchantId`, `env`, `createdAt`, `updatedAt` and `schemaVersion`.
 *
 * - `conversations` — one document per conversation with the denormalised summary (counts, last message, status).
 * - `messages` — a separate collection (never embedded), ordered by `(at, id)`; internal notes are `internal: true`.
 *   Conversations and messages carry `retainUntil` (TTL index) — the transcripts retention.
 * - `entries` (FAQ), `chunks` (retrieval index with term frequencies), `sources` (fetch state of web pages).
 * - `leads`, `ratings`, `agents`, `counters` (round-robin cursors, monthly token budgets).
 * - `orders`, `customers` — caches fed by `order.*@1` and `customer.*@1` events (TTL), used by the order lookup tool.
 * - `visitors` — proactive-message frequency memory (TTL).
 * @module
 */

export const SCHEMA_VERSION = 1;

export const COLLECTIONS = Object.freeze({
	conversations: 'conversations',
	messages: 'messages',
	entries: 'entries',
	chunks: 'chunks',
	sources: 'sources',
	leads: 'leads',
	ratings: 'ratings',
	agents: 'agents',
	counters: 'counters',
	orders: 'orders',
	customers: 'customers',
	visitors: 'visitors',
});

/**
 * Indexes (websiteId first everywhere; TTL indexes are single-field), created idempotently by app-kit per website.
 * @type {Array<{ collection: string, keys: Record<string, 1 | -1>, name: string, unique?: boolean, expireAfterSeconds?: number, partialFilterExpression?: Record<string, unknown> }>}
 */
export const INDEXES = /** @type {any} */ ([
	{ collection: 'conversations', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'conversations', keys: { websiteId: 1, 'last.at': -1, id: -1 }, name: 'website_last' },
	{ collection: 'conversations', keys: { websiteId: 1, status: 1, 'last.at': -1, id: -1 }, name: 'website_status_last' },
	{ collection: 'conversations', keys: { websiteId: 1, customerId: 1, 'last.at': -1 }, name: 'website_customer_last' },
	{ collection: 'conversations', keys: { websiteId: 1, visitorId: 1, 'last.at': -1 }, name: 'website_visitor_last' },
	{ collection: 'conversations', keys: { websiteId: 1, assignee: 1, status: 1 }, name: 'website_assignee_status' },
	{ collection: 'conversations', keys: { websiteId: 1, 'sla.firstResponseDueAt': 1 }, name: 'website_sla_first' },
	{ collection: 'conversations', keys: { websiteId: 1, 'handoff.at': 1, status: 1 }, name: 'website_handoff' },
	{ collection: 'conversations', keys: { retainUntil: 1 }, name: 'retain_ttl', expireAfterSeconds: 0 },
	{ collection: 'messages', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'messages', keys: { websiteId: 1, conversationId: 1, at: 1, id: 1 }, name: 'website_conversation_time' },
	{ collection: 'messages', keys: { websiteId: 1, customerId: 1 }, name: 'website_customer' },
	{ collection: 'messages', keys: { retainUntil: 1 }, name: 'retain_ttl', expireAfterSeconds: 0 },
	{ collection: 'entries', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'entries', keys: { websiteId: 1, updatedAt: -1, id: -1 }, name: 'website_updated' },
	{ collection: 'chunks', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'chunks', keys: { websiteId: 1, terms: 1 }, name: 'website_terms' },
	{ collection: 'chunks', keys: { websiteId: 1, sourceType: 1, sourceId: 1 }, name: 'website_source' },
	{ collection: 'sources', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'leads', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'leads', keys: { websiteId: 1, at: -1, id: -1 }, name: 'website_time' },
	{ collection: 'ratings', keys: { websiteId: 1, conversationId: 1 }, name: 'website_conversation', unique: true },
	{ collection: 'ratings', keys: { websiteId: 1, at: -1, id: -1 }, name: 'website_time' },
	{ collection: 'agents', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{
		collection: 'agents',
		keys: { websiteId: 1, userId: 1 },
		name: 'website_user',
		unique: true,
		partialFilterExpression: { userId: { $type: 'string' } },
	},
	{ collection: 'counters', keys: { websiteId: 1, key: 1 }, name: 'website_key', unique: true },
	{ collection: 'orders', keys: { websiteId: 1, orderId: 1 }, name: 'website_order', unique: true },
	{ collection: 'orders', keys: { websiteId: 1, customerId: 1, updatedAt: -1 }, name: 'website_customer' },
	{ collection: 'orders', keys: { websiteId: 1, 'customer.subject': 1 }, name: 'website_subject' },
	{ collection: 'orders', keys: { websiteId: 1, 'customer.email': 1 }, name: 'website_email' },
	{ collection: 'orders', keys: { expiresAt: 1 }, name: 'expires_ttl', expireAfterSeconds: 0 },
	{ collection: 'customers', keys: { websiteId: 1, customerId: 1 }, name: 'website_customer', unique: true },
	{ collection: 'customers', keys: { websiteId: 1, emails: 1 }, name: 'website_emails' },
	{ collection: 'customers', keys: { expiresAt: 1 }, name: 'expires_ttl', expireAfterSeconds: 0 },
	{ collection: 'visitors', keys: { websiteId: 1, key: 1 }, name: 'website_key', unique: true },
	{ collection: 'visitors', keys: { expiresAt: 1 }, name: 'expires_ttl', expireAfterSeconds: 0 },
]);

/** Lazy, versioned migrations (app-kit runs them once per website under a lock). */
export const MIGRATIONS = [
	{
		version: 1,
		name: 'conversation_defaults',
		up: async (/** @type {any} */ scope) => {
			await scope
				.collection(COLLECTIONS.conversations)
				.updateMany(
					{ websiteId: scope.websiteId, tags: { $exists: false } },
					{ $set: { tags: [], toolCalls: 0, tokens: 0 } },
				);
		},
	},
];

/** Fields the repositories never return. */
const INTERNAL = new Set([
	'_id',
	'websiteId',
	'merchantId',
	'env',
	'schemaVersion',
	'retainUntil',
	'expiresAt',
	'createdAt',
	'updatedAt',
]);

/**
 * @param {Record<string, any> | null} doc
 * @returns {any}
 */
const strip = (doc) => (doc ? Object.fromEntries(Object.entries(doc).filter(([key]) => !INTERNAL.has(key))) : null);

/**
 * A snoozed conversation whose `snoozedUntil` has passed reads as open even before the maintenance wakes it.
 * @param {any} conversation
 * @param {string} at ISO instant
 */
export const awake = (conversation, at) =>
	conversation?.status === 'snoozed' && typeof conversation.snoozedUntil === 'string' && conversation.snoozedUntil <= at
		? { ...conversation, status: 'open', snoozedUntil: null }
		: conversation;

/**
 * Status filter that sees through expired snoozes: `open` includes snoozed conversations that are due, `snoozed`
 * excludes them.
 * @param {string[]} statuses
 * @param {string} at ISO instant
 * @returns {Record<string, unknown>}
 */
export const statusFilter = (statuses, at) => {
	const open = statuses.includes('open');
	const snoozed = statuses.includes('snoozed');
	if (open === snoozed) return { status: { $in: statuses } };
	const others = statuses.filter((status) => status !== 'snoozed');
	return {
		$or: [
			...(others.length > 0 ? [{ status: { $in: others } }] : []),
			{ status: 'snoozed', snoozedUntil: open ? { $lte: at } : { $gt: at } },
		],
	};
};

/** @param {unknown} error */
export const isDuplicateKey = (error) => /** @type {{ code?: number }} */ (error)?.code === 11000;

/**
 * Keyset cursor `<at>|<id>` → filter on (field desc, id desc) or (asc).
 * @param {string | null | undefined} cursor
 * @param {string} field
 * @param {'desc' | 'asc'} order
 */
const keyset = (cursor, field, order) => {
	if (typeof cursor !== 'string' || !cursor.includes('|')) return {};
	const index = cursor.lastIndexOf('|');
	const at = cursor.slice(0, index);
	const id = cursor.slice(index + 1);
	const op = order === 'desc' ? '$lt' : '$gt';
	return { $or: [{ [field]: { [op]: at } }, { [field]: at, id: { [op]: id } }] };
};

/**
 * @typedef {object} Scope app-kit website data scope (guarded collections)
 * @property {string} websiteId
 * @property {(name: string) => any} collection
 */

/**
 * Repositories of one website.
 * @param {Scope} scope
 * @param {{ now?: () => number, stamp?: { merchantId?: string, env?: string } }} [options]
 */
export const createRepositories = (scope, { now = Date.now, stamp = {} } = {}) => {
	const { websiteId } = scope;
	if (typeof websiteId !== 'string' || websiteId.length === 0) throw new TypeError('websiteId is required');
	const c = Object.fromEntries(Object.values(COLLECTIONS).map((name) => [name, scope.collection(name)]));
	/** @param {Record<string, unknown>} doc */
	const onInsert = (doc) => ({ ...stamp, createdAt: new Date(now()), schemaVersion: SCHEMA_VERSION, ...doc });

	return Object.freeze({
		websiteId,
		conversations: Object.freeze({
			/** @param {Record<string, any>} conversation @param {Date} retainUntil @returns {Promise<boolean>} */
			insert: async (conversation, retainUntil) => {
				const result = await c.conversations.updateOne(
					{ websiteId, id: conversation.id },
					{ $setOnInsert: onInsert({ ...conversation, retainUntil }) },
					{ upsert: true },
				);
				return (result.upsertedCount ?? 0) > 0;
			},
			/**
			 * A conversation; a snooze that has passed is ended on access (and reads as open if that write loses a race).
			 * @param {string} id
			 */
			get: async (id) => {
				const doc = strip(await c.conversations.findOne({ websiteId, id }));
				const at = new Date(now()).toISOString();
				if (awake(doc, at) === doc) return doc;
				const woken = await c.conversations.findOneAndUpdate(
					{ websiteId, id, status: 'snoozed', snoozedUntil: { $lte: at } },
					{ $set: { status: 'open', snoozedUntil: null } },
					{ returnDocument: 'after' },
				);
				return awake(strip(woken) ?? doc, at);
			},
			/**
			 * Apply a summary change atomically (`$set` + `$inc`), optionally only from given statuses.
			 * @param {string} id
			 * @param {{ set?: Record<string, unknown>, inc?: Record<string, number>, push?: Record<string, unknown>, ifStatus?: string[], unless?: Record<string, unknown> }} change
			 * @returns {Promise<any>} the updated conversation, or null when the guard did not match
			 */
			update: async (id, { set = {}, inc = {}, push, ifStatus, unless }) => {
				const filter = { websiteId, id, ...(ifStatus ? { status: { $in: ifStatus } } : {}), ...(unless ?? {}) };
				const update = {
					...(Object.keys(set).length > 0 ? { $set: set } : {}),
					...(Object.keys(inc).length > 0 ? { $inc: inc } : {}),
					...(push ? { $push: push } : {}),
				};
				if (Object.keys(update).length === 0) return strip(await c.conversations.findOne(filter));
				return strip(await c.conversations.findOneAndUpdate(filter, update, { returnDocument: 'after' }));
			},
			/**
			 * Newest activity first, keyset cursor `<last.at>|<id>`.
			 * @param {{ customerId?: string | null, visitorId?: string | null, owners?: Array<Record<string, string>>, status?: string | string[] | null,
			 *   assignee?: string | null, team?: string | null, waiting?: boolean, after?: string | null, fetchLimit: number }} query
			 */
			list: async ({ customerId, visitorId, owners, status, assignee, team, waiting, after, fetchLimit }) => {
				/** @type {Record<string, unknown>} */
				const filter = { websiteId };
				if (owners) filter.$and = [{ $or: owners }];
				if (customerId) filter.customerId = customerId;
				if (visitorId) filter.visitorId = visitorId;
				const at = new Date(now()).toISOString();
				if (status)
					filter.$and = [
						.../** @type {any[]} */ (filter.$and ?? []),
						statusFilter(Array.isArray(status) ? status : [status], at),
					];
				if (assignee !== undefined && assignee !== null) filter.assignee = assignee === 'none' ? null : assignee;
				if (team) filter.team = team;
				if (waiting) Object.assign(filter, { 'handoff.at': { $type: 'string' }, assignee: null, status: { $in: ['open'] } });
				const page = keyset(after, 'last.at', 'desc');
				if (page.$or) filter.$and = [.../** @type {any[]} */ (filter.$and ?? []), page];
				const docs = await c.conversations.find(filter, { sort: { 'last.at': -1, id: -1 }, limit: fetchLimit }).toArray();
				return docs.map((/** @type {any} */ doc) => awake(strip(doc), at));
			},
			/** Open conversations of an owner. @param {Array<Record<string, string>>} owners */
			countOpen: async (owners) =>
				owners.length === 0
					? 0
					: c.conversations.countDocuments({ websiteId, $or: owners, status: { $in: ['open', 'pending', 'snoozed'] } }),
			/**
			 * Move a guest's conversations to the signed-in customer.
			 * @param {string} visitorId
			 * @param {string} customerId
			 */
			claim: async (visitorId, customerId) => {
				const result = await c.conversations.updateMany({ websiteId, visitorId, customerId: null }, { $set: { customerId } });
				await c.messages.updateMany({ websiteId, visitorId, customerId: null }, { $set: { customerId } });
				return result.modifiedCount ?? 0;
			},
			/** Open conversations per agent. @returns {Promise<Record<string, number>>} */
			loads: async () => {
				const rows = await c.conversations
					.aggregate([
						{ $match: { websiteId, status: { $in: ['open', 'pending'] }, assignee: { $type: 'string' } } },
						{ $group: { _id: '$assignee', n: { $sum: 1 } } },
					])
					.toArray();
				return Object.fromEntries(rows.map((/** @type {any} */ r) => [r._id, r.n]));
			},
			/** Waiting conversations handed off before an instant (queue position). @param {string} at */
			waitingBefore: async (at) =>
				c.conversations.countDocuments({ websiteId, status: 'open', assignee: null, 'handoff.at': { $lt: at } }),
			/** Conversations with a running SLA that may have breached. @param {string} at @param {number} limit */
			slaCandidates: async (at, limit) =>
				(
					await c.conversations
						.find(
							{
								websiteId,
								status: { $nin: ['closed'] },
								$or: [{ 'sla.firstResponseDueAt': { $lte: at } }, { 'sla.resolutionDueAt': { $lte: at } }],
							},
							{ limit },
						)
						.toArray()
				).map(strip),
			/** Conversations idle in resolved / pending since an instant (auto-close). @param {string} before @param {number} limit */
			idle: async (before, limit) =>
				(
					await c.conversations
						.find({ websiteId, status: { $in: ['resolved', 'pending'] }, 'last.at': { $lt: before } }, { limit })
						.toArray()
				).map(strip),
			/** Snoozed conversations to wake. @param {string} at @param {number} limit */
			dueSnoozed: async (at, limit) =>
				(await c.conversations.find({ websiteId, status: 'snoozed', snoozedUntil: { $lte: at } }, { limit }).toArray()).map(
					strip,
				),
			/** KPI counts. @param {string} since ISO */
			stats: async (since) => {
				const [open, waiting, recent, breaches] = await Promise.all([
					c.conversations.countDocuments({ websiteId, status: { $in: ['open', 'pending'] } }),
					c.conversations.countDocuments({ websiteId, status: 'open', assignee: null, 'handoff.at': { $type: 'string' } }),
					c.conversations.countDocuments({ websiteId, openedAt: { $gte: since } }),
					c.conversations.countDocuments({ websiteId, status: { $ne: 'closed' }, 'sla.breached.0': { $exists: true } }),
				]);
				return { open, waiting, recent, breaches };
			},
		}),
		messages: Object.freeze({
			/**
			 * Store messages (idempotent per id).
			 * @param {Array<Record<string, any>>} messages
			 * @param {{ retainUntil: Date, visitorId?: string | null }} options
			 */
			insert: async (messages, { retainUntil, visitorId = null }) => {
				for (const message of messages)
					await c.messages.updateOne(
						{ websiteId, id: message.id },
						{ $setOnInsert: onInsert({ ...message, visitorId, retainUntil }) },
						{ upsert: true },
					);
			},
			/**
			 * A page of a conversation: newest `limit` (default), older than `before` (a message id), or newer than `since`.
			 * @param {string} conversationId
			 * @param {{ since?: string | null, before?: string | null, limit: number, includeInternal?: boolean }} query
			 * @returns {Promise<{ items: any[], hasMoreOlder: boolean }>}
			 */
			page: async (conversationId, { since = null, before = null, limit, includeInternal = false }) => {
				/** @type {Record<string, unknown>} */
				const filter = { websiteId, conversationId, ...(includeInternal ? {} : { internal: { $ne: true } }) };
				if (since) {
					// inclusive: re-deliver the boundary message rather than risk skipping one in the same millisecond
					const items = await c.messages
						.find({ ...filter, at: { $gte: since } }, { sort: { at: 1, id: 1 }, limit: limit + 1 })
						.toArray();
					return { items: items.slice(0, limit).map(strip), hasMoreOlder: false };
				}
				if (before) {
					const pivot = await c.messages.findOne({ websiteId, conversationId, id: before });
					if (!pivot) return { items: [], hasMoreOlder: false };
					Object.assign(filter, { $or: [{ at: { $lt: pivot.at } }, { at: pivot.at, id: { $lt: pivot.id } }] });
				}
				const docs = await c.messages.find(filter, { sort: { at: -1, id: -1 }, limit: limit + 1 }).toArray();
				return { items: docs.slice(0, limit).reverse().map(strip), hasMoreOlder: docs.length > limit };
			},
			/** Last `n` visible messages (oldest first). @param {string} conversationId @param {number} n */
			recent: async (conversationId, n) =>
				(
					await c.messages
						.find({ websiteId, conversationId, internal: { $ne: true } }, { sort: { at: -1, id: -1 }, limit: n })
						.toArray()
				)
					.reverse()
					.map(strip),
			/** Internal notes. @param {string} conversationId */
			notes: async (conversationId) =>
				(
					await c.messages
						.find({ websiteId, conversationId, internal: true }, { sort: { at: 1, id: 1 }, limit: 500 })
						.toArray()
				).map(strip),
			/** Every message for a transcript. @param {string} conversationId @param {{ max: number, includeInternal: boolean }} options */
			all: async (conversationId, { max, includeInternal }) =>
				(
					await c.messages
						.find(
							{ websiteId, conversationId, ...(includeInternal ? {} : { internal: { $ne: true } }) },
							{ sort: { at: 1, id: 1 }, limit: max },
						)
						.toArray()
				).map(strip),
			/** Extend retention of a conversation's messages. @param {string} conversationId @param {Date} retainUntil */
			retain: async (conversationId, retainUntil) => {
				await c.messages.updateMany({ websiteId, conversationId }, { $set: { retainUntil } });
			},
			/** @param {string} id */
			get: async (id) => strip(await c.messages.findOne({ websiteId, id })),
		}),
		entries: Object.freeze({
			/** @param {Record<string, any>} entry @returns {Promise<boolean>} */
			insert: async (entry) => {
				const result = await c.entries.updateOne(
					{ websiteId, id: entry.id },
					{ $setOnInsert: onInsert(entry) },
					{ upsert: true },
				);
				return (result.upsertedCount ?? 0) > 0;
			},
			/** @param {string} id */
			get: async (id) => strip(await c.entries.findOne({ websiteId, id, deletedAt: null })),
			/** @param {string} id @param {Record<string, unknown>} set */
			update: async (id, set) =>
				strip(
					await c.entries.findOneAndUpdate({ websiteId, id, deletedAt: null }, { $set: set }, { returnDocument: 'after' }),
				),
			/** Soft delete. @param {string} id @param {string} at */
			remove: async (id, at) => {
				const result = await c.entries.updateOne(
					{ websiteId, id, deletedAt: null },
					{ $set: { deletedAt: at, enabled: false } },
				);
				return (result.matchedCount ?? 0) > 0;
			},
			/** @param {{ after?: string | null, fetchLimit: number }} page */
			list: async ({ after, fetchLimit }) =>
				(
					await c.entries
						.find(
							{ websiteId, deletedAt: null, ...(after ? { id: { $gt: after } } : {}) },
							{ sort: { id: 1 }, limit: fetchLimit },
						)
						.toArray()
				).map(strip),
			count: async () => c.entries.countDocuments({ websiteId, deletedAt: null }),
			/** Hard-delete entries soft-deleted before an instant (retention). @param {string} before */
			purgeDeleted: async (before) =>
				(await c.entries.deleteMany({ websiteId, deletedAt: { $lt: before } })).deletedCount ?? 0,
		}),
		chunks: Object.freeze({
			/**
			 * Replace the chunks of a source.
			 * @param {'faq' | 'page'} sourceType
			 * @param {string} sourceId
			 * @param {Array<Record<string, any>>} chunks with ids
			 */
			replace: async (sourceType, sourceId, chunks) => {
				const keep = chunks.map((chunk) => chunk.id);
				for (const chunk of chunks)
					await c.chunks.updateOne(
						{ websiteId, id: chunk.id },
						{ $set: { ...chunk }, $setOnInsert: { ...stamp, schemaVersion: SCHEMA_VERSION } },
						{ upsert: true },
					);
				await c.chunks.deleteMany({ websiteId, sourceType, sourceId, id: { $nin: keep } });
			},
			/** @param {'faq' | 'page'} sourceType @param {string} sourceId */
			removeSource: async (sourceType, sourceId) => {
				await c.chunks.deleteMany({ websiteId, sourceType, sourceId });
			},
			/** Chunks sharing a term with the query. @param {string[]} terms @param {number} limit */
			candidates: async (terms, limit) =>
				terms.length === 0 ? [] : (await c.chunks.find({ websiteId, terms: { $in: terms } }, { limit }).toArray()).map(strip),
			/** Collection statistics for BM25. @param {string[]} terms */
			stats: async (terms) => {
				const [row] = await c.chunks
					.aggregate([{ $match: { websiteId } }, { $group: { _id: null, count: { $sum: 1 }, avg: { $avg: '$length' } } }])
					.toArray();
				const df = Object.fromEntries(
					await Promise.all(terms.map(async (term) => [term, await c.chunks.countDocuments({ websiteId, terms: term })])),
				);
				return { count: row?.count ?? 0, avgLength: row?.avg ?? 0, df };
			},
			count: async () => c.chunks.countDocuments({ websiteId }),
		}),
		sources: Object.freeze({
			/** @param {string} id */
			get: async (id) => strip(await c.sources.findOne({ websiteId, id })),
			/** @param {string} id @param {Record<string, unknown>} set */
			save: async (id, set) => {
				await c.sources.updateOne(
					{ websiteId, id },
					{ $set: set, $setOnInsert: { ...stamp, schemaVersion: SCHEMA_VERSION } },
					{ upsert: true },
				);
			},
			all: async () => (await c.sources.find({ websiteId }, { sort: { id: 1 }, limit: 500 }).toArray()).map(strip),
		}),
		leads: Object.freeze({
			/** @param {Record<string, any>} lead @returns {Promise<boolean>} */
			insert: async (lead) => {
				const result = await c.leads.updateOne(
					{ websiteId, id: lead.id },
					{ $setOnInsert: onInsert(lead) },
					{ upsert: true },
				);
				return (result.upsertedCount ?? 0) > 0;
			},
			/** @param {string} id */
			get: async (id) => strip(await c.leads.findOne({ websiteId, id })),
			/** @param {{ after?: string | null, fetchLimit: number }} page */
			list: async ({ after, fetchLimit }) =>
				(
					await c.leads
						.find({ websiteId, ...keyset(after, 'at', 'desc') }, { sort: { at: -1, id: -1 }, limit: fetchLimit })
						.toArray()
				).map(strip),
			/** @param {string} since */
			countSince: async (since) => c.leads.countDocuments({ websiteId, at: { $gte: since } }),
		}),
		ratings: Object.freeze({
			/** @param {Record<string, any>} rating @returns {Promise<boolean>} false when the conversation was rated already */
			insert: async (rating) => {
				const result = await c.ratings.updateOne(
					{ websiteId, conversationId: rating.conversationId },
					{ $setOnInsert: onInsert(rating) },
					{ upsert: true },
				);
				return (result.upsertedCount ?? 0) > 0;
			},
			/** @param {{ after?: string | null, fetchLimit: number }} page */
			list: async ({ after, fetchLimit }) =>
				(
					await c.ratings
						.find({ websiteId, ...keyset(after, 'at', 'desc') }, { sort: { at: -1, id: -1 }, limit: fetchLimit })
						.toArray()
				).map(strip),
			/** @param {string} since */
			since: async (since) =>
				(await c.ratings.find({ websiteId, at: { $gte: since } }, { limit: 10_000 }).toArray()).map(strip),
		}),
		agents: Object.freeze({
			/** @param {Record<string, any>} agent @returns {Promise<boolean>} */
			insert: async (agent) => {
				try {
					await c.agents.insertOne({ ...agent });
					return true;
				} catch (error) {
					if (isDuplicateKey(error)) return false;
					throw error;
				}
			},
			/** @param {string} id */
			get: async (id) => strip(await c.agents.findOne({ websiteId, id, deletedAt: null })),
			/** @param {string} userId */
			byUser: async (userId) => strip(await c.agents.findOne({ websiteId, userId, deletedAt: null })),
			/** @param {string} id @param {Record<string, unknown>} set */
			update: async (id, set) =>
				strip(
					await c.agents.findOneAndUpdate({ websiteId, id, deletedAt: null }, { $set: set }, { returnDocument: 'after' }),
				),
			/** @param {string} id @param {string} at */
			remove: async (id, at) => {
				const result = await c.agents.updateOne(
					{ websiteId, id, deletedAt: null },
					{ $set: { deletedAt: at, active: false, status: 'offline' } },
				);
				return (result.matchedCount ?? 0) > 0;
			},
			all: async () =>
				(await c.agents.find({ websiteId, deletedAt: null }, { sort: { id: 1 }, limit: 1000 }).toArray()).map(strip),
			/** @param {{ after?: string | null, fetchLimit: number }} page */
			list: async ({ after, fetchLimit }) =>
				(
					await c.agents
						.find(
							{ websiteId, deletedAt: null, ...(after ? { id: { $gt: after } } : {}) },
							{ sort: { id: 1 }, limit: fetchLimit },
						)
						.toArray()
				).map(strip),
			count: async () => c.agents.countDocuments({ websiteId, deletedAt: null }),
			/** Hard-delete agents removed before an instant (retention). @param {string} before */
			purgeDeleted: async (before) => (await c.agents.deleteMany({ websiteId, deletedAt: { $lt: before } })).deletedCount ?? 0,
		}),
		counters: Object.freeze({
			/**
			 * Atomically add to a counter; returns the new value.
			 * @param {string} key
			 * @param {number} by
			 */
			add: async (key, by) => {
				const doc = await c.counters.findOneAndUpdate(
					{ websiteId, key },
					{ $inc: { value: by }, $setOnInsert: { ...stamp, schemaVersion: SCHEMA_VERSION } },
					{ upsert: true, returnDocument: 'after' },
				);
				return Number(doc?.value ?? by);
			},
			/** @param {string} key */
			get: async (key) => Number((await c.counters.findOne({ websiteId, key }))?.value ?? 0),
		}),
		orders: Object.freeze({
			/**
			 * Merge an order event into the cache.
			 * @param {string} orderId
			 * @param {{ set: Record<string, unknown>, inc?: Record<string, number>, expiresAt: Date }} change
			 */
			upsert: async (orderId, { set, inc, expiresAt }) => {
				await c.orders.updateOne(
					{ websiteId, orderId },
					{
						$set: { ...set, expiresAt },
						...(inc ? { $inc: inc } : {}),
						// defaults for a first event, without the fields this event sets (no update path conflicts)
						$setOnInsert: Object.fromEntries(
							Object.entries({ ...stamp, schemaVersion: SCHEMA_VERSION, lines: [], refunded: 0, status: 'placed' }).filter(
								([field]) => !(field in set) && !(inc && field in inc),
							),
						),
					},
					{ upsert: true },
				);
			},
			/**
			 * Orders of a verified customer (by customer id, federated subject or verified e-mail), newest first.
			 * @param {{ customerIds: string[], subject: string | null, email: string | null }} who
			 * @param {number} limit
			 */
			forCustomer: async ({ customerIds, subject, email }, limit) => {
				/** @type {Array<Record<string, unknown>>} */
				const or = [];
				if (customerIds.length > 0)
					or.push({ customerId: { $in: customerIds } }, { 'customer.customerId': { $in: customerIds } });
				if (subject) or.push({ 'customer.subject': subject });
				if (email) or.push({ 'customer.email': email });
				if (or.length === 0) return [];
				return (await c.orders.find({ websiteId, $or: or }, { sort: { updatedAt: -1 }, limit }).toArray()).map(strip);
			},
			/** @param {string} number */
			byNumber: async (number) =>
				(await c.orders.find({ websiteId, $or: [{ number }, { orderId: number }] }, { limit: 5 }).toArray()).map(strip),
		}),
		customers: Object.freeze({
			/** @param {string} customerId @param {{ emails?: string[], expiresAt: Date }} change */
			upsert: async (customerId, { emails = [], expiresAt }) => {
				await c.customers.updateOne(
					{ websiteId, customerId },
					{
						$set: { expiresAt },
						...(emails.length > 0 ? { $addToSet: { emails: { $each: emails } } } : {}),
						$setOnInsert: { ...stamp, schemaVersion: SCHEMA_VERSION },
					},
					{ upsert: true },
				);
			},
			/** Customer ids known for an e-mail. @param {string} email */
			idsForEmail: async (email) =>
				(await c.customers.find({ websiteId, emails: email }, { limit: 10 }).toArray()).map((/** @type {any} */ d) =>
					String(d.customerId),
				),
		}),
		visitors: Object.freeze({
			/** @param {string} key */
			get: async (key) => strip(await c.visitors.findOne({ websiteId, key })),
			/** @param {string} key @param {Record<string, unknown>} memory @param {Date} expiresAt */
			save: async (key, memory, expiresAt) => {
				await c.visitors.updateOne(
					{ websiteId, key },
					{ $set: { memory, expiresAt }, $setOnInsert: { ...stamp, schemaVersion: SCHEMA_VERSION } },
					{ upsert: true },
				);
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
