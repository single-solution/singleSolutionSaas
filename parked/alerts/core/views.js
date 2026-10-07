/**
 * Public views of stored records (pure): what the API returns. Addresses are masked everywhere except where a server
 * key reads them explicitly (`reveal`); internal fields (contact hashes, leases, cap reservations) never leave.
 * @module
 */
import { maskAddress } from './contact.js';

/**
 * @param {import('./subscription.js').Subscription} sub
 * @param {{ reveal?: boolean, position?: number | null }} [options]
 */
export const subscriptionView = (sub, { reveal = false, position } = {}) => ({
	id: sub.id,
	type: sub.type,
	itemId: sub.target.itemId,
	variantId: sub.target.variantId ?? null,
	channel: sub.channel,
	contact: reveal ? (sub.address ?? null) : null,
	contactMasked: maskAddress(sub.address),
	customerId: sub.customerId ?? null,
	lang: sub.lang,
	tier: sub.tier ?? null,
	status: sub.status,
	threshold: sub.threshold ?? null,
	priceAtSubscribe: sub.priceAtSubscribe ?? null,
	item: sub.item ?? null,
	consent: { given: sub.consent?.given === true, at: sub.consent?.at ?? null },
	source: sub.source,
	subscribedAt: sub.subscribedAt,
	confirmedAt: sub.confirmedAt ?? null,
	notifiedAt: sub.notifiedAt ?? null,
	endedAt: sub.endedAt ?? null,
	...(position === undefined ? {} : { position }),
});

/**
 * @param {Record<string, any>} message stored message
 */
export const messageView = (message) => ({
	id: message.id,
	kind: message.kind,
	channel: message.channel,
	to: maskAddress(message.to),
	lang: message.lang,
	status: message.status,
	items: (message.items ?? []).map((/** @type {Record<string, any>} */ item) => ({
		subscriptionId: item.subscriptionId,
		type: item.type,
		itemId: item.itemId ?? null,
		variantId: item.variantId ?? null,
	})),
	attempts: message.attempts ?? 0,
	notBefore: typeof message.notBefore === 'number' ? new Date(message.notBefore).toISOString() : null,
	sentAt: message.sentAt ?? null,
	providerMessageId: message.providerMessageId ?? null,
	error: message.error ?? null,
	createdAt: message.queuedAt ?? null,
});

/**
 * @param {Record<string, any>} trigger stored trigger run
 */
export const triggerView = (trigger) => ({
	id: trigger.id,
	source: trigger.source,
	kind: trigger.kind,
	eventId: trigger.eventId ?? null,
	eventType: trigger.eventType ?? null,
	itemId: trigger.target?.itemId ?? null,
	variantId: trigger.target?.variantId ?? null,
	before: trigger.before ?? null,
	after: trigger.after ?? null,
	status: trigger.status,
	reason: trigger.reason ?? null,
	matched: trigger.matched ?? 0,
	queued: trigger.queued ?? 0,
	more: trigger.open === true,
	at: trigger.at,
});
