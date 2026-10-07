/**
 * Review requests (pure): one per completed order, listing the order's items. A request makes the customer's reviews
 * of those items **verified** while it is open (`collection.review_window_days` after completion), is due at
 * completion, and is sent — then reminded — by the request flow through the merchant's messaging connector (the flow
 * runs when an order completes or on demand; nothing runs on a timer). Every transition is a plain function of
 * (request, settings, now).
 * @module
 */
import { DAY_MS, HOUR_MS, iso, toMs } from './time.js';

/** Request statuses: open (reviews accepted), completed (every item reviewed), expired, cancelled. */
export const REQUEST_STATUSES = Object.freeze(/** @type {const} */ (['open', 'completed', 'expired', 'cancelled']));
/** Delivery states: scheduled → sent (reminders pending) → done; failed after the last attempt; off when not sent. */
export const DELIVERY_STATES = Object.freeze(/** @type {const} */ (['scheduled', 'sent', 'done', 'failed', 'off']));

/**
 * @typedef {object} RequestItem
 * @property {string} itemId
 * @property {string | null} variantId
 * @property {string | null} title
 * @property {string | null} sku
 * @property {string | null} reviewId set once the customer reviewed it through this request
 */

/**
 * @typedef {object} ReviewRequest
 * @property {string} id
 * @property {string} orderId
 * @property {string | null} number
 * @property {string} customerId
 * @property {string[]} customerKeys
 * @property {{ name: string | null, email: string | null, phone: string | null }} contact
 * @property {RequestItem[]} items
 * @property {(typeof REQUEST_STATUSES)[number]} status
 * @property {string} completedAt
 * @property {string} dueAt
 * @property {string} expiresAt
 * @property {string | null} locale
 * @property {'event' | 'api'} source
 * @property {{ state: (typeof DELIVERY_STATES)[number], sends: number, attempts: number, nextAt: string | null,
 *   firstSentAt: string | null, lastSentAt: string | null, lastError: string | null, channel: string | null }} delivery
 */

/**
 * A new request for a completed order.
 * @param {{ id: string, order: import('./orders.js').OrderFacts & { customerId: string }, completedAt: number,
 *   windowDays: number, locale?: string | null, source?: 'event' | 'api' }} input
 * @returns {ReviewRequest}
 */
export const buildRequest = ({ id, order, completedAt, windowDays, locale = null, source = 'event' }) => {
	const due = completedAt;
	return {
		id,
		orderId: order.orderId,
		number: order.number,
		customerId: order.customerId,
		customerKeys: order.customerKeys.length > 0 ? order.customerKeys : [order.customerId],
		contact: order.contact,
		items: order.lines.map((line) => ({ ...line, reviewId: null })),
		status: 'open',
		completedAt: iso(completedAt),
		dueAt: iso(due),
		expiresAt: iso(completedAt + windowDays * DAY_MS),
		locale,
		source,
		delivery: {
			state: 'scheduled',
			sends: 0,
			attempts: 0,
			nextAt: iso(due),
			firstSentAt: null,
			lastSentAt: null,
			lastError: null,
			channel: null,
		},
	};
};

/**
 * Whether a request accepts a review of an item right now.
 * @param {ReviewRequest} request
 * @param {string} itemId
 * @param {number} now
 * @returns {'ok' | 'not_in_order' | 'already_reviewed' | 'closed' | 'expired'}
 */
export const itemEligibility = (request, itemId, now) => {
	if (request.status === 'cancelled') return 'closed';
	if (request.status === 'expired' || toMs(request.expiresAt) <= now) return 'expired';
	const item = request.items.find((candidate) => candidate.itemId === itemId);
	if (!item) return 'not_in_order';
	if (item.reviewId) return 'already_reviewed';
	return 'ok';
};

/**
 * Items still waiting for a review.
 * @param {ReviewRequest} request
 */
export const pendingItems = (request) => request.items.filter((item) => !item.reviewId);

/** Channels a request can go out on. */
export const CHANNELS = Object.freeze(/** @type {const} */ (['email', 'sms', 'whatsapp']));

/**
 * The first configured channel the customer has a contact for.
 * @param {ReviewRequest['contact']} contact
 * @param {readonly string[]} channels
 * @returns {{ channel: string, to: string } | null}
 */
export const pickChannel = (contact, channels) => {
	for (const channel of channels) {
		const to = channel === 'email' ? contact.email : channel === 'sms' || channel === 'whatsapp' ? contact.phone : null;
		if (to) return { channel, to };
	}
	return null;
};

/**
 * The review page link: the merchant's URL template with `{token}`, `{orderId}` and `{requestId}` filled in.
 * Null without a template.
 * @param {string} template
 * @param {{ token: string, orderId: string, requestId: string }} values
 * @returns {string | null}
 */
export const reviewUrl = (template, values) => {
	if (typeof template !== 'string' || !template.startsWith('https://')) return null;
	return template.replace(/\{(token|orderId|requestId)\}/g, (_, name) =>
		encodeURIComponent(values[/** @type {'token' | 'orderId' | 'requestId'} */ (name)]),
	);
};

/**
 * What the request flow should do with a due request now.
 * @param {ReviewRequest} request
 * @param {{ now: number, reminders: readonly number[], quiet: boolean }} input `quiet`: inside quiet hours
 * @returns {{ action: 'expire' } | { action: 'done' } | { action: 'wait' } | { action: 'send', kind: 'request' | 'reminder' }}
 */
export const nextStep = (request, { now, reminders, quiet }) => {
	if (request.status !== 'open') return { action: 'done' };
	if (toMs(request.expiresAt) <= now) return { action: 'expire' };
	if (pendingItems(request).length === 0) return { action: 'done' };
	const { sends } = request.delivery;
	if (sends > reminders.length) return { action: 'done' };
	if (quiet) return { action: 'wait' };
	return { action: 'send', kind: sends === 0 ? 'request' : 'reminder' };
};

/**
 * Delivery after a successful send: the next reminder (days after the first send) or done.
 * @param {ReviewRequest} request
 * @param {{ now: number, reminders: readonly number[], channel: string }} input
 * @returns {ReviewRequest['delivery']}
 */
export const afterSent = (request, { now, reminders, channel }) => {
	const sends = request.delivery.sends + 1;
	const first = request.delivery.firstSentAt ?? iso(now);
	const nextDays = reminders[sends - 1];
	const next = nextDays === undefined ? null : toMs(first) + nextDays * DAY_MS;
	const expires = toMs(request.expiresAt);
	return {
		...request.delivery,
		state: next !== null && next < expires ? 'sent' : 'done',
		sends,
		attempts: 0,
		nextAt: next !== null && next < expires ? iso(Math.max(next, now + HOUR_MS)) : null,
		firstSentAt: first,
		lastSentAt: iso(now),
		lastError: null,
		channel,
	};
};

/**
 * Delivery after a failed attempt: exponential back-off (1 h, 2 h, 4 h, …), failed after `maxAttempts`.
 * @param {ReviewRequest} request
 * @param {{ now: number, maxAttempts: number, error: string, permanent?: boolean }} input `permanent`: no retry
 * @returns {ReviewRequest['delivery']}
 */
export const afterFailure = (request, { now, maxAttempts, error, permanent = false }) => {
	const attempts = request.delivery.attempts + 1;
	const failed = permanent || attempts >= maxAttempts;
	return {
		...request.delivery,
		state: failed ? 'failed' : request.delivery.state,
		attempts,
		nextAt: failed ? null : iso(now + HOUR_MS * 2 ** (attempts - 1)),
		lastError: error.slice(0, 200),
	};
};
