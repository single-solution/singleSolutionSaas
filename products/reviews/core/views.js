/**
 * Representations (pure): what Mode C returns and what the headless element renders. Public views carry only what a
 * shopper may see — the public author name, never e-mail, phone, customer id or moderation details; owner views
 * (`sk_` keys, dashboard) carry everything except internal tenant fields.
 * @module
 */
import { displayName } from './text.js';

/**
 * @typedef {object} StoredPhoto
 * @property {string} id
 * @property {string} key object key relative to the product's area of the merchant's bucket (what the storage
 *   connector takes and returns)
 * @property {string} [objectKey] the full object key in the bucket (connector `fullKey(key)`, for public base URLs)
 * @property {string} contentType
 * @property {number} size
 */

/**
 * @typedef {object} StoredReview
 * @property {string} id
 * @property {string} itemId
 * @property {string | null} variantId
 * @property {string | null} orderId
 * @property {string | null} requestId
 * @property {string | null} customerId
 * @property {{ name: string | null, email: string | null } | null} author null once anonymised
 * @property {number} rating
 * @property {number} scale
 * @property {string | null} title
 * @property {string | null} body
 * @property {Record<string, number>} attributes
 * @property {StoredPhoto[] | null} photos
 * @property {number} photoCount
 * @property {'pending' | 'approved' | 'rejected'} status
 * @property {boolean} verifiedPurchase
 * @property {'storefront' | 'request_link' | 'api' | 'import'} source
 * @property {{ by: string, ruleId: string | null, reason: string | null, flags: string[], terms: string[],
 *   note: string | null, decidedAt: string | null, actor: string | null }} moderation
 * @property {{ body: string, at: string, by: string | null } | null} reply
 * @property {string | null} locale
 * @property {string | null} externalId
 * @property {string} submittedAt
 * @property {string | null} publishedAt
 * @property {string | null} deletedAt
 * @property {Record<string, unknown> | null} custom
 * @property {unknown} [anonymizedAt]
 */

/** @typedef {(photo: StoredPhoto) => string | null} PhotoUrl */

/**
 * @param {StoredReview} review
 * @param {PhotoUrl | null} photoUrl
 */
const photosOf = (review, photoUrl) =>
	photoUrl
		? (review.photos ?? [])
				.map((photo) => ({ id: photo.id, url: photoUrl(photo), contentType: photo.contentType }))
				.filter((photo) => photo.url !== null)
		: [];

/**
 * What shoppers see.
 * @param {StoredReview} review
 * @param {{ nameFormat: import('./text.js').NAME_FORMATS[number], showReply: boolean, showVerified: boolean,
 *   photoUrl?: PhotoUrl | null }} options
 */
export const publicReview = (review, { nameFormat, showReply, showVerified, photoUrl = null }) => ({
	id: review.id,
	itemId: review.itemId,
	variantId: review.variantId,
	rating: review.rating,
	scale: review.scale,
	title: review.title,
	body: review.body,
	removed: review.anonymizedAt !== undefined && review.anonymizedAt !== null,
	author: displayName(review.author?.name, nameFormat),
	verifiedPurchase: showVerified ? review.verifiedPurchase : null,
	attributes: review.attributes ?? {},
	photos: photosOf(review, photoUrl),
	reply: showReply && review.reply ? { body: review.reply.body, at: review.reply.at } : null,
	submittedAt: review.submittedAt,
	locale: review.locale,
});

/** @typedef {ReturnType<typeof publicReview>} PublicReview */

/**
 * What the merchant sees (sk_ keys, dashboard).
 * @param {StoredReview} review
 * @param {{ photoUrl?: PhotoUrl | null }} [options]
 */
export const ownerReview = (review, { photoUrl = null } = {}) => ({
	id: review.id,
	itemId: review.itemId,
	variantId: review.variantId,
	orderId: review.orderId,
	requestId: review.requestId,
	customerId: review.customerId,
	author: review.author ?? { name: null, email: null },
	rating: review.rating,
	scale: review.scale,
	title: review.title,
	body: review.body,
	attributes: review.attributes ?? {},
	photos: photosOf(review, photoUrl),
	status: review.status,
	verifiedPurchase: review.verifiedPurchase,
	source: review.source,
	moderation: review.moderation,
	reply: review.reply,
	locale: review.locale,
	externalId: review.externalId,
	custom: review.custom ?? {},
	submittedAt: review.submittedAt,
	publishedAt: review.publishedAt,
	deletedAt: review.deletedAt,
});

/** @typedef {ReturnType<typeof ownerReview>} OwnerReview */

/**
 * A request as its customer sees it (pk_ + identity or a link token): which items can still be reviewed.
 * @param {import('./requests.js').ReviewRequest} request
 * @param {number} now
 */
export const customerRequestView = (request, now) => ({
	id: request.id,
	orderId: request.orderId,
	number: request.number,
	// an open request past its `expiresAt` is expired, whether or not the request job has marked it yet
	status: request.status === 'open' && Date.parse(request.expiresAt) <= now ? 'expired' : request.status,
	open: request.status === 'open' && Date.parse(request.expiresAt) > now,
	completedAt: request.completedAt,
	expiresAt: request.expiresAt,
	items: request.items.map((item) => ({
		itemId: item.itemId,
		variantId: item.variantId,
		title: item.title,
		sku: item.sku,
		reviewed: item.reviewId !== null,
	})),
});

/**
 * A request as the merchant sees it.
 * @param {import('./requests.js').ReviewRequest} request
 * @param {number} now
 */
export const requestView = (request, now) => ({
	...customerRequestView(request, now),
	customerId: request.customerId,
	source: request.source,
	dueAt: request.dueAt,
	items: request.items.map((item) => ({ ...item, reviewed: item.reviewId !== null })),
	delivery: {
		state: request.delivery.state,
		sends: request.delivery.sends,
		attempts: request.delivery.attempts,
		nextAt: request.delivery.nextAt,
		lastSentAt: request.delivery.lastSentAt,
		lastError: request.delivery.lastError,
		channel: request.delivery.channel,
	},
});

/**
 * @typedef {object} StoredAnswer
 * @property {string} id
 * @property {string | null} body
 * @property {{ name: string | null } | null} author
 * @property {string | null} customerId
 * @property {'merchant' | 'customer'} by
 * @property {boolean} verifiedBuyer
 * @property {'pending' | 'published' | 'rejected'} status
 * @property {string} answeredAt
 */

/**
 * @typedef {object} StoredQuestion
 * @property {string} id
 * @property {string} itemId
 * @property {string | null} body
 * @property {{ name: string | null, email: string | null } | null} author
 * @property {string | null} customerId
 * @property {'pending' | 'published' | 'rejected'} status
 * @property {StoredAnswer[]} answers
 * @property {string | null} locale
 * @property {string} askedAt
 * @property {string | null} answeredAt
 */

/**
 * @param {StoredQuestion} question
 * @param {{ nameFormat: import('./text.js').NAME_FORMATS[number], owner?: boolean }} options
 */
export const questionView = (question, { nameFormat, owner = false }) => ({
	id: question.id,
	itemId: question.itemId,
	body: question.body,
	author: owner ? (question.author ?? { name: null, email: null }) : displayName(question.author?.name, nameFormat),
	askedAt: question.askedAt,
	answeredAt: question.answeredAt,
	locale: question.locale,
	...(owner ? { status: question.status, customerId: question.customerId } : {}),
	answers: question.answers
		.filter((answer) => owner || answer.status === 'published')
		.map((answer) => ({
			id: answer.id,
			body: answer.body,
			author: answer.by === 'merchant' ? null : displayName(answer.author?.name, nameFormat),
			by: answer.by,
			verifiedBuyer: answer.verifiedBuyer,
			answeredAt: answer.answeredAt,
			...(owner ? { status: answer.status, customerId: answer.customerId } : {}),
		})),
});

/**
 * The review form definition (`GET /v1/review-form`): everything a custom form needs to validate like the API does.
 * @param {import('./validate.js').ContentLimits} content
 * @param {{ max_photos_per_review: number, max_photo_bytes: number, allowed_types: string[] } | null} photos null = off
 */
export const formView = (content, photos) => ({
	ratingScale: content.rating_scale,
	title: { enabled: content.title_max_length > 0, required: content.title_required, maxLength: content.title_max_length },
	body: { required: content.body_required, minLength: content.body_min_length, maxLength: content.body_max_length },
	authorName: { maxLength: content.author_name_max_length },
	attributes: content.attributes.map((def) => ({
		key: def.key,
		label: def.label,
		min: def.min,
		max: def.max,
		lowLabel: def.low_label ?? null,
		highLabel: def.high_label ?? null,
		required: def.required === true,
	})),
	photos: photos
		? { enabled: true, max: photos.max_photos_per_review, maxBytes: photos.max_photo_bytes, types: [...photos.allowed_types] }
		: { enabled: false, max: 0, maxBytes: 0, types: [] },
});
