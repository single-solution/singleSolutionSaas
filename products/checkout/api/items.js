/**
 * Items Checkout sells from: the mirror in the merchant's database (posted by the merchant's server or fed by the
 * Catalog product's events) and, when the website chooses `item_source: catalog`, a live lookup in the Catalog
 * product's API for an item not mirrored yet (the result is mirrored so placement can reserve against it).
 */
import { applyInventoryChange, applyPriceChange, itemFromCatalogEvent, itemFromCatalogView, priceLine } from '../core/items.js';

/** @typedef {import('./context.js').Site} Site */
/** @typedef {import('./context.js').Checkout} Checkout */

/**
 * @param {Checkout} checkout
 */
export const createItemsService = (checkout) => {
	/**
	 * Items by id: mirror first, then the Catalog API for missing ones (when configured).
	 * @param {Site} site
	 * @param {string[]} ids
	 * @returns {Promise<Map<string, import('../core/items.js').Item>>}
	 */
	const lookup = async (site, ids) => {
		const unique = [...new Set(ids)];
		const found = new Map((await site.repos.items.getMany(unique)).map((/** @type {any} */ item) => [item.itemId, item]));
		const missing = unique.filter((id) => !found.has(id));
		if (missing.length === 0 || site.settings.cart.item_source !== 'catalog') return found;
		const { catalog } = await checkout.connectionsFor(site);
		if (!catalog) return found;
		for (const id of missing.slice(0, 20)) {
			const result = await checkout.integrations.catalog.item(catalog, id);
			const item = result.ok ? itemFromCatalogView(result.json) : null;
			if (item && item.itemId === id) {
				await site.repos.items.put(item);
				found.set(id, item);
			}
		}
		return found;
	};

	/**
	 * Price wanted lines from the item records (never from the request).
	 * @param {Site} site
	 * @param {ReadonlyArray<{ itemId: string, variantId?: string | null, quantity: number }>} wants
	 */
	const price = async (site, wants) => {
		const items = await lookup(
			site,
			wants.map((want) => want.itemId),
		);
		const untracked = site.settings.place.stock_source === 'checkout' ? site.settings.place.untracked_stock : 'allow';
		return wants.map((want) =>
			priceLine(items.get(want.itemId) ?? null, want, { currency: site.settings.currency, untracked }),
		);
	};

	/**
	 * Catalog event consumers: mirror item snapshots, prices and stock (only items Checkout may sell from).
	 * @param {Site} site
	 * @param {string} type
	 * @param {Record<string, any>} data
	 */
	const onCatalogEvent = async (site, type, data) => {
		if (typeof data?.itemId !== 'string') return false;
		const current = await site.repos.items.get(data.itemId);
		if (type === 'item.deleted@1') return current ? site.repos.items.remove(data.itemId) : false;
		if (type === 'item.created@1' || type === 'item.updated@1') {
			const next = itemFromCatalogEvent(data, current);
			if (!next) return false;
			await site.repos.items.put(next);
			return true;
		}
		if (!current) return false;
		const next = type === 'price.changed@1' ? applyPriceChange(current, data) : applyInventoryChange(current, data);
		if (!next) return false;
		await site.repos.items.put(next);
		return true;
	};

	return Object.freeze({ lookup, price, onCatalogEvent });
};

/** @typedef {ReturnType<typeof createItemsService>} ItemsService */
