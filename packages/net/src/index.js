/**
 * @ss/net — safe outbound networking shared by the Portal and products: SSRF policy and address classification,
 * DNS-pinned guarded lookups, a guarded fetch, MongoDB URI safety and AWS SigV4 signing. See README.md.
 */
export { NET_ERROR_CODES, isNetError, netError } from './errors.js';
export {
	IPV4_RANGES,
	IPV6_RANGES,
	classifyAddress,
	formatIPv4,
	formatIPv6,
	isBlockedAddress,
	isIpLiteral,
	parseIPv4,
	parseIPv6,
	parseLooseIPv4,
} from './address.js';
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_REDIRECTS,
	DEFAULT_PORTS,
	DEFAULT_TIMEOUT_MS,
	INTERNAL_SUFFIXES,
	MAX_URL_LENGTH,
	checkHost,
	checkUrl,
	createOutboundPolicy,
	isAllowlisted,
	normaliseHost,
	sameOrigin,
} from './policy.js';
export { guardedLookup, resolveVetted } from './lookup.js';
export { jsonOf, safeFetch, textOf } from './fetch.js';
export { SAFE_MONGO_OPTIONS, isSafeMongoUri, parseMongoUri } from './mongo.js';
export { ALGORITHM, MAX_PRESIGN_SECONDS, UNSIGNED_PAYLOAD, amzDates, objectUrl, presignV4, signV4, uriEncode } from './sigv4.js';

/** @typedef {import('./errors.js').NetError} NetError */
/** @typedef {import('./errors.js').NetErrorCode} NetErrorCode */
/** @typedef {import('./address.js').AddressClass} AddressClass */
/** @typedef {import('./address.js').AddressCategory} AddressCategory */
/** @typedef {import('./policy.js').OutboundPolicy} OutboundPolicy */
/** @typedef {import('./policy.js').OutboundPolicyOptions} OutboundPolicyOptions */
/** @typedef {import('./policy.js').Resolver} Resolver */
/** @typedef {import('./policy.js').ResolvedAddress} ResolvedAddress */
/** @typedef {import('./policy.js').UrlCheck} UrlCheck */
/** @typedef {import('./policy.js').HostCheck} HostCheck */
/** @typedef {import('./lookup.js').LookupFunction} LookupFunction */
/** @typedef {import('./fetch.js').SafeFetchInit} SafeFetchInit */
/** @typedef {import('./fetch.js').SafeResponse} SafeResponse */
/** @typedef {import('./mongo.js').ParsedMongoUri} ParsedMongoUri */
/** @typedef {import('./mongo.js').MongoUriCheck} MongoUriCheck */
/** @typedef {import('./sigv4.js').SignV4Params} SignV4Params */
/** @typedef {import('./sigv4.js').PresignV4Params} PresignV4Params */
