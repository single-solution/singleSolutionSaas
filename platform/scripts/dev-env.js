// Print the development environment for `.env.local`: `node scripts/dev-env.js > .env.local`. Only the database and
// the asset storage are configured through the environment; keys and secrets are generated in the database on first
// start. Then open http://localhost:4000/admin/login and choose the admin password.

const lines = [
	'NODE_ENV=development',
	`MONGODB_URI=${process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27999/ss_portal?replicaSet=testset'}`,
	// asset storage: a local directory in development; an S3-compatible bucket (STORAGE_BUCKET, …) in production
	'STORAGE_DIR=.data/assets',
	// local products, object stores and databases may be reached over loopback / plain http (ignored in production)
	'OUTBOUND_DEV_ALLOW_HOSTS=localhost,127.0.0.1,::1',
];
process.stdout.write(`${lines.join('\n')}\n`);
