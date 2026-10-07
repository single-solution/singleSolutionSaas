/**
 * Tickets for admin widgets (PLAN 0.4.5): a product signs a 15-minute ticket (`typ: ss-ticket+jws`, EdDSA, with its own
 * ticket key) for one member of the merchant's staff, one website, one browser origin and a set of permissions. The
 * merchant's server asks for it with the server token; `tid` records that server token's `jti`, so regenerating the
 * server token ends every ticket made with it.
 *
 * A ticket is accepted only on requests whose Origin equals the ticket's origin. Every verification failure throws the
 * same `invalid_token` error.
 */
import { createProtocolError, isProtocolError } from './errors.js';
import { defaultRandomBytes, randomId } from './encoding.js';
import { checkTimeClaims, isObject, nowSeconds, signCompact, verifyCompact } from './jws.js';
import { canonicalOrigin, isProductId, ticketOriginAllowed } from './tokens.js';

/** @import { KeyResolver, Signer } from './keys.js' */

/** JOSE `typ` of tickets. */
export const TICKET_TYP = 'ss-ticket+jws';

/** Lifetime of every ticket, seconds (exactly 15 minutes). */
export const TICKET_TTL_SECONDS = 900;

/** Format of a permission key (the manifest `permissions[].key`). */
export const PERMISSION_KEY_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;

const INVALID_TOKEN_MESSAGE = 'token is not valid';
const SKEW_SECONDS = 5;
const MAX_PERMISSIONS = 100;

/** @typedef {{ id: string, name: string, email: string }} TicketUser */
/**
 * @typedef {{ iss: string, aud: string, sub: string, websiteId: string, user: TicketUser, origin: string,
 *   permissions: string[], tid: string, iat: number, nbf: number, exp: number, jti: string }} TicketClaims
 */

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {value is string}
 */
const isText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

/**
 * Return why a ticket user is invalid, or `null`.
 * @param {unknown} user
 * @returns {string | null}
 */
const userViolation = (user) => {
	if (!isObject(user)) return 'user is required';
	if (!isText(user.id, 256)) return 'user.id is required';
	if (!isText(user.name, 200)) return 'user.name is required';
	if (!isText(user.email, 320)) return 'user.email is required';
	return null;
};

/**
 * @param {unknown} permissions
 * @returns {boolean}
 */
const isPermissionList = (permissions) =>
	Array.isArray(permissions) &&
	permissions.length <= MAX_PERMISSIONS &&
	permissions.every((key) => typeof key === 'string' && PERMISSION_KEY_PATTERN.test(key)) &&
	new Set(permissions).size === permissions.length;

/**
 * Issue a ticket (product side). `origin` must pass `ticketOriginAllowed` and is stored in canonical form.
 * @param {{
 *   signer: Signer, productId: string, websiteId: string, user: TicketUser, origin: string, permissions: string[],
 *   tokenId: string, now?: () => number, randomBytes?: (length: number) => Uint8Array,
 * }} params `tokenId` is the `jti` of the server token the ticket was requested with.
 * @returns {Promise<{ ticket: string, expiresAt: string, claims: TicketClaims }>}
 */
export const issueTicket = async ({
	signer,
	productId,
	websiteId,
	user,
	origin,
	permissions,
	tokenId,
	now = Date.now,
	randomBytes = defaultRandomBytes,
}) => {
	if (!isProductId(productId)) throw createProtocolError('invalid_argument', 'productId is invalid');
	if (!isText(websiteId, 256)) throw createProtocolError('invalid_argument', 'websiteId is required');
	if (!isText(tokenId, 256)) throw createProtocolError('invalid_argument', 'tokenId is required');
	const violation = userViolation(user);
	if (violation) throw createProtocolError('invalid_argument', violation);
	if (!ticketOriginAllowed(origin)) throw createProtocolError('invalid_argument', 'origin is not allowed');
	if (!isPermissionList(permissions)) throw createProtocolError('invalid_argument', 'permissions must be unique keys');
	const iat = nowSeconds(now);
	/** @type {TicketClaims} */
	const claims = {
		iss: productId,
		aud: productId,
		sub: user.id,
		websiteId,
		user: { id: user.id, name: user.name, email: user.email },
		origin: /** @type {string} */ (canonicalOrigin(origin)),
		permissions: [...permissions],
		tid: tokenId,
		iat,
		nbf: iat,
		exp: iat + TICKET_TTL_SECONDS,
		jti: randomId(randomBytes),
	};
	const ticket = await signCompact({ signer, typ: TICKET_TYP, payload: claims });
	return { ticket, expiresAt: new Date(claims.exp * 1000).toISOString(), claims };
};

/**
 * Check the verified payload of a ticket; throws on the first problem.
 * @param {Record<string, unknown>} payload
 * @param {{ productId: string, origin: string | null, nowMs: number }} expected
 * @returns {TicketClaims}
 */
const checkTicketClaims = (payload, { productId, origin, nowMs }) => {
	if (payload.iss !== productId || payload.aud !== productId) throw createProtocolError('audience', 'wrong product');
	checkTimeClaims({ claims: payload, nowMs, skewSeconds: SKEW_SECONDS, maxLifetimeSeconds: TICKET_TTL_SECONDS });
	if (origin === null || payload.origin !== origin) throw createProtocolError('malformed', 'origin does not match');
	if (userViolation(payload.user) !== null) throw createProtocolError('malformed', 'user is invalid');
	const user = /** @type {TicketUser} */ (payload.user);
	if (payload.sub !== user.id || !isText(payload.websiteId, 256) || !isText(payload.tid, 256) || !isText(payload.jti, 256))
		throw createProtocolError('malformed', 'claims are invalid');
	if (!isPermissionList(payload.permissions)) throw createProtocolError('malformed', 'permissions are invalid');
	return /** @type {TicketClaims} */ (/** @type {unknown} */ (payload));
};

/**
 * Verify a ticket (product side): signature with the product's own ticket key, typ, issuer and audience equal to
 * `productId`, time (15 minutes at most), `origin` equal to the ticket's origin (both canonical), and the server token it
 * was made with not revoked. Every failure throws `invalid_token` with the same message; errors thrown by `isRevoked`
 * itself pass through unchanged.
 * @param {{
 *   ticket: unknown, keyResolver: KeyResolver, productId: string, origin: unknown,
 *   isRevoked?: (tid: string) => boolean | Promise<boolean>, now?: () => number,
 * }} params `origin` is the request's Origin header.
 * @returns {Promise<TicketClaims>}
 */
export const verifyTicket = async ({ ticket, keyResolver, productId, origin, isRevoked, now = Date.now }) => {
	if (!isProductId(productId)) throw createProtocolError('invalid_argument', 'productId is invalid');
	if (!keyResolver || typeof keyResolver.resolve !== 'function')
		throw createProtocolError('invalid_argument', 'keyResolver is required');
	/** @type {TicketClaims} */
	let claims;
	try {
		const { payload } = await verifyCompact({ token: ticket, keyResolver, typ: TICKET_TYP, maxLength: 8192 });
		claims = checkTicketClaims(payload, { productId, origin: canonicalOrigin(origin), nowMs: now() });
	} catch (error) {
		if (isProtocolError(error)) throw createProtocolError('invalid_token', INVALID_TOKEN_MESSAGE);
		throw error;
	}
	if (isRevoked && (await isRevoked(claims.tid)) === true) throw createProtocolError('invalid_token', INVALID_TOKEN_MESSAGE);
	return claims;
};
