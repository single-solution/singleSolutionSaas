/**
 * Platform adapter: builds the app-kit product from the environment (`configFromEnv`: SS_PORTAL_URL, SS_APP_ID,
 * SS_APP_SIGNING_KEY, SS_REGISTRATION_TOKEN_HASH, SS_PRODUCT_DB_URI, SS_LOG_LEVEL, SS_OUTBOUND_ALLOW_HOSTS; plus
 * AFTERSALES_TOKEN_SECRET) and the project files (manifest with feature schemas inlined, string catalogs). This is the
 * only place that reads the environment.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { configFromEnv, createLogger, createMongoStores, createProduct } from '@ss/app-kit';
import { INDEXES, MIGRATIONS } from './db.js';
import { PRIVACY } from './privacy.js';
import { createClaimTokens, randomBytes, stableId, tokenSecret } from './tokens.js';

export { PRIVACY };

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

/**
 * Whole days of an ISO-8601 duration of days (`P2D`), else the fallback.
 * @param {unknown} duration
 * @param {number} fallback
 */
export const retentionDays = (duration, fallback) => {
	const match = typeof duration === 'string' ? /^P(\d{1,5})D$/.exec(duration) : null;
	return match ? Number(match[1]) : fallback;
};

/** Product-specific problem codes (RFC 9457 `type` = `<base>/problems/<code>`). */
export const PROBLEM_CODES = Object.freeze({
	not_eligible: { status: 409, title: 'The item is not inside a claim window' },
	quantity_unavailable: { status: 409, title: 'More units than can still be claimed' },
	serial_mismatch: { status: 422, title: 'The serial number does not belong to this purchase' },
	invalid_token: { status: 401, title: 'The claim link is invalid or expired' },
	access_disabled: { status: 403, title: 'Guest claims are turned off' },
	claim_limit: { status: 429, title: 'Too many open claims' },
	transition_invalid: { status: 409, title: 'The claim cannot move to that status' },
	status_conflict: { status: 409, title: 'The claim was changed meanwhile; reload it' },
	refund_not_allowed: { status: 409, title: 'This claim cannot be refunded now' },
	refund_exceeds: { status: 409, title: 'The refund is more than the claim still holds' },
	restock_not_allowed: { status: 409, title: 'The items of this claim cannot be restocked now' },
	notes_full: { status: 409, title: 'The claim has the most notes allowed' },
	messages_closed: { status: 403, title: 'Customers cannot write on this website' },
	messages_full: { status: 409, title: 'The conversation has the most messages allowed' },
	lookup_disabled: { status: 403, title: 'The public serial lookup is turned off' },
	photo_invalid: { status: 422, title: 'A photo is missing, not uploaded or not allowed' },
	storage_unavailable: { status: 503, title: 'The storage connector is not available' },
});

/**
 * @typedef {object} AftersalesApp
 * @property {any} product app-kit product
 * @property {import('./tokens.js').ClaimTokens} tokens
 * @property {string} portalUrl
 * @property {() => number} now
 * @property {(text: string) => string} hash
 * @property {(n: number) => Uint8Array} randomBytes
 * @property {Record<string, Record<string, string>>} strings
 * @property {{ photos: number }} retention days
 * @property {() => Promise<void>} close pooled merchant connections and the control database client
 */

/**
 * Build the product.
 * @param {{ env?: Record<string, string | undefined>, root?: string, overrides?: Record<string, any> }} [options]
 *   `overrides` are passed to app-kit `createProduct` (tests: `now`, `fetch`, `logger`, `manifest`, `outboundSend`, …)
 * @returns {Promise<AftersalesApp>}
 */
export const createPlatform = async ({ env = process.env, root = process.cwd(), overrides = {} } = {}) => {
	const config = configFromEnv(env);
	const { portalUrl, signingKey, registrationTokenHash } = config;
	if (!portalUrl || !signingKey || !registrationTokenHash) {
		const missing = [
			['SS_PORTAL_URL', portalUrl],
			['SS_APP_SIGNING_KEY', signingKey],
			['SS_REGISTRATION_TOKEN_HASH', registrationTokenHash],
		]
			.filter(([, value]) => !value)
			.map(([name]) => name);
		throw new Error(`Missing environment variables: ${missing.join(', ')} (run \`ss dev env\`)`);
	}
	const [manifest, strings] = await Promise.all([loadManifest(root), loadStrings(root)]);
	/** @type {unknown} */
	let stores;
	/** @type {{ close: () => Promise<void> } | null} */
	let controlClient = null;
	if (config.productDbUri) {
		const { MongoClient } = await import('mongodb');
		const client = new MongoClient(config.productDbUri, config.productDbOptions);
		controlClient = client;
		const mongoStores = createMongoStores({ db: client.db() });
		await mongoStores.ensureIndexes();
		stores = mongoStores;
	}
	const now = typeof overrides.now === 'function' ? overrides.now : Date.now;
	const product = createProduct(
		/** @type {any} */ ({
			manifest,
			strings,
			portalUrl,
			appId: config.appId,
			signingKey,
			registrationTokenHash,
			logger: createLogger({ level: config.logLevel }),
			privacy: PRIVACY,
			problemCodes: PROBLEM_CODES,
			data: { indexes: [...INDEXES], migrations: MIGRATIONS },
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
	const retention = /** @type {Record<string, unknown>} */ (manifest.retention ?? {});
	return {
		product,
		tokens: createClaimTokens({ secret: tokenSecret({ secret: env.AFTERSALES_TOKEN_SECRET, signingKey }), now }),
		portalUrl,
		now,
		hash: stableId,
		randomBytes,
		strings,
		retention: { photos: retentionDays(retention.photos, 2) },
		close: async () => {
			await product.close?.();
			await controlClient?.close();
		},
	};
};
