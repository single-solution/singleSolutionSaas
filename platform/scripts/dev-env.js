// Print the development environment for `.env.local`: `node scripts/dev-env.js > .env.local`. The environment holds
// the database, the Portal's own address, the key that encrypts stored secrets and the asset storage; every other key
// and secret is generated in the database on first start. Then open http://localhost:4000/login and create the first
// admin.
import { randomBytes } from 'node:crypto';

const lines = [
	'NODE_ENV=development',
	`MONGODB_URI=${process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27999/ss_portal?replicaSet=testset'}`,
	'PORTAL_URL=http://localhost:4000',
	`ENCRYPTION_KEY=${randomBytes(32).toString('base64url')}`,
	// asset storage: a local directory in development; an S3-compatible bucket (STORAGE_BUCKET, …) in production
	'STORAGE_DIR=.data/assets',
	// local products, object stores and databases may be reached over loopback / plain http (ignored in production)
	'OUTBOUND_DEV_ALLOW_HOSTS=localhost,127.0.0.1,::1',
];
process.stdout.write(`${lines.join('\n')}\n`);
