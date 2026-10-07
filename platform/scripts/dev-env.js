// Print the development environment for `.env.local`: `node scripts/dev-env.js > .env.local`. The environment holds
// the database, the Portal's own address and the key that encrypts stored secrets; every other key and secret is
// generated in the database on first start. Products running on localhost can be connected outside production. Then
// open http://localhost:4000/login and create the first admin.
import { randomBytes } from 'node:crypto';

const lines = [
	'NODE_ENV=development',
	`MONGODB_URI=${process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27999/ss_portal?replicaSet=testset'}`,
	'PORTAL_URL=http://localhost:4000',
	`ENCRYPTION_KEY=${randomBytes(32).toString('base64url')}`,
];
process.stdout.write(`${lines.join('\n')}\n`);
