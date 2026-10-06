/**
 * Platform adapter: builds the app-kit product from the environment (`configFromEnv`: SS_PORTAL_URL, SS_APP_ID,
 * SS_APP_SIGNING_KEY, SS_REGISTRATION_TOKEN_HASH, SS_PRODUCT_DB_URI, SS_LOG_LEVEL) and the project files (manifest with
 * feature schemas inlined, string catalogs). This is the only place that reads the environment.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { configFromEnv, createLogger, createMongoStores, createProduct } from '@ss/app-kit';
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

/**
 * Build the product.
 * @param {{ env?: Record<string, string | undefined>, root?: string, overrides?: Record<string, unknown> }} [options]
 */
export const createPlatform = async ({ env = process.env, root = process.cwd(), overrides = {} } = {}) => {
	const config = configFromEnv(env);
	const { portalUrl, signingKey, registrationTokenHash } = config;
	if (!portalUrl || !signingKey || !registrationTokenHash) {
		const missing = [
			['SS_PORTAL_URL', portalUrl],
			['SS_APP_SIGNING_KEY', signingKey],
			['SS_REGISTRATION_TOKEN_HASH', registrationTokenHash],
		].filter(([, value]) => !value);
		throw new Error(`Missing environment variables: ${missing.map(([name]) => name).join(', ')} (run \`ss dev env\`)`);
	}
	const [manifest, strings] = await Promise.all([loadManifest(root), loadStrings(root)]);
	/** @type {ReturnType<typeof createMongoStores> | undefined} */
	let stores;
	if (config.productDbUri) {
		const { MongoClient } = await import('mongodb');
		const client = new MongoClient(config.productDbUri, config.productDbOptions);
		const mongoStores = createMongoStores({ db: client.db() });
		await mongoStores.ensureIndexes();
		stores = mongoStores;
	}
	return createProduct({
		manifest,
		strings,
		portalUrl,
		appId: config.appId,
		signingKey,
		registrationTokenHash,
		logger: createLogger({ level: config.logLevel }),
		privacy: PRIVACY,
		devProbes: true, // /v1/ss-probe/* for `ss certify`; app-kit never mounts them when NODE_ENV=production
		// SSRF policy for merchant databases and connectors: in development the `ss dev` client database and local mocks
		// live on loopback; app-kit ignores the allowlist when NODE_ENV=production
		outbound: {
			allowHosts: config.outboundAllowHosts.length > 0 ? config.outboundAllowHosts : ['127.0.0.1', 'localhost', '::1'],
		},
		...(stores === undefined ? {} : { stores }),
		...overrides,
	});
};
