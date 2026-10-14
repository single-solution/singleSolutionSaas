/**
 * Profiles (PLAN 0.8.6), pure: the standard fields (name, email, phone, addresses, merchant-only notes, blocked flag
 * and reason), the merchant's custom fields (text, number, date, choice) and the views of a user: what the user
 * sees in My account, and what the merchant's server and staff see.
 * @module
 */

/** Most addresses a user can keep (the Profile setting `maxAddresses` may lower it, PLAN 0.8.10 A11). */
export const MAX_ADDRESSES = 10;
/** The address fields; `addressRequired` names the ones that must be filled (A11). */
export const ADDRESS_FIELDS = Object.freeze(
	/** @type {const} */ (['name', 'line1', 'line2', 'area', 'city', 'region', 'postalCode', 'country', 'phone']),
);
export const MAX_CUSTOM_FIELDS = 50;
const FIELD_TYPES = Object.freeze(/** @type {const} */ (['text', 'number', 'date', 'choice']));
const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COUNTRY = /^[A-Z]{2}$/;

/**
 * @typedef {object} CustomField
 * @property {string} key
 * @property {string} label
 * @property {'text' | 'number' | 'date' | 'choice'} type
 * @property {string[]} options choices (type choice)
 * @property {boolean} required asked at sign-up and never left empty
 */

/**
 * @typedef {object} Address
 * @property {string} id
 * @property {string} label
 * @property {string} name
 * @property {string} line1
 * @property {string} line2
 * @property {string} area the area or neighborhood (A11)
 * @property {string} city
 * @property {string} region
 * @property {string} postalCode
 * @property {string} country ISO 3166-1 alpha-2, or ''
 * @property {string} phone
 * @property {boolean} default the user's default address: one per user, the first when none is chosen (A11)
 */

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string | null} trimmed text, '' when absent, null when too long or not text
 */
const text = (value, max) => {
	if (value === undefined || value === null) return '';
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > max || [...trimmed].some((ch) => ch.charCodeAt(0) < 32) ? null : trimmed;
};

/**
 * A name (at most 120 characters).
 * @param {unknown} value
 * @returns {string | null}
 */
export const checkName = (value) => text(value, 120);

/**
 * Check a custom field definition as the merchant saves it (the key comes from the path).
 * @param {string} key
 * @param {unknown} input
 * @returns {{ ok: true, value: CustomField } | { ok: false, field: string, message: string }}
 */
export const checkFieldDefinition = (key, input) => {
	const body = typeof input === 'object' && input !== null ? /** @type {Record<string, unknown>} */ (input) : {};
	if (!FIELD_KEY.test(key)) return { ok: false, field: 'key', message: 'Use 1–40 lower-case letters, digits or _.' };
	const label = text(body.label, 80);
	if (!label) return { ok: false, field: 'label', message: 'Write the label (at most 80 characters).' };
	const type = FIELD_TYPES.find((t) => t === body.type);
	if (!type) return { ok: false, field: 'type', message: 'The type is text, number, date or choice.' };
	const options = Array.isArray(body.options)
		? [...new Set(body.options.map((o) => (typeof o === 'string' ? o.trim() : '')))]
		: [];
	if (type === 'choice' && (options.length === 0 || options.length > 50 || options.some((o) => o === '' || o.length > 80)))
		return { ok: false, field: 'options', message: 'A choice needs 1 to 50 options of at most 80 characters.' };
	return { ok: true, value: { key, label, type, options: type === 'choice' ? options : [], required: body.required === true } };
};

/**
 * Check custom field values against the definitions. Unknown keys are refused; `complete` also refuses a missing
 * required field (sign-up); otherwise only the fields sent are checked (an update).
 * @param {ReadonlyArray<CustomField>} fields
 * @param {unknown} input
 * @param {{ complete: boolean, current?: Record<string, string | number> }} options
 * @returns {{ ok: true, value: Record<string, string | number> } | { ok: false, field: string, message: string }}
 */
export const checkCustomValues = (fields, input, { complete, current = {} }) => {
	const body = input === undefined || input === null ? {} : input;
	if (typeof body !== 'object' || Array.isArray(body))
		return { ok: false, field: 'custom', message: 'Send the fields as an object.' };
	/** @type {Record<string, string | number>} */
	const out = { ...current };
	for (const [key, raw] of Object.entries(body)) {
		const field = fields.find((f) => f.key === key);
		if (!field) return { ok: false, field: `custom/${key}`, message: 'There is no such field.' };
		if (raw === null || raw === '') {
			delete out[key];
			continue;
		}
		if (field.type === 'number') {
			if (typeof raw !== 'number' || !Number.isFinite(raw))
				return { ok: false, field: `custom/${key}`, message: `${field.label} must be a number.` };
			out[key] = raw;
		} else {
			const value = text(raw, 1000);
			if (value === null || value === '')
				return { ok: false, field: `custom/${key}`, message: `${field.label} is not valid.` };
			if (field.type === 'date' && (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))))
				return { ok: false, field: `custom/${key}`, message: `${field.label} must be a date (YYYY-MM-DD).` };
			if (field.type === 'choice' && !field.options.includes(value))
				return { ok: false, field: `custom/${key}`, message: `${field.label} must be one of the choices.` };
			out[key] = value;
		}
	}
	for (const field of fields)
		if (field.required && (complete || Object.hasOwn(body, field.key)) && out[field.key] === undefined)
			return { ok: false, field: `custom/${field.key}`, message: `${field.label} is required.` };
	return { ok: true, value: out };
};

/**
 * Check the user's addresses (the whole list is saved at once) with the website's Profile settings (A11): at most
 * `max` addresses, the `required` fields filled, the last one kept with `keepOne`, and one default address (the first
 * when none is chosen).
 * @param {unknown} input
 * @param {(index: number) => string} idOf a new id for an address without one
 * @param {{ max?: number, required?: ReadonlyArray<string>, keepOne?: boolean, before?: number }} [rules] `before`: how
 *   many addresses the user has now
 * @returns {{ ok: true, value: Address[] } | { ok: false, field: string, message: string }}
 */
export const checkAddresses = (
	input,
	idOf,
	{ max = MAX_ADDRESSES, required = ['line1', 'city'], keepOne = false, before = 0 } = {},
) => {
	const most = Math.min(max, MAX_ADDRESSES);
	if (!Array.isArray(input) || input.length > most)
		return { ok: false, field: 'addresses', message: `Send up to ${most} addresses.` };
	if (keepOne && before > 0 && input.length === 0)
		return { ok: false, field: 'addresses', message: 'Keep at least one address.' };
	if (input.filter((raw) => raw?.default === true).length > 1)
		return { ok: false, field: 'addresses', message: 'Only one address can be the default.' };
	/** @type {Address[]} */
	const out = [];
	for (const [index, raw] of input.entries()) {
		const a = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
		const fields = {
			label: text(a.label, 40),
			name: text(a.name, 120),
			line1: text(a.line1, 200),
			line2: text(a.line2, 200),
			area: text(a.area, 100),
			city: text(a.city, 100),
			region: text(a.region, 100),
			postalCode: text(a.postalCode, 20),
			country: text(a.country, 2),
			phone: text(a.phone, 40),
		};
		const bad = Object.entries(fields).find(([, v]) => v === null);
		if (bad) return { ok: false, field: `addresses/${index}/${bad[0]}`, message: 'This value is too long.' };
		const f = /** @type {Record<keyof typeof fields, string>} */ (fields);
		const missing = required.find((name) => name in f && f[/** @type {keyof typeof f} */ (name)] === '');
		if (missing) return { ok: false, field: `addresses/${index}/${missing}`, message: 'Fill out this part of the address.' };
		const country = f.country.toUpperCase();
		if (country !== '' && !COUNTRY.test(country))
			return { ok: false, field: `addresses/${index}/country`, message: 'Use a two-letter country code.' };
		const id = typeof a.id === 'string' && /^adr_[0-9a-z]{6,40}$/.test(a.id) ? a.id : idOf(index);
		out.push({ id, ...f, country, default: a.default === true });
	}
	if (out.length > 0 && !out.some((address) => address.default)) /** @type {Address} */ (out[0]).default = true;
	return { ok: true, value: out };
};

/**
 * The address an account was made with, which it signs in by: `email` (an email sign-up or invite), `phone` (a phone
 * sign-up or invite) or `provider` (Google, Apple or Facebook).
 * @typedef {'email' | 'phone' | 'provider'} Identity
 */

/** The identity of an account a sign-up method makes. @type {Readonly<Record<string, Identity>>} */
const IDENTITY_OF_METHOD = Object.freeze({
	email_password: 'email',
	email_code: 'email',
	phone_password: 'phone',
	phone_code: 'phone',
});

/**
 * The identity of an account a sign-up method makes (Google, Apple and Facebook: `provider`).
 * @param {string} method
 * @returns {Identity}
 */
export const identityOfMethod = (method) => IDENTITY_OF_METHOD[method] ?? 'provider';

/**
 * An account's identity. An imported account may have none stored (its source did not say, and it had both an email
 * address and a phone number, or neither): while it has an email address and no phone number it signs in by the
 * address; otherwise which one is not known (null).
 * @param {Pick<UserRecord, 'identity' | 'email' | 'phone'>} user
 * @returns {Identity | null}
 */
export const identityOf = (user) => user.identity ?? (user.email && !user.phone ? 'email' : null);

/**
 * Whether a password reset link may go to the user's email address: a proven address, or the address the account was
 * made with. An address typed but never proven on an account that signs in another way (for example at a phone +
 * password sign-up) is no way in: its owner would take over that account.
 * @param {Pick<UserRecord, 'identity' | 'email' | 'emailVerified' | 'phone'>} user
 */
export const resetsByEmail = (user) => user.emailVerified || identityOf(user) === 'email';

/**
 * @typedef {object} UserRecord
 * @property {string} id
 * @property {string | null} email
 * @property {boolean} emailVerified
 * @property {string | null} phone
 * @property {boolean} phoneVerified
 * @property {string} name
 * @property {Address[]} addresses
 * @property {Record<string, string | number>} custom
 * @property {string} notes
 * @property {{ at: Date, reason: string } | null} blocked
 * @property {'active' | 'pending' | 'invited'} status
 * @property {string} role
 * @property {Record<string, string>} providers social sign-ins: provider → the provider's user id
 * @property {Identity} [identity] the address the account was made with and signs in by (absent on an imported
 *   account whose source did not say: see `identityOf`)
 * @property {string | null} passwordHash
 * @property {{ sealed: string, lastStep: number | null, recovery: Array<{ hash: string, format: 'v1' | 'sha256_prefixed' }>,
 *   enabledAt: Date | null } | null} twoStep recovery codes as hashes with their format (A8)
 * @property {number} failedLogins
 * @property {Date | null} lockedUntil
 * @property {number} [lockLevel] how far a growing lock has grown (A9)
 * @property {string | null} [phoneDigits] the last 10 digits of the phone (A4)
 * @property {Date} roleSince when the role was last set (A5: "Member since"; an import gives the source's, else
 *   `createdAt`)
 * @property {{ version: string, acceptedAt: Date } | null} terms
 * @property {{ requestedAt: Date, dueAt: Date | null } | null} deletion
 * @property {string | null} deviceHash
 * @property {Date | null} lastSignInAt
 * @property {Date} createdAt
 */

/**
 * What the user sees of themselves (My account): never notes, password or secrets.
 * @param {UserRecord} user
 */
export const selfView = (user) => ({
	id: user.id,
	email: user.email,
	emailVerified: user.emailVerified,
	phone: user.phone,
	phoneVerified: user.phoneVerified,
	name: user.name,
	addresses: user.addresses,
	custom: user.custom,
	role: user.role,
	providers: Object.keys(user.providers).sort(),
	hasPassword: Boolean(user.passwordHash),
	twoStep: Boolean(user.twoStep?.enabledAt),
	terms: user.terms ? { version: user.terms.version, acceptedAt: user.terms.acceptedAt.toISOString() } : null,
	deletion: user.deletion
		? { requestedAt: user.deletion.requestedAt.toISOString(), dueAt: user.deletion.dueAt?.toISOString() ?? null }
		: null,
	roleSince: user.roleSince.toISOString(),
	createdAt: user.createdAt.toISOString(),
});

/**
 * What the merchant's server and staff see (Users admin): the profile, notes, blocked flag, status and role.
 * @param {UserRecord} user
 */
export const staffView = (user) => ({
	...selfView(user),
	notes: user.notes,
	blocked: user.blocked ? { at: user.blocked.at.toISOString(), reason: user.blocked.reason } : null,
	status: user.status,
	lastSignInAt: user.lastSignInAt?.toISOString() ?? null,
	lockedUntil: user.lockedUntil?.toISOString() ?? null,
	recoveryCodesLeft: user.twoStep?.enabledAt ? user.twoStep.recovery.length : null,
});
