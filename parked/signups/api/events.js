/**
 * Event consumers (Part E §9). `entitlement.changed@1` asks the Portal to make Signups the website's identity issuer
 * when that is still needed (once per issuer configuration). Order events feed the account pages' order list. Consumption is idempotent twice over:
 * app-kit dedupes deliveries on the event `id`, and each event only sets its own lifecycle timestamp on the order
 * summary, so a re-processed or out-of-order event converges to the same document. Websites without an active
 * subscription (or with the account pages off) are ignored.
 */

/**
 * @param {{ service: import('./service.js').SignupsService, siteFor: (websiteId: string) => Promise<import('./service.js').Site | null> }} deps
 * @returns {Record<string, (event: any) => Promise<void>>}
 */
export const createEventHandlers = ({ service, siteFor }) => {
	/** @param {any} event */
	const order = async (event) => {
		const site = await siteFor(event.websiteId);
		if (site && site.settings.enabled('account_pages')) await service.applyOrderEvent(site, event);
	};
	return {
		// after app-kit's own handler refreshed the entitlement: the change may make the issuer request relevant
		'entitlement.changed': async (event) => {
			const site = typeof event.websiteId === 'string' ? await siteFor(event.websiteId) : null;
			if (site) await service.autoRegisterIssuer(site);
		},
		'order.placed@1': order,
		'order.completed@1': order,
		'order.cancelled@1': order,
		'order.refunded@1': order,
	};
};
