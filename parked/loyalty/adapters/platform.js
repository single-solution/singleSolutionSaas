/**
 * Platform adapter: builds the app-kit product from the environment (`configFromEnv`: `MONGODB_URI`, the product's
 * control database, `CONNECT_SECRET`, plus optional tuning) and the project files (manifest with feature schemas inlined, string
 * catalogs). A Portal connects at `/.well-known/ss-connect` with the connect secret; the connection and every generated secret are kept in the control database. This is the only place that reads the environment.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { configFromEnv, createLogger, createMongoStores, createProduct } from '@ss/app-kit';
import { INDEXES, MIGRATIONS } from './db.js';
import { createWalletTokens, randomBytes, stableId, walletSecret } from './tokens.js';

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
	insufficient_points: { status: 409, title: 'Not enough points' },
	below_minimum: { status: 422, title: 'Below the minimum redemption' },
	above_maximum: { status: 422, title: 'Above the maximum share of the transaction' },
	share_too_small: { status: 422, title: 'The transaction is too small to redeem the minimum' },
	offers_not_allowed: { status: 422, title: 'Points cannot be combined with offers' },
	no_balance: { status: 409, title: 'No points to redeem' },
	amount_required: { status: 422, title: 'An amount is required' },
	points_invalid: { status: 422, title: 'Invalid number of points' },
	not_releasable: { status: 409, title: 'The redemption cannot be released' },
	not_applied: { status: 409, title: 'The redemption is not applied' },
	order_mismatch: { status: 409, title: 'The redemption belongs to another order' },
	referrals_disabled: { status: 403, title: 'Referrals are not enabled' },
	unknown_code: { status: 404, title: 'Unknown referral code' },
	self_referral: { status: 422, title: 'Customers cannot refer themselves' },
	already_referred: { status: 409, title: 'The customer was already referred' },
	not_a_new_customer: { status: 422, title: 'Only new customers can be referred' },
});

/**
 * @typedef {object} LoyaltyApp
 * @property {any} product app-kit product
 * @property {import('./tokens.js').WalletTokens} tokens
 * @property {() => number} now
 * @property {(text: string) => string} hash
 * @property {(n: number) => Uint8Array} randomBytes
 * @property {Record<string, Record<string, string>>} strings
 * @property {() => Promise<void>} close pooled merchant connections and the control database client
 */

/**
 * Build the product.
 * @param {{ env?: Record<string, string | undefined>, root?: string, assets?: { manifest: any, strings: Record<string, Record<string, string>> },
 *   overrides?: Record<string, any> }} [options]
 *   `assets` (the Next.js build: app/_lib/assets.js) replaces reading manifest.json, schemas/ and strings/ from `root`
 *   `overrides` are passed to app-kit `createProduct` (tests: `now`, `fetch`, `logger`, `manifest`, …)
 * @returns {Promise<LoyaltyApp>}
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
			// SSRF policy for merchant databases and connectors: in development the client database and local mocks
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
		tokens: createWalletTokens({
			secret: walletSecret({ secret: product.secret('wallet-tokens').toString('base64url') }),
			now,
		}),
		now,
		hash: stableId,
		randomBytes,
		strings,
		close: async () => {
			await product.close?.();
			await controlClient?.close();
		},
	};
};
