/**
 * Event consumers (Part E §9). Consumption is idempotent twice over: app-kit dedupes deliveries on the event `id`, and
 * every movement has a deterministic source key (`earn:order.completed@1:<orderId>`, `reverse:<orderId>:…`), so even a
 * re-processed event never moves points twice. Websites without an active subscription (or with the base element off)
 * are ignored.
 */

/**
 * @param {{ service: import('./service.js').LoyaltyService, siteFor: (websiteId: string) => Promise<import('./service.js').Site | null> }} deps
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
	return {
		'order.placed@1': forSite(service.orderPlaced),
		'order.completed@1': forSite(service.orderCompleted),
		'order.cancelled@1': forSite(service.orderCancelled),
		'order.refunded@1': forSite(service.orderRefunded),
		'customer.created@1': forSite(service.customerCreated),
		// `events.consumes: custom.*` — app-kit dispatches every type to `*`; only custom events earn here
		'*': async (event) => {
			if (typeof event.type === 'string' && event.type.startsWith('custom.')) await forSite(service.customEvent)(event);
		},
	};
};
