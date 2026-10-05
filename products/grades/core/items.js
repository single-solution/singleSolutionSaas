/**
 * Items (pure): catalog snapshots from the standard `item.created@1` / `item.updated@1` events, tiers named by a
 * catalog attribute, and the per-item tier rollup that filters, mappings and badges read. Items may also be plain
 * external ids that no catalog event ever described (standalone use).
 * @module
 */
import { rankKeys, tierNamed } from './tiers.js';
import { isId, isObject } from './text.js';

/** Snapshot fields copied from item events when present. */
const SNAPSHOT_FIELDS = Object.freeze(['title', 'status', 'brand', 'collections', 'attributes']);

/** Key of an item-level assignment (no variant). */
export const ITEM_LEVEL = '_';

/**
 * @param {string | null | undefined} variantId
 * @returns {string}
 */
export const variantKey = (variantId) => variantId ?? ITEM_LEVEL;

/**
 * Snapshot patch of an item event: only the fields the event carries (`item.updated@1` may be partial). Variants keep
 * id, sku, title and attributes (prices, costs and stock are not this product's business).
 * @param {Record<string, any>} data event data
 * @returns {Record<string, unknown>}
 */
export const snapshotPatch = (data) => {
	/** @type {Record<string, unknown>} */
	const patch = {};
	for (const field of SNAPSHOT_FIELDS) if (data[field] !== undefined) patch[field] = data[field];
	if (Array.isArray(data.variants))
		patch.variants = data.variants
			.filter((variant) => isObject(variant) && isId(variant.variantId))
			.map((variant) => ({
				variantId: variant.variantId,
				sku: typeof variant.sku === 'string' ? variant.sku : null,
				title: typeof variant.title === 'string' ? variant.title : null,
				attributes: isObject(variant.attributes) ? variant.attributes : {},
			}));
	return patch;
};

/**
 * Tiers the catalog names through an attribute: the item's own attribute (item level) and each variant's.
 * @param {{ attributes?: Record<string, unknown>, variants?: Array<{ variantId: string, attributes?: Record<string, unknown> }> }} item
 * @param {ReadonlyArray<import('./tiers.js').Tier>} tiers
 * @param {string} attribute `tiers.catalog_attribute` ('' = off)
 * @returns {Array<{ variantId: string | null, tier: string }>}
 */
export const catalogTiers = (item, tiers, attribute) => {
	if (!attribute) return [];
	/** @type {Array<{ variantId: string | null, tier: string }>} */
	const out = [];
	const own = tierNamed(tiers, item.attributes?.[attribute]);
	if (own) out.push({ variantId: null, tier: own.key });
	for (const variant of item.variants ?? []) {
		const tier = tierNamed(tiers, variant.attributes?.[attribute]);
		if (tier) out.push({ variantId: variant.variantId, tier: tier.key });
	}
	return out;
};

/**
 * Tiers an item is offered in: its assignments (item and variants) and its available units, best first.
 * @param {ReadonlyMap<string, import('./tiers.js').Tier>} index
 * @param {{ assignments: Array<{ tier: string }>, unitTiers: Array<string | null> }} input
 */
export const rollupTiers = (index, { assignments, unitTiers }) =>
	rankKeys(index, [...assignments.map((assignment) => assignment.tier), ...unitTiers]);

/**
 * The tier of a variant: its own assignment, else the item's, else the default tier.
 * @param {Array<{ variantId: string | null, tier: string }>} assignments
 * @param {string | null} variantId
 * @param {string | null} defaultTier
 */
export const effectiveTier = (assignments, variantId, defaultTier) =>
	(variantId ? assignments.find((a) => a.variantId === variantId)?.tier : undefined) ??
	assignments.find((a) => a.variantId === null)?.tier ??
	defaultTier;
