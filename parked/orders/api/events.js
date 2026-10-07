/**
 * Event consumers (app-kit verifies the Portal signature and dedupes on the event id before these run):
 *
 * - `order.placed@1` (the Checkout product, or any checkout that publishes it): take the order in (inbound_api,
 *   `accept_checkout_events`), keeping the event's order id so every later event names the same order.
 * - `order.paid@1`: a payment captured elsewhere (a payment gateway of the Checkout) becomes a ledger entry.
 * - `order.cancelled@1`: a cancellation made elsewhere moves the order when the matrix allows the system to.
 * - `order.refunded@1`: a refund made elsewhere (After-sales approving a claim) becomes one ledger entry per event,
 *   not republished.
 *
 * Our own publications come back through the Event Hub and are skipped. Handlers are idempotent and never throw for
 * bad data.
 */
import { placedToInput } from '../core/orders.js';
import { isId } from '../core/text.js';

/**
 * @param {{ siteFor: (websiteId: string) => Promise<import('./context.js').Site | null>,
 *   intake: import('./intake.js').Intake, ledger: import('./ledger.js').Ledger, lifecycle: import('./lifecycle.js').Lifecycle,
 *   deps: import('./context.js').Deps }} orders
 * @returns {Record<string, (event: any) => Promise<void>>}
 */
export const createEventHandlers = ({ siteFor, intake, ledger, lifecycle, deps }) => {
	/**
	 * @param {any} event
	 * @param {(site: import('./context.js').Site, data: Record<string, any>) => Promise<unknown>} run
	 */
	const withSite = async (event, run) => {
		if (typeof event?.websiteId !== 'string' || event?.context?.product === 'orders') return;
		const site = await siteFor(event.websiteId);
		if (!site) return;
		try {
			await run(site, event.data ?? {});
		} catch (error) {
			deps.log?.warn?.('order event failed', { type: event.type, error: /** @type {Error} */ (error)?.message });
		}
	};
	const system = (/** @type {string} */ id) => ({ type: /** @type {const} */ ('system'), id });
	return {
		'order.placed@1': (event) =>
			withSite(event, async (site, data) => {
				if (!site.settings.enabled('inbound_api') || !site.settings.inbound.accept_checkout_events || !isId(data.orderId))
					return;
				await intake.take(site, placedToInput(data), { source: 'checkout', actor: system(`event:${event.id}`) });
			}),
		'order.paid@1': (event) =>
			withSite(event, async (site, data) => {
				if (!site.settings.enabled('ledger') || !isId(data.orderId)) return;
				const order = await site.repos.orders.get(data.orderId);
				if (!order || data.amount?.currency !== order.currency) return;
				const method = site.settings.methods.find((m) => m.key === data.method)?.key ?? site.settings.methods.at(-1)?.key;
				await ledger.pay(
					site,
					order.id,
					{
						amount: data.amount?.amount,
						method,
						reference:
							typeof data.reference === 'string' ? data.reference : typeof data.method === 'string' ? data.method : null,
					},
					system(`event:${event.id}`),
					{ entryId: deps.stableId('pay', `${site.websiteId}|${event.id}`), publish: false },
				);
			}),
		'order.refunded@1': (event) =>
			withSite(event, async (site, data) => {
				if (!site.settings.enabled('ledger') || !isId(data.orderId)) return;
				const order = await site.repos.orders.get(data.orderId);
				if (!order || data.amount?.currency !== order.currency) return;
				const method = site.settings.methods.find((m) => m.key === data.method)?.key ?? site.settings.methods.at(-1)?.key;
				const source = typeof event.context?.product === 'string' ? event.context.product : 'external';
				await ledger.refund(
					site,
					order.id,
					{
						amount: data.amount?.amount,
						method,
						reason: typeof data.reason === 'string' && data.reason.trim() ? data.reason.slice(0, 500) : source,
						reference: `${source}:${event.id}`.slice(0, 200),
					},
					system(`event:${event.id}`),
					{ entryId: deps.stableId('rfd', `${site.websiteId}|${event.id}`), publish: false },
				);
			}),
		'order.cancelled@1': (event) =>
			withSite(event, async (site, data) => {
				if (!isId(data.orderId)) return;
				const order = await site.repos.orders.get(data.orderId);
				if (!order) return;
				const target = site.settings.matrix.transitions.find(
					(t) =>
						t.from === order.status &&
						t.publish === 'order.cancelled' &&
						t.actors.includes('system') &&
						t.requires.length === 0,
				);
				if (!target) return;
				await lifecycle.move(site, order, target.to, { actor: system(`event:${event.id}`), catalogued: false });
			}),
	};
};
