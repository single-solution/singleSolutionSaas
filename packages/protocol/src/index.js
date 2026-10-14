/**
 * @ss/protocol — signing and verification shared by the Portal and every product: Ed25519 keys and JWKS, browser and
 * server tokens, tickets, launches, client assertions, notices, Portal calls and the connect handshake; and the sealing
 * of stored secrets. See README.md.
 */
export { ERROR_CODES, createProtocolError, isProtocolError } from './errors.js';
export * from './keys.js';
export * from './tokens.js';
export * from './tickets.js';
export * from './launch.js';
export { signAssertion, verifyAssertion } from './assertion.js';
export { NOTICE_PATH, NOTICE_TYPES, signNotice, verifyNotice } from './notices.js';
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
export { canonicalJson } from './encoding.js';
export { SEAL_FORMAT, createSealer, legacyV1, sealKeyId } from './sealing.js';

/** @typedef {import('./errors.js').ProtocolError} ProtocolError */
/** @typedef {import('./errors.js').ProtocolErrorCode} ProtocolErrorCode */
/** @typedef {import('./assertion.js').ReplayStore} ReplayStore */
/** @typedef {import('./assertion.js').AssertionClaims} AssertionClaims */
/** @typedef {import('./notices.js').Notice} Notice */
/** @typedef {import('./notices.js').NoticeType} NoticeType */
/** @typedef {import('./notices.js').NoticeHeaders} NoticeHeaders */
/** @typedef {import('./calls.js').CallHeaders} CallHeaders */
/** @typedef {import('./sealing.js').Sealer} Sealer */
/** @typedef {import('./sealing.js').LegacyReader} LegacyReader */
