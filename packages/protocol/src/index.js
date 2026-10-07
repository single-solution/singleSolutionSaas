/**
 * @ss/protocol — signing and verification shared by the Portal and every product: Ed25519 keys and JWKS, browser and
 * server tokens, tickets, launches, client assertions, notices and the connect handshake. See README.md.
 */
export { ERROR_CODES, createProtocolError, isProtocolError } from './errors.js';
export * from './keys.js';
export { consumeWith, createMemoryReplayStore } from './replay.js';
export * from './tokens.js';
export * from './tickets.js';
export * from './launch.js';
export { ASSERTION_TYP, MAX_ASSERTION_LIFETIME_SECONDS, signAssertion, verifyAssertion } from './assertion.js';
export { NOTICE_HEADERS, NOTICE_PATH, NOTICE_TOLERANCE_SECONDS, NOTICE_TYPES, signNotice, verifyNotice } from './notices.js';
export {
	CONNECT_PATH,
	CONNECT_SIGNATURE_HEADER,
	CONNECT_TIMESTAMP_HEADER,
	CONNECT_TOLERANCE_SECONDS,
	MIN_CONNECT_SECRET_LENGTH,
	canonicalUrl,
	createConnectRequest,
	createConnectResponse,
	generateConnectSecret,
	isConnectSecret,
	verifyConnectRequest,
	verifyConnectResponse,
} from './registration.js';
export { canonicalJson } from './encoding.js';

/** @typedef {import('./errors.js').ProtocolError} ProtocolError */
/** @typedef {import('./errors.js').ProtocolErrorCode} ProtocolErrorCode */
/** @typedef {import('./replay.js').ReplayStore} ReplayStore */
/** @typedef {import('./assertion.js').AssertionClaims} AssertionClaims */
/** @typedef {import('./notices.js').Notice} Notice */
/** @typedef {import('./notices.js').NoticeType} NoticeType */
/** @typedef {import('./notices.js').NoticeHeaders} NoticeHeaders */
