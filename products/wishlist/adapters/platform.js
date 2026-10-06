/**
 * Platform adapter: builds the app-kit product from the environment (`configFromEnv`: SS_PORTAL_URL, SS_APP_ID,
 * SS_APP_SIGNING_KEY, SS_REGISTRATION_TOKEN_HASH, SS_PRODUCT_DB_URI, SS_LOG_LEVEL, SS_OUTBOUND_ALLOW_HOSTS; plus
 * WISHLIST_TOKEN_SECRET) and the project files (manifest with feature schemas inlined, string catalogs). This is the
 * only place that reads the environment.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { configFromEnv, createLogger, createMongoStores, createProduct } from '@ss/app-kit';
import { INDEXES, MIGRATIONS, repositoriesFor } from './db.js';
import { createPrivacyHandlers } from './privacy.js';
import { createTokens, randomId, tokenSecret } from './tokens.js';

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
	guest_invalid: { status: 401, title: 'The guest token is invalid or has expired' },
	limit_reached: { status: 409, title: 'The limit of lists or items is reached' },
	share_not_allowed: { status: 403, title: 'This list cannot be shared' },
});

/**
 * @typedef {object} WishlistApp
 * @property {any} product app-kit product
 * @property {import('./tokens.js').Tokens} tokens
 * @property {string} portalUrl
 * @property {() => number} now
 * @property {(prefix: string) => string} newId
 * @property {Record<string, Record<string, string>>} strings
 * @property {() => Promise<void>} close pooled merchant connections and the control database client
 */

/**
 * Build the product.
 * @param {{ env?: Record<string, string | undefined>, root?: string, overrides?: Record<string, any> }} [options]
 *   `overrides` are passed to app-kit `createProduct` (tests: `now`, `fetch`, `logger`, `manifest`, …)
 * @returns {Promise<WishlistApp>}
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
	/* v8 ignore start -- the production control store (tests use the in-memory stores) */
	if (config.productDbUri) {
		const { MongoClient } = await import('mongodb');
		const client = new MongoClient(config.productDbUri, config.productDbOptions);
		controlClient = client;
		const mongoStores = createMongoStores({ db: client.db() });
		await mongoStores.ensureIndexes();
		stores = mongoStores;
	}
	/* v8 ignore stop */
	const now = typeof overrides.now === 'function' ? overrides.now : Date.now;
	const tokens = createTokens({ secret: tokenSecret({ secret: env.WISHLIST_TOKEN_SECRET, signingKey }), now });
	/** @type {any} */
	let product = null;
	const repoFor = repositoriesFor({ data: { forWebsite: (id, stamp) => product.data.forWebsite(id, stamp) } }, { now });
	product = createProduct(
		/** @type {any} */ ({
			manifest,
			strings,
			portalUrl,
			appId: config.appId,
			signingKey,
			registrationTokenHash,
			logger: createLogger({ level: config.logLevel }),
			privacy: createPrivacyHandlers({ repoFor, now }),
			problemCodes: PROBLEM_CODES,
			data: { indexes: [...INDEXES], migrations: MIGRATIONS },
			devProbes: true, // /v1/ss-probe/* for `ss certify`; app-kit never mounts them when NODE_ENV=production
			// SSRF policy for merchant databases: in development the `ss dev` client database lives on loopback; app-kit
			// ignores the allowlist when NODE_ENV=production
			outbound: {
				allowHosts: config.outboundAllowHosts.length > 0 ? config.outboundAllowHosts : ['127.0.0.1', 'localhost', '::1'],
			},
			...(stores === undefined ? {} : { stores }),
			...overrides,
		}),
	);
	return {
		product,
		tokens,
		portalUrl,
		now,
		newId: randomId,
		strings,
		close: async () => {
			await product.close?.();
			await controlClient?.close();
		},
	};
};
