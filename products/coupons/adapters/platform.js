/**
 * Platform adapter: builds the app-kit product from the environment (`configFromEnv`: `MONGODB_URI`, the product's
 * control database, `CONNECT_SECRET`, plus optional tuning) and the project files (manifest with feature schemas inlined, string
 * catalogs). A Portal connects at `/.well-known/ss-connect` with the connect secret; the connection and every generated secret are kept in the control database. This is the only place
 * that reads the environment.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { configFromEnv, createLogger, createMongoStores, createProduct } from '@ss/app-kit';
import { randomBytes, randomId, stableId } from './crypto.js';
import { INDEXES, MIGRATIONS } from './repositories.js';

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
 * Personal data this product stores (drives POST /v1/data:export and /v1/data:anonymize): reservations name the
 * customer and may carry an e-mail and a device id; per-customer usage counters name the customer (their `key` is a
 * hash). Coupons and codes hold no personal data.
 */
export const PRIVACY = Object.freeze({
	collections: [
		{ name: 'reservations', subjectField: 'customerId', fields: ['customerId', 'email', 'deviceId'] },
		{ name: 'usage', subjectField: 'customerId', fields: ['customerId'] },
	],
});

/** Product-specific problem codes (RFC 9457 `type` = `<base>/problems/<code>`). */
export const PROBLEM_CODES = Object.freeze({
	code_not_found: { status: 404, title: 'Unknown coupon code' },
	coupon_inactive: { status: 422, title: 'The coupon is not active' },
	code_disabled: { status: 422, title: 'The code is disabled' },
	exhausted: { status: 409, title: 'The code has no uses left' },
	not_started: { status: 422, title: 'The coupon is not valid yet' },
	ended: { status: 422, title: 'The coupon has ended' },
	outside_schedule: { status: 422, title: 'The coupon is not valid at this time' },
	currency_mismatch: { status: 422, title: 'The coupon is for another currency' },
	not_eligible: { status: 422, title: 'The cart is not eligible for this coupon' },
	action_unavailable: { status: 422, title: 'This coupon’s discount type is not enabled' },
	blocked: { status: 403, title: 'Coupons are not available for this customer' },
	customer_limit_reached: { status: 409, title: 'The customer already used this coupon' },
	device_limit_reached: { status: 409, title: 'This device already used this coupon' },
	not_combinable: { status: 422, title: 'The coupons cannot be combined' },
	too_many_coupons: { status: 422, title: 'Too many coupons for one cart' },
	duplicate_coupon: { status: 422, title: 'Two codes of the same coupon' },
	no_discount: { status: 422, title: 'The coupon gives no discount on this cart' },
	velocity_limited: { status: 429, title: 'Too many coupon attempts' },
	code_taken: { status: 409, title: 'The code already exists' },
	limit_reached: { status: 409, title: 'The plan limit is reached' },
	pattern_too_weak: { status: 422, title: 'The pattern has too few random positions' },
	reservation_expired: { status: 409, title: 'The reservation expired and its uses are gone' },
	not_redeemable: { status: 409, title: 'The reservation cannot be redeemed' },
	not_releasable: { status: 409, title: 'The reservation cannot be released' },
	order_mismatch: { status: 409, title: 'The reservation belongs to another order' },
	element_off: { status: 422, title: 'The element this setting needs is not enabled' },
});

/**
 * @typedef {object} CouponsApp
 * @property {any} product app-kit product
 * @property {() => number} now
 * @property {(text: string) => string} hash
 * @property {(n: number) => Uint8Array} randomBytes
 * @property {(prefix: string) => string} randomId
 * @property {Record<string, Record<string, string>>} strings
 * @property {() => Promise<void>} close pooled merchant connections and the control database client
 */

/**
 * Build the product.
 * @param {{ env?: Record<string, string | undefined>, root?: string, assets?: { manifest: any, strings: Record<string, Record<string, string>> },
 *   overrides?: Record<string, any> }} [options]
 *   `assets` (the Next.js build: app/_lib/assets.js) replaces reading manifest.json, schemas/ and strings/ from `root`
 *   `overrides` are passed to app-kit `createProduct` (tests: `now`, `fetch`, `logger`, `manifest`, `randomBytes`, …)
 * @returns {Promise<CouponsApp>}
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
	/** @type {(n: number) => Uint8Array} */
	const bytes = typeof overrides.randomBytes === 'function' ? overrides.randomBytes : randomBytes;
	const product = createProduct(
		/** @type {any} */ ({
			manifest,
			strings,
			logger: createLogger({ level: config.logLevel }),
			problems: config.problems,
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
		now,
		hash: stableId,
		randomBytes: bytes,
		randomId: (prefix) => randomId(prefix, bytes),
		strings,
		close: async () => {
			await product.close?.();
			await controlClient?.close();
		},
	};
};
