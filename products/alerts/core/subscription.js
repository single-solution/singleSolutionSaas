/**
 * Subscriptions (pure): the lifecycle of one "notify me" request and how it is built from a validated request.
 *
 *   unconfirmed ──confirm──▶ pending ──trigger claims──▶ claimed ──message sent──▶ notified
 *        │                      ▲  │                        │
 *        │                      │  └── expire ──▶ expired    └── send failed ──▶ pending (re-armed) | failed
 *        └──────── unsubscribe (any active state) ──▶ unsubscribed
 *
 * `active` (unconfirmed, pending, claimed) subscriptions are unique per contact, type and target, so subscribing twice
 * updates the existing one (as ibrahimMobiles did per phone and variant). A trigger claims a subscription by moving it
 * pending → claimed with a new `cycle` (compare-and-set), which is what makes one alert per change exactly once even
 * with duplicate deliveries or several instances.
 * @module
 */
import { DAY_MS, HOUR_MS, iso } from './time.js';
import { targetKeyOf } from './types.js';

export const STATUSES = Object.freeze(
	/** @type {const} */ (['unconfirmed', 'pending', 'claimed', 'notified', 'unsubscribed', 'expired', 'failed']),
);
export const ACTIVE_STATUSES = Object.freeze(/** @type {const} */ (['unconfirmed', 'pending', 'claimed']));

/** @typedef {(typeof STATUSES)[number]} Status */

/**
 * @typedef {object} Subscription
 * @property {string} id `als_…`
 * @property {string} type
 * @property {{ itemId: string, variantId?: string }} target
 * @property {string} targetKey
 * @property {import('./contact.js').Channel} channel
 * @property {import('./contact.js').Address | null} address null once anonymised
 * @property {string} contactKey keyed hash of the contact
 * @property {string | null} customerId the website's own customer id (identity subject) when known
 * @property {string} lang
 * @property {string | null} tier
 * @property {number} rank waitlist rank (lower = earlier)
 * @property {Status} status
 * @property {boolean} [active] present (true) while the status is active
 * @property {number} cycle claims so far
 * @property {import('./types.js').Threshold | null} threshold
 * @property {import('./types.js').Money | null} priceAtSubscribe
 * @property {{ name?: string, url?: string } | null} item display details captured with the subscription
 * @property {{ given: boolean, at: string | null, textVersion: string | null }} consent
 * @property {'widget' | 'api' | 'import'} source
 * @property {string} subscribedAt ISO
 * @property {string | null} confirmedAt
 * @property {string | null} claimedAt
 * @property {string | null} notifiedAt
 * @property {string | null} endedAt
 * @property {Date} expiresAt TTL anchor
 */

/**
 * @param {Status} status
 */
export const isActive = (status) => /** @type {readonly string[]} */ (ACTIVE_STATUSES).includes(status);

/**
 * Build a new subscription.
 * @param {{ id: string, type: string, target: { itemId: string, variantId?: string | null }, channel: import('./contact.js').Channel,
 *   address: import('./contact.js').Address, contactKey: string, customerId: string | null, lang: string, tier: string | null, rank: number,
 *   threshold: import('./types.js').Threshold | null, priceAtSubscribe: import('./types.js').Money | null,
 *   item: { name?: string, url?: string } | null, consent: { given: boolean, textVersion: string | null },
 *   source: 'widget' | 'api' | 'import', confirm: boolean, now: number, pendingDays: number, confirmHours: number }} input
 * @returns {Subscription}
 */
export const newSubscription = (input) => {
	const target = input.target.variantId
		? { itemId: input.target.itemId, variantId: input.target.variantId }
		: { itemId: input.target.itemId };
	const status = input.confirm ? 'unconfirmed' : 'pending';
	return {
		id: input.id,
		type: input.type,
		target,
		targetKey: targetKeyOf(target),
		channel: input.channel,
		address: input.address,
		contactKey: input.contactKey,
		customerId: input.customerId,
		lang: input.lang,
		tier: input.tier,
		rank: input.rank,
		status,
		active: true,
		cycle: 0,
		threshold: input.threshold,
		priceAtSubscribe: input.priceAtSubscribe,
		item: input.item,
		consent: {
			given: input.consent.given,
			at: input.consent.given ? iso(input.now) : null,
			textVersion: input.consent.textVersion,
		},
		source: input.source,
		subscribedAt: iso(input.now),
		confirmedAt: input.confirm ? null : iso(input.now),
		claimedAt: null,
		notifiedAt: null,
		endedAt: null,
		expiresAt: new Date(input.now + (input.confirm ? input.confirmHours * HOUR_MS : input.pendingDays * DAY_MS)),
	};
};

/**
 * Display details from untrusted input: the name as text, the URL only when it is on the website's own domain
 * (policy `same_site`), any https URL (`any_https`) or never (`none`).
 * @param {{ name?: unknown, url?: unknown } | undefined} item
 * @param {{ domain: string, allowSubdomains: boolean, policy: 'same_site' | 'any_https' | 'none' }} site
 * @returns {{ name?: string, url?: string } | null}
 */
export const sanitizeItem = (item, { domain, allowSubdomains, policy }) => {
	if (!item) return null;
	/** @type {{ name?: string, url?: string }} */
	const out = {};
	if (typeof item.name === 'string' && item.name.trim())
		out.name = [...item.name]
			.map((char) => (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f ? ' ' : char))
			.join('')
			.trim()
			.slice(0, 200);
	if (typeof item.url === 'string' && policy !== 'none') {
		try {
			const url = new URL(item.url);
			const host = url.hostname.toLowerCase();
			const sameSite = host === domain || (allowSubdomains && host.endsWith(`.${domain}`));
			if (url.protocol === 'https:' && !url.username && !url.password && (policy === 'any_https' || sameSite))
				out.url = url.href;
		} catch {
			// not a URL: dropped
		}
	}
	return Object.keys(out).length > 0 ? out : null;
};

/**
 * Display details of an update (existing details are kept for fields the update does not set).
 * @param {{ name?: string, url?: string } | null} current
 * @param {{ name?: string, url?: string } | null} update
 */
export const mergeItem = (current, update) => (update ? { ...(current ?? {}), ...update } : current);
