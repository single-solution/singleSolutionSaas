/**
 * Reviews (feature `reviews`, PLAN 0.8.8: only after delivery, with moderation): a signed-in shopper whose delivered
 * order holds the product writes one review of it; visitors read the approved ones with the rating summary; the
 * merchant's staff (or server) approve, reject, reply and delete. The product's `rating` is kept right on every change.
 * @module
 */
import { createId } from '@ss/contracts';
import { countHandlers, created, defineRoute, noContent, ok, paginate, problem } from '@ss/app-kit';
import { isDuplicate, refreshRating, reviewSummary, userIdsOf } from '../adapters/extras-store.js';
import { afterFilter, keyOf, sortOf } from '../core/extras-pages.js';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import { REVIEW_SORTS, REVIEW_STATUSES, checkReply, checkReviewInput, reviewSort } from '../core/reviews.js';
import { SERVER_LIMITS, VISITOR_LIMITS, VISITOR_WRITE_LIMITS } from './service.js';

/** Rate limits (mutable copies of the shared constants, as route definitions take them). */
const SERVER = [...SERVER_LIMITS];
const VISITOR = [...VISITOR_LIMITS];
const VISITOR_WRITE = [...VISITOR_WRITE_LIMITS];

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/model.js').ReviewRecord & { createdAt: Date, updatedAt: Date }} StoredReview */

const NO_ID = { projection: { _id: 0 } };
const NEWEST = REVIEW_SORTS.newest;

/** @param {any} ctx */
const bodyOf = (ctx) => (typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {});

/** @param {StoredReview} review */
const publicView = (review) => ({
	id: review.id,
	name: review.name,
	rating: review.rating,
	title: review.title,
	body: review.body,
	reply: review.reply,
	createdAt: new Date(review.createdAt).toISOString(),
});

/** @param {StoredReview} review */
const staffView = (review) => ({
	...publicView(review),
	productId: review.productId,
	userId: review.userId,
	orderId: review.orderId,
	status: review.status,
	updatedAt: new Date(review.updatedAt).toISOString(),
});

/**
 * @param {Product} product
 * @param {Service} service
 */
export const createReviews = (product, service) => {
	/** @param {WebsiteData} data */
	const reviews = (data) => data.collection(COLLECTIONS.reviews);

	/**
	 * @param {WebsiteData} data
	 * @param {unknown} id
	 * @returns {Promise<StoredReview>}
	 */
	const reviewOf = async (data, id) => {
		const found =
			typeof id === 'string' && id.length <= 80
				? /** @type {StoredReview | null} */ (await reviews(data).findOne({ websiteId: data.websiteId, id }, NO_ID))
				: null;
		if (!found) throw problem('not_found', 'No such review.');
		return found;
	};

	/** @param {any} ctx */
	const write = async (ctx) => {
		const s = await service.site(ctx);
		const shopper = await service.requireShopper(s);
		const checked = checkReviewInput(bodyOf(ctx));
		if (!checked.ok) throw service.invalid(checked.field, checked.message);
		const input = checked.value;
		const data = await s.data();
		const item = await data
			.collection(COLLECTIONS.products)
			.findOne({ websiteId: data.websiteId, id: input.productId, status: 'active' }, { projection: { _id: 0, id: 1 } });
		if (!item) throw problem('not_found', 'No such product.');
		const order = await data.collection(COLLECTIONS.orders).findOne(
			{
				websiteId: data.websiteId,
				'customer.userId': shopper.id,
				deliveredAt: { $ne: null },
				'lines.productId': input.productId,
			},
			{ projection: { _id: 0, id: 1 }, sort: { deliveredAt: -1 } },
		);
		if (!order) throw problem('review_not_allowed', 'Products can be reviewed once an order with them was delivered.');
		const { moderation } = await s.values('reviews');
		/** @type {import('../core/model.js').ReviewRecord} */
		const review = {
			id: createId(ID_PREFIX.review),
			productId: input.productId,
			userId: shopper.id,
			orderId: String(order.id),
			name: shopper.name.trim().slice(0, 80),
			rating: input.rating,
			title: input.title,
			body: input.body,
			status: moderation === 'auto' ? 'approved' : 'pending',
			reply: '',
		};
		try {
			await reviews(data).insertOne({ ...review });
		} catch (error) {
			if (isDuplicate(error)) throw problem('already_reviewed', 'You have already reviewed this product.');
			throw error;
		}
		if (review.status === 'approved') await refreshRating(data, review.productId);
		return created(staffView(await reviewOf(data, review.id)));
	};

	/** @param {any} ctx */
	const productReviews = async (ctx) => {
		const page = paginate(
			{ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url },
			{ defaultLimit: 10, maxLimit: 50 },
		);
		const s = await service.site(ctx);
		const data = await s.data();
		const productId = String(ctx.params.id);
		const fields = REVIEW_SORTS[reviewSort(ctx.query.sort)];
		const rows = /** @type {StoredReview[]} */ (
			await reviews(data)
				.find(
					{ websiteId: data.websiteId, productId, status: 'approved', ...afterFilter(fields, page.after) },
					{ ...NO_ID, sort: sortOf(fields), limit: page.fetchLimit },
				)
				.toArray()
		);
		const body = page.page(rows.map(publicView), (view) => keyOf(fields, view));
		const link = page.link(body.nextCursor);
		return ok({ ...body, summary: await reviewSummary(data, productId) }, { headers: link ? { link } : {} });
	};

	/**
	 * The staff review list's collection and filter (`status`, `productId`), shared by the list and its counts
	 * (PLAN 0.8.10 K4).
	 * @param {any} ctx
	 */
	const reviewSource = async (ctx) => {
		const data = await (await service.site(ctx)).data();
		const { status, productId } = ctx.query;
		return {
			collection: reviews(data),
			filter: {
				websiteId: data.websiteId,
				...(REVIEW_STATUSES.includes(status) ? { status } : {}),
				...(typeof productId === 'string' && productId ? { productId } : {}),
			},
		};
	};
	const reviewCounts = countHandlers({ source: reviewSource, by: { status: 'status' } });

	/** @param {any} ctx */
	const list = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const { collection, filter } = await reviewSource(ctx);
		const rows = /** @type {StoredReview[]} */ (
			await collection
				.find({ ...filter, ...afterFilter(NEWEST, page.after) }, { ...NO_ID, sort: sortOf(NEWEST), limit: page.fetchLimit })
				.toArray()
		);
		return page.respond(rows.map(staffView), (view) => keyOf(NEWEST, view));
	};

	/**
	 * A review as the activity log names it: the name of its product.
	 * @param {WebsiteData} data @param {StoredReview} review
	 */
	const reviewLabel = async (data, review) => {
		const found = await data
			.collection(COLLECTIONS.products)
			.findOne({ websiteId: data.websiteId, id: review.productId }, { projection: { _id: 0, name: 1 } });
		return { label: `${found ? String(found.name) : review.productId} (${review.rating}★)` };
	};

	/**
	 * Approve or reject.
	 * @param {'approved' | 'rejected'} status
	 */
	const moderate = (status) => async (/** @type {any} */ ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const review = await reviewOf(data, ctx.params.id);
		if (review.status !== status) {
			await reviews(data).updateOne({ websiteId: data.websiteId, id: review.id }, { $set: { status } });
			await refreshRating(data, review.productId);
			await service.log(ctx, `review.${status}`, review.id, {
				...(await reviewLabel(data, review)),
				detail: `${review.status} → ${status}`,
			});
		}
		return staffView(await reviewOf(data, review.id));
	};

	/** @param {any} ctx */
	const reply = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const review = await reviewOf(data, ctx.params.id);
		const checked = checkReply(bodyOf(ctx).reply);
		if (!checked.ok) throw service.invalid('reply', checked.message);
		await reviews(data).updateOne({ websiteId: data.websiteId, id: review.id }, { $set: { reply: checked.reply } });
		await service.log(ctx, 'review.replied', review.id, {
			...(await reviewLabel(data, review)),
			detail: checked.reply ? 'Reply saved' : 'Reply removed',
		});
		return staffView(await reviewOf(data, review.id));
	};

	/** @param {any} ctx */
	const remove = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const review = await reviewOf(data, ctx.params.id);
		await reviews(data).deleteOne({ websiteId: data.websiteId, id: review.id });
		if (review.status === 'approved') await refreshRating(data, review.productId);
		await service.log(ctx, 'review.deleted', review.id, await reviewLabel(data, review));
		return noContent();
	};

	/**
	 * @param {Site} s
	 * @param {{ id?: string, email?: string, phone?: string }} person
	 */
	const exportUser = async (s, person) => {
		const data = await s.data();
		const users = await userIdsOf(data, person);
		const rows = /** @type {StoredReview[]} */ (
			users.length === 0
				? []
				: await reviews(data)
						.find({ websiteId: data.websiteId, userId: { $in: users } }, NO_ID)
						.toArray()
		);
		return { reviews: rows.map(staffView) };
	};

	/**
	 * A person's reviews are deleted and the ratings of their products recomputed.
	 * @param {Site} s
	 * @param {{ id?: string, email?: string, phone?: string }} person
	 */
	const deleteUser = async (s, person) => {
		const data = await s.data();
		const users = await userIdsOf(data, person);
		if (users.length === 0) return { deleted: 0, anonymised: 0 };
		const filter = { websiteId: data.websiteId, userId: { $in: users } };
		const products = await reviews(data).distinct('productId', { ...filter, status: 'approved' });
		const result = await reviews(data).deleteMany(filter);
		for (const productId of products) await refreshRating(data, String(productId));
		return { deleted: result.deletedCount, anonymised: 0 };
	};

	const routes = [
		defineRoute({
			method: 'POST',
			path: '/v1/shop/reviews',
			auth: 'browser',
			feature: 'reviews',
			idempotent: true,
			rateLimit: VISITOR_WRITE,
			handler: write,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/shop/products/:id/reviews',
			auth: 'browser',
			feature: 'reviews',
			rateLimit: VISITOR,
			handler: productReviews,
		}),

		defineRoute({ method: 'GET', path: '/v1/reviews', auth: 'server', feature: 'reviews', rateLimit: SERVER, handler: list }),
		defineRoute({
			method: 'GET',
			path: '/v1/reviews/count',
			auth: 'server',
			feature: 'reviews',
			rateLimit: SERVER,
			handler: reviewCounts.count,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/reviews/counts',
			auth: 'server',
			feature: 'reviews',
			rateLimit: SERVER,
			handler: reviewCounts.counts,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/reviews/:id/approve',
			auth: 'server',
			feature: 'reviews',
			rateLimit: SERVER,
			handler: moderate('approved'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/reviews/:id/reject',
			auth: 'server',
			feature: 'reviews',
			rateLimit: SERVER,
			handler: moderate('rejected'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/reviews/:id/reply',
			auth: 'server',
			feature: 'reviews',
			rateLimit: SERVER,
			handler: reply,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/reviews/:id',
			auth: 'server',
			feature: 'reviews',
			rateLimit: SERVER,
			handler: remove,
		}),

		defineRoute({
			method: 'GET',
			path: '/v1/admin/reviews',
			auth: 'ticket',
			feature: 'reviews',
			permission: 'reviews.moderate',
			rateLimit: SERVER,
			handler: list,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/reviews/count',
			auth: 'ticket',
			feature: 'reviews',
			permission: 'reviews.moderate',
			rateLimit: SERVER,
			handler: reviewCounts.count,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/reviews/counts',
			auth: 'ticket',
			feature: 'reviews',
			permission: 'reviews.moderate',
			rateLimit: SERVER,
			handler: reviewCounts.counts,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/reviews/:id/approve',
			auth: 'ticket',
			feature: 'reviews',
			permission: 'reviews.moderate',
			rateLimit: SERVER,
			handler: moderate('approved'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/reviews/:id/reject',
			auth: 'ticket',
			feature: 'reviews',
			permission: 'reviews.moderate',
			rateLimit: SERVER,
			handler: moderate('rejected'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/reviews/:id/reply',
			auth: 'ticket',
			feature: 'reviews',
			permission: 'reviews.moderate',
			rateLimit: SERVER,
			handler: reply,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/reviews/:id',
			auth: 'ticket',
			feature: 'reviews',
			permission: 'reviews.moderate',
			rateLimit: SERVER,
			handler: remove,
		}),
	];

	return { routes, exportUser, deleteUser };
};
