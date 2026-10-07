/**
 * Event consumers (Part E §9). Consumption is idempotent twice over: app-kit dedupes deliveries on the event `id`, and
 * a review request's id derives from its order (one per order, upserted), so even a re-processed completion never opens
 * a second request. Websites without an active subscription (or with the base element off) are ignored.
 */

/**
 * @param {{ service: import('./service.js').ReviewsService, siteFor: (websiteId: string) => Promise<import('./service.js').Site | null> }} deps
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
		'order.completed@1': forSite(service.orderCompleted),
		'order.placed@1': forSite(service.orderPlaced),
		'order.cancelled@1': forSite(service.orderReversed),
		'order.refunded@1': forSite(service.orderReversed),
	};
};
