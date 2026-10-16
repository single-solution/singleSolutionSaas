/**
 * Reviews (PLAN 0.8.8: reviews only after delivery, with moderation): checking a shopper's review (of a product, or of
 * one order line with `per: order_line`, E34) and a staff reply, the names shown (`nameFormat`), the sorts of the
 * public list, and the rating summary kept on the product. The merchant's review questions (fixed-choices E40, the
 * `review_questions` list: fit, quality, value …): each a 1–5 rating or one of the merchant's choices, required or not;
 * shoppers answer them with the review, the answers show on it and in the summary (a rating's average, a choice's
 * count per answer). No I/O.
 * @module
 */
import { boolField, checkNamedList, oneOf } from './named-lists.js';
import { plainText } from './returns.js';

/** What a review question asks for. */
export const QUESTION_TYPES = Object.freeze(/** @type {const} */ (['rating', 'choice']));
/** Engine caps: questions, choices of one, characters of a choice. */
export const QUESTION_LIMITS = Object.freeze({ questions: 10, choices: 10, choice: 60 });
/**
 * @typedef {{ key: string, label: string, type: typeof QUESTION_TYPES[number], choices: string[], required: boolean }} ReviewQuestion
 */

/**
 * Check the `review_questions` list: a rating question has no choices; a choice question 2 to 10 different ones.
 * @param {unknown} value
 * @returns {{ ok: true, value: ReviewQuestion[] } | { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const checkReviewQuestions = (value) =>
	/** @type {{ ok: true, value: ReviewQuestion[] } | { ok: false, errors: Array<{ path: string, message: string }> }} */ (
		checkNamedList(value, {
			max: QUESTION_LIMITS.questions,
			what: 'questions',
			label: 120,
			fields: (entry, fail) => {
				const type = oneOf(entry, 'type', QUESTION_TYPES, 'rating', fail);
				const given = Array.isArray(entry.choices) ? entry.choices : [];
				const choices = given.map((choice) => (typeof choice === 'string' ? choice.trim() : ''));
				if (type === 'choice') {
					if (
						choices.length < 2 ||
						choices.length > QUESTION_LIMITS.choices ||
						choices.some((choice) => !choice || choice.length > QUESTION_LIMITS.choice) ||
						new Set(choices).size !== choices.length
					)
						fail(
							'choices',
							`A choice question has 2 to ${QUESTION_LIMITS.choices} different choices of 1 to ${QUESTION_LIMITS.choice} characters.`,
						);
				} else if (given.length > 0) fail('choices', 'A rating question has no choices.');
				return { type, choices: type === 'choice' ? choices : [], required: boolField(entry, 'required', false, fail) };
			},
		})
	);

/**
 * Check a shopper's answers to the review questions: each a question of the list (a rating 1–5, or one of its
 * choices), every required one answered.
 * @param {unknown} value
 * @param {ReadonlyArray<ReviewQuestion>} questions
 * @returns {{ ok: true, value: Record<string, number | string> } | { ok: false, field: string, message: string }}
 */
export const checkAnswers = (value, questions) => {
	const given = value === undefined || value === null ? {} : value;
	if (typeof given !== 'object' || Array.isArray(given))
		return { ok: false, field: 'answers', message: 'answers are given by question key.' };
	/** @type {Record<string, number | string>} */
	const out = {};
	for (const [key, answer] of Object.entries(/** @type {Record<string, unknown>} */ (given))) {
		const question = questions.find((entry) => entry.key === key);
		if (!question) return { ok: false, field: `answers/${key}`, message: 'There is no such question.' };
		if (question.type === 'rating') {
			if (!Number.isInteger(answer) || Number(answer) < 1 || Number(answer) > 5)
				return { ok: false, field: `answers/${key}`, message: 'The answer is a whole number from 1 to 5.' };
			out[key] = Number(answer);
		} else {
			if (typeof answer !== 'string' || !question.choices.includes(answer))
				return { ok: false, field: `answers/${key}`, message: `The answer is one of ${question.choices.join(', ')}.` };
			out[key] = answer;
		}
	}
	const missing = questions.find((question) => question.required && out[question.key] === undefined);
	if (missing) return { ok: false, field: `answers/${missing.key}`, message: `Answer ${missing.label}.` };
	return { ok: true, value: out };
};

/**
 * A review's answers as people read them: the questions still asked, in the list's order, with their names.
 * @param {Record<string, number | string> | undefined} answers
 * @param {ReadonlyArray<ReviewQuestion>} questions
 */
export const answersView = (answers, questions) =>
	questions
		.filter((question) => answers?.[question.key] !== undefined)
		.map((question) => ({
			key: question.key,
			label: question.label,
			type: question.type,
			value: /** @type {number | string} */ (answers?.[question.key]),
		}));

/**
 * The summary of the answers of approved reviews from their count per question and answer: a rating question's
 * average and count, a choice question's count per choice.
 * @param {ReadonlyArray<ReviewQuestion>} questions
 * @param {Array<{ key: string, value: unknown, count: number }>} counted
 */
export const answerSummary = (questions, counted) =>
	questions.map((question) => {
		const rows = counted.filter((row) => row.key === question.key);
		if (question.type === 'rating') {
			const valid = rows.filter((row) => Number.isInteger(row.value) && Number(row.value) >= 1 && Number(row.value) <= 5);
			const count = valid.reduce((sum, row) => sum + row.count, 0);
			const total = valid.reduce((sum, row) => sum + Number(row.value) * row.count, 0);
			return {
				key: question.key,
				label: question.label,
				type: question.type,
				count,
				average: count === 0 ? 0 : Math.round((total / count) * 100) / 100,
			};
		}
		const choices = Object.fromEntries(
			question.choices.map((choice) => [
				choice,
				rows.filter((row) => row.value === choice).reduce((sum, row) => sum + row.count, 0),
			]),
		);
		return {
			key: question.key,
			label: question.label,
			type: question.type,
			count: Object.values(choices).reduce((sum, n) => sum + n, 0),
			choices,
		};
	});

/** @typedef {import('./model.js').ReviewRecord} ReviewRecord */
/** @typedef {import('./extras-pages.js').SortField} SortField */

const MAX_TITLE = 120;
const MAX_BODY = 2000;
const MAX_REPLY = 2000;
/** The longest order and line ids taken. */
const MAX_ID = 80;
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
 * Check a review's rating, title and text.
 * @param {Record<string, unknown>} input
 * @returns {{ ok: true, value: { rating: number, title: string, body: string } } | { ok: false, field: string, message: string }}
 */
const checkWords = (input) => {
	if (!Number.isInteger(input.rating) || Number(input.rating) < 1 || Number(input.rating) > 5)
		return { ok: false, field: 'rating', message: 'The rating is a whole number from 1 to 5.' };
	const title = plainText(input.title);
	if (title.length > MAX_TITLE) return { ok: false, field: 'title', message: `The title is at most ${MAX_TITLE} characters.` };
	const text = plainText(input.body);
	if (text.length > MAX_BODY) return { ok: false, field: 'body', message: `The review is at most ${MAX_BODY} characters.` };
	return { ok: true, value: { rating: Number(input.rating), title, body: text } };
};

/**
 * Check a shopper's review of a product.
 * @param {unknown} body
 * @returns {{ ok: true, value: { productId: string, rating: number, title: string, body: string } } | { ok: false, field: string, message: string }}
 */
export const checkReviewInput = (body) => {
	const input = typeof body === 'object' && body !== null ? /** @type {Record<string, unknown>} */ (body) : {};
	if (typeof input.productId !== 'string' || !/^prd_[A-Za-z0-9]{1,64}$/.test(input.productId))
		return { ok: false, field: 'productId', message: 'Name the product.' };
	const words = checkWords(input);
	return words.ok ? { ok: true, value: { productId: input.productId, ...words.value } } : words;
};

/**
 * Check a shopper's review of one order line (`per: order_line`, E34).
 * @param {unknown} body
 * @returns {{ ok: true, value: { orderId: string, lineId: string, rating: number, title: string, body: string } } | { ok: false, field: string, message: string }}
 */
export const checkLineReviewInput = (body) => {
	const input = typeof body === 'object' && body !== null ? /** @type {Record<string, unknown>} */ (body) : {};
	if (typeof input.orderId !== 'string' || !input.orderId || input.orderId.length > MAX_ID)
		return { ok: false, field: 'orderId', message: 'Name the order.' };
	if (typeof input.lineId !== 'string' || !input.lineId || input.lineId.length > MAX_ID)
		return { ok: false, field: 'lineId', message: 'Name the item of the order.' };
	const words = checkWords(input);
	return words.ok ? { ok: true, value: { orderId: input.orderId, lineId: input.lineId, ...words.value } } : words;
};

/**
 * The name a review shows (`nameFormat`): the whole name, or the first name and the last name's initial ("Alex K.").
 * @param {string} name
 * @param {unknown} format
 */
export const shownName = (name, format) => {
	if (format !== 'first_initial') return name;
	const words = name.trim().split(/\s+/).filter(Boolean);
	const first = words[0] ?? '';
	const last = words.length > 1 ? (words[words.length - 1] ?? '') : '';
	const initial = [...last][0];
	return initial ? `${first} ${initial.toUpperCase()}.` : first;
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
