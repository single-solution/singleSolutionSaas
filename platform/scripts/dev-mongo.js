// Docker-free local database: a single-node in-memory replica set (data is lost on exit).
// `pnpm --filter @ss/platform db:memory` → prints MONGODB_URI; keep it running while `next dev` runs.
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const port = Number(process.env.MONGO_PORT ?? 27999);
const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, instanceOpts: [{ port }] });
const url = new URL(replSet.getUri());
url.pathname = '/ss_portal';
process.stdout.write(`MONGODB_URI=${url.toString()}\n(ctrl-c to stop)\n`);
const stop = async () => {
	await replSet.stop();
	process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
