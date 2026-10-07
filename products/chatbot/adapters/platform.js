/**
 * Platform adapter: builds the app-kit product from the environment (`configFromEnv`: `MONGODB_URI`, the product's
 * control database, `CONNECT_SECRET`, plus optional tuning) and the project files (manifest with feature schemas inlined, string
 * catalogs). A Portal connects at `/.well-known/ss-connect` with the connect secret; the connection and every generated secret are kept in the control database. Registers the AI provider adapters (the merchant's own AI connector); knowledge pages and webhook tools
 * use app-kit's `product.outbound.fetch`. This is the only place that reads the environment.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { configFromEnv, createLogger, createMongoStores, createProduct } from '@ss/app-kit';
import { AI_ADAPTERS } from './ai.js';
import { INDEXES, MIGRATIONS } from './db.js';
import { createTokens, randomBytes, rootSecret, stableId } from './tokens.js';

/**
 * SSRF-guarded outbound HTTP (app-kit `product.outbound.fetch`, `@ss/net` safeFetch under the product's policy).
 * @typedef {(url: string, init?: Record<string, unknown>) => Promise<{ status: number, headers: Record<string, string> | Headers, body: Buffer, url?: string }>} Send
 */

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
		{ name: 'conversations', subjectField: 'customerId', fields: ['contact', 'context', 'last', 'subject', 'custom'] },
		{ name: 'messages', subjectField: 'customerId', fields: ['body', 'payload', 'authorName'] },
		{ name: 'leads', subjectField: 'customerId', fields: ['fields', 'contact'] },
		{ name: 'ratings', subjectField: 'customerId', fields: ['comment'] },
		{ name: 'orders', subjectField: 'customerId', fields: ['customer', 'lines', 'number'] },
		{ name: 'customers', subjectField: 'customerId', fields: ['emails'] },
	],
});

/** Product-specific problem codes (RFC 9457 `type` = `<base>/problems/<code>`). */
export const PROBLEM_CODES = Object.freeze({
	guest_limit_reached: { status: 403, title: 'Sign in to continue the conversation' },
	conversation_closed: { status: 409, title: 'The conversation is closed' },
	message_rejected: { status: 422, title: 'The message was rejected by moderation' },
	too_many_conversations: { status: 429, title: 'Too many open conversations' },
	invalid_marker: { status: 422, title: 'The guest marker is invalid' },
	already_rated: { status: 409, title: 'The conversation was already rated' },
	limit_reached: { status: 409, title: 'A configured limit was reached' },
	invalid_transition: { status: 409, title: 'This status change is not allowed' },
	unknown_tool: { status: 404, title: 'No such tool' },
	tool_failed: { status: 502, title: 'The tool call failed' },
	source_failed: { status: 502, title: 'The page could not be fetched' },
	unknown_flow: { status: 404, title: 'No such flow' },
	unknown_canned_reply: { status: 404, title: 'No such canned reply' },
	ai_unavailable: { status: 503, title: 'AI replies are not available' },
});

/**
 * @typedef {object} ChatbotApp
 * @property {any} product app-kit product
 * @property {import('./tokens.js').Tokens} tokens
 * @property {{ fetch: Send }} outbound app-kit `product.outbound` (SSRF-guarded fetch under the product's outbound policy)
 * @property {() => number} now
 * @property {(text: string) => string} hash
 * @property {(n: number) => Uint8Array} randomBytes
 * @property {Record<string, Record<string, string>>} strings
 * @property {() => Promise<void>} close
 */

/**
 * Build the product.
 * @param {{ env?: Record<string, string | undefined>, root?: string, assets?: { manifest: any, strings: Record<string, Record<string, string>> },
 *   overrides?: Record<string, any> }} [options]
 *   `assets` (the Next.js build: app/_lib/assets.js) replaces reading manifest.json, schemas/ and strings/ from `root`
 *   `overrides` go to app-kit `createProduct` (tests: `now`, `fetch`, `logger`, `manifest`, `outboundSend`, …)
 * @returns {Promise<ChatbotApp>}
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
	// SSRF policy for merchant databases, connectors, knowledge pages and webhook tools: in development the `ss dev`
	// client database and local mocks live on loopback; the allowlist is ignored when NODE_ENV=production
	const outbound = {
		allowHosts: config.outboundAllowHosts.length > 0 ? config.outboundAllowHosts : ['127.0.0.1', 'localhost', '::1'],
	};
	const product = createProduct(
		/** @type {any} */ ({
			manifest,
			strings,
			logger: createLogger({ level: config.logLevel }),
			problems: config.problems,
			privacy: PRIVACY,
			problemCodes: PROBLEM_CODES,
			data: { indexes: [...INDEXES], migrations: MIGRATIONS },
			connectors: { ai: AI_ADAPTERS },
			devProbes: true, // /v1/ss-probe/* for `ss certify`; app-kit never mounts them when NODE_ENV=production
			outbound,
			...(config.connectSecret ? { connectSecret: config.connectSecret } : {}),
			...(stores === undefined ? {} : { stores }),
			...overrides,
		}),
	);
	// generated secrets and the Portal connection live in the control database (made at /.well-known/ss-connect)
	await product.ready();
	const tokens = createTokens({ secret: rootSecret({ secret: product.secret('tokens').toString('base64url') }), now });
	return {
		product,
		tokens,
		outbound: product.outbound,
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
