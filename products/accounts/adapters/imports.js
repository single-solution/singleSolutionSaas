/**
 * The `import` feature (PLAN 0.8.10 K10, Migration step 1): what the kit's import routes take into Accounts, in this
 * order: `roles` and `fields` (found by `key`), `users` (`usr_…`), `requests` (`rrq_…`, A5) and `copies` (the source
 * system's activity entries). Each record goes through `core/imports.js` with what the checks read once per call (the
 * role keys, the custom fields, the website's phone format); email addresses and phone numbers another user holds are
 * refused in the dry run too; a two-step secret is sealed at once (A8) and the phone's last digits derived as the
 * store does. A user or role request without a `createdAt` from the source keeps the stored one, else gets the
 * import's time; a user's `roleSince` is the source's, else its `createdAt`. `finish` derives nothing (every derived
 * value is set per record) and reports what points nowhere; the sums are what `ss-import verify` compares. Nothing is
 * sent: no message, event, alert or activity copy, no timer.
 * @module
 */
import { websiteCallingCode } from '@ss/contracts/phone';
import {
	checkImportedCopy,
	checkImportedField,
	checkImportedRequest,
	checkImportedRole,
	checkImportedUser,
} from '../core/imports.js';
import { MAX_CUSTOM_FIELDS } from '../core/profile.js';
import { MAX_ROLES, READY_ROLES } from '../core/roles.js';
import { isPasswordHash } from './crypto.js';
import { createStore, phoneDigitsOf } from './store.js';

/** @typedef {import('@ss/app-kit').ImportCollection} ImportCollection */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {Parameters<ImportCollection['check']>[1]} CheckContext */
/** @typedef {import('../core/imports.js').ImportError} ImportError */

/**
 * What the import reads of the website (from the kit's product, built in `product.js`).
 * @typedef {object} ImportDeps
 * @property {(websiteId: string, feature: string) => Promise<Record<string, unknown>>} settings a feature's settings
 *   (or a shared group's, such as `phone`)
 * @property {(websiteId: string) => Promise<{ country: string | null }>} business the business.json copy
 * @property {(websiteId: string, userId: string, input: { secret: string, recoveryHashes: string[] }) => unknown} twoStepFromImport
 *   two-step sign-in with the secret sealed (A8)
 */

/** Most role or custom-field keys read at once (a website has at most `MAX_ROLES` and `MAX_CUSTOM_FIELDS`). */
const KEYS_READ = 200;

/**
 * The keys of a website's roles (with the ready-made ones) or custom fields; read only, nothing is seeded here.
 * @param {'roles' | 'fields'} collection
 * @returns {(ctx: { data: WebsiteData, websiteId: string }) => Promise<Set<string>>}
 */
const keysIn =
	(collection) =>
	async ({ data, websiteId }) =>
		new Set([
			...(collection === 'roles' ? READY_ROLES.map((role) => role.key) : []),
			...(
				await data
					.collection(collection)
					.find({ websiteId }, { projection: { _id: 0, key: 1 } })
					.limit(KEYS_READ)
					.toArray()
			).map((doc) => String(doc.key)),
		]);

/** The role keys that exist: the ready-made ones and the website's own. */
const roleKeysOf = keysIn('roles');

/**
 * The website's phone format (shared by Phone code and Phone + password): its calling code, else the business.json
 * country's, and its trunk prefix.
 * @param {ImportDeps} deps @param {string} websiteId
 */
const phoneFormatOf = async (deps, websiteId) => {
	const { defaultCallingCode, trunkPrefix } = await deps.settings(websiteId, 'phone');
	const code = websiteCallingCode(defaultCallingCode) || websiteCallingCode('', (await deps.business(websiteId)).country);
	return { defaultCallingCode: code, trunkPrefix: String(trunkPrefix ?? '') };
};

/**
 * A collection of records found by `key` with a most count per website (roles, custom fields): a new key past the
 * limit is refused.
 * @param {{ keysOf: (ctx: { data: WebsiteData, websiteId: string }) => Promise<Set<string>>, max: number, what: string,
 *   check: (record: Record<string, unknown>) => ({ ok: true, value: Record<string, unknown> & { key: string } } | { ok: false, errors: ImportError[] }) }} input
 * @returns {ImportCollection}
 */
const keyedCollection = ({ keysOf, max, what, check }) => ({
	key: ['key'],
	prepare: keysOf,
	check: (record, ctx) => {
		const checked = check(record);
		if (!checked.ok) return checked;
		// the keys of this call count too
		const keys = /** @type {Set<string>} */ (ctx.prepared);
		if (!keys.has(checked.value.key)) {
			if (keys.size >= max) return { ok: false, errors: [{ path: '/key', message: `A website has at most ${max} ${what}.` }] };
			keys.add(checked.value.key);
		}
		return checked;
	},
});

/**
 * Email addresses and phone numbers of a user that another user already holds, stored or earlier in this call (the
 * unique indexes would refuse them only when written, so the dry run would not show them).
 * @param {CheckContext} ctx
 * @param {{ id: string, email: string | null, phone: string | null }} user
 * @param {Map<string, string>} taken email or phone → the id of the record of this call that has it
 * @returns {Promise<ImportError[]>}
 */
const takenContacts = async (ctx, user, taken) => {
	const contacts = /** @type {Array<['email' | 'phone', string]>} */ (
		[
			['email', user.email],
			['phone', user.phone],
		].filter(([, value]) => value)
	);
	const stored = await ctx.data
		.collection('users')
		.find(
			{ websiteId: ctx.websiteId, id: { $ne: user.id }, $or: contacts.map(([field, value]) => ({ [field]: value })) },
			{ projection: { _id: 0, id: 1, email: 1, phone: 1 } },
		)
		.limit(2)
		.toArray();
	return contacts.flatMap(([field, value]) => {
		const other = taken.get(value) ?? stored.find((doc) => doc[field] === value)?.id;
		return other && other !== user.id
			? [
					{
						path: `/${field}`,
						message: `${field === 'email' ? 'This email address' : 'This phone number'} is already another user’s (${other}).`,
					},
				]
			: [];
	});
};

/**
 * When an imported user or role request was made, when the source does not say: the stored record's time (a re-run
 * keeps it), else the import's, so every record has one (lists sort by it and show it).
 * @param {CheckContext} ctx @param {'users' | 'requests'} collection @param {string} id
 * @returns {Promise<Date>}
 */
const createdAtOf = async (ctx, collection, id) => {
	const stored = await ctx.data
		.collection(collection)
		.findOne({ websiteId: ctx.websiteId, id }, { projection: { _id: 0, createdAt: 1 } });
	return stored?.createdAt instanceof Date ? stored.createdAt : new Date(ctx.now());
};

/**
 * The kit's `imports` option.
 * @param {ImportDeps} deps
 * @returns {import('@ss/app-kit').ImportOptions}
 */
export const createImportOptions = (deps) => ({
	collections: {
		roles: keyedCollection({ keysOf: roleKeysOf, max: MAX_ROLES, what: 'roles', check: checkImportedRole }),
		fields: keyedCollection({
			keysOf: keysIn('fields'),
			max: MAX_CUSTOM_FIELDS,
			what: 'custom fields',
			check: checkImportedField,
		}),
		users: {
			prepare: async (ctx) => ({
				roles: await roleKeysOf(ctx),
				fields: await createStore(ctx.data, { now: ctx.now }).fields.list(),
				phoneFormat: await phoneFormatOf(deps, ctx.websiteId),
				taken: new Map(),
			}),
			check: async (record, ctx) => {
				const { taken, ...rules } =
					/** @type {Omit<import('../core/imports.js').UserRules, 'isPasswordHash'> & { taken: Map<string, string> }} */ (
						ctx.prepared
					);
				const checked = checkImportedUser(record, { ...rules, isPasswordHash });
				if (!checked.ok) return checked;
				const { twoStep, ...user } = checked.value;
				const errors = await takenContacts(ctx, user, taken);
				if (errors.length > 0) return { ok: false, errors };
				for (const value of [user.email, user.phone]) if (value) taken.set(value, user.id);
				const createdAt = user.createdAt ?? (await createdAtOf(ctx, 'users', user.id));
				return {
					ok: true,
					value: {
						...user,
						createdAt,
						roleSince: user.roleSince ?? createdAt,
						phoneDigits: phoneDigitsOf(user.phone),
						// the plain secret came only over this server-token call; only its sealed form is kept
						twoStep: twoStep ? deps.twoStepFromImport(ctx.websiteId, user.id, twoStep) : null,
					},
				};
			},
		},
		requests: {
			prepare: async (ctx) => ({ roles: await roleKeysOf(ctx), phoneFormat: await phoneFormatOf(deps, ctx.websiteId) }),
			check: async (record, ctx) => {
				const checked = checkImportedRequest(
					record,
					/** @type {Pick<import('../core/imports.js').UserRules, 'roles' | 'phoneFormat'>} */ (ctx.prepared),
				);
				if (!checked.ok) return checked;
				const createdAt = checked.value.createdAt ?? (await createdAtOf(ctx, 'requests', checked.value.id));
				return { ok: true, value: { ...checked.value, createdAt } };
			},
		},
		copies: { check: (record, ctx) => checkImportedCopy(record, ctx.websiteId) },
	},

	/**
	 * Accounts derives nothing at the end (the phone's last digits, `createdAt`, `roleSince` and the identity are set per
	 * record): it reports users whose role no longer exists (they act as Customer until it is imported again) and
	 * requests whose user is gone, for example after a prune.
	 * @param {any} ctx
	 */
	finish: async (ctx) => {
		const data = /** @type {WebsiteData} */ (await ctx.data());
		const websiteId = /** @type {string} */ (ctx.websiteId);
		const users = data.collection('users');
		const requests = data.collection('requests');
		const roles = await roleKeysOf({ data, websiteId });
		const unknownRoles = (await users.distinct('role', { websiteId })).filter((role) => !roles.has(role));
		const named = await requests.distinct('userId', { websiteId, userId: { $type: 'string' } });
		const found = new Set(await users.distinct('id', { websiteId, id: { $in: named } }));
		const missing = named.filter((id) => !found.has(id));
		return {
			usersWithUnknownRole:
				unknownRoles.length === 0 ? 0 : await users.countDocuments({ websiteId, role: { $in: unknownRoles } }),
			requestsWithUnknownUser:
				missing.length === 0 ? 0 : await requests.countDocuments({ websiteId, userId: { $in: missing } }),
		};
	},

	/**
	 * The sums `ss-import verify` compares with the source: staff (users whose role grants a permission), users with a
	 * password and with two-step, users per role, and open role requests.
	 * @param {any} ctx
	 */
	totals: async (ctx) => {
		const data = /** @type {WebsiteData} */ (await ctx.data());
		const websiteId = /** @type {string} */ (ctx.websiteId);
		const users = data.collection('users');
		const stored = await data
			.collection('roles')
			.find({ websiteId }, { projection: { _id: 0, key: 1, permissions: 1 } })
			.limit(KEYS_READ)
			.toArray();
		const staffRoles = [...READY_ROLES.filter((role) => !stored.some((own) => own.key === role.key)), ...stored]
			.filter((role) => Array.isArray(role.permissions) && role.permissions.length > 0)
			.map((role) => String(role.key));
		const byRole = await users
			.aggregate([{ $match: { websiteId } }, { $group: { _id: '$role', users: { $sum: 1 } } }, { $sort: { _id: 1 } }])
			.toArray();
		return {
			'users.staff': await users.countDocuments({ websiteId, role: { $in: staffRoles } }),
			'users.withPassword': await users.countDocuments({ websiteId, passwordHash: { $type: 'string' } }),
			'users.twoStep': await users.countDocuments({ websiteId, 'twoStep.enabledAt': { $type: 'date' } }),
			...Object.fromEntries(byRole.map((row) => [`users.role.${row._id}`, Number(row.users)])),
			'requests.pending': await data.collection('requests').countDocuments({ websiteId, status: 'pending' }),
		};
	},
});
