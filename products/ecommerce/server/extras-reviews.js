/**
 * Reviews (feature `reviews`, PLAN 0.8.8: only after delivery, with moderation): a signed-in shopper whose delivered
 * order holds the product writes one review of it; with `per: order_line` (E34) one review per order line instead,
 * written from the order page by the order's owner (their sign-in, or a guest's order key in `SS-Order-Key`, E21).
 * Visitors read the approved ones with the rating summary, `pageSize` at a time, each with `verified` (written from an
 * order), the variant bought and the name as `nameFormat` shows it; the merchant's staff (or server) approve, reject,
 * set back to pending, reply and delete. The product's `rating` is kept right on every change.
 * @module
 */
import { createId } from '@ss/contracts';
import { countHandlers, created, defineRoute, noContent, ok, paginate, problem } from '@ss/app-kit';
import { keyOpens } from '../adapters/crypto.js';
import { answerCounts, isDuplicate, refreshRating, reviewSummary, userIdsOf } from '../adapters/extras-store.js';
import { afterFilter, keyOf, sortOf } from '../core/extras-pages.js';
import { COLLECTIONS, ID_PREFIX, NO_ID } from '../core/model.js';
import {
	REVIEW_SORTS,
	REVIEW_STATUSES,
	answerSummary,
	answersView,
	checkAnswers,
	checkLineReviewInput,
	checkReply,
	checkReviewInput,
	reviewSort,
	shownName,
} from '../core/reviews.js';
import { SERVER_LIMITS, VISITOR_LIMITS, VISITOR_WRITE_LIMITS, bodyOf } from './service.js';
import { activeProduct } from './seo-reads.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/model.js').ReviewRecord & { createdAt: Date, updatedAt: Date }} StoredReview */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */
/** @typedef {import('../core/model.js').ReviewRecord} ReviewRecord */

const NEWEST = REVIEW_SORTS.newest;
/** The header a guest's order key comes in (E21). */
const ORDER_KEY_HEADER = 'ss-order-key';
/** What a review needs of its order. */
const ORDER_FIELDS = { projection: { _id: 0, id: 1, customer: 1, accessKeyHash: 1, deliveredAt: 1, lines: 1 } };

/**
 * A review as visitors see it: the name as `nameFormat` shows it, `verified` when written from an order, and the
 * variant bought (E34), and the answers to the merchant's questions still asked (E40).
 * @param {StoredReview} review
 * @param {unknown} [nameFormat]
 * @param {ReadonlyArray<import('../core/reviews.js').ReviewQuestion>} [questions]
 */
const publicView = (review, nameFormat = 'full', questions = []) => ({
	id: review.id,
	name: shownName(review.name, nameFormat),
	verified: Boolean(review.orderId),
	variantName: review.variantName ?? '',
	rating: review.rating,
	title: review.title,
	body: review.body,
	reply: review.reply,
	answers: answersView(review.answers, questions),
	createdAt: new Date(review.createdAt).toISOString(),
});

/**
 * @param {StoredReview} review
 * @param {ReadonlyArray<import('../core/reviews.js').ReviewQuestion>} [questions]
 */
const staffView = (review, questions = []) => ({
	...publicView(review, 'full', questions),
	productId: review.productId,
	userId: review.userId,
	orderId: review.orderId,
	lineId: review.lineId ?? null,
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

	/**
	 * Save a new review (approved at once with `moderation: auto`) and keep the product's rating right.
	 * @param {Site} s
	 * @param {WebsiteData} data
	 * @param {Omit<import('../core/model.js').ReviewRecord, 'id' | 'status' | 'reply'>} input
	 * @param {string} duplicate the answer to a second review
	 */
	const save = async (s, data, input, duplicate) => {
		const { moderation } = await s.values('reviews');
		/** @type {import('../core/model.js').ReviewRecord} */
		const review = {
			id: createId(ID_PREFIX.review),
			...input,
			status: moderation === 'auto' ? 'approved' : 'pending',
			reply: '',
		};
		try {
			await reviews(data).insertOne({ ...review });
		} catch (error) {
			if (isDuplicate(error)) throw problem('already_reviewed', duplicate);
			throw error;
		}
		if (review.status === 'approved') await refreshRating(data, review.productId);
		await service.emit('review.submitted', s, { review });
		return created(staffView(await reviewOf(data, review.id), await s.list('review_questions')));
	};

	/**
	 * A review of a product (`per: product`): by a signed-in shopper with a delivered order holding it.
	 * @param {any} ctx @param {Site} s
	 */
	const writeProduct = async (ctx, s) => {
		const shopper = await service.requireShopper(s);
		const checked = checkReviewInput(bodyOf(ctx));
		if (!checked.ok) throw service.invalid(checked.field, checked.message);
		const input = checked.value;
		const answers = await answersOf(s, ctx);
		const data = await s.data();
		await activeProduct(data, input.productId);
		const order = /** @type {Pick<OrderRecord, 'id' | 'lines'> | null} */ (
			await data.collection(COLLECTIONS.orders).findOne(
				{
					websiteId: data.websiteId,
					'customer.userId': shopper.id,
					deliveredAt: { $ne: null },
					'lines.productId': input.productId,
				},
				{ projection: { _id: 0, id: 1, lines: 1 }, sort: { deliveredAt: -1 } },
			)
		);
		if (!order) throw problem('review_not_allowed', 'Products can be reviewed once an order with them was delivered.');
		return save(
			s,
			data,
			{
				productId: input.productId,
				userId: shopper.id,
				orderId: String(order.id),
				lineId: null,
				variantName: order.lines.find((line) => line.productId === input.productId)?.variantName ?? '',
				name: shopper.name.trim().slice(0, 80),
				rating: input.rating,
				title: input.title,
				body: input.body,
				answers,
			},
			'You have already reviewed this product.',
		);
	};

	/**
	 * A review of one order line (`per: order_line`, E34): by the order's owner — their sign-in, or the guest's order
	 * key — once the order was delivered.
	 * @param {any} ctx @param {Site} s
	 */
	const writeLine = async (ctx, s) => {
		const shopper = await service.shopper(s);
		const key = ctx.headers?.get?.(ORDER_KEY_HEADER);
		if (!shopper && !key) throw problem('sign_in_required', 'Sign in to continue.');
		const checked = checkLineReviewInput(bodyOf(ctx));
		if (!checked.ok) throw service.invalid(checked.field, checked.message);
		const input = checked.value;
		const answers = await answersOf(s, ctx);
		const data = await s.data();
		const order = /** @type {OrderRecord | null} */ (
			await data.collection(COLLECTIONS.orders).findOne({ websiteId: data.websiteId, id: input.orderId }, ORDER_FIELDS)
		);
		const owner = order?.customer.userId ?? '';
		const mine = order && ((shopper && owner === shopper.id) || (key && keyOpens(key, order.accessKeyHash ?? null)));
		if (!order || !mine) throw problem('not_found', 'There is no such order.');
		const line = order.lines.find((entry) => entry.id === input.lineId);
		if (!line) throw service.invalid('lineId', 'This order has no such item.');
		if (!order.deliveredAt) throw problem('review_not_allowed', 'Items can be reviewed once their order was delivered.');
		await activeProduct(data, line.productId);
		if (await reviews(data).findOne({ websiteId: data.websiteId, orderId: order.id, lineId: line.id }, NO_ID))
			throw problem('already_reviewed', 'You have already reviewed this item.');
		const name = shopper && owner === shopper.id ? shopper.name : order.customer.name;
		return save(
			s,
			data,
			{
				productId: line.productId,
				userId: owner,
				orderId: order.id,
				lineId: line.id,
				variantName: line.variantName ?? '',
				name: String(name ?? '')
					.trim()
					.slice(0, 80),
				rating: input.rating,
				title: input.title,
				body: input.body,
				answers,
			},
			'You have already reviewed this item.',
		);
	};

	/**
	 * The answers to the merchant's review questions a review gives (E40).
	 * @param {Site} s @param {any} ctx
	 */
	const answersOf = async (s, ctx) => {
		const checked = checkAnswers(bodyOf(ctx).answers, await s.list('review_questions'));
		if (!checked.ok) throw service.invalid(checked.field, checked.message);
		return checked.value;
	};

	/** POST /v1/shop/reviews: of a product, or of an order line with `per: order_line` (E34). @param {any} ctx */
	const write = async (ctx) => {
		const s = await service.site(ctx);
		const { per } = await s.values('reviews');
		return per === 'order_line' ? writeLine(ctx, s) : writeProduct(ctx, s);
	};

	/** @param {any} ctx */
	const productReviews = async (ctx) => {
		const s = await service.site(ctx);
		const { pageSize, nameFormat } = await s.values('reviews');
		const page = paginate(
			{ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url },
			{ defaultLimit: Math.min(20, Math.max(5, Number(pageSize) || 10)), maxLimit: 50 },
		);
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
		/** @type {import('../core/reviews.js').ReviewQuestion[]} */
		const questions = await s.list('review_questions');
		const body = page.page(
			rows.map((row) => publicView(row, nameFormat, questions)),
			(view) => keyOf(fields, view),
		);
		const link = page.link(body.nextCursor);
		const [summary, counted] = await Promise.all([reviewSummary(data, productId), answerCounts(data, productId)]);
		// the answers to the merchant's questions: a rating's average, a choice's count per answer (E40)
		return ok(
			{ ...body, summary: { ...summary, questions: answerSummary(questions, counted) } },
			{ headers: link ? { link } : {} },
		);
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
		// each review names its product, for the moderation list (names read once per page)
		const s = await service.site(ctx);
		const data = await s.data();
		/** @type {import('../core/reviews.js').ReviewQuestion[]} */
		const questions = await s.list('review_questions');
		const names = new Map(
			(
				await data
					.collection(COLLECTIONS.products)
					.find(
						{ websiteId: data.websiteId, id: { $in: [...new Set(rows.map((row) => row.productId))] } },
						{ projection: { _id: 0, id: 1, name: 1 } },
					)
					.toArray()
			).map((row) => [String(row.id), String(row.name)]),
		);
		return page.respond(
			rows.map((row) => ({ ...staffView(row, questions), productName: names.get(row.productId) ?? '' })),
			(view) => keyOf(NEWEST, view),
		);
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
	 * Approve, reject or set back to pending (E34).
	 * @param {ReviewRecord['status']} status
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
		return staffView(await reviewOf(data, review.id), await s.list('review_questions'));
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
		return staffView(await reviewOf(data, review.id), await s.list('review_questions'));
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
		const questions = await s.list('review_questions');
		return { reviews: rows.map((row) => staffView(row, questions)) };
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
			rateLimit: VISITOR_WRITE_LIMITS,
			handler: write,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/shop/products/:id/reviews',
			auth: 'browser',
			feature: 'reviews',
			rateLimit: VISITOR_LIMITS,
			handler: productReviews,
		}),

		defineRoute({
			method: 'GET',
			path: '/v1/reviews',
			auth: 'server',
			feature: 'reviews',
			rateLimit: SERVER_LIMITS,
			handler: list,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/reviews/count',
			auth: 'server',
			feature: 'reviews',
			rateLimit: SERVER_LIMITS,
			handler: reviewCounts.count,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/reviews/counts',
			auth: 'server',
			feature: 'reviews',
			rateLimit: SERVER_LIMITS,
			handler: reviewCounts.counts,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/reviews/:id/approve',
			auth: 'server',
			feature: 'reviews',
			rateLimit: SERVER_LIMITS,
			handler: moderate('approved'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/reviews/:id/reject',
			auth: 'server',
			feature: 'reviews',
			rateLimit: SERVER_LIMITS,
			handler: moderate('rejected'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/reviews/:id/pending',
			auth: 'server',
			feature: 'reviews',
			rateLimit: SERVER_LIMITS,
			handler: moderate('pending'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/reviews/:id/reply',
			auth: 'server',
			feature: 'reviews',
			rateLimit: SERVER_LIMITS,
			handler: reply,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/reviews/:id',
			auth: 'server',
			feature: 'reviews',
			rateLimit: SERVER_LIMITS,
			handler: remove,
		}),

		defineRoute({
			method: 'GET',
			path: '/v1/admin/reviews',
			auth: 'ticket',
			feature: 'reviews',
			permission: 'reviews.moderate',
			rateLimit: SERVER_LIMITS,
			handler: list,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/reviews/count',
			auth: 'ticket',
			feature: 'reviews',
			permission: 'reviews.moderate',
			rateLimit: SERVER_LIMITS,
			handler: reviewCounts.count,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/reviews/counts',
			auth: 'ticket',
			feature: 'reviews',
			permission: 'reviews.moderate',
			rateLimit: SERVER_LIMITS,
			handler: reviewCounts.counts,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/reviews/:id/approve',
			auth: 'ticket',
			feature: 'reviews',
			permission: 'reviews.moderate',
			rateLimit: SERVER_LIMITS,
			handler: moderate('approved'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/reviews/:id/reject',
			auth: 'ticket',
			feature: 'reviews',
			permission: 'reviews.moderate',
			rateLimit: SERVER_LIMITS,
			handler: moderate('rejected'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/reviews/:id/pending',
			auth: 'ticket',
			feature: 'reviews',
			permission: 'reviews.moderate',
			rateLimit: SERVER_LIMITS,
			handler: moderate('pending'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/reviews/:id/reply',
			auth: 'ticket',
			feature: 'reviews',
			permission: 'reviews.moderate',
			rateLimit: SERVER_LIMITS,
			handler: reply,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/reviews/:id',
			auth: 'ticket',
			feature: 'reviews',
			permission: 'reviews.moderate',
			rateLimit: SERVER_LIMITS,
			handler: remove,
		}),
	];

	return { routes, exportUser, deleteUser };
};
