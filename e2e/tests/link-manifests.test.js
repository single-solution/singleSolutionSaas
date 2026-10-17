/**
 * The six products' manifests agree on their links (settings-ownership step 7): every scope a product needs of another
 * is one the other offers, every scope a product offers is served by a route that takes it (the kit's own scopes are the
 * kit's routes), no product needs a product that does not exist, and a need names only features the product has. The
 * Portal grants only what is offered, so a typo here would silently grant nothing.
 */
import { createMemoryStore } from '@ss/app-kit/testing';
import { KIT_LINK_SCOPES } from '@ss/app-kit';
import { describe, expect, it } from 'vitest';
import * as accounts from '@ss/product-accounts/product';
import * as accountsRoutes from '@ss/product-accounts/routes';
import * as chat from '@ss/product-chat/product';
import * as chatRoutes from '@ss/product-chat/routes';
import * as ecommerce from '@ss/product-ecommerce/product';
import * as ecommerceRoutes from '@ss/product-ecommerce/routes';
import * as growth from '@ss/product-growth/product';
import * as growthRoutes from '@ss/product-growth/routes';
import * as notifications from '@ss/product-notifications/product';
import * as notificationsRoutes from '@ss/product-notifications/routes';
import * as payments from '@ss/product-payments/product';
import * as paymentsRoutes from '@ss/product-payments/routes';

/** @type {Array<{ unit: any, routes: any }>} */
const UNITS = [
	{ unit: accounts, routes: accountsRoutes },
	{ unit: chat, routes: chatRoutes },
	{ unit: ecommerce, routes: ecommerceRoutes },
	{ unit: growth, routes: growthRoutes },
	{ unit: notifications, routes: notificationsRoutes },
	{ unit: payments, routes: paymentsRoutes },
];
const KIT_SCOPES = new Set(Object.values(KIT_LINK_SCOPES));

/** Each product: its manifest, and the scopes its routes take. */
const products = new Map(
	UNITS.map(({ unit, routes }) => {
		const instance = unit.createProductInstance({
			config: { mongodbUri: '', connectSecret: 'c'.repeat(40), encryptionKey: 'e'.repeat(40) },
			store: createMemoryStore({ now: () => Date.now() }),
			nodeEnv: 'test',
		});
		const scopes = new Set(
			routes
				.createRoutes(instance)
				.map((/** @type {{ scope?: string }} */ route) => route.scope)
				.filter((/** @type {string | undefined} */ scope) => scope !== undefined),
		);
		return [unit.manifest.id, { manifest: unit.manifest, routeScopes: scopes }];
	}),
);

describe('the manifests’ links agree', () => {
	it('every scope a product needs of another is offered by that product', () => {
		for (const [id, { manifest }] of products)
			for (const need of manifest.links?.needs ?? []) {
				const other = products.get(need.product);
				expect(other, `${id} needs ${need.product}, which is not a product`).toBeDefined();
				const offered = new Set((other?.manifest.links?.offers ?? []).map((/** @type {{ scope: string }} */ o) => o.scope));
				for (const scope of need.scopes) expect(offered.has(scope), `${id} needs ${need.product} ${scope}`).toBe(true);
			}
	});

	it('every need names only features of the product that needs it', () => {
		for (const [id, { manifest }] of products) {
			const features = new Set(manifest.features.map((/** @type {{ key: string }} */ f) => f.key));
			for (const need of manifest.links?.needs ?? [])
				for (const feature of need.features) expect(features.has(feature), `${id}: ${feature}`).toBe(true);
		}
	});

	it('every scope a product offers is served by a route that takes it (or is one of the kit’s own)', () => {
		for (const [id, { manifest, routeScopes }] of products)
			for (const offer of manifest.links?.offers ?? [])
				expect(routeScopes.has(offer.scope) || KIT_SCOPES.has(offer.scope), `${id} offers ${offer.scope}`).toBe(true);
	});

	it('every route that takes a link key is offered in the manifest (the kit refuses to start otherwise)', () => {
		for (const [id, { manifest, routeScopes }] of products) {
			const offered = new Set((manifest.links?.offers ?? []).map((/** @type {{ scope: string }} */ o) => o.scope));
			for (const scope of routeScopes) expect(offered.has(scope), `${id} route scope ${scope}`).toBe(true);
		}
	});

	it('every offer has a name and a sentence that tells a merchant what it allows', () => {
		for (const [id, { manifest }] of products)
			for (const offer of manifest.links?.offers ?? []) {
				expect(offer.name.length, `${id} ${offer.scope}`).toBeGreaterThan(2);
				expect(offer.description.length, `${id} ${offer.scope}`).toBeGreaterThan(20);
			}
	});
});
