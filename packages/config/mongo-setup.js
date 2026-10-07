/**
 * Vitest global setup (`defineUnitConfig({ mongo: true })`): ONE single-node MongoMemoryReplSet for the whole run,
 * shared by every test file. Its URI is exposed as `TEST_MONGODB_URI` (inherited by the test workers); test helpers
 * give each test file its own databases on it. When `TEST_MONGODB_URI` is already set (an outer run, or a real
 * server), nothing is started. Needs the optional peers `mongodb` and `mongodb-memory-server`.
 * @module
 */
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

/** Shared across every project of a run (each project's global setup may be loaded as its own module instance). */
const KEY = Symbol.for('@ss/config/mongo-setup');

/** @typedef {{ users: number, ready: Promise<{ replSet: MongoMemoryReplSet, uri: string }> }} SharedMongo */

/** @returns {Promise<{ replSet: MongoMemoryReplSet, uri: string }>} */
const start = async () => {
	// the TTL monitor is off: it deletes documents by **wall-clock** time, while every test runs on an injected clock
	// (`createClock`, starting at a fixed T0). Expiry stays deterministic because the code compares `expireAt` with the
	// injected `now()`; with the monitor on, a short-lived token or session whose injected expiry lies in the real past
	// vanished whenever a monitor pass (every 60 s) fell inside the test (flaky under load).
	const replSet = await MongoMemoryReplSet.create({
		replSet: {
			count: 1,
			storageEngine: 'wiredTiger',
			args: ['--setParameter', 'diagnosticDataCollectionEnabled=false', '--setParameter', 'ttlMonitorEnabled=false'],
		},
	});
	await replSet.waitUntilRunning();
	const uri = replSet.getUri();
	// test-only durability trade-off: majority writes (the driver default) and commits are acknowledged without
	// waiting for a journal flush, which dominates test time on laptops; semantics (transactions, indexes) are unchanged
	const client = await new MongoClient(uri, { directConnection: true }).connect();
	try {
		const admin = client.db('admin');
		const { config } = await admin.command({ replSetGetConfig: 1 });
		if (config.writeConcernMajorityJournalDefault !== false) {
			await admin.command({
				replSetReconfig: { ...config, version: config.version + 1, writeConcernMajorityJournalDefault: false },
			});
		}
	} finally {
		await client.close();
	}
	return { replSet, uri };
};

/** @type {Record<symbol, SharedMongo | undefined>} */
const shared = /** @type {any} */ (globalThis);

export const setup = async () => {
	// an outer run (or a real server) already provides the database
	if (process.env.TEST_MONGODB_URI && shared[KEY] === undefined) return;
	const state = (shared[KEY] ??= { users: 0, ready: start() });
	state.users += 1;
	process.env.TEST_MONGODB_URI = (await state.ready).uri;
};

export const teardown = async () => {
	const state = shared[KEY];
	if (state === undefined) return;
	state.users -= 1;
	if (state.users > 0) return;
	shared[KEY] = undefined;
	delete process.env.TEST_MONGODB_URI;
	await (await state.ready).replSet.stop();
};
