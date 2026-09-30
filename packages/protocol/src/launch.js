/**
 * SSO launch tokens: Portal → product, single use, short-lived (default 60 s), EdDSA JWT with `typ: ss-launch+jwt`.
 *
 * The product exchanges the launch for its own session once, after checking signature (Portal JWKS), issuer,
 * audience (= the product's appId), time, lifetime cap, kind/scope consistency and single use (`consume(jti)`).
 */
import { createProtocolError } from './errors.js';
import { defaultRandomBytes, randomId } from './encoding.js';
import { checkTimeClaims, isObject, nowSeconds, requireString, signCompact, verifyCompact } from './jws.js';

/** @typedef {import('./keys.js').Signer} Signer */
/** @typedef {import('./keys.js').KeyResolver} KeyResolver */

/** Launch kinds. */
export const LAUNCH_KINDS = Object.freeze(
	/** @type {const} */ (['merchant', 'demo', 'admin', 'impersonate', 'partner', 'developer']),
);

/** JOSE `typ` of launch tokens. */
export const LAUNCH_TYP = 'ss-launch+jwt';

/** Default and maximum launch lifetime (seconds). */
export const DEFAULT_LAUNCH_TTL_SECONDS = 60;
export const MAX_LAUNCH_TTL_SECONDS = 300;
/** Maximum impersonation session length (seconds). */
export const MAX_IMPERSONATION_SECONDS = 3600;

/** @typedef {typeof LAUNCH_KINDS[number]} LaunchKind */
/** @typedef {{ id: string, email?: string, name?: string, roles?: string[] }} LaunchUser */
/**
 * @typedef {{ merchantId?: string, websiteId?: string, websiteIds?: string[], partnerId?: string, developerId?: string,
 *   permissions?: string[] }} LaunchScope
 */
/**
 * @typedef {{ iss: string, aud: string, sub: string, iat: number, nbf: number, exp: number, jti: string, kind: LaunchKind,
 *   user: LaunchUser, scope: LaunchScope, subscriptions?: unknown[], act?: { sub: string }, impExp?: number }} LaunchClaims
 */

/**
 * @param {unknown} value
 * @returns {boolean}
 */
const nonEmpty = (value) => typeof value === 'string' && value.length > 0;

/**
 * Return why `claims` violate the kind/scope rules, or `null` when consistent.
 *  - every kind: `user.id`, `scope` object
 *  - merchant/admin: `scope.merchantId`; admin is always merchant-scoped
 *  - demo: no `scope.merchantId` (sandbox data only)
 *  - partner: `scope.partnerId`; developer: `scope.developerId`
 *  - impersonate: `act.sub` (the staff actor, ≠ `sub`), `scope.merchantId`, `impExp` with iat < impExp ≤ iat + 1 h
 *  - only impersonate may carry `act` / `impExp`
 * @param {Record<string, unknown>} claims
 * @returns {string | null}
 */
export const kindScopeViolation = (claims) => {
	const { kind, user, scope, act, impExp, iat, sub } = claims;
	if (typeof kind !== 'string' || !(/** @type {readonly string[]} */ (LAUNCH_KINDS).includes(kind))) return 'unknown kind';
	if (!isObject(user) || !nonEmpty(user.id)) return 'user.id is required';
	if (!isObject(scope)) return 'scope is required';
	if (kind !== 'impersonate' && (act !== undefined || impExp !== undefined)) return 'act/impExp only allowed for impersonate';
	switch (kind) {
		case 'merchant':
		case 'admin':
			return nonEmpty(scope.merchantId) ? null : `${kind} launch requires scope.merchantId`;
		case 'demo':
			return scope.merchantId === undefined ? null : 'demo launch must not carry scope.merchantId';
		case 'partner':
			return nonEmpty(scope.partnerId) ? null : 'partner launch requires scope.partnerId';
		case 'developer':
			return nonEmpty(scope.developerId) ? null : 'developer launch requires scope.developerId';
		default: {
			if (!isObject(act) || !nonEmpty(act.sub)) return 'impersonate launch requires act.sub';
			if (act.sub === sub) return 'actor must differ from subject';
			if (!nonEmpty(scope.merchantId)) return 'impersonate launch requires scope.merchantId';
			if (typeof impExp !== 'number' || typeof iat !== 'number') return 'impersonate launch requires impExp';
			if (impExp <= iat || impExp - iat > MAX_IMPERSONATION_SECONDS) return 'impExp must be within 1 hour of iat';
			return null;
		}
	}
};

/**
 * Issue a launch token.
 * @param {{
 *   signer: Signer, issuer: string, audience: string, subject: string, kind: LaunchKind, user: LaunchUser,
 *   scope?: LaunchScope, subscriptions?: unknown[], actor?: string, impersonationSeconds?: number,
 *   ttlSeconds?: number, jti?: string, now?: () => number, randomBytes?: (length: number) => Uint8Array,
 * }} params `audience` is the product's appId; `actor` and `impersonationSeconds` are for `impersonate` only.
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
	actor,
	impersonationSeconds,
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
	if (kind === 'impersonate') {
		if (actor !== undefined) claims.act = { sub: actor };
		claims.impExp = iat + (impersonationSeconds ?? MAX_IMPERSONATION_SECONDS);
	}
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
	if (payload.kind === 'impersonate' && now() / 1000 >= /** @type {number} */ (payload.impExp)) {
		throw createProtocolError('expired', 'impersonation window has ended');
	}
	const first = await consume(/** @type {string} */ (payload.jti), (exp + skewSeconds) * 1000);
	if (!first) throw createProtocolError('replay', 'launch token was already used');
	return /** @type {LaunchClaims} */ (/** @type {unknown} */ (payload));
};
