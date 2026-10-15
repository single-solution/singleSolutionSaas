/**
 * Typed Portal configuration, validated once at boot. Every problem is collected and reported together (names only,
 * never values), so a misconfigured deployment fails fast and completely.
 *
 * Two sources, both plain:
 * - **Environment** (`loadEnv`, PLAN 0.11): the database (`MONGODB_URI`), the Portal's final public address
 *   (`PORTAL_URL`) and the key that encrypts stored secrets (`ENCRYPTION_KEY`, plus the optional
 *   `ENCRYPTION_KEY_PREVIOUS` set only while the owner changes it), listed in `.env.example`. Everything else is a fixed
 *   constant below. The environment comes from `NODE_ENV` (production unless `development` or `test`).
 * - **System state** (`infra/system.js`, the control database): the secrets generated on first start (the Portal
 *   signing keys, the token signing keys, the session secret and the idempotency secret) and the settings an Owner
 *   records (email sending, branding, support contact, security, billing rules).
 * The Portal's address is `PORTAL_URL` and nothing else: never the request's Host or forwarded headers (PLAN 0.8.1).
 * `buildConfig(env, system)` joins them into the {@link PortalConfig} every module reads.
 * @module
 */
import { mongoDatabaseName } from '@ss/net';
import { platformError } from './errors.js';

/** @typedef {import('@ss/protocol').PrivateJwk} PrivateJwk */
/** @typedef {'production' | 'development' | 'test'} PortalEnv */

/**
 * @typedef {object} EnvConfig
 * @property {PortalEnv} env
 * @property {boolean} isProduction
 * @property {string} portalUrl `PORTAL_URL`: scheme + host (+ port), no path and no trailing slash
 * @property {string} encryptionKey `ENCRYPTION_KEY` (at least 32 characters; encrypts stored secrets, PLAN 0.4.8)
 * @property {string | null} previousEncryptionKey `ENCRYPTION_KEY_PREVIOUS`: the old key while the owner changes
 *   `ENCRYPTION_KEY` (values it sealed keep opening until Settings → Encryption key → Re-seal), else null
 * @property {{ uri: string, dbName: string, maxPoolSize: number }} mongo control-plane database only
 * @property {string} logLevel
 * @property {number} maxBodyBytes default JSON body cap
 * @property {{ allowHosts: ReadonlyArray<string> }} outbound hosts outbound calls may reach although private or
 *   plain http: the loopback hosts outside production (local products), none in production
 */

/**
 * The generated secrets and the recorded settings (see `infra/system.js`).
 * @typedef {object} SystemState
 * @property {{ host: string, port: number, secure: boolean, user: string | null, pass: string | null, from: string } | null} mail
 * @property {{ [K in keyof PortalSettings]?: Partial<PortalSettings[K]> }} [settings] Owner-recorded settings (defaults
 *   when absent)
 * @property {ReadonlyArray<PrivateJwk>} signingKeys first signs; all are published
 * @property {ReadonlyArray<PrivateJwk>} tokenSigningKeys first signs browser and server tokens; all are published
 * @property {{ signing: ReadonlyArray<import('@ss/protocol').PublicJwk>, token: ReadonlyArray<import('@ss/protocol').PublicJwk> }} [publishedOnly]
 *   public keys of stored signing keys whose seed no longer opens (`ENCRYPTION_KEY` lost): published, never signing
 * @property {Buffer} sessionSecret
 * @property {Buffer} idempotencySecret
 */

/**
 * Settings an Owner records in Settings (PLAN 0.8.2), with their defaults.
 * @typedef {object} PortalSettings
 * @property {{ sessionHours: number, requireTwoStepForAdmins: boolean }} security
 * @property {{ name: string, accent: string, hasLogo: boolean, logoVersion: number }} branding
 * @property {{ email: string | null, phone: string | null, whatsapp: string | null }} support
 * @property {{ graceDays: number, lowBalanceDays: number }} billing
 */

/**
 * @typedef {object} PortalConfig
 * @property {PortalEnv} env
 * @property {boolean} isProduction
 * @property {string} portalUrl `PORTAL_URL` (no trailing slash) — issuer of launches, audience of assertions, base of
 *   links, the only origin the CSRF check accepts
 * @property {boolean} cookieSecure true when `PORTAL_URL` is https
 * @property {string} encryptionKey `ENCRYPTION_KEY`
 * @property {string | null} previousEncryptionKey `ENCRYPTION_KEY_PREVIOUS` (null when not set)
 * @property {PortalSettings} settings
 * @property {{ uri: string, dbName: string, maxPoolSize: number }} mongo control-plane database only

 * @property {ReadonlyArray<PrivateJwk>} signingKeys first = active signer; all are published in the JWKS
 * @property {ReadonlyArray<PrivateJwk>} tokenSigningKeys dedicated token signers (first signs; all published)
 * @property {{ signing: ReadonlyArray<import('@ss/protocol').PublicJwk>, token: ReadonlyArray<import('@ss/protocol').PublicJwk> }} publishedOnly
 *   public keys published without a signer (stored keys whose seed no longer opens)
 * @property {Buffer} sessionSecret HMAC key for session ids, recovery codes and throttle keys at rest
 * @property {Buffer} idempotencySecret HMAC key of idempotency fingerprints
 * @property {string} problemBaseUri RFC 9457 type base (`<url>/problems/`)
 * @property {string} logLevel
 * @property {number} maxBodyBytes default JSON body cap
 * @property {number} sessionMs how long a sign-in lasts, admins and merchants alike (Settings → Security → Session length)
 * @property {{ allowHosts: ReadonlyArray<string> }} outbound
 * @property {{ smtp: SmtpConfig | null, from: string | null }} mail platform mailer (verify email, resets, invites)
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
const MONGO_POOL_SIZE = 5;
/** Default request body cap (1 MiB). */
const MAX_BODY_BYTES = 1024 * 1024;
/** Settings bounds and defaults (PLAN 0.5.4, 0.8.2). */
export const SETTINGS_BOUNDS = Object.freeze({
	sessionHours: Object.freeze({ min: 1, max: 336, default: 12 }),
	graceDays: Object.freeze({ min: 0, max: 30, default: 3 }),
	lowBalanceDays: Object.freeze({ min: 1, max: 30, default: 3 }),
});

/** Logo file types (never SVG) and size cap (PLAN 0.8.2 Branding). */
export const LOGO_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
export const LOGO_MAX_BYTES = 200 * 1024;

/**
 * The address of the Branding logo (it changes with each new logo, so caches never show an old one), or null.
 * @param {string} portalUrl
 * @param {{ hasLogo: boolean, logoVersion: number }} branding
 */
export const logoUrlOf = (portalUrl, branding) =>
	branding.hasLogo ? `${portalUrl}/branding/logo?v=${branding.logoVersion}` : null;

/** @type {Readonly<PortalSettings>} */
export const DEFAULT_SETTINGS = Object.freeze({
	security: Object.freeze({ sessionHours: SETTINGS_BOUNDS.sessionHours.default, requireTwoStepForAdmins: false }),
	branding: Object.freeze({ name: 'Single Solution', accent: '#4f46e5', hasLogo: false, logoVersion: 0 }),
	support: Object.freeze({ email: null, phone: null, whatsapp: null }),
	billing: Object.freeze({
		graceDays: SETTINGS_BOUNDS.graceDays.default,
		lowBalanceDays: SETTINGS_BOUNDS.lowBalanceDays.default,
	}),
});

const LEVELS = new Set(['debug', 'info', 'warn', 'error', 'silent']);
/** Hosts outbound calls may reach over loopback and plain http outside production (products run locally). */
const LOCAL_OUTBOUND_HOSTS = Object.freeze(['localhost', '127.0.0.1', '::1']);
/** `Name <address>` or `address`. */
export const MAIL_FROM = /^(?:[^<>\r\n]{1,100} <[^\s@<>]{1,64}@[^\s@<>]{1,255}>|[^\s@<>]{1,64}@[^\s@<>]{1,255})$/;

const LOCAL_HOST = /^(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.localhost|127\.0\.0\.1|\[::1\])$/;

/**
 * Validate `PORTAL_URL` (PLAN 0.11): an http(s) origin with nothing after it; https unless a local host outside
 * production. Returns the origin or a message naming the variable.
 * @param {string | undefined} raw
 * @param {boolean} production
 * @returns {{ ok: true, value: string } | { ok: false, message: string }}
 */
export const parsePortalUrl = (raw, production) => {
	// tolerate surrounding spaces and one trailing slash, the common copy-paste slips
	const text = raw?.trim().replace(/\/$/, '');
	if (!text) return { ok: false, message: 'PORTAL_URL is required' };
	/** @type {URL | null} */
	let url = null;
	try {
		url = new URL(text);
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
		url.pathname !== '/' ||
		text.endsWith('/') ||
		text.includes('?') ||
		text.includes('#')
	)
		return { ok: false, message: 'PORTAL_URL must be scheme + host (+ port), with no path and no trailing slash' };
	if (url.protocol === 'http:' && (production || !LOCAL_HOST.test(url.hostname)))
		return { ok: false, message: 'PORTAL_URL must use https (http only for a local host in development and tests)' };
	return { ok: true, value: url.origin };
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
	const dbName = (mongoUri ? mongoDatabaseName(mongoUri) : null) ?? 'ss_portal';
	if (!/^[A-Za-z0-9_-]{1,63}$/.test(dbName)) problems.push('MONGODB_URI names an invalid database');

	// The Portal's address and the key of stored secrets (PLAN 0.11)
	const portalUrl = parsePortalUrl(read('PORTAL_URL'), strict);
	if (!portalUrl.ok) problems.push(portalUrl.message);
	const encryptionKey = read('ENCRYPTION_KEY') ?? '';
	if (!encryptionKey) problems.push('ENCRYPTION_KEY is required');
	else if (encryptionKey.length < 32) problems.push('ENCRYPTION_KEY must be at least 32 characters');
	const previousEncryptionKey = read('ENCRYPTION_KEY_PREVIOUS') ?? null;
	if (previousEncryptionKey !== null && previousEncryptionKey.length < 32)
		problems.push('ENCRYPTION_KEY_PREVIOUS must be at least 32 characters');

	// Log level: info, debug in development; the optional LOG_LEVEL (`.env.example`) overrides it
	const logLevel = read('LOG_LEVEL') ?? (portalEnv === 'development' ? 'debug' : 'info');
	if (!LEVELS.has(logLevel)) problems.push('LOG_LEVEL must be debug, info, warn, error or silent');
	if (problems.length > 0) {
		throw platformError('config_invalid', `Invalid Portal configuration: ${problems.join('; ')}`, { problems });
	}
	return Object.freeze({
		env: portalEnv,
		isProduction: portalEnv === 'production',
		portalUrl: portalUrl.ok ? portalUrl.value : '',
		encryptionKey,
		previousEncryptionKey,
		mongo: Object.freeze({ uri: mongoUri, dbName, maxPoolSize: MONGO_POOL_SIZE }),
		logLevel,
		maxBodyBytes: MAX_BODY_BYTES,
		outbound: Object.freeze({ allowHosts: portalEnv === 'production' ? Object.freeze([]) : LOCAL_OUTBOUND_HOSTS }),
	});
};

/**
 * The recorded settings merged over their defaults.
 * @param {{ [K in keyof PortalSettings]?: Partial<PortalSettings[K]> } | null | undefined} settings
 * @returns {PortalSettings}
 */
const settingsWithDefaults = (settings) => ({
	security: { ...DEFAULT_SETTINGS.security, ...(settings?.security ?? {}) },
	branding: { ...DEFAULT_SETTINGS.branding, ...(settings?.branding ?? {}) },
	support: { ...DEFAULT_SETTINGS.support, ...(settings?.support ?? {}) },
	billing: { ...DEFAULT_SETTINGS.billing, ...(settings?.billing ?? {}) },
});

/**
 * Join the environment and the system state into the Portal configuration.
 * @param {Readonly<EnvConfig>} envConfig
 * @param {SystemState} system
 * @param {{ overrides?: Partial<PortalConfig> }} [options] `overrides`: fixed values replaced (tests)
 * @returns {Readonly<PortalConfig>}
 */
export const buildConfig = (envConfig, system, { overrides = {} } = {}) => {
	/** @type {string[]} */
	const problems = [];
	const mail = system.mail;
	if (mail && !MAIL_FROM.test(mail.from)) problems.push('Mail sender must be `Name <address>` or an address');
	if (system.signingKeys.length === 0 || system.tokenSigningKeys.length === 0) problems.push('system secrets are incomplete');
	if (problems.length > 0) {
		throw platformError('config_invalid', `Invalid Portal configuration: ${problems.join('; ')}`, { problems });
	}
	const settings = settingsWithDefaults(system.settings);
	const config = {
		...envConfig,
		cookieSecure: envConfig.portalUrl.startsWith('https:'),
		settings,
		sessionMs: settings.security.sessionHours * 3_600_000,
		signingKeys: Object.freeze([...system.signingKeys]),
		tokenSigningKeys: Object.freeze([...system.tokenSigningKeys]),
		publishedOnly: Object.freeze({
			signing: Object.freeze([...(system.publishedOnly?.signing ?? [])]),
			token: Object.freeze([...(system.publishedOnly?.token ?? [])]),
		}),
		sessionSecret: system.sessionSecret,
		idempotencySecret: system.idempotencySecret,
		problemBaseUri: `${envConfig.portalUrl}/problems/`,
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
		...overrides,
	};
	return /** @type {Readonly<PortalConfig>} */ (Object.freeze(config));
};

/**
 * `buildConfig(loadEnv(env), system)` in one call (tests, scripts).
 * @param {Record<string, string | undefined>} env
 * @param {SystemState} system
 * @param {{ overrides?: Partial<PortalConfig> }} [options]
 * @returns {Readonly<PortalConfig>}
 */
export const loadConfig = (env, system, options) => buildConfig(loadEnv(env), system, options);
