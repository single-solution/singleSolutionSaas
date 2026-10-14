/**
 * Chat's records in the merchant database (collections `ss_chat_<name>`, through the kit's tenant guard: every query
 * carries the website id; inserts are stamped with `websiteId`, `merchantId`, `createdAt` and `updatedAt`).
 *
 * - `conversations` and `messages` (separate, ordered by a per-conversation `seq`); never deleted because of age
 * - `guests`: guest device keys (hash only), removed by a TTL index when the device forgets them
 * - `staff`: the merchant's staff named in tickets or by the `SS-Actor-*` headers of server calls (the kit records
 *   them), or assigned from Accounts, with presence and max chats
 * - `leads`, `saved_replies`, `entries` (knowledge), `pages` (website pages and their text), `chunks` (retrieval)
 * - `usage`: AI token counts per day and month window (and the month's cost alert)
 * - `activity`: the activity log (the kit writes it)
 * @module
 */
import { createId } from '@ss/contracts';
import { normalisePhone } from '@ss/contracts/phone';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/conversation.js').ConversationRecord} ConversationRecord */
/** @typedef {import('../core/conversation.js').MessageRecord} MessageRecord */
/** @typedef {{ id: string, name: string, email?: string, presence?: 'online' | 'away' | 'offline', checkedInAt?: Date, maxChats?: number | null }} StaffRecord */
/** @typedef {{ name?: string | null, email?: string | null, phone?: string | null }} Contact */
/** @typedef {{ id: string, conversationId: string | null, name: string | null, email: string | null, phone: string | null, message: string | null, custom: Record<string, unknown>, page: unknown, createdAt: Date }} LeadRecord */
/** @typedef {{ id: string, kind: 'faq' | 'article', title: string, text: string, updatedAt: Date }} EntryRecord */
/**
 * A website page as knowledge; a page that could not be fetched keeps why (`reason`, and the status it answered).
 * @typedef {{ id: string, url: string, title: string, text: string, status: 'ok' | 'failed',
 *   reason?: 'http_status' | 'unreachable' | null, httpStatus?: number | null, error: string | null,
 *   fetchedAt: Date | null }} PageRecord
 */

const CONVERSATIONS = 'conversations';
const MESSAGES = 'messages';
const GUESTS = 'guests';
const STAFF = 'staff';
const LEADS = 'leads';
const SAVED_REPLIES = 'saved_replies';
const ENTRIES = 'entries';
const PAGES = 'pages';
const CHUNKS = 'chunks';
const USAGE = 'usage';

/** Merchant database indexes (created on a website's first use). @type {import('@ss/app-kit').IndexDefinition[]} */
export const INDEXES = [
	{ collection: CONVERSATIONS, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{
		collection: CONVERSATIONS,
		keys: { websiteId: 1, 'visitor.kind': 1, 'visitor.id': 1, lastMessageAt: -1 },
		name: 'by_visitor',
	},
	{ collection: CONVERSATIONS, keys: { websiteId: 1, lastMessageAt: -1, id: -1 }, name: 'by_activity' },
	{ collection: CONVERSATIONS, keys: { websiteId: 1, guestIds: 1 }, name: 'by_guest' },
	{ collection: CONVERSATIONS, keys: { websiteId: 1, createdAt: 1 }, name: 'by_created' },
	{ collection: MESSAGES, keys: { websiteId: 1, conversationId: 1, seq: 1 }, name: 'by_seq', unique: true },
	// a message by its id (imports find and replace messages by id, PLAN 0.8.10 K10)
	{ collection: MESSAGES, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: GUESTS, keys: { websiteId: 1, keyHash: 1 }, name: 'by_key', unique: true },
	{ collection: GUESTS, keys: { expireAt: 1 }, name: 'ttl', expireAfterSeconds: 0 },
	{ collection: STAFF, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: LEADS, keys: { websiteId: 1, createdAt: -1, id: -1 }, name: 'by_created' },
	{ collection: SAVED_REPLIES, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: ENTRIES, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: PAGES, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: CHUNKS, keys: { websiteId: 1, terms: 1 }, name: 'by_term' },
	{ collection: CHUNKS, keys: { websiteId: 1, sourceId: 1 }, name: 'by_source' },
	{ collection: USAGE, keys: { websiteId: 1, key: 1 }, name: 'by_key', unique: true },
];

/** Fields of a record never returned to callers. */
const HIDDEN = { projection: { _id: 0, websiteId: 0, merchantId: 0 } };

/** @param {string} value */
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {WebsiteData} data
 * @param {{ now: () => number }} options
 */
export const createStore = (data, { now }) => {
	const conversations = data.collection(CONVERSATIONS);
	const messages = data.collection(MESSAGES);
	const guests = data.collection(GUESTS);
	const staff = data.collection(STAFF);
	const leads = data.collection(LEADS);
	const replies = data.collection(SAVED_REPLIES);
	const entries = data.collection(ENTRIES);
	const pages = data.collection(PAGES);
	const chunks = data.collection(CHUNKS);
	const usage = data.collection(USAGE);
	const w = data.websiteId;
	const date = () => new Date(now());

	return Object.freeze({
		conversations: Object.freeze({
			/** @param {string} id @returns {Promise<ConversationRecord | null>} */
			get: async (id) => /** @type {any} */ (await conversations.findOne({ websiteId: w, id }, HIDDEN)),
			/**
			 * The visitor's latest conversation.
			 * @param {{ kind: 'guest' | 'user', id: string }} visitor
			 * @returns {Promise<ConversationRecord | null>}
			 */
			current: async (visitor) =>
				/** @type {any} */ (
					await conversations.findOne(
						{ websiteId: w, 'visitor.kind': visitor.kind, 'visitor.id': visitor.id },
						{ ...HIDDEN, sort: { lastMessageAt: -1 } },
					)
				),
			/** @param {Omit<ConversationRecord, 'id'>} record @returns {Promise<ConversationRecord>} */
			create: async (record) => {
				const doc = { id: createId('conv'), ...record };
				await conversations.insertOne({ ...doc });
				return doc;
			},
			/**
			 * Change a conversation; answers it after the change.
			 * @param {string} id
			 * @param {{ set?: Record<string, unknown>, inc?: Record<string, number>, push?: Record<string, unknown>, unless?: Record<string, unknown> }} change
			 * @returns {Promise<ConversationRecord | null>}
			 */
			update: async (id, { set = {}, inc = {}, push = {}, unless = {} }) =>
				/** @type {any} */ (
					await conversations.findOneAndUpdate(
						{ websiteId: w, id, ...unless },
						{
							$set: { ...set, updatedAt: date() },
							...(Object.keys(inc).length > 0 ? { $inc: inc } : {}),
							...(Object.keys(push).length > 0 ? { $addToSet: push } : {}),
						},
						{ ...HIDDEN, returnDocument: 'after' },
					)
				),
			/**
			 * The inbox's filter (the list and its counts share it): the website, the field filters and a search in the
			 * visitor's name, email and phone and in visible message texts.
			 * @param {{ filter: Record<string, unknown>, q: string | null }} query
			 * @returns {Promise<Record<string, unknown>>}
			 */
			where: async ({ filter, q }) => {
				if (!q) return { websiteId: w, ...filter };
				const pattern = new RegExp(escapeRegex(q), 'i');
				const ids = await messages.distinct('conversationId', { websiteId: w, internal: false, text: pattern });
				return {
					websiteId: w,
					...filter,
					$and: [{ $or: [{ name: pattern }, { email: pattern }, { phone: pattern }, { id: { $in: ids.slice(0, 500) } }] }],
				};
			},
			/**
			 * A page of the inbox, newest activity first.
			 * @param {{ where: Record<string, unknown>, after: [string, string] | null, limit: number }} query `where` from
			 *   `where()`
			 * @returns {Promise<ConversationRecord[]>}
			 */
			list: async ({ where, after, limit }) => {
				const at = after ? new Date(after[0]) : null;
				const page = after
					? {
							$and: [
								.../** @type {unknown[]} */ (where.$and ?? []),
								{ $or: [{ lastMessageAt: { $lt: at } }, { lastMessageAt: at, id: { $lt: after[1] } }] },
							],
						}
					: {};
				return /** @type {any} */ (
					await conversations
						.find({ ...where, ...page, websiteId: w }, { ...HIDDEN, sort: { lastMessageAt: -1, id: -1 }, limit })
						.toArray()
				);
			},
			/**
			 * Visitor messages no staff member has opened, over the conversations the inbox shows (`where`, default all).
			 * @param {Record<string, unknown>} [where]
			 */
			unread: async (where = {}) => {
				const [row] = await conversations
					.aggregate([
						{ $match: { ...where, websiteId: w, unreadStaff: { $gt: 0 } } },
						{ $group: { _id: null, total: { $sum: '$unreadStaff' }, conversations: { $sum: 1 } } },
					])
					.toArray();
				return { total: Number(row?.total ?? 0), conversations: Number(row?.conversations ?? 0) };
			},
			/** Open conversations the inbox shows (`where`). @param {Record<string, unknown>} [where] */
			open: (where = {}) => conversations.countDocuments({ ...where, websiteId: w, status: 'open' }),
			/** Open conversations assigned to each staff member. @returns {Promise<Map<string, number>>} */
			openByStaff: async () => {
				const rows = await conversations
					.aggregate([
						{ $match: { websiteId: w, status: 'open', assignedTo: { $type: 'string' } } },
						{ $group: { _id: '$assignedTo', n: { $sum: 1 } } },
					])
					.toArray();
				return new Map(rows.map((row) => [String(row._id), Number(row.n)]));
			},
			/**
			 * The visitor's place in the queue: unassigned conversations waiting for a person since earlier (this handoff,
			 * not the first one, CH-5), + 1.
			 * @param {ConversationRecord} c
			 */
			queuePosition: async (c) =>
				1 +
				(await conversations.countDocuments({
					websiteId: w,
					waiting: true,
					assignedTo: null,
					status: { $ne: 'resolved' },
					waitingSince: { $lt: c.waitingSince ?? c.handedOffAt },
				})),
			/**
			 * Move a guest's conversations to an account (the same device showed both); the name, email and phone they
			 * lack come from the sign-in (CH-7).
			 * @param {string} guestId
			 * @param {string} userId
			 * @param {Contact} [contact]
			 */
			moveGuest: async (guestId, userId, contact = {}) => {
				const moved = (
					await conversations.updateMany(
						{ websiteId: w, 'visitor.kind': 'guest', 'visitor.id': guestId },
						{ $set: { visitor: { kind: 'user', id: userId }, updatedAt: date() }, $addToSet: { guestIds: guestId } },
					)
				).modifiedCount;
				for (const field of /** @type {const} */ (['name', 'email', 'phone']))
					if (contact[field])
						await conversations.updateMany(
							{ websiteId: w, 'visitor.kind': 'user', 'visitor.id': userId, guestIds: guestId, [field]: null },
							{ $set: { [field]: contact[field], updatedAt: date() } },
						);
				return moved;
			},
			/**
			 * Merge conversations into one by time (C7): their messages join the target's, in the order they were written,
			 * and are numbered again; counters, contact details (else the sign-in's, CH-7), custom fields and the guests
			 * behind them move along; the merged conversations are deleted. The status is open when the newest message is
			 * the visitor's, else the status of the conversation with the latest message (CH-7). One transaction.
			 * @param {ConversationRecord} target
			 * @param {ConversationRecord[]} sources
			 * @param {Contact} [contact]
			 * @returns {Promise<ConversationRecord | null>}
			 */
			merge: async (target, sources, contact = {}) => {
				if (sources.length === 0) return target;
				const all = [target, ...sources];
				const ids = all.map((c) => c.id);
				return data.transaction(async (session) => {
					const found = /** @type {MessageRecord[]} */ (
						/** @type {unknown} */ (
							await messages.find({ websiteId: w, conversationId: { $in: ids } }, { ...HIDDEN, session }).toArray()
						)
					);
					const order = new Map(ids.map((id, index) => [id, index]));
					found.sort(
						(a, b) =>
							new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
							Number(order.get(a.conversationId)) - Number(order.get(b.conversationId)) ||
							a.seq - b.seq,
					);
					/** @type {Map<string, number>} old conversation and seq → new seq */
					const renumbered = new Map(found.map((m, index) => [`${m.conversationId}:${m.seq}`, index + 1]));
					/** @param {ConversationRecord} c @param {number} seen */
					const seenOf = (c, seen) => {
						let best = 0;
						for (const m of found)
							if (m.conversationId === c.id && m.seq <= seen) best = Number(renumbered.get(`${c.id}:${m.seq}`));
						return best;
					};
					await messages.deleteMany({ websiteId: w, conversationId: { $in: ids } }, { session });
					if (found.length > 0)
						await messages.insertMany(
							found.map((m, index) => ({ ...m, conversationId: target.id, seq: index + 1 })),
							{ session },
						);
					const sum = (/** @type {'visitorMessages' | 'unreadStaff' | 'unreadVisitor' | 'aiReplies'} */ key) =>
						all.reduce((total, c) => total + Number(c[key] ?? 0), 0);
					/** @param {'firstVisitorAt' | 'firstStaffReplyAt' | 'handedOffAt' | 'createdAt'} key */
					const earliest = (key) =>
						all
							.map((c) => c[key])
							.filter((value) => value !== null && value !== undefined)
							.map((value) => new Date(/** @type {Date} */ (value)))
							.sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
					const latest = [...all].sort(
						(a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime(),
					)[0];
					const guests = [
						...new Set([
							...all.flatMap((c) => c.guestIds ?? []),
							...sources.filter((c) => c.visitor.kind === 'guest').map((c) => c.visitor.id),
						]),
					];
					const merged = await conversations.findOneAndUpdate(
						{ websiteId: w, id: target.id },
						{
							$set: {
								guestIds: guests,
								lastSeq: found.length,
								visitorMessages: sum('visitorMessages'),
								unreadStaff: sum('unreadStaff'),
								unreadVisitor: sum('unreadVisitor'),
								aiReplies: sum('aiReplies'),
								staffSeenSeq: Math.max(...all.map((c) => seenOf(c, Number(c.staffSeenSeq ?? 0)))),
								visitorSeenSeq: Math.max(...all.map((c) => seenOf(c, Number(c.visitorSeenSeq ?? 0)))),
								status: found.at(-1)?.author === 'visitor' ? 'open' : (latest?.status ?? target.status),
								name: all.find((c) => c.name)?.name ?? contact.name ?? null,
								email: all.find((c) => c.email)?.email ?? contact.email ?? null,
								phone: all.find((c) => c.phone)?.phone ?? contact.phone ?? null,
								fields: Object.assign({}, ...[...all].reverse().map((c) => c.fields ?? {})),
								staffReplied: all.some((c) => c.staffReplied),
								firstVisitorAt: earliest('firstVisitorAt'),
								firstStaffReplyAt: earliest('firstStaffReplyAt'),
								createdAt: earliest('createdAt'),
								lastMessageAt: latest?.lastMessageAt ?? target.lastMessageAt,
								preview: latest?.preview ?? target.preview,
								updatedAt: date(),
							},
						},
						{ ...HIDDEN, returnDocument: 'after', session },
					);
					await conversations.deleteMany({ websiteId: w, id: { $in: sources.map((c) => c.id) } }, { session });
					return /** @type {any} */ (merged);
				});
			},
			/**
			 * A guest's conversations.
			 * @param {string} guestId
			 * @returns {Promise<ConversationRecord[]>}
			 */
			ofGuest: async (guestId) =>
				/** @type {any} */ (
					await conversations
						.find({ websiteId: w, 'visitor.kind': 'guest', 'visitor.id': guestId }, { ...HIDDEN, limit: 50 })
						.toArray()
				),
			/**
			 * Guest conversations whose captured phone is this phone (both E.164, read by the shared normalizer; C7 claim
			 * by phone).
			 * @param {string} phone
			 * @returns {Promise<ConversationRecord[]>}
			 */
			guestsByPhone: async (phone) => {
				const e164 = normalisePhone(phone);
				if (!e164) return [];
				return /** @type {any} */ (
					await conversations
						.find({ websiteId: w, 'visitor.kind': 'guest', phone: e164 }, { ...HIDDEN, limit: 50 })
						.toArray()
				);
			},
			/** @param {{ kind: 'guest' | 'user', id: string }} visitor */
			countOf: (visitor) =>
				conversations.countDocuments({ websiteId: w, 'visitor.kind': visitor.kind, 'visitor.id': visitor.id }),
			/**
			 * Conversations of a person (data rights): an Accounts user id, or contact details captured from a guest.
			 * @param {{ id?: string, email?: string, phone?: string }} user
			 * @returns {Promise<ConversationRecord[]>}
			 */
			ofPerson: async (user) => {
				/** @type {Record<string, unknown>[]} */
				const or = [];
				if (user.id) or.push({ 'visitor.kind': 'user', 'visitor.id': user.id });
				if (user.email) or.push({ email: user.email.toLowerCase() });
				if (user.phone) or.push({ phone: normalisePhone(user.phone) ?? user.phone });
				if (or.length === 0) return [];
				return /** @type {any} */ (await conversations.find({ websiteId: w, $or: or }, HIDDEN).toArray());
			},
			/** @param {Date} from @param {Date} to */
			startedBetween: async (from, to) =>
				/** @type {any[]} */ (
					await conversations.find({ websiteId: w, createdAt: { $gte: from, $lt: to } }, HIDDEN).toArray()
				),
			/**
			 * Some of the website's conversations, in no set order (delete-all takes them a batch at a time, C20).
			 * @param {number} limit
			 * @returns {Promise<ConversationRecord[]>}
			 */
			some: async (limit) => /** @type {any} */ (await conversations.find({ websiteId: w }, { ...HIDDEN, limit }).toArray()),
			/**
			 * Delete conversations and their messages; answers how many of each went.
			 * @param {string[]} ids
			 */
			remove: async (ids) => {
				if (ids.length === 0) return { conversations: 0, messages: 0 };
				const removed = (await conversations.deleteMany({ websiteId: w, id: { $in: ids } })).deletedCount;
				const gone = (await messages.deleteMany({ websiteId: w, conversationId: { $in: ids } })).deletedCount;
				return { conversations: removed, messages: gone };
			},
		}),

		messages: Object.freeze({
			/** @param {MessageRecord} record */
			insert: async (record) => {
				await messages.insertOne({ ...record });
				return record;
			},
			/**
			 * Messages of a conversation in order: after a seq, else the last `limit` (before a seq when given, C8).
			 * @param {string} conversationId
			 * @param {{ after?: number | null, before?: number | null, limit: number, internal: boolean }} query
			 * @returns {Promise<MessageRecord[]>}
			 */
			list: async (conversationId, { after = null, before = null, limit, internal }) => {
				const where = { websiteId: w, conversationId, ...(internal ? {} : { internal: false }) };
				if (after !== null)
					return /** @type {any} */ (
						await messages.find({ ...where, seq: { $gt: after } }, { ...HIDDEN, sort: { seq: 1 }, limit }).toArray()
					);
				const last = await messages
					.find(before === null ? where : { ...where, seq: { $lt: before } }, { ...HIDDEN, sort: { seq: -1 }, limit })
					.toArray();
				return /** @type {any} */ (last.reverse());
			},
			/**
			 * Whether a conversation has messages before a seq.
			 * @param {string} conversationId
			 * @param {number} seq
			 * @param {boolean} internal internal notes count
			 */
			earlier: async (conversationId, seq, internal) =>
				(await messages.countDocuments(
					{ websiteId: w, conversationId, seq: { $lt: seq }, ...(internal ? {} : { internal: false }) },
					{ limit: 1 },
				)) > 0,
			/**
			 * The storage keys of the attachments in conversations.
			 * @param {string[]} conversationIds
			 * @returns {Promise<string[]>}
			 */
			attachmentKeys: async (conversationIds) =>
				(
					await messages
						.find(
							{ websiteId: w, conversationId: { $in: conversationIds }, attachment: { $ne: null } },
							{ projection: { _id: 0, 'attachment.key': 1 } },
						)
						.toArray()
				)
					.map((m) => m.attachment?.key)
					.filter((key) => typeof key === 'string'),
			/** @param {string[]} conversationIds @returns {Promise<MessageRecord[]>} */
			ofConversations: async (conversationIds) =>
				/** @type {any} */ (
					await messages
						.find({ websiteId: w, conversationId: { $in: conversationIds } }, { ...HIDDEN, sort: { seq: 1 } })
						.toArray()
				),
			/** @param {Date} from @param {Date} to */
			visitorCountBetween: (from, to) =>
				messages.countDocuments({ websiteId: w, author: 'visitor', createdAt: { $gte: from, $lt: to } }),
		}),

		guests: Object.freeze({
			/** @param {string} keyHash @returns {Promise<{ id: string } | null>} */
			byKey: async (keyHash) => /** @type {any} */ (await guests.findOne({ websiteId: w, keyHash }, HIDDEN)),
			/** @param {string} keyHash @param {Date} expireAt */
			create: async (keyHash, expireAt) => {
				const id = createId('guest');
				await guests.insertOne({ id, keyHash, expireAt });
				return { id };
			},
			/** @param {string[]} ids */
			remove: async (ids) =>
				ids.length === 0 ? 0 : (await guests.deleteMany({ websiteId: w, id: { $in: ids } })).deletedCount,
		}),

		staff: Object.freeze({
			/** @returns {Promise<StaffRecord[]>} */
			list: async () =>
				/** @type {any} */ (await staff.find({ websiteId: w }, { ...HIDDEN, sort: { name: 1 }, limit: 500 }).toArray()),
			/** @param {string} id @returns {Promise<StaffRecord | null>} */
			get: async (id) => /** @type {any} */ (await staff.findOne({ websiteId: w, id }, HIDDEN)),
			/**
			 * The inbox checked in (presence is judged from it): a ticket's user, or the acting user of a server call.
			 * @param {{ id: string, name: string, email?: string }} user
			 */
			checkIn: (user) =>
				staff.updateOne(
					{ websiteId: w, id: user.id },
					{
						$set: { name: user.name, ...(user.email ? { email: user.email } : {}), checkedInAt: date(), updatedAt: date() },
					},
					{ upsert: true },
				),
			/**
			 * Add a member of staff known from Accounts (CH-6): Offline until they check in.
			 * @param {{ id: string, name: string, email?: string }} user
			 */
			add: (user) =>
				staff.updateOne(
					{ websiteId: w, id: user.id },
					{ $set: { name: user.name, ...(user.email ? { email: user.email } : {}), updatedAt: date() } },
					{ upsert: true },
				),
			/** @param {string} id @param {Record<string, unknown>} set */
			set: async (id, set) =>
				/** @type {StaffRecord | null} */ (
					/** @type {unknown} */ (
						await staff.findOneAndUpdate(
							{ websiteId: w, id },
							{ $set: { ...set, updatedAt: date() } },
							{ ...HIDDEN, returnDocument: 'after' },
						)
					)
				),
		}),

		leads: Object.freeze({
			/** @param {Omit<LeadRecord, 'id' | 'createdAt'>} record */
			insert: async (record) => {
				const id = createId('lead');
				await leads.insertOne({ id, ...record });
				return id;
			},
			/** @param {{ after: [string, string] | null, limit: number }} query @returns {Promise<LeadRecord[]>} */
			list: async ({ after, limit }) => {
				const where = after
					? {
							websiteId: w,
							$or: [{ createdAt: { $lt: new Date(after[0]) } }, { createdAt: new Date(after[0]), id: { $lt: after[1] } }],
						}
					: { websiteId: w };
				return /** @type {any} */ (await leads.find(where, { ...HIDDEN, sort: { createdAt: -1, id: -1 }, limit }).toArray());
			},
			/** @param {string} id @returns {Promise<LeadRecord | null>} */
			get: async (id) => /** @type {any} */ (await leads.findOne({ websiteId: w, id }, HIDDEN)),
			/** @param {{ email?: string, phone?: string }} contact @param {string[]} conversationIds @returns {Promise<LeadRecord[]>} */
			ofPerson: async (contact, conversationIds) => {
				const or = [
					...(contact.email ? [{ email: contact.email.toLowerCase() }] : []),
					...(contact.phone ? [{ phone: normalisePhone(contact.phone) ?? contact.phone }] : []),
					...(conversationIds.length > 0 ? [{ conversationId: { $in: conversationIds } }] : []),
				];
				return or.length === 0 ? [] : /** @type {any} */ (await leads.find({ websiteId: w, $or: or }, HIDDEN).toArray());
			},
			/** @param {string[]} ids */
			remove: async (ids) =>
				ids.length === 0 ? 0 : (await leads.deleteMany({ websiteId: w, id: { $in: ids } })).deletedCount,
			/** @param {Date} from @param {Date} to */
			countBetween: (from, to) => leads.countDocuments({ websiteId: w, createdAt: { $gte: from, $lt: to } }),
		}),

		replies: Object.freeze({
			/** @returns {Promise<Array<{ id: string, title: string, text: string }>>} */
			list: async () =>
				/** @type {any} */ (
					await replies
						.find({ websiteId: w }, { projection: { _id: 0, id: 1, title: 1, text: 1 }, sort: { title: 1 }, limit: 500 })
						.toArray()
				),
			count: () => replies.countDocuments({ websiteId: w }),
			/** @param {{ title: string, text: string }} reply */
			create: async (reply) => {
				const doc = { id: createId('reply'), title: reply.title, text: reply.text };
				await replies.insertOne({ ...doc });
				return doc;
			},
			/** @param {string} id @param {{ title: string, text: string }} reply */
			update: async (id, reply) =>
				(await replies.updateOne({ websiteId: w, id }, { $set: { title: reply.title, text: reply.text, updatedAt: date() } }))
					.matchedCount > 0,
			/** Delete one; answers what it was, or null. @param {string} id @returns {Promise<{ id: string, title: string, text: string } | null>} */
			remove: async (id) =>
				/** @type {any} */ (
					await replies.findOneAndDelete({ websiteId: w, id }, { projection: { _id: 0, id: 1, title: 1, text: 1 } })
				),
		}),

		knowledge: Object.freeze({
			/** @param {{ q: string | null, after: [string, string] | null, limit: number }} query @returns {Promise<EntryRecord[]>} */
			entries: async ({ q, after, limit }) => {
				/** @type {Record<string, unknown>[]} */
				const and = [];
				if (q) {
					const pattern = new RegExp(escapeRegex(q), 'i');
					and.push({ $or: [{ title: pattern }, { text: pattern }] });
				}
				if (after)
					and.push({
						$or: [{ updatedAt: { $lt: new Date(after[0]) } }, { updatedAt: new Date(after[0]), id: { $lt: after[1] } }],
					});
				const where = { websiteId: w, ...(and.length > 0 ? { $and: and } : {}) };
				return /** @type {any} */ (
					await entries.find(where, { ...HIDDEN, sort: { updatedAt: -1, id: -1 }, limit }).toArray()
				);
			},
			countEntries: () => entries.countDocuments({ websiteId: w }),
			/** @param {{ kind: 'faq' | 'article', title: string, text: string }} entry @returns {Promise<EntryRecord>} */
			createEntry: async (entry) => {
				const doc = { id: createId('kb'), ...entry };
				await entries.insertOne({ ...doc });
				return { ...doc, updatedAt: date() };
			},
			/** @param {string} id @param {{ kind: 'faq' | 'article', title: string, text: string }} entry */
			updateEntry: async (id, entry) =>
				/** @type {EntryRecord | null} */ (
					/** @type {unknown} */ (
						await entries.findOneAndUpdate(
							{ websiteId: w, id },
							{ $set: { ...entry, updatedAt: date() } },
							{ ...HIDDEN, returnDocument: 'after' },
						)
					)
				),
			/** Delete one; answers what it was, or null. @param {string} id @returns {Promise<EntryRecord | null>} */
			removeEntry: async (id) => /** @type {any} */ (await entries.findOneAndDelete({ websiteId: w, id }, HIDDEN)),
			/** @returns {Promise<PageRecord[]>} */
			pages: async () =>
				/** @type {any} */ (await pages.find({ websiteId: w }, { ...HIDDEN, sort: { createdAt: -1 }, limit: 500 }).toArray()),
			countPages: () => pages.countDocuments({ websiteId: w }),
			/** @param {string} id @returns {Promise<PageRecord | null>} */
			page: async (id) => /** @type {any} */ (await pages.findOne({ websiteId: w, id }, HIDDEN)),
			/** @param {string} url */
			createPage: async (url) => {
				const doc = {
					id: createId('page'),
					url,
					title: url,
					text: '',
					status: /** @type {const} */ ('failed'),
					error: null,
					fetchedAt: null,
				};
				await pages.insertOne({ ...doc });
				return doc;
			},
			/** @param {string} id @param {Partial<PageRecord>} set @returns {Promise<PageRecord | null>} */
			updatePage: async (id, set) =>
				/** @type {any} */ (
					await pages.findOneAndUpdate(
						{ websiteId: w, id },
						{ $set: { ...set, updatedAt: date() } },
						{ ...HIDDEN, returnDocument: 'after' },
					)
				),
			/** Delete one; answers what it was, or null. @param {string} id @returns {Promise<PageRecord | null>} */
			removePage: async (id) => /** @type {any} */ (await pages.findOneAndDelete({ websiteId: w, id }, HIDDEN)),
			/**
			 * Replace the chunks of one source.
			 * @param {string} sourceId
			 * @param {import('../core/knowledge.js').ChunkDraft[]} drafts
			 */
			replaceChunks: async (sourceId, drafts) => {
				await chunks.deleteMany({ websiteId: w, sourceId });
				if (drafts.length > 0) await chunks.insertMany(drafts.map((draft, i) => ({ id: `${sourceId}:${i}`, ...draft })));
			},
			/**
			 * Chunks sharing a query term, and how many chunks there are.
			 * @param {string[]} terms
			 * @returns {Promise<{ chunks: import('../core/knowledge.js').Chunk[], count: number }>}
			 */
			search: async (terms) => ({
				chunks: /** @type {any} */ (
					await chunks.find({ websiteId: w, terms: { $in: terms } }, { ...HIDDEN, limit: 300 }).toArray()
				),
				count: await chunks.countDocuments({ websiteId: w }),
			}),
		}),

		usage: Object.freeze({
			/** @param {string[]} keys @returns {Promise<Record<string, number>>} */
			get: async (keys) => {
				const rows = await usage.find({ websiteId: w, key: { $in: keys } }, HIDDEN).toArray();
				return Object.fromEntries(keys.map((key) => [key, Number(rows.find((row) => row.key === key)?.tokens ?? 0)]));
			},
			/** Add tokens to windows; answers each window's total before. @param {string[]} keys @param {number} tokens */
			add: async (keys, tokens) => {
				/** @type {Record<string, number>} */
				const before = {};
				for (const key of keys) {
					const row = await usage.findOneAndUpdate(
						{ websiteId: w, key },
						{ $inc: { tokens }, $setOnInsert: { alerted: false } },
						{ upsert: true, returnDocument: 'before' },
					);
					before[key] = Number(row?.tokens ?? 0);
				}
				return before;
			},
			/** Mark the window's alert as sent; true for the first caller only. @param {string} key */
			markAlerted: async (key) =>
				(await usage.updateOne({ websiteId: w, key, alerted: false }, { $set: { alerted: true } })).modifiedCount > 0,
			/** @param {string[]} keys */
			total: async (keys) => {
				const rows = await usage.find({ websiteId: w, key: { $in: keys } }, HIDDEN).toArray();
				return rows.reduce((sum, row) => sum + Number(row.tokens ?? 0), 0);
			},
		}),
	});
};

/** @typedef {ReturnType<typeof createStore>} Store */
