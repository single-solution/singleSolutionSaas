/**
 * Standard catalog events (pure): the data of `item.created@1`, `item.updated@1`, `item.deleted@1`,
 * `inventory.changed@1` and `price.changed@1` exactly as `@ss/contracts` defines them (closed objects, no nulls), with
 * stable idempotency keys so a republished event is deduplicated by the Portal. The private cost is never published.
 * @module
 */
import { statusDef } from './items.js';

export const EVENT_TYPES = Object.freeze({
	created: 'item.created@1',
	updated: 'item.updated@1',
	deleted: 'item.deleted@1',
	inventory: 'inventory.changed@1',
	price: 'price.changed@1',
});

/** Variants carried by an item snapshot (consumers needing more read the API). */
export const SNAPSHOT_VARIANTS = 250;
const ATTRIBUTE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * @param {Record<string, unknown>} object
 * @returns {Record<string, unknown>}
 */
const compact = (object) =>
	Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null && value !== undefined));

/**
 * Attributes in the event shape (≤ 50 names, scalar or short-list values of ≤ 500 characters).
 * @param {Record<string, unknown> | undefined} attributes
 */
export const eventAttributes = (attributes) => {
	/** @type {Record<string, unknown>} */
	const out = {};
	for (const [key, value] of Object.entries(attributes ?? {})) {
		if (Object.keys(out).length >= 50 || !ATTRIBUTE_NAME.test(key)) continue;
		const scalar = (/** @type {unknown} */ v) =>
			typeof v === 'number' ? Number.isFinite(v) : typeof v === 'boolean' || (typeof v === 'string' && v.length <= 500);
		if (Array.isArray(value)) {
			const list = value.filter(scalar).slice(0, 20);
			if (list.length > 0) out[key] = list;
		} else if (scalar(value)) out[key] = value;
	}
	return out;
};

/**
 * The item snapshot of `item.created@1` / `item.updated@1`.
 * @param {Record<string, any>} item stored item
 * @param {{ currency: string | null, brandName: string | null, statuses: Array<{ key: string, label: string, base: 'draft' | 'active' | 'archived', visible: boolean }> }} context
 */
export const itemSnapshot = (item, { currency, brandName, statuses }) => {
	const variants = [...(item.variants ?? [])]
		.sort((a, b) => a.position - b.position)
		.slice(0, SNAPSHOT_VARIANTS)
		.map((variant) =>
			compact({
				variantId: variant.id,
				sku: variant.sku,
				title: variant.title,
				attributes: Object.keys(variant.options ?? {}).length > 0 ? eventAttributes(variant.options) : null,
				price: variant.price,
				compareAtPrice: variant.compareAtPrice,
				inventory: variant.quantity,
			}),
		);
	return compact({
		itemId: item.id,
		title: item.title,
		status: statusDef(statuses, item.status).base,
		brand: brandName ? brandName.slice(0, 200) : null,
		collections: (item.collectionIds ?? []).slice(0, 100),
		attributes: eventAttributes(item.attributes),
		...(currency && variants.length > 0 ? { currency, variants } : {}),
	});
};

/**
 * `inventory.changed@1` data for one variant.
 * @param {{ itemId: string, variant: Record<string, any>, quantity: number, previousQuantity: number, reason: string }} input
 */
export const inventoryData = ({ itemId, variant, quantity, previousQuantity, reason }) =>
	compact({ itemId, variantId: variant.id, sku: variant.sku, quantity, previousQuantity, reason });

/**
 * `price.changed@1` data for every variant whose price or compare-at price changed.
 * @param {{ itemId: string, before: ReadonlyArray<Record<string, any>>, after: ReadonlyArray<Record<string, any>>, currency: string | null, reason: string }} input
 * @returns {Array<{ variantId: string, data: Record<string, unknown> }>}
 */
export const priceChanges = ({ itemId, before, after, currency, reason }) => {
	if (!currency) return [];
	const money = (/** @type {number | null | undefined} */ amount) => (typeof amount === 'number' ? { amount, currency } : null);
	return after.flatMap((variant) => {
		const previous = before.find((v) => v.id === variant.id);
		if (
			!previous ||
			(previous.price === variant.price && (previous.compareAtPrice ?? null) === (variant.compareAtPrice ?? null))
		)
			return [];
		return [
			{
				variantId: variant.id,
				data: compact({
					itemId,
					variantId: variant.id,
					sku: variant.sku,
					price: money(variant.price),
					previousPrice: money(previous.price),
					compareAtPrice: money(variant.compareAtPrice),
					previousCompareAtPrice: money(previous.compareAtPrice),
					reason,
				}),
			},
		];
	});
};

/**
 * Stock changes between two variant lists (`inventory.changed@1` per variant whose quantity moved).
 * @param {{ itemId: string, before: ReadonlyArray<Record<string, any>>, after: ReadonlyArray<Record<string, any>>, reason: string }} input
 * @returns {Array<{ variantId: string, data: Record<string, unknown> }>}
 */
export const stockChanges = ({ itemId, before, after, reason }) =>
	after.flatMap((variant) => {
		const previous = before.find((v) => v.id === variant.id);
		const previousQuantity = previous ? previous.quantity : 0;
		if (previous && previous.quantity === variant.quantity) return [];
		if (!previous && variant.quantity === 0) return [];
		return [
			{
				variantId: variant.id,
				data: inventoryData({ itemId, variant, quantity: variant.quantity, previousQuantity, reason }),
			},
		];
	});
