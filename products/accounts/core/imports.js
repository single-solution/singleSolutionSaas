/**
 * Import mode of Accounts' records (PLAN 0.8.10 K10, Migration; A1, A5, A8), pure: the checks of the `import` feature
 * for each record ss-import sends, built on the product's own checks (roles, custom fields, names, addresses, custom
 * values, activity copies) with what an import needs on top: given ids and past times, password hashes from another system and
 * history (blocked users, accepted terms, requests already invited, completed or declined).
 *
 * - Strict: a field a collection does not take is refused by name, so a mapping mistake shows in the dry run; the
 *   website never comes from the record (`websiteId` and `merchantId` are unknown fields).
 * - Text over a limit is refused, never cut (IMP-31). Times are ISO-8601 with their zone.
 * - A user's role and a request's role must exist (a ready-made role, or one imported before).
 * @module
 */
import { isId, validateActivityCopy } from '@ss/contracts';
import { normalisePhone } from '@ss/contracts/phone';
import { normaliseEmail } from './identifiers.js';
import { MAX_ADDRESSES, checkAddresses, checkCustomValues, checkFieldDefinition, checkName } from './profile.js';
import { DEFAULT_ROLE, READY_ROLES, checkRole } from './roles.js';

/** @typedef {{ path: string, message: string }} ImportError */
/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, errors: ImportError[] }} ImportChecked
 */
/** @typedef {import('./profile.js').CustomField} CustomField */
/**
 * A role request as stored (the store's `RequestRecord`).
 * @typedef {{ id: string, role: string, name: string, phone: string | null, email: string | null, note: string,
 *   status: 'pending' | 'invited' | 'completed' | 'declined', userId: string | null,
 *   invitedBy: { kind: string, id: string, name?: string } | null, invitedAt: Date | null, setupExpiresAt: Date | null,
 *   completedAt: Date | null, createdAt?: Date }} ImportedRequest
 */
/**
 * An activity copy as stored (the store's `CopyRecord`).
 * @typedef {{ id: string, productId: string, actor: { kind: string, id: string, name?: string, role?: string },
 *   action: string, target: string, label?: string, detail?: string, at: Date }} ImportedCopy
 */

/** What each collection takes (top-level fields). */
export const IMPORT_FIELDS = Object.freeze({
	roles: Object.freeze([
		'key',
		'name',
		'description',
		'permissions',
		'twoStep',
		'sessionHours',
		'rememberDays',
		'sessionRolling',
		'rank',
		'remember',
		'methods',
		'signIn',
		'logSignIns',
	]),
	fields: Object.freeze(['key', 'label', 'type', 'options', 'required', 'createdAt']),
	users: Object.freeze([
		'id',
		'name',
		'email',
		'emailVerified',
		'phone',
		'phoneVerified',
		'role',
		'roleSince',
		'status',
		'blocked',
		'notes',
		'addresses',
		'custom',
		'providers',
		'identity',
		'passwordHash',
		'twoStep',
		'terms',
		'lastSignInAt',
		'createdAt',
	]),
	requests: Object.freeze([
		'id',
		'role',
		'name',
		'phone',
		'email',
		'note',
		'status',
		'userId',
		'invitedBy',
		'invitedAt',
		'setupExpiresAt',
		'completedAt',
		'createdAt',
	]),
	copies: Object.freeze(['id', 'productId', 'actor', 'action', 'target', 'label', 'detail', 'at']),
});

const ADDRESS_KEYS = Object.freeze([
	'id',
	'label',
	'name',
	'line1',
	'line2',
	'area',
	'city',
	'region',
	'postalCode',
	'country',
	'phone',
	'default',
]);
/** An ISO-8601 time with its zone (`Z` or an offset). */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** A TOTP secret in base32 (80 to 640 bits). */
const TOTP_SECRET = /^[A-Z2-7]{16,128}$/;
/** The source system's recovery-code hash: SHA-256 hex (A8). */
const RECOVERY_HASH = /^[0-9a-fA-F]{64}$/;
const MAX_RECOVERY_HASHES = 20;
const MAX_NOTES = 5000;
const MAX_BLOCKED_REASON = 300;
const MAX_NOTE = 1000;
const MAX_TERMS_VERSION = 40;
const MAX_SUBJECT = 255;
const PROVIDERS = Object.freeze(['google', 'apple', 'facebook']);
const IDENTITIES = Object.freeze(/** @type {const} */ (['email', 'phone', 'provider']));
const USER_STATUSES = Object.freeze(['active', 'pending', 'invited']);
/** Stored request statuses (`expired` is judged on read from `setupExpiresAt`). */
const REQUEST_STATUSES = Object.freeze(['pending', 'invited', 'completed', 'declined']);
const ACTOR_KIND = /^[a-z][a-z_]{0,31}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f]/;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} value */
const absent = (value) => value === undefined || value === null;

/** A JSON Pointer of a top-level field. @param {string} name */
const pointer = (name) => `/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`;

/**
 * A time as JSON carries it (ISO-8601 with its zone), or null.
 * @param {unknown} value
 * @returns {Date | null}
 */
export const timeOf = (value) => {
	if (typeof value !== 'string' || !TIME.test(value)) return null;
	const at = Date.parse(value);
	return Number.isNaN(at) ? null : new Date(at);
};

/**
 * One error per field the record holds that the collection does not take, naming it.
 * @param {Record<string, unknown>} record
 * @param {ReadonlyArray<string>} allowed
 * @param {string} what `a user`, `an address` …
 * @param {string} [at] the pointer of the object in the record
 * @returns {ImportError[]}
 */
export const unknownFields = (record, allowed, what, at = '') =>
	Object.keys(record)
		.filter((name) => !allowed.includes(name))
		.map((name) => ({ path: `${at}${pointer(name)}`, message: `${name} is not a field of ${what}.` }));

/**
 * Errors for given values of the wrong JSON type (the product's own checks read those as their defaults).
 * @param {Record<string, unknown>} record
 * @param {Record<string, 'string' | 'boolean' | 'array'>} types
 * @returns {ImportError[]}
 */
const wrongTypes = (record, types) =>
	Object.entries(types)
		.filter(([name, type]) => {
			const value = record[name];
			return value !== undefined && (type === 'array' ? !Array.isArray(value) : typeof value !== type);
		})
		.map(([name, type]) => ({ path: pointer(name), message: `${name} is ${type === 'array' ? 'a list' : `a ${type}`}.` }));

/**
 * A time field: absent or null → null; otherwise it must be a time.
 * @param {Record<string, unknown>} record @param {string} name @param {ImportError[]} errors
 * @returns {Date | null}
 */
const optionalTime = (record, name, errors) => {
	if (absent(record[name])) return null;
	const at = timeOf(record[name]);
	if (!at) errors.push({ path: pointer(name), message: `${name} is an ISO-8601 time with its zone (2024-05-01T10:00:00Z).` });
	return at;
};

/**
 * A boolean field (false when absent).
 * @param {Record<string, unknown>} record @param {string} name @param {ImportError[]} errors
 */
const flagOf = (record, name, errors) => {
	if (record[name] === undefined) return false;
	if (typeof record[name] !== 'boolean') errors.push({ path: pointer(name), message: `${name} is true or false.` });
	return record[name] === true;
};

/**
 * Plain text of at most `max` characters ('' when absent), or null with an error.
 * @param {Record<string, unknown>} record @param {string} name @param {number} max @param {ImportError[]} errors
 * @param {string} [at] the pointer of the object in the record
 */
const textOf = (record, name, max, errors, at = '') => {
	const value = record[name];
	if (absent(value)) return '';
	if (typeof value !== 'string' || value.length > max) {
		errors.push({ path: `${at}${pointer(name)}`, message: `${name} is text of at most ${max} characters.` });
		return null;
	}
	return value;
};

/**
 * An e-mail address and a phone number as Accounts keeps them (canonical e-mail, E.164 phone with the website's
 * phone format); errors name the field.
 * @param {Record<string, unknown>} record
 * @param {{ defaultCallingCode?: string, trunkPrefix?: string }} phoneFormat
 * @param {ImportError[]} errors
 */
const contactsOf = (record, phoneFormat, errors) => {
	const email = absent(record.email) ? null : normaliseEmail(record.email);
	if (email === null && !absent(record.email)) errors.push({ path: '/email', message: 'Not a valid e-mail address.' });
	const phone = absent(record.phone) ? null : normalisePhone(record.phone, phoneFormat);
	if (phone === null && !absent(record.phone))
		errors.push({ path: '/phone', message: 'Not a phone number: give it with its country code.' });
	if (absent(record.email) && absent(record.phone))
		errors.push({ path: '/email', message: 'Give an e-mail address or a phone number.' });
	return { email, phone };
};

/**
 * A role the record names: it must exist (a ready-made role, or one imported before).
 * @param {Record<string, unknown>} record @param {ReadonlySet<string>} roles @param {ImportError[]} errors
 * @param {string} [fallback] the role when none is given
 */
const roleOf = (record, roles, errors, fallback) => {
	const role = record.role === undefined && fallback ? fallback : record.role;
	if (typeof role !== 'string' || !roles.has(role)) {
		errors.push({ path: '/role', message: `There is no such role: ${String(role)}. Import the roles first.` });
		return '';
	}
	return role;
};

/** @template T @param {ImportError[]} errors @param {() => T} value @returns {ImportChecked<T>} */
const resultOf = (errors, value) => (errors.length > 0 ? { ok: false, errors } : { ok: true, value: value() });

// --------------------------------------------------------------------------------------------------------- roles

/**
 * A role (`roles`, found by `key`): the merchant's own, such as a `member` copy of Customer, or a ready-made one with
 * the merchant's changes (it keeps its rank and stays ready-made).
 * @param {Record<string, unknown>} record
 * @returns {ImportChecked<import('./roles.js').Role>}
 */
export const checkImportedRole = (record) => {
	const errors = [
		...unknownFields(record, IMPORT_FIELDS.roles, 'a role'),
		...wrongTypes(record, {
			name: 'string',
			description: 'string',
			permissions: 'array',
			methods: 'array',
			sessionRolling: 'boolean',
			logSignIns: 'boolean',
		}),
	];
	if (record.twoStep !== undefined && record.twoStep !== 'optional' && record.twoStep !== 'required')
		errors.push({ path: '/twoStep', message: 'twoStep is optional or required.' });
	const readyMade = READY_ROLES.find((role) => role.key === record.key);
	if (readyMade && record.rank !== undefined && record.rank !== readyMade.rank)
		errors.push({ path: '/rank', message: `A ready-made role keeps its rank (${readyMade.rank}).` });
	if (errors.length > 0) return { ok: false, errors };
	const checked = checkRole(String(record.key), record);
	if (!checked.ok) return { ok: false, errors: [{ path: `/${checked.field}`, message: checked.message }] };
	return { ok: true, value: { ...checked.value, ready: Boolean(readyMade) } };
};

// ------------------------------------------------------------------------------------------------ custom fields

/**
 * A custom field (`fields`, found by `key`); `createdAt` keeps the order of the fields list.
 * @param {Record<string, unknown>} record
 * @returns {ImportChecked<CustomField & { createdAt?: Date }>}
 */
export const checkImportedField = (record) => {
	const errors = [
		...unknownFields(record, IMPORT_FIELDS.fields, 'a custom field'),
		...wrongTypes(record, { label: 'string', type: 'string', options: 'array', required: 'boolean' }),
	];
	if (record.type !== 'choice' && Array.isArray(record.options) && record.options.length > 0)
		errors.push({ path: '/options', message: 'Only a choice field has options.' });
	const createdAt = optionalTime(record, 'createdAt', errors);
	if (errors.length > 0) return { ok: false, errors };
	const checked = checkFieldDefinition(String(record.key), record);
	if (!checked.ok) return { ok: false, errors: [{ path: `/${checked.field}`, message: checked.message }] };
	return { ok: true, value: { ...checked.value, ...(createdAt ? { createdAt } : {}) } };
};

// --------------------------------------------------------------------------------------------------------- users

/**
 * What a user check reads of the website.
 * @typedef {object} UserRules
 * @property {ReadonlySet<string>} roles the role keys that exist
 * @property {ReadonlyArray<CustomField>} fields the custom fields
 * @property {{ defaultCallingCode?: string, trunkPrefix?: string }} phoneFormat the website's phone format
 * @property {(hash: string) => boolean} isPasswordHash a hash Accounts' password check reads (A1)
 */

/**
 * A user as the import check gives it: the stored user record, but two-step still as the importer sent it (the
 * adapter seals the secret at once, A8), without the phone's last digits (the store derives them) and with
 * `createdAt` and `roleSince` only when the source gives them (`roleSince` defaults to `createdAt`; the adapter sets
 * both when the source gives neither).
 * @typedef {Omit<import('./profile.js').UserRecord, 'twoStep' | 'createdAt' | 'roleSince' | 'phoneDigits'> & {
 *   createdAt?: Date, roleSince?: Date, twoStep: { secret: string, recoveryHashes: string[] } | null }} ImportedUser
 */

/**
 * Addresses of an imported user: the product's address check without the Profile settings (history: at most 10, and
 * only the first line is needed); an address without an id gets one from the user id and its place, so a re-run
 * keeps it.
 * @param {unknown} input @param {string} userId @param {ImportError[]} errors
 */
const addressesOf = (input, userId, errors) => {
	if (input === undefined) return [];
	const list = Array.isArray(input) ? input : [];
	for (const [index, address] of list.entries()) {
		if (!isObject(address)) errors.push({ path: `/addresses/${index}`, message: 'An address is an object.' });
		else errors.push(...unknownFields(address, ADDRESS_KEYS, 'an address', `/addresses/${index}`));
	}
	const own = userId.slice(userId.indexOf('_') + 1, userId.indexOf('_') + 31);
	const checked = checkAddresses(input, (index) => `adr_${own}${String(index).padStart(2, '0')}`, {
		max: MAX_ADDRESSES,
		required: ['line1'],
	});
	if (!checked.ok) {
		errors.push({ path: `/${checked.field}`, message: checked.message });
		return [];
	}
	return checked.value;
};

/**
 * Social sign-ins: provider → the provider's user id.
 * @param {unknown} input @param {ImportError[]} errors
 * @returns {Record<string, string>}
 */
const providersOf = (input, errors) => {
	if (absent(input)) return {};
	if (!isObject(input)) {
		errors.push({ path: '/providers', message: 'providers is an object: { google, apple, facebook } → their user id.' });
		return {};
	}
	errors.push(...unknownFields(input, PROVIDERS, 'providers', '/providers'));
	/** @type {Record<string, string>} */
	const out = {};
	for (const name of PROVIDERS) {
		const subject = input[name];
		if (subject === undefined) continue;
		if (typeof subject !== 'string' || subject === '' || subject.length > MAX_SUBJECT || CONTROL.test(subject))
			errors.push({ path: `/providers/${name}`, message: `The ${name} user id is text of 1 to ${MAX_SUBJECT} characters.` });
		else out[name] = subject;
	}
	return out;
};

/**
 * Two-step sign-in from the source system (A8): `{ secret, recoveryHashes }`, the plain TOTP secret (base32) and the
 * SHA-256 hashes of its recovery codes.
 * @param {unknown} input @param {ImportError[]} errors
 * @returns {{ secret: string, recoveryHashes: string[] } | null}
 */
const twoStepOf = (input, errors) => {
	if (absent(input)) return null;
	if (!isObject(input)) {
		errors.push({ path: '/twoStep', message: 'twoStep is { secret, recoveryHashes }.' });
		return null;
	}
	const before = errors.length;
	errors.push(...unknownFields(input, ['secret', 'recoveryHashes'], 'twoStep', '/twoStep'));
	const secret = typeof input.secret === 'string' ? input.secret.toUpperCase().replace(/[\s=-]/g, '') : '';
	if (!TOTP_SECRET.test(secret))
		errors.push({ path: '/twoStep/secret', message: 'The secret is the authenticator key in base32 (16 to 128 characters).' });
	const hashes = input.recoveryHashes ?? [];
	if (
		!Array.isArray(hashes) ||
		hashes.length > MAX_RECOVERY_HASHES ||
		hashes.some((hash) => typeof hash !== 'string' || !RECOVERY_HASH.test(hash))
	)
		errors.push({
			path: '/twoStep/recoveryHashes',
			message: `recoveryHashes holds up to ${MAX_RECOVERY_HASHES} SHA-256 hashes (64 hex digits).`,
		});
	return errors.length > before ? null : { secret, recoveryHashes: /** @type {string[]} */ (hashes) };
};

/**
 * The address the account signs in by (A6): as given, which must be there, else the only one it has (both: unknown).
 * @param {unknown} input
 * @param {{ email: string | null, phone: string | null, providers: Record<string, string> }} user
 * @param {ImportError[]} errors
 * @returns {import('./profile.js').Identity | null}
 */
const identityOf = (input, { email, phone, providers }, errors) => {
	if (absent(input)) return email && !phone ? 'email' : phone && !email ? 'phone' : null;
	const has = { email: Boolean(email), phone: Boolean(phone), provider: Object.keys(providers).length > 0 };
	const identity = IDENTITIES.find((each) => each === input);
	if (!identity || !has[identity]) {
		errors.push({ path: '/identity', message: 'identity is email, phone or provider, and the user has it.' });
		return null;
	}
	return identity;
};

/**
 * A user (`users`, id `usr_…`): a shopper or a member of staff with their history. The password hash is kept as
 * given in a format Accounts checks (A1); unknown hash formats are refused. Verified flags need the address.
 * @param {Record<string, unknown>} record
 * @param {UserRules} rules
 * @returns {ImportChecked<ImportedUser>}
 */
export const checkImportedUser = (record, rules) => {
	const errors = unknownFields(record, IMPORT_FIELDS.users, 'a user');
	const id = String(record.id);
	if (!isId(id, 'usr')) errors.push({ path: '/id', message: 'A user id is usr_<id>.' });
	const name = checkName(record.name);
	if (name === null) errors.push({ path: '/name', message: 'The name is text of at most 120 characters on one line.' });
	const { email, phone } = contactsOf(record, rules.phoneFormat, errors);
	const emailVerified = flagOf(record, 'emailVerified', errors);
	const phoneVerified = flagOf(record, 'phoneVerified', errors);
	if (emailVerified && !email) errors.push({ path: '/emailVerified', message: 'Only an e-mail address can be verified.' });
	if (phoneVerified && !phone) errors.push({ path: '/phoneVerified', message: 'Only a phone number can be verified.' });
	const role = roleOf(record, rules.roles, errors, DEFAULT_ROLE);
	const status = record.status ?? 'active';
	if (!USER_STATUSES.includes(/** @type {string} */ (status)))
		errors.push({ path: '/status', message: 'status is active, pending or invited.' });
	const notes = textOf(record, 'notes', MAX_NOTES, errors);
	/** @type {{ at: Date, reason: string } | null} */
	let blocked = null;
	if (isObject(record.blocked)) {
		errors.push(...unknownFields(record.blocked, ['at', 'reason'], 'blocked', '/blocked'));
		const at = timeOf(record.blocked.at);
		if (!at) errors.push({ path: '/blocked/at', message: 'blocked.at is an ISO-8601 time with its zone.' });
		const reason = textOf(record.blocked, 'reason', MAX_BLOCKED_REASON, errors, '/blocked');
		if (at && reason !== null) blocked = { at, reason };
	} else if (!absent(record.blocked)) errors.push({ path: '/blocked', message: 'blocked is { at, reason } or null.' });
	const addresses = addressesOf(record.addresses, id, errors);
	const custom = checkCustomValues(rules.fields, record.custom, { complete: false });
	if (!custom.ok) errors.push({ path: `/${custom.field}`, message: custom.message });
	const providers = providersOf(record.providers, errors);
	const identity = identityOf(record.identity, { email, phone, providers }, errors);
	const passwordHash = absent(record.passwordHash) ? null : record.passwordHash;
	if (passwordHash !== null && (typeof passwordHash !== 'string' || !rules.isPasswordHash(passwordHash)))
		errors.push({
			path: '/passwordHash',
			message:
				'Not a hash Accounts checks: bcrypt ($2a$, $2b$, $2y$), pbkdf2$<iterations>$<salt>$<hash> or scrypt$<salt>$<hash>.',
		});
	const twoStep = twoStepOf(record.twoStep, errors);
	/** @type {{ version: string, acceptedAt: Date } | null} */
	let terms = null;
	if (isObject(record.terms)) {
		errors.push(...unknownFields(record.terms, ['version', 'acceptedAt'], 'terms', '/terms'));
		const version = record.terms.version;
		const acceptedAt = timeOf(record.terms.acceptedAt);
		if (typeof version !== 'string' || version === '' || version.length > MAX_TERMS_VERSION)
			errors.push({ path: '/terms/version', message: `terms.version is text of 1 to ${MAX_TERMS_VERSION} characters.` });
		else if (!acceptedAt) errors.push({ path: '/terms/acceptedAt', message: 'terms.acceptedAt is an ISO-8601 time.' });
		else terms = { version, acceptedAt };
	} else if (!absent(record.terms)) errors.push({ path: '/terms', message: 'terms is { version, acceptedAt } or null.' });
	const lastSignInAt = optionalTime(record, 'lastSignInAt', errors);
	const createdAt = optionalTime(record, 'createdAt', errors);
	const roleSince = optionalTime(record, 'roleSince', errors) ?? createdAt;
	return resultOf(errors, () => ({
		id,
		email,
		emailVerified,
		phone,
		phoneVerified,
		name: /** @type {string} */ (name),
		addresses,
		custom: custom.ok ? custom.value : {},
		notes: /** @type {string} */ (notes),
		blocked,
		status: /** @type {'active' | 'pending' | 'invited'} */ (status),
		role,
		providers,
		...(identity ? { identity } : {}),
		passwordHash: /** @type {string | null} */ (passwordHash),
		twoStep,
		failedLogins: 0,
		lockedUntil: null,
		lockLevel: 0,
		terms,
		deletion: null,
		deviceHash: null,
		lastSignInAt,
		...(roleSince ? { roleSince } : {}),
		...(createdAt ? { createdAt } : {}),
	}));
};

// ------------------------------------------------------------------------------------------------ role requests

/**
 * A role request (`requests`, id `rrq_…`, A5) with its history. Setup links are not imported: Accounts' links carry
 * their record id, so the source system's link cannot open here; staff give a new one (A3).
 * @param {Record<string, unknown>} record
 * @param {Pick<UserRules, 'roles' | 'phoneFormat'>} rules
 * @returns {ImportChecked<ImportedRequest>}
 */
export const checkImportedRequest = (record, rules) => {
	const errors = unknownFields(record, IMPORT_FIELDS.requests, 'a role request');
	const id = String(record.id);
	if (!isId(id, 'rrq')) errors.push({ path: '/id', message: 'A role request id is rrq_<id>.' });
	const role = roleOf(record, rules.roles, errors);
	const name = checkName(record.name);
	if (!name) errors.push({ path: '/name', message: 'The name is text of 1 to 120 characters on one line.' });
	const { email, phone } = contactsOf(record, rules.phoneFormat, errors);
	const note = textOf(record, 'note', MAX_NOTE, errors);
	const status = record.status ?? 'pending';
	if (!REQUEST_STATUSES.includes(/** @type {string} */ (status)))
		errors.push({
			path: '/status',
			message: 'status is pending, invited, completed or declined (expired is an invited request past setupExpiresAt).',
		});
	const userId = absent(record.userId) ? null : record.userId;
	if (userId !== null && !isId(userId, 'usr')) errors.push({ path: '/userId', message: 'userId is the user’s id (usr_…).' });
	if ((status === 'invited' || status === 'completed') && userId === null)
		errors.push({ path: '/userId', message: 'An invited or completed request names its user.' });
	/** @type {{ kind: string, id: string, name?: string } | null} */
	let invitedBy = null;
	if (isObject(record.invitedBy)) {
		const by = record.invitedBy;
		errors.push(...unknownFields(by, ['kind', 'id', 'name'], 'invitedBy', '/invitedBy'));
		const byName = textOf(by, 'name', 200, errors, '/invitedBy');
		if (
			typeof by.kind !== 'string' ||
			!ACTOR_KIND.test(by.kind) ||
			typeof by.id !== 'string' ||
			by.id === '' ||
			by.id.length > 256
		)
			errors.push({ path: '/invitedBy', message: 'invitedBy is { kind, id, name? } (kind: user, server …).' });
		else if (byName !== null) invitedBy = { kind: by.kind, id: by.id, ...(byName ? { name: byName } : {}) };
	} else if (!absent(record.invitedBy))
		errors.push({ path: '/invitedBy', message: 'invitedBy is { kind, id, name? } or null.' });
	const invitedAt = optionalTime(record, 'invitedAt', errors);
	const setupExpiresAt = optionalTime(record, 'setupExpiresAt', errors);
	const completedAt = optionalTime(record, 'completedAt', errors);
	const createdAt = optionalTime(record, 'createdAt', errors);
	return resultOf(errors, () => ({
		id,
		role,
		name: /** @type {string} */ (name),
		phone,
		email,
		note: /** @type {string} */ (note),
		status: /** @type {'pending' | 'invited' | 'completed' | 'declined'} */ (status),
		userId: /** @type {string | null} */ (userId),
		invitedBy,
		invitedAt,
		setupExpiresAt,
		completedAt,
		...(createdAt ? { createdAt } : {}),
	}));
};

// ---------------------------------------------------------------------------------------------- activity copies

/**
 * An activity entry of the source system (`copies`, its id as given): the activity-copy shape other products send
 * (K9), so the Activity screen keeps its history.
 * @param {Record<string, unknown>} record
 * @param {string} websiteId the website the call is for
 * @returns {ImportChecked<ImportedCopy>}
 */
export const checkImportedCopy = (record, websiteId) => {
	const errors = unknownFields(record, IMPORT_FIELDS.copies, 'an activity copy');
	if (errors.length > 0) return { ok: false, errors };
	const { id, ...copy } = record;
	const checked = validateActivityCopy({ ...copy, websiteId });
	if (!checked.ok) return { ok: false, errors: checked.problems.map(({ path, message }) => ({ path, message })) };
	const { productId, actor, action, target, label, detail, at } = checked.value;
	return {
		ok: true,
		value: {
			id: String(id),
			productId,
			actor,
			action,
			target,
			...(label ? { label } : {}),
			...(detail ? { detail } : {}),
			at: new Date(at),
		},
	};
};
