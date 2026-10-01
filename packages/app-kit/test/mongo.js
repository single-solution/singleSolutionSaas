import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';

/** Start a single-node replica set (transactions, change streams) for one test file. */
export const startMongo = async () => {
	const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
	const uri = replSet.getUri();
	const client = await new MongoClient(uri).connect();
	return {
		uri,
		client,
		/** @param {string} name */
		uriFor: (name) => {
			const url = new URL(uri);
			url.pathname = `/${name}`;
			return url.toString();
		},
		stop: async () => {
			await client.close();
			await replSet.stop();
		},
	};
};
