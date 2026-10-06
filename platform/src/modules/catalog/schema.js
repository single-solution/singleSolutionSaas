/**
 * Collections of the `catalog` module. Control-plane facts only (PLAN §1a): app identity, lifecycle, environments,
 * manifests (public product descriptions), public keys, launch ids and heartbeat metadata — never client data.
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
			'Registered apps (`_id` = appId): slug, kind (service|pack), lifecycle status, sunset date, environments ' +
			'(production/staging base URLs), current and pending manifest versions, last heartbeat.',
		indexes: [{ keys: { slug: 1 }, unique: true }, { keys: { status: 1, _id: 1 } }, { keys: { kind: 1, status: 1, _id: 1 } }],
	}),
	defineCollection({
		module: 'catalog',
		name: VERSIONS,
		description:
			'Manifest versions per app (`_id` = `<appId>:<n>`): canonical manifest JSON, its SHA-256, review status ' +
			'(pending|accepted|superseded|rejected), diff against the accepted version, source, pack asset metadata.',
		indexes: [{ keys: { appId: 1, version: -1 }, unique: true }, { keys: { status: 1, createdAt: -1 } }],
	}),
	defineCollection({
		module: 'catalog',
		name: KEYS,
		description:
			'Public keys per app (`_id` = `<appId>:<kid>`): Ed25519 public JWK, thumbprint, status (active|revoked), ' +
			'`notAfter` (end of a rotation overlap). Service apps: client-assertion keys; packs: bundle signing keys.',
		indexes: [{ keys: { appId: 1, status: 1, createdAt: 1 } }],
	}),
	defineCollection({
		module: 'catalog',
		name: LAUNCHES,
		description: 'Issued launch ids (`_id` = jti) for online single-use consumption by the product; expire with the launch.',
		indexes: [{ keys: { appId: 1, _id: 1 } }],
		ttl: { field: 'expireAt', afterSeconds: 0 },
	}),
]);
