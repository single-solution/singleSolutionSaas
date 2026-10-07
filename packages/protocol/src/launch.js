/**
 * SSO launch tokens: Portal → product, single use, short-lived (default 60 s), EdDSA JWT with `typ: ss-launch+jwt`.
 *
 * The product exchanges the launch for its own session once, after checking signature (Portal JWKS), issuer,
 * audience (= the product's appId), time, lifetime cap, kind/scope consistency and single use (`consume(jti)`).
 */
import { createProtocolError } from './errors.js';
import { defaultRandomBytes, randomId } from './encoding.js';
import { checkTimeClaims, isObject, nowSeconds, requireString, signCompact, verifyCompact } from './jws.js';

/** @import { KeyResolver, Signer } from './keys.js' */

/** Launch kinds. */
export const LAUNCH_KINDS = Object.freeze(/** @type {const} */ (['merchant', 'admin']));

/** JOSE `typ` of launch tokens. */
export const LAUNCH_TYP = 'ss-launch+jwt';

/** Default and maximum launch lifetime (seconds). */
export const DEFAULT_LAUNCH_TTL_SECONDS = 60;
export const MAX_LAUNCH_TTL_SECONDS = 300;

/** @typedef {typeof LAUNCH_KINDS[number]} LaunchKind */
/** @typedef {{ id: string, email?: string, name?: string, roles?: string[] }} LaunchUser */
/**
 * What a launch may act on. Admin launches carry either `{ all: true }` (app-wide management, nothing else) or a
 * merchant scope `{ merchantId, subscriptions? }`.
 * @typedef {{ all?: true, merchantId?: string, websiteId?: string, websiteIds?: string[], subscriptions?: string[],
 *   permissions?: string[] }} LaunchScope
 */
/**
 * @typedef {{ iss: string, aud: string, sub: string, iat: number, nbf: number, exp: number, jti: string, kind: LaunchKind,
 *   user: LaunchUser, scope: LaunchScope, subscriptions?: unknown[] }} LaunchClaims
 */

/** Scope members allowed next to `all: true` (none: app-wide scope is exclusive, except `permissions`). */
const ALL_SCOPE_MEMBERS = new Set(['all', 'permissions']);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
const nonEmpty = (value) => typeof value === 'string' && value.length > 0;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
const stringList = (value) => Array.isArray(value) && value.length <= 1000 && value.every(nonEmpty);

/**
 * Return why `claims` violate the kind/scope rules, or `null` when consistent.
 *  - every kind: `user.id`, `scope` object; `scope.subscriptions` (when present) is a list of ids
 *  - merchant: `scope.merchantId`
 *  - admin: either `scope.all === true` (app-wide; then no merchant/website/subscription members) or `scope.merchantId`
 *  - `scope.all` only for admin
 * @param {Record<string, unknown>} claims
 * @returns {string | null}
 */
export const kindScopeViolation = (claims) => {
	const { kind, user, scope } = claims;
	if (typeof kind !== 'string' || !(/** @type {readonly string[]} */ (LAUNCH_KINDS).includes(kind))) return 'unknown kind';
	if (!isObject(user) || !nonEmpty(user.id)) return 'user.id is required';
	if (!isObject(scope)) return 'scope is required';
	if (scope.subscriptions !== undefined && !stringList(scope.subscriptions)) return 'scope.subscriptions must be a list of ids';
	if (scope.all !== undefined) {
		if (kind !== 'admin') return 'scope.all is only allowed for admin launches';
		if (scope.all !== true) return 'scope.all must be true';
		const extra = Object.keys(scope).find((key) => !ALL_SCOPE_MEMBERS.has(key));
		return extra === undefined ? null : `scope.all excludes scope.${extra}`;
	}
	if (nonEmpty(scope.merchantId)) return null;
	return kind === 'merchant'
		? 'merchant launch requires scope.merchantId'
		: 'admin launch requires scope.all or scope.merchantId';
};

/**
 * Issue a launch token.
 * @param {{
 *   signer: Signer, issuer: string, audience: string, subject: string, kind: LaunchKind, user: LaunchUser,
 *   scope?: LaunchScope, subscriptions?: unknown[], ttlSeconds?: number, jti?: string, now?: () => number,
 *   randomBytes?: (length: number) => Uint8Array,
 * }} params `audience` is the product's appId.
 * @returns {Promise<{ token: string, claims: LaunchClaims }>}
 */
export const issueLaunch = async ({
	signer,
	issuer,
	audience,
	subject,
	kind,
	user,
	scope = {},
	subscriptions,
	ttlSeconds = DEFAULT_LAUNCH_TTL_SECONDS,
	jti,
	now = Date.now,
	randomBytes = defaultRandomBytes,
}) => {
	requireString(issuer, 'issuer');
	requireString(audience, 'audience');
	requireString(subject, 'subject');
	if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_LAUNCH_TTL_SECONDS) {
		throw createProtocolError('invalid_argument', `ttlSeconds must be 1..${MAX_LAUNCH_TTL_SECONDS}`);
	}
	const iat = nowSeconds(now);
	/** @type {Record<string, unknown>} */
	const claims = {
		iss: issuer,
		aud: audience,
		sub: subject,
		iat,
		nbf: iat,
		exp: iat + ttlSeconds,
		jti: jti ?? randomId(randomBytes),
		kind,
		user,
		scope,
	};
	if (subscriptions !== undefined) claims.subscriptions = subscriptions;
	const violation = kindScopeViolation(claims);
	if (violation) throw createProtocolError('kind_scope', violation);
	const token = await signCompact({ signer, typ: LAUNCH_TYP, payload: claims });
	return { token, claims: /** @type {LaunchClaims} */ (claims) };
};

/**
 * Verify a launch token and consume its `jti` (single use).
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
	if (!nonEmpty(payload.sub)) throw createProtocolError('malformed', 'sub is missing');
	if (!nonEmpty(payload.jti)) throw createProtocolError('malformed', 'jti is missing');
	const { exp } = checkTimeClaims({ claims: payload, nowMs: now(), skewSeconds, maxLifetimeSeconds: maxTtlSeconds });
	const violation = kindScopeViolation(payload);
	if (violation) throw createProtocolError('kind_scope', violation);
	const first = await consume(/** @type {string} */ (payload.jti), (exp + skewSeconds) * 1000);
	if (!first) throw createProtocolError('replay', 'launch token was already used');
	return /** @type {LaunchClaims} */ (/** @type {unknown} */ (payload));
};
