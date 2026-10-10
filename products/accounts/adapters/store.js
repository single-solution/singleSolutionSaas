/**
 * Accounts' records in the merchant database (collections `ss_accounts_<name>`, through the kit's tenant guard: every
 * query carries the website id; inserts are stamped with `websiteId`, `merchantId`, `createdAt` and `updatedAt`).
 *
 * - `users`: the one user list of the website (shoppers and the merchant's staff), unique e-mail and phone
 * - `sessions`: signed-in devices with their rotating refresh token (hash only)
 * - `codes`: one-time codes and links (sign-in codes, magic links, resets, invites, two-step steps, social hand-overs,
 *   data exports), kept as hashes and removed by a TTL index once expired
 * - `oauth`: social sign-ins in progress (state, PKCE verifier, nonce), TTL
 * - `roles`, `fields` (custom fields), `permissions` (the merchant's own permission names)
 * - `keys`: the website's sign-in signing key (private part sealed with `ENCRYPTION_KEY`)
 * - `signups`: hashed device and network of each sign-up (risk checks), TTL 30 days
 * - `deletions`: users erased here whose erasure some connected products have not confirmed yet
 * - `copies`: the activity-log copies other products send
 * @module
 */
import { createId } from '@ss/contracts';
import { DEFAULT_ROLE, READY_ROLES } from '../core/roles.js';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/profile.js').UserRecord} UserRecord */
/** @typedef {import('../core/roles.js').Role} Role */
/** @typedef {import('../core/profile.js').CustomField} CustomField */

/**
 * @typedef {object} SessionRecord
 * @property {string} id
 * @property {string} userId
 * @property {string} refreshHash
 * @property {string[]} previousHashes
 * @property {string} method how the user signed in
 * @property {string} device
 * @property {boolean} remember
 * @property {Date} expiresAt
 * @property {Date} lastUsedAt
 * @property {Date | null} revokedAt
 * @property {Date} createdAt
 */

/**
 * @typedef {'phone' | 'email' | 'link' | 'reset' | 'invite' | 'step' | 'handoff' | 'export'} CodeKind
 * @typedef {{ id: string, kind: CodeKind, target: string, hash: string, attempts: number, expireAt: Date,
 *   data: Record<string, any>, createdAt: Date }} CodeRecord
 */

/**
 * The filters of the users list (and its counts): text in the name, e-mail or phone; a role; a status (`active`,
 * `pending`, `invited`, or `blocked` for blocked users); users who asked to be deleted.
 * @typedef {{ q?: string, role?: string, status?: string, deletion?: boolean }} UserQuery
 */

/**
 * An activity-log copy another product sent (PLAN 0.4.11, 0.8.10 K9).
 * @typedef {object} CopyRecord
 * @property {string} id
 * @property {string} productId
 * @property {{ kind: string, id: string, name?: string, role?: string }} actor
 * @property {string} action
 * @property {string} target
 * @property {string} [label] what the target is called
 * @property {string} [detail] plain text
 * @property {Date} at
 */

const USERS = 'users';
const SESSIONS = 'sessions';
const CODES = 'codes';
const OAUTH = 'oauth';
const ROLES = 'roles';
const FIELDS = 'fields';
const PERMISSIONS = 'permissions';
const KEYS = 'keys';
const SIGNUPS = 'signups';
const DELETIONS = 'deletions';
const COPIES = 'copies';

const present = { $type: 'string' };

/** Merchant database indexes (created on a website's first use). @type {import('@ss/app-kit').IndexDefinition[]} */
export const INDEXES = [
	{ collection: USERS, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{
		collection: USERS,
		keys: { websiteId: 1, email: 1 },
		name: 'by_email',
		unique: true,
		partialFilterExpression: { email: present },
	},
	{
		collection: USERS,
		keys: { websiteId: 1, phone: 1 },
		name: 'by_phone',
		unique: true,
		partialFilterExpression: { phone: present },
	},
	{ collection: USERS, keys: { websiteId: 1, createdAt: -1, id: -1 }, name: 'newest' },
	{ collection: USERS, keys: { websiteId: 1, role: 1 }, name: 'by_role' },
	{ collection: USERS, keys: { websiteId: 1, status: 1 }, name: 'by_status' },
	{ collection: USERS, keys: { websiteId: 1, 'deletion.dueAt': 1 }, name: 'deletions_due' },
	{ collection: SESSIONS, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: SESSIONS, keys: { websiteId: 1, userId: 1 }, name: 'by_user' },
	{ collection: CODES, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: CODES, keys: { websiteId: 1, kind: 1, target: 1 }, name: 'by_target' },
	{ collection: CODES, keys: { expireAt: 1 }, name: 'expire', expireAfterSeconds: 0 },
	{ collection: OAUTH, keys: { websiteId: 1, state: 1 }, name: 'by_state', unique: true },
	{ collection: OAUTH, keys: { expireAt: 1 }, name: 'expire', expireAfterSeconds: 0 },
	{ collection: ROLES, keys: { websiteId: 1, key: 1 }, name: 'by_key', unique: true },
	{ collection: FIELDS, keys: { websiteId: 1, key: 1 }, name: 'by_key', unique: true },
	{ collection: PERMISSIONS, keys: { websiteId: 1, key: 1 }, name: 'by_key', unique: true },
	{ collection: KEYS, keys: { websiteId: 1 }, name: 'by_website', unique: true },
	{ collection: SIGNUPS, keys: { websiteId: 1, deviceHash: 1 }, name: 'by_device' },
	{ collection: SIGNUPS, keys: { websiteId: 1, networkHash: 1, createdAt: -1 }, name: 'by_network' },
	{ collection: SIGNUPS, keys: { createdAt: 1 }, name: 'expire', expireAfterSeconds: 30 * 24 * 3600 },
	{ collection: DELETIONS, keys: { websiteId: 1, userId: 1 }, name: 'by_user', unique: true },
	{ collection: COPIES, keys: { websiteId: 1, at: -1, id: -1 }, name: 'newest' },
	{ collection: COPIES, keys: { websiteId: 1, productId: 1, at: -1, id: -1 }, name: 'by_product' },
	{ collection: COPIES, keys: { websiteId: 1, 'actor.id': 1, at: -1 }, name: 'by_actor' },
	{ collection: COPIES, keys: { websiteId: 1, target: 1, at: -1 }, name: 'by_target' },
];

const NO_ID = { projection: { _id: 0 } };
const MAX_LIST = 100;

/** @param {string} text */
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {WebsiteData} data the website's guarded merchant database
 * @param {{ now: () => number }} clock
 */
export const createStore = (data, { now }) => {
	const websiteId = data.websiteId;
	const at = () => new Date(now());
	const users = data.collection(USERS);
	const sessions = data.collection(SESSIONS);
	const codes = data.collection(CODES);
	const oauth = data.collection(OAUTH);
	const roles = data.collection(ROLES);
	const fields = data.collection(FIELDS);
	const permissions = data.collection(PERMISSIONS);
	const keys = data.collection(KEYS);
	const signups = data.collection(SIGNUPS);
	const deletions = data.collection(DELETIONS);
	const copies = data.collection(COPIES);
	/** @param {unknown} doc */
	const as = (doc) => /** @type {any} */ (doc);

	/**
	 * The filter of the users list and of its counts (one builder, so a count always equals the list).
	 * @param {UserQuery} query
	 */
	const usersFilter = ({ q, role, status, deletion }) => {
		/** @type {Record<string, unknown>} */
		const filter = {};
		if (q) {
			const pattern = { $regex: escapeRegex(q.slice(0, 100)), $options: 'i' };
			filter.$or = [{ name: pattern }, { email: pattern }, { phone: pattern }];
		}
		if (role) filter.role = role;
		if (status === 'blocked') filter.blocked = { $ne: null };
		else if (status) filter.status = status;
		if (deletion) filter.deletion = { $ne: null };
		return { ...filter, websiteId };
	};

	/**
	 * A copies filter (`core/activity.js`) for this website.
	 * @param {Record<string, unknown>} filter
	 */
	const copiesFilter = (filter) => ({ ...filter, websiteId });

	/** Create the ready-made roles once per website. */
	const seedRoles = async () => {
		if ((await roles.countDocuments({ websiteId, ready: true })) >= READY_ROLES.length) return;
		for (const role of READY_ROLES)
			await roles.updateOne({ websiteId, key: role.key }, { $setOnInsert: { ...role } }, { upsert: true });
	};

	return Object.freeze({
		users: Object.freeze({
			/** @param {string} id @returns {Promise<UserRecord | null>} */
			get: async (id) => as(await users.findOne({ websiteId, id }, NO_ID)),
			/** @param {string} email @returns {Promise<UserRecord | null>} */
			byEmail: async (email) => as(await users.findOne({ websiteId, email }, NO_ID)),
			/** @param {string} phone @returns {Promise<UserRecord | null>} */
			byPhone: async (phone) => as(await users.findOne({ websiteId, phone }, NO_ID)),
			/** @param {string} provider @param {string} subject @returns {Promise<UserRecord | null>} */
			byProvider: async (provider, subject) =>
				as(await users.findOne({ websiteId, [`providers.${provider}`]: subject }, NO_ID)),
			/**
			 * Users matching any of id, e-mail or phone (data rights).
			 * @param {{ id?: string, email?: string | null, phone?: string | null }} who
			 * @returns {Promise<UserRecord[]>}
			 */
			matching: async ({ id, email, phone }) => {
				const or = [...(id ? [{ id }] : []), ...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])];
				return or.length === 0 ? [] : as(await users.find({ websiteId, $or: or }, NO_ID).limit(10).toArray());
			},
			/**
			 * Create a user; null when the e-mail or phone is taken.
			 * @param {Omit<UserRecord, 'id' | 'createdAt'>} user
			 * @returns {Promise<UserRecord | null>}
			 */
			create: async (user) => {
				const id = createId('usr');
				try {
					await users.insertOne({ ...user, id });
				} catch (error) {
					if (/** @type {{ code?: number }} */ (error).code === 11000) return null;
					throw error;
				}
				return as(await users.findOne({ websiteId, id }, NO_ID));
			},
			/**
			 * @param {string} id @param {Record<string, unknown>} set @param {Record<string, unknown>} [more] other operators
			 * @returns {Promise<UserRecord | null>} null when missing or the e-mail or phone is taken
			 */
			update: async (id, set, more = {}) => {
				try {
					return as(
						await users.findOneAndUpdate(
							{ websiteId, id },
							{ ...(Object.keys(set).length > 0 ? { $set: set } : {}), ...more },
							{ returnDocument: 'after', ...NO_ID },
						),
					);
				} catch (error) {
					if (/** @type {{ code?: number }} */ (error).code === 11000) return null;
					throw error;
				}
			},
			/** Count a wrong password; returns the new count. @param {string} id */
			failedLogin: async (id) =>
				as(
					await users.findOneAndUpdate(
						{ websiteId, id },
						{ $inc: { failedLogins: 1 } },
						{ returnDocument: 'after', projection: { _id: 0, failedLogins: 1 } },
					),
				)?.failedLogins ?? 0,
			/**
			 * A page of users, newest first, filtered by text (name, e-mail, phone), role or status.
			 * @param {{ after: [string, string] | null, limit: number } & UserQuery} query
			 * @returns {Promise<UserRecord[]>}
			 */
			list: async ({ after, limit, ...query }) => {
				const filter = usersFilter(query);
				const page = after
					? {
							...filter,
							$and: [
								{
									$or: [
										{ createdAt: { $lt: new Date(after[0]) } },
										{ createdAt: new Date(after[0]), id: { $lt: after[1] } },
									],
								},
							],
						}
					: filter;
				return as(
					await users
						.find(page, NO_ID)
						.sort({ createdAt: -1, id: -1 })
						.limit(Math.min(limit, MAX_LIST + 1))
						.toArray(),
				);
			},
			/**
			 * The collection and filter of the users list, for its counts (PLAN 0.8.10 K4).
			 * @param {UserQuery} query
			 */
			counting: (query) => ({ collection: users, filter: usersFilter(query) }),
			/** Users whose deletion is due (no approval needed any more). @param {number} limit */
			deletionsDue: async (limit) =>
				as(
					await users
						.find({ websiteId, 'deletion.dueAt': { $lte: at() } }, NO_ID)
						.limit(limit)
						.toArray(),
				),
			/** @param {string} id */
			remove: async (id) => (await users.deleteOne({ websiteId, id })).deletedCount === 1,
			/** Move users of a deleted role to the default role. @param {string} role */
			resetRole: async (role) => (await users.updateMany({ websiteId, role }, { $set: { role: DEFAULT_ROLE } })).modifiedCount,
		}),

		sessions: Object.freeze({
			/** @param {Omit<SessionRecord, 'id' | 'createdAt'>} session @returns {Promise<SessionRecord>} */
			create: async (session) => {
				const id = createId('ses');
				await sessions.insertOne({ ...session, id });
				return as(await sessions.findOne({ websiteId, id }, NO_ID));
			},
			/** @param {string} id @returns {Promise<SessionRecord | null>} */
			get: async (id) => as(await sessions.findOne({ websiteId, id }, NO_ID)),
			/**
			 * Rotate the refresh token if it is still `expected` (two tabs racing lose cleanly).
			 * @param {string} id @param {string} expected @param {string} next
			 */
			rotate: async (id, expected, next) =>
				(
					await sessions.updateOne(
						{ websiteId, id, refreshHash: expected, revokedAt: null },
						{
							$set: { refreshHash: next, lastUsedAt: at() },
							$push: { previousHashes: { $each: [expected], $slice: -20 } },
						},
					)
				).modifiedCount === 1,
			/** Active sessions of a user, most recently used first. @param {string} userId @returns {Promise<SessionRecord[]>} */
			ofUser: async (userId) =>
				as(
					await sessions
						.find({ websiteId, userId, revokedAt: null, expiresAt: { $gt: at() } }, NO_ID)
						.sort({ lastUsedAt: -1 })
						.limit(MAX_LIST)
						.toArray(),
				),
			/** @param {string} userId @param {string} id */
			revoke: async (userId, id) =>
				(await sessions.updateOne({ websiteId, userId, id, revokedAt: null }, { $set: { revokedAt: at() } }))
					.modifiedCount === 1,
			/** @param {string} userId */
			revokeAll: async (userId) =>
				(await sessions.updateMany({ websiteId, userId, revokedAt: null }, { $set: { revokedAt: at() } })).modifiedCount,
			/** @param {string} userId */
			removeAll: async (userId) => (await sessions.deleteMany({ websiteId, userId })).deletedCount,
		}),

		codes: Object.freeze({
			/**
			 * Add a code record; with `replace`, other live records of the same kind and target are removed first.
			 * @param {{ kind: CodeRecord['kind'], target: string, hash: string, expireAt: Date, data?: Record<string, any>,
			 *   id?: string, replace?: boolean }} input
			 * @returns {Promise<string>} the record id
			 */
			add: async ({ kind, target, hash, expireAt, data: extra = {}, id = createId('cod'), replace = false }) => {
				if (replace) await codes.deleteMany({ websiteId, kind, target });
				await codes.insertOne({ id, kind, target, hash, attempts: 0, expireAt, data: extra });
				return id;
			},
			/** @param {string} id @returns {Promise<CodeRecord | null>} */
			get: async (id) => as(await codes.findOne({ websiteId, id, expireAt: { $gt: at() } }, NO_ID)),
			/** The newest live record of a kind and target. @param {CodeRecord['kind']} kind @param {string} target */
			latest: async (kind, target) =>
				/** @type {CodeRecord | null} */ (
					as(
						await codes.findOne(
							{ websiteId, kind, target, expireAt: { $gt: at() } },
							{ ...NO_ID, sort: { createdAt: -1 } },
						),
					)
				),
			/** Records of a kind and target made since a time (rate limits). @param {CodeRecord['kind']} kind @param {string} target @param {Date} since */
			countSince: (kind, target, since) => codes.countDocuments({ websiteId, kind, target, createdAt: { $gte: since } }),
			/** Count a wrong try; returns the new count. @param {string} id */
			attempt: async (id) =>
				as(
					await codes.findOneAndUpdate(
						{ websiteId, id },
						{ $inc: { attempts: 1 } },
						{ returnDocument: 'after', projection: { _id: 0, attempts: 1 } },
					),
				)?.attempts ?? Number.MAX_SAFE_INTEGER,
			/** Use a record once: true only for the first caller. @param {string} id */
			consume: async (id) => (await codes.deleteOne({ websiteId, id })).deletedCount === 1,
			/** @param {string} target */
			removeTarget: async (target) => (await codes.deleteMany({ websiteId, target })).deletedCount,
		}),

		oauth: Object.freeze({
			/** @param {{ state: string, provider: string, data: Record<string, string>, expireAt: Date }} entry */
			add: async (entry) => {
				await oauth.insertOne({ ...entry });
			},
			/** Take a pending social sign-in once. @param {string} state */
			take: async (state) =>
				as(await oauth.findOneAndDelete({ websiteId, state, expireAt: { $gt: at() } }, { projection: { _id: 0 } })),
		}),

		roles: Object.freeze({
			/** @returns {Promise<Role[]>} */
			list: async () => {
				await seedRoles();
				return as(await roles.find({ websiteId }, NO_ID).sort({ ready: -1, key: 1 }).limit(200).toArray());
			},
			/** @param {string} key @returns {Promise<Role | null>} */
			get: async (key) => {
				await seedRoles();
				return as(await roles.findOne({ websiteId, key }, NO_ID));
			},
			count: () => roles.countDocuments({ websiteId }),
			/** @param {Omit<Role, 'ready'>} role */
			save: async (role) => {
				await seedRoles();
				await roles.updateOne(
					{ websiteId, key: role.key },
					{ $set: { ...role }, $setOnInsert: { ready: false } },
					{ upsert: true },
				);
				return /** @type {Role} */ (as(await roles.findOne({ websiteId, key: role.key }, NO_ID)));
			},
			/** Delete a role of the merchant's own (never a ready-made one). @param {string} key */
			remove: async (key) => (await roles.deleteOne({ websiteId, key, ready: false })).deletedCount === 1,
		}),

		fields: Object.freeze({
			/** @returns {Promise<CustomField[]>} */
			list: async () =>
				as(
					await fields
						.find({ websiteId }, { projection: { _id: 0, key: 1, label: 1, type: 1, options: 1, required: 1 } })
						.sort({ createdAt: 1, _id: 1 })
						.limit(100)
						.toArray(),
				),
			count: () => fields.countDocuments({ websiteId }),
			/** @param {CustomField} field */
			save: async (field) => {
				await fields.updateOne({ websiteId, key: field.key }, { $set: { ...field } }, { upsert: true });
			},
			/** @param {string} key */
			remove: async (key) => (await fields.deleteOne({ websiteId, key })).deletedCount === 1,
		}),

		permissions: Object.freeze({
			/** The merchant's own permission names. @returns {Promise<Array<{ key: string, name: string }>>} */
			list: async () =>
				as(
					await permissions
						.find({ websiteId }, { projection: { _id: 0, key: 1, name: 1 } })
						.sort({ key: 1 })
						.toArray(),
				),
			/** Replace the merchant's own permission names. @param {Array<{ key: string, name: string }>} list */
			replace: async (list) => {
				await permissions.deleteMany({ websiteId });
				if (list.length > 0) await permissions.insertMany(list.map((item) => ({ ...item })));
			},
		}),

		keys: Object.freeze({
			/** @returns {Promise<{ kid: string, sealed: string, publicJwk: Record<string, string> } | null>} */
			get: async () => as(await keys.findOne({ websiteId }, NO_ID)),
			/** Keep a key (the first writer wins). @param {{ kid: string, sealed: string, publicJwk: Record<string, string> }} key */
			put: async (key) => {
				await keys.updateOne({ websiteId }, { $setOnInsert: { ...key } }, { upsert: true });
				return as(await keys.findOne({ websiteId }, NO_ID));
			},
			/** Replace a key that no longer opens (ENCRYPTION_KEY changed). @param {{ kid: string, sealed: string, publicJwk: Record<string, string> }} key */
			replace: async (key) => {
				await keys.updateOne({ websiteId }, { $set: { ...key } }, { upsert: true });
			},
		}),

		signups: Object.freeze({
			/** @param {{ deviceHash: string | null, networkHash: string }} entry */
			add: async (entry) => {
				await signups.insertOne({ ...entry });
			},
			/** @param {string} deviceHash */
			byDevice: (deviceHash) => signups.countDocuments({ websiteId, deviceHash }),
			/** @param {string} networkHash @param {Date} since */
			byNetwork: (networkHash, since) => signups.countDocuments({ websiteId, networkHash, createdAt: { $gte: since } }),
		}),

		deletions: Object.freeze({
			/** @param {{ userId: string, email: string | null, phone: string | null, pending: string[] }} entry */
			add: async (entry) => {
				await deletions.updateOne({ websiteId, userId: entry.userId }, { $set: { ...entry } }, { upsert: true });
			},
			/** @param {number} limit @returns {Promise<Array<{ userId: string, email: string | null, phone: string | null, pending: string[] }>>} */
			pending: async (limit) => as(await deletions.find({ websiteId }, NO_ID).limit(limit).toArray()),
			/** @param {string} userId @param {string[]} pending */
			update: async (userId, pending) => {
				if (pending.length === 0) await deletions.deleteOne({ websiteId, userId });
				else await deletions.updateOne({ websiteId, userId }, { $set: { pending } });
			},
		}),

		copies: Object.freeze({
			/** @param {Omit<CopyRecord, 'id'>} copy */
			add: async (copy) => {
				await copies.insertOne({ ...copy, id: createId('act') });
			},
			/**
			 * A page of copies, newest first (cursor: time and id), with a filter of `core/activity.js` `copyFilter`.
			 * @param {{ after: [string, string] | null, limit: number, filter: Record<string, unknown> }} query
			 * @returns {Promise<CopyRecord[]>}
			 */
			list: async ({ after, limit, filter }) => {
				const own = copiesFilter(filter);
				const page = after
					? {
							...own,
							$and: [{ $or: [{ at: { $lt: new Date(after[0]) } }, { at: new Date(after[0]), id: { $lt: after[1] } }] }],
						}
					: own;
				return as(
					await copies
						.find(page, {
							projection: { _id: 0, id: 1, productId: 1, actor: 1, action: 1, target: 1, label: 1, detail: 1, at: 1 },
						})
						.sort({ at: -1, id: -1 })
						.limit(Math.min(limit, MAX_LIST + 1))
						.toArray(),
				);
			},
			/**
			 * The collection and filter of the copies list, for its counts (PLAN 0.8.10 K4, K9).
			 * @param {Record<string, unknown>} filter
			 */
			counting: (filter) => ({ collection: copies, filter: copiesFilter(filter) }),
		}),
	});
};

/** @typedef {ReturnType<typeof createStore>} Store */
