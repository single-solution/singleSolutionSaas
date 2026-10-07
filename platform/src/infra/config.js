/**
 * Typed Portal configuration, validated once at boot. Every problem is collected and reported together (names only,
 * never values), so a misconfigured deployment fails fast and completely.
 *
 * Two sources, both plain:
 * - **Environment** (`loadEnv`, PLAN 0.11): the database (`MONGODB_URI`), the Portal's final public address
 *   (`PORTAL_URL`) and the key that encrypts stored secrets (`ENCRYPTION_KEY`). Everything else is a fixed constant
 *   below. The environment comes from `NODE_ENV` (production unless `development` or `test`). Listed in
 *   {@link ENV_VARS}.
 * - **System state** (`infra/system.js`, the control database): the secrets generated on first start (the Portal
 *   signing keys, the token signing keys, the session secret and the idempotency secret) and the settings an Owner
 *   records (e-mail sending, branding, support contact, security, billing rules).
 * The Portal's address is `PORTAL_URL` and nothing else: never the request's Host or forwarded headers (PLAN 0.8.1).
 * `buildConfig(env, system)` joins them into the {@link PortalConfig} every module reads.
 * @module
 */
import { hkdfSync } from 'node:crypto';
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
 * @property {string} portalUrl `PORTAL_URL`: scheme + host (+ port), no path and no trailing slash
 * @property {string} encryptionKey `ENCRYPTION_KEY` (at least 32 characters; encrypts stored secrets, PLAN 0.4.8)
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
 * @property {string} portalOrigin same as `portalUrl`
 * @property {boolean} cookieSecure true when `PORTAL_URL` is https
 * @property {string} encryptionKey `ENCRYPTION_KEY`
 * @property {PortalSettings} settings
 * @property {{ uri: string, dbName: string, maxPoolSize: number }} mongo control-plane database only

 * @property {ReadonlyArray<PrivateJwk>} signingKeys first = active signer; all are published in the JWKS
 * @property {ReadonlyArray<PrivateJwk>} tokenSigningKeys dedicated token signers (first signs; all published)
 * @property {Buffer} sessionSecret HMAC key for session ids, recovery codes and throttle keys at rest
 * @property {Buffer} idempotencySecret HMAC key of idempotency fingerprints
 * @property {string} problemBaseUri RFC 9457 type base (`<url>/problems/`)
 * @property {string} logLevel
 * @property {number} maxBodyBytes default JSON body cap
 * @property {{ admin: SessionPolicy, merchant: SessionPolicy }} sessions from Settings → Security → Session length
 * @property {{ allowHosts: ReadonlyArray<string> }} outbound
 * @property {{ smtp: SmtpConfig | null, from: string | null }} mail platform mailer (verify e-mail, resets, invites)
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
/** Settings bounds and defaults (PLAN 0.5.4, 0.8.2). */
export const SETTINGS_BOUNDS = Object.freeze({
	sessionHours: Object.freeze({ min: 1, max: 336, default: 12 }),
	graceDays: Object.freeze({ min: 0, max: 30, default: 3 }),
	lowBalanceDays: Object.freeze({ min: 1, max: 30, default: 3 }),
});

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

/**
 * Session lifetimes from Settings → Security → Session length: one absolute lifetime from sign-in, the same for admins
 * and merchants, with no separate idle timeout (PLAN 0.2).
 * @param {number} hours
 * @returns {{ admin: SessionPolicy, merchant: SessionPolicy }}
 */
export const sessionPolicies = (hours) => {
	const ms = hours * 3_600_000;
	const policy = Object.freeze({ idleMs: ms, absoluteMs: ms });
	return Object.freeze({ admin: policy, merchant: policy });
};

/** Session lifetimes with the default Session length. */
export const SESSIONS = sessionPolicies(SETTINGS_BOUNDS.sessionHours.default);

/** Documented environment variables: `[name, required, description]`. Nothing else is read. */
export const ENV_VARS = Object.freeze([
	['MONGODB_URI', true, 'Control-plane MongoDB connection string (never a client database).'],
	[
		'PORTAL_URL',
		true,
		"The Portal's final public address, scheme + host (+ port), no path and no trailing slash. https is required, except for localhost, *.localhost, 127.0.0.1 and [::1] in development and tests.",
	],
	['ENCRYPTION_KEY', true, "Random, at least 32 characters. Encrypts the Portal's stored secrets."],
]);

const LEVELS = new Set(['debug', 'info', 'warn', 'error', 'silent']);
/** Hosts outbound calls may reach over loopback and plain http outside production (products run locally). */
export const LOCAL_OUTBOUND_HOSTS = Object.freeze(['localhost', '127.0.0.1', '::1']);
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

const LOCAL_HOST = /^(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.localhost|127\.0\.0\.1|\[::1\])$/;

/**
 * Validate `PORTAL_URL` (PLAN 0.11): an http(s) origin with nothing after it; https unless a local host outside
 * production. Returns the origin or a message naming the variable.
 * @param {string | undefined} text
 * @param {boolean} production
 * @returns {{ ok: true, value: string } | { ok: false, message: string }}
 */
export const parsePortalUrl = (text, production) => {
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
 * Derive a 32-byte subkey from a secret (HKDF-SHA-256).
 * @param {Uint8Array} secret
 * @param {string} label
 * @returns {Buffer}
 */
export const deriveSecret = (secret, label) =>
	Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), `ss-derived-secret.v1|${label}`, 32));

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

	// The Portal's address and the key of stored secrets (PLAN 0.11)
	const portalUrl = parsePortalUrl(read('PORTAL_URL'), strict);
	if (!portalUrl.ok) problems.push(portalUrl.message);
	const encryptionKey = read('ENCRYPTION_KEY') ?? '';
	if (!encryptionKey) problems.push('ENCRYPTION_KEY is required');
	else if (encryptionKey.length < 32) problems.push('ENCRYPTION_KEY must be at least 32 characters');

	// Log level: info in production, debug in development (LOG_LEVEL overrides, undocumented)
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
export const settingsWithDefaults = (settings) => ({
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
		portalOrigin: envConfig.portalUrl,
		cookieSecure: envConfig.portalUrl.startsWith('https:'),
		settings,
		sessions: sessionPolicies(settings.security.sessionHours),
		signingKeys: Object.freeze([...system.signingKeys]),
		tokenSigningKeys: Object.freeze([...system.tokenSigningKeys]),
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
