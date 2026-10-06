/**
 * Typed Portal configuration, validated once at boot. Every problem is collected and reported together (names only,
 * never values), so a misconfigured deployment fails fast and completely.
 *
 * Two sources, both plain:
 * - **Environment** (`loadEnv`): only the database (`MONGODB_URI`) and the asset storage (`STORAGE_*`), plus optional
 *   tuning. The environment comes from `NODE_ENV` (production unless `development` or `test`). Listed in {@link ENV_VARS}.
 * - **System state** (`infra/system.js`, the control database): the secrets generated on first start (signing keys,
 *   website-key signing keys, encryption keys, session secret, key pepper, idempotency secret) and the settings recorded
 *   at `/setup` or by an admin (the Portal URL, the preview URL, the mailer). The Portal URL is never read from request
 *   headers.
 * `buildConfig(env, system)` joins them into the {@link PortalConfig} every module reads.
 * @module
 */
import { hkdfSync } from 'node:crypto';
import { canonicalUrl } from '@ss/protocol';
import { platformError } from './errors.js';

/** @typedef {import('@ss/protocol').PrivateJwk} PrivateJwk */
/** @typedef {'production' | 'development' | 'test'} PortalEnv */

/**
 * @typedef {object} SessionPolicy
 * @property {number} idleMs session ends after this much inactivity
 * @property {number} absoluteMs session ends this long after login, whatever the activity
 */

/**
 * @typedef {object} EnvConfig
 * @property {PortalEnv} env
 * @property {boolean} isProduction
 * @property {string} version
 * @property {{ uri: string, dbName: string, maxPoolSize: number }} mongo control-plane database only
 * @property {string} logLevel
 * @property {boolean} trustProxyHeaders use `X-Forwarded-For` for the client IP (only behind a trusted proxy)
 * @property {number} maxBodyBytes default JSON body cap
 * @property {number} operationDeadlineMs time budget of one on-demand admin operation (bounded, resumable)
 * @property {{ staff: SessionPolicy, merchant: SessionPolicy }} sessions
 * @property {{ allowHosts: ReadonlyArray<string> }} outbound hosts outbound calls may reach although private or
 *   plain http (`OUTBOUND_DEV_ALLOW_HOSTS`; always empty in production)
 * @property {{ storage: AssetStorageConfig | null, budgetKb: number }} delivery platform-owned artefact storage (our
 *   software only: pack assets and compiled website bundles — never client data) and the default website budget
 */

/**
 * The generated secrets and the recorded settings (see `infra/system.js`).
 * @typedef {object} SystemState
 * @property {string | null} portalUrl recorded at `/setup` (null before setup)
 * @property {string | null} previewUrl dedicated cookie-less preview origin (F.16), set by an admin
 * @property {{ host: string, port: number, secure: boolean, user: string | null, pass: string | null, from: string } | null} mail
 * @property {ReadonlyArray<PrivateJwk>} signingKeys first signs; all are published
 * @property {ReadonlyArray<PrivateJwk>} websiteKeySigningKeys first signs; all are published
 * @property {ReadonlyArray<{ id: string, key: Buffer }>} keks first = active
 * @property {Buffer} sessionSecret
 * @property {Buffer} websiteKeyPepper
 * @property {Buffer} idempotencySecret
 */

/**
 * @typedef {object} PortalConfig
 * @property {PortalEnv} env
 * @property {boolean} isProduction
 * @property {string} version
 * @property {boolean} setUp false until `/setup` recorded the Portal URL (then everything but setup is refused)
 * @property {string} portalUrl canonical Portal URL (no trailing slash) — issuer of launches, audience of assertions
 * @property {string} portalOrigin
 * @property {boolean} cookieSecure true unless the Portal runs on plain-http localhost
 * @property {{ uri: string, dbName: string, maxPoolSize: number }} mongo control-plane database only
 * @property {ReadonlyArray<PrivateJwk>} signingKeys first = active signer; all are published in the JWKS
 * @property {ReadonlyArray<PrivateJwk>} websiteKeySigningKeys dedicated website-key signers (first signs; all published)
 * @property {ReadonlyArray<{ id: string, key: Buffer }>} keks key-encryption keys; first = active (wraps new data keys)
 * @property {Buffer} sessionSecret HMAC key for session ids, recovery codes and throttle keys at rest
 * @property {Buffer} websiteKeyPepper HMAC pepper for website secret keys at rest
 * @property {Buffer} idempotencySecret HMAC key of idempotency fingerprints
 * @property {string} problemBaseUri RFC 9457 type base (`<url>/problems/`)
 * @property {string} logLevel
 * @property {boolean} trustProxyHeaders use `X-Forwarded-For` for the client IP (only behind a trusted proxy)
 * @property {number} maxBodyBytes default JSON body cap
 * @property {number} operationDeadlineMs time budget of one on-demand admin operation (bounded, resumable)
 * @property {{ staff: SessionPolicy, merchant: SessionPolicy }} sessions
 * @property {{ allowHosts: ReadonlyArray<string> }} outbound
 * @property {{ smtp: SmtpConfig | null, from: string | null }} mail platform mailer (verify e-mail, resets, invites)
 * @property {{ storage: AssetStorageConfig | null, budgetKb: number, previewOrigin: string | null }} delivery
 *   artefact storage, the default website budget, and the dedicated cookie-less preview origin (F.16) or null
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
 * @property {boolean} secure implicit TLS; otherwise STARTTLS (required in production)
 * @property {string | null} user
 * @property {string | null} pass
 */

/** Documented environment variables: `[name, required, description]`. Nothing else is read. */
export const ENV_VARS = Object.freeze([
	['MONGODB_URI', true, 'Control-plane MongoDB connection string (never a client database).'],
	[
		'STORAGE_ENDPOINT',
		true,
		'Asset storage (pack assets, compiled website bundles): S3-compatible endpoint origin, e.g. https://<account>.r2.cloudflarestorage.com.',
	],
	['STORAGE_BUCKET', true, 'Bucket name.'],
	['STORAGE_ACCESS_KEY_ID', true, 'Access key id, limited to the bucket.'],
	['STORAGE_SECRET_ACCESS_KEY', true, 'Secret access key.'],
	['STORAGE_REGION', false, 'Bucket region (default `auto`).'],
	['STORAGE_PREFIX', false, 'Key prefix inside the bucket, e.g. `portal/`.'],
	['STORAGE_PATH_STYLE', false, '`true` for path-style bucket URLs.'],
	['STORAGE_DIR', false, 'Development only, instead of a bucket: a local directory (e.g. `.data/assets`) or `:memory:`.'],
	['APP_VERSION', false, 'Version reported by /healthz and /v1/system/info (default `dev`).'],
	['MONGODB_DB', false, 'Database name; defaults to the path of MONGODB_URI, else `ss_portal`.'],
	['MONGODB_MAX_POOL_SIZE', false, 'Connection pool size per instance (default 5).'],
	['DELIVERY_BUDGET_KB', false, 'Default per-website bundle budget in KB gzip (default 60).'],
	['TRUST_PROXY_HEADERS', false, '`true` behind a proxy that sets X-Forwarded-For.'],
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

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
const LEVELS = new Set(['debug', 'info', 'warn', 'error', 'silent']);
const HOST_ENTRY = /^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]{1,253}|[0-9a-fA-F:]{2,39})$/;
/** `Name <address>` or `address`. */
export const MAIL_FROM = /^(?:[^<>\r\n]{1,100} <[^\s@<>]{1,64}@[^\s@<>]{1,255}>|[^\s@<>]{1,64}@[^\s@<>]{1,255})$/;

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
 * Derive a 32-byte subkey from a secret (HKDF-SHA-256).
 * @param {Uint8Array} secret
 * @param {string} label
 * @returns {Buffer}
 */
export const deriveSecret = (secret, label) =>
	Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), `ss-derived-secret.v1|${label}`, 32));

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
 * @param {URL} url
 * @returns {boolean}
 */
const isLocal = (url) => LOCAL.has(url.hostname) || url.hostname.endsWith('.localhost');

/**
 * Check a Portal URL candidate (setup, admin settings): an absolute origin-like URL, https unless localhost outside
 * production. Returns the canonical form or an error message.
 * @param {unknown} value
 * @param {{ production: boolean }} options
 * @returns {{ ok: true, url: string } | { ok: false, message: string }}
 */
export const checkPortalUrl = (value, { production }) => {
	try {
		const url = new URL(canonicalUrl(value));
		if (url.pathname !== '/' && url.pathname !== '') return { ok: false, message: 'Enter an origin, without a path.' };
		if (url.protocol !== 'https:' && (production || !isLocal(url)))
			return { ok: false, message: 'The Portal URL must use https (http only for localhost in development).' };
		return { ok: true, url: url.origin };
	} catch {
		return { ok: false, message: 'Enter an absolute https URL without query, fragment or credentials.' };
	}
};

/**
 * Check a preview origin candidate: https (http only for localhost in development), origin only, another host than the
 * Portal's.
 * @param {unknown} value
 * @param {{ production: boolean, portalUrl: string | null }} options
 * @returns {{ ok: true, url: string } | { ok: false, message: string }}
 */
export const checkPreviewUrl = (value, { production, portalUrl }) => {
	try {
		const url = new URL(String(value));
		if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== ''))
			throw new Error('not an origin');
		if (url.protocol !== 'https:' && (production || !isLocal(url) || url.protocol !== 'http:')) throw new Error('scheme');
		if (portalUrl && new URL(portalUrl).host === url.host)
			return { ok: false, message: 'The preview URL must be a different host from the Portal URL.' };
		return { ok: true, url: url.origin };
	} catch {
		return {
			ok: false,
			message: 'The preview URL must be an https origin (scheme and host only; http only for localhost in development).',
		};
	}
};

/**
 * Read and validate the environment. Throws `config_invalid` listing every offending variable (never values).
 * @param {Record<string, string | undefined>} [env]
 * @returns {Readonly<EnvConfig>}
 */
export const loadEnv = (env = process.env) => {
	/** @type {string[]} */
	const problems = [];
	/** @param {string} name */
	const read = (name) => {
		const value = env[name];
		return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
	};

	// Environment: NODE_ENV only — production unless `development` or `test`
	/** @type {PortalEnv} */
	const portalEnv = env.NODE_ENV === 'development' || env.NODE_ENV === 'test' ? env.NODE_ENV : 'production';
	const strict = portalEnv === 'production';

	// Mongo
	const mongoUri = read('MONGODB_URI') ?? '';
	if (!mongoUri) problems.push('MONGODB_URI is required');
	else if (!/^mongodb(\+srv)?:\/\//.test(mongoUri)) problems.push('MONGODB_URI must be a mongodb:// or mongodb+srv:// URI');
	const dbName = read('MONGODB_DB') ?? (mongoUri ? dbNameFromUri(mongoUri) : null) ?? 'ss_portal';
	if (!/^[A-Za-z0-9_-]{1,63}$/.test(dbName)) problems.push('MONGODB_DB is not a valid database name');
	const maxPoolSize = intOf(read('MONGODB_MAX_POOL_SIZE'), 5, { max: 500 });
	if (maxPoolSize === null) problems.push('MONGODB_MAX_POOL_SIZE must be an integer 1..500');

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

	// Delivery: platform-owned artefact storage (never a client connector) and the default website budget
	/** @type {AssetStorageConfig | null} */
	let assetStorage = null;
	try {
		assetStorage = parseAssetStorage(read);
	} catch (error) {
		problems.push(/** @type {Error} */ (error).message);
	}
	// storage is optional: without it the Portal runs and only the delivery routes (website scripts, packs) answer 503
	if (assetStorage && assetStorage.kind !== 's3' && strict)
		problems.push('STORAGE_DIR is for development: use an S3-compatible bucket (STORAGE_BUCKET) in production');
	if (assetStorage?.kind === 's3' && assetStorage.endpoint?.startsWith('http:') && strict)
		problems.push('STORAGE_ENDPOINT must use https in production');
	const budgetKb = intOf(read('DELIVERY_BUDGET_KB'), 60, { min: 1, max: 1024 });
	if (budgetKb === null) problems.push('DELIVERY_BUDGET_KB must be an integer 1..1024');

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
		mongo: Object.freeze({ uri: mongoUri, dbName, maxPoolSize: /** @type {number} */ (maxPoolSize) }),
		logLevel,
		trustProxyHeaders: trustText === 'true',
		maxBodyBytes: /** @type {number} */ (maxBodyBytes),
		operationDeadlineMs: /** @type {number} */ (operationDeadlineMs),
		sessions: Object.freeze(sessions),
		outbound: Object.freeze({ allowHosts: Object.freeze(allowHosts) }),
		delivery: Object.freeze({
			storage: assetStorage ? Object.freeze(assetStorage) : null,
			budgetKb: /** @type {number} */ (budgetKb),
		}),
	});
};

/**
 * Join the environment and the system state into the Portal configuration. Before setup (`portalUrl` null) the
 * configuration carries `setUp: false` and a placeholder URL: the runtime then serves only `/setup`.
 * @param {Readonly<EnvConfig>} envConfig
 * @param {SystemState} system
 * @returns {Readonly<PortalConfig>}
 */
export const buildConfig = (envConfig, system) => {
	/** @type {string[]} */
	const problems = [];
	const production = envConfig.isProduction;
	let portalUrl = 'http://localhost';
	if (system.portalUrl) {
		const checked = checkPortalUrl(system.portalUrl, { production });
		if (checked.ok) portalUrl = checked.url;
		else problems.push(`Portal URL: ${checked.message}`);
	}
	/** @type {string | null} */
	let previewOrigin = null;
	if (system.previewUrl) {
		const checked = checkPreviewUrl(system.previewUrl, { production, portalUrl: system.portalUrl });
		if (checked.ok) previewOrigin = checked.url;
		else problems.push(`Preview URL: ${checked.message}`);
	}
	const mail = system.mail;
	if (mail && !MAIL_FROM.test(mail.from)) problems.push('Mail sender must be `Name <address>` or an address');
	if (system.signingKeys.length === 0 || system.websiteKeySigningKeys.length === 0 || system.keks.length === 0)
		problems.push('system secrets are incomplete');
	if (problems.length > 0) {
		throw platformError('config_invalid', `Invalid Portal configuration: ${problems.join('; ')}`, { problems });
	}
	const url = new URL(portalUrl);
	return Object.freeze({
		...envConfig,
		setUp: Boolean(system.portalUrl),
		portalUrl,
		portalOrigin: url.origin,
		cookieSecure: url.protocol === 'https:',
		signingKeys: Object.freeze([...system.signingKeys]),
		websiteKeySigningKeys: Object.freeze([...system.websiteKeySigningKeys]),
		keks: Object.freeze([...system.keks]),
		sessionSecret: system.sessionSecret,
		websiteKeyPepper: system.websiteKeyPepper,
		idempotencySecret: system.idempotencySecret,
		problemBaseUri: `${portalUrl}/problems/`,
		mail: Object.freeze(
			mail
				? {
						smtp: Object.freeze({
							host: mail.host,
							port: mail.port,
							secure: mail.secure,
							user: mail.user,
							pass: mail.pass,
						}),
						from: mail.from,
					}
				: { smtp: null, from: null },
		),
		delivery: Object.freeze({ ...envConfig.delivery, previewOrigin }),
	});
};

/**
 * `buildConfig(loadEnv(env), system)` in one call (tests, scripts).
 * @param {Record<string, string | undefined>} env
 * @param {SystemState} system
 * @returns {Readonly<PortalConfig>}
 */
export const loadConfig = (env, system) => buildConfig(loadEnv(env), system);
