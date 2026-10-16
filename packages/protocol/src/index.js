/**
 * @ss/protocol — signing and verification shared by the Portal and every product: Ed25519 keys and JWKS, browser and
 * server tokens, tickets, launches, client assertions, notices, Portal calls and the connect handshake; the sealing
 * of stored secrets; timestamped webhook signatures; and the hashing, comparing and random-token helpers. See README.md.
 */
export { isProtocolError } from './errors.js';
export { createJwks, createKeyResolver, createSigner, generateSigningKey, signingKeyFromSeed, toPublicJwk } from './keys.js';
export { canonicalOrigin, isLocalOrigin, issueToken, originAllowed, ticketOriginAllowed, verifyToken } from './tokens.js';
export { issueTicket, verifyTicket } from './tickets.js';
export { issueLaunch, verifyLaunch } from './launch.js';
export { signAssertion, verifyAssertion } from './assertion.js';
export { NOTICE_PATH, signNotice, verifyNotice } from './notices.js';
export { signPortalCall, verifyPortalCall } from './calls.js';
export {
	CONNECT_PATH,
	canonicalUrl,
	createConnectRequest,
	createConnectResponse,
	isConnectSecret,
	verifyConnectRequest,
	verifyConnectResponse,
} from './registration.js';
export { canonicalJson, constantTimeEqual, hmacSha256Hex, randomToken, sha256Hex } from './encoding.js';
export { createSealer } from './sealing.js';
export { WEBHOOK_TOLERANCE_SECONDS, signWebhook, verifyWebhook } from './webhooks.js';

/** @typedef {import('./keys.js').PublicJwk} PublicJwk */
/** @typedef {import('./keys.js').PrivateJwk} PrivateJwk */
/** @typedef {import('./keys.js').Jwks} Jwks */
/** @typedef {import('./keys.js').Signer} Signer */
/** @typedef {import('./keys.js').KeyResolver} KeyResolver */
/** @typedef {import('./tokens.js').TokenKind} TokenKind */
/** @typedef {import('./tokens.js').TokenClaims} TokenClaims */
/** @typedef {import('./tickets.js').TicketUser} TicketUser */
/** @typedef {import('./tickets.js').TicketClaims} TicketClaims */
/** @typedef {import('./launch.js').LaunchClaims} LaunchClaims */
/** @typedef {import('./errors.js').ProtocolError} ProtocolError */
/** @typedef {import('./errors.js').ProtocolErrorCode} ProtocolErrorCode */
/** @typedef {import('./assertion.js').ReplayStore} ReplayStore */
/** @typedef {import('./assertion.js').AssertionClaims} AssertionClaims */
/** @typedef {import('./notices.js').Notice} Notice */
/** @typedef {import('./notices.js').NoticeType} NoticeType */
/** @typedef {import('./notices.js').NoticeHeaders} NoticeHeaders */
/** @typedef {import('./calls.js').CallHeaders} CallHeaders */
/** @typedef {import('./sealing.js').Sealer} Sealer */
