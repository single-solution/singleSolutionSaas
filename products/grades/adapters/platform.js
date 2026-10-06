/**
 * Platform adapter: builds the app-kit product from the environment (`configFromEnv`: only `DATABASE_URI`, the
 * product's control database, plus optional tuning) and the project files (manifest with feature schemas inlined, string
 * catalogs). The Portal connection is made at `/setup` and, like every secret, kept in the control database. This is the only place that reads the
 * environment.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { configFromEnv, createLogger, createMongoStores, createProduct } from '@ss/app-kit';
import { INDEXES, MIGRATIONS } from './db.js';
import { createReportTokens, stableId } from './tokens.js';

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
 * Personal data this product stores (drives the Portal-signed POST /v1/data:export and /v1/data:anonymize). Grades
 * holds items, tiers, units and inspections — no shopper data — so both answer with empty results. The inspector's
 * name is staff data recorded on inspections by the merchant's own systems.
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
	tier_unknown: { status: 422, title: 'The tier is not defined for this website' },
	tier_not_applicable: { status: 422, title: 'The tier does not apply to this item' },
	unit_limit: { status: 409, title: 'The item has the most graded units allowed' },
	serial_taken: { status: 409, title: 'Another unit has this serial' },
	checklist_missing: { status: 422, title: 'No checklist applies to this unit' },
	inspection_completed: { status: 409, title: 'The inspection is already completed' },
	inspection_incomplete: { status: 422, title: 'The inspection is not complete' },
	photo_limit: { status: 409, title: 'This checklist item has the most photos allowed' },
	not_inspected: { status: 409, title: 'The unit has no completed inspection yet' },
	storage_unavailable: { status: 503, title: 'The storage connector is not available' },
});

/**
 * @typedef {object} GradesApp
 * @property {any} product app-kit product
 * @property {import('./tokens.js').ReportTokens} reports
 * @property {() => number} now
 * @property {(text: string) => string} hash
 * @property {Record<string, Record<string, string>>} strings
 * @property {() => Promise<void>} close pooled merchant connections and the control database client
 */

/**
 * Build the product.
 * @param {{ env?: Record<string, string | undefined>, root?: string, overrides?: Record<string, any> }} [options]
 *   `overrides` are passed to app-kit `createProduct` (tests: `now`, `fetch`, `logger`, `manifest`, `outboundSend`, …)
 * @returns {Promise<GradesApp>}
 */
export const createPlatform = async ({ env = process.env, root = process.cwd(), overrides = {} } = {}) => {
	const config = configFromEnv(env);
	const [manifest, strings] = await Promise.all([loadManifest(root), loadStrings(root)]);
	/** @type {unknown} */
	let stores;
	/** @type {{ close: () => Promise<void> } | null} */
	let controlClient = null;
	/* v8 ignore start -- production control database (tests use the in-memory stores) */
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
	// generated secrets and the Portal connection live in the control database (set up at /setup)
	await product.ready();
	return {
		product,
		reports: createReportTokens(),
		now,
		hash: stableId,
		strings,
		close: async () => {
			await product.close?.();
			await controlClient?.close();
		},
	};
};
