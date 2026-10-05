/**
 * Event consumers (Part E §9). Consumption is idempotent: app-kit dedupes deliveries on the event `id`, and every
 * effect is a convergent write — a price or stock value is set (not added), an item is upserted, a release flips the
 * application `committed → released` once. Websites without an active subscription (or with the engine off) are
 * ignored.
 *
 * - `price.changed@1` → the synced item's (or variant's) price and currency;
 * - `inventory.changed@1` → stock per location, summed per item and variant (the deals page hides sold-out items);
 * - `item.*` → item data (`item.created`/`item.updated` upsert the fields they carry, `item.deleted` removes;
 *   `item.viewed` and other analytics events are ignored);
 * - `order.cancelled@1` → the order's deals give their uses and stock back (`quote_api.release_on_cancel`).
 */
import { validateItem } from '../core/validate.js';

/** `item.<verb>` events that carry item data. */
const ITEM_UPSERTS = new Set(['created', 'updated', 'upserted', 'synced']);
const ITEM_FIELDS = [
	'itemId',
	'title',
	'brand',
	'collections',
	'attributes',
	'price',
	'cost',
	'currency',
	'stock',
	'url',
	'image',
	'variants',
];

/**
 * @param {{ service: import('./service.js').DealsService, siteFor: (websiteId: string) => Promise<import('./service.js').Site | null>,
 *   log?: { warn: (message: string, fields?: Record<string, unknown>) => void } }} deps
 * @returns {Record<string, (event: any) => Promise<void>>}
 */
export const createEventHandlers = ({ service, siteFor, log }) => {
	/**
	 * @param {(site: import('./service.js').Site, event: any) => Promise<unknown>} handle
	 * @returns {(event: any) => Promise<void>}
	 */
	const forSite = (handle) => async (event) => {
		const site = await siteFor(event.websiteId);
		if (site) await handle(site, event);
	};
	/**
	 * @param {import('./service.js').Site} site
	 * @param {any} event
	 */
	const itemEvent = async (site, event) => {
		const [, verb] = String(event.type).split('@')[0]?.split('.') ?? [];
		const data = event.data && typeof event.data === 'object' ? event.data : {};
		if (verb === 'deleted') {
			if (typeof data.itemId === 'string') await service.removeItem(site, data.itemId);
			return;
		}
		if (!ITEM_UPSERTS.has(verb ?? '')) return;
		const picked = Object.fromEntries(ITEM_FIELDS.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));
		const problems = validateItem(picked, { maxVariants: site.settings.quote.max_variants });
		if (problems.length > 0) {
			log?.warn('item event ignored', { type: event.type, problems: problems.slice(0, 5) });
			return;
		}
		await service.mergeItem(site, picked);
	};
	return {
		'price.changed@1': forSite(service.priceChanged),
		'inventory.changed@1': forSite(service.inventoryChanged),
		'order.cancelled@1': forSite(service.orderCancelled),
		// `events.consumes: item.*` — app-kit dispatches every type to `*`; only item events are handled here
		'*': async (event) => {
			if (typeof event.type === 'string' && event.type.startsWith('item.')) await forSite(itemEvent)(event);
		},
	};
};
