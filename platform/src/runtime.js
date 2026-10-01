/**
 * Process-wide Portal instance for the Next.js adapters. Built lazily on first use (never at import or build
 * time), from the environment, and cached on `globalThis` so warm serverless invocations reuse it. Configuration
 * errors throw on first use — and at server start through `instrumentation.js` — so a misconfigured deployment
 * fails fast.
 * @module
 */
import { loadConfig } from './infra/config.js';
import { getMongoClient } from './infra/db.js';
import { createLogger } from './infra/logger.js';
import { modules as defaultModules } from './modules/index.js';
import { createPortal } from './portal.js';

const KEY = Symbol.for('ss.platform.portal');

/**
 * @param {{ env?: Record<string, string | undefined>, modules?: ReadonlyArray<Readonly<import('./infra/modules.js').ModuleDefinition>>,
 *   write?: (line: string) => void }} [options]
 * @returns {import('./portal.js').Portal}
 */
export const getPortal = ({ env = process.env, modules = defaultModules, write } = {}) => {
	const store = /** @type {any} */ (globalThis);
	if (store[KEY]) return store[KEY];
	const config = loadConfig(env);
	const logger = createLogger({ level: config.logLevel, ...(write ? { write } : {}) }).child({
		service: 'portal',
		env: config.env,
	});
	const client = getMongoClient({ uri: config.mongo.uri, maxPoolSize: config.mongo.maxPoolSize });
	const portal = createPortal({ config, db: client.db(config.mongo.dbName), modules, logger });
	store[KEY] = portal;
	return portal;
};

/** Forget the cached instance (tests). */
export const resetPortal = () => {
	const store = /** @type {Record<symbol, unknown>} */ (globalThis);
	delete store[KEY];
};
