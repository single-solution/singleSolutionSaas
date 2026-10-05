/**
 * MongoDB connection-string safety (pure). Only `mongodb://` and `mongodb+srv://` are accepted; every host must pass
 * the outbound policy (`checkHost`); only a known-safe set of URI options is allowed — anything that makes the client
 * read local files (`tlsCAFile`, …), weaken TLS (`tlsInsecure`, `tlsAllowInvalidCertificates`, …), go through a proxy
 * (`proxyHost`, …) or use ambient cloud credentials (`MONGODB-AWS`, `MONGODB-OIDC`, `authMechanismProperties`) is
 * refused; TLS is required unless every host is allowlisted.
 *
 * Connect with `{ lookup: guardedLookup(policy) }` as well: SRV answers and every replica-set member discovered later
 * are then vetted at connect time too.
 * @module
 */
import { checkHost } from './policy.js';

/** @typedef {import('./policy.js').OutboundPolicy} OutboundPolicy */

/**
 * @typedef {object} ParsedMongoUri
 * @property {'mongodb' | 'mongodb+srv'} scheme
 * @property {string | null} username decoded
 * @property {boolean} hasPassword
 * @property {Array<{ host: string, port: number | null }>} hosts
 * @property {string | null} dbName decoded, from the path
 * @property {URLSearchParams} options
 */

/**
 * @typedef {{ ok: true, value: ParsedMongoUri, tls: boolean, allowlisted: boolean }
 *   | { ok: false, code: 'bad_url' | 'ssrf_blocked' | 'unsafe_option' | 'tls_required', reason: string }} MongoUriCheck
 */

/** URI options (lower-cased) a connection string may carry. */
export const SAFE_MONGO_OPTIONS = Object.freeze(
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
const OPTIONS = new Set(SAFE_MONGO_OPTIONS);

/**
 * Parse a MongoDB connection string without contacting anything.
 * @param {unknown} uri
 * @returns {{ ok: true, value: ParsedMongoUri } | { ok: false, reason: string }}
 */
export const parseMongoUri = (uri) => {
	if (typeof uri !== 'string' || uri.length > 4096) return { ok: false, reason: 'invalid_uri' };
	const match = /^(mongodb(?:\+srv)?):\/\/([^/?#]*)(\/[^?#]*)?(\?[^#]*)?$/.exec(uri);
	if (!match) return { ok: false, reason: 'unsupported_scheme' };
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
		if (/[@/:]/.test(rawUser) || /[@/]/.test(rawPassword)) return { ok: false, reason: 'userinfo_not_encoded' };
		try {
			username = decodeURIComponent(rawUser);
			decodeURIComponent(rawPassword);
		} catch {
			return { ok: false, reason: 'userinfo_not_encoded' };
		}
		if (username === '') return { ok: false, reason: 'empty_username' };
		hasPassword = rawPassword.length > 0;
	}
	if (hostPart === '') return { ok: false, reason: 'missing_host' };
	/** @type {Array<{ host: string, port: number | null }>} */
	const hosts = [];
	for (const entry of hostPart.split(',')) {
		const hostMatch = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(entry);
		if (!hostMatch) return { ok: false, reason: 'invalid_host' };
		const port = hostMatch[2] === undefined ? null : Number(hostMatch[2]);
		if (port !== null && (port < 1 || port > 65_535)) return { ok: false, reason: 'invalid_port' };
		hosts.push({ host: /** @type {string} */ (hostMatch[1]).toLowerCase(), port });
	}
	if (scheme === 'mongodb+srv' && (hosts.length !== 1 || hosts[0]?.port !== null))
		return { ok: false, reason: 'srv_single_host' };
	const path = match[3] ?? '';
	/** @type {string | null} */
	let dbName = null;
	if (path.length > 1) {
		try {
			dbName = decodeURIComponent(path.slice(1));
		} catch {
			return { ok: false, reason: 'invalid_db_name' };
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
 * @returns {string | null} lower-cased value of the last occurrence
 */
const option = (options, name) => {
	/** @type {string | null} */
	let out = null;
	for (const [key, value] of options) if (key.toLowerCase() === name) out = value.toLowerCase();
	return out;
};

/**
 * Check that a MongoDB connection string is safe to connect to under the policy.
 * @param {unknown} uri
 * @param {OutboundPolicy} policy
 * @returns {MongoUriCheck}
 */
export const isSafeMongoUri = (uri, policy) => {
	const parsed = parseMongoUri(uri);
	if (!parsed.ok) return { ok: false, code: 'bad_url', reason: parsed.reason };
	const value = parsed.value;
	let allowlisted = true;
	for (const { host } of value.hosts) {
		const checked = checkHost(host, policy);
		if (!checked.ok) return { ok: false, code: checked.code, reason: checked.reason };
		allowlisted = allowlisted && checked.allowlisted;
	}
	for (const [key, raw] of value.options) {
		const name = key.toLowerCase();
		if (!OPTIONS.has(name)) return { ok: false, code: 'unsafe_option', reason: `option_${name}` };
		if (name === 'authmechanism' && !SAFE_MECHANISMS.has(raw.toUpperCase()))
			return { ok: false, code: 'unsafe_option', reason: 'auth_mechanism' };
	}
	const tlsOption = option(value.options, 'tls') ?? option(value.options, 'ssl');
	const tls = tlsOption === 'true' || (value.scheme === 'mongodb+srv' && tlsOption !== 'false');
	if (!tls && !allowlisted) return { ok: false, code: 'tls_required', reason: 'tls_required' };
	return { ok: true, value, tls, allowlisted };
};
