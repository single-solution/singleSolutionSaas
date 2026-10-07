/**
 * Typed Portal configuration, validated once at boot. Every problem is collected and reported together (names only,
 * never values), so a misconfigured deployment fails fast and completely.
 *
 * Two sources, both plain:
 * - **Environment** (`loadEnv`): the database (`MONGODB_URI`) and the optional asset storage (`STORAGE_*`). Everything
 *   else is a fixed constant below. The environment comes from `NODE_ENV` (production unless `development` or
 *   `test`). Listed in {@link ENV_VARS}.
 * - **System state** (`infra/system.js`, the control database): the secrets generated on first start (signing keys,
 *   website-key signing keys, encryption keys, session secret, key pepper, idempotency secret) and the mailer an admin
 *   sets.
 * The Portal's own address is never stored: `portalUrl`, `portalOrigin` and `cookieSecure` read the current request's
 * origin (`request-scope.js`), and fall back to `baseUrl` outside a request (scripts, tests).
 * `buildConfig(env, system)` joins them into the {@link PortalConfig} every module reads.
 * @module
 */
import { hkdfSync } from 'node:crypto';
import { platformError } from './errors.js';
import { currentOrigin } from './request-scope.js';

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
 * @property {{ uri: string, dbName: string, maxPoolSize: number }} mongo control-plane database only
 * @property {string} logLevel
 * @property {number} maxBodyBytes default JSON body cap
 * @property {{ staff: SessionPolicy, merchant: SessionPolicy }} sessions
 * @property {{ allowHosts: ReadonlyArray<string> }} outbound hosts outbound calls may reach although private or
 *   plain http (`OUTBOUND_DEV_ALLOW_HOSTS`; always empty in production)
 * @property {{ storage: AssetStorageConfig | null }} delivery platform-owned artefact storage (our software only: pack
 *   assets and compiled website bundles — never client data)
 */

/**
 * The generated secrets and the recorded settings (see `infra/system.js`).
 * @typedef {object} SystemState
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
 * @property {string} portalUrl the current request's origin (no trailing slash) — issuer of launches, audience of
 *   assertions, base of links
 * @property {string} portalOrigin same as `portalUrl`
 * @property {boolean} cookieSecure true unless the request came over plain http
 * @property {{ uri: string, dbName: string, maxPoolSize: number }} mongo control-plane database only

 * @property {ReadonlyArray<PrivateJwk>} signingKeys first = active signer; all are published in the JWKS
 * @property {ReadonlyArray<PrivateJwk>} websiteKeySigningKeys dedicated website-key signers (first signs; all published)
 * @property {ReadonlyArray<{ id: string, key: Buffer }>} keks key-encryption keys; first = active (wraps new data keys)
 * @property {Buffer} sessionSecret HMAC key for session ids, recovery codes and throttle keys at rest
 * @property {Buffer} websiteKeyPepper HMAC pepper for website secret keys at rest
 * @property {Buffer} idempotencySecret HMAC key of idempotency fingerprints
 * @property {string} problemBaseUri RFC 9457 type base (`<url>/problems/`)
 * @property {string} logLevel
 * @property {number} maxBodyBytes default JSON body cap
 * @property {{ staff: SessionPolicy, merchant: SessionPolicy }} sessions
 * @property {{ allowHosts: ReadonlyArray<string> }} outbound
 * @property {{ smtp: SmtpConfig | null, from: string | null }} mail platform mailer (verify e-mail, resets, invites)
 * @property {{ storage: AssetStorageConfig | null }} delivery artefact storage
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

/** Control-plane connection pool per instance. */
export const MONGO_POOL_SIZE = 5;
/** Default request body cap (1 MiB). */
export const MAX_BODY_BYTES = 1024 * 1024;
/** Session lifetimes: idle timeout and absolute lifetime. */
export const SESSIONS = Object.freeze({
	staff: Object.freeze({ idleMs: 30 * 60_000, absoluteMs: 12 * 3_600_000 }),
	merchant: Object.freeze({ idleMs: 1440 * 60_000, absoluteMs: 336 * 3_600_000 }),
});

/** Documented environment variables: `[name, required, description]`. Nothing else is read. */
export const ENV_VARS = Object.freeze([
	['MONGODB_URI', true, 'Control-plane MongoDB connection string (never a client database).'],
	[
		'STORAGE_ENDPOINT',
		false,
		'Asset storage (pack assets, compiled website bundles): S3-compatible endpoint origin, e.g. https://<account>.r2.cloudflarestorage.com.',
	],
	['STORAGE_BUCKET', false, 'Bucket name.'],
	['STORAGE_ACCESS_KEY_ID', false, 'Access key id, limited to the bucket.'],
	['STORAGE_SECRET_ACCESS_KEY', false, 'Secret access key.'],
	['STORAGE_REGION', false, 'Bucket region (default `auto`).'],
	['STORAGE_PREFIX', false, 'Key prefix inside the bucket, e.g. `portal/`.'],
	['STORAGE_PATH_STYLE', false, '`true` for path-style bucket URLs.'],
	['STORAGE_DIR', false, 'Development only, instead of a bucket: a local directory (e.g. `.data/assets`) or `:memory:`.'],
	[
		'OUTBOUND_DEV_ALLOW_HOSTS',
		false,
		'Development only: comma-separated hosts/IPs outbound calls may reach although private or plain http.',
	],
]);

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

	// Mongo (the database is the path of MONGODB_URI, else `ss_portal`)
	const mongoUri = read('MONGODB_URI') ?? '';
	if (!mongoUri) problems.push('MONGODB_URI is required');
	else if (!/^mongodb(\+srv)?:\/\//.test(mongoUri)) problems.push('MONGODB_URI must be a mongodb:// or mongodb+srv:// URI');
	const dbName = (mongoUri ? dbNameFromUri(mongoUri) : null) ?? 'ss_portal';
	if (!/^[A-Za-z0-9_-]{1,63}$/.test(dbName)) problems.push('MONGODB_URI names an invalid database');

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

	// Delivery: platform-owned artefact storage (never a client connector)
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
	// Log level: info in production, debug in development (LOG_LEVEL overrides, undocumented)
	const logLevel = read('LOG_LEVEL') ?? (portalEnv === 'development' ? 'debug' : 'info');
	if (!LEVELS.has(logLevel)) problems.push('LOG_LEVEL must be debug, info, warn, error or silent');
	if (problems.length > 0) {
		throw platformError('config_invalid', `Invalid Portal configuration: ${problems.join('; ')}`, { problems });
	}
	return Object.freeze({
		env: portalEnv,
		isProduction: portalEnv === 'production',
		mongo: Object.freeze({ uri: mongoUri, dbName, maxPoolSize: MONGO_POOL_SIZE }),
		logLevel,
		maxBodyBytes: MAX_BODY_BYTES,
		sessions: SESSIONS,
		outbound: Object.freeze({ allowHosts: Object.freeze(allowHosts) }),
		delivery: Object.freeze({
			storage: assetStorage ? Object.freeze(assetStorage) : null,
		}),
	});
};

/**
 * Join the environment and the system state into the Portal configuration. `portalUrl`, `portalOrigin` and
 * `cookieSecure` are read per request (the request's own origin); `baseUrl` answers outside a request.
 * @param {Readonly<EnvConfig>} envConfig
 * @param {SystemState} system
 * @param {{ baseUrl?: string, overrides?: Partial<EnvConfig> }} [options] `overrides`: fixed values replaced (tests)
 * @returns {Readonly<PortalConfig>}
 */
export const buildConfig = (envConfig, system, { baseUrl = 'http://localhost', overrides = {} } = {}) => {
	/** @type {string[]} */
	const problems = [];
	const mail = system.mail;
	if (mail && !MAIL_FROM.test(mail.from)) problems.push('Mail sender must be `Name <address>` or an address');
	if (system.signingKeys.length === 0 || system.websiteKeySigningKeys.length === 0 || system.keks.length === 0)
		problems.push('system secrets are incomplete');
	if (problems.length > 0) {
		throw platformError('config_invalid', `Invalid Portal configuration: ${problems.join('; ')}`, { problems });
	}
	const fallback = new URL(baseUrl).origin;
	const origin = () => currentOrigin() ?? fallback;
	const config = {
		...envConfig,
		signingKeys: Object.freeze([...system.signingKeys]),
		websiteKeySigningKeys: Object.freeze([...system.websiteKeySigningKeys]),
		keks: Object.freeze([...system.keks]),
		sessionSecret: system.sessionSecret,
		websiteKeyPepper: system.websiteKeyPepper,
		idempotencySecret: system.idempotencySecret,
		problemBaseUri: `${fallback}/problems/`,
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
		delivery: envConfig.delivery,
		...overrides,
	};
	Object.defineProperties(config, {
		portalUrl: { get: origin, enumerable: true },
		portalOrigin: { get: origin, enumerable: true },
		cookieSecure: { get: () => origin().startsWith('https:'), enumerable: true },
	});
	return /** @type {Readonly<PortalConfig>} */ (Object.freeze(config));
};

/**
 * `buildConfig(loadEnv(env), system)` in one call (tests, scripts).
 * @param {Record<string, string | undefined>} env
 * @param {SystemState} system
 * @param {{ baseUrl?: string, overrides?: Partial<EnvConfig> }} [options]
 * @returns {Readonly<PortalConfig>}
 */
export const loadConfig = (env, system, options) => buildConfig(loadEnv(env), system, options);
