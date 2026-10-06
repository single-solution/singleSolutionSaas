// Print a fresh development environment (new signing keys and secrets) for `.env.local`:
//   node scripts/dev-env.js > .env.local
// Every value is a plain string. Never use these values outside local development.
import { randomBytes } from 'node:crypto';
import { formatSigningKey, generateSigningKey } from '@ss/protocol';

const day = new Date().toISOString().slice(0, 10);
const { privateJwk } = await generateSigningKey({ kid: `portal-dev-${day}` });
// website keys (pk_/sk_) are signed with their own key, never with the Portal key (kids must differ)
const { privateJwk: websiteKeyJwk } = await generateSigningKey({ kid: `website-dev-${day}` });
const secret = () => randomBytes(32).toString('base64');
const lines = [
	`MONGODB_URI=${process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27999/ss_portal?replicaSet=testset'}`,
	`SIGNING_KEYS=${formatSigningKey(privateJwk)}`,
	`WEBSITE_SIGNING_KEYS=${formatSigningKey(websiteKeyJwk)}`,
	`ENCRYPTION_KEYS=dev1:${secret()}`,
	`SESSION_SECRET=${secret()}`,
	`KEY_PEPPER=${secret()}`,
	// local products, object stores and databases may be reached over loopback / plain http (ignored in production)
	`OUTBOUND_DEV_ALLOW_HOSTS=localhost,127.0.0.1,::1`,
	// delivery artefacts (pack assets, compiled website bundles) on local disk; production uses an S3-compatible bucket
	`STORAGE_DIR=.data/assets`,
];
process.stdout.write(`${lines.join('\n')}\n`);
