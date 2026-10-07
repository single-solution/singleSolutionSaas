/**
 * Launches (PLAN 0.4.3): Portal → product, single use, 60 seconds by default, EdDSA JWT with `typ: ss-launch+jwt`.
 *
 * A launch opens a product dashboard. The product exchanges it once for its own session, after checking the signature
 * (pinned Portal keys), issuer, audience (= the product id), time, lifetime cap, the launch claims and single use
 * (`consume(jti)`).
 *
 * - **merchant** launch: `merchant: { id, name, websites: [{ websiteId, domain }], websiteId }`; the website to open
 *   must be one of `websites` (the merchant's websites that have this product, removed ones excluded).
 * - **admin** launch: `admin: { id, name, role: 'owner' | 'support', websiteId: string | null }` (`null` opens
 *   Defaults). Finance launches are refused.
 *
 * Both carry `sessionExpiresAt` (ISO-8601 UTC, when the launching Portal session ends), the branding and the support
 * contact. `sub` is the merchant id or the admin id.
 */
import { createProtocolError } from './errors.js';
import { defaultRandomBytes, randomId } from './encoding.js';
import { checkTimeClaims, isObject, nowSeconds, requireString, signCompact, verifyCompact } from './jws.js';

/** @import { KeyResolver, Signer } from './keys.js' */

/** Launch kinds. */
export const LAUNCH_KINDS = Object.freeze(/** @type {const} */ (['merchant', 'admin']));

/** Admin roles that may open a product dashboard. */
export const LAUNCH_ADMIN_ROLES = Object.freeze(/** @type {const} */ (['owner', 'support']));

/** JOSE `typ` of launches. */
export const LAUNCH_TYP = 'ss-launch+jwt';

/** Default and maximum launch lifetime (seconds). */
export const DEFAULT_LAUNCH_TTL_SECONDS = 60;
export const MAX_LAUNCH_TTL_SECONDS = 300;

const MAX_WEBSITES = 1000;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const ACCENT = /^#[0-9a-fA-F]{6}$/;

/** @typedef {typeof LAUNCH_KINDS[number]} LaunchKind */
/** @typedef {typeof LAUNCH_ADMIN_ROLES[number]} LaunchAdminRole */
/** @typedef {{ name: string, accent: string, logoUrl: string | null }} LaunchBranding */
/** @typedef {{ email: string, phone: string, whatsapp?: string }} LaunchSupport */
/** @typedef {{ websiteId: string, domain: string }} LaunchWebsite */
/** @typedef {{ id: string, name: string, websites: LaunchWebsite[], websiteId: string }} LaunchMerchant */
/** @typedef {{ id: string, name: string, role: LaunchAdminRole, websiteId: string | null }} LaunchAdmin */
/**
 * @typedef {{ iss: string, aud: string, sub: string, iat: number, nbf: number, exp: number, jti: string,
 *   kind: LaunchKind, sessionExpiresAt: string, branding: LaunchBranding, support: LaunchSupport,
 *   merchant?: LaunchMerchant, admin?: LaunchAdmin }} LaunchClaims
 */

/**
 * @param {unknown} value
 * @param {number} [max]
 * @returns {value is string}
 */
const isText = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max;

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {boolean}
 */
const isOptionalText = (value, max) => typeof value === 'string' && value.length <= max;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
const isHttpUrl = (value) => {
	if (typeof value !== 'string' || value.length > 2048) return false;
	try {
		const url = new URL(value);
		return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '';
	} catch {
		return false;
	}
};

/**
 * True for an ISO-8601 UTC timestamp string that parses to a real instant.
 * @param {unknown} value
 * @returns {value is string}
 */
const isIsoUtc = (value) => typeof value === 'string' && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));

/**
 * @param {unknown} branding
 * @returns {string | null}
 */
const brandingViolation = (branding) => {
	if (!isObject(branding)) return 'branding is required';
	if (!isText(branding.name, 200)) return 'branding.name is required';
	if (typeof branding.accent !== 'string' || !ACCENT.test(branding.accent)) return 'branding.accent must be #rrggbb';
	if (branding.logoUrl !== null && !isHttpUrl(branding.logoUrl)) return 'branding.logoUrl must be a URL or null';
	return null;
};

/**
 * @param {unknown} support
 * @returns {string | null}
 */
const supportViolation = (support) => {
	if (!isObject(support)) return 'support is required';
	if (!isOptionalText(support.email, 320) || !isOptionalText(support.phone, 64)) return 'support.email and phone are required';
	if (support.whatsapp !== undefined && !isOptionalText(support.whatsapp, 64)) return 'support.whatsapp must be a string';
	return null;
};

/**
 * @param {unknown} merchant
 * @returns {string | null}
 */
const merchantViolation = (merchant) => {
	if (!isObject(merchant)) return 'merchant launch requires merchant';
	if (!isText(merchant.id) || !isText(merchant.name, 200)) return 'merchant.id and merchant.name are required';
	const { websites, websiteId } = merchant;
	if (!Array.isArray(websites) || websites.length === 0 || websites.length > MAX_WEBSITES)
		return 'merchant.websites must list the websites';
	if (!websites.every((site) => isObject(site) && isText(site.websiteId) && isText(site.domain, 253)))
		return 'merchant.websites entries need websiteId and domain';
	if (!isText(websiteId) || !websites.some((site) => site.websiteId === websiteId))
		return 'merchant.websiteId must be one of merchant.websites';
	return null;
};

/**
 * @param {unknown} admin
 * @returns {string | null}
 */
const adminViolation = (admin) => {
	if (!isObject(admin)) return 'admin launch requires admin';
	if (!isText(admin.id) || !isText(admin.name, 200)) return 'admin.id and admin.name are required';
	if (!(/** @type {readonly unknown[]} */ (LAUNCH_ADMIN_ROLES).includes(admin.role)))
		return 'admin.role must be owner or support';
	if (admin.websiteId !== null && !isText(admin.websiteId)) return 'admin.websiteId must be an id or null';
	return null;
};

/**
 * Return why launch claims break the launch rules, or `null` when they are consistent:
 *  - `kind` is merchant or admin; never both `merchant` and `admin`;
 *  - merchant: `merchant` with `websiteId` inside `websites`; admin: `admin` with role owner or support;
 *  - `sub` equals the merchant or admin id; `sessionExpiresAt` is ISO-8601 UTC; branding and support are complete.
 * @param {Record<string, unknown>} claims
 * @returns {string | null}
 */
export const launchViolation = (claims) => {
	const { kind, merchant, admin } = claims;
	if (!(/** @type {readonly unknown[]} */ (LAUNCH_KINDS).includes(kind))) return 'unknown kind';
	if (merchant !== undefined && admin !== undefined) return 'a launch is either merchant or admin, never both';
	const violation = kind === 'merchant' ? merchantViolation(merchant) : adminViolation(admin);
	if (violation) return violation;
	const person = /** @type {{ id: string }} */ (kind === 'merchant' ? merchant : admin);
	if (claims.sub !== person.id) return 'sub must equal the merchant or admin id';
	if (!isIsoUtc(claims.sessionExpiresAt)) return 'sessionExpiresAt must be an ISO-8601 UTC time';
	return brandingViolation(claims.branding) ?? supportViolation(claims.support);
};

/**
 * Issue a launch (Portal side).
 * @param {{
 *   signer: Signer, issuer: string, audience: string, kind: LaunchKind, sessionExpiresAt: string,
 *   branding: LaunchBranding, support: LaunchSupport, merchant?: LaunchMerchant, admin?: LaunchAdmin,
 *   ttlSeconds?: number, jti?: string, now?: () => number, randomBytes?: (length: number) => Uint8Array,
 * }} params `audience` is the product id; `issuer` the Portal's `PORTAL_URL`.
 * @returns {Promise<{ token: string, claims: LaunchClaims }>}
 */
export const issueLaunch = async ({
	signer,
	issuer,
	audience,
	kind,
	sessionExpiresAt,
	branding,
	support,
	merchant,
	admin,
	ttlSeconds = DEFAULT_LAUNCH_TTL_SECONDS,
	jti,
	now = Date.now,
	randomBytes = defaultRandomBytes,
}) => {
	requireString(issuer, 'issuer');
	requireString(audience, 'audience');
	if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_LAUNCH_TTL_SECONDS) {
		throw createProtocolError('invalid_argument', `ttlSeconds must be 1..${MAX_LAUNCH_TTL_SECONDS}`);
	}
	const iat = nowSeconds(now);
	const person = kind === 'admin' ? admin : merchant;
	/** @type {Record<string, unknown>} */
	const claims = {
		iss: issuer,
		aud: audience,
		sub: isObject(person) ? person.id : undefined,
		iat,
		nbf: iat,
		exp: iat + ttlSeconds,
		jti: jti ?? randomId(randomBytes),
		kind,
		sessionExpiresAt,
		branding,
		support,
	};
	if (merchant !== undefined) claims.merchant = merchant;
	if (admin !== undefined) claims.admin = admin;
	const violation = launchViolation(claims);
	if (violation) throw createProtocolError('invalid_launch', violation);
	if (Date.parse(sessionExpiresAt) <= now())
		throw createProtocolError('invalid_launch', 'sessionExpiresAt must be in the future');
	const token = await signCompact({ signer, typ: LAUNCH_TYP, payload: claims });
	return { token, claims: /** @type {LaunchClaims} */ (/** @type {unknown} */ (claims)) };
};

/**
 * Verify a launch and consume its `jti` (single use). A launch whose `sessionExpiresAt` has passed is refused
 * (`expired`).
 * @param {{
 *   token: unknown, keyResolver: KeyResolver, audience: string, issuer: string,
 *   consume: (jti: string, expiresAtMs: number) => boolean | Promise<boolean>,
 *   now?: () => number, skewSeconds?: number, maxTtlSeconds?: number,
 * }} params `consume` must atomically mark the jti used and return `true` only on first use (see `consumeWith`).
 * @returns {Promise<LaunchClaims>}
 */
export const verifyLaunch = async ({
	token,
	keyResolver,
	audience,
	issuer,
	consume,
	now = Date.now,
	skewSeconds = 5,
	maxTtlSeconds = MAX_LAUNCH_TTL_SECONDS,
}) => {
	requireString(audience, 'audience');
	requireString(issuer, 'issuer');
	if (typeof consume !== 'function')
		throw createProtocolError('invalid_argument', 'consume is required (launches are single-use)');
	const { payload } = await verifyCompact({ token, keyResolver, typ: LAUNCH_TYP });
	if (payload.iss !== issuer) throw createProtocolError('issuer', 'unexpected issuer');
	if (payload.aud !== audience) throw createProtocolError('audience', 'token is not for this audience');
	if (!isText(payload.jti)) throw createProtocolError('malformed', 'jti is missing');
	const { exp } = checkTimeClaims({ claims: payload, nowMs: now(), skewSeconds, maxLifetimeSeconds: maxTtlSeconds });
	const violation = launchViolation(payload);
	if (violation) throw createProtocolError('invalid_launch', violation);
	if (Date.parse(/** @type {string} */ (payload.sessionExpiresAt)) <= now())
		throw createProtocolError('expired', 'the Portal session has ended');
	const first = await consume(/** @type {string} */ (payload.jti), (exp + skewSeconds) * 1000);
	if (!first) throw createProtocolError('replay', 'launch was already used');
	return /** @type {LaunchClaims} */ (/** @type {unknown} */ (payload));
};
