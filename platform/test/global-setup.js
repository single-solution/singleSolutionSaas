/**
 * Vitest global setup: ONE single-node MongoMemoryReplSet for the whole run, shared by every test file. Its URI is
 * exposed as `SS_TEST_MONGO_URI` (inherited by the test workers); `startMongo()` in `helpers.js` connects to it and
 * gives each test file its own databases (`t_<random>_…`), dropped when the file finishes.
 */
import { createRequire } from 'node:module';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

// the global setup runs in the root context: resolve the driver from the platform package
/** @type {typeof import('mongodb')} */
const { MongoClient } = createRequire(new URL('../package.json', import.meta.url))('mongodb');

/** @type {MongoMemoryReplSet | null} */
let replSet = null;

export const setup = async () => {
	if (process.env.SS_TEST_MONGO_URI) return;
	replSet = await MongoMemoryReplSet.create({
		replSet: { count: 1, storageEngine: 'wiredTiger', args: ['--setParameter', 'diagnosticDataCollectionEnabled=false'] },
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
	process.env.SS_TEST_MONGO_URI = uri;
};

export const teardown = async () => {
	await replSet?.stop();
	replSet = null;
};
