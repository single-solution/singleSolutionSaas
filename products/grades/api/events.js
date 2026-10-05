/**
 * Event consumers (Part E §9): the standard catalog events attach tiers to catalog items. Consumption is idempotent
 * twice over: app-kit dedupes deliveries on the event `id`, and every effect is an upsert keyed by the item (and
 * variant), so a re-processed event changes nothing. Websites without an active subscription (or with `tiers` off)
 * are ignored.
 */

/**
 * @param {{ service: import('./service.js').GradesService, siteFor: (websiteId: string) => Promise<import('./service.js').Site | null> }} deps
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
		'item.created@1': forSite(service.itemUpserted),
		'item.updated@1': forSite(service.itemUpserted),
		'item.deleted@1': forSite(service.itemDeleted),
	};
};
