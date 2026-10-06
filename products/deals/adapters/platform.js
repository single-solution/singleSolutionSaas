/**
 * Platform adapter: builds the app-kit product from the environment (`configFromEnv`: `DATABASE_URI`, the product's
 * control database, `CONNECT_SECRET`, plus optional tuning) and the project files (manifest with feature schemas inlined, string
 * catalogs). A Portal connects at `/.well-known/ss-connect` with the connect secret; the connection and every generated secret are kept in the control database. This is the only place that reads the environment.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { configFromEnv, createLogger, createMongoStores, createProduct } from '@ss/app-kit';
import { INDEXES, MIGRATIONS } from './db.js';
import { createLockTokens, lockSecret } from './locks.js';

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

/** Personal data this product stores (drives POST /v1/data:export and /v1/data:anonymize). */
export const PRIVACY = Object.freeze({
	collections: [
		{ name: 'quotes', subjectField: 'customerId', fields: ['customerId', 'cartId'] },
		{ name: 'applications', subjectField: 'customerId', fields: ['customerId'] },
		{ name: 'customer_usage', subjectField: 'customerId', fields: ['customerId'] },
	],
});

/** Product-specific problem codes (RFC 9457 `type` = `<base>/problems/<code>`). */
export const PROBLEM_CODES = Object.freeze({
	kind_disabled: { status: 403, title: 'This deal kind is not enabled' },
	deal_limit_reached: { status: 409, title: 'Maximum number of deals of this kind reached' },
	quote_expired: { status: 409, title: 'The quote expired; quote the cart again' },
	quote_committed: { status: 409, title: 'The quote was committed to another order' },
	quote_not_committed: { status: 409, title: 'The quote is not committed' },
	deal_exhausted: { status: 409, title: 'A deal ran out (uses, stock or per-customer limit); quote the cart again' },
	total_mismatch: { status: 409, title: 'The order total differs from the quote' },
	price_lock_expired: { status: 409, title: 'A price lock expired; quote the cart again' },
	currency_mismatch: { status: 422, title: 'Items and cart use different currencies' },
});

/**
 * @typedef {object} DealsApp
 * @property {any} product app-kit product
 * @property {import('./locks.js').LockTokens} locks
 * @property {() => number} now
 * @property {Record<string, Record<string, string>>} strings
 * @property {() => Promise<void>} close pooled merchant connections and the control database client
 */

/**
 * Build the product.
 * @param {{ env?: Record<string, string | undefined>, root?: string, overrides?: Record<string, any> }} [options]
 *   `overrides` are passed to app-kit `createProduct` (tests: `now`, `fetch`, `logger`, `manifest`, …)
 * @returns {Promise<DealsApp>}
 */
export const createPlatform = async ({ env = process.env, root = process.cwd(), overrides = {} } = {}) => {
	const config = configFromEnv(env);
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
			...(config.connectSecret ? { connectSecret: config.connectSecret } : {}),
			...(stores === undefined ? {} : { stores }),
			...overrides,
		}),
	);
	// generated secrets and the Portal connection live in the control database (made at /.well-known/ss-connect)
	await product.ready();
	return {
		product,
		locks: createLockTokens({ secret: lockSecret({ secret: product.secret('price-locks').toString('base64url') }) }),
		now,
		strings,
		close: async () => {
			await product.close?.();
			await controlClient?.close();
		},
	};
};
