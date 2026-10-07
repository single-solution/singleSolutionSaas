/**
 * Moderation decisions (pure). A submission first goes through the content checks of the `moderation` element
 * (blocked terms, links, minimum length); a check whose action is `reject` rejects at once, any other flag sends the
 * review to the manual queue. Otherwise the merchant's rules@1 rules run in order and the first match decides
 * (approve / reject / queue), else `default_action`. Rules never approve an unverified review unless
 * `auto_approve_unverified` is on. With the element off nothing is checked and reviews are published at once.
 * @module
 */
import { conditionMatches } from './rules.js';
import { countLinks, findBlockedTerms } from './text.js';

/** Review statuses. */
export const STATUSES = Object.freeze(/** @type {const} */ (['pending', 'approved', 'rejected']));

/** @typedef {(typeof STATUSES)[number]} Status */

/**
 * @typedef {object} ModerationSettings `moderation` features
 * @property {Array<{ id: string, name?: string, when?: string, action: 'approve' | 'reject' | 'queue', reason?: string, enabled?: boolean }>} rules
 * @property {'queue' | 'approve'} default_action
 * @property {boolean} auto_approve_unverified
 * @property {string[]} blocked_terms
 * @property {'queue' | 'reject'} blocked_term_action
 * @property {number} max_links
 * @property {'queue' | 'reject'} link_action
 * @property {number} queue_shorter_than
 * @property {string[]} rejection_reasons
 * @property {boolean} replies_enabled
 * @property {number} reply_max_length
 */

/**
 * @typedef {object} Decision
 * @property {Status} status
 * @property {'check' | 'rule' | 'default' | 'unverified' | 'off'} by what decided
 * @property {string | null} ruleId
 * @property {string | null} reason rejection reason code (or why it was queued)
 * @property {string[]} flags content-check codes that fired
 * @property {string[]} terms blocked terms found (never shown publicly)
 */

/**
 * @typedef {object} Submission what moderation looks at
 * @property {number} rating
 * @property {string | null} title
 * @property {string | null} body
 * @property {boolean} verified
 * @property {number} photos
 */

/**
 * Content checks of a submission.
 * @param {Submission} review
 * @param {ModerationSettings} settings
 * @returns {{ flags: Array<{ code: 'blocked_terms' | 'links' | 'short', action: 'queue' | 'reject' }>, terms: string[] }}
 */
export const contentChecks = (review, settings) => {
	const text = [review.title ?? '', review.body ?? ''].join('\n');
	/** @type {Array<{ code: 'blocked_terms' | 'links' | 'short', action: 'queue' | 'reject' }>} */
	const flags = [];
	const terms = findBlockedTerms(text, settings.blocked_terms);
	if (terms.length > 0) flags.push({ code: 'blocked_terms', action: settings.blocked_term_action });
	if (countLinks(text) > settings.max_links) flags.push({ code: 'links', action: settings.link_action });
	if (settings.queue_shorter_than > 0 && (review.body ?? '').length < settings.queue_shorter_than)
		flags.push({ code: 'short', action: 'queue' });
	return { flags, terms };
};

/**
 * The rules@1 context of a submission.
 * @param {{ review: Submission & { itemId: string, attributes?: Record<string, number>, source?: string, locale?: string | null, scale: number },
 *   customer?: { id: string | null, identified: boolean, reviewsToday: number }, item?: { id: string, count: number, average: number },
 *   flags: string[] }} input
 */
export const moderationContext = ({ review, customer, item, flags }) => ({
	review: {
		itemId: review.itemId,
		rating: review.rating,
		scale: review.scale,
		title: review.title ?? '',
		body: review.body ?? '',
		length: (review.body ?? '').length,
		titleLength: (review.title ?? '').length,
		verified: review.verified,
		photos: review.photos,
		hasPhotos: review.photos > 0,
		attributes: review.attributes ?? {},
		source: review.source ?? 'api',
		locale: review.locale ?? null,
	},
	customer: customer ?? { id: null, identified: false, reviewsToday: 0 },
	item: item ?? { id: review.itemId, count: 0, average: 0 },
	flags,
});

/**
 * Decide the status of a submission.
 * @param {{ review: Submission, settings: ModerationSettings | null, context: Record<string, unknown>,
 *   now: number, timeZone: string }} input `settings` null = moderation element off
 * @returns {Decision}
 */
export const decide = ({ review, settings, context, now, timeZone }) => {
	if (!settings) return { status: 'approved', by: 'off', ruleId: null, reason: null, flags: [], terms: [] };
	const { flags, terms } = contentChecks(review, settings);
	const codes = flags.map((flag) => flag.code);
	const rejecting = flags.find((flag) => flag.action === 'reject');
	if (rejecting) return { status: 'rejected', by: 'check', ruleId: null, reason: rejecting.code, flags: codes, terms };
	if (flags.length > 0)
		return { status: 'pending', by: 'check', ruleId: null, reason: /** @type {string} */ (codes[0]), flags: codes, terms };
	const withFlags = { ...context, flags: codes };
	/** @param {'approve' | 'queue'} action @param {'rule' | 'default'} by @param {string | null} ruleId */
	const approveOrQueue = (action, by, ruleId) => {
		if (action === 'approve' && !review.verified && !settings.auto_approve_unverified)
			return /** @type {Decision} */ ({
				status: 'pending',
				by: 'unverified',
				ruleId,
				reason: 'unverified',
				flags: codes,
				terms,
			});
		return /** @type {Decision} */ ({
			status: action === 'approve' ? 'approved' : 'pending',
			by,
			ruleId,
			reason: null,
			flags: codes,
			terms,
		});
	};
	for (const rule of settings.rules) {
		if (rule.enabled === false) continue;
		if (!conditionMatches(rule.when, withFlags, { now, timeZone }).matched) continue;
		if (rule.action === 'reject')
			return { status: 'rejected', by: 'rule', ruleId: rule.id, reason: rule.reason || 'other', flags: codes, terms };
		return approveOrQueue(rule.action, 'rule', rule.id);
	}
	return approveOrQueue(settings.default_action, 'default', null);
};
