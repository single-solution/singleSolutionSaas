/**
 * Event consumers (Part E §9). Consumption is idempotent twice over: app-kit dedupes deliveries on the event `id`, and a
 * purchase is keyed by its order (upserted), a serial by serial + order, a grade and a stock level by item + variant,
 * and an outside refund is applied once per event id. Websites without an active subscription (or with neither claims
 * nor the serial registry on) are ignored; events this product published itself are skipped.
 *
 * - `order.placed@1`: the purchase snapshot (lines, customer) before delivery.
 * - `order.delivered@1` / `order.completed@1` (and any type listed in claims.window_start_events, e.g. an Orders
 *   product `orders.*@1` event): the window opens.
 * - `order.paid@1`, other `order.*@1` and `orders.*@1` events: they enrich the purchase and carry serials.
 * - `order.cancelled@1`: nothing is claimable any more. `order.refunded@1` (from elsewhere): refunded units are not
 *   claimable again.
 * - `grades.tier_assigned@1`: the tier that grade windows read. `inventory.changed@1`: the on-hand level restock
 *   events start from.
 */

/** Order event types handled by name (the rest of `order.*` / `orders.*` arrive through the wildcard). */
export const ORDER_TYPES = Object.freeze([
	'order.placed@1',
	'order.paid@1',
	'order.completed@1',
	'order.delivered@1',
	'order.cancelled@1',
	'order.refunded@1',
]);

/**
 * @param {{ service: import('./service.js').AftersalesService, siteFor: (websiteId: string) => Promise<import('./service.js').Site | null> }} deps
 * @returns {Record<string, (event: any) => Promise<void>>}
 */
export const createEventHandlers = ({ service, siteFor }) => {
	/**
	 * @param {(site: import('./service.js').Site, event: any) => Promise<unknown>} handle
	 * @returns {(event: any) => Promise<void>}
	 */
	const forSite = (handle) => async (event) => {
		const site = await siteFor(event.websiteId);
		if (site) await handle(site, event);
	};
	const order = forSite(service.orderEvent);
	return {
		...Object.fromEntries(ORDER_TYPES.map((type) => [type, order])),
		'grades.tier_assigned@1': forSite(service.gradeEvent),
		'inventory.changed@1': forSite(service.inventoryEvent),
		// other order lifecycle events of the standard namespace and the Orders product's own events
		'*': async (event) => {
			const type = String(event?.type ?? '');
			if (ORDER_TYPES.includes(type)) return;
			if ((type.startsWith('order.') || type.startsWith('orders.')) && type.endsWith('@1')) await order(event);
		},
	};
};
