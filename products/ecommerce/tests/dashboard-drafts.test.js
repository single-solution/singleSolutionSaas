import { describe, expect, it } from 'vitest';
import {
	GRADE_CONDITIONS,
	GRADE_LIMITS,
	blankGrade,
	cleanGrade,
	cleanLines,
	daysOf,
	flowToSave,
	removeFlowStatus,
	renameFlowStatus,
	gradeProblems,
	keyOf,
	loadGrade,
	splitIds,
	taxRegionLine,
	taxRegionOf,
	videoOf,
} from '../app/dashboard/drafts.js';
import { checkTaxRules } from '../core/taxes.js';
import { DEFAULT_FLOW, canMove, checkOrderFlow } from '../core/flow.js';
import { MAX_GRADES, checkGrades } from '../core/grades.js';

/** A grade with every field, as the server saves it. @type {import('../app/dashboard/drafts.js').SavedGrade} */
const FULL = {
	key: 'grade-a',
	label: 'Grade A',
	description: 'Like new.',
	returnDays: 14,
	warrantyDays: 180,
	categoryId: 'cat_phones',
	categoryIds: ['cat_phones', 'cat_tablets'],
	typeKeys: ['used_phone'],
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

	it('writes a tax rule’s region as one line, Country, Region, City, Postcode start, and reads it back', () => {
		expect(taxRegionLine({ country: 'US', region: '', city: '', postcode: '' })).toBe('US');
		expect(taxRegionLine({ country: 'US', region: 'California', city: '', postcode: '' })).toBe('US, California');
		expect(taxRegionLine({ country: 'GB', region: '', city: '', postcode: 'SW1' })).toBe('GB, , , SW1');
		expect(taxRegionOf('GB, , , SW1')).toEqual({ country: 'GB', region: '', city: '', postcode: 'SW1' });
		expect(taxRegionOf(' US ,California')).toEqual({ country: 'US', region: 'California', city: '', postcode: '' });
		for (const line of ['US', 'US, California', 'US, California, San Francisco, 941', 'GB, , London'])
			expect(taxRegionLine(taxRegionOf(line))).toBe(line);
		// the editor's lines save as the server checks them
		const saved = checkTaxRules([{ name: 'T', percent: 1, regions: ['US, California', 'GB, , , sw1'].map(taxRegionOf) }]);
		expect(saved.ok && saved.value[0]?.regions).toEqual([
			{ country: 'US', region: 'California', city: '', postcode: '' },
			{ country: 'GB', region: '', city: '', postcode: 'SW1' },
		]);
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
		// no category and no days of its own show as empty fields
		const plain = loadGrade({ ...FULL, categoryId: null, returnDays: null, warrantyDays: null, condition: 'new' });
		expect(plain).toMatchObject({ categoryId: '', returnDays: '', warrantyDays: '', condition: 'new' });
		expect(cleanGrade(plain)).toEqual({ ...FULL, categoryId: null, returnDays: null, warrantyDays: null, condition: 'new' });
	});

	it('saves a new grade the server takes: key from the name, empty rows dropped, used by default', () => {
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
			condition: 'used',
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
		expect(GRADE_CONDITIONS).toEqual(['new', 'refurbished', 'used']);
	});
});

describe('order flow drafts (the flow editor)', () => {
	it('renames a status in its moves, triggers and starts, and removes one with what names it', () => {
		const flow = structuredClone(DEFAULT_FLOW);
		const renamed = renameFlowStatus(flow, 'confirmed', 'accepted');
		expect(renamed.statuses.map((status) => status.key)).toContain('accepted');
		expect(renamed.moves.filter((move) => move.from === 'confirmed' || move.to === 'confirmed')).toEqual([]);
		expect(renamed.triggers.paid).toBe('accepted');
		expect(checkOrderFlow(renamed).ok).toBe(true);
		const withRefund = {
			...flow,
			triggers: { ...flow.triggers, refundsCover: 'refunded' },
			starts: { ...flow.starts, cod: 'confirmed' },
		};
		const removed = removeFlowStatus(withRefund, 'refunded');
		expect(removed.moves.some((move) => move.to === 'refunded')).toBe(false);
		expect(removed.triggers).toEqual({ paid: 'confirmed', windowEnd: 'cancelled', refundsCover: '' });
		const noCod = removeFlowStatus(withRefund, 'confirmed');
		expect(noCod.starts).toEqual({ pickup: 'awaiting_confirmation', free: 'awaiting_confirmation' });
		expect(noCod.triggers).toMatchObject({ paid: '' });
	});

	it('saves every field: keys from names, options, shopper texts, triggers and starts kept, disallowed moves left out', () => {
		const flow = structuredClone(DEFAULT_FLOW);
		flow.statuses.push({
			key: '',
			label: ' On hold ',
			role: 'open',
			shopperLabel: 'Waiting',
			shopperText: { cod: '', online: 'We hold it', bank_transfer: '', pickup: '' },
			notify: false,
		});
		flow.moves.push({ from: '', to: 'cancelled' }, { from: 'delivered', to: 'confirmed' });
		flow.moves[0] = {
			.../** @type {import('../core/model.js').OrderMove} */ (flow.moves[0]),
			options: { paidOnConfirm: ['bank_transfer'] },
		};
		const saved = flowToSave(flow, (next, move) => canMove(next, move.from, move.to));
		const hold = saved.statuses.at(-1);
		expect(hold).toMatchObject({ key: 'on_hold', label: 'On hold', shopperLabel: 'Waiting', notify: false });
		expect(saved.moves).toContainEqual(expect.objectContaining({ from: 'on_hold', to: 'cancelled' }));
		expect(saved.moves.some((move) => move.from === 'delivered' && move.to === 'confirmed')).toBe(false);
		expect(saved.moves[0]).toMatchObject({ options: { paidOnConfirm: ['bank_transfer'] } });
		expect(saved.triggers).toEqual(DEFAULT_FLOW.triggers);
		expect(saved.starts).toEqual(DEFAULT_FLOW.starts);
		const checked = checkOrderFlow(saved);
		expect(checked.ok && checked.value.statuses.at(-1)?.shopperText?.online).toBe('We hold it');
	});
});
