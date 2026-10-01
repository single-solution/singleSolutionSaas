/**
 * Valid manifests for catalog tests (fresh deep copies).
 * @module
 */
import { manifest as contractsManifest, packManifest as contractsPack } from '@ss/contracts/testing';

export const SERVICE_BASE = 'https://coupons.example.dev';

/** @returns {any} */
export const serviceManifest = () => contractsManifest();

/** @returns {any} */
export const packManifest = () => contractsPack();

/** @returns {any} pack assets matching {@link packManifest} */
export const packAssets = () => [
	{ path: 'headless/bar.js', sha256: 'a'.repeat(64), size: 1200, contentType: 'text/javascript' },
	{ path: 'ui/bar.js', sha256: 'b'.repeat(64), size: 2400, contentType: 'text/javascript' },
];

/**
 * A valid service manifest under another slug (event namespace follows the slug).
 * @param {string} slug
 * @returns {any}
 */
export const renamedService = (slug) => {
	const m = serviceManifest();
	m.product.slug = slug;
	m.events.publishes = [`${slug.replace(/-/g, '_')}.redeemed@1`];
	return m;
};
