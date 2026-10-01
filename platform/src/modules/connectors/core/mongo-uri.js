/**
 * MongoDB connection strings of client databases (pure). Only `mongodb://` and `mongodb+srv://` are accepted; the
 * hosts must be public (see `netguard.js`); only a known-safe set of URI options is allowed — anything that makes
 * the Portal read local files (`tlsCAFile`, …), weaken TLS (`tlsInsecure`, …), go through a proxy (`proxyHost`, …)
 * or use ambient cloud credentials (`MONGODB-AWS`, `MONGODB-OIDC`, `authMechanismProperties`) is refused; TLS is
 * required unless every host is on the development allowlist.
 * @module
 */
import { checkHost, isAllowlisted } from './netguard.js';

/** @typedef {import('./netguard.js').Allowlist} Allowlist */
/** @typedef {{ path: string, message: string, code?: string }} FieldError */

/**
 * @typedef {object} ParsedMongoUri
 * @property {'mongodb' | 'mongodb+srv'} scheme
 * @property {string | null} username decoded
 * @property {boolean} hasPassword
 * @property {Array<{ host: string, port: number | null }>} hosts
 * @property {string | null} dbName from the path
 * @property {URLSearchParams} options
 */

/** Options (lower-cased) a client connection string may carry. */
const SAFE_OPTIONS = new Set(
	[
		'replicaSet',
		'authSource',
		'authMechanism',
		'tls',
		'ssl',
		'retryWrites',
		'retryReads',
		'w',
		'wtimeoutMS',
		'journal',
		'readPreference',
		'readPreferenceTags',
		'maxStalenessSeconds',
		'readConcernLevel',
		'maxPoolSize',
		'minPoolSize',
		'maxIdleTimeMS',
		'maxConnecting',
		'waitQueueTimeoutMS',
		'appName',
		'compressors',
		'zlibCompressionLevel',
		'directConnection',
		'loadBalanced',
		'connectTimeoutMS',
		'socketTimeoutMS',
		'serverSelectionTimeoutMS',
		'heartbeatFrequencyMS',
		'localThresholdMS',
		'srvMaxHosts',
	].map((name) => name.toLowerCase()),
);
const SAFE_MECHANISMS = new Set(['SCRAM-SHA-1', 'SCRAM-SHA-256']);
const RESERVED_DBS = new Set(['admin', 'local', 'config']);
const DB_NAME = /^[^/\\. "$*<>:|?\0]{1,63}$/;

/**
 * Parse a MongoDB connection string without contacting anything.
 * @param {string} uri
 * @returns {{ ok: true, value: ParsedMongoUri } | { ok: false, message: string }}
 */
export const parseMongoUri = (uri) => {
	const match = /^(mongodb(?:\+srv)?):\/\/([^/?#]*)(\/[^?#]*)?(\?[^#]*)?$/.exec(uri);
	if (!match) return { ok: false, message: 'must be a mongodb:// or mongodb+srv:// connection string' };
	const scheme = /** @type {'mongodb' | 'mongodb+srv'} */ (match[1]);
	const authority = /** @type {string} */ (match[2]);
	const at = authority.lastIndexOf('@');
	const userinfo = at === -1 ? null : authority.slice(0, at);
	const hostPart = at === -1 ? authority : authority.slice(at + 1);
	/** @type {string | null} */
	let username = null;
	let hasPassword = false;
	if (userinfo !== null) {
		const colon = userinfo.indexOf(':');
		const rawUser = colon === -1 ? userinfo : userinfo.slice(0, colon);
		const rawPassword = colon === -1 ? '' : userinfo.slice(colon + 1);
		if (/[@/:]/.test(rawUser) || /[@/]/.test(rawPassword))
			return { ok: false, message: 'user name and password must be percent-encoded' };
		try {
			username = decodeURIComponent(rawUser);
			decodeURIComponent(rawPassword);
		} catch {
			return { ok: false, message: 'user name and password must be percent-encoded' };
		}
		if (username === '') return { ok: false, message: 'user name is empty' };
		hasPassword = rawPassword.length > 0;
	}
	if (hostPart === '') return { ok: false, message: 'a host is required' };
	/** @type {Array<{ host: string, port: number | null }>} */
	const hosts = [];
	for (const entry of hostPart.split(',')) {
		const hostMatch = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(entry);
		if (!hostMatch) return { ok: false, message: 'a host is invalid' };
		const port = hostMatch[2] === undefined ? null : Number(hostMatch[2]);
		if (port !== null && (port < 1 || port > 65535)) return { ok: false, message: 'a port is invalid' };
		hosts.push({ host: /** @type {string} */ (hostMatch[1]).toLowerCase(), port });
	}
	if (scheme === 'mongodb+srv' && (hosts.length !== 1 || hosts[0]?.port !== null))
		return { ok: false, message: 'mongodb+srv:// takes exactly one host without a port' };
	const path = match[3] ?? '';
	/** @type {string | null} */
	let dbName = null;
	if (path.length > 1) {
		try {
			dbName = decodeURIComponent(path.slice(1));
		} catch {
			return { ok: false, message: 'the database name is invalid' };
		}
	}
	return {
		ok: true,
		value: { scheme, username, hasPassword, hosts, dbName, options: new URLSearchParams((match[4] ?? '').slice(1)) },
	};
};

/**
 * @param {URLSearchParams} options
 * @param {string} name lower-case
 * @returns {string | null}
 */
const option = (options, name) => {
	for (const [key, value] of options) if (key.toLowerCase() === name) return value.toLowerCase();
	return null;
};

/**
 * Validate a client database credential `{ uri, dbName? }` semantically.
 * @param {{ uri: string, dbName?: string }} credentials
 * @param {Allowlist} allowlist
 * @returns {{ errors: FieldError[], parsed: ParsedMongoUri | null, dbName: string | null }}
 */
export const checkDatabaseCredentials = (credentials, allowlist) => {
	/** @type {FieldError[]} */
	const errors = [];
	const parsed = parseMongoUri(credentials.uri);
	if (!parsed.ok) return { errors: [{ path: '/credentials/uri', message: parsed.message }], parsed: null, dbName: null };
	const uri = parsed.value;
	const local = uri.hosts.every(({ host }) => isAllowlisted(allowlist, host));
	for (const { host } of uri.hosts) {
		const checked = checkHost(host, allowlist);
		if (!checked.ok)
			errors.push({
				path: '/credentials/uri',
				message: checked.code === 'address_refused' ? 'hosts must be public addresses' : 'a host is invalid',
				code: checked.code,
			});
	}
	for (const [key, value] of uri.options) {
		const name = key.toLowerCase();
		if (!SAFE_OPTIONS.has(name)) errors.push({ path: '/credentials/uri', message: `option ${key} is not allowed` });
		else if (name === 'authmechanism' && !SAFE_MECHANISMS.has(value.toUpperCase()))
			errors.push({ path: '/credentials/uri', message: 'only SCRAM authentication is allowed' });
	}
	const tls = option(uri.options, 'tls') ?? option(uri.options, 'ssl');
	if (!local) {
		if (tls === 'false' || (uri.scheme === 'mongodb' && tls !== 'true'))
			errors.push({ path: '/credentials/uri', message: 'TLS is required (tls=true)', code: 'tls_required' });
		if (uri.username === null || !uri.hasPassword)
			errors.push({ path: '/credentials/uri', message: 'a database user and password are required' });
	}
	const dbName = credentials.dbName ?? uri.dbName;
	if (dbName === null)
		errors.push({ path: '/credentials/dbName', message: 'a database name is required (in the URI path or dbName)' });
	else if (!DB_NAME.test(dbName) || Buffer.byteLength(dbName) > 63)
		errors.push({ path: '/credentials/dbName', message: 'the database name is invalid' });
	else if (RESERVED_DBS.has(dbName.toLowerCase()))
		errors.push({ path: '/credentials/dbName', message: 'admin, local and config cannot be used' });
	return { errors, parsed: uri, dbName };
};
