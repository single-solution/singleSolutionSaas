/**
 * Client database credentials (pure). Connection-string safety is `@ss/net` `isSafeMongoUri`: only `mongodb://` and
 * `mongodb+srv://`, every host public (or on the development allowlist), only safe URI options (no local file reads,
 * no TLS weakening, no proxies, no ambient cloud credentials, SCRAM only), TLS unless every host is allowlisted. The
 * credential rules on top of it stay here: a user and password outside the allowlist, and a usable database name
 * (never `admin`, `local` or `config`).
 * @module
 */
import { checkHost, isSafeMongoUri, parseMongoUri } from '@ss/net';

/** @typedef {import('@ss/net').OutboundPolicy} OutboundPolicy */
/** @typedef {import('@ss/net').ParsedMongoUri} ParsedMongoUri */
/** @typedef {{ path: string, message: string, code?: string }} FieldError */

const PATH = '/credentials/uri';
const RESERVED_DBS = new Set(['admin', 'local', 'config']);
const DB_NAME = /^[^/\\. "$*<>:|?\0]{1,63}$/;

/**
 * Field error of a refused connection string (never echoes the value).
 * @param {{ code: string, reason: string }} refusal
 * @returns {FieldError}
 */
const refusalError = ({ code, reason }) => {
	switch (code) {
		case 'ssrf_blocked':
			return { path: PATH, message: 'hosts must be public addresses', code: 'address_refused' };
		case 'tls_required':
			return { path: PATH, message: 'TLS is required (tls=true)', code: 'tls_required' };
		case 'unsafe_option':
			return reason === 'auth_mechanism'
				? { path: PATH, message: 'only SCRAM authentication is allowed', code: 'unsafe_option' }
				: { path: PATH, message: `option ${reason.replace(/^option_/, '')} is not allowed`, code: 'unsafe_option' };
		default:
			return { path: PATH, message: 'a host is invalid', code: 'invalid_host' };
	}
};

/**
 * Validate a client database credential `{ uri, dbName? }` semantically.
 * @param {{ uri: string, dbName?: string }} credentials
 * @param {OutboundPolicy} policy
 * @returns {{ errors: FieldError[], parsed: ParsedMongoUri | null, dbName: string | null }}
 */
export const checkDatabaseCredentials = (credentials, policy) => {
	const parsed = parseMongoUri(credentials.uri);
	if (!parsed.ok)
		return {
			errors: [{ path: PATH, message: 'must be a valid mongodb:// or mongodb+srv:// connection string' }],
			parsed: null,
			dbName: null,
		};
	const uri = parsed.value;
	/** @type {FieldError[]} */
	const errors = [];
	const safe = isSafeMongoUri(credentials.uri, policy);
	if (!safe.ok) errors.push(refusalError(safe));
	const local = uri.hosts.every(({ host }) => {
		const checked = checkHost(host, policy);
		return checked.ok && checked.allowlisted;
	});
	if (!local && (uri.username === null || !uri.hasPassword))
		errors.push({ path: PATH, message: 'a database user and password are required' });
	const dbName = credentials.dbName ?? uri.dbName;
	if (dbName === null)
		errors.push({ path: '/credentials/dbName', message: 'a database name is required (in the URI path or dbName)' });
	else if (!DB_NAME.test(dbName) || Buffer.byteLength(dbName) > 63)
		errors.push({ path: '/credentials/dbName', message: 'the database name is invalid' });
	else if (RESERVED_DBS.has(dbName.toLowerCase()))
		errors.push({ path: '/credentials/dbName', message: 'admin, local and config cannot be used' });
	return { errors, parsed: uri, dbName };
};
