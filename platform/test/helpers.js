import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { generateSigningKey } from '@ss/protocol';
import { loadConfig } from '../src/infra/config.js';

export const T0 = Date.parse('2026-10-01T10:00:00Z');
export const PORTAL_URL = 'https://portal.test';
export const MERCHANT = 'mer_0123456789abcdefghjkmnpq';
export const MERCHANT_2 = 'mer_1123456789abcdefghjkmnpq';
export const WEBSITE = 'web_0123456789abcdefghjkmnpq';

/** Single-node replica set for one test file. */
export const startMongo = async () => {
	const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
	const uri = replSet.getUri();
	const client = await new MongoClient(uri).connect();
	return {
		uri,
		client,
		/** @param {string} name */
		db: (name) => client.db(name),
		stop: async () => {
			await client.close();
			await replSet.stop();
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
 * A complete, valid environment (fresh signing keys).
 * @param {Record<string, string | undefined>} [overrides]
 */
export const testEnv = async (overrides = {}) => {
	const { privateJwk } = await generateSigningKey({ kid: 'portal-2026-10' });
	const { privateJwk: previous } = await generateSigningKey({ kid: 'portal-2026-04' });
	return {
		NODE_ENV: 'test',
		MONGODB_URI: 'mongodb://127.0.0.1:27017/ss_portal_test',
		PORTAL_URL,
		PORTAL_SIGNING_KEYS: JSON.stringify([privateJwk, previous]),
		SECRETS_KEK: `kek-2:${b64(32, 2)},kek-1:${b64(32, 1)}`,
		SESSION_SECRET: b64(32, 3),
		WEBSITE_KEY_PEPPER: b64(32, 4),
		CRON_SECRET: 'c'.repeat(40),
		...overrides,
	};
};

/** @param {Record<string, string | undefined>} [overrides] */
export const testConfig = async (overrides = {}) => loadConfig(await testEnv(overrides));
