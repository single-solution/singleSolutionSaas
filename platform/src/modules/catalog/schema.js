/**
 * Collections of the `catalog` module (PLAN 0.4.12, 0.8.2 Products): connected products, the launches the Portal
 * issued, and notices a product has not taken yet. Control-plane facts only: product addresses, public manifests,
 * public keys and launch ids.
 * @module
 */
import { defineCollection } from '../../infra/db.js';

export const PRODUCTS = 'catalog_products';
export const LAUNCHES = 'catalog_launches';
export const NOTICES = 'catalog_notices';

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
]);
