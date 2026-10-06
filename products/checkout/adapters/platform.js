/**
 * Platform adapter: builds the app-kit product from the environment (`configFromEnv`: SS_PORTAL_URL, SS_APP_ID,
 * SS_APP_SIGNING_KEY, SS_REGISTRATION_TOKEN_HASH, SS_PRODUCT_DB_URI, SS_LOG_LEVEL, SS_OUTBOUND_ALLOW_HOSTS; plus
 * SS_CHECKOUT_SEAL_KEY) and the project files (manifest with feature schemas inlined, string catalogs).
 * This is the only place that reads the environment.
 */
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { configFromEnv, createLogger, createMongoStores, createProduct } from '@ss/app-kit';
import { createId } from '@ss/contracts';
import { INDEXES } from './db.js';
import { ADAPTERS } from './payments.js';
import { PRIVACY } from './privacy.js';
import { sealingKey } from './secrets.js';

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

/** Product-specific problem codes (RFC 9457 `type` = `<base>/problems/<code>`). */
export const PROBLEM_CODES = Object.freeze({
	cart_not_found: { status: 404, title: 'Unknown cart' },
	cart_closed: { status: 409, title: 'The cart is no longer open' },
	cart_empty: { status: 422, title: 'The cart has no lines' },
	cart_unavailable_lines: { status: 409, title: 'Some lines can no longer be bought' },
	line_not_found: { status: 404, title: 'Unknown cart line' },
	too_many_lines: { status: 422, title: 'The cart has too many lines' },
	item_unavailable: { status: 409, title: 'The item is not available' },
	variant_unavailable: { status: 409, title: 'The variant is not available' },
	out_of_stock: { status: 409, title: 'Sold out' },
	insufficient_stock: { status: 409, title: 'Not enough stock' },
	untracked_stock: { status: 409, title: 'The item has no tracked stock' },
	currency_mismatch: { status: 422, title: 'The item is priced in another currency' },
	currency_not_configured: { status: 422, title: 'The website has no currency' },
	payment_unavailable: { status: 422, title: 'This payment method is not available' },
	delivery_unavailable: { status: 422, title: 'This delivery method is not available' },
	consent_required: { status: 422, title: 'A required policy was not accepted' },
	total_changed: { status: 409, title: 'The total changed' },
	blocked: { status: 403, title: 'Online orders are not available for this shopper' },
	open_orders_limit: { status: 409, title: 'Too many orders waiting for payment or confirmation' },
	offer_unavailable: { status: 409, title: 'An offer is no longer available' },
	points_unavailable: { status: 409, title: 'The points cannot be redeemed' },
	order_not_found: { status: 404, title: 'Unknown order' },
	order_state: { status: 409, title: 'The order cannot change from its current status' },
	placement_in_progress: { status: 409, title: 'This order is already being placed' },
	integration_unavailable: { status: 503, title: 'A connected product did not answer' },
	proof_not_uploaded: { status: 409, title: 'The proof file was not uploaded' },
	proof_limit: { status: 409, title: 'This order has all the proofs it accepts' },
	payment_failed: { status: 402, title: 'The payment did not go through' },
	return_url_invalid: { status: 422, title: 'The return address is not on this website' },
});

/**
 * @typedef {object} CheckoutApp
 * @property {any} product app-kit product
 * @property {string} portalUrl
 * @property {() => number} now
 * @property {(text: string) => string} hash SHA-256 hex
 * @property {(prefix: string) => string} randomId opaque ids (`crt_…`, 128 bits)
 * @property {(n: number) => Uint8Array} randomBytes
 * @property {Buffer} sealKey key that seals the integration key
 * @property {Record<string, Record<string, string>>} strings
 * @property {() => Promise<void>} close
 */

/**
 * Build the product.
 * @param {{ env?: Record<string, string | undefined>, root?: string, overrides?: Record<string, any> }} [options]
 *   `overrides` are passed to app-kit `createProduct` (tests: `now`, `fetch`, `logger`, `outboundSend`, `randomBytes`, …)
 * @returns {Promise<CheckoutApp>}
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
	/** @type {(n: number) => Uint8Array} */
	const bytes = typeof overrides.randomBytes === 'function' ? overrides.randomBytes : (n) => new Uint8Array(nodeRandomBytes(n));
	const sealSecret =
		env.SS_CHECKOUT_SEAL_KEY && env.SS_CHECKOUT_SEAL_KEY.length >= 32 ? env.SS_CHECKOUT_SEAL_KEY : String(signingKey);
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
			data: { indexes: [...INDEXES] },
			connectors: { payments: ADAPTERS },
			devProbes: true, // /v1/ss-probe/* for `ss certify`; app-kit never mounts them when NODE_ENV=production
			// SSRF policy for merchant databases, connectors and calls to the merchant's other products: in development the
			// `ss dev` client database and local mocks live on loopback; app-kit ignores the allowlist in production
			outbound: {
				allowHosts: config.outboundAllowHosts.length > 0 ? config.outboundAllowHosts : ['127.0.0.1', 'localhost', '::1'],
			},
			...(stores === undefined ? {} : { stores }),
			...overrides,
		}),
	);
	return {
		product,
		portalUrl,
		now,
		hash: (text) => createHash('sha256').update(text).digest('hex'),
		randomId: (prefix) => createId(prefix, { randomBytes: bytes }),
		randomBytes: bytes,
		sealKey: sealingKey(sealSecret),
		strings,
		close: async () => {
			await product.close?.();
			await controlClient?.close();
		},
	};
};
