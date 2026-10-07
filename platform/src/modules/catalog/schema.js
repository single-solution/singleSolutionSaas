/**
 * Collections of the `catalog` module. Control-plane facts only (PLAN §1a): app identity and status, the connected base
 * URL, manifests (public product descriptions), public keys and launch ids — never client data.
 * @module
 */
import { defineCollection } from '../../infra/db.js';

export const APPS = 'catalog_apps';
export const VERSIONS = 'catalog_versions';
export const KEYS = 'catalog_app_keys';
export const LAUNCHES = 'catalog_launches';

export const collections = Object.freeze([
	defineCollection({
		module: 'catalog',
		name: APPS,
		description:
			'Registered apps (`_id` = appId): slug, kind (service|pack), status (active|inactive), the connected production ' +
			'base URL (service products), current and latest manifest version numbers.',
		indexes: [{ keys: { slug: 1 }, unique: true }, { keys: { status: 1, _id: 1 } }, { keys: { kind: 1, status: 1, _id: 1 } }],
	}),
	defineCollection({
		module: 'catalog',
		name: VERSIONS,
		description:
			'Manifest versions per app (`_id` = `<appId>:<n>`; subscriptions pin one): canonical manifest JSON, its SHA-256, ' +
			'status (uploading|accepted|superseded), source (connection|upload), pack asset metadata.',
		indexes: [{ keys: { appId: 1, version: -1 }, unique: true }],
	}),
	defineCollection({
		module: 'catalog',
		name: KEYS,
		description:
			'Client-assertion public keys of service products (`_id` = `<appId>:<kid>`): Ed25519 public JWK and thumbprint; ' +
			'replaced when the product is connected again.',
		indexes: [{ keys: { appId: 1, createdAt: 1 } }],
	}),
	defineCollection({
		module: 'catalog',
		name: LAUNCHES,
		description: 'Issued launch ids (`_id` = jti) for online single-use consumption by the product; expire with the launch.',
		indexes: [{ keys: { appId: 1, _id: 1 } }],
		ttl: { field: 'expireAt', afterSeconds: 0 },
	}),
]);
