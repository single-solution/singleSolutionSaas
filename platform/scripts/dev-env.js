// Print a fresh development environment (new signing key and secrets) for `.env.local`:
//   node scripts/dev-env.js > .env.local
// Never use these values outside local development.
import { randomBytes } from 'node:crypto';
import { generateSigningKey } from '@ss/protocol';

const day = new Date().toISOString().slice(0, 10);
const { privateJwk } = await generateSigningKey({ kid: `portal-dev-${day}` });
// website keys (pk_/sk_) are signed with their own key, never with the Portal key (kids must differ)
const { privateJwk: websiteKeyJwk } = await generateSigningKey({ kid: `website-dev-${day}` });
const secret = () => randomBytes(32).toString('base64');
const lines = [
	`PORTAL_ENV=development`,
	`PORTAL_URL=http://localhost:4000`,
	`MONGODB_URI=${process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27999/ss_portal?replicaSet=testset'}`,
	`PORTAL_SIGNING_KEYS='${JSON.stringify([privateJwk])}'`,
	`WEBSITE_KEY_SIGNING_KEYS='${JSON.stringify([websiteKeyJwk])}'`,
	`SECRETS_KEK=dev1:${secret()}`,
	`SESSION_SECRET=${secret()}`,
	`WEBSITE_KEY_PEPPER=${secret()}`,
	`IDEMPOTENCY_SECRET=${secret()}`,
	`CRON_SECRET=${randomBytes(32).toString('base64url')}`,
	// local products, object stores and databases may be reached over loopback / plain http (ignored in production)
	`OUTBOUND_DEV_ALLOW_HOSTS=localhost,127.0.0.1,::1`,
	`LOG_LEVEL=debug`,
];
process.stdout.write(`${lines.join('\n')}\n`);
