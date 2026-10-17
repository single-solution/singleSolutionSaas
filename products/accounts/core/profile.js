/**
 * Profiles (PLAN 0.8.6), pure: the standard fields (name, email, phone, addresses, merchant-only notes, blocked flag
 * and reason), the merchant's custom fields (A6: text, long text, number, date, choice, several choices, yes/no, email
 * address and web address, each with a help text and who sees it) and the views of a user: what the user sees in My
 * account, and what the merchant's server and staff see.
 * @module
 */
import { ownConsents } from './consents.js';
import { PLACE_PARTS, addressProblem, countryCodeOf, countryName, tidyPostcode } from '@ss/contracts/address';
import { MAX_CHOICES } from './limits.js';
import { ADDRESS_LIMITS } from './widgets.js';

/**
 * Most addresses a user can have, the ceiling an import may reach; a website's own live cap is `ADDRESSES_PER_USER`
 * (limits.js).
 */
export const MAX_ADDRESSES = 50;
/** Most tags one user has (A5). */
const MAX_TAGS = 20;
/** Longest tag. */
const TAG_LENGTH = 40;
const FIELD_TYPES = Object.freeze(
	/** @type {const} */ (['text', 'textarea', 'number', 'date', 'choice', 'multi_choice', 'boolean', 'email', 'url']),
);
/**
 * Who sees a custom field (A6): `edit` the user sees and changes it (sign-up asks the required ones), `view` the user
 * sees it and only staff change it, `staff` only staff and the merchant's server see it.
 */
const FIELD_VISIBILITY = Object.freeze(/** @type {const} */ (['edit', 'view', 'staff']));
/** The types whose fields have options. */
const CHOICE_TYPES = Object.freeze(['choice', 'multi_choice']);
/** Longest value of a long-text field, and of the other text values. */
const LONG_TEXT = 5000;
const SHORT_TEXT = 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The longest country the API reads: a code or an English name (kept as the code). */
const COUNTRY_INPUT = 60;

/**
 * @typedef {object} CustomField
 * @property {string} key
 * @property {string} label
 * @property {typeof FIELD_TYPES[number]} type
 * @property {string[]} options choices (types choice and multi_choice)
 * @property {boolean} required never left empty; sign-up asks it when the user edits the field
 * @property {typeof FIELD_VISIBILITY[number]} visibility who sees and changes it (A6)
 * @property {string} help a short help text shown with the field ('' for none)
 */
/** A custom value: text, a number, yes/no or several choices. @typedef {string | number | boolean | string[]} CustomValue */

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
	const most = MAX_CHOICES;
	const body = typeof input === 'object' && input !== null ? /** @type {Record<string, unknown>} */ (input) : {};
	if (!FIELD_KEY.test(key)) return { ok: false, field: 'key', message: 'Use 1–40 lower-case letters, digits or _.' };
	const label = text(body.label, 80);
	if (!label) return { ok: false, field: 'label', message: 'Write the label (at most 80 characters).' };
	const type = FIELD_TYPES.find((t) => t === body.type);
	if (!type) return { ok: false, field: 'type', message: `The type is one of ${FIELD_TYPES.join(', ')}.` };
	const options = Array.isArray(body.options)
		? [...new Set(body.options.map((o) => (typeof o === 'string' ? o.trim() : '')))]
		: [];
	const choices = CHOICE_TYPES.includes(type);
	if (choices && (options.length === 0 || options.length > most || options.some((o) => o === '' || o.length > 80)))
		return { ok: false, field: 'options', message: `A choice needs 1 to ${most} options of at most 80 characters.` };
	const visibility = body.visibility === undefined ? 'edit' : FIELD_VISIBILITY.find((v) => v === body.visibility);
	if (!visibility) return { ok: false, field: 'visibility', message: 'Visibility is edit, view or staff.' };
	const help = text(body.help, 200);
	if (help === null) return { ok: false, field: 'help', message: 'The help text is at most 200 characters on one line.' };
	return {
		ok: true,
		value: { key, label, type, options: choices ? options : [], required: body.required === true, visibility, help },
	};
};

/**
 * One custom value checked against its field, or a refusal message (`raw` is not empty).
 * @param {CustomField} field @param {unknown} raw
 * @returns {{ ok: true, value: CustomValue } | { ok: false, message: string }}
 */
const customValueOf = (field, raw) => {
	const refuse = (/** @type {string} */ message) => ({ ok: /** @type {const} */ (false), message });
	switch (field.type) {
		case 'number':
			return typeof raw === 'number' && Number.isFinite(raw)
				? { ok: true, value: raw }
				: refuse(`${field.label} must be a number.`);
		case 'boolean':
			return typeof raw === 'boolean' ? { ok: true, value: raw } : refuse(`${field.label} is true or false.`);
		case 'multi_choice': {
			const list = Array.isArray(raw) ? [...new Set(raw)] : null;
			return list && list.every((item) => typeof item === 'string' && field.options.includes(item))
				? { ok: true, value: field.options.filter((option) => list.includes(option)) }
				: refuse(`${field.label} must be a list of the choices.`);
		}
		case 'textarea': {
			const value = typeof raw === 'string' && raw.length <= LONG_TEXT ? raw.replace(/\r\n?/g, '\n').trim() : null;
			return value && ![...value].some((ch) => ch.charCodeAt(0) < 32 && ch !== '\n' && ch !== '\t')
				? { ok: true, value }
				: refuse(`${field.label} is not valid.`);
		}
		default: {
			const value = text(raw, SHORT_TEXT);
			if (value === null || value === '') return refuse(`${field.label} is not valid.`);
			if (field.type === 'date' && (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))))
				return refuse(`${field.label} must be a date (YYYY-MM-DD).`);
			if (field.type === 'choice' && !field.options.includes(value))
				return refuse(`${field.label} must be one of the choices.`);
			if (field.type === 'email' && !EMAIL.test(value)) return refuse(`${field.label} must be an email address.`);
			if (field.type === 'url' && !/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(value))
				return refuse(`${field.label} must be a web address starting with https:// or http://.`);
			return { ok: true, value };
		}
	}
};

/**
 * A user's custom values as the user may see them: without the staff-only fields (A6).
 * @param {Record<string, CustomValue>} custom @param {ReadonlyArray<CustomField>} fields
 */
export const ownCustom = (custom, fields) =>
	Object.fromEntries(
		Object.entries(custom).filter(([key]) => fields.find((field) => field.key === key)?.visibility !== 'staff'),
	);

/**
 * Check custom field values against the definitions. Unknown keys are refused; `complete` also refuses a missing
 * required field (sign-up); otherwise only the fields sent are checked (an update). The user (`by: 'user'`) changes
 * only the fields they edit (A6): a field they only see is refused, and a staff-only field does not exist for them.
 * @param {ReadonlyArray<CustomField>} fields
 * @param {unknown} input
 * @param {{ complete: boolean, current?: Record<string, CustomValue>, by: 'user' | 'staff' }} options
 * @returns {{ ok: true, value: Record<string, CustomValue> } | { ok: false, field: string, message: string }}
 */
export const checkCustomValues = (fields, input, { complete, current = {}, by }) => {
	const body = input === undefined || input === null ? {} : input;
	if (typeof body !== 'object' || Array.isArray(body))
		return { ok: false, field: 'custom', message: 'Send the fields as an object.' };
	const usable = by === 'user' ? fields.filter((field) => field.visibility !== 'staff') : fields;
	/** @type {Record<string, CustomValue>} */
	const out = { ...current };
	for (const [key, raw] of Object.entries(body)) {
		const field = usable.find((f) => f.key === key);
		if (!field) return { ok: false, field: `custom/${key}`, message: 'There is no such field.' };
		if (by === 'user' && field.visibility === 'view')
			return { ok: false, field: `custom/${key}`, message: `${field.label} is changed by the business only.` };
		if (raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0)) {
			delete out[key];
			continue;
		}
		const checked = customValueOf(field, raw);
		if (!checked.ok) return { ok: false, field: `custom/${key}`, message: checked.message };
		out[key] = checked.value;
	}
	const asked = by === 'user' ? usable.filter((field) => field.visibility === 'edit') : fields;
	for (const field of asked)
		if (field.required && (complete || Object.hasOwn(body, field.key)) && out[field.key] === undefined)
			return { ok: false, field: `custom/${field.key}`, message: `${field.label} is required.` };
	return { ok: true, value: out };
};

/**
 * Check the user's addresses (the whole list is saved at once) with the website's Profile settings (A11): at most
 * `max` addresses, the `required` fields filled, the last one kept with `keepOne`, and one default address (the first
 * when none is chosen). Each address follows its country's format (`@ss/contracts/address`, A1): the country kept as
 * its ISO code (given as a code or an English name), the region and postal code filled where the country requires them
 * (never a postal code where it has none) and the postal code in the country's shape, kept upper case. An address
 * without a country is in `country` (the business.json country). Imports pass `byCountry: false`: an imported
 * address keeps its parts as they were (only the country as its code and the postal code upper case).
 * @param {unknown} input
 * @param {(index: number) => string} idOf a new id for an address without one
 * @param {{ max?: number, required?: ReadonlyArray<string>, keepOne?: boolean, before?: number, country?: string,
 *   byCountry?: boolean }}
 *   [rules] `before`: how many addresses the user has now
 * @returns {{ ok: true, value: Address[] } | { ok: false, field: string, message: string }}
 */
export const checkAddresses = (
	input,
	idOf,
	{ max = MAX_ADDRESSES, required = ['line1', 'city'], keepOne = false, before = 0, country: home = '', byCountry = true } = {},
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
		const limits = { ...ADDRESS_LIMITS, country: COUNTRY_INPUT };
		const fields = Object.fromEntries(Object.entries(limits).map(([key, most]) => [key, text(a[key], most)]));
		const bad = Object.entries(fields).find(([, v]) => v === null);
		if (bad) return { ok: false, field: `addresses/${index}/${bad[0]}`, message: 'This value is too long.' };
		const f = /** @type {Record<keyof typeof ADDRESS_LIMITS, string>} */ (fields);
		// the website's required fields outside the place (the place parts follow the country's format below)
		const missing = required.find(
			(name) =>
				name in f &&
				!(byCountry && PLACE_PARTS.includes(/** @type {any} */ (name))) &&
				f[/** @type {keyof typeof f} */ (name)] === '',
		);
		if (missing) return { ok: false, field: `addresses/${index}/${missing}`, message: 'Fill out this part of the address.' };
		const country = f.country === '' ? '' : countryCodeOf(f.country);
		if (country === null) return { ok: false, field: `addresses/${index}/country`, message: 'Choose a country.' };
		const place = { ...f, country, postalCode: tidyPostcode(f.postalCode) };
		const refused = byCountry ? addressProblem(place, { country: home, required }) : null;
		if (refused)
			return {
				ok: false,
				field: `addresses/${index}/${refused.part}`,
				message:
					refused.problem === 'required'
						? 'Fill out this part of the address.'
						: `Use a postal code of ${countryName(country || home).replace(/^United /, 'the United ')}.`,
			};
		const id = typeof a.id === 'string' && /^adr_[0-9a-z]{6,40}$/.test(a.id) ? a.id : idOf(index);
		out.push({ id, ...place, default: a.default === true });
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
 * @property {Record<string, CustomValue>} custom
 * @property {string} notes
 * @property {{ at: Date, reason: string } | null} blocked
 * @property {'active' | 'pending' | 'invited'} status
 * @property {string} role
 * @property {Record<string, string>} providers social sign-ins: provider → the provider's user id
 * @property {Identity} [identity] the address the account was made with and signs in by (absent on an imported
 *   account whose source did not say: see `identityOf`)
 * @property {string | null} passwordHash
 * @property {Date | null} [passwordChangedAt] when the password was last set or changed (null: none yet, or an import
 *   that did not say); a session made before it ends (`endedByPassword`)
 * @property {{ sealed: string, lastStep: number | null, recovery: Array<{ hash: string, format: 'v1' | 'sha256_prefixed' }>,
 *   enabledAt: Date | null } | null} twoStep recovery codes as hashes with their format (A8)
 * @property {number} failedLogins wrong passwords and two-step codes that still count toward the lock (A9, ST-1)
 * @property {Date} [lastFailedAt] the last of them: after the method's quiet hours with none, the count starts again
 *   (K-27)
 * @property {Date | null} lockedUntil
 * @property {number} [lockLevel] how far a growing lock has grown (A9)
 * @property {string | null} [phoneReversed] the phone's national number written backwards, for the search by the end of
 *   a number (A7)
 * @property {Date} roleSince when the role was last set (A5: "Member since"; an import gives the source's, else
 *   `createdAt`)
 * @property {Record<string, import('./consents.js').ConsentAnswer>} consents what the user gave, by consent key (A2)
 * @property {string[]} tags the merchant's labels, seen by staff only (A5)
 * @property {{ requestedAt: Date, dueAt: Date | null } | null} deletion
 * @property {string | null} deviceHash
 * @property {Date | null} lastSignInAt
 * @property {Date} createdAt
 */

/**
 * A user's tags as staff set them (A5): the merchant's own labels (for example VIP or Wholesale), trimmed, inner spaces
 * kept single, each once (the first spelling wins, whatever the case), at most `MAX_TAGS` of 1 to 40 characters.
 * @param {unknown} input
 * @returns {{ ok: true, value: string[] } | { ok: false, message: string }}
 */
export const checkTags = (input) => {
	if (!Array.isArray(input) || input.length > MAX_TAGS * 2)
		return { ok: false, message: `Send the tags as a list (at most ${MAX_TAGS}).` };
	/** @type {string[]} */
	const out = [];
	for (const raw of input) {
		const tag = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
		if (tag === '' || tag.length > TAG_LENGTH || [...tag].some((ch) => ch.charCodeAt(0) < 32))
			return { ok: false, message: `A tag is text of 1 to ${TAG_LENGTH} characters.` };
		if (!out.some((kept) => kept.toLowerCase() === tag.toLowerCase())) out.push(tag);
	}
	return out.length > MAX_TAGS ? { ok: false, message: `At most ${MAX_TAGS} tags.` } : { ok: true, value: out };
};

/**
 * What the user sees of themselves (My account): never notes, password, secrets or staff-only custom fields (A6).
 * @param {UserRecord} user
 * @param {ReadonlyArray<CustomField> | null} fields the website's custom fields (null: every value, for staff views)
 */
export const selfView = (user, fields) => ({
	id: user.id,
	email: user.email,
	emailVerified: user.emailVerified,
	phone: user.phone,
	phoneVerified: user.phoneVerified,
	name: user.name,
	addresses: user.addresses,
	custom: fields ? ownCustom(user.custom, fields) : user.custom,
	role: user.role,
	providers: Object.keys(user.providers).sort(),
	hasPassword: Boolean(user.passwordHash),
	passwordChangedAt: user.passwordChangedAt?.toISOString() ?? null,
	twoStep: Boolean(user.twoStep?.enabledAt),
	consents: ownConsents(user.consents),
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
	...selfView(user, null),
	notes: user.notes,
	tags: user.tags,
	blocked: user.blocked ? { at: user.blocked.at.toISOString(), reason: user.blocked.reason } : null,
	status: user.status,
	lastSignInAt: user.lastSignInAt?.toISOString() ?? null,
	lockedUntil: user.lockedUntil?.toISOString() ?? null,
	recoveryCodesLeft: user.twoStep?.enabledAt ? user.twoStep.recovery.length : null,
});
