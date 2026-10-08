/**
 * Reviews (PLAN 0.8.8: reviews only after delivery, with moderation): checking a shopper's review and a staff reply,
 * the sorts of the public list, and the rating summary kept on the product. No I/O.
 * @module
 */
import { plainText } from './returns.js';

/** @typedef {import('./model.js').ReviewRecord} ReviewRecord */
/** @typedef {import('./extras-pages.js').SortField} SortField */

export const MAX_TITLE = 120;
export const MAX_BODY = 2000;
export const MAX_REPLY = 2000;
export const REVIEW_STATUSES = Object.freeze(/** @type {ReviewRecord['status'][]} */ (['pending', 'approved', 'rejected']));

/** The public list's sorts (newest first by default). @type {Readonly<Record<'newest' | 'highest' | 'lowest', SortField[]>>} */
export const REVIEW_SORTS = Object.freeze({
	newest: [
		{ field: 'createdAt', direction: -1, date: true },
		{ field: 'id', direction: -1 },
	],
	highest: [
		{ field: 'rating', direction: -1 },
		{ field: 'createdAt', direction: -1, date: true },
		{ field: 'id', direction: -1 },
	],
	lowest: [
		{ field: 'rating', direction: 1 },
		{ field: 'createdAt', direction: -1, date: true },
		{ field: 'id', direction: -1 },
	],
});

/**
 * The sort a visitor asked for.
 * @param {unknown} value
 * @returns {keyof typeof REVIEW_SORTS}
 */
export const reviewSort = (value) => (value === 'highest' || value === 'lowest' ? value : 'newest');

/**
 * Check a shopper's review.
 * @param {unknown} body
 * @returns {{ ok: true, value: { productId: string, rating: number, title: string, body: string } } | { ok: false, field: string, message: string }}
 */
export const checkReviewInput = (body) => {
	const input = typeof body === 'object' && body !== null ? /** @type {Record<string, unknown>} */ (body) : {};
	if (typeof input.productId !== 'string' || !/^prd_[A-Za-z0-9]{1,64}$/.test(input.productId))
		return { ok: false, field: 'productId', message: 'Name the product.' };
	if (!Number.isInteger(input.rating) || Number(input.rating) < 1 || Number(input.rating) > 5)
		return { ok: false, field: 'rating', message: 'The rating is a whole number from 1 to 5.' };
	const title = plainText(input.title);
	if (title.length > MAX_TITLE) return { ok: false, field: 'title', message: `The title is at most ${MAX_TITLE} characters.` };
	const text = plainText(input.body);
	if (text.length > MAX_BODY) return { ok: false, field: 'body', message: `The review is at most ${MAX_BODY} characters.` };
	return { ok: true, value: { productId: input.productId, rating: Number(input.rating), title, body: text } };
};

/**
 * Check a staff reply ('' removes it).
 * @param {unknown} value
 * @returns {{ ok: true, reply: string } | { ok: false, message: string }}
 */
export const checkReply = (value) => {
	const reply = plainText(value);
	return reply.length > MAX_REPLY
		? { ok: false, message: `The reply is at most ${MAX_REPLY} characters.` }
		: { ok: true, reply };
};

/**
 * The rating summary of approved reviews from their count per star.
 * @param {Array<{ rating: number, count: number }>} perStar
 * @returns {{ average: number, count: number, stars: Record<'1' | '2' | '3' | '4' | '5', number> }}
 */
export const ratingSummary = (perStar) => {
	const stars = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
	for (const { rating, count } of perStar)
		if (rating >= 1 && rating <= 5 && Number.isInteger(rating)) stars[/** @type {1 | 2 | 3 | 4 | 5} */ (rating)] += count;
	const count = Object.values(stars).reduce((a, b) => a + b, 0);
	const total = Object.entries(stars).reduce((sum, [rating, n]) => sum + Number(rating) * n, 0);
	return {
		average: count === 0 ? 0 : Math.round((total / count) * 100) / 100,
		count,
		stars: /** @type {Record<'1' | '2' | '3' | '4' | '5', number>} */ (/** @type {unknown} */ (stars)),
	};
};
