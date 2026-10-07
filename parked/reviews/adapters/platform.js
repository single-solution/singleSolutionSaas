/**
 * Platform adapter: builds the app-kit product from the environment (`configFromEnv`: `MONGODB_URI`, the product's
 * control database, `CONNECT_SECRET`, plus optional tuning) and the project files (manifest with feature schemas inlined, string
 * catalogs). A Portal connects at `/.well-known/ss-connect` with the connect secret; the connection and every generated secret are kept in the control database. This is the only place that reads the environment.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { configFromEnv, createLogger, createMongoStores, createProduct } from '@ss/app-kit';
import { INDEXES, MIGRATIONS } from './db.js';
import { createLinkTokens, linkSecret, randomBytes, stableId } from './tokens.js';

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
 * Whole days of an ISO-8601 duration of days (`P730D`), else the fallback.
 * @param {unknown} duration
 * @param {number} fallback
 */
export const retentionDays = (duration, fallback) => {
	const match = typeof duration === 'string' ? /^P(\d{1,5})D$/.exec(duration) : null;
	return match ? Number(match[1]) : fallback;
};

/** Product-specific problem codes (RFC 9457 `type` = `<base>/problems/<code>`). */
export const PROBLEM_CODES = Object.freeze({
	not_verified: { status: 403, title: 'Only verified buyers can review this item' },
	already_reviewed: { status: 409, title: 'This item was already reviewed' },
	review_limit: { status: 429, title: 'Too many reviews in the last 24 hours' },
	question_limit: { status: 429, title: 'Too many questions in the last 24 hours' },
	invalid_token: { status: 401, title: 'The review link is invalid or expired' },
	request_closed: { status: 409, title: 'The review request is closed' },
	not_pending: { status: 409, title: 'The item is not waiting for moderation' },
	replies_disabled: { status: 403, title: 'Merchant replies are turned off' },
	photo_invalid: { status: 422, title: 'A photo is missing, not uploaded or not allowed' },
	storage_unavailable: { status: 503, title: 'The storage connector is not available' },
	name_required: { status: 422, title: 'The item has no name yet' },
	csv_invalid: { status: 422, title: 'The file is not valid CSV' },
	answers_closed: { status: 403, title: 'Only the merchant can answer' },
});

/**
 * @typedef {object} ReviewsApp
 * @property {any} product app-kit product
 * @property {import('./tokens.js').LinkTokens} tokens
 * @property {() => number} now
 * @property {(text: string) => string} hash
 * @property {(n: number) => Uint8Array} randomBytes
 * @property {Record<string, Record<string, string>>} strings
 * @property {{ requests: number, orders: number, photos: number }} retention days
 * @property {() => Promise<void>} close pooled merchant connections and the control database client
 */

/**
 * Build the product.
 * @param {{ env?: Record<string, string | undefined>, root?: string, assets?: { manifest: any, strings: Record<string, Record<string, string>> },
 *   overrides?: Record<string, any> }} [options]
 *   `assets` (the Next.js build: app/_lib/assets.js) replaces reading manifest.json, schemas/ and strings/ from `root`
 *   `overrides` are passed to app-kit `createProduct` (tests: `now`, `fetch`, `logger`, `manifest`, `outboundSend`, …)
 * @returns {Promise<ReviewsApp>}
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
	const retention = /** @type {Record<string, unknown>} */ (manifest.retention ?? {});
	return {
		product,
		tokens: createLinkTokens({ secret: linkSecret({ secret: product.secret('review-links').toString('base64url') }), now }),
		now,
		hash: stableId,
		randomBytes,
		strings,
		retention: {
			requests: retentionDays(retention.requests, 730),
			orders: retentionDays(retention.orders, 730),
			photos: retentionDays(retention.photos, 30),
		},
		close: async () => {
			await product.close?.();
			await controlClient?.close();
		},
	};
};
