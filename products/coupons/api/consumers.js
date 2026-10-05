/**
 * Event consumers (Part E §9). Consumption is idempotent twice over: app-kit dedupes deliveries on the event `id`, and
 * every effect is a compare-and-set on the reservation (`reserved → redeemed`, `→ released`), with refunds recorded
 * once per event id — a re-processed event never redeems or releases twice. Websites without an active subscription
 * (or with the `api` element off) are ignored.
 */

/**
 * @param {{ service: import('./service.js').CouponsService, siteFor: (websiteId: string) => Promise<import('./service.js').Site | null> }} deps
 * @returns {Record<string, (event: any) => Promise<void>>}
 */
export const createEventHandlers = ({ service, siteFor }) => {
	/**
	 * @param {(site: import('./service.js').Site, event: any) => Promise<unknown>} handle
	 * @returns {(event: any) => Promise<void>}
	 */
	const forSite = (handle) => async (event) => {
		const site = await siteFor(event.websiteId);
		if (site && typeof event.data?.orderId === 'string') await handle(site, event);
	};
	return {
		'order.completed@1': forSite(service.orderCompleted),
		'order.cancelled@1': forSite(service.orderCancelled),
		'order.refunded@1': forSite(service.orderRefunded),
	};
};
