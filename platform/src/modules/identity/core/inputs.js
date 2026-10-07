/**
 * Pure input validation for the identity module: every request body is parsed here into a typed value or a list
 * of field errors (`{ path, message }`, JSON-pointer paths). Objects are closed: unknown members are errors.
 * @module
 */
import { normaliseDomain } from '@ss/contracts';
import { isCountryCode } from './countries.js';

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
export const ADMIN_ROLE_NAMES = Object.freeze(/** @type {const} */ (['owner', 'support', 'finance']));
/** Merchant field lengths (PLAN 0.8.4: chosen by the builder, awaiting owner review). */
export const MERCHANT_FIELD_MAX = Object.freeze({ name: 120, ownerName: 120, phone: 40, address: 300 });

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const ID = /^[a-z]{2,8}_[0-9a-z]{10,64}$/;
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
 * An ISO 3166-1 alpha-2 country code, upper-cased (`pk` → `PK`).
 * @type {Field<string>}
 */
export const country = (value) =>
	typeof value === 'string' && isCountryCode(value.trim().toUpperCase())
		? okv(value.trim().toUpperCase())
		: bad('must be an ISO 3166-1 alpha-2 country code such as PK');

/**
 * Optional free text: `null` or an empty string clears it, else 1..`max` characters.
 * @param {number} max
 * @returns {Field<string | null>}
 */
export const optionalText = (max) => (value) =>
	value === null || (typeof value === 'string' && value.trim() === '') ? okv(null) : text(max)(value);

/**
 * `null` (clear the field) or a value of `field`.
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

/**
 * The merchant fields (PLAN 0.2 Merchants), each optional for an edit.
 * @typedef {{ name: string, ownerName: string, email: string, phone: string | null, address: string | null,
 *   country: string | null }} MerchantFields
 */

const merchantSpec = Object.freeze({
	name: text(MERCHANT_FIELD_MAX.name),
	ownerName: text(MERCHANT_FIELD_MAX.ownerName),
	phone: optionalText(MERCHANT_FIELD_MAX.phone),
	address: optionalText(MERCHANT_FIELD_MAX.address),
	country: nullable(country),
});

/**
 * A closed object with at least one member.
 * @param {unknown} b
 * @param {Spec} spec
 */
const someOf = (b, spec) => {
	const parsed = object(b, spec);
	if (parsed.ok && Object.keys(parsed.value).length === 0)
		return { ok: false, errors: [{ path: '', message: 'send at least one field' }] };
	return parsed;
};

/** Body parsers per operation. */
export const inputs = Object.freeze({
	signIn: /** @type {(b: unknown) => Parsed<{ email: string, password: string }>} */ ((b) => object(b, { email, password })),
	twoStepSignIn: /** @type {(b: unknown) => Parsed<SecondFactor & { challenge: string }>} */ (
		(b) => secondFactor(b, { challenge: token })
	),
	firstAdmin: /** @type {(b: unknown) => Parsed<{ name: string, email: string, password: string }>} */ (
		(b) => object(b, { name: text(120), email, password: newPassword })
	),
	tokenOnly: /** @type {(b: unknown) => Parsed<{ token: string }>} */ ((b) => object(b, { token })),
	emailOnly: /** @type {(b: unknown) => Parsed<{ email: string }>} */ ((b) => object(b, { email })),
	resetConfirm: /** @type {(b: unknown) => Parsed<{ token: string, password: string }>} */ (
		(b) => object(b, { token, password: newPassword })
	),
	setupConfirm: /** @type {(b: unknown) => Parsed<{ token: string, password: string, name?: string }>} */ (
		(b) => object(b, { token, password: newPassword, name: { optional: text(120) } })
	),
	passwordChange: /** @type {(b: unknown) => Parsed<SecondFactor & { currentPassword: string, newPassword: string }>} */ (
		(b) =>
			object(b, {
				currentPassword: password,
				newPassword,
				code: { optional: otp },
				recoveryCode: { optional: recoveryCode },
			})
	),
	emailChange: /** @type {(b: unknown) => Parsed<SecondFactor & { email: string, password: string }>} */ (
		(b) => object(b, { email, password, code: { optional: otp }, recoveryCode: { optional: recoveryCode } })
	),
	twoStepConfirm: /** @type {(b: unknown) => Parsed<{ code: string }>} */ ((b) => object(b, { code: otp })),
	twoStepWithPassword: /** @type {(b: unknown) => Parsed<SecondFactor & { password: string }>} */ (
		(b) => secondFactor(b, { password })
	),
	adminProfile: /** @type {(b: unknown) => Parsed<{ name: string }>} */ ((b) => object(b, { name: text(120) })),
	merchantProfile: /** @type {(b: unknown) => Parsed<Partial<Omit<MerchantFields, 'email'>>>} */ (
		(b) =>
			someOf(b, {
				name: { optional: merchantSpec.name },
				ownerName: { optional: merchantSpec.ownerName },
				phone: { optional: merchantSpec.phone },
				address: { optional: merchantSpec.address },
				country: { optional: merchantSpec.country },
			})
	),
	merchantCreate: /** @type {(b: unknown) => Parsed<MerchantFields>} */ (
		(b) => {
			const parsed = object(b, {
				name: merchantSpec.name,
				ownerName: merchantSpec.ownerName,
				email,
				phone: { optional: merchantSpec.phone },
				address: { optional: merchantSpec.address },
				country: { optional: merchantSpec.country },
			});
			if (!parsed.ok) return parsed;
			const v = /** @type {Record<string, any>} */ (parsed.value);
			return { ok: true, value: { phone: null, address: null, country: null, ...v } };
		}
	),
	merchantUpdate: /** @type {(b: unknown) => Parsed<Partial<MerchantFields>>} */ (
		(b) =>
			someOf(b, {
				name: { optional: merchantSpec.name },
				ownerName: { optional: merchantSpec.ownerName },
				email: { optional: email },
				phone: { optional: merchantSpec.phone },
				address: { optional: merchantSpec.address },
				country: { optional: merchantSpec.country },
			})
	),
	merchantDelete: /** @type {(b: unknown) => Parsed<{ confirm: string }>} */ (
		(b) => object(b, { confirm: text(MERCHANT_FIELD_MAX.name) })
	),
	bulk: /** @type {(b: unknown) => Parsed<{ action: 'suspend' | 'resume' | 'resend_setup_link', merchantIds: string[], reason?: string }>} */ (
		(b) =>
			object(b, {
				action: oneOf(/** @type {const} */ (['suspend', 'resume', 'resend_setup_link'])),
				merchantIds: (value) => {
					if (!Array.isArray(value) || value.length === 0 || value.length > 50) return bad('must list 1..50 merchants');
					const ids = value.map(idOf('mer'));
					const failed = ids.find((r) => !r.ok);
					if (failed && !failed.ok) return bad(failed.message);
					return okv([...new Set(value.map(String))]);
				},
				reason: { optional: text(500) },
			})
	),
	linkAction: /** @type {(b: unknown) => Parsed<{ copy?: boolean }>} */ ((b) => object(b ?? {}, { copy: { optional: bool } })),
	website:
		/** @type {(b: unknown, options?: { isPublicSuffix?: (domain: string) => boolean }) => Parsed<{ domain: string }>} */ (
			(b, options) => object(b, { domain: domain(options) })
		),
	websiteRemove: /** @type {(b: unknown) => Parsed<{ confirm: string }>} */ ((b) => object(b, { confirm: text(253) })),
	tokenRegenerate: /** @type {(b: unknown) => Parsed<{ kind: 'browser' | 'server' }>} */ (
		(b) => object(b, { kind: oneOf(/** @type {const} */ (['browser', 'server'])) })
	),
	reason: /** @type {(b: unknown) => Parsed<{ reason: string }>} */ ((b) => object(b, { reason: text(500) })),
	adminInvite: /** @type {(b: unknown) => Parsed<{ email: string, role: 'owner' | 'support' | 'finance', copy?: boolean }>} */ (
		(b) => object(b, { email, role: oneOf(ADMIN_ROLE_NAMES), copy: { optional: bool } })
	),
	adminUpdate: /** @type {(b: unknown) => Parsed<{ email?: string, role?: 'owner' | 'support' | 'finance' }>} */ (
		(b) => someOf(b, { email: { optional: email }, role: { optional: oneOf(ADMIN_ROLE_NAMES) } })
	),
});
