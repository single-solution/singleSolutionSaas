/**
 * Products and price books from manifests (pure, over `@ss/entitlements`).
 *
 * - {@link productOf}: the normalised product of one manifest version (resolution, plans, features, current book).
 * - {@link settlementCatalog}: a product whose `priceBooks` are the books of **every pinned manifest version**, so
 *   settlement prices each hour with the book pinned at that hour. Its elements are the union of all versions' element
 *   keys (an element missing from a version costs 0 under that version's book).
 * @module
 */
import { currentPriceBook, hourlyCharge, normaliseProduct, planDefaults } from '@ss/entitlements';

/** @typedef {ReturnType<typeof normaliseProduct>} Product */
/** @typedef {Product['priceBooks'][number]} PriceBook */

/**
 * @typedef {object} Manifest The subset of an SSPS v1 manifest commerce reads.
 * @property {{ slug: string, version: string }} product
 * @property {readonly any[]} elements
 * @property {readonly { code: string, elements: readonly string[], addons?: readonly string[] }[]} [plans]
 * @property {{ version: string, effectiveFrom: string }} priceBook
 * @property {number} [trialHours]
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
 * Price book of one manifest version, in the `priceBooks[]` input shape.
 * @param {Manifest} manifest
 */
const bookOf = (manifest) => ({
	version: manifest.priceBook.version,
	effectiveFrom: manifest.priceBook.effectiveFrom,
	elements: Object.fromEntries(manifest.elements.map((el) => [el.key, el.price?.hourly ?? 0])),
	metered: manifest.elements.flatMap((el) =>
		(el.price?.metered ?? []).map((/** @type {any} */ m) => ({
			unit: m.unit,
			element: el.key,
			perUnit: m.perUnit,
			per: m.per ?? 1,
			...(m.included ? { included: m.included } : {}),
		})),
	),
});

/**
 * Settlement product over several manifest versions (latest wins for a repeated price-book version).
 * @param {readonly Manifest[]} manifests
 * @returns {Product}
 */
export const settlementCatalog = (manifests) => {
	if (manifests.length === 0) throw Object.assign(new Error('no manifests'), { code: 'catalog/no_manifests' });
	/** @type {Map<string, ReturnType<typeof bookOf>>} */
	const books = new Map();
	/** @type {Set<string>} */
	const elements = new Set();
	/** @type {Set<string>} */
	const plans = new Set();
	for (const manifest of manifests) {
		books.set(manifest.priceBook.version, bookOf(manifest));
		for (const el of manifest.elements) elements.add(el.key);
		for (const plan of manifest.plans ?? []) plans.add(plan.code);
		for (const el of manifest.elements)
			for (const m of el.price?.metered ?? []) for (const code of Object.keys(m.included ?? {})) plans.add(code);
	}
	const last = /** @type {Manifest} */ (manifests[manifests.length - 1]);
	return normaliseProduct({
		product: { slug: last.product.slug, version: last.product.version },
		elements: [...elements].sort().map((key) => ({ key })),
		plans: [...plans].sort().map((code) => ({ code, elements: [] })),
		priceBooks: [...books.values()],
	});
};

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

/**
 * Period of a metered unit's included allowance: the period of the quota feature counting that unit, else `month`.
 * @param {Product} product
 * @param {string} unit
 * @returns {'hour' | 'day' | 'week' | 'month'}
 */
export const unitPeriod = (product, unit) => quotaFeatures(product).find((q) => q.unit === unit)?.period ?? 'month';

/**
 * Charge of one hour for a new subscription on a plan (plan-included elements, or product defaults without a plan).
 * @param {Product} product
 * @param {string | null} planCode
 * @param {number} at epoch ms
 * @returns {{ amount: number, priceBook: PriceBook } | null} null when no price book is effective
 */
export const firstHourCharge = (product, planCode, at) => {
	const book = currentPriceBook(product, at);
	if (!book) return null;
	const defaults = planDefaults(product, planCode);
	const on = Object.entries(defaults.elements)
		.filter(([, enabled]) => enabled)
		.map(([key]) => key);
	return { amount: hourlyCharge({ priceBook: book, elements: on }).amount, priceBook: book };
};
