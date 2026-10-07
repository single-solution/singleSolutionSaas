/**
 * Pure input validation for the identity module: every request body is parsed here into a typed value or a list
 * of field errors (`{ path, message }`, JSON-pointer paths). Objects are closed: unknown members are errors.
 * @module
 */
import { isTimeZone, normaliseDomain } from '@ss/contracts';

/** @typedef {{ path: string, message: string }} FieldError */
/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, errors: FieldError[] }} Parsed
 */
/**
 * A field parser: returns the parsed value or an error message.
 * @template T
 * @typedef {(value: unknown) => { ok: true, value: T } | { ok: false, message: string }} Field
 */

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 1024;
export const MAX_SCOPES = 32;
export const MAX_GRANTS = 100;
export const MERCHANT_ROLE_NAMES = Object.freeze(['owner', 'admin', 'billing', 'developer', 'editor']);
export const ASSIGNABLE_MERCHANT_ROLES = Object.freeze(['admin', 'billing', 'developer', 'editor']);
export const STAFF_ROLE_NAMES = Object.freeze(['superadmin', 'admin', 'support', 'finance']);
export const MAX_GRACE_SECONDS = 7 * 24 * 3600;
export const DEFAULT_GRACE_SECONDS = 24 * 3600;

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const ID = /^[a-z]{2,8}_[0-9a-z]{10,64}$/;
const SCOPE = /^[a-z*][a-z0-9_.:*@-]{0,127}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;
const OTP = /^\d{6}$/;
const RECOVERY = /^[a-z2-7]{5}-?[a-z2-7]{5}$/i;

/**
 * @template T
 * @param {T} value
 * @returns {{ ok: true, value: T }}
 */
const okv = (value) => ({ ok: true, value });
/**
 * @param {string} message
 * @returns {{ ok: false, message: string }}
 */
const bad = (message) => ({ ok: false, message });

// ---------------------------------------------------------------------------------------------------------------
// Fields

/**
 * Lower-cased, trimmed e-mail address (≤ 254 chars, one `@`, a dot in the domain).
 * @type {Field<string>}
 */
export const email = (value) => {
	if (typeof value !== 'string') return bad('must be an e-mail address');
	const v = value.trim().toLowerCase();
	if (v.length === 0 || v.length > 254 || !EMAIL.test(v)) return bad('must be an e-mail address');
	return okv(v);
};

/** The staff login name: an e-mail address, or `admin`. @type {Field<string>} */
export const staffLoginName = (value) =>
	typeof value === 'string' && value.trim().toLowerCase() === 'admin' ? okv('admin') : email(value);

/**
 * A new password: 12..1024 characters, not only whitespace.
 * @type {Field<string>}
 */
export const newPassword = (value) => {
	if (typeof value !== 'string') return bad('must be a string');
	if (value.length < PASSWORD_MIN || value.length > PASSWORD_MAX)
		return bad(`must be ${PASSWORD_MIN}..${PASSWORD_MAX} characters`);
	if (value.trim().length === 0) return bad('must not be blank');
	return okv(value);
};

/**
 * An existing password (any non-empty string up to the maximum; never trimmed).
 * @type {Field<string>}
 */
export const password = (value) =>
	typeof value === 'string' && value.length > 0 && value.length <= PASSWORD_MAX ? okv(value) : bad('is required');

/**
 * @param {number} max
 * @returns {Field<string>}
 */
export const text = (max) => (value) => {
	if (typeof value !== 'string') return bad('must be a string');
	const v = value.trim();
	if (v.length === 0 || v.length > max) return bad(`must be 1..${max} characters`);
	if ([...v].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f))
		return bad('must not contain control characters');
	return okv(v);
};

/**
 * A platform id with the given prefix.
 * @param {string} prefix
 * @returns {Field<string>}
 */
export const idOf = (prefix) => (value) =>
	typeof value === 'string' && ID.test(value) && value.startsWith(`${prefix}_`) ? okv(value) : bad(`must be a ${prefix}_ id`);

/** @type {Field<string>} */
export const token = (value) => (typeof value === 'string' && TOKEN.test(value) ? okv(value) : bad('is invalid'));

/** @type {Field<string>} */
export const otp = (value) => (typeof value === 'string' && OTP.test(value.trim()) ? okv(value.trim()) : bad('must be 6 digits'));

/** @type {Field<string>} */
export const recoveryCode = (value) =>
	typeof value === 'string' && RECOVERY.test(value.trim()) ? okv(value.trim().toLowerCase()) : bad('is invalid');

/** @type {Field<boolean>} */
export const bool = (value) => (typeof value === 'boolean' ? okv(value) : bad('must be a boolean'));

/**
 * Role names of a family, unique, non-empty unless `allowEmpty`.
 * @param {ReadonlyArray<string>} allowed
 * @param {{ allowEmpty?: boolean }} [options]
 * @returns {Field<string[]>}
 */
export const roles =
	(allowed, { allowEmpty = false } = {}) =>
	(value) => {
		if (!Array.isArray(value)) return bad('must be an array of roles');
		if (!allowEmpty && value.length === 0) return bad('must name at least one role');
		if (value.some((role) => typeof role !== 'string' || !allowed.includes(role)))
			return bad(`roles must be among ${allowed.join(', ')}`);
		if (new Set(value).size !== value.length) return bad('must not repeat roles');
		return okv(/** @type {string[]} */ ([...value]));
	};

/**
 * Website-scoped grants `[{ websiteId, roles }]` with assignable merchant roles; one entry per website.
 * @type {Field<Array<{ websiteId: string, roles: string[] }>>}
 */
export const grants = (value) => {
	if (!Array.isArray(value) || value.length > MAX_GRANTS) return bad(`must be an array of at most ${MAX_GRANTS} grants`);
	/** @type {Array<{ websiteId: string, roles: string[] }>} */
	const out = [];
	for (const grant of value) {
		if (typeof grant !== 'object' || grant === null || Array.isArray(grant)) return bad('each grant is { websiteId, roles }');
		const { websiteId, roles: grantRoles, ...rest } = /** @type {Record<string, unknown>} */ (grant);
		if (Object.keys(rest).length > 0) return bad('each grant is { websiteId, roles }');
		const id = idOf('web')(websiteId);
		const r = roles(ASSIGNABLE_MERCHANT_ROLES)(grantRoles);
		if (!id.ok) return bad(`websiteId ${id.message}`);
		if (!r.ok) return bad(r.message);
		if (out.some((g) => g.websiteId === id.value)) return bad('must not repeat a website');
		out.push({ websiteId: id.value, roles: r.value });
	}
	return okv(out);
};

/**
 * Website-key scopes: 0..32 unique scope names (empty = the default scopes; the vocabulary is checked on issue,
 * `core/scopes.js`).
 * @type {Field<string[]>}
 */
export const scopes = (value) => {
	if (!Array.isArray(value) || value.length > MAX_SCOPES) return bad(`must be an array of at most ${MAX_SCOPES} scopes`);
	if (value.some((scope) => typeof scope !== 'string' || !SCOPE.test(scope))) return bad('contains an invalid scope');
	if (new Set(value).size !== value.length) return bad('must not repeat scopes');
	return okv(/** @type {string[]} */ ([...value]));
};

/**
 * An IANA time zone name the runtime knows (`Intl`), in its canonical spelling (`europe/berlin` → `Europe/Berlin`).
 * @type {Field<string>}
 */
export const timeZone = (value) => {
	if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/.test(value) || !isTimeZone(value))
		return bad('must be an IANA time zone such as Europe/Berlin');
	return okv(new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone);
};

/**
 * A BCP 47 language tag, canonicalised with `Intl.getCanonicalLocales` (`en-us` → `en-US`).
 * @type {Field<string>}
 */
export const language = (value) => {
	if (typeof value !== 'string' || value.length === 0 || value.length > 35 || !/^[A-Za-z0-9-]+$/.test(value))
		return bad('must be a BCP 47 language tag such as en or de-CH');
	try {
		const [tag] = Intl.getCanonicalLocales(value);
		return tag ? okv(tag) : bad('must be a BCP 47 language tag such as en or de-CH');
	} catch {
		return bad('must be a BCP 47 language tag such as en or de-CH');
	}
};

/** ISO 4217 codes the runtime knows (empty when `Intl.supportedValuesOf` is unavailable: then the shape alone counts). */
const CURRENCIES = new Set(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : []);

/**
 * An ISO 4217 currency code, upper-cased (`eur` → `EUR`).
 * @type {Field<string>}
 */
export const currency = (value) => {
	if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value)) return bad('must be an ISO 4217 currency code such as EUR');
	const code = value.toUpperCase();
	return CURRENCIES.size === 0 || CURRENCIES.has(code) ? okv(code) : bad('must be an ISO 4217 currency code such as EUR');
};

/**
 * `null` (clear the setting) or a value of `field`.
 * @template T
 * @param {Field<T>} field
 * @returns {Field<T | null>}
 */
export const nullable = (field) => (value) => (value === null ? okv(null) : field(value));

/**
 * A website domain, normalised with `@ss/contracts` `normaliseDomain` (public hosts only).
 * @param {{ isPublicSuffix?: (domain: string) => boolean }} [options]
 * @returns {Field<string>}
 */
export const domain =
	(options = {}) =>
	(value) => {
		const result = normaliseDomain(value, options.isPublicSuffix ? { isPublicSuffix: options.isPublicSuffix } : {});
		return result.ok ? okv(result.value) : bad(result.message);
	};

/**
 * An ISO-8601 timestamp, returned as epoch milliseconds.
 * @type {Field<number>}
 */
export const timestamp = (value) => {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value))
		return bad('must be an ISO-8601 timestamp with a zone');
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? okv(ms) : bad('must be an ISO-8601 timestamp with a zone');
};

/**
 * Integer within bounds.
 * @param {number} min
 * @param {number} max
 * @returns {Field<number>}
 */
export const int = (min, max) => (value) =>
	Number.isInteger(value) && /** @type {number} */ (value) >= min && /** @type {number} */ (value) <= max
		? okv(/** @type {number} */ (value))
		: bad(`must be an integer ${min}..${max}`);

/**
 * One of fixed values.
 * @template {string} T
 * @param {ReadonlyArray<T>} values
 * @returns {Field<T>}
 */
export const oneOf = (values) => (value) =>
	values.includes(/** @type {T} */ (value)) ? okv(/** @type {T} */ (value)) : bad(`must be one of ${values.join(', ')}`);

// ---------------------------------------------------------------------------------------------------------------
// Objects

/**
 * @typedef {{ [key: string]: Field<any> | { optional: Field<any> } }} Spec
 */

/**
 * Parse a closed object: every `spec` member is required unless wrapped as `{ optional: field }`.
 * @template {Record<string, unknown>} T
 * @param {unknown} body
 * @param {Spec} spec
 * @returns {Parsed<T>}
 */
export const object = (body, spec) => {
	if (typeof body !== 'object' || body === null || Array.isArray(body))
		return { ok: false, errors: [{ path: '', message: 'body must be a JSON object' }] };
	const input = /** @type {Record<string, unknown>} */ (body);
	/** @type {FieldError[]} */
	const errors = Object.keys(input)
		.filter((key) => !Object.hasOwn(spec, key))
		.map((key) => ({ path: `/${key}`, message: 'unknown property' }));
	/** @type {Record<string, unknown>} */
	const value = {};
	for (const [key, entry] of Object.entries(spec)) {
		const optional = typeof entry === 'object';
		const field = typeof entry === 'object' ? entry.optional : entry;
		if (input[key] === undefined) {
			if (!optional) errors.push({ path: `/${key}`, message: 'is required' });
			continue;
		}
		const result = field(input[key]);
		if (result.ok) value[key] = result.value;
		else errors.push({ path: `/${key}`, message: result.message });
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: /** @type {T} */ (value) };
};

/**
 * Exactly one of `code` (TOTP) or `recoveryCode`, plus the members of `extra`.
 * @template {Record<string, unknown>} T
 * @param {unknown} body
 * @param {Spec} [extra]
 * @returns {Parsed<T & { code?: string, recoveryCode?: string }>}
 */
export const secondFactor = (body, extra = {}) => {
	const parsed = object(body, { ...extra, code: { optional: otp }, recoveryCode: { optional: recoveryCode } });
	if (!parsed.ok) return /** @type {any} */ (parsed);
	const v = /** @type {Record<string, unknown>} */ (parsed.value);
	if ((v.code === undefined) === (v.recoveryCode === undefined))
		return { ok: false, errors: [{ path: '/code', message: 'send exactly one of code or recoveryCode' }] };
	return /** @type {any} */ (parsed);
};

/** @typedef {{ code?: string, recoveryCode?: string }} SecondFactor */
/** @typedef {{ websiteId: string, roles: string[] }} GrantInput */

/** Body parsers per operation. */
export const inputs = Object.freeze({
	signup: /** @type {(b: unknown) => Parsed<{ email: string, password: string, merchantName: string, name?: string }>} */ (
		(b) => object(b, { email, password: newPassword, merchantName: text(120), name: { optional: text(120) } })
	),
	login: /** @type {(b: unknown) => Parsed<{ email: string, password: string, merchantId?: string }>} */ (
		(b) => object(b, { email, password, merchantId: { optional: idOf('mer') } })
	),
	// staff sign in with their e-mail, or with the login name `admin` (the first admin, which may have no e-mail)
	staffLogin: /** @type {(b: unknown) => Parsed<{ email: string, password: string }>} */ (
		(b) => object(b, { email: staffLoginName, password })
	),
	firstAdmin: /** @type {(b: unknown) => Parsed<{ password: string }>} */ ((b) => object(b, { password: newPassword })),
	staffProfile: /** @type {(b: unknown) => Parsed<{ name?: string, email?: string }>} */ (
		(b) => object(b, { name: { optional: text(120) }, email: { optional: email } })
	),
	tokenOnly: /** @type {(b: unknown) => Parsed<{ token: string }>} */ ((b) => object(b, { token })),
	emailOnly: /** @type {(b: unknown) => Parsed<{ email: string }>} */ ((b) => object(b, { email })),
	resetConfirm: /** @type {(b: unknown) => Parsed<{ token: string, password: string }>} */ (
		(b) => object(b, { token, password: newPassword })
	),
	inviteAccept: /** @type {(b: unknown) => Parsed<{ token: string, password: string, name?: string }>} */ (
		(b) => object(b, { token, password, name: { optional: text(120) } })
	),
	passwordChange: /** @type {(b: unknown) => Parsed<{ currentPassword: string, newPassword: string }>} */ (
		(b) => object(b, { currentPassword: password, newPassword })
	),
	mfaChallenge: /** @type {(b: unknown) => Parsed<SecondFactor & { challenge: string }>} */ (
		(b) => secondFactor(b, { challenge: token })
	),
	mfaCode: /** @type {(b: unknown) => Parsed<SecondFactor>} */ ((b) => secondFactor(b)),
	mfaConfirm: /** @type {(b: unknown) => Parsed<{ code: string }>} */ ((b) => object(b, { code: otp })),
	mfaDisable: /** @type {(b: unknown) => Parsed<SecondFactor & { password: string }>} */ ((b) => secondFactor(b, { password })),
	switchMerchant: /** @type {(b: unknown) => Parsed<{ merchantId: string }>} */ ((b) => object(b, { merchantId: idOf('mer') })),
	merchantUpdate: /** @type {(b: unknown) => Parsed<{ name: string }>} */ ((b) => object(b, { name: text(120) })),
	invite: /** @type {(b: unknown) => Parsed<{ email: string, roles?: string[], grants?: GrantInput[] }>} */ (
		(b) =>
			object(b, {
				email,
				roles: { optional: roles(ASSIGNABLE_MERCHANT_ROLES, { allowEmpty: true }) },
				grants: { optional: grants },
			})
	),
	memberUpdate: /** @type {(b: unknown) => Parsed<{ roles?: string[], grants?: GrantInput[] }>} */ (
		(b) =>
			object(b, {
				roles: { optional: roles(ASSIGNABLE_MERCHANT_ROLES, { allowEmpty: true }) },
				grants: { optional: grants },
			})
	),
	ownerTransfer: /** @type {(b: unknown) => Parsed<{ userId: string, password?: string }>} */ (
		(b) => object(b, { userId: idOf('usr'), password: { optional: password } })
	),
	website:
		/** @type {(b: unknown, options?: { isPublicSuffix?: (domain: string) => boolean }) => Parsed<{ domain: string }>} */ (
			(b, options) => object(b, { domain: domain(options) })
		),
	websiteSettings:
		/** @type {(b: unknown) => Parsed<{ timeZone?: string | null, language?: string | null, currency?: string | null }>} */ (
			(b) => {
				const parsed = object(b, {
					timeZone: { optional: nullable(timeZone) },
					language: { optional: nullable(language) },
					currency: { optional: nullable(currency) },
				});
				if (parsed.ok && Object.keys(parsed.value).length === 0)
					return { ok: false, errors: [{ path: '', message: 'send at least one of timeZone, language, currency' }] };
				return /** @type {any} */ (parsed);
			}
		),
	keyIssue:
		/** @type {(b: unknown) => Parsed<{ kind: 'pk' | 'sk', scopes?: string[], expiresAt?: number, allowSubdomains?: boolean }>} */ (
			(b) =>
				object(b, {
					kind: oneOf(/** @type {const} */ (['pk', 'sk'])),
					scopes: { optional: scopes },
					expiresAt: { optional: timestamp },
					allowSubdomains: { optional: bool },
				})
		),
	keyRotate: /** @type {(b: unknown) => Parsed<{ graceSeconds?: number }>} */ (
		(b) => object(b ?? {}, { graceSeconds: { optional: int(0, MAX_GRACE_SECONDS) } })
	),
	keyRevoke: /** @type {(b: unknown) => Parsed<{ reason?: string }>} */ (
		(b) => object(b ?? {}, { reason: { optional: text(500) } })
	),
	reason: /** @type {(b: unknown) => Parsed<{ reason: string }>} */ ((b) => object(b, { reason: text(500) })),
	websiteTransfer: /** @type {(b: unknown) => Parsed<{ toMerchantId: string, reason: string }>} */ (
		(b) => object(b, { toMerchantId: idOf('mer'), reason: text(500) })
	),
	staffCreate: /** @type {(b: unknown) => Parsed<{ email: string, roles: string[], name?: string }>} */ (
		(b) => object(b, { email, roles: roles(STAFF_ROLE_NAMES), name: { optional: text(120) } })
	),
	staffUpdate: /** @type {(b: unknown) => Parsed<{ roles?: string[], status?: 'active' | 'disabled' }>} */ (
		(b) =>
			object(b, {
				roles: { optional: roles(STAFF_ROLE_NAMES) },
				status: { optional: oneOf(/** @type {const} */ (['active', 'disabled'])) },
			})
	),
	note: /** @type {(b: unknown) => Parsed<{ body: string }>} */ ((b) => object(b, { body: text(2000) })),
});
