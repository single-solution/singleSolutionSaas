// Docker-free local database for development: a single-node replica set on this machine (port 27999, or MONGO_PORT).
// `pnpm --filter @ss/platform db:memory` keeps the data in memory (lost on exit); `pnpm --filter @ss/platform db:local`
// keeps it in platform/.mongo-data (git-ignored), so the Portal, the products and their merchant databases survive a
// restart. It prints MONGODB_URI for the Portal; every product uses the same server with its own database name
// (mongodb://127.0.0.1:27999/ss_<product>?replicaSet=testset). Keep it running while `next dev` runs.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { MongoClient } from 'mongodb';
import { MongoBinary, MongoMemoryReplSet } from 'mongodb-memory-server';

const port = Number(process.env.MONGO_PORT ?? 27999);
const keep = process.argv.includes('--keep');
const SET = 'testset';

/** @param {() => Promise<unknown>} stop */
const ready = (stop) => {
	process.stdout.write(
		`MONGODB_URI=mongodb://127.0.0.1:${port}/ss_portal?replicaSet=${SET}\n` +
			`${keep ? `(data kept in ${path.join('platform', '.mongo-data')}; ` : '(data lost on exit; '}ctrl-c to stop)\n`,
	);
	const end = async () => {
		await stop();
		process.exit(0);
	};
	process.on('SIGINT', end);
	process.on('SIGTERM', end);
};

if (!keep) {
	const replSet = await MongoMemoryReplSet.create({
		replSet: { count: 1, storageEngine: 'wiredTiger', name: SET },
		instanceOpts: [{ port }],
	});
	ready(() => replSet.stop());
} else {
	// mongod itself on a data folder of its own: the replica set is set up once, then reused on every start
	const dbPath = path.join(import.meta.dirname, '..', '.mongo-data');
	await mkdir(dbPath, { recursive: true });
	const mongod = spawn(
		await MongoBinary.getPath(),
		['--replSet', SET, '--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1'],
		{ stdio: ['ignore', 'ignore', 'inherit'] },
	);
	mongod.on('exit', (code) => {
		if (code) process.stderr.write(`mongod stopped (${code})\n`);
		process.exit(code ?? 0);
	});
	const client = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, { serverSelectionTimeoutMS: 1000 });
	for (let tries = 0; ; tries += 1) {
		try {
			await client.connect();
			break;
		} catch (error) {
			if (tries > 30) throw error;
			await sleep(500);
		}
	}
	const admin = client.db('admin');
	try {
		await admin.command({ replSetGetStatus: 1 });
	} catch (error) {
		if (/** @type {{ codeName?: string }} */ (error).codeName !== 'NotYetInitialized') throw error;
		await admin.command({ replSetInitiate: { _id: SET, members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
	}
	while (!(await admin.command({ hello: 1 })).isWritablePrimary) await sleep(250);
	await client.close();
	ready(async () => {
		mongod.removeAllListeners('exit');
		mongod.kill('SIGINT');
		await new Promise((resolve) => mongod.once('exit', resolve));
	});
}
