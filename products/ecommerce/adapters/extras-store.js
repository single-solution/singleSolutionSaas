/**
 * The shopper extras' records in the merchant database (return claims, reviews, wishlists, alerts): their indexes and
 * the queries shared by the extras' routes — the product rating kept from approved reviews, and the Accounts users a
 * data-rights request is about.
 * @module
 */
import { COLLECTIONS } from '../core/model.js';
import { ratingSummary } from '../core/reviews.js';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */

/** Merchant database indexes of this part. @type {import('@ss/app-kit').IndexDefinition[]} */
export const INDEXES = [
	{ collection: COLLECTIONS.returns, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: COLLECTIONS.returns, keys: { websiteId: 1, createdAt: -1, id: -1 }, name: 'newest' },
	{ collection: COLLECTIONS.returns, keys: { websiteId: 1, orderId: 1 }, name: 'by_order' },
	{ collection: COLLECTIONS.returns, keys: { websiteId: 1, userId: 1, createdAt: -1 }, name: 'by_user' },
	{ collection: COLLECTIONS.reviews, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	// one review per product per shopper, or per order line with `per: order_line` (E34; a product review has no line)
	{
		collection: COLLECTIONS.reviews,
		keys: { websiteId: 1, productId: 1, userId: 1, lineId: 1 },
		name: 'one_per_reviewer',
		unique: true,
	},
	{ collection: COLLECTIONS.reviews, keys: { websiteId: 1, orderId: 1, lineId: 1 }, name: 'by_line' },
	{ collection: COLLECTIONS.reviews, keys: { websiteId: 1, productId: 1, status: 1, createdAt: -1 }, name: 'by_product' },
	{ collection: COLLECTIONS.reviews, keys: { websiteId: 1, status: 1, createdAt: -1 }, name: 'by_status' },
	{ collection: COLLECTIONS.reviews, keys: { websiteId: 1, userId: 1 }, name: 'by_user' },
	{ collection: COLLECTIONS.wishlists, keys: { websiteId: 1, userId: 1 }, name: 'by_user', unique: true },
	{ collection: COLLECTIONS.alerts, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: COLLECTIONS.alerts, keys: { websiteId: 1, userId: 1 }, name: 'by_user' },
	{ collection: COLLECTIONS.alerts, keys: { websiteId: 1, productId: 1, status: 1 }, name: 'by_product' },
	{ collection: COLLECTIONS.alerts, keys: { websiteId: 1, status: 1, dueAt: 1 }, name: 'due' },
	// one waiting alert of a kind per shopper (a guest: per phone or email address, E34, E15) and product (or variant)
	{
		collection: COLLECTIONS.alerts,
		keys: { websiteId: 1, userId: 1, phone: 1, email: 1, kind: 1, productId: 1, variantId: 1 },
		name: 'one_waiting_per_contact',
		unique: true,
		partialFilterExpression: { status: 'waiting' },
	},
	// the unsubscribe link's token, kept as its hash (E34)
	{
		collection: COLLECTIONS.alerts,
		keys: { websiteId: 1, tokenHash: 1 },
		name: 'by_token',
		partialFilterExpression: { tokenHash: { $type: 'string' } },
	},
];

/**
 * The approved reviews' summary of a product (count per star, average).
 * @param {WebsiteData} data
 * @param {string} productId
 */
export const reviewSummary = async (data, productId) => {
	const perStar = await data
		.collection(COLLECTIONS.reviews)
		.aggregate([
			{ $match: { websiteId: data.websiteId, productId, status: 'approved' } },
			{ $group: { _id: '$rating', count: { $sum: 1 } } },
		])
		.toArray();
	return ratingSummary(perStar.map((row) => ({ rating: Number(row._id), count: Number(row.count) })));
};

/**
 * The answers to the review questions of a product's approved reviews, counted per question and answer (E40).
 * @param {WebsiteData} data
 * @param {string} productId
 * @returns {Promise<Array<{ key: string, value: unknown, count: number }>>}
 */
export const answerCounts = async (data, productId) =>
	(
		await data
			.collection(COLLECTIONS.reviews)
			.aggregate([
				{ $match: { websiteId: data.websiteId, productId, status: 'approved', answers: { $type: 'object' } } },
				{ $project: { _id: 0, answer: { $objectToArray: '$answers' } } },
				{ $unwind: '$answer' },
				{ $group: { _id: { key: '$answer.k', value: '$answer.v' }, count: { $sum: 1 } } },
			])
			.toArray()
	).map((row) => ({ key: String(row._id?.key ?? ''), value: row._id?.value, count: Number(row.count) }));

/**
 * Keep a product's `rating` right after its approved reviews changed.
 * @param {WebsiteData} data
 * @param {string} productId
 */
export const refreshRating = async (data, productId) => {
	const { average, count } = await reviewSummary(data, productId);
	await data
		.collection(COLLECTIONS.products)
		.updateOne({ websiteId: data.websiteId, id: productId }, { $set: { rating: { average, count } } });
};

/**
 * The Accounts user ids a data-rights request is about: the id given, and the users of orders and alerts with the
 * email or phone given.
 * @param {WebsiteData} data
 * @param {{ id?: string, email?: string, phone?: string }} person
 * @returns {Promise<string[]>}
 */
export const userIdsOf = async (data, person) => {
	const ids = new Set(person.id ? [person.id] : []);
	const contact = [...(person.email ? [{ email: person.email }] : []), ...(person.phone ? [{ phone: person.phone }] : [])];
	if (contact.length > 0) {
		const orders = await data.collection(COLLECTIONS.orders).distinct('customer.userId', {
			websiteId: data.websiteId,
			$or: contact.map((c) => (c.email ? { 'customer.email': c.email } : { 'customer.phone': c.phone })),
		});
		const alerts = await data.collection(COLLECTIONS.alerts).distinct('userId', { websiteId: data.websiteId, $or: contact });
		for (const id of [...orders, ...alerts]) if (typeof id === 'string' && id) ids.add(id);
	}
	return [...ids];
};
