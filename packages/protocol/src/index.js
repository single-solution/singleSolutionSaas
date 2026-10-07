/**
 * @ss/protocol — App Protocol primitives shared by the Portal and every product.
 * See README.md for sequence diagrams and the security rationale of each primitive.
 */
export { ERROR_CODES, createProtocolError, isProtocolError } from './errors.js';
export * from './keys.js';
export { consumeWith, createMemoryReplayStore } from './replay.js';
export * from './launch.js';
export { ASSERTION_TYP, MAX_ASSERTION_LIFETIME_SECONDS, signAssertion, verifyAssertion } from './assertion.js';
export {
	WEBSITE_KEY_TYP,
	compareSecretKey,
	hashSecretKey,
	issueWebsiteKey,
	normalizeDomain,
	originAllowed,
	verifyWebsiteKey,
} from './website-keys.js';
export { DEFAULT_GRACE_MS, ENTITLEMENT_TYP, signEntitlementDocument, verifyEntitlementDocument } from './entitlement-doc.js';
export * from './events.js';
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
	hashManifest,
	isConnectSecret,
	verifyConnectRequest,
	verifyConnectResponse,
} from './registration.js';
export { canonicalJson } from './encoding.js';

/** @typedef {import('./errors.js').ProtocolError} ProtocolError */
/** @typedef {import('./errors.js').ProtocolErrorCode} ProtocolErrorCode */
/** @typedef {import('./replay.js').ReplayStore} ReplayStore */
/** @typedef {import('./assertion.js').AssertionClaims} AssertionClaims */
/** @typedef {import('./website-keys.js').WebsiteKeyClaims} WebsiteKeyClaims */
/** @typedef {import('./entitlement-doc.js').EntitlementPayload} EntitlementPayload */
