/**
 * The merchant's review questions (fixed-choices E40): the list check, the answers a review gives, how they read and
 * their summary.
 */
import { describe, expect, it } from 'vitest';
import { answerSummary, answersView, checkAnswers, checkReviewQuestions } from '../core/reviews.js';

const QUESTIONS = [
	{ key: 'fit', label: 'Fit', type: /** @type {const} */ ('choice'), choices: ['Small', 'True', 'Large'], required: true },
	{ key: 'quality', label: 'Quality', type: /** @type {const} */ ('rating'), choices: [], required: false },
];

describe('review questions', () => {
	it('checks the list: a rating has no choices, a choice question 2 to 10 different ones', () => {
		expect(checkReviewQuestions(QUESTIONS)).toEqual({ ok: true, value: QUESTIONS });
		expect(checkReviewQuestions([{ key: 'value', label: 'Value' }])).toEqual({
			ok: true,
			value: [{ key: 'value', label: 'Value', type: 'rating', choices: [], required: false }],
		});
		expect(checkReviewQuestions([{ key: 'fit', label: 'Fit', type: 'choice', choices: ['Only'] }])).toMatchObject({
			errors: [{ path: '/value/0/choices' }],
		});
		expect(checkReviewQuestions([{ key: 'fit', label: 'Fit', type: 'choice', choices: ['A', 'A'] }])).toMatchObject({
			errors: [{ path: '/value/0/choices' }],
		});
		expect(checkReviewQuestions([{ key: 'q', label: 'Q', type: 'rating', choices: ['A'] }])).toMatchObject({
			errors: [{ path: '/value/0/choices' }],
		});
		expect(checkReviewQuestions([{ key: 'q', label: 'Q', type: 'text' }])).toMatchObject({
			errors: [{ path: '/value/0/type' }],
		});
	});

	it('takes answers of the list, every required one given', () => {
		expect(checkAnswers({ fit: 'True', quality: 5 }, QUESTIONS)).toEqual({ ok: true, value: { fit: 'True', quality: 5 } });
		expect(checkAnswers(undefined, QUESTIONS)).toMatchObject({ field: 'answers/fit' });
		expect(checkAnswers(undefined, [])).toEqual({ ok: true, value: {} });
		expect(checkAnswers([], QUESTIONS)).toMatchObject({ field: 'answers' });
		expect(checkAnswers({ fit: 'Tiny' }, QUESTIONS)).toMatchObject({ field: 'answers/fit' });
		expect(checkAnswers({ fit: 'True', quality: 0 }, QUESTIONS)).toMatchObject({ field: 'answers/quality' });
		expect(checkAnswers({ fit: 'True', size: 'M' }, QUESTIONS)).toMatchObject({ field: 'answers/size' });
	});

	it('reads the answers of the questions still asked, and sums them up', () => {
		expect(answersView({ quality: 4, gone: 'x' }, QUESTIONS)).toEqual([
			{ key: 'quality', label: 'Quality', type: 'rating', value: 4 },
		]);
		expect(
			answerSummary(QUESTIONS, [
				{ key: 'fit', value: 'True', count: 3 },
				{ key: 'fit', value: 'Small', count: 1 },
				{ key: 'quality', value: 5, count: 1 },
				{ key: 'quality', value: 4, count: 2 },
				{ key: 'quality', value: 9, count: 7 },
			]),
		).toEqual([
			{ key: 'fit', label: 'Fit', type: 'choice', count: 4, choices: { Small: 1, True: 3, Large: 0 } },
			{ key: 'quality', label: 'Quality', type: 'rating', count: 3, average: 4.33 },
		]);
	});
});
