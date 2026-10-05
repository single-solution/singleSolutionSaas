/**
 * The price-drop / back-in-stock hook. Consumes `price.changed@1` and `inventory.changed@1` (from Catalog, or from the
 * merchant's server through the Event Hub or `POST /v1/events` with an `sk_` key), keeps every saved entry's latest
 * price and availability, and for customers who opted in on a list publishes `wishlist.price_dropped@1` /
 * `wishlist.back_in_stock@1` — one per customer and change. No message is sent from here: Alerts or the merchant's
 * messaging decides who is told and how.
 *
 * Exactly once: app-kit dedupes deliveries on the event id, and each signal is recorded under
 * `<event id>:<customer>` (unique) before it is published with the same idempotency key, so a redelivered or
 * re-processed event never publishes twice. Provenance: price and stock are trusted only from servers — an event with a
 * `customer` / `anonymous` actor, delivered from a `pk_` key, or pushed to `POST /v1/events` with a `pk_` key is ignored
 * unless `price_drop_hook.accept_customer_events` is on.
 */
import { itemKeyOf } from '../core/item.js';
import { isRestock, priceChangeOf, priceSignals, stockChangeOf, stockSignals } from '../core/signals.js';

/** Signal records are kept this long (manifest `retention.notifications`). */
export const NOTIFICATION_RETENTION_DAYS = 90;

/**
 * Whether an event came from a trusted (server-side) source.
 * @param {any} event
 * @param {{ source?: string, website?: { kind?: string } } | undefined} meta
 */
export const fromServer = (event, meta) => {
	if (meta?.source === 'site' && meta.website?.kind !== 'sk') return false;
	if (event?.context?.keyKind === 'pk') return false;
	return !['customer', 'anonymous'].includes(event?.actor?.type);
};

/**
 * @typedef {object} SignalDeps
 * @property {() => number} now
 * @property {(prefix: string) => string} newId
 * @property {(event: { websiteId: string, type: string, data: Record<string, unknown>, idempotencyKey: string }) => Promise<void>} publish
 */

/**
 * @param {SignalDeps} deps
 */
export const createSignals = ({ now, newId, publish }) => {
	/**
	 * Record and publish the signals of one change.
	 * @param {import('./lists.js').Site} site
	 * @param {{ type: string, kind: 'price_dropped' | 'back_in_stock', eventId: string, signals: import('../core/signals.js').Signal[],
	 *   lists: Array<{ id: string, contactEmail?: string | null }>, data: (signal: import('../core/signals.js').Signal) => Record<string, unknown>,
	 *   mark: Record<string, unknown> }} input
	 */
	const emit = async (site, { type, kind, eventId, signals, lists, data, mark }) => {
		let published = 0;
		const emails = new Map(lists.map((list) => [list.id, list.contactEmail ?? null]));
		for (const signal of signals) {
			const key = `${eventId}:${signal.ownerId}`;
			const at = new Date(now()).toISOString();
			const fresh = await site.repos.notifications.record({
				key,
				id: newId('wln'),
				kind,
				itemId: signal.entry.itemId,
				variantId: signal.entry.variantId,
				ownerId: signal.ownerId,
				listIds: signal.listIds.slice(0, 100),
				eventId,
				at,
				expiresAt: new Date(now() + NOTIFICATION_RETENTION_DAYS * 86_400_000),
			});
			if (!fresh) continue;
			const email = site.settings.signals.includeEmail
				? (signal.listIds.map((id) => emails.get(id)).find((value) => typeof value === 'string') ?? null)
				: null;
			const { entry } = signal;
			await publish({
				websiteId: site.websiteId,
				type,
				idempotencyKey: key,
				data: {
					customer: { subject: signal.ownerId, ...(email ? { email } : {}) },
					itemId: entry.itemId,
					...(entry.variantId ? { variantId: entry.variantId } : {}),
					...(entry.title ? { title: entry.title } : {}),
					...(entry.url ? { url: entry.url } : {}),
					...(entry.image ? { image: entry.image } : {}),
					...data(signal),
					listIds: signal.listIds.slice(0, 100),
				},
			});
			for (const listId of signal.listIds)
				await site.repos.lists.markEntries(listId, signal.entryIds, { ...mark, signaledAt: at });
			published += 1;
		}
		return published;
	};

	return Object.freeze({
		/**
		 * @param {import('./lists.js').Site} site
		 * @param {{ id: string, data: unknown }} event
		 * @returns {Promise<{ published: number } | null>} null when the event is not usable
		 */
		price: async (site, event) => {
			const change = priceChangeOf(event.data);
			if (!change) return null;
			await site.repos.stock.put(itemKeyOf(change), { price: change.price });
			await site.repos.lists.setOnEntries(change, { price: change.price });
			const lists = await site.repos.lists.optedInWith(change.itemId, site.settings.signals.maxLists);
			const signals = priceSignals({ lists, change, settings: site.settings.signals, now: now() });
			const published = await emit(site, {
				type: 'wishlist.price_dropped@1',
				kind: 'price_dropped',
				eventId: event.id,
				signals,
				lists,
				data: (signal) => ({ price: change.price, referencePrice: signal.reference, dropPercent: signal.percent }),
				mark: { signalPrice: change.price },
			});
			return { published };
		},
		/**
		 * @param {import('./lists.js').Site} site
		 * @param {{ id: string, data: unknown }} event
		 * @returns {Promise<{ published: number } | null>} null when the event is not usable or not for a tracked location
		 */
		stock: async (site, event) => {
			const change = stockChangeOf(event.data);
			if (!change) return null;
			const { locations, inStockThreshold } = site.settings.signals;
			if (locations.length > 0 && (change.locationId === null || !locations.includes(change.locationId))) return null;
			const key = itemKeyOf(change);
			const last = await site.repos.stock.get(key);
			const restock = isRestock(change, typeof last?.available === 'number' ? last.available : null, inStockThreshold);
			await site.repos.stock.put(key, { available: change.available });
			await site.repos.lists.setOnEntries(change, { inStock: change.available >= inStockThreshold });
			if (!restock) return { published: 0 };
			const lists = await site.repos.lists.optedInWith(change.itemId, site.settings.signals.maxLists);
			const signals = stockSignals({ lists, change, settings: site.settings.signals, now: now() });
			const published = await emit(site, {
				type: 'wishlist.back_in_stock@1',
				kind: 'back_in_stock',
				eventId: event.id,
				signals,
				lists,
				data: () => ({ available: change.available, ...(change.locationId ? { locationId: change.locationId } : {}) }),
				mark: {},
			});
			return { published };
		},
	});
};

/**
 * Event handlers for app-kit `events.on` (websites without an active subscription or with the hook off are ignored).
 * @param {{ signals: ReturnType<typeof createSignals>, siteFor: (websiteId: string, options?: { element?: string }) => Promise<import('./lists.js').Site | null> }} deps
 * @returns {Record<string, (event: any, meta?: any) => Promise<void>>}
 */
export const createEventHandlers = ({ signals, siteFor }) => {
	/**
	 * @param {any} event
	 * @param {any} meta
	 */
	const siteOf = async (event, meta) => {
		const site = await siteFor(event.websiteId, { element: 'price_drop_hook' });
		if (!site) return null;
		return fromServer(event, meta) || site.settings.signals.acceptCustomerEvents ? site : null;
	};
	return {
		'price.changed@1': async (event, meta) => {
			const site = await siteOf(event, meta);
			if (site) await signals.price(site, event);
		},
		'inventory.changed@1': async (event, meta) => {
			const site = await siteOf(event, meta);
			if (site) await signals.stock(site, event);
		},
	};
};
