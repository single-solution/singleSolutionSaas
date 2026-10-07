/**
 * Products from manifests (pure, over `@ss/entitlements`): the normalised product of one manifest version (resolution,
 * plans, features), its data scope, usage units and quotas. Money lives in `core/money.js`, not in manifests.
 * @module
 */
import { normaliseProduct } from '@ss/entitlements';

/** @typedef {ReturnType<typeof normaliseProduct>} Product */
/** @typedef {Product['priceBooks'][number]} PriceBook */

/**
 * @typedef {object} Manifest The subset of an SSPS v1 manifest commerce reads.
 * @property {{ slug: string, version: string }} product
 * @property {readonly any[]} elements
 * @property {readonly { code: string, elements: readonly string[], addons?: readonly string[] }[]} [plans]
 * @property {{ version: string, effectiveFrom: string }} priceBook
 */

/**
 * @param {Manifest} manifest
 * @returns {Product}
 */
export const productOf = (manifest) => normaliseProduct(/** @type {any} */ (manifest));

/**
 * Data scope prefix (F.9): `ss_<slug with - → _>_`.
 * @param {string} slug
 */
export const dataScopePrefix = (slug) => `ss_${slug.replace(/-/g, '_')}_`;

/**
 * Units a product meters or counts: priced metered units ∪ quota `x-unit`s.
 * @param {Product} product
 * @returns {Set<string>}
 */
export const knownUnits = (product) => {
	const units = new Set();
	for (const book of product.priceBooks) for (const unit of Object.keys(book.metered)) units.add(unit);
	for (const feature of Object.values(product.features)) if (feature.kind === 'quota' && feature.unit) units.add(feature.unit);
	return units;
};

/**
 * Quota features with a usage unit.
 * @param {Product} product
 * @returns {{ key: string, unit: string, period: 'hour' | 'day' | 'week' | 'month', hardStop: boolean }[]}
 */
export const quotaFeatures = (product) =>
	Object.values(product.features)
		.filter((f) => f.kind === 'quota' && f.unit !== null && f.period !== null)
		.map((f) => ({
			key: f.key,
			unit: /** @type {string} */ (f.unit),
			period: /** @type {'hour' | 'day' | 'week' | 'month'} */ (f.period),
			hardStop: f.hardStop,
		}))
		.sort((a, b) => (a.key < b.key ? -1 : 1));
