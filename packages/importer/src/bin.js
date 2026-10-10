#!/usr/bin/env node
/* v8 ignore start — process wiring only; everything else is tested through main(). */
import { MongoClient } from 'mongodb';
import { main } from './cli.js';

process.exitCode = await main(process.argv.slice(2), {
	io: {
		out: (/** @type {string} */ text) => {
			process.stdout.write(text);
		},
		err: (/** @type {string} */ text) => {
			process.stderr.write(text);
		},
	},
	env: process.env,
	fetch: globalThis.fetch,
	// the store database is only read: a secondary is preferred, so the shop's primary is not loaded
	connect: async (uri) => {
		const client = await new MongoClient(uri, { readPreference: 'secondaryPreferred', maxPoolSize: 2 }).connect();
		return { db: client.db(), close: () => client.close() };
	},
});
/* v8 ignore stop */
