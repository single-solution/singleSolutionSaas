import { describe, expect, it } from 'vitest';
import {
	GRADE_CONDITIONS,
	GRADE_LIMITS,
	blankGrade,
	cleanGrade,
	cleanLines,
	daysOf,
	gradeProblems,
	keyOf,
	loadGrade,
	splitIds,
	videoOf,
} from '../app/dashboard/drafts.js';
import { MAX_GRADES, checkGrades } from '../core/grades.js';

/** A grade with every E10 field, as the server saves it. */
const FULL = {
	key: 'grade-a',
	label: 'Grade A',
	description: 'Like new.',
	returnDays: 14,
	warrantyDays: 180,
	categoryIds: ['cat_phones', 'cat_tablets'],
	color: '#16a34a',
	video: 'dQw4w9WgXcQ',
	content: { summary: 'Checked twice.', bullets: [{ text: 'No scratches', icon: 'sparkles' }] },
	active: false,
	condition: 'refurbished',
	seo: {
		title: 'Grade A phones',
		description: 'What Grade A means.',
		body: 'Every Grade A phone is tested.',
		faqs: [{ question: 'Is the battery new?', answer: 'Above 85 %.' }],
	},
};

describe('list helpers', () => {
	it('makes keys from names and keeps typed ones', () => {
		expect(keyOf('', 'Express Delivery')).toBe('express_delivery');
		expect(keyOf(undefined, '  9 Lives! ')).toBe('lives');
		expect(keyOf(' own-key ', 'Name')).toBe('own-key');
		expect(keyOf(null, null)).toBe('');
	});

	it('cleans lines and days', () => {
		expect(cleanLines([' a ', '', 'b', 3])).toEqual(['a', 'b', '3']);
		expect(cleanLines('a')).toEqual([]);
		expect(daysOf('')).toBeNull();
		expect(daysOf(' 30 ')).toBe(30);
		expect(daysOf(undefined)).toBeNull();
	});

	it('splits pasted ids on commas, spaces and lines, without repeats', () => {
		expect(splitIds('cat_a, cat_b\ncat_a;cat_c  ')).toEqual(['cat_a', 'cat_b', 'cat_c']);
		expect(splitIds(' , ')).toEqual([]);
	});

	it('keeps the id of a pasted YouTube address and anything else as typed', () => {
		const id = 'dQw4w9WgXcQ';
		for (const url of [
			`https://www.youtube.com/watch?v=${id}&t=10`,
			`https://youtu.be/${id}?si=x`,
			`https://m.youtube.com/shorts/${id}`,
			`https://www.youtube-nocookie.com/embed/${id}`,
			`https://youtube.com/live/${id}`,
		])
			expect(videoOf(url)).toBe(id);
		expect(videoOf(` ${id} `)).toBe(id);
		expect(videoOf('ecommerce/products/prd_1/video.mp4')).toBe('ecommerce/products/prd_1/video.mp4');
		expect(videoOf('https://vimeo.com/123')).toBe('https://vimeo.com/123');
		expect(videoOf('https://www.youtube.com/watch?v=<bad>')).toBe('https://www.youtube.com/watch?v=<bad>');
	});
});

describe('grade drafts (E10)', () => {
	it('loads a saved grade and saves it back unchanged', () => {
		const draft = loadGrade(FULL);
		expect(draft.returnDays).toBe('14');
		expect(draft.condition).toBe('refurbished');
		expect(draft.active).toBe(false);
		const saved = cleanGrade(draft);
		expect(saved).toEqual(FULL);
		const checked = checkGrades([saved]);
		expect(checked).toEqual({ ok: true, value: [FULL] });
	});

	it('fills in what a grade saved before E10 lacks', () => {
		const draft = loadGrade({ key: 'b', label: 'B', description: 'Used', returnDays: null, warrantyDays: 30 });
		expect(draft).toEqual({
			...blankGrade(),
			key: 'b',
			label: 'B',
			description: 'Used',
			warrantyDays: '30',
		});
		const odd = loadGrade({ key: 1, condition: 'mint', content: 'x', seo: null, categoryIds: 'cat_a' });
		expect(odd.key).toBe('');
		expect(odd.condition).toBe('');
		expect(odd.content).toEqual({ summary: '', bullets: [] });
		expect(odd.categoryIds).toEqual([]);
		const partial = loadGrade({
			key: 'c',
			label: 'C',
			content: { bullets: [null, { text: 'x' }] },
			seo: { faqs: [{ question: 'q' }, null] },
		});
		expect(partial.content.bullets).toEqual([
			{ text: '', icon: '' },
			{ text: 'x', icon: '' },
		]);
		expect(partial.seo.faqs).toEqual([
			{ question: 'q', answer: '' },
			{ question: '', answer: '' },
		]);
	});

	it('saves a new grade the server takes: key from the name, empty rows dropped, no condition as null', () => {
		const draft = {
			...blankGrade(),
			label: ' Grade B+ ',
			returnDays: ' 7 ',
			categoryIds: [' cat_a ', ''],
			video: 'https://youtu.be/dQw4w9WgXcQ',
			content: {
				summary: ' ok ',
				bullets: [
					{ text: ' Tested ', icon: ' check ' },
					{ text: ' ', icon: 'x' },
				],
			},
			seo: {
				title: '',
				description: '',
				body: '',
				faqs: [
					{ question: ' ', answer: '' },
					{ question: 'Q', answer: ' A ' },
				],
			},
		};
		const saved = cleanGrade(draft);
		expect(saved).toMatchObject({
			key: 'grade_b',
			label: 'Grade B+',
			returnDays: 7,
			warrantyDays: null,
			categoryIds: ['cat_a'],
			video: 'dQw4w9WgXcQ',
			content: { summary: 'ok', bullets: [{ text: 'Tested', icon: 'check' }] },
			condition: null,
			active: true,
			seo: { faqs: [{ question: 'Q', answer: 'A' }] },
		});
		expect(checkGrades([saved]).ok).toBe(true);
	});

	it('says what stops a grade being applied', () => {
		expect(gradeProblems(blankGrade(), [])).toEqual({ label: 'missing' });
		expect(gradeProblems({ ...blankGrade(), label: 'A' }, [])).toEqual({});
		expect(gradeProblems({ ...blankGrade(), label: 'A' }, ['a'])).toEqual({ key: 'taken' });
		expect(gradeProblems({ ...blankGrade(), label: '123' }, [])).toEqual({ key: 'invalid' });
		expect(gradeProblems({ ...blankGrade(), key: 'Bad Key', label: 'B' }, [])).toEqual({ key: 'invalid' });
		expect(gradeProblems({ ...blankGrade(), key: 'grade-b' }, [])).toEqual({ label: 'missing' });
		expect(gradeProblems({ ...blankGrade(), key: 'grade-b', label: 'B' }, ['grade-a'])).toEqual({});
	});

	it('names the limits the server checks', () => {
		expect(GRADE_LIMITS.grades).toBe(MAX_GRADES);
		expect(GRADE_LIMITS.description).toBe(1200);
		expect(GRADE_CONDITIONS).toEqual(['', 'new', 'refurbished', 'used']);
	});
});
