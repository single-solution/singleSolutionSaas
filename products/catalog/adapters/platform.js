/**
 * Platform adapter: builds the app-kit product from the environment (`configFromEnv`: SS_PORTAL_URL, SS_APP_ID,
 * SS_APP_SIGNING_KEY, SS_REGISTRATION_TOKEN_HASH, SS_PRODUCT_DB_URI, SS_LOG_LEVEL, SS_OUTBOUND_ALLOW_HOSTS; plus
 * CATALOG_FEED_SECRET and CRON_SECRET) and the project files (manifest with feature schemas inlined, string
 * catalogs). This is the only place that reads the environment.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { configFromEnv, createLogger, createMongoStores, createProduct } from '@ss/app-kit';
import { INDEXES, MIGRATIONS } from './db.js';
import { createSiteRegistry } from './registry.js';
import { createExportLinks, createFeedTokens, exportSecret, feedSecret, newId, stableId } from './tokens.js';

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
 * Personal data: the catalog stores none (items, taxonomy and stock moves hold order ids, never customers), so export
 * and anonymise answer with empty results.
 */
export const PRIVACY = Object.freeze({
	collections: [],
	/** @param {{ websiteId: string, subject?: Record<string, string> }} input */
	export: async ({ websiteId, subject }) => ({
		websiteId,
		...(subject ? { subject } : {}),
		exportedAt: new Date().toISOString(),
		collections: {},
	}),
	/** @param {{ websiteId: string }} input */
	anonymize: async ({ websiteId }) => ({ websiteId, anonymized: {} }),
});

/** Product-specific problem codes (RFC 9457 `type` = `<base>/problems/<code>`). */
export const PROBLEM_CODES = Object.freeze({
	limit_reached: { status: 409, title: 'A catalog limit is reached' },
	slug_taken: { status: 409, title: 'The slug is already used' },
	key_taken: { status: 409, title: 'The key is already used' },
	in_use: { status: 409, title: 'Still in use' },
	version_mismatch: { status: 412, title: 'The resource changed since it was read' },
	insufficient_stock: { status: 409, title: 'Not enough stock' },
	media_missing: { status: 422, title: 'The media object is not in storage' },
	storage_unavailable: { status: 503, title: 'The storage connector is not available' },
	storage_not_connected: { status: 409, title: 'No storage connector is connected' },
	csv_invalid: { status: 422, title: 'The file is not a valid import' },
	writes_disabled: { status: 403, title: 'Writes with sk_ keys are turned off' },
});

/**
 * @typedef {object} CatalogApp
 * @property {any} product app-kit product
 * @property {import('./tokens.js').FeedTokens} tokens
 * @property {import('./tokens.js').ExportLinks} exportLinks signed, short-lived CSV download links of the dashboard
 * @property {import('./registry.js').SiteRegistry} registry
 * @property {string | null} cronSecret
 * @property {string} portalUrl
 * @property {() => number} now
 * @property {(text: string) => string} stableId
 * @property {(prefix: string) => string} newId
 * @property {Record<string, Record<string, string>>} strings
 * @property {() => Promise<void>} close pooled merchant connections and the control database client
 */

/**
 * Build the product.
 * @param {{ env?: Record<string, string | undefined>, root?: string, overrides?: Record<string, any> }} [options]
 *   `overrides` are passed to app-kit `createProduct` (tests: `now`, `fetch`, `logger`, `manifest`, `outboundSend`, …)
 * @returns {Promise<CatalogApp>}
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
		sites = client.db().collection('ss_catalog_sites');
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
	return {
		product,
		tokens: createFeedTokens({ secret: feedSecret({ secret: env.CATALOG_FEED_SECRET, signingKey }) }),
		exportLinks: createExportLinks({ secret: exportSecret({ secret: env.CATALOG_FEED_SECRET, signingKey }), now }),
		registry: createSiteRegistry({ collection: sites }),
		cronSecret: env.CRON_SECRET && env.CRON_SECRET.length >= 16 ? env.CRON_SECRET : null,
		portalUrl,
		now,
		stableId,
		newId,
		strings,
		close: async () => {
			await product.close?.();
			await controlClient?.close();
		},
	};
};
