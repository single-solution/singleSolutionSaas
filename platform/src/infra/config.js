/**
 * Typed Portal configuration from environment variables, validated once at boot. Every problem is collected and
 * reported together (names only, never values), so a misconfigured deployment fails fast and completely.
 * Every value is a plain string (no JSON) and nothing depends on the host. The environment comes from `NODE_ENV` only
 * (production unless `development` or `test`); the canonical URL from `PUBLIC_URL` (development default
 * `http://localhost:4000`) — never from request headers. The variables are documented in `platform/README.md` and listed
 * in {@link ENV_VARS}.
 * @module
 */
import { hkdfSync } from 'node:crypto';
import { canonicalUrl, parseSigningKeys as parseKeyList, signingKeyFromSeed } from '@ss/protocol';
import { platformError } from './errors.js';

/** @typedef {import('@ss/protocol').PrivateJwk} PrivateJwk */
/** @typedef {'production' | 'development' | 'test'} PortalEnv */

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
 * @property {ReadonlyArray<PrivateJwk>} websiteKeySigningKeys dedicated website-key signers (first signs; all published)
 * @property {boolean} websiteKeySigningDerived true when no `WEBSITE_SIGNING_KEYS` was given outside production and
 *   the key was derived from `SESSION_SECRET` (development convenience only)
 * @property {ReadonlyArray<{ id: string, key: Buffer }>} keks key-encryption keys; first = active (wraps new data keys)
 * @property {Buffer} sessionSecret HMAC key for session ids, recovery codes and throttle keys at rest
 * @property {Buffer} websiteKeyPepper HMAC pepper for website secret keys at rest
 * @property {Buffer} idempotencySecret HMAC key of idempotency fingerprints (`IDEMPOTENCY_SECRET` or derived)
 * @property {string} problemBaseUri RFC 9457 type base (`<url>/problems/`)
 * @property {string} logLevel
 * @property {boolean} trustProxyHeaders use `X-Forwarded-For` for the client IP (only behind a trusted proxy)
 * @property {number} maxBodyBytes default JSON body cap
 * @property {number} operationDeadlineMs time budget of one on-demand admin operation (bounded, resumable)
 * @property {{ staff: SessionPolicy, merchant: SessionPolicy }} sessions
 * @property {{ allowHosts: ReadonlyArray<string> }} outbound hosts outbound calls may reach although private or
 *   plain http (`OUTBOUND_DEV_ALLOW_HOSTS`; always empty in production)
 * @property {{ smtp: SmtpConfig | null, from: string | null }} mail platform mailer (verify e-mail, resets, invites)
 * @property {{ storage: AssetStorageConfig | null, budgetKb: number, previewOrigin: string | null }} delivery
 *   platform-owned artefact storage (our software only: pack assets and compiled website bundles — never client data),
 *   the default website budget, and the dedicated cookie-less preview origin (`PREVIEW_URL`, F.16) or null
 */

/**
 * Asset storage (`STORAGE_*`): an S3-compatible bucket we own, or a development store (`STORAGE_DIR`).
 * @typedef {{ kind: 'memory' } | { kind: 'file', dir: string } | { kind: 's3', endpoint: string | null, region: string,
 *   bucket: string, accessKeyId: string, secretAccessKey: string, sessionToken: string | null, forcePathStyle: boolean | null,
 *   prefix: string }} AssetStorageConfig
 */

/**
 * @typedef {object} SmtpConfig
 * @property {string} host
 * @property {number} port
 * @property {boolean} secure implicit TLS (`smtps://`); otherwise STARTTLS (required in production)
 * @property {string | null} user
 * @property {string | null} pass
 */

/** Documented environment variables: `[name, required, description]`. */
export const ENV_VARS = Object.freeze([
	['MONGODB_URI', true, 'Control-plane MongoDB connection string (never a client database).'],
	[
		'SIGNING_KEYS',
		true,
		'Portal signing keys `kid:seed[,kid:seed…]` (seed = base64url of 32 bytes, Ed25519); the first signs, all are published.',
	],
	[
		'WEBSITE_SIGNING_KEYS',
		true,
		'Website-key signing keys, same `kid:seed` form, kids and keys distinct from SIGNING_KEYS (derived from SESSION_SECRET outside production).',
	],
	['ENCRYPTION_KEYS', true, 'Key-encryption keys `kid:base64(32 bytes)[,kid:base64…]`, first = active.'],
	['SESSION_SECRET', true, 'At least 32 bytes (base64 or text): HMAC key for session ids and recovery codes at rest.'],
	[
		'KEY_PEPPER',
		true,
		'At least 32 bytes (base64 or text), different from SESSION_SECRET: HMAC pepper for website secret keys.',
	],
	[
		'PUBLIC_URL',
		true,
		'The Portal address, e.g. https://portal.example.com: token issuer/audience, e-mail links, CSRF origin (development default http://localhost:4000).',
	],
	['SMTP_URL', false, 'Mailer `smtp(s)://user:pass@host:port` (STARTTLS required in production for smtp://).'],
	['MAIL_FROM', false, 'Sender of Portal mail, `Name <address>` or `address` (required with SMTP_URL).'],
	['STORAGE_BUCKET', false, 'Asset storage (pack assets, compiled website bundles): S3-compatible bucket name.'],
	['STORAGE_ENDPOINT', false, 'S3-compatible endpoint origin, e.g. https://<account>.r2.cloudflarestorage.com (default AWS).'],
	['STORAGE_REGION', false, 'Bucket region (default `auto`).'],
	['STORAGE_ACCESS_KEY_ID', false, 'Bucket access key id (required with STORAGE_BUCKET).'],
	['STORAGE_SECRET_ACCESS_KEY', false, 'Bucket secret access key (required with STORAGE_BUCKET).'],
	['STORAGE_PREFIX', false, 'Key prefix inside the bucket, e.g. `portal/`.'],
	['STORAGE_PATH_STYLE', false, '`true` for path-style bucket URLs (default: virtual-hosted on AWS, path-style elsewhere).'],
	['STORAGE_DIR', false, 'Development only: a local directory for assets (e.g. `.data/assets`), or `:memory:`.'],
	[
		'PREVIEW_URL',
		false,
		'Dedicated cookie-less origin serving only the preview proxy (`/p/*`), on another host than the Portal (ideally another registrable domain).',
	],
	['APP_VERSION', false, 'Version reported by /healthz and /v1/system/info (default `dev`).'],
	[
		'IDEMPOTENCY_SECRET',
		false,
		'At least 32 bytes: HMAC key of idempotency fingerprints (default: derived from SESSION_SECRET).',
	],
	['MONGODB_DB', false, 'Database name; defaults to the path of MONGODB_URI, else `ss_portal`.'],
	['MONGODB_MAX_POOL_SIZE', false, 'Connection pool size per instance (default 5).'],
	['DELIVERY_BUDGET_KB', false, 'Default per-website bundle budget in KB gzip (default 60).'],
	['TRUST_PROXY_HEADERS', false, '`true` behind a proxy that sets X-Forwarded-For (e.g. the hosting edge).'],
	['MAX_BODY_BYTES', false, 'Default request body cap in bytes (default 1048576).'],
	['OPERATION_DEADLINE_MS', false, 'Time budget of one on-demand admin operation in ms (default 50000).'],
	['STAFF_SESSION_IDLE_MINUTES', false, 'Staff idle timeout (default 30).'],
	['STAFF_SESSION_MAX_HOURS', false, 'Staff absolute session lifetime (default 12).'],
	['MERCHANT_SESSION_IDLE_MINUTES', false, 'Merchant idle timeout (default 1440).'],
	['MERCHANT_SESSION_MAX_HOURS', false, 'Merchant absolute session lifetime (default 336).'],
	[
		'OUTBOUND_DEV_ALLOW_HOSTS',
		false,
		'Development only: comma-separated hosts/IPs outbound calls may reach although private or plain http.',
	],
]);

const KID = /^[A-Za-z0-9._-]{1,64}$/;
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
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
 * Parse `ENCRYPTION_KEYS`.
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
 * Parse `SIGNING_KEYS` / `WEBSITE_SIGNING_KEYS` (`kid:seed[,kid:seed…]`); null when invalid.
 * @param {string} text
 * @returns {PrivateJwk[] | null}
 */
export const parseSigningKeys = (text) => {
	try {
		return parseKeyList(text);
	} catch {
		return null;
	}
};

/**
 * Deterministic Ed25519 key from a secret (HKDF-SHA-256, labelled), for development website-key signing when
 * `WEBSITE_SIGNING_KEYS` is not set. Never used in production.
 * @param {Uint8Array} secret
 * @param {string} label
 * @returns {PrivateJwk}
 */
export const deriveSigningKey = (secret, label) => {
	const seed = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), `ss-derived-ed25519.v1|${label}`, 32));
	const key = signingKeyFromSeed(label, seed);
	return signingKeyFromSeed(`${label}-${key.x.slice(0, 8)}`, seed);
};

/**
 * Derive a 32-byte subkey from a secret (HKDF-SHA-256).
 * @param {Uint8Array} secret
 * @param {string} label
 * @returns {Buffer}
 */
export const deriveSecret = (secret, label) =>
	Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), `ss-derived-secret.v1|${label}`, 32));

const MAIL_FROM = /^(?:[^<>\r\n]{1,100} <[^\s@<>]{1,64}@[^\s@<>]{1,255}>|[^\s@<>]{1,64}@[^\s@<>]{1,255})$/;
const HOST_ENTRY = /^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]{1,253}|[0-9a-fA-F:]{2,39})$/;

/**
 * Parse `SMTP_URL`.
 * @param {string} text
 * @returns {SmtpConfig | null}
 */
export const parseSmtpUrl = (text) => {
	/** @type {URL} */
	let url;
	try {
		url = new URL(text);
	} catch {
		return null;
	}
	if ((url.protocol !== 'smtp:' && url.protocol !== 'smtps:') || !url.hostname) return null;
	if ((url.pathname && url.pathname !== '/') || url.search || url.hash) return null;
	const secure = url.protocol === 'smtps:';
	try {
		return {
			host: url.hostname.replace(/^\[|\]$/g, ''),
			port: url.port ? Number(url.port) : secure ? 465 : 587,
			secure,
			user: url.username ? decodeURIComponent(url.username) : null,
			pass: url.password ? decodeURIComponent(url.password) : null,
		};
	} catch {
		return null;
	}
};

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{1,40}$/;
const PREFIX = /^(?:[A-Za-z0-9_-]+\/)*$/;

/**
 * Read asset storage from `STORAGE_*` (null when none is configured). Throws a message naming the variable when invalid.
 * @param {(name: string) => string | undefined} read
 * @returns {AssetStorageConfig | null}
 */
export const parseAssetStorage = (read) => {
	const dir = read('STORAGE_DIR');
	const bucket = read('STORAGE_BUCKET');
	if (dir !== undefined && bucket !== undefined) throw new Error('set either STORAGE_DIR or STORAGE_BUCKET, not both');
	if (dir !== undefined) {
		if (dir === ':memory:') return { kind: 'memory' };
		if (dir.includes('\0')) throw new Error('STORAGE_DIR is not a valid directory');
		return { kind: 'file', dir };
	}
	if (bucket === undefined) {
		const stray = ['STORAGE_ENDPOINT', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY', 'STORAGE_PREFIX'].find(
			(name) => read(name) !== undefined,
		);
		if (stray) throw new Error(`${stray} needs STORAGE_BUCKET`);
		return null;
	}
	if (!BUCKET.test(bucket)) throw new Error('STORAGE_BUCKET is not a valid bucket name');
	const region = read('STORAGE_REGION') ?? 'auto';
	if (!REGION.test(region)) throw new Error('STORAGE_REGION is not a valid region');
	const accessKeyId = read('STORAGE_ACCESS_KEY_ID');
	const secretAccessKey = read('STORAGE_SECRET_ACCESS_KEY');
	if (!accessKeyId || accessKeyId.length > 2048) throw new Error('STORAGE_ACCESS_KEY_ID is required with STORAGE_BUCKET');
	if (!secretAccessKey || secretAccessKey.length > 2048)
		throw new Error('STORAGE_SECRET_ACCESS_KEY is required with STORAGE_BUCKET');
	const prefix = read('STORAGE_PREFIX') ?? '';
	if (prefix.length > 200 || !PREFIX.test(prefix)) throw new Error('STORAGE_PREFIX must be path segments ending in /');
	const pathStyle = read('STORAGE_PATH_STYLE');
	if (pathStyle !== undefined && pathStyle !== 'true' && pathStyle !== 'false')
		throw new Error('STORAGE_PATH_STYLE must be true or false');
	const endpointText = read('STORAGE_ENDPOINT');
	/** @type {string | null} */
	let endpoint = null;
	if (endpointText !== undefined) {
		/** @type {URL | null} */
		let url = null;
		try {
			url = new URL(endpointText);
		} catch {
			// reported below
		}
		if (
			!url ||
			(url.protocol !== 'https:' && url.protocol !== 'http:') ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			(url.pathname !== '/' && url.pathname !== '')
		)
			throw new Error('STORAGE_ENDPOINT must be an http(s) origin');
		endpoint = url.origin;
	}
	return {
		kind: 's3',
		endpoint,
		region,
		bucket,
		accessKeyId,
		secretAccessKey,
		sessionToken: null,
		forcePathStyle: pathStyle === undefined ? null : pathStyle === 'true',
		prefix,
	};
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

	// Environment: NODE_ENV only — production unless `development` or `test`
	/** @type {PortalEnv} */
	const portalEnv = env.NODE_ENV === 'development' || env.NODE_ENV === 'test' ? env.NODE_ENV : 'production';
	const strict = portalEnv === 'production';

	// Canonical URL: PUBLIC_URL (development default localhost); never derived from request headers
	const portalUrlText = read('PUBLIC_URL') ?? (strict ? undefined : 'http://localhost:4000');
	if (portalUrlText === undefined) problems.push('PUBLIC_URL is required in production (e.g. https://portal.example.com)');
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
				problems.push('PUBLIC_URL must use https (http only for localhost in development)');
			cookieSecure = url.protocol === 'https:';
		} catch {
			problems.push('PUBLIC_URL must be an absolute http(s) URL without query, fragment or credentials');
		}
	}

	// Mongo
	const mongoUri = required('MONGODB_URI');
	if (mongoUri && !/^mongodb(\+srv)?:\/\//.test(mongoUri))
		problems.push('MONGODB_URI must be a mongodb:// or mongodb+srv:// URI');
	const dbName = read('MONGODB_DB') ?? (mongoUri ? dbNameFromUri(mongoUri) : null) ?? 'ss_portal';
	if (!/^[A-Za-z0-9_-]{1,63}$/.test(dbName)) problems.push('MONGODB_DB is not a valid database name');
	const maxPoolSize = intOf(read('MONGODB_MAX_POOL_SIZE'), 5, { max: 500 });
	if (maxPoolSize === null) problems.push('MONGODB_MAX_POOL_SIZE must be an integer 1..500');

	// Keys and secrets
	const signingText = required('SIGNING_KEYS');
	const signingKeys = signingText ? parseSigningKeys(signingText) : null;
	if (signingText && !signingKeys)
		problems.push('SIGNING_KEYS must be `kid:seed` entries (seed = base64url of 32 bytes) with unique kids');
	const kekText = required('ENCRYPTION_KEYS');
	const keks = kekText ? parseKeks(kekText) : null;
	if (kekText && !keks)
		problems.push('ENCRYPTION_KEYS must be `kid:base64` entries of exactly 32 bytes with unique kids (or one bare base64 key)');
	const sessionText = required('SESSION_SECRET');
	const sessionSecret = sessionText ? secretBytes(sessionText, 32) : null;
	if (sessionText && !sessionSecret) problems.push('SESSION_SECRET must be at least 32 bytes');
	const pepperText = required('KEY_PEPPER');
	const websiteKeyPepper = pepperText ? secretBytes(pepperText, 32) : null;
	if (pepperText && !websiteKeyPepper) problems.push('KEY_PEPPER must be at least 32 bytes');
	if (sessionSecret && websiteKeyPepper && sessionSecret.equals(websiteKeyPepper)) {
		problems.push('SESSION_SECRET and KEY_PEPPER must differ');
	}

	// Website-key signer (dedicated: never the Portal launch/document key)
	const websiteText = read('WEBSITE_SIGNING_KEYS');
	/** @type {PrivateJwk[] | null} */
	let websiteKeySigningKeys = null;
	if (websiteText) {
		websiteKeySigningKeys = parseSigningKeys(websiteText);
		if (!websiteKeySigningKeys)
			problems.push('WEBSITE_SIGNING_KEYS must be `kid:seed` entries (seed = base64url of 32 bytes) with unique kids');
	} else if (portalEnv === 'production') problems.push('WEBSITE_SIGNING_KEYS is required in production');
	else if (sessionSecret) websiteKeySigningKeys = [deriveSigningKey(sessionSecret, 'website-dev')];
	if (websiteKeySigningKeys && signingKeys) {
		const portalKids = new Set(signingKeys.map((k) => k.kid));
		const portalXs = new Set(signingKeys.map((k) => k.x));
		if (websiteKeySigningKeys.some((k) => portalKids.has(k.kid) || portalXs.has(k.x)))
			problems.push('WEBSITE_SIGNING_KEYS must use keys and kids distinct from SIGNING_KEYS');
	}

	// Idempotency fingerprints
	const idempotencyText = read('IDEMPOTENCY_SECRET');
	/** @type {Buffer | null} */
	let idempotencySecret = null;
	if (idempotencyText) {
		idempotencySecret = secretBytes(idempotencyText, 32);
		if (!idempotencySecret) problems.push('IDEMPOTENCY_SECRET must be at least 32 bytes');
	} else if (sessionSecret) idempotencySecret = deriveSecret(sessionSecret, 'idempotency');

	// Outbound development allowlist (never in production)
	const allowText = read('OUTBOUND_DEV_ALLOW_HOSTS');
	const allowHosts =
		allowText && portalEnv !== 'production'
			? allowText
					.split(',')
					.map((entry) => entry.trim().toLowerCase())
					.filter(Boolean)
			: [];
	if (allowHosts.some((entry) => !HOST_ENTRY.test(entry)))
		problems.push('OUTBOUND_DEV_ALLOW_HOSTS must be comma-separated host names or IP addresses');

	// Platform mailer
	const smtpText = read('SMTP_URL');
	const smtp = smtpText ? parseSmtpUrl(smtpText) : null;
	if (smtpText && !smtp) problems.push('SMTP_URL must be smtp://user:pass@host:port or smtps://user:pass@host:port');
	const mailFrom = read('MAIL_FROM') ?? null;
	if (mailFrom !== null && !MAIL_FROM.test(mailFrom)) problems.push('MAIL_FROM must be `Name <address>` or an address');
	if (smtpText && mailFrom === null) problems.push('MAIL_FROM is required with SMTP_URL');

	// Delivery: platform-owned artefact storage (never a client connector) and the default website budget
	/** @type {AssetStorageConfig | null} */
	let assetStorage = null;
	try {
		assetStorage = parseAssetStorage(read);
	} catch (error) {
		problems.push(/** @type {Error} */ (error).message);
	}
	if (assetStorage && assetStorage.kind !== 's3' && strict)
		problems.push('STORAGE_DIR is for development: use an S3-compatible bucket (STORAGE_BUCKET) in production');
	if (assetStorage?.kind === 's3' && assetStorage.endpoint?.startsWith('http:') && strict)
		problems.push('STORAGE_ENDPOINT must use https in production');
	const budgetKb = intOf(read('DELIVERY_BUDGET_KB'), 60, { min: 1, max: 1024 });
	if (budgetKb === null) problems.push('DELIVERY_BUDGET_KB must be an integer 1..1024');
	const previewText = read('PREVIEW_URL');
	/** @type {string | null} */
	let previewOrigin = null;
	if (previewText) {
		try {
			const url = new URL(previewText);
			const local = LOCAL.has(url.hostname) || url.hostname.endsWith('.localhost');
			if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== ''))
				throw new Error('not an origin');
			if (url.protocol !== 'https:' && (strict || !local || url.protocol !== 'http:')) throw new Error('scheme');
			previewOrigin = url.origin;
			if (portalOrigin && new URL(portalOrigin).host === url.host)
				problems.push('PREVIEW_URL must be a different host from PUBLIC_URL');
		} catch {
			problems.push('PREVIEW_URL must be an https origin (scheme and host only; http only for localhost in development)');
		}
	}

	// Problems base, from the canonical URL
	const problemBaseUri = portalUrl ? `${portalUrl}/problems/` : '';

	// Log level: info in production, debug in development (LOG_LEVEL overrides, undocumented)
	const logLevel = read('LOG_LEVEL') ?? (portalEnv === 'development' ? 'debug' : 'info');
	if (!LEVELS.has(logLevel)) problems.push('LOG_LEVEL must be debug, info, warn, error or silent');
	const trustText = read('TRUST_PROXY_HEADERS') ?? 'false';
	if (trustText !== 'true' && trustText !== 'false') problems.push('TRUST_PROXY_HEADERS must be true or false');
	const maxBodyBytes = intOf(read('MAX_BODY_BYTES'), 1024 * 1024, { min: 1024, max: 50 * 1024 * 1024 });
	if (maxBodyBytes === null) problems.push('MAX_BODY_BYTES must be an integer 1024..52428800');
	const operationDeadlineMs = intOf(read('OPERATION_DEADLINE_MS'), 50_000, { min: 1000, max: 900_000 });
	if (operationDeadlineMs === null) problems.push('OPERATION_DEADLINE_MS must be an integer 1000..900000');

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
		version: read('APP_VERSION') ?? 'dev',
		portalUrl,
		portalOrigin,
		cookieSecure,
		mongo: Object.freeze({ uri: mongoUri, dbName, maxPoolSize: /** @type {number} */ (maxPoolSize) }),
		signingKeys: Object.freeze(/** @type {PrivateJwk[]} */ (signingKeys)),
		keks: Object.freeze(/** @type {Array<{ id: string, key: Buffer }>} */ (keks)),
		sessionSecret: /** @type {Buffer} */ (sessionSecret),
		websiteKeyPepper: /** @type {Buffer} */ (websiteKeyPepper),
		websiteKeySigningKeys: Object.freeze(/** @type {PrivateJwk[]} */ (websiteKeySigningKeys)),
		websiteKeySigningDerived: !websiteText,
		idempotencySecret: /** @type {Buffer} */ (idempotencySecret),
		problemBaseUri,
		logLevel,
		trustProxyHeaders: trustText === 'true',
		maxBodyBytes: /** @type {number} */ (maxBodyBytes),
		operationDeadlineMs: /** @type {number} */ (operationDeadlineMs),
		sessions: Object.freeze(sessions),
		outbound: Object.freeze({ allowHosts: Object.freeze(allowHosts) }),
		mail: Object.freeze({ smtp: smtp ? Object.freeze(smtp) : null, from: mailFrom }),
		delivery: Object.freeze({
			storage: assetStorage ? Object.freeze(assetStorage) : null,
			budgetKb: /** @type {number} */ (budgetKb),
			previewOrigin,
		}),
	});
};
