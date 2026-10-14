/**
 * Collections of the `catalog` module (PLAN 0.4.12, 0.8.2 Products): connected products, the launches the Portal
 * issued, notices a product has not taken yet, and the share links and business profiles of websites' Setup sheets.
 * Control-plane facts only: product addresses, public manifests, public keys, launch ids, hashes of share-link keys
 * and the few answers of a business profile (never a sheet).
 * @module
 */
import { defineCollection } from '../../infra/db.js';

export const PRODUCTS = 'catalog_products';
export const LAUNCHES = 'catalog_launches';
export const NOTICES = 'catalog_notices';
export const SETUP_LINKS = 'catalog_setup_links';
export const SETUP_PROFILES = 'catalog_setup_profiles';

export const collections = Object.freeze([
	defineCollection({
		module: 'catalog',
		name: PRODUCTS,
		description:
			'Connected products (`_id` = product id, the manifest `id`): status active | inactive, the base URL it was connected with, its manifest (canonical JSON), the public key of its client assertions, connected and reconnected times. Never deleted.',
		indexes: [{ keys: { status: 1, _id: 1 } }],
	}),
	defineCollection({
		module: 'catalog',
		name: LAUNCHES,
		description: 'Issued launch ids (`_id` = jti) for single-use consumption by the product; expire with the launch.',
		indexes: [{ keys: { productId: 1, _id: 1 } }],
		ttl: { field: 'expireAt', afterSeconds: 0 },
	}),
	defineCollection({
		module: 'catalog',
		name: NOTICES,
		description:
			'Notices a product has not answered 2xx yet (`{ productId, body, queuedAt, attempts }`), retried oldest first right after its next call to the Portal and dropped once delivered.',
		indexes: [{ keys: { productId: 1, queuedAt: 1, _id: 1 } }],
	}),
	defineCollection({
		module: 'catalog',
		name: SETUP_LINKS,
		description:
			"Share links of websites' Setup sheets (`_id` = `shl_…`): the SHA-256 of the link key (never the key), the website, whether the copy shows settings values and the install details, who made it (admin or merchant), when it expires (removed then) or was revoked, and when it was last opened and how often.",
		tenant: 'merchant',
		indexes: [{ keys: { merchantId: 1, websiteId: 1, createdAt: -1, _id: -1 } }, { keys: { keyHash: 1 }, unique: true }],
		ttl: { field: 'expiresAt', afterSeconds: 0 },
	}),
	defineCollection({
		module: 'catalog',
		name: SETUP_PROFILES,
		description:
			"The business profile of a website's Setup sheet (`_id` = websiteId): the answers its advisor recommends features from (`@ss/contracts` business profile: what it sells, how shoppers pay, delivery, sign-in, chat, messages, marketing, offers, moving, countries and languages). Removed when every answer is cleared.",
		tenant: 'merchant',
		indexes: [{ keys: { merchantId: 1, _id: 1 } }],
	}),
]);
