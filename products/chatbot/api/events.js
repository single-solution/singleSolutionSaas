/**
 * Event consumers (Part E §9): `order.*@1` and `customer.*@1` feed the order and customer caches the order lookup
 * tool reads. app-kit dedupes deliveries on the event `id`; the caches are upserts (last write by event order wins,
 * statuses never move backwards), so a re-processed event changes nothing. Websites without an active subscription
 * (or with the base element off) are ignored. `events.consumes` lists globs, so one `*` handler routes by prefix.
 */

/**
 * @param {{ service: import('./service.js').ChatbotService, siteFor: (websiteId: string) => Promise<import('./service.js').Site | null> }} deps
 * @returns {Record<string, (event: any) => Promise<void>>}
 */
export const createEventHandlers = ({ service, siteFor }) => ({
	'*': async (event) => {
		const type = typeof event?.type === 'string' ? event.type : '';
		if (!/^(?:order|customer)\.[a-z_]+@1$/.test(type) || typeof event.websiteId !== 'string') return;
		const site = await siteFor(event.websiteId);
		if (site) await service.consume(site, event);
	},
});
