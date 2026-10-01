/**
 * Typed Portal configuration from environment variables, validated once at boot. Every problem is collected and
 * reported together (names only, never values), so a misconfigured deployment fails fast and completely.
 * Nothing here has a default host: every URL comes from the environment. The variables are documented in
 * `platform/README.md` and listed in {@link ENV_VARS}.
 * @module
 */
import { canonicalUrl, toPublicJwk } from '@ss/protocol';
import { platformError } from './errors.js';
import { isObject } from './util.js';

/** @typedef {import('@ss/protocol').PrivateJwk} PrivateJwk */
/** @typedef {'production' | 'preview' | 'development' | 'test'} PortalEnv */

/**
 * @typedef {object} SessionPolicy
 * @property {number} idleMs session ends after this much inactivity
 * @property {number} absoluteMs session ends this long after login, whatever the activity
 */

/**
 * @typedef {object} PortalConfig
 * @property {PortalEnv} env
 * @property {boolean} isProduction
 * @property {string} version
 * @property {string} portalUrl canonical Portal URL (no trailing slash) — issuer of launches, audience of assertions
 * @property {string} portalOrigin
 * @property {boolean} cookieSecure true unless the Portal runs on plain-http localhost
 * @property {{ uri: string, dbName: string, maxPoolSize: number }} mongo control-plane database only
 * @property {ReadonlyArray<PrivateJwk>} signingKeys first = active signer; all are published in the JWKS
 * @property {ReadonlyArray<{ id: string, key: Buffer }>} keks key-encryption keys; first = active (wraps new data keys)
 * @property {Buffer} sessionSecret HMAC key for session ids, recovery codes and throttle keys at rest
 * @property {Buffer} websiteKeyPepper HMAC pepper for website secret keys at rest
 * @property {string} cronSecret bearer secret for `/api/cron/*`
 * @property {string} problemBaseUri RFC 9457 type base
 * @property {string} logLevel
 * @property {boolean} trustProxyHeaders use `X-Forwarded-For` for the client IP (only behind a trusted proxy)
 * @property {number} maxBodyBytes default JSON body cap
 * @property {number} cronDeadlineMs time budget of one cron invocation
 * @property {{ staff: SessionPolicy, merchant: SessionPolicy }} sessions
 */

/** Documented environment variables: `[name, required, description]`. */
export const ENV_VARS = Object.freeze([
	['MONGODB_URI', true, 'Control-plane MongoDB connection string (never a client database).'],
	['MONGODB_DB', false, 'Database name; defaults to the path of MONGODB_URI, else `ss_portal`.'],
	['MONGODB_MAX_POOL_SIZE', false, 'Connection pool size per instance (default 10).'],
	['PORTAL_URL', true, 'Canonical Portal URL, e.g. https://portal.example.com (https unless localhost in development).'],
	['PORTAL_SIGNING_KEYS', true, 'JSON array of private Ed25519 JWKs with unique kids; the first signs, all are published.'],
	['SECRETS_KEK', true, 'Key-encryption keys: `kid:base64(32 bytes)[,kid:base64…]`, first = active; or one bare base64 key.'],
	['SESSION_SECRET', true, 'At least 32 bytes (base64 or text): HMAC key for session ids and recovery codes at rest.'],
	['WEBSITE_KEY_PEPPER', true, 'At least 32 bytes (base64 or text): HMAC pepper for website secret keys at rest.'],
	['CRON_SECRET', true, 'At least 32 characters; cron routes require `Authorization: Bearer <CRON_SECRET>`.'],
	['PROBLEM_BASE_URI', false, 'RFC 9457 problem type base URI (default `<PORTAL_URL>/problems/`).'],
	['PORTAL_ENV', false, 'production | preview | development | test (default from NODE_ENV).'],
	['PORTAL_VERSION', false, 'Version string reported by /healthz and /v1/system/info (default `dev`).'],
	['LOG_LEVEL', false, 'debug | info | warn | error | silent (default info).'],
	['TRUST_PROXY_HEADERS', false, '`true` behind a proxy that sets X-Forwarded-For (e.g. the hosting edge).'],
	['MAX_BODY_BYTES', false, 'Default request body cap in bytes (default 1048576).'],
	['CRON_DEADLINE_MS', false, 'Time budget per cron invocation in ms (default 50000; keep below the function limit).'],
	['STAFF_SESSION_IDLE_MINUTES', false, 'Staff idle timeout (default 30).'],
	['STAFF_SESSION_MAX_HOURS', false, 'Staff absolute session lifetime (default 12).'],
	['MERCHANT_SESSION_IDLE_MINUTES', false, 'Merchant idle timeout (default 1440).'],
	['MERCHANT_SESSION_MAX_HOURS', false, 'Merchant absolute session lifetime (default 336).'],
]);

const KID = /^[A-Za-z0-9._-]{1,64}$/;
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
const ENVS = new Set(['production', 'preview', 'development', 'test']);
const LEVELS = new Set(['debug', 'info', 'warn', 'error', 'silent']);

/**
 * Decode base64 / base64url; null when the text is not valid base64.
 * @param {string} text
 * @returns {Buffer | null}
 */
const decodeBase64 = (text) => {
	const trimmed = text.trim();
	if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) return null;
	const bytes = Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
	return bytes.length > 0 ? bytes : null;
};

/**
 * A secret of at least `min` bytes given as base64 (preferred) or raw text.
 * @param {string} text
 * @param {number} min
 * @returns {Buffer | null}
 */
const secretBytes = (text, min) => {
	const decoded = decodeBase64(text);
	if (decoded && decoded.length >= min) return decoded;
	const raw = Buffer.from(text, 'utf8');
	return raw.length >= min ? raw : null;
};

/**
 * @param {string} uri
 * @returns {string | null}
 */
const dbNameFromUri = (uri) => {
	const match = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/.exec(uri);
	const name = match?.[1] ? decodeURIComponent(match[1]) : '';
	return name.length > 0 ? name : null;
};

/**
 * Parse `SECRETS_KEK`.
 * @param {string} text
 * @returns {Array<{ id: string, key: Buffer }> | null}
 */
export const parseKeks = (text) => {
	const entries = text
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean);
	if (entries.length === 0) return null;
	/** @type {Array<{ id: string, key: Buffer }>} */
	const out = [];
	for (const entry of entries) {
		const colon = entry.indexOf(':');
		const id = colon === -1 ? (entries.length === 1 ? 'k1' : '') : entry.slice(0, colon);
		const key = decodeBase64(colon === -1 ? entry : entry.slice(colon + 1));
		if (!KID.test(id) || !key || key.length !== 32 || out.some((k) => k.id === id)) return null;
		out.push({ id, key });
	}
	return out;
};

/**
 * Parse `PORTAL_SIGNING_KEYS`.
 * @param {string} text
 * @returns {PrivateJwk[] | null}
 */
export const parseSigningKeys = (text) => {
	/** @type {unknown} */
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed) || parsed.length === 0) return null;
	/** @type {PrivateJwk[]} */
	const keys = [];
	for (const jwk of parsed) {
		if (!isObject(jwk) || typeof jwk.d !== 'string' || jwk.d.length === 0) return null;
		try {
			const pub = toPublicJwk(jwk);
			if (keys.some((k) => k.kid === pub.kid)) return null;
			keys.push({ ...pub, d: jwk.d });
		} catch {
			return null;
		}
	}
	return keys;
};

/**
 * @param {string | undefined} text
 * @param {number} fallback
 * @param {{ min?: number, max?: number }} [bounds]
 * @returns {number | null}
 */
const intOf = (text, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
	if (text === undefined || text === '') return fallback;
	if (!/^\d{1,15}$/.test(text)) return null;
	const n = Number(text);
	return n >= min && n <= max ? n : null;
};

/**
 * Load and validate the configuration. Throws `config_invalid` listing every offending variable (never values).
 * @param {Record<string, string | undefined>} [env]
 * @returns {Readonly<PortalConfig>}
 */
export const loadConfig = (env = process.env) => {
	/** @type {string[]} */
	const problems = [];
	/** @param {string} name */
	const read = (name) => {
		const value = env[name];
		return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
	};
	/**
	 * @param {string} name
	 * @returns {string}
	 */
	const required = (name) => {
		const value = read(name);
		if (value === undefined) problems.push(`${name} is required`);
		return value ?? '';
	};

	const portalEnvText =
		read('PORTAL_ENV') ?? (env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development');
	if (!ENVS.has(portalEnvText)) problems.push('PORTAL_ENV must be production, preview, development or test');
	const portalEnv = /** @type {PortalEnv} */ (ENVS.has(portalEnvText) ? portalEnvText : 'production');
	const strict = portalEnv === 'production' || portalEnv === 'preview';

	// Portal URL
	const portalUrlText = required('PORTAL_URL');
	let portalUrl = '';
	let portalOrigin = '';
	let cookieSecure = true;
	if (portalUrlText) {
		try {
			portalUrl = canonicalUrl(portalUrlText);
			const url = new URL(portalUrl);
			portalOrigin = url.origin;
			const local = LOCAL.has(url.hostname) || url.hostname.endsWith('.localhost');
			if (url.protocol !== 'https:' && (strict || !local))
				problems.push('PORTAL_URL must use https (http only for localhost in development)');
			cookieSecure = url.protocol === 'https:';
		} catch {
			problems.push('PORTAL_URL must be an absolute http(s) URL without query, fragment or credentials');
		}
	}

	// Mongo
	const mongoUri = required('MONGODB_URI');
	if (mongoUri && !/^mongodb(\+srv)?:\/\//.test(mongoUri))
		problems.push('MONGODB_URI must be a mongodb:// or mongodb+srv:// URI');
	const dbName = read('MONGODB_DB') ?? (mongoUri ? dbNameFromUri(mongoUri) : null) ?? 'ss_portal';
	if (!/^[A-Za-z0-9_-]{1,63}$/.test(dbName)) problems.push('MONGODB_DB is not a valid database name');
	const maxPoolSize = intOf(read('MONGODB_MAX_POOL_SIZE'), 10, { max: 500 });
	if (maxPoolSize === null) problems.push('MONGODB_MAX_POOL_SIZE must be an integer 1..500');

	// Keys and secrets
	const signingText = required('PORTAL_SIGNING_KEYS');
	const signingKeys = signingText ? parseSigningKeys(signingText) : null;
	if (signingText && !signingKeys) {
		problems.push(
			'PORTAL_SIGNING_KEYS must be a JSON array of private Ed25519 JWKs (kty OKP, crv Ed25519, x, d, kid) with unique kids',
		);
	}
	const kekText = required('SECRETS_KEK');
	const keks = kekText ? parseKeks(kekText) : null;
	if (kekText && !keks)
		problems.push('SECRETS_KEK must be `kid:base64` entries of exactly 32 bytes with unique kids (or one bare base64 key)');
	const sessionText = required('SESSION_SECRET');
	const sessionSecret = sessionText ? secretBytes(sessionText, 32) : null;
	if (sessionText && !sessionSecret) problems.push('SESSION_SECRET must be at least 32 bytes');
	const pepperText = required('WEBSITE_KEY_PEPPER');
	const websiteKeyPepper = pepperText ? secretBytes(pepperText, 32) : null;
	if (pepperText && !websiteKeyPepper) problems.push('WEBSITE_KEY_PEPPER must be at least 32 bytes');
	if (sessionSecret && websiteKeyPepper && sessionSecret.equals(websiteKeyPepper)) {
		problems.push('SESSION_SECRET and WEBSITE_KEY_PEPPER must differ');
	}
	const cronSecret = required('CRON_SECRET');
	if (cronSecret && cronSecret.length < 32) problems.push('CRON_SECRET must be at least 32 characters');

	// Problems base
	let problemBaseUri = read('PROBLEM_BASE_URI') ?? (portalUrl ? `${portalUrl}/problems/` : '');
	try {
		if (problemBaseUri) {
			const url = new URL(problemBaseUri);
			if (url.search || url.hash) throw new Error('query');
			problemBaseUri = url.href.endsWith('/') ? url.href : `${url.href}/`;
		}
	} catch {
		problems.push('PROBLEM_BASE_URI must be an absolute URI without query or fragment');
	}

	const logLevel = read('LOG_LEVEL') ?? 'info';
	if (!LEVELS.has(logLevel)) problems.push('LOG_LEVEL must be debug, info, warn, error or silent');
	const trustText = read('TRUST_PROXY_HEADERS') ?? 'false';
	if (trustText !== 'true' && trustText !== 'false') problems.push('TRUST_PROXY_HEADERS must be true or false');
	const maxBodyBytes = intOf(read('MAX_BODY_BYTES'), 1024 * 1024, { min: 1024, max: 50 * 1024 * 1024 });
	if (maxBodyBytes === null) problems.push('MAX_BODY_BYTES must be an integer 1024..52428800');
	const cronDeadlineMs = intOf(read('CRON_DEADLINE_MS'), 50_000, { min: 1000, max: 900_000 });
	if (cronDeadlineMs === null) problems.push('CRON_DEADLINE_MS must be an integer 1000..900000');

	/**
	 * @param {string} name
	 * @param {number} fallback
	 * @param {number} unitMs
	 */
	const duration = (name, fallback, unitMs) => {
		const n = intOf(read(name), fallback, { max: 100_000 });
		if (n === null) problems.push(`${name} must be a positive integer`);
		return (n ?? fallback) * unitMs;
	};
	const sessions = {
		staff: {
			idleMs: duration('STAFF_SESSION_IDLE_MINUTES', 30, 60_000),
			absoluteMs: duration('STAFF_SESSION_MAX_HOURS', 12, 3_600_000),
		},
		merchant: {
			idleMs: duration('MERCHANT_SESSION_IDLE_MINUTES', 1440, 60_000),
			absoluteMs: duration('MERCHANT_SESSION_MAX_HOURS', 336, 3_600_000),
		},
	};
	for (const [who, policy] of Object.entries(sessions)) {
		if (policy.idleMs > policy.absoluteMs)
			problems.push(`${who.toUpperCase()} session idle timeout must not exceed the absolute lifetime`);
	}

	if (problems.length > 0) {
		throw platformError('config_invalid', `Invalid Portal configuration: ${problems.join('; ')}`, { problems });
	}
	return Object.freeze({
		env: portalEnv,
		isProduction: portalEnv === 'production',
		version: read('PORTAL_VERSION') ?? 'dev',
		portalUrl,
		portalOrigin,
		cookieSecure,
		mongo: Object.freeze({ uri: mongoUri, dbName, maxPoolSize: /** @type {number} */ (maxPoolSize) }),
		signingKeys: Object.freeze(/** @type {PrivateJwk[]} */ (signingKeys)),
		keks: Object.freeze(/** @type {Array<{ id: string, key: Buffer }>} */ (keks)),
		sessionSecret: /** @type {Buffer} */ (sessionSecret),
		websiteKeyPepper: /** @type {Buffer} */ (websiteKeyPepper),
		cronSecret,
		problemBaseUri,
		logLevel,
		trustProxyHeaders: trustText === 'true',
		maxBodyBytes: /** @type {number} */ (maxBodyBytes),
		cronDeadlineMs: /** @type {number} */ (cronDeadlineMs),
		sessions: Object.freeze(sessions),
	});
};
