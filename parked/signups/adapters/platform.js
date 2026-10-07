/**
 * Platform adapter: builds the app-kit product from the environment (`configFromEnv`: `MONGODB_URI`, the product's
 * control database, `CONNECT_SECRET`, plus optional tuning) and the project files (manifest with feature schemas inlined, string
 * catalogs). A Portal connects at `/.well-known/ss-connect` with the connect secret; the connection and every generated secret are kept in the control database. This is the only place that reads the environment.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { configFromEnv, createLogger, createMongoStores, createProduct } from '@ss/app-kit';
import { createSealer, sealSecret } from './crypto.js';
import { INDEXES, MIGRATIONS } from './db.js';

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
	channel_disabled: { status: 422, title: 'This delivery channel is not enabled' },
	identifier_invalid: { status: 422, title: 'Invalid e-mail address or phone number' },
	identifier_blocked: { status: 422, title: 'This e-mail domain is not accepted' },
	identifier_in_use: { status: 409, title: 'The identifier belongs to another account' },
	too_soon: { status: 429, title: 'Wait before asking for another message' },
	send_limit: { status: 429, title: 'Too many messages requested' },
	velocity_limit: { status: 429, title: 'Too many attempts from this network' },
	delivery_failed: { status: 502, title: 'The message could not be delivered' },
	code_invalid: { status: 422, title: 'The code is not valid' },
	code_expired: { status: 422, title: 'The code has expired' },
	attempts_exhausted: { status: 422, title: 'Too many attempts for this code' },
	link_invalid: { status: 422, title: 'The sign-in link is not valid' },
	link_expired: { status: 422, title: 'The sign-in link has expired' },
	redirect_not_allowed: { status: 422, title: 'The redirect is not on this website' },
	consent_required: { status: 422, title: 'Terms must be accepted' },
	account_blocked: { status: 403, title: 'This account is blocked' },
	refresh_invalid: { status: 401, title: 'The refresh token is not valid' },
	refresh_reused: { status: 401, title: 'The refresh token was already used; the session was ended' },
	refresh_conflict: { status: 409, title: 'The session was refreshed concurrently; use the newest token' },
	session_ended: { status: 401, title: 'The session has ended' },
	not_allowed: { status: 403, title: 'This operation is not enabled' },
	data_request_pending: { status: 409, title: 'A deletion is already scheduled' },
});

/**
 * @typedef {object} SignupsApp
 * @property {any} product app-kit product
 * @property {import('./crypto.js').Sealer} sealer
 * @property {string} base the product's public base URL (issuer prefix)
 * @property {() => number} now
 * @property {any} log structured logger (never receives secrets)
 * @property {Record<string, Record<string, string>>} strings
 * @property {() => Promise<void>} close pooled merchant connections and the control database client
 */

/**
 * Build the product.
 * @param {{ env?: Record<string, string | undefined>, root?: string, assets?: { manifest: any, strings: Record<string, Record<string, string>> },
 *   overrides?: Record<string, any> }} [options]
 *   `assets` (the Next.js build: app/_lib/assets.js) replaces reading manifest.json, schemas/ and strings/ from `root`
 *   `overrides` are passed to app-kit `createProduct` (tests: `now`, `fetch`, `logger`, `manifest`, `outboundSend`, …)
 * @returns {Promise<SignupsApp>}
 */
export const createPlatform = async ({ env = process.env, root = process.cwd(), assets, overrides = {} } = {}) => {
	const config = configFromEnv(env);
	const [loaded, strings] = assets
		? [assets.manifest, assets.strings]
		: await Promise.all([loadManifest(root), loadStrings(root)]);
	const manifest = overrides.manifest ?? loaded;
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
	const logger = overrides.logger ?? createLogger({ level: config.logLevel });
	const product = createProduct(
		/** @type {any} */ ({
			manifest,
			strings,
			logger,
			problems: config.problems,
			problemCodes: PROBLEM_CODES,
			data: { indexes: [...INDEXES], migrations: MIGRATIONS },
			// messaging: app-kit's built-in adapters for the Portal providers `generic-http` and `smtp` (no registration)
			// SSRF policy for merchant databases and connectors: in development the local client database and mocks live on
			// loopback; app-kit ignores the allowlist when NODE_ENV=production
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
		// sealing secret generated once and kept in the control database
		sealer: createSealer({ secrets: [sealSecret({ secret: product.secret('seal').toString('base64url') })] }),
		/** this deployment's address (the one the Portal connected to) */
		get base() {
			return product.baseUrl();
		},
		now,
		log: logger,
		strings,
		close: async () => {
			await product.close?.();
			await controlClient?.close();
		},
	};
};
