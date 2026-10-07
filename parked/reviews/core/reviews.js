/**
 * Reviews (pure): eligibility of a submitter under `collection.who`, the one-review-per key, and the stored document
 * of a new review. The application service does the I/O (requests, photos, moderation context) around these.
 * @module
 */

/** Where a review came from. */
export const SOURCES = Object.freeze(/** @type {const} */ (['storefront', 'request_link', 'api', 'import']));

/**
 * Who is submitting.
 * @typedef {object} Submitter
 * @property {'server' | 'identity' | 'token' | 'guest'} via sk_ key, the website's login (SS-Identity), a request link
 *   token, or nobody
 * @property {string | null} customerId
 */

/**
 * Whether a submitter may review under the website's policy. `server` callers (sk_) act for the merchant and are
 * always allowed; their reviews are verified only when a purchase backs them.
 * @param {Submitter} submitter
 * @param {{ who: 'verified_buyers' | 'identified' | 'anyone', verified: boolean }} input
 * @returns {null | 'identity_required' | 'not_verified'}
 */
export const submissionRefusal = (submitter, { who, verified }) => {
	if (submitter.via === 'server') return null;
	if (who === 'anyone') return null;
	if (submitter.via === 'guest') return 'identity_required';
	if (who === 'verified_buyers' && !verified) return 'not_verified';
	return null;
};

/**
 * The one-review-per key (null when the customer is unknown: guest and anonymous API reviews are not deduplicated).
 * @param {{ customerId: string | null, itemId: string, orderId: string | null }} review
 * @param {'order_item' | 'item'} onePer
 * @returns {string | null}
 */
export const dedupeKeyOf = ({ customerId, itemId, orderId }, onePer) => {
	if (!customerId) return null;
	return onePer === 'item' || !orderId ? `${customerId}|${itemId}` : `${customerId}|${itemId}|${orderId}`;
};

/**
 * The stored document of a new review.
 * @param {{ id: string, value: import('./validate.js').ReviewValue, customerId: string | null, orderId: string | null,
 *   requestId: string | null, verified: boolean, source: (typeof SOURCES)[number], scale: number,
 *   photos: import('./views.js').StoredPhoto[], decision: import('./moderation.js').Decision, dedupeKey: string | null,
 *   now: string, authorName: string | null, authorEmail: string | null }} input
 * @returns {import('./views.js').StoredReview & { dedupeKey: string | null }}
 */
export const buildReview = ({
	id,
	value,
	customerId,
	orderId,
	requestId,
	verified,
	source,
	scale,
	photos,
	decision,
	dedupeKey,
	now,
	authorName,
	authorEmail,
}) => ({
	id,
	itemId: value.itemId,
	variantId: value.variantId,
	orderId,
	requestId,
	customerId,
	author: { name: authorName, email: authorEmail },
	rating: value.rating,
	scale,
	title: value.title,
	body: value.body,
	attributes: value.attributes,
	photos,
	photoCount: photos.length,
	status: decision.status,
	verifiedPurchase: verified,
	source,
	moderation: {
		by: decision.by,
		ruleId: decision.ruleId,
		reason: decision.reason,
		flags: decision.flags,
		terms: decision.terms,
		note: null,
		decidedAt: decision.status === 'pending' ? null : now,
		actor: null,
	},
	reply: null,
	locale: value.locale,
	externalId: value.externalId,
	submittedAt: now,
	publishedAt: decision.status === 'approved' ? now : null,
	deletedAt: null,
	custom: value.custom,
	dedupeKey,
});
