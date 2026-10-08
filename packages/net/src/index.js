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
export * from './policy.js';
export { guardedLookup, resolveVetted } from './lookup.js';
export { jsonOf, safeFetch, textOf } from './fetch.js';
export { isSafeMongoUri, parseMongoUri } from './mongo.js';
export { amzDates, objectUrl, presignV4, signV4, uriEncode } from './sigv4.js';

/** @typedef {import('./errors.js').NetError} NetError */
/** @typedef {import('./errors.js').NetErrorCode} NetErrorCode */
/** @typedef {import('./address.js').AddressClass} AddressClass */
/** @typedef {import('./address.js').AddressCategory} AddressCategory */
/** @typedef {import('./lookup.js').LookupFunction} LookupFunction */
/** @typedef {import('./fetch.js').SafeFetchInit} SafeFetchInit */
/** @typedef {import('./fetch.js').SafeResponse} SafeResponse */
/** @typedef {import('./mongo.js').ParsedMongoUri} ParsedMongoUri */
/** @typedef {import('./mongo.js').MongoUriCheck} MongoUriCheck */
/** @typedef {import('./sigv4.js').SignV4Params} SignV4Params */
/** @typedef {import('./sigv4.js').PresignV4Params} PresignV4Params */
