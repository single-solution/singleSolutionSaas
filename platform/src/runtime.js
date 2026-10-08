/**
 * Process-wide Portal instance for the Next.js adapters and the scripts. Built lazily on first use (never at import or
 * build time) and cached on `globalThis`, so warm serverless invocations reuse it:
 *
 * 1. the environment (`MONGODB_URI`, `PORTAL_URL`, `ENCRYPTION_KEY`) is validated — a misconfigured
 *    deployment fails fast, naming the variable (never its value);
 * 2. the system state is loaded from the control database: secrets generated on first start, settings recorded by
 *    admins (`infra/system.js`);
 * 3. indexes and migrations are applied once per schema version, under a lock (no manual step for the owner);
 * 4. every few seconds a cheap read of the settings version decides whether another instance changed the settings
 *    (or rotated a key), and the Portal is rebuilt.
 * @module
 */
import { createHash } from 'node:crypto';
import { buildConfig, loadEnv } from './infra/config.js';
import { getMongoClient } from './infra/db.js';
import { createLogger } from './infra/logger.js';
import { createSystemStore } from './infra/system.js';
import { modules as defaultModules } from './modules/index.js';
import { createPortal } from './portal.js';

const KEY = Symbol.for('ss.platform.portal');
/** Settings changes on other instances are noticed within this delay. */
const SETTINGS_RECHECK_MS = 5_000;

/**
 * @typedef {object} Entry
 * @property {import('./portal.js').Portal} portal
 * @property {import('./infra/system.js').SystemStore} system
 * @property {number} version settings version the portal was built from
 * @property {number} checkedAt
 */

/** @returns {{ entry?: Entry, pending?: Promise<Entry> | null, options?: GetPortalOptions }} */
const shared = () => {
	const store = /** @type {any} */ (globalThis);
	return (store[KEY] ??= {});
};

/**
 * Fingerprint of every collection definition and migration id: indexes and migrations are applied when it changes.
 * @param {import('./portal.js').Portal} portal
 */
const schemaFingerprint = (portal) =>
	createHash('sha256')
		.update(
			JSON.stringify({
				collections: portal.registry.all().map((def) => [def.name, def.indexes, def.ttl ?? null]),
				migrations: portal.modules.migrations().map((m) => m.id),
			}),
		)
		.digest('hex');

/**
 * Apply indexes and migrations once per schema version (idempotent; migrations hold their own lock).
 * @param {import('./portal.js').Portal} portal
 * @param {import('./infra/system.js').SystemStore} system
 * @param {import('./infra/logger.js').Logger} logger
 */
const prepareSchema = async (portal, system, logger) => {
	const fingerprint = schemaFingerprint(portal);
	if ((await system.appliedSchema()) === fingerprint) return { applied: false };
	await portal.ensureIndexes();
	const migrated = await portal.migrate();
	if (migrated && /** @type {any} */ (migrated).locked) return { applied: false };
	await system.recordSchema(fingerprint);
	logger.info('schema prepared', { fingerprint: fingerprint.slice(0, 12) });
	return { applied: true };
};

/**
 * @typedef {{ env?: Record<string, string | undefined>, modules?: ReadonlyArray<Readonly<import('./infra/modules.js').ModuleDefinition>>,
 *   write?: (line: string) => void, now?: () => number }} GetPortalOptions
 */

/**
 * The Portal of this process (built or rebuilt when needed). Options given once are kept for later rebuilds (a
 * settings change); by default everything comes from `process.env`.
 * @param {GetPortalOptions} [given]
 * @returns {Promise<import('./portal.js').Portal>}
 */
export const getPortal = async (given) => {
	const store = shared();
	if (given) store.options = given;
	const { env = process.env, modules = defaultModules, write, now = Date.now } = store.options ?? {};
	if (store.entry && now() - store.entry.checkedAt < SETTINGS_RECHECK_MS) return store.entry.portal;
	store.pending ??= (async () => {
		if (store.entry) {
			const version = await store.entry.system.version();
			if (version === store.entry.version) {
				store.entry = { ...store.entry, checkedAt: now() };
				return store.entry;
			}
		}
		const envConfig = loadEnv(env);
		const client = getMongoClient({ uri: envConfig.mongo.uri, maxPoolSize: envConfig.mongo.maxPoolSize });
		const db = client.db(envConfig.mongo.dbName);
		const system = createSystemStore(db, { encryptionKey: envConfig.encryptionKey, now });
		const { state, version } = await system.load();
		const config = buildConfig(envConfig, state);
		const logger = createLogger({ level: config.logLevel, ...(write ? { write } : {}) }).child({
			service: 'portal',
			env: config.env,
		});
		const portal = createPortal({ config, db, modules, logger, system });
		await prepareSchema(portal, system, logger);
		/** @type {Entry} */
		const entry = { portal, system, version, checkedAt: now() };
		store.entry = entry;
		return entry;
	})().finally(() => {
		store.pending = null;
	});
	return (await store.pending).portal;
};

/** Forget the cached instance: the next `getPortal()` rebuilds it (after a settings change; tests). */
export const resetPortal = () => {
	const store = shared();
	delete store.entry;
	store.pending = null;
};
