/**
 * Platform adapter: builds the app-kit product from the environment (`configFromEnv`: SS_PORTAL_URL, SS_APP_ID,
 * SS_APP_SIGNING_KEY, SS_REGISTRATION_TOKEN_HASH, SS_PRODUCT_DB_URI, SS_LOG_LEVEL, SS_OUTBOUND_ALLOW_HOSTS; plus
 * SIGNUPS_SEAL_SECRET, SIGNUPS_SEAL_SECRET_PREVIOUS and CRON_SECRET) and the project files (manifest with feature
 * schemas inlined, string catalogs). This is the only place that reads the environment.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { configFromEnv, createLogger, createMongoStores, createProduct } from '@ss/app-kit';
import { createSealer, sealSecret } from './crypto.js';
import { INDEXES, MIGRATIONS } from './db.js';
import { createSiteRegistry } from './registry.js';

/**
 * @param {string} file
 * @returns {Promise<any>}
 */
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

/**
 * Load manifest.json and inline element feature `$ref`s (app-kit and the Portal take features inline).
 * @param {string} root
 */
export const loadManifest = async (root) => {
	const manifest = await readJson(path.join(root, 'manifest.json'));
	const elements = await Promise.all(
		manifest.elements.map(async (/** @type {any} */ element) =>
			typeof element.features?.$ref === 'string'
				? { ...element, features: await readJson(path.join(root, element.features.$ref)) }
				: element,
		),
	);
	return { ...manifest, elements };
};

/**
 * Load every `strings/<lang>.json` catalog.
 * @param {string} root
 * @returns {Promise<Record<string, Record<string, string>>>}
 */
export const loadStrings = async (root) => {
	const files = (await readdir(path.join(root, 'strings'))).filter((file) => /^[a-z]{2,3}(?:-[A-Za-z0-9]+)*\.json$/.test(file));
	return Object.fromEntries(
		await Promise.all(files.map(async (file) => [file.slice(0, -5), await readJson(path.join(root, 'strings', file))])),
	);
};

/** Product-specific problem codes (RFC 9457 `type` = `<base>/problems/<code>`). */
export const PROBLEM_CODES = Object.freeze({
	channel_disabled: { status: 422, title: 'This delivery channel is not enabled' },
	identifier_invalid: { status: 422, title: 'Invalid e-mail address or phone number' },
	identifier_blocked: { status: 422, title: 'This e-mail domain is not accepted' },
	identifier_in_use: { status: 409, title: 'The identifier belongs to another account' },
	too_soon: { status: 429, title: 'Wait before asking for another message' },
	send_limit: { status: 429, title: 'Too many messages requested' },
	velocity_limit: { status: 429, title: 'Too many attempts from this network' },
	delivery_failed: { status: 502, title: 'The message could not be delivered' },
	code_invalid: { status: 422, title: 'The code is not valid' },
	code_expired: { status: 422, title: 'The code has expired' },
	attempts_exhausted: { status: 422, title: 'Too many attempts for this code' },
	link_invalid: { status: 422, title: 'The sign-in link is not valid' },
	link_expired: { status: 422, title: 'The sign-in link has expired' },
	redirect_not_allowed: { status: 422, title: 'The redirect is not on this website' },
	consent_required: { status: 422, title: 'Terms must be accepted' },
	account_blocked: { status: 403, title: 'This account is blocked' },
	refresh_invalid: { status: 401, title: 'The refresh token is not valid' },
	refresh_reused: { status: 401, title: 'The refresh token was already used; the session was ended' },
	refresh_conflict: { status: 409, title: 'The session was refreshed concurrently; use the newest token' },
	session_ended: { status: 401, title: 'The session has ended' },
	not_allowed: { status: 403, title: 'This operation is not enabled' },
	data_request_pending: { status: 409, title: 'A deletion is already scheduled' },
});

/**
 * @typedef {object} SignupsApp
 * @property {any} product app-kit product
 * @property {import('./crypto.js').Sealer} sealer
 * @property {import('./registry.js').SiteRegistry} registry
 * @property {string | null} cronSecret
 * @property {string} portalUrl
 * @property {string} base the product's public base URL (issuer prefix)
 * @property {() => number} now
 * @property {any} log structured logger (never receives secrets)
 * @property {Record<string, Record<string, string>>} strings
 * @property {{ export?: (input: any) => Promise<unknown>, anonymize?: (input: any) => Promise<unknown> }} privacy late-bound
 *   handlers of the Portal-signed `POST /v1/data:export|anonymize`
 * @property {() => Promise<void>} close pooled merchant connections and the control database client
 */

/**
 * Build the product.
 * @param {{ env?: Record<string, string | undefined>, root?: string, overrides?: Record<string, any> }} [options]
 *   `overrides` are passed to app-kit `createProduct` (tests: `now`, `fetch`, `logger`, `manifest`, `outboundSend`, …)
 * @returns {Promise<SignupsApp>}
 */
export const createPlatform = async ({ env = process.env, root = process.cwd(), overrides = {} } = {}) => {
	const config = configFromEnv(env);
	const missing = [
		['SS_PORTAL_URL', config.portalUrl],
		['SS_APP_SIGNING_KEY', config.signingKey],
		['SS_REGISTRATION_TOKEN_HASH', config.registrationTokenHash],
	].filter(([, value]) => !value);
	if (missing.length > 0)
		throw new Error(`Missing environment variables: ${missing.map(([name]) => name).join(', ')} (run \`ss dev env\`)`);
	const [loaded, strings] = await Promise.all([loadManifest(root), loadStrings(root)]);
	const manifest = overrides.manifest ?? loaded;
	/** @type {unknown} */
	let stores;
	/** @type {any} */
	let sites = null;
	/** @type {{ close: () => Promise<void> } | null} */
	let controlClient = null;
	if (config.productDbUri) {
		const { MongoClient } = await import('mongodb');
		const client = new MongoClient(config.productDbUri, config.productDbOptions);
		controlClient = client;
		const mongoStores = createMongoStores({ db: client.db() });
		await mongoStores.ensureIndexes();
		stores = mongoStores;
		sites = client.db().collection('ss_signups_sites');
	}
	const now = typeof overrides.now === 'function' ? overrides.now : Date.now;
	const signingKey = /** @type {string} */ (config.signingKey);
	const secrets = [sealSecret({ secret: env.SIGNUPS_SEAL_SECRET, signingKey })];
	if (env.SIGNUPS_SEAL_SECRET_PREVIOUS && env.SIGNUPS_SEAL_SECRET_PREVIOUS.length >= 32)
		secrets.push(Buffer.from(env.SIGNUPS_SEAL_SECRET_PREVIOUS, 'utf8'));
	const logger = overrides.logger ?? createLogger({ level: config.logLevel });
	/** @type {SignupsApp['privacy']} */
	const privacy = {};
	const product = createProduct(
		/** @type {any} */ ({
			manifest,
			strings,
			portalUrl: config.portalUrl,
			appId: config.appId,
			signingKey,
			registrationTokenHash: config.registrationTokenHash,
			logger,
			privacy: {
				export: (/** @type {any} */ input) => /** @type {any} */ (privacy.export)?.(input),
				anonymize: (/** @type {any} */ input) => /** @type {any} */ (privacy.anonymize)?.(input),
			},
			problemCodes: PROBLEM_CODES,
			data: { indexes: [...INDEXES], migrations: MIGRATIONS },
			// messaging: app-kit's built-in adapters for the Portal providers `generic-http` and `smtp` (no registration)
			devProbes: true, // /v1/ss-probe/* for `ss certify`; app-kit never mounts them when NODE_ENV=production
			// SSRF policy for merchant databases and connectors: in development the `ss dev` client database and local mocks
			// live on loopback; app-kit ignores the allowlist when NODE_ENV=production
			outbound: {
				allowHosts: config.outboundAllowHosts.length > 0 ? config.outboundAllowHosts : ['127.0.0.1', 'localhost', '::1'],
			},
			...(stores === undefined ? {} : { stores }),
			...overrides,
		}),
	);
	return {
		product,
		sealer: createSealer({ secrets }),
		registry: createSiteRegistry({ collection: sites }),
		cronSecret: env.CRON_SECRET && env.CRON_SECRET.length >= 16 ? env.CRON_SECRET : null,
		portalUrl: /** @type {string} */ (config.portalUrl),
		base: String(manifest.endpoints.base).replace(/\/+$/, ''),
		now,
		log: logger,
		strings,
		privacy,
		close: async () => {
			await product.close?.();
			await controlClient?.close();
		},
	};
};
