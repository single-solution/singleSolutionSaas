/**
 * Event consumers (Part E §9) of the optional catalog link: `item.created@1`, `item.updated@1`, `item.deleted@1` and
 * `inventory.changed@1` from the Event Hub (and site events pushed to `POST /v1/events`) are stored in the merchant's
 * database, so catalog-linked configurators always resolve against current options, prices and stock.
 *
 * Idempotent twice over: app-kit dedupes deliveries on the event `id`, and the catalog core ignores figures older than
 * the stored ones, so a redelivered or out-of-order event changes nothing. Provenance: catalog data is trusted only
 * from the merchant's servers — an event with a `customer` / `anonymous` actor or pushed with a browser `pk_` key is
 * ignored. Websites without an active subscription, with `schema` off or with `schema.catalog_link` off are ignored.
 */

/**
 * Whether an event came from a trusted (server-side) source.
 * @param {any} event
 * @param {{ source?: string, website?: { kind?: string } } | undefined} meta
 */
export const fromServer = (event, meta) => {
	if (meta?.source === 'site' && meta.website?.kind !== 'sk') return false;
	return !['customer', 'anonymous'].includes(event?.actor?.type);
};

/** @param {unknown} value @param {() => number} now */
const occurredAt = (value, now) =>
	typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : new Date(now()).toISOString();

/**
 * @param {{ service: import('./service.js').ConfiguratorService, siteFor: (websiteId: string) => Promise<import('./service.js').Site | null>,
 *   now: () => number }} deps
 * @returns {Record<string, (event: any, meta?: any) => Promise<void>>}
 */
export const createEventHandlers = ({ service, siteFor, now }) => {
	/**
	 * @param {(site: import('./service.js').Site, data: Record<string, any>, at: string) => Promise<unknown>} apply
	 * @returns {(event: any, meta?: any) => Promise<void>}
	 */
	const catalog = (apply) => async (event, meta) => {
		const data = event?.data;
		if (!fromServer(event, meta) || data === null || typeof data !== 'object' || typeof data.itemId !== 'string') return;
		const site = await siteFor(event.websiteId);
		if (!site || !site.settings.schema.catalog_link) return;
		await apply(site, data, occurredAt(event.occurredAt, now));
	};
	return {
		'item.created@1': catalog((site, data, at) => service.itemSnapshot(site, data, at)),
		'item.updated@1': catalog((site, data, at) => service.itemSnapshot(site, data, at)),
		'item.deleted@1': catalog((site, data, at) => service.itemDeleted(site, data.itemId, at)),
		'inventory.changed@1': catalog((site, data, at) => service.inventory(site, data, at)),
	};
};
