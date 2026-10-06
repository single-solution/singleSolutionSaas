/**
 * Platform adapter: builds the app-kit product from the environment (`configFromEnv`: SS_PORTAL_URL, SS_APP_ID,
 * SS_APP_SIGNING_KEY, SS_REGISTRATION_TOKEN_HASH, SS_PRODUCT_DB_URI, SS_LOG_LEVEL, SS_OUTBOUND_ALLOW_HOSTS; plus
 * ALERTS_TOKEN_SECRET and CRON_SECRET) and the project files (manifest with feature schemas inlined, string catalogs).
 * This is the only place that reads the environment.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { configFromEnv, createLogger, createMongoStores, createProduct } from '@ss/app-kit';
import { addressFor, contactIdOf } from '../core/contact.js';
import { INDEXES, MIGRATIONS, repositoriesFor } from './db.js';
import { createSiteRegistry } from './registry.js';
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
 * @property {import('./registry.js').SiteRegistry} registry
 * @property {string | null} cronSecret
 * @property {string} portalUrl
 * @property {string} instanceId this process (message lease owner)
 * @property {() => number} now
 * @property {(prefix: string) => string} newId
 * @property {(prefix: string, key: string) => string} stableId
 * @property {Record<string, Record<string, string>>} strings
 * @property {() => Promise<void>} close pooled merchant connections and the control database client
 */

/**
 * Personal data export / anonymisation (Portal-signed standard routes). A subject is a customer id (`customerId`) or a
 * contact (`email` / `phone`, matched through the keyed contact hash).
 * @param {{ repoFor: ReturnType<typeof repositoriesFor>, tokens: import('./tokens.js').Tokens, now: () => number }} deps
 */
export const createPrivacyHandlers = ({ repoFor, tokens, now }) => {
	/** @param {{ websiteId: string, subject?: Record<string, string> }} input */
	const subjectsOf = ({ websiteId, subject }) => {
		if (!subject) return null;
		/** @type {Array<{ customerId?: string, contactKey?: string }>} */
		const out = [];
		if (typeof subject.customerId === 'string') out.push({ customerId: subject.customerId });
		for (const [field, channel] of /** @type {const} */ ([
			['email', 'email'],
			['phone', 'sms'],
		])) {
			const address = addressFor(channel, subject[field]);
			if (address) out.push({ contactKey: tokens.contactKey(websiteId, contactIdOf(address)) });
		}
		return out;
	};
	return Object.freeze({
		/** @param {{ websiteId: string, subject?: Record<string, string>, requestId?: string }} input */
		export: async (input) => {
			const repos = await repoFor(input.websiteId);
			const subjects = subjectsOf(input);
			const subscriptions = subjects
				? (await Promise.all(subjects.map((subject) => repos.subscriptions.ofSubject(subject)))).flat()
				: await repos.subscriptions.list({ fetchLimit: 10_000 });
			const contactKeys = [...new Set(subscriptions.map((/** @type {any} */ sub) => sub.contactKey))];
			const messages = (await Promise.all(contactKeys.map((key) => repos.messages.ofContact(key)))).flat();
			return {
				websiteId: input.websiteId,
				...(input.subject ? { subject: input.subject } : {}),
				exportedAt: new Date(now()).toISOString(),
				collections: { subscriptions, messages },
			};
		},
		/** @param {{ websiteId: string, subject?: Record<string, string>, requestId?: string }} input */
		anonymize: async (input) => {
			const repos = await repoFor(input.websiteId);
			const subjects = subjectsOf(input) ?? [];
			let subscriptions = 0;
			let messages = 0;
			for (const subject of subjects) {
				const found = await repos.subscriptions.ofSubject(subject);
				for (const key of new Set(
					[...found.map((/** @type {any} */ sub) => sub.contactKey), subject.contactKey].filter(Boolean),
				))
					messages += await repos.messages.anonymize(/** @type {string} */ (key));
				subscriptions += await repos.subscriptions.anonymize(subject);
			}
			return { websiteId: input.websiteId, anonymized: { subscriptions, messages } };
		},
	});
};

/**
 * Build the product.
 * @param {{ env?: Record<string, string | undefined>, root?: string, overrides?: Record<string, any> }} [options]
 *   `overrides` are passed to app-kit `createProduct` (tests: `now`, `fetch`, `logger`, `manifest`, `outboundSend`, …)
 * @returns {Promise<AlertsApp>}
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
	/** @type {any} */
	let sites = null;
	/** @type {{ close: () => Promise<void> } | null} */
	let controlClient = null;
	if (config.productDbUri) {
		const { MongoClient } = await import('mongodb');
		const client = new MongoClient(config.productDbUri, config.productDbOptions);
		controlClient = client;
		const mongoStores = createMongoStores({ db: client.db() });
		await mongoStores.ensureIndexes();
		stores = mongoStores;
		sites = client.db().collection('ss_alerts_sites');
	}
	const now = typeof overrides.now === 'function' ? overrides.now : Date.now;
	const tokens = createTokens({ secret: tokenSecret({ secret: env.ALERTS_TOKEN_SECRET, signingKey }), now });
	/** @type {any} */
	let product = null;
	const repoFor = repositoriesFor({ data: { forWebsite: (id, stamp) => product.data.forWebsite(id, stamp) } }, { now });
	product = createProduct(
		/** @type {any} */ ({
			manifest,
			strings,
			portalUrl,
			appId: config.appId,
			signingKey,
			registrationTokenHash,
			logger: createLogger({ level: config.logLevel }),
			privacy: createPrivacyHandlers({ repoFor, tokens, now }),
			problemCodes: PROBLEM_CODES,
			data: { indexes: [...INDEXES], migrations: MIGRATIONS },
			devProbes: true, // /v1/ss-probe/* for `ss certify`; app-kit never mounts them when NODE_ENV=production
			// SSRF policy for merchant databases and providers: in development the `ss dev` client database and local
			// mock providers live on loopback; app-kit ignores the allowlist when NODE_ENV=production
			outbound: {
				allowHosts: config.outboundAllowHosts.length > 0 ? config.outboundAllowHosts : ['127.0.0.1', 'localhost', '::1'],
			},
			...(stores === undefined ? {} : { stores }),
			...overrides,
		}),
	);
	return {
		product,
		tokens,
		registry: createSiteRegistry({ collection: sites }),
		cronSecret: env.CRON_SECRET && env.CRON_SECRET.length >= 16 ? env.CRON_SECRET : null,
		portalUrl,
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
