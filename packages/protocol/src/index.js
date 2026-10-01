/**
 * @ss/protocol — App Protocol primitives shared by the Portal and every product.
 * See README.md for sequence diagrams and the security rationale of each primitive.
 */
export { ERROR_CODES, createProtocolError, isProtocolError } from './errors.js';
export {
	createJwks,
	createKeyResolver,
	createSigner,
	exportPublicJwk,
	generateSigningKey,
	importPrivateKey,
	importPublicKey,
	thumbprint,
	toPublicJwk,
} from './keys.js';
export { consumeWith, createMemoryReplayStore } from './replay.js';
export {
	DEFAULT_LAUNCH_TTL_SECONDS,
	LAUNCH_KINDS,
	LAUNCH_TYP,
	MAX_IMPERSONATION_SECONDS,
	MAX_LAUNCH_TTL_SECONDS,
	issueLaunch,
	kindScopeViolation,
	verifyLaunch,
} from './launch.js';
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
export { EVENT_HEADERS, signEvent, verifyEvent } from './events.js';
export { canonicalRequestPath, signRequest, verifyRequest } from './requests.js';
export {
	REGISTRATION_RESPONSE_TYP,
	REGISTRATION_TYP,
	canonicalUrl,
	createRegistrationHandler,
	createRegistrationRequest,
	hashManifest,
	hashRegistrationToken,
	verifyRegistrationResponse,
} from './registration.js';
export { BUNDLE_SIGNING_PREFIX, bundleSigningInput, signBundle, verifyBundle } from './bundle.js';
export {
	DEFAULT_MANIFEST_MAX_AGE_SECONDS,
	MANIFEST_SIGNATURE_HEADER,
	MANIFEST_TYP,
	signManifest,
	verifyManifest,
} from './manifest-signature.js';
export { canonicalJson } from './encoding.js';

/** @typedef {import('./errors.js').ProtocolError} ProtocolError */
/** @typedef {import('./errors.js').ProtocolErrorCode} ProtocolErrorCode */
/** @typedef {import('./keys.js').PublicJwk} PublicJwk */
/** @typedef {import('./keys.js').PrivateJwk} PrivateJwk */
/** @typedef {import('./keys.js').Jwks} Jwks */
/** @typedef {import('./keys.js').Signer} Signer */
/** @typedef {import('./keys.js').KeyResolver} KeyResolver */
/** @typedef {import('./replay.js').ReplayStore} ReplayStore */
/** @typedef {import('./launch.js').LaunchClaims} LaunchClaims */
/** @typedef {import('./launch.js').LaunchScope} LaunchScope */
/** @typedef {import('./launch.js').LaunchUser} LaunchUser */
/** @typedef {import('./bundle.js').BundleSignature} BundleSignature */
/** @typedef {import('./manifest-signature.js').ManifestSignatureClaims} ManifestSignatureClaims */
/** @typedef {import('./launch.js').LaunchKind} LaunchKind */
/** @typedef {import('./assertion.js').AssertionClaims} AssertionClaims */
/** @typedef {import('./website-keys.js').WebsiteKeyClaims} WebsiteKeyClaims */
/** @typedef {import('./entitlement-doc.js').EntitlementPayload} EntitlementPayload */
/** @typedef {import('./events.js').EventHeaders} EventHeaders */
/** @typedef {import('./requests.js').RequestHeaders} RequestHeaders */
/** @typedef {import('./registration.js').RegistrationResult} RegistrationResult */
/** @typedef {import('./registration.js').RegistrationProofClaims} RegistrationProofClaims */
