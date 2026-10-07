/**
 * Platform adapter: builds the app-kit product from the environment (`configFromEnv`: `MONGODB_URI`, the product's
 * control database, `CONNECT_SECRET`, plus optional tuning) and the project files (manifest with feature schemas inlined, string
 * catalogs). A Portal connects at `/.well-known/ss-connect` with the connect secret; the connection and every generated secret are kept in the control database.
 * This is the only place that reads the environment.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { configFromEnv, createLogger, createMongoStores, createProduct } from '@ss/app-kit';
import { INDEXES, MIGRATIONS } from './db.js';
import { createTokens, randomId, stableId, tokenSecret } from './tokens.js';

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
	type_not_enabled: { status: 422, title: 'This alert type is not enabled' },
	contact_invalid: { status: 422, title: 'The e-mail address or phone number is not valid' },
	contact_required: { status: 422, title: 'An e-mail address or phone number is required' },
	entry_not_allowed: { status: 401, title: 'Only signed-in customers can subscribe' },
	consent_required: { status: 422, title: 'Consent is required' },
	in_stock: { status: 409, title: 'The item is available now' },
	limit_reached: { status: 409, title: 'Too many active alerts' },
	contact_suppressed: { status: 409, title: 'This contact unsubscribed from alerts' },
	token_invalid: { status: 404, title: 'The link is invalid or has expired' },
	csv_invalid: { status: 422, title: 'The CSV file is not valid' },
	dispatch_unavailable: { status: 409, title: 'Messaging is not connected for this website' },
});

/**
 * @typedef {object} AlertsApp
 * @property {any} product app-kit product
 * @property {import('./tokens.js').Tokens} tokens
 * @property {string} instanceId this process (message lease owner)
 * @property {() => number} now
 * @property {(prefix: string) => string} newId
 * @property {(prefix: string, key: string) => string} stableId
 * @property {Record<string, Record<string, string>>} strings
 * @property {() => Promise<void>} close pooled merchant connections and the control database client
 */

/**
 * Build the product.
 * @param {{ env?: Record<string, string | undefined>, root?: string, assets?: { manifest: any, strings: Record<string, Record<string, string>> },
 *   overrides?: Record<string, any> }} [options]
 *   `assets` (the Next.js build: app/_lib/assets.js) replaces reading manifest.json, schemas/ and strings/ from `root`
 *   `overrides` are passed to app-kit `createProduct` (tests: `now`, `fetch`, `logger`, `manifest`, `outboundSend`, …)
 * @returns {Promise<AlertsApp>}
 */
export const createPlatform = async ({ env = process.env, root = process.cwd(), assets, overrides = {} } = {}) => {
	const config = configFromEnv(env);
	const [manifest, strings] = assets
		? [assets.manifest, assets.strings]
		: await Promise.all([loadManifest(root), loadStrings(root)]);
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
			logger: createLogger({ level: config.logLevel }),
			problems: config.problems,
			problemCodes: PROBLEM_CODES,
			data: { indexes: [...INDEXES], migrations: MIGRATIONS },
			// SSRF policy for merchant databases and providers: in development a local client database and
			// mock providers live on loopback; app-kit ignores the allowlist when NODE_ENV=production
			outbound: {
				allowHosts: config.outboundAllowHosts.length > 0 ? config.outboundAllowHosts : ['127.0.0.1', 'localhost', '::1'],
			},
			...(config.connectSecret ? { connectSecret: config.connectSecret } : {}),
			...(stores === undefined ? {} : { stores }),
			...overrides,
		}),
	);
	// generated secrets and the Portal connection live in the control database (made at /.well-known/ss-connect)
	await product.ready();
	const tokens = createTokens({ secret: tokenSecret({ secret: product.secret('link-tokens').toString('base64url') }), now });
	return {
		product,
		tokens,
		instanceId: randomId('ins'),
		now,
		newId: randomId,
		stableId,
		strings,
		close: async () => {
			await product.close?.();
			await controlClient?.close();
		},
	};
};
