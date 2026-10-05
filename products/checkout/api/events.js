/**
 * Event consumers (Part E §9). app-kit verifies the Portal signature and dedupes deliveries on the event id; every
 * effect is also a compare-and-set (order status, refund event id), so a re-processed event never acts twice.
 *
 * - Order lifecycle from the Order Manager (or any other product): `order.paid@1`, `order.completed@1`,
 *   `order.cancelled@1`, `order.refunded@1` — only for orders Checkout placed.
 * - Catalog data: `item.created|updated|deleted@1`, `price.changed@1`, `inventory.changed@1` keep the item mirror
 *   current, so the Catalog product is optional.
 */

const ORDER_EVENTS = ['order.paid@1', 'order.completed@1', 'order.cancelled@1', 'order.refunded@1'];
const ITEM_EVENTS = ['item.created@1', 'item.updated@1', 'item.deleted@1', 'price.changed@1', 'inventory.changed@1'];

/**
 * @param {{ siteFor: (websiteId: string, element?: string) => Promise<import('./context.js').Site | null>,
 *   orders: import('./orders.js').OrdersService, items: import('./items.js').ItemsService }} application
 * @returns {Record<string, (event: any) => Promise<void>>}
 */
export const createEventHandlers = ({ siteFor, orders, items }) => {
	/** @type {Record<string, (event: any) => Promise<void>>} */
	const handlers = {};
	for (const type of ORDER_EVENTS)
		handlers[type] = async (event) => {
			if (typeof event?.websiteId !== 'string') return;
			const site = await siteFor(event.websiteId, 'place_order');
			if (site) await orders.onOrderEvent(site, type, event);
		};
	for (const type of ITEM_EVENTS)
		handlers[type] = async (event) => {
			if (typeof event?.websiteId !== 'string') return;
			const site = await siteFor(event.websiteId, 'cart');
			if (site) await items.onCatalogEvent(site, type, event.data ?? {});
		};
	return handlers;
};
