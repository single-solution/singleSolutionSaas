/**
 * Platform adapter: builds the app-kit product from the environment (`configFromEnv`: `MONGODB_URI`, the product's
 * control database, `CONNECT_SECRET`, plus optional tuning) and the project files (manifest with feature schemas inlined, string
 * catalogs). A Portal connects at `/.well-known/ss-connect` with the connect secret; the connection and every generated secret are kept in the control database. This is the only place
 * that reads the environment.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { configFromEnv, createLogger, createMongoStores, createProduct } from '@ss/app-kit';
import { INDEXES, MIGRATIONS } from './db.js';
import { hashKey, newId, stableId } from './ids.js';
import { PRIVACY } from './privacy.js';

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
	transition_not_allowed: { status: 409, title: 'The order cannot move to that status' },
	actor_not_allowed: { status: 403, title: 'You may not make this move' },
	status_unchanged: { status: 409, title: 'The order already has that status' },
	unknown_status: { status: 422, title: 'Unknown status' },
	serials_missing: { status: 409, title: 'Serials are missing' },
	tracking_missing: { status: 409, title: 'A tracking number is required' },
	dispatch_video_missing: { status: 409, title: 'A dispatch video is required' },
	refund_incomplete: { status: 409, title: 'Refunds do not cover what was paid' },
	balance_due: { status: 409, title: 'The order is not paid in full' },
	reason_required: { status: 422, title: 'A reason is required' },
	reason_not_allowed: { status: 422, title: 'That reason is not allowed for this move' },
	order_changed: { status: 409, title: 'The order changed meanwhile; read it again' },
	not_cancellable: { status: 409, title: 'The order can no longer be cancelled' },
	risk_rejected: { status: 422, title: 'The order was refused by the risk rules' },
	duplicate_order: { status: 409, title: 'An order with this number already exists' },
	refund_exceeds_paid: { status: 409, title: 'The refund is larger than what is held' },
	overpayment: { status: 409, title: 'The payment is larger than the balance due' },
	partial_refund_disabled: { status: 409, title: 'Refunds must return everything held' },
	ledger_full: { status: 409, title: 'The order has too many ledger entries' },
	serial_taken: { status: 409, title: 'The serial is on another order' },
	order_closed: { status: 409, title: 'The order is closed' },
	limit_reached: { status: 409, title: 'A limit is reached' },
	mapping_unknown: { status: 422, title: 'Unknown mapping' },
	csv_invalid: { status: 422, title: 'The file is not a valid import' },
	message_not_found: { status: 404, title: 'No such message' },
});

/**
 * @typedef {object} OrdersApp
 * @property {any} product app-kit product
 * @property {() => number} now
 * @property {(prefix: string) => string} newId
 * @property {(prefix: string, text: string) => string} stableId
 * @property {(websiteId: string, key: string) => string} hashKey
 * @property {Record<string, Record<string, string>>} strings
 * @property {() => Promise<void>} close pooled merchant connections and the control database client
 */

/**
 * Build the product.
 * @param {{ env?: Record<string, string | undefined>, root?: string, assets?: { manifest: any, strings: Record<string, Record<string, string>> },
 *   overrides?: Record<string, any> }} [options]
 *   `assets` (the Next.js build: app/_lib/assets.js) replaces reading manifest.json, schemas/ and strings/ from `root`
 *   `overrides` are passed to app-kit `createProduct` (tests: `now`, `fetch`, `logger`, `manifest`, `outboundSend`, …)
 * @returns {Promise<OrdersApp>}
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
	/* v8 ignore start -- a control database is only configured in deployments */
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
		newId,
		stableId,
		hashKey,
		strings,
		close: async () => {
			await product.close?.();
			await controlClient?.close();
		},
	};
};
