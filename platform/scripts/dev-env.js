// Print a fresh development environment (new signing key and secrets) for `.env.local`:
//   node scripts/dev-env.js > .env.local
// Never use these values outside local development.
import { randomBytes } from 'node:crypto';
import { generateSigningKey } from '@ss/protocol';

const { privateJwk } = await generateSigningKey({ kid: `portal-dev-${new Date().toISOString().slice(0, 10)}` });
const secret = () => randomBytes(32).toString('base64');
const lines = [
	`PORTAL_ENV=development`,
	`PORTAL_URL=http://localhost:4000`,
	`MONGODB_URI=${process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27999/ss_portal?replicaSet=testset'}`,
	`PORTAL_SIGNING_KEYS='${JSON.stringify([privateJwk])}'`,
	`SECRETS_KEK=dev1:${secret()}`,
	`SESSION_SECRET=${secret()}`,
	`WEBSITE_KEY_PEPPER=${secret()}`,
	`CRON_SECRET=${randomBytes(32).toString('base64url')}`,
	`LOG_LEVEL=debug`,
];
process.stdout.write(`${lines.join('\n')}\n`);
