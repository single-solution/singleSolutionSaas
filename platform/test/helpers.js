import { randomBytes } from 'node:crypto';
import { afterEach, expect } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { generateSigningKey } from '@ss/protocol';
import { loadConfig } from '../src/infra/config.js';

export const T0 = Date.parse('2026-10-01T10:00:00Z');
export const PORTAL_URL = 'https://portal.test';
export const MERCHANT = 'mer_0123456789abcdefghjkmnpq';
export const MERCHANT_2 = 'mer_1123456789abcdefghjkmnpq';
export const WEBSITE = 'web_0123456789abcdefghjkmnpq';

/** @type {Set<(testName: string) => Promise<void>>} */
const releasers = new Set();
// databases a test opened are wiped and recycled when it ends (see startMongo)
afterEach(async () => {
	const name = expect.getState().currentTestName ?? '';
	for (const release of releasers) await release(name);
});

/**
 * Databases of one test file on the run's shared replica set (`TEST_MONGODB_URI`, started once by
 * the `@ss/config` Mongo global setup; a private one is started when the variable is absent, e.g. a run without the global setup).
 *
 * Every name maps to a database of this file (`t_<random>_<n>`), so test files never share data, and `stop()`
 * drops them. Creating collections and indexes dominates test time, so a database first opened inside a test is
 * **recycled** when that test ends: its documents are deleted (collections and indexes stay) and the next new name
 * gets it. Databases opened in hooks (`beforeAll`) live until `stop()`. `db(name, { fresh: true })` always creates
 * a new database (for tests that inspect index or collection creation).
 */
export const startMongo = async () => {
	const shared = process.env.TEST_MONGODB_URI;
	// TTL monitor off, as in the @ss/config Mongo setup: expiry follows the injected clock, never the wall clock
	const replSet = shared
		? null
		: await MongoMemoryReplSet.create({
				replSet: { count: 1, storageEngine: 'wiredTiger', args: ['--setParameter', 'ttlMonitorEnabled=false'] },
			});
	const uri = shared ?? /** @type {MongoMemoryReplSet} */ (replSet).getUri();
	const client = await new MongoClient(uri).connect();
	const prefix = `t_${randomBytes(5).toString('hex')}`;
	let counter = 0;
	/** @type {Set<string>} every physical database of this file */
	const created = new Set();
	/** @type {Map<string, { physical: string, test: string | null }>} logical name → physical database */
	const assigned = new Map();
	/** @type {string[]} wiped databases ready for reuse */
	const free = [];
	/** @param {string} [name] @param {{ fresh?: boolean }} [options] */
	const dbName = (name = 'main', { fresh = false } = {}) => {
		const existing = assigned.get(name);
		if (existing) return existing.physical;
		const test = expect.getState().currentTestName ?? null;
		const physical = (!fresh && free.shift()) || `${prefix}_${(counter += 1)}`;
		created.add(physical);
		assigned.set(name, { physical, test });
		return physical;
	};
	/** @param {string} testName */
	const release = async (testName) => {
		for (const [name, entry] of [...assigned]) {
			if (entry.test === null || entry.test !== testName) continue;
			assigned.delete(name);
			const db = client.db(entry.physical);
			const collections = await db.listCollections({}, { nameOnly: true }).toArray();
			await Promise.all(
				collections.filter((c) => !c.name.startsWith('system.')).map((c) => db.collection(c.name).deleteMany({})),
			);
			free.push(entry.physical);
		}
	};
	releasers.add(release);
	return {
		uri,
		client,
		dbName,
		/** @param {string} [name] @param {{ fresh?: boolean }} [options] */
		db: (name, options) => client.db(dbName(name, options)),
		stop: async () => {
			releasers.delete(release);
			try {
				await Promise.all(
					[...created].map((name) =>
						client
							.db(name)
							.dropDatabase()
							.catch(() => undefined),
					),
				);
			} finally {
				await client.close();
				await replSet?.stop();
			}
		},
	};
};

/** Controllable clock. */
export const createClock = (start = T0) => {
	let t = start;
	return {
		now: () => t,
		/** @param {number} ms */
		advance: (ms) => {
			t += ms;
		},
		/** @param {number} ms */
		set: (ms) => {
			t = ms;
		},
	};
};

/** Logger that records entries. */
export const createTestLogger = () => {
	/** @type {Array<{ level: string, msg: string, fields?: Record<string, unknown> }>} */
	const entries = [];
	/**
	 * @param {Record<string, unknown>} base
	 * @returns {any}
	 */
	const make = (base) => {
		/** @param {string} level */
		const at = (level) => (/** @type {string} */ msg, /** @type {Record<string, unknown> | undefined} */ fields) => {
			entries.push({ level, msg, fields: { ...base, ...(fields ?? {}) } });
		};
		return {
			debug: at('debug'),
			info: at('info'),
			warn: at('warn'),
			error: at('error'),
			child: (/** @type {Record<string, unknown>} */ more) => make({ ...base, ...more }),
		};
	};
	return { logger: make({}), entries };
};

/** @param {number} n */
export const b64 = (n, fill = 7) => Buffer.alloc(n, fill).toString('base64');

/**
 * A complete, valid environment (only the database and tuning live there).
 * @param {Record<string, string | undefined>} [overrides]
 */
export const testEnv = async (overrides = {}) => ({
	NODE_ENV: 'test',
	MONGODB_URI: 'mongodb://127.0.0.1:27017/ss_portal_test',
	...overrides,
});

/** The environment of a production Portal (a bucket is required there). */
export const PRODUCTION_ENV = Object.freeze({
	NODE_ENV: 'production',
	STORAGE_ENDPOINT: 'https://r2.example.net',
	STORAGE_BUCKET: 'ss-assets',
	STORAGE_ACCESS_KEY_ID: 'AK',
	STORAGE_SECRET_ACCESS_KEY: 'SK',
});

/**
 * A complete system state (generated secrets and settings, as `infra/system.js` keeps them in the database), with
 * fresh signing keys: Portal keys `portal-2026-10` (signs) and `portal-2026-04`, website-key signer `website-2026-10`.
 * @param {Partial<import('../src/infra/config.js').SystemState>} [overrides]
 * @returns {Promise<import('../src/infra/config.js').SystemState>}
 */
export const testSystem = async (overrides = {}) => {
	const { privateJwk } = await generateSigningKey({ kid: 'portal-2026-10' });
	const { privateJwk: previous } = await generateSigningKey({ kid: 'portal-2026-04' });
	const { privateJwk: website } = await generateSigningKey({ kid: 'website-2026-10' });
	return {
		mail: null,
		signingKeys: [privateJwk, previous],
		websiteKeySigningKeys: [website],
		keks: [
			{ id: 'kek-2', key: Buffer.alloc(32, 2) },
			{ id: 'kek-1', key: Buffer.alloc(32, 1) },
		],
		sessionSecret: Buffer.alloc(32, 3),
		websiteKeyPepper: Buffer.alloc(32, 4),
		idempotencySecret: Buffer.alloc(32, 5),
		...overrides,
	};
};

/**
 * @param {Record<string, string | undefined>} [overrides] environment
 * @param {Partial<import('../src/infra/config.js').SystemState>} [system] system state
 * @param {Partial<import('../src/infra/config.js').EnvConfig>} [fixed] fixed values replaced (e.g. a smaller budget)
 */
export const testConfig = async (overrides = {}, system = {}, fixed = {}) =>
	loadConfig(await testEnv(overrides), await testSystem(system), { baseUrl: PORTAL_URL, overrides: fixed });
