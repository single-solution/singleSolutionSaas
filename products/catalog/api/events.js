/**
 * Event consumers (app-kit verifies the Portal signature and dedupes on the event id before these run): order events
 * move stock when the `variants` element is on. Each handler is also idempotent on its own (one stock move per order,
 * one restock per refund event), so a redelivery never moves stock twice. Handlers never throw for bad data.
 */

/**
 * @param {{ siteFor: (websiteId: string) => Promise<import('./catalog.js').Site | null>,
 *   variants: import('./variants.js').VariantsService }} catalog
 * @returns {Record<string, (event: any) => Promise<void>>}
 */
export const createEventHandlers = ({ siteFor, variants }) => {
	/**
	 * @param {any} event
	 * @param {(site: import('./catalog.js').Site, data: Record<string, any>, id: string) => Promise<unknown>} run
	 */
	const withSite = async (event, run) => {
		if (typeof event?.websiteId !== 'string') return;
		const site = await siteFor(event.websiteId);
		if (!site || !site.settings.enabled('variants')) return;
		await run(site, event.data ?? {}, event.id);
	};
	return {
		'order.placed@1': (event) => withSite(event, (site, data) => variants.onOrderPlaced(site, data)),
		'order.cancelled@1': (event) => withSite(event, (site, data) => variants.onOrderCancelled(site, data)),
		'order.refunded@1': (event) => withSite(event, (site, data, id) => variants.onOrderRefunded(site, data, id)),
	};
};
