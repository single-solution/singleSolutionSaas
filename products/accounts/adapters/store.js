/**
 * Accounts' records in the merchant database (collections `ss_accounts_<name>`, through the kit's tenant guard: every
 * query carries the website id; inserts are stamped with `websiteId`, `merchantId`, `createdAt` and `updatedAt`).
 *
 * - `users`: the one user list of the website (customers and the merchant's staff), unique email and phone
 * - `sessions`: signed-in devices with their rotating refresh token (hash only; the current secret sealed for the
 *   30-second grace of parallel renewals, dropped when the session is signed out), removed 7 days after their end (TTL)
 * - `codes`: one-time codes and links (sign-in codes, magic links, resets, invites, two-step steps, social hand-overs,
 *   data exports), kept as hashes and removed by a TTL index once expired; a setup link also leaves a trace (its hash,
 *   its user, its end and whether it was used or canceled) kept 30 days past its end, so a setup page can say "used"
 *   or "expired" (A3)
 * - `oauth`: social sign-ins in progress (state, PKCE verifier, nonce), TTL
 * - `roles` (the ready-made templates are made once, on first use, with Owner; a template the merchant deletes stays
 *   deleted), `fields` (custom fields), `permissions` (the merchant's own permission names), `consents` (the merchant's
 *   consent list, A2: the terms consent is made once, on first use; one deleted stays deleted)
 * - `keys`: the website's sign-in signing key (private part sealed with `ENCRYPTION_KEY`)
 * - `signups`: hashed device and network of each sign-up (risk checks), TTL 30 days
 * - `deletions`: users erased here whose erasure some connected products have not confirmed yet
 * - `copies`: the activity-log copies other products send
 * - `requests`: role requests (PLAN 0.8.10 A5)
 * - `counters`: short counters with a TTL (codes per hour per phone and per website, A7; tries per network and
 *   address, A9; reset emails per address, ST-12)
 * - `outbox`: messages Notifications could not send yet (Forgot password), their values sealed, sent again right
 *   after later requests until they expire (TTL)
 * @module
 */
import { createId } from '@ss/contracts';
import { nationalNumberOf } from '@ss/contracts/phone';
import { CONSENT_TEMPLATES, MAX_CONSENTS } from '../core/consents.js';
import { MAX_CUSTOM_FIELDS } from '../core/profile.js';
import { MAX_VIEWS } from '../core/views.js';
import { MAX_ROLES, OWNER_ROLE, ROLE_TEMPLATES, SIGN_UP_TEMPLATE } from '../core/roles.js';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/profile.js').UserRecord} UserRecord */
/** @typedef {import('../core/roles.js').Role} Role */
/** @typedef {import('../core/profile.js').CustomField} CustomField */
/** @typedef {import('../core/consents.js').Consent} Consent */
/** @typedef {import('../core/views.js').SavedView} SavedView */

/**
 * @typedef {object} SessionRecord
 * @property {string} id
 * @property {string} userId
 * @property {string} refreshHash
 * @property {string[]} previousHashes
 * @property {Array<{ hash: string, at: Date }>} [rotated] the last refresh tokens rotated away, with when (the grace
 *   period of parallel renewals)
 * @property {string | null} [sealedRefresh] the current refresh secret, sealed (answered again within the grace period)
 * @property {string} method how the user signed in
 * @property {{ browser: string, system: string }} device the browser and the system by their own names ('' when unknown, A8)
 * @property {boolean} remember
 * @property {Date} expiresAt
 * @property {Date} lastUsedAt
 * @property {Date | null} revokedAt
 * @property {Date} createdAt
 */

/**
 * @typedef {'phone' | 'email' | 'link' | 'reset' | 'invite' | 'step' | 'handoff' | 'export' | 'phone_reset' | 'staff_code'
 *   | 'setup' | 'setup_trace'} CodeKind
 * @typedef {{ id: string, kind: CodeKind, target: string, hash: string, attempts: number, expireAt: Date,
 *   data: Record<string, any>, createdAt: Date }} CodeRecord
 */

/**
 * The filters of the users list (and its counts): text in the name, email or phone; roles (one or several); a status
 * (`active`, `pending`, `invited`, or `blocked` for blocked users); blocked or not; users who asked to be deleted; an
 * exact phone, the end of a national number (digits, A7), users who gave a consent now (A2), users with any of some
 * tags (A5), and users made after a time (PLAN 0.8.10 A4).
 * @typedef {{ q?: string, roles?: string[], status?: string, blocked?: boolean, deletion?: boolean, phone?: string,
 *   phoneEnd?: string, consent?: string, tags?: string[], createdAfter?: Date }} UserQuery
 */

/**
 * What an invite of a role request did, so a decline can undo it (kept on the request, never answered): `at` when the
 * request's role is given (`invite`, or `completion`: when the setup link is used), `createdUser` whether the invite
 * made the user, `roleBefore` the user's role before (the default role for a user the invite made).
 * @typedef {{ at: 'invite' | 'completion', createdUser: boolean, roleBefore: string }} RequestGrant
 */

/**
 * A role request (A5): someone without an account asks for a role.
 * @typedef {object} RequestRecord
 * @property {string} id `rrq_…`
 * @property {string} role
 * @property {string} name
 * @property {string | null} phone
 * @property {string | null} email
 * @property {string} note
 * @property {'pending' | 'invited' | 'completed' | 'declined'} status stored; `expired` is judged on read
 * @property {string | null} userId
 * @property {{ kind: string, id: string, name?: string } | null} invitedBy
 * @property {Date | null} invitedAt
 * @property {Date | null} setupExpiresAt when the setup link answered at the invite expires
 * @property {Date | null} completedAt
 * @property {RequestGrant | null} [grant] what its invite did (absent on requests invited before, or imported)
 * @property {Date} createdAt
 */

/**
 * A message kept to be sent again (Forgot password): one per key (template and address), its values sealed.
 * @typedef {{ id: string, key: string, channel: 'email' | 'sms' | 'whatsapp', template: string,
 *   to: { email?: string, phone?: string }, sealed: string, expireAt: Date }} OutboxRecord
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
 * @property {Record<string, string | number | boolean>} [values] what changed as codes, numbers and yes/no (A8)
 * @property {Date} at
 */

const USERS = 'users';
const SESSIONS = 'sessions';
const CODES = 'codes';
const OAUTH = 'oauth';
const ROLES = 'roles';
const FIELDS = 'fields';
const CONSENTS = 'consents';
const VIEWS = 'views';
const PERMISSIONS = 'permissions';
const KEYS = 'keys';
const SIGNUPS = 'signups';
const DELETIONS = 'deletions';
const COPIES = 'copies';
const REQUESTS = 'requests';
const COUNTERS = 'counters';
const OUTBOX = 'outbox';

const present = { $type: 'string' };
/** An ended session (signed out, or past its end) is removed this long after its end (RT-11). */
const SESSION_KEPT_SECONDS = 7 * 24 * 3600;

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
	{ collection: USERS, keys: { websiteId: 1, phoneReversed: 1 }, name: 'by_phone_reversed' },
	{ collection: SESSIONS, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: SESSIONS, keys: { websiteId: 1, userId: 1 }, name: 'by_user' },
	{ collection: SESSIONS, keys: { expiresAt: 1 }, name: 'expire', expireAfterSeconds: SESSION_KEPT_SECONDS },
	{ collection: CODES, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: CODES, keys: { websiteId: 1, kind: 1, target: 1 }, name: 'by_target' },
	{ collection: CODES, keys: { expireAt: 1 }, name: 'expire', expireAfterSeconds: 0 },
	{ collection: OAUTH, keys: { websiteId: 1, state: 1 }, name: 'by_state', unique: true },
	{ collection: OAUTH, keys: { expireAt: 1 }, name: 'expire', expireAfterSeconds: 0 },
	{ collection: ROLES, keys: { websiteId: 1, key: 1 }, name: 'by_key', unique: true },
	{ collection: FIELDS, keys: { websiteId: 1, key: 1 }, name: 'by_key', unique: true },
	{ collection: CONSENTS, keys: { websiteId: 1, key: 1 }, name: 'by_key', unique: true },
	{ collection: VIEWS, keys: { websiteId: 1, key: 1 }, name: 'by_key', unique: true },
	{ collection: USERS, keys: { websiteId: 1, tags: 1 }, name: 'by_tag' },
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
	{ collection: REQUESTS, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: REQUESTS, keys: { websiteId: 1, createdAt: -1, id: -1 }, name: 'newest' },
	{ collection: REQUESTS, keys: { websiteId: 1, status: 1 }, name: 'by_status' },
	{ collection: COUNTERS, keys: { websiteId: 1, key: 1 }, name: 'by_key', unique: true },
	{ collection: COUNTERS, keys: { expireAt: 1 }, name: 'expire', expireAfterSeconds: 0 },
	{ collection: OUTBOX, keys: { websiteId: 1, key: 1 }, name: 'by_key' },
	{ collection: OUTBOX, keys: { websiteId: 1, expireAt: 1 }, name: 'by_expiry' },
	{ collection: OUTBOX, keys: { expireAt: 1 }, name: 'expire', expireAfterSeconds: 0 },
];

/**
 * The national number of a phone, written backwards, for the users list's search by the end of a number (A7): an
 * index finds a number's end as the start of this text. The national number follows the number's own country (its
 * digits after the calling code), never a fixed count of last digits.
 * @param {string | null} phone E.164
 * @returns {string | null}
 */
export const phoneReversedOf = (phone) => {
	const national = nationalNumberOf(phone);
	return national === null ? null : [...national].reverse().join('');
};

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
	const consents = data.collection(CONSENTS);
	const views = data.collection(VIEWS);
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
	const usersFilter = ({ q, roles: anyRole, status, blocked, deletion, phone, phoneEnd, consent, tags, createdAfter }) => {
		/** @type {Record<string, unknown>} */
		const filter = {};
		/** @type {Record<string, unknown>[]} */
		const and = [];
		if (q) {
			const pattern = { $regex: escapeRegex(q.slice(0, 100)), $options: 'i' };
			filter.$or = [{ name: pattern }, { email: pattern }, { phone: pattern }];
		}
		if (anyRole) filter.role = anyRole.length === 1 ? anyRole[0] : { $in: anyRole };
		if (status === 'blocked') filter.blocked = { $ne: null };
		else if (status) filter.status = status;
		if (blocked === true) and.push({ blocked: { $ne: null } });
		if (blocked === false) and.push({ blocked: null });
		if (deletion) filter.deletion = { $ne: null };
		if (phone) filter.phone = phone;
		if (phoneEnd) filter.phoneReversed = { $regex: `^${[...phoneEnd].reverse().join('')}` };
		if (consent) filter[`consents.${consent}.given`] = true;
		if (tags) filter.tags = { $in: tags };
		if (createdAfter) filter.createdAt = { $gt: createdAfter };
		return { ...filter, ...(and.length > 0 ? { $and: and } : {}), websiteId };
	};

	/**
	 * A copies filter (the kit's `activityFilter` with `productId`, `server/manage.js`) for this website.
	 * @param {Record<string, unknown>} filter
	 */
	const copiesFilter = (filter) => ({ ...filter, websiteId });

	/**
	 * Make the ready-made templates once per website (A3): Owner always exists, so the templates come only with the
	 * Owner record; a template deleted later stays deleted. A template never takes the sign-up choice from an imported
	 * role that has it.
	 */
	let seeded = false;
	const seedRoles = async () => {
		if (seeded) return;
		const owner = /** @type {Role} */ (ROLE_TEMPLATES.find((role) => role.key === OWNER_ROLE));
		const others = ROLE_TEMPLATES.filter((role) => role !== owner);
		const made = await roles.updateOne({ websiteId, key: owner.key }, { $setOnInsert: { ...owner } }, { upsert: true });
		if (made.upsertedCount === 1) {
			const chosen = (await roles.countDocuments({ websiteId, signUp: true })) > 0;
			for (const role of others)
				await roles.updateOne(
					{ websiteId, key: role.key },
					{ $setOnInsert: { ...role, signUp: role.signUp && !chosen } },
					{ upsert: true },
				);
		}
		seeded = true;
	};

	const requests = data.collection(REQUESTS);
	const counters = data.collection(COUNTERS);
	const outbox = data.collection(OUTBOX);

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
			 * Users matching any of id, email or phone (data rights).
			 * @param {{ id?: string, email?: string | null, phone?: string | null }} who
			 * @returns {Promise<UserRecord[]>}
			 */
			matching: async ({ id, email, phone }) => {
				const or = [...(id ? [{ id }] : []), ...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])];
				return or.length === 0 ? [] : as(await users.find({ websiteId, $or: or }, NO_ID).limit(10).toArray());
			},
			/**
			 * Create a user; null when the email or phone is taken.
			 * @param {Omit<UserRecord, 'id' | 'createdAt' | 'roleSince'>} user (`roleSince` is now)
			 * @returns {Promise<UserRecord | null>}
			 */
			create: async (user) => {
				const id = createId('usr');
				try {
					await users.insertOne({ ...user, id, phoneReversed: phoneReversedOf(user.phone), roleSince: at() });
				} catch (error) {
					if (/** @type {{ code?: number }} */ (error).code === 11000) return null;
					throw error;
				}
				return as(await users.findOne({ websiteId, id }, NO_ID));
			},
			/**
			 * @param {string} id @param {Record<string, unknown>} set @param {Record<string, unknown>} [more] other operators
			 * @returns {Promise<UserRecord | null>} null when missing or the email or phone is taken
			 */
			update: async (id, set, more = {}) => {
				// the phone's reversed national number and the time the role was set follow the fields they come from (A4, A5)
				const full = {
					...set,
					...('phone' in set ? { phoneReversed: phoneReversedOf(/** @type {string | null} */ (set.phone)) } : {}),
					...('role' in set ? { roleSince: at() } : {}),
				};
				// nothing to change (for example two-step turned off twice): the user as stored
				if (Object.keys(full).length === 0 && Object.keys(more).length === 0)
					return as(await users.findOne({ websiteId, id }, NO_ID));
				try {
					return as(
						await users.findOneAndUpdate(
							{ websiteId, id },
							{ ...(Object.keys(full).length > 0 ? { $set: full } : {}), ...more },
							{ returnDocument: 'after', ...NO_ID },
						),
					);
				} catch (error) {
					if (/** @type {{ code?: number }} */ (error).code === 11000) return null;
					throw error;
				}
			},
			/**
			 * Count a wrong password or two-step code in one step; returns the new count. Only recent failures count
			 * (K-27): when the last one is `forgetMs` or more ago (or none is known), the count starts again at this one.
			 * @param {string} id @param {number} forgetMs
			 */
			failedLogin: async (id, forgetMs) => {
				const when = at();
				const since = new Date(when.getTime() - forgetMs);
				const recent = { $gt: [{ $ifNull: ['$lastFailedAt', since] }, since] };
				return (
					as(
						await users.findOneAndUpdate(
							{ websiteId, id },
							[
								{
									$set: {
										failedLogins: { $cond: [recent, { $add: [{ $ifNull: ['$failedLogins', 0] }, 1] }, 1] },
										lastFailedAt: when,
									},
								},
							],
							{ returnDocument: 'after', projection: { _id: 0, failedLogins: 1 } },
						),
					)?.failedLogins ?? 0
				);
			},
			/**
			 * A page of users, newest first, filtered by text (name, email, phone), role or status.
			 * @param {{ after: [string, string] | null, limit: number } & UserQuery} query
			 * @returns {Promise<UserRecord[]>}
			 */
			list: async ({ after, limit, ...query }) => {
				const filter = usersFilter(query);
				const page = after
					? {
							...filter,
							$and: [
								.../** @type {Record<string, unknown>[]} */ (filter.$and ?? []),
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
			/** Unblocked users of a role (A4: the last unblocked Owner stays). @param {string} role */
			unblockedOf: (role) => users.countDocuments({ websiteId, role, blocked: null }),
			/** @param {string} id */
			remove: async (id) => (await users.deleteOne({ websiteId, id })).deletedCount === 1,
			/** Move users of a deleted role to another (the role for new sign-ups). @param {string} role @param {string} to */
			resetRole: async (role, to) => (await users.updateMany({ websiteId, role }, { $set: { role: to } })).modifiedCount,
			/**
			 * The website's tags with how many users have each, by name (A5).
			 * @returns {Promise<Array<{ tag: string, users: number }>>}
			 */
			tags: async () =>
				(
					await users
						.aggregate([
							{ $match: { websiteId, 'tags.0': { $exists: true } } },
							{ $unwind: '$tags' },
							{ $group: { _id: '$tags', users: { $sum: 1 } } },
							{ $sort: { _id: 1 } },
							{ $limit: 1000 },
						])
						.toArray()
				).map((row) => ({ tag: String(row._id), users: Number(row.users) })),
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
			 * Rotate the refresh token if it is still `expected` (of renewals racing, only the first rotates); the old hash is
			 * kept with the time, and the new secret sealed, for the grace period. A rolling session (K-27) gets its new end.
			 * @param {string} id @param {string} expected @param {string} next @param {string} sealed the new secret, sealed
			 * @param {Date | null} [expiresAt] the session's new end (null: it keeps its end)
			 */
			rotate: async (id, expected, next, sealed, expiresAt = null) =>
				(
					await sessions.updateOne(
						{ websiteId, id, refreshHash: expected, revokedAt: null },
						{
							$set: { refreshHash: next, sealedRefresh: sealed, lastUsedAt: at(), ...(expiresAt ? { expiresAt } : {}) },
							$push: {
								previousHashes: { $each: [expected], $slice: -20 },
								rotated: { $each: [{ hash: expected, at: at() }], $slice: -5 },
							},
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
			/** End a session; its sealed refresh secret goes at once (RT-11). @param {string} userId @param {string} id */
			revoke: async (userId, id) =>
				(
					await sessions.updateOne(
						{ websiteId, userId, id, revokedAt: null },
						{ $set: { revokedAt: at(), sealedRefresh: null } },
					)
				).modifiedCount === 1,
			/** @param {string} userId */
			revokeAll: async (userId) =>
				(
					await sessions.updateMany(
						{ websiteId, userId, revokedAt: null },
						{ $set: { revokedAt: at(), sealedRefresh: null } },
					)
				).modifiedCount,
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
			/** Remove the records of one kind and target (a declined request's setup link). @param {CodeRecord['kind']} kind @param {string} target */
			removeKind: async (kind, target) => (await codes.deleteMany({ websiteId, kind, target })).deletedCount,
			/**
			 * Mark the trace of a setup link that is still issued: `used`, or `canceled` (A3).
			 * @param {string} linkId the setup link's record id @param {'used' | 'canceled'} state
			 */
			traceSetup: async (linkId, state) => {
				await codes.updateOne(
					{ websiteId, kind: 'setup_trace', target: linkId, 'data.state': 'issued' },
					{ $set: { 'data.state': state } },
				);
			},
			/**
			 * Mark the traces of a user's setup links that still work as canceled (a new link, a decline); a link already past
			 * its end stays expired.
			 * @param {string} userId
			 */
			cancelSetups: async (userId) =>
				(
					await codes.updateMany(
						{
							websiteId,
							kind: 'setup_trace',
							'data.userId': userId,
							'data.state': 'issued',
							'data.validUntil': { $gt: at() },
						},
						{ $set: { 'data.state': 'canceled' } },
					)
				).modifiedCount,
			/** Remove the traces of a user's setup links (the user is removed). @param {string} userId */
			removeSetupTraces: async (userId) =>
				(await codes.deleteMany({ websiteId, kind: 'setup_trace', 'data.userId': userId })).deletedCount,
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
				/** @type {Role[]} */
				const all = as(await roles.find({ websiteId }, NO_ID).limit(MAX_ROLES).toArray());
				return all.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
			},
			/** @param {string} key @returns {Promise<Role | null>} */
			get: async (key) => {
				await seedRoles();
				return as(await roles.findOne({ websiteId, key }, NO_ID));
			},
			/**
			 * The role for new sign-ups (A4): the one chosen (the lowest-ranked when an import chose more than one), else the
			 * Customer template while it exists, else null.
			 * @returns {Promise<Role | null>}
			 */
			signUp: async () => {
				await seedRoles();
				return as(
					(await roles.findOne({ websiteId, signUp: true }, { ...NO_ID, sort: { rank: -1, key: 1 } })) ??
						(await roles.findOne({ websiteId, key: SIGN_UP_TEMPLATE }, NO_ID)),
				);
			},
			count: () => roles.countDocuments({ websiteId }),
			/**
			 * Save a whole role; a role saved as the role for new sign-ups takes that choice from every other role.
			 * @param {Role} role
			 */
			save: async (role) => {
				await seedRoles();
				await roles.updateOne({ websiteId, key: role.key }, { $set: { ...role } }, { upsert: true });
				if (role.signUp)
					await roles.updateMany({ websiteId, key: { $ne: role.key }, signUp: true }, { $set: { signUp: false } });
				return as(await roles.findOne({ websiteId, key: role.key }, NO_ID));
			},
			/**
			 * Delete a role, never a system role (Owner or the role for new sign-ups, A3).
			 * @param {string} key
			 */
			remove: async (key) =>
				key !== OWNER_ROLE && (await roles.deleteOne({ websiteId, key, signUp: { $ne: true } })).deletedCount === 1,
		}),

		fields: Object.freeze({
			/**
			 * The fields in the merchant's order (A6; fields never placed, such as imported ones, first, oldest first).
			 * @returns {Promise<CustomField[]>}
			 */
			list: async () =>
				as(
					await fields
						.find(
							{ websiteId },
							{
								projection: { _id: 0, key: 1, label: 1, type: 1, options: 1, required: 1, visibility: 1, help: 1 },
							},
						)
						.sort({ position: 1, createdAt: 1, _id: 1 })
						.limit(MAX_CUSTOM_FIELDS)
						.toArray(),
				),
			count: () => fields.countDocuments({ websiteId }),
			/** Save a field; a new one goes last. @param {CustomField} field */
			save: async (field) => {
				const position = await fields.countDocuments({ websiteId });
				await fields.updateOne(
					{ websiteId, key: field.key },
					{ $set: { ...field }, $setOnInsert: { position } },
					{ upsert: true },
				);
			},
			/**
			 * Place the fields in this order (every key of the website once).
			 * @param {string[]} keys
			 */
			reorder: async (keys) => {
				for (const [position, key] of keys.entries()) await fields.updateOne({ websiteId, key }, { $set: { position } });
			},
			/** @param {string} key */
			remove: async (key) => (await fields.deleteOne({ websiteId, key })).deletedCount === 1,
		}),

		views: Object.freeze({
			/** The saved views of the users list, in the merchant's order (A5). @returns {Promise<SavedView[]>} */
			list: async () =>
				as(
					await views
						.find({ websiteId }, { projection: { _id: 0, key: 1, name: 1, query: 1 } })
						.sort({ position: 1, key: 1 })
						.limit(MAX_VIEWS)
						.toArray(),
				),
			count: () => views.countDocuments({ websiteId }),
			/** Save a view; a new one goes last. @param {SavedView} view */
			save: async (view) => {
				const position = await views.countDocuments({ websiteId });
				await views.updateOne(
					{ websiteId, key: view.key },
					{ $set: { ...view }, $setOnInsert: { position } },
					{ upsert: true },
				);
			},
			/** Place the views in this order (every key once). @param {string[]} keys */
			reorder: async (keys) => {
				for (const [position, key] of keys.entries()) await views.updateOne({ websiteId, key }, { $set: { position } });
			},
			/** @param {string} key */
			remove: async (key) => (await views.deleteOne({ websiteId, key })).deletedCount === 1,
		}),

		consents: Object.freeze({
			/**
			 * The consent list in the merchant's order (A2); the terms consent is made once, on first use (a marker in
			 * `counters` without an end), so one the merchant deletes stays deleted.
			 * @returns {Promise<Consent[]>}
			 */
			list: async () => {
				const seeded = await counters.updateOne(
					{ websiteId, key: 'seeded|consents' },
					{ $setOnInsert: { at: at() } },
					{ upsert: true },
				);
				if (seeded.upsertedCount === 1)
					for (const [position, consent] of CONSENT_TEMPLATES.entries())
						await consents.updateOne(
							{ websiteId, key: consent.key },
							{ $setOnInsert: { ...consent, position } },
							{ upsert: true },
						);
				return as(
					await consents
						.find({ websiteId }, { projection: { _id: 0, key: 1, label: 1, url: 1, version: 1, required: 1, purpose: 1 } })
						.sort({ position: 1, key: 1 })
						.limit(MAX_CONSENTS)
						.toArray(),
				);
			},
			count: () => consents.countDocuments({ websiteId }),
			/** Save a consent; a new one goes last. @param {Consent} consent */
			save: async (consent) => {
				const position = await consents.countDocuments({ websiteId });
				await consents.updateOne(
					{ websiteId, key: consent.key },
					{ $set: { ...consent }, $setOnInsert: { position } },
					{ upsert: true },
				);
			},
			/** Place the consents in this order (every key once). @param {string[]} keys */
			reorder: async (keys) => {
				for (const [position, key] of keys.entries()) await consents.updateOne({ websiteId, key }, { $set: { position } });
			},
			/** @param {string} key */
			remove: async (key) => (await consents.deleteOne({ websiteId, key })).deletedCount === 1,
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

		requests: Object.freeze({
			/** @param {Omit<RequestRecord, 'id' | 'createdAt'>} request @returns {Promise<RequestRecord>} */
			create: async (request) => {
				const id = createId('rrq');
				await requests.insertOne({ ...request, id });
				return as(await requests.findOne({ websiteId, id }, NO_ID));
			},
			/** @param {string} id @returns {Promise<RequestRecord | null>} */
			get: async (id) => as(await requests.findOne({ websiteId, id }, NO_ID)),
			/** @param {string} id @param {Record<string, unknown>} set @returns {Promise<RequestRecord | null>} */
			update: async (id, set) =>
				as(await requests.findOneAndUpdate({ websiteId, id }, { $set: set }, { returnDocument: 'after', ...NO_ID })),
			/** The open request of a user (invited, waiting for their password), if any. @param {string} userId @returns {Promise<RequestRecord | null>} */
			invitedFor: async (userId) => as(await requests.findOne({ websiteId, userId, status: 'invited' }, NO_ID)),
			/**
			 * A page of requests, newest first, with a filter of the stored fields.
			 * @param {{ after: [string, string] | null, limit: number, filter: Record<string, unknown> }} query
			 * @returns {Promise<RequestRecord[]>}
			 */
			list: async ({ after, limit, filter }) => {
				/** @type {Record<string, unknown>} */
				const own = { ...filter, websiteId };
				const page = after
					? {
							...own,
							$and: [
								.../** @type {Record<string, unknown>[]} */ (own.$and ?? []),
								{
									$or: [
										{ createdAt: { $lt: new Date(after[0]) } },
										{ createdAt: new Date(after[0]), id: { $lt: after[1] } },
									],
								},
							],
						}
					: own;
				return as(
					await requests
						.find(page, NO_ID)
						.sort({ createdAt: -1, id: -1 })
						.limit(Math.min(limit, MAX_LIST + 1))
						.toArray(),
				);
			},
			/** The collection and filter of the requests list, for its counts (K4). @param {Record<string, unknown>} filter */
			counting: (filter) => ({ collection: requests, filter: { ...filter, websiteId } }),
		}),

		counters: Object.freeze({
			/**
			 * Count one use in a fixed window and say whether it stays within the limit (removed by TTL after the window).
			 * @param {string} key @param {number} windowMs @param {number} limit
			 */
			take: async (key, windowMs, limit) => {
				const window = Math.floor(now() / windowMs);
				const id = `${key}|${window}`;
				const bump = () =>
					counters.findOneAndUpdate(
						{ websiteId, key: id },
						{ $inc: { n: 1 }, $setOnInsert: { expireAt: new Date((window + 1) * windowMs) } },
						{ upsert: true, returnDocument: 'after', projection: { _id: 0, n: 1 } },
					);
				/** @type {any} */
				let doc;
				try {
					doc = await bump();
				} catch (error) {
					// two first uses at once: the second insert lost, so count on the one that won
					if (/** @type {{ code?: number }} */ (error).code !== 11000) throw error;
					doc = await bump();
				}
				return Number(doc?.n ?? 0) <= limit;
			},
			/** Forget the uses of the current window (a good sign-in clears its network's tries, A9). @param {string} key @param {number} windowMs */
			clear: async (key, windowMs) => {
				await counters.deleteOne({ websiteId, key: `${key}|${Math.floor(now() / windowMs)}` });
			},
		}),

		outbox: Object.freeze({
			/**
			 * Keep a message to send again; it replaces a kept one with the same key.
			 * @param {Omit<OutboxRecord, 'id'>} message
			 */
			keep: async (message) => {
				await outbox.deleteMany({ websiteId, key: message.key });
				await outbox.insertOne({ ...message, id: createId('msg') });
			},
			/** Kept messages still valid, those expiring first first. @param {number} limit @returns {Promise<OutboxRecord[]>} */
			pending: async (limit) =>
				as(
					await outbox
						.find({ websiteId, expireAt: { $gt: at() } }, NO_ID)
						.sort({ expireAt: 1 })
						.limit(limit)
						.toArray(),
				),
			/** A kept message was sent (or can no longer be). @param {string} id */
			sent: async (id) => {
				await outbox.deleteOne({ websiteId, id });
			},
			/** Drop kept messages of a key (a newer one went out). @param {string} key */
			remove: async (key) => {
				await outbox.deleteMany({ websiteId, key });
			},
			/**
			 * Drop kept messages to a person (their user is removed); returns how many.
			 * @param {{ email: string | null, phone: string | null }} who
			 */
			removeTo: async ({ email, phone }) => {
				const or = [...(email ? [{ 'to.email': email }] : []), ...(phone ? [{ 'to.phone': phone }] : [])];
				return or.length === 0 ? 0 : (await outbox.deleteMany({ websiteId, $or: or })).deletedCount;
			},
		}),

		copies: Object.freeze({
			/** @param {Omit<CopyRecord, 'id'>} copy */
			add: async (copy) => {
				await copies.insertOne({ ...copy, id: createId('act') });
			},
			/**
			 * A page of copies, newest first (cursor: time and id), with the copies filter of `server/manage.js`.
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
							projection: {
								_id: 0,
								id: 1,
								productId: 1,
								actor: 1,
								action: 1,
								target: 1,
								label: 1,
								detail: 1,
								values: 1,
								at: 1,
							},
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
