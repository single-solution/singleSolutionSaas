/**
 * @ss/net — the server-side networking and runtime shared by the Portal and products: SSRF policy and address
 * classification, DNS-pinned guarded lookups, a guarded fetch, MongoDB connection strings and client rules, AWS SigV4
 * signing, the structured logger with redaction and the static security headers. See README.md.
 */
export { isNetError, netError } from './errors.js';
export { LOCAL_HOSTS, allowHostsFor, checkHost, checkUrl, createOutboundPolicy } from './policy.js';
export { guardedLookup, resolveVetted } from './lookup.js';
export { jsonOf, safeFetch, textOf } from './fetch.js';
export { isSafeMongoUri, mongoDatabaseName } from './mongo.js';
export { DATABASE_DEADLINES, connectBeforeUse, databaseClientOptions, isDatabaseUnavailable } from './database.js';
export { createLogger, noopLogger, redact } from './logger.js';
export { clientIpOf, staticSecurityHeaders } from './headers.js';
export { createLocalWindows } from './windows.js';
export { objectUrl, presignV4, signV4 } from './sigv4.js';

/** @typedef {import('./policy.js').OutboundPolicy} OutboundPolicy */
/** @typedef {import('./policy.js').OutboundPolicyOptions} OutboundPolicyOptions */
/** @typedef {import('./policy.js').Resolver} Resolver */
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
/** @typedef {import('./logger.js').Logger} Logger */
/** @typedef {import('./logger.js').LogLevel} LogLevel */
