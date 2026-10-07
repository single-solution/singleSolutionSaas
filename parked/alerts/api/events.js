/**
 * Event consumers (Part E §9): `inventory.changed@1`, `price.changed@1` and `custom.*` from the Event Hub (and site
 * events pushed to `POST /v1/events`). Consumption is idempotent twice over: app-kit dedupes deliveries on the event
 * `id`, and the trigger run is unique on `evt:<event id>`, so even a re-processed event never claims a subscription
 * twice. Provenance: stock and price changes are trusted only from the merchant's servers — an event with a
 * `customer` / `anonymous` actor (what browser `pk_` keys may send) or pushed with a `pk_` key is ignored unless
 * `triggers.accept_customer_events` is on. Websites without an active subscription, or with `triggers` off, are ignored.
 */
import { fromInventory, fromPrice } from '../core/triggers.js';
import { toMs } from '../core/time.js';
import { isObject } from '../core/validate.js';

/**
 * Whether an event came from a trusted (server-side) source.
 * @param {any} event
 * @param {{ source?: string, website?: { kind?: string } } | undefined} meta
 */
export const fromServer = (event, meta) => {
	if (meta?.source === 'site' && meta.website?.kind !== 'sk') return false;
	return !['customer', 'anonymous'].includes(event?.actor?.type);
};

/**
 * @param {{ alerts: import('./service.js').Alerts }} deps
 * @returns {Record<string, (event: any, meta?: any) => Promise<void>>}
 */
export const createEventHandlers = ({ alerts }) => {
	const { engine, siteFor } = alerts;
	/** @param {any} event */
	const site = (event) => siteFor(event.websiteId, { element: 'triggers' });
	/** @param {any} event */
	const occurredAt = (event) => {
		const ms = toMs(event.occurredAt);
		return Number.isNaN(ms) ? alerts.deps.now() : ms;
	};
	return {
		'inventory.changed@1': async (event, meta) => {
			const s = await site(event);
			if (!s || !s.settings.triggers.consumeInventory || !isObject(event.data)) return;
			const trusted = fromServer(event, meta);
			if (!trusted && !s.settings.triggers.acceptCustomerEvents) return;
			const change = fromInventory(event.data, occurredAt(event));
			if (change) await engine.process(s, change, { source: 'event', key: `evt:${event.id}`, eventId: event.id, trusted });
		},
		'price.changed@1': async (event, meta) => {
			const s = await site(event);
			if (!s || !s.settings.triggers.consumePrice || !isObject(event.data)) return;
			const trusted = fromServer(event, meta);
			if (!trusted && !s.settings.triggers.acceptCustomerEvents) return;
			const lists = s.settings.triggers.priceLists;
			if (lists.length > 0 && typeof event.data.priceListId === 'string' && !lists.includes(event.data.priceListId)) return;
			const change = fromPrice(event.data, occurredAt(event));
			if (change) await engine.process(s, change, { source: 'event', key: `evt:${event.id}`, eventId: event.id, trusted });
		},
		// `events.consumes: custom.*` — app-kit dispatches every type to `*`; only custom events fire custom types
		'*': async (event, meta) => {
			if (typeof event.type !== 'string' || !event.type.startsWith('custom.')) return;
			const s = await site(event);
			if (!s || !s.settings.triggers.consumeCustom) return;
			await engine.process(
				s,
				{
					kind: 'custom',
					target: { itemId: '*' },
					eventType: event.type,
					data: isObject(event.data) ? event.data : {},
					at: occurredAt(event),
				},
				{ source: 'event', key: `evt:${event.id}`, eventId: event.id, trusted: fromServer(event, meta) },
			);
		},
	};
};
