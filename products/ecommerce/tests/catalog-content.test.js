/**
 * The pure rules of PLAN 0.8.10 E1–E17: content fields (SEO fields, FAQs, content blocks, rich text, videos, photo
 * sizes), URL templates and slug history, size charts, landing pages, Atlas Search stages, grade conditions, filled
 * policies, landing copy prompts and the taxonomy checks of categories, brands and attributes.
 */
import { describe, expect, it } from 'vitest';
import { checkLandingAiRequest, landingPrompt, readSuggestions } from '../core/catalog-ai.js';
import {
	checkContent,
	checkFaqs,
	checkHtml,
	checkSeo,
	checkVideo,
	cleanHtml,
	decodeEntities,
	htmlToText,
	mediaExtras,
	siteAddress,
	youtubeId,
} from '../core/catalog-content.js';
import { checkAttribute, checkBrand, checkCategory, choicesOf } from '../core/catalog-taxonomy.js';
import { optionsFromAttributes, specValue, valueLabel } from '../core/catalog.js';
import { gradeCondition, gradeView, gradesByKey } from '../core/grades.js';
import { checkLanding, isIndexable, landingFor, landingLink } from '../core/landings.js';
import { absolute, categoryLink, nextPreviousSlugs, normalRef, productLink, variantQueryOf, withQuery } from '../core/links.js';
import { buildLlmsFull } from '../core/llms.js';
import { fillPolicies } from '../core/policies.js';
import { SEARCH_INDEX_DEFINITION, namesMatching, searchStage } from '../core/search.js';
import { checkSizeChart, resolveSizeChart } from '../core/size-charts.js';

describe('content fields', () => {
	it('cleans rich text to the allowed tags', () => {
		expect(cleanHtml('<P>Hi <B>bold</B> <i>it</i></p>')).toBe('<p>Hi <strong>bold</strong> <em>it</em></p>');
		expect(cleanHtml('<p>a<br/>b<br>c</br></p>')).toBe('<p>a<br>b<br>c</p>');
		expect(cleanHtml('<div><p>x</p></div><span>y</span>')).toBe('<p>x</p>y');
		expect(cleanHtml('<script>alert(1)</script><style>p{}</style><iframe src=x></iframe>ok')).toBe('ok');
		expect(cleanHtml('<svg/><p>after</p>')).toBe('<p>after</p>');
		expect(cleanHtml('<!-- c --><!doctype html><?x?><p>t</p>')).toBe('<p>t</p>');
		expect(cleanHtml('<ul><li>one<li>two</ul>')).toBe('<ul><li>one<li>two</li></li></ul>');
		expect(cleanHtml('<p>open <strong>bold')).toBe('<p>open <strong>bold</strong></p>');
		expect(cleanHtml('</p>stray')).toBe('stray');
		expect(cleanHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
		expect(cleanHtml('<a href="https://x.example/?a=1&amp;b=2">x</a>')).toBe('<a href="https://x.example/?a=1&amp;b=2">x</a>');
		expect(cleanHtml('<a href=\'/care\' onclick=x>c</a><a href=//evil.example>e</a><a href="http://x">h</a>')).toBe(
			'<a href="/care">c</a><a>e</a><a>h</a>',
		);
		expect(cleanHtml('<p></p><p> </p><h3>T</h3>')).toBe('<h3>T</h3>');
		expect(decodeEntities('&lt;&#65;&#x42;&nbsp;&bogus;&#0;')).toBe('<AB &bogus;');
		expect(htmlToText('<h3>A</h3><p>B&amp;C</p><ul><li>D</li></ul><script>x</script>')).toBe('A\n\nB&C\n\nD');
		expect(checkHtml(5)).toBeNull();
		expect(checkHtml('x'.repeat(20_001))).toBeNull();
		expect(checkHtml('<b>x</b>')).toBe('<strong>x</strong>');
	});

	it('checks SEO fields, FAQs and content blocks', () => {
		/** @type {Array<{ path: string, message: string }>} */
		const errors = [];
		expect(checkSeo(undefined, { title: 'T', description: '' }, '/seo', errors)).toMatchObject({ title: 'T', noindex: false });
		expect(
			checkSeo({ canonicalUrl: '/p', ogImage: 'https://c.example/i.jpg', noindex: true }, null, '/seo', errors),
		).toMatchObject({
			canonicalUrl: '/p',
			ogImage: 'https://c.example/i.jpg',
			noindex: true,
		});
		expect(errors).toEqual([]);
		checkSeo(
			{ title: 'x'.repeat(201), nofollow: 'yes', canonicalUrl: 'ftp://x', focusKeyword: 'k'.repeat(101) },
			null,
			'/seo',
			errors,
		);
		expect(errors.map((error) => error.path)).toEqual([
			'/seo/title',
			'/seo/canonicalUrl',
			'/seo/nofollow',
			'/seo/focusKeyword',
		]);
		checkSeo('x', null, '/seo', errors);
		expect(errors.at(-1)?.path).toBe('/seo');
		expect(siteAddress('')).toBe('');
		expect(siteAddress('/a b')).toBeNull();
		expect(siteAddress('https://user:pw@x.example/')).toBeNull();
		expect(siteAddress('not a url')).toBeNull();
		expect(siteAddress(5)).toBeNull();
		/** @type {Array<{ path: string, message: string }>} */
		const more = [];
		expect(checkFaqs([{ question: 'Q', answer: 'A' }], 2, '/faqs', more)).toEqual([{ question: 'Q', answer: 'A' }]);
		expect(checkFaqs('x', 2, '/faqs', more)).toBeNull();
		expect(checkFaqs([{ question: 'Q' }], 2, '/faqs', more)).toBeNull();
		expect(checkContent({ summary: 'S', bullets: ['A', { text: 'B', icon: 'star' }] }, '/c', more)).toEqual({
			summary: 'S',
			bullets: [
				{ text: 'A', icon: '' },
				{ text: 'B', icon: 'star' },
			],
		});
		expect(checkContent('x', '/c', more)).toBeNull();
		expect(checkContent({ summary: 'x'.repeat(2001) }, '/c', more)).toBeNull();
		expect(checkContent({ bullets: Array.from({ length: 13 }, () => 'b') }, '/c', more)).toBeNull();
		expect(checkContent({ bullets: [{ text: 'B', icon: 'i'.repeat(41) }] }, '/c', more)).toBeNull();
		expect(more.map((error) => error.path)).toEqual(['/faqs', '/faqs/0', '/c', '/c/summary', '/c/bullets', '/c/bullets/0']);
	});

	it('reads videos and photo extras', () => {
		expect(youtubeId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
		expect(youtubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
		expect(youtubeId('https://m.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
		expect(youtubeId('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
		expect(youtubeId('https://vimeo.com/123')).toBeNull();
		expect(youtubeId('nope')).toBeNull();
		expect(youtubeId(5)).toBeNull();
		/** @type {Array<{ path: string, message: string }>} */
		const errors = [];
		expect(checkVideo(null, '/video', errors)).toBeNull();
		expect(checkVideo({ kind: 'file', key: 'k' }, '/video', errors)).toEqual({ kind: 'file', key: 'k' });
		expect(checkVideo({ kind: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ' }, '/video', errors)).toEqual({
			kind: 'youtube',
			id: 'dQw4w9WgXcQ',
		});
		expect(checkVideo({ kind: 'youtube', id: 'x' }, '/video', errors)).toBeUndefined();
		expect(checkVideo({ kind: 'url', url: '/local.mp4' }, '/video', errors)).toBeUndefined();
		expect(checkVideo('x', '/video', errors)).toBeUndefined();
		expect(errors).toHaveLength(3);
		/** @type {Array<{ path: string, message: string }>} */
		const extras = [];
		expect(
			mediaExtras(
				{ sizes: { thumb: 'f/t.webp', card: '', detail: null }, width: 10, height: 20, blur: 'data:image/png;base64,AA==' },
				'f/',
				'',
				extras,
			),
		).toEqual({ sizes: { thumb: 'f/t.webp' }, width: 10, height: 20, blur: 'data:image/png;base64,AA==' });
		mediaExtras({ sizes: 'x', width: 0, height: 1.5, blur: 'x' }, 'f/', '/m', extras);
		mediaExtras({ sizes: { big: 'f/a', card: 'g/a', thumb: 'f/../a' } }, 'f/', '/m', extras);
		expect(extras.map((error) => error.path)).toEqual([
			'/m/sizes',
			'/m/width',
			'/m/height',
			'/m/blur',
			'/m/sizes/big',
			'/m/sizes/card',
			'/m/sizes/thumb',
		]);
	});
});

describe('attributes and variants', () => {
	const colour = /** @type {any} */ ({
		id: 'att_c',
		name: 'Colour',
		type: 'choice',
		on: 'variant',
		multiple: true,
		sort: 1,
		unit: '',
		choices: [{ value: 'r', label: 'Red' }, 'Blue'],
	});
	const weight = /** @type {any} */ ({
		id: 'att_w',
		name: 'Weight',
		type: 'number',
		on: 'variant',
		sort: 2,
		unit: 'g',
		choices: [],
	});

	it('reads values and labels, several values, and derives options', () => {
		expect(choicesOf(colour)).toEqual([
			{ value: 'r', label: 'Red' },
			{ value: 'Blue', label: 'Blue' },
		]);
		expect(specValue(colour, ['r', 'Blue'])).toEqual(['r', 'Blue']);
		expect(specValue(colour, ['r', 'r'])).toBeNull();
		expect(specValue(colour, [])).toBeNull();
		expect(specValue(colour, ['x'], ['x'])).toEqual(['x']);
		expect(specValue({ ...colour, multiple: false }, ['r'])).toBeNull();
		expect(specValue(weight, 12)).toBe(12);
		expect(valueLabel(colour, ['r', 'Blue'])).toBe('Red, Blue');
		expect(valueLabel(colour, 'gone')).toBe('gone');
		expect(valueLabel(weight, 12)).toBe('12 g');
		expect(valueLabel({ ...weight, unit: '' }, 12)).toBe('12');
		const derived = optionsFromAttributes(
			/** @type {any} */ ([
				{ id: 'v1', attributes: { att_c: ['r'], att_w: 10 }, options: {} },
				{ id: 'v2', attributes: { att_c: 'Blue' }, options: {} },
			]),
			new Map([
				['att_w', weight],
				['att_c', colour],
				['att_x', { ...weight, id: 'att_x', name: 'Unused' }],
			]),
		);
		expect(derived.axes).toEqual([
			{ name: 'Colour', values: ['Red', 'Blue'] },
			{ name: 'Weight', values: ['10 g'] },
		]);
		expect(derived.variants.map((variant) => variant.options)).toEqual([{ Colour: 'Red', Weight: '10 g' }, { Colour: 'Blue' }]);
	});

	it('checks categories, brands and attributes', () => {
		expect(checkCategory({ name: 'C', requiresSerial: null, sizeChartId: '' }, null)).toMatchObject({
			ok: true,
			value: { requiresSerial: null, sizeChartId: null, status: 'active' },
		});
		expect(checkCategory({ name: 'C', requiresSerial: 'yes' }, null).ok).toBe(false);
		expect(checkCategory({ name: 'C', sizeChartId: 5 }, null).ok).toBe(false);
		expect(checkBrand({ name: 'B', categoryIds: 'x' }, null).ok).toBe(false);
		expect(checkBrand({ name: 'B', status: 'hidden', categoryIds: ['cat_a', 'cat_a'] }, null)).toMatchObject({
			ok: true,
			value: { status: 'hidden', categoryIds: ['cat_a'] },
		});
		expect(checkAttribute({ name: 'A', type: 'number', multiple: true }, null).ok).toBe(false);
		expect(checkAttribute({ name: 'A', visibility: 'always' }, null)).toMatchObject({
			ok: true,
			value: { visibility: { when: 'always' } },
		});
		expect(
			checkAttribute({ name: 'A', visibility: { when: 'attribute', attributeId: 'att_x', value: 'v' } }, null),
		).toMatchObject({
			ok: true,
			value: { visibility: { when: 'attribute', attributeId: 'att_x', value: 'v' } },
		});
		expect(checkAttribute({ name: 'A', visibility: { when: 'brands', ids: [] } }, null).ok).toBe(false);
		expect(checkAttribute({ name: 'A', visibility: { when: 'attribute' } }, null).ok).toBe(false);
		expect(checkAttribute({ name: 'A', visibility: { when: 'never' } }, null).ok).toBe(false);
		expect(checkAttribute({ name: 'A', card: 'big' }, null).ok).toBe(false);
		expect(checkAttribute({ name: 'A', seo: 'x' }, null).ok).toBe(false);
		expect(checkAttribute({ name: 'A', seo: { faqs: [{}] } }, null).ok).toBe(false);
		expect(checkAttribute({ name: 'A', type: 'choice', choices: [{ value: 'a' }, { value: 'a' }] }, null).ok).toBe(false);
		expect(
			checkAttribute({ name: 'A', visibility: { when: 'always' } }, /** @type {any} */ ({ ...colour, id: 'att_c' })),
		).toMatchObject({
			ok: true,
			value: {
				choices: [
					{ value: 'r', label: 'Red' },
					{ value: 'Blue', label: 'Blue' },
				],
			},
		});
	});
});

describe('links', () => {
	const context = {
		domain: 'shop.example',
		categories: new Map([
			['c1', { slug: 'phones', path: [] }],
			['c2', { slug: 'android', path: ['c1', 'gone'] }],
		]),
		brands: new Map([['b1', { slug: 'acme' }]]),
	};

	it('fills the URL templates', () => {
		const product = { id: 'prd_1', slug: 'pixel 9', categoryIds: ['c2'], brandId: 'b1' };
		expect(productLink('/{categoryPath}/{brand}/{slug}', product, context)).toBe(
			'https://shop.example/phones/android/acme/pixel%209',
		);
		expect(productLink('/{category}/{slug}?id={id}', product, context)).toBe('https://shop.example/android/pixel%209?id=prd_1');
		expect(productLink('/{category}/{slug}', { id: 'p', slug: 's' }, context)).toBe('https://shop.example/s');
		expect(productLink('', { id: 'p', slug: 's', brandId: 'b9' }, context)).toBe('https://shop.example/products/s');
		expect(productLink('https://cdn.example/{slug}', { id: 'p', slug: 's' }, context)).toBe('https://cdn.example/s');
		expect(categoryLink('/{path}', { id: 'c2', slug: 'android' }, context)).toBe('https://shop.example/phones/android');
		expect(categoryLink('', { slug: 'x' }, context)).toBe('https://shop.example/categories/x');
		expect(absolute('a', 'shop.example')).toBe('https://shop.example/a');
		const attributes = new Map([
			['att_c', { slug: 'colour' }],
			['att_x', {}],
		]);
		expect(
			variantQueryOf('grade={grade}&{attributes}', { grade: 'a', attributes: { att_c: ['r', 'b'], att_x: 'y' } }, attributes),
		).toBe('grade=a&colour=r%2Cb');
		expect(variantQueryOf('grade={grade}&{attributes}', { grade: null }, attributes)).toBe('');
		expect(variantQueryOf('', { grade: 'a' }, attributes)).toBe('');
		expect(withQuery('https://x/p', 'a=1')).toBe('https://x/p?a=1');
		expect(withQuery('https://x/p?id=1', 'a=1')).toBe('https://x/p?id=1&a=1');
		expect(withQuery('https://x/p', '')).toBe('https://x/p');
	});

	it('keeps earlier slugs and reads references', () => {
		expect(nextPreviousSlugs(undefined, 'a', 'a')).toEqual([]);
		expect(nextPreviousSlugs(['b', 'c'], 'a', 'b')).toEqual(['a', 'c']);
		expect(
			nextPreviousSlugs(
				Array.from({ length: 20 }, (_, n) => `s${n}`),
				'new',
				'x',
			),
		).toHaveLength(20);
		expect(normalRef('prd_ABC', 'prd')).toBe('prd_ABC');
		expect(normalRef('Pixel-9', 'prd')).toBe('pixel-9');
	});
});

describe('size charts', () => {
	it('checks charts and resolves the product, brand and category chart', () => {
		const chart = checkSizeChart(
			{
				name: 'C',
				columns: [{ key: 'bust', label: 'Bust' }],
				rows: [{ size: 'S', label: 'Small', values: { bust: 30 } }],
				notes: 'N',
			},
			null,
		);
		expect(chart).toMatchObject({
			ok: true,
			value: { unit: 'in', rows: [{ size: 'S', label: 'Small', values: { bust: '30' } }] },
		});
		expect(checkSizeChart('x', null).ok).toBe(false);
		expect(checkSizeChart({ name: 'C', unit: 'mm', columns: [{ key: 'A', label: '' }] }, null)).toMatchObject({ ok: false });
		expect(
			checkSizeChart({ name: 'C', columns: [{ key: 'a', label: 'A' }], rows: [{ size: 'S' }, { size: 'S' }] }, null).ok,
		).toBe(false);
		expect(
			checkSizeChart({ name: 'C', columns: [{ key: 'a', label: 'A' }], rows: [{ size: 'S', values: 'x' }] }, null).ok,
		).toBe(false);
		expect(
			checkSizeChart(
				{ name: 'C', columns: [{ key: 'a', label: 'A' }], rows: 'x', fitAdvice: 'x'.repeat(2001), active: 'no' },
				null,
			),
		).toMatchObject({
			ok: false,
		});
		const existing = /** @type {any} */ ({
			id: 'szc_1',
			name: 'C',
			unit: 'cm',
			columns: [{ key: 'a', label: 'A' }],
			rows: [],
			fitAdvice: 'F',
			notes: '',
			active: true,
		});
		expect(checkSizeChart({ active: false }, existing)).toMatchObject({
			ok: true,
			value: { unit: 'cm', fitAdvice: 'F', active: false },
		});
		const charts = new Map([
			['p', existing],
			['b', { ...existing, id: 'b' }],
			['root', { ...existing, id: 'root' }],
		]);
		const categories = new Map([
			['c1', { path: [], sizeChartId: 'root' }],
			['c2', { path: ['c1'], sizeChartId: null }],
		]);
		expect(resolveSizeChart({ sizeChartId: 'p', categoryIds: [] }, null, categories, charts)?.id).toBe('szc_1');
		expect(resolveSizeChart({ categoryIds: ['c2'] }, { sizeChartId: 'b' }, categories, charts)?.id).toBe('b');
		expect(resolveSizeChart({ categoryIds: ['c2'] }, null, categories, charts)?.id).toBe('root');
		expect(resolveSizeChart({ categoryIds: ['none'] }, null, categories, charts)).toBeNull();
		expect(resolveSizeChart({ categoryIds: ['c2'], hideSizeGuide: true }, null, categories, charts)).toBeNull();
		expect(resolveSizeChart({ categoryIds: ['c2'] }, null, new Map([['c2', { path: [] }]]), charts)).toBeNull();
	});
});

describe('landing pages, search, grades, policies and llms-full', () => {
	it('checks landings, fills their address and judges them indexable', () => {
		expect(checkLanding('x', null).ok).toBe(false);
		expect(checkLanding({}, null).ok).toBe(false);
		expect(checkLanding({ grade: 5, indexable: 'x', h1: 'x'.repeat(201), faqs: 'x' }, null)).toMatchObject({ ok: false });
		const landing = checkLanding({ categoryId: 'cat_1', brandId: '', grade: 'a', intro: 'Line 1\nLine 2' }, null);
		expect(landing).toMatchObject({
			ok: true,
			value: { categoryId: 'cat_1', brandId: null, grade: 'a', indexable: 'auto', intro: 'Line 1\nLine 2' },
		});
		expect(isIndexable({ indexable: 'auto' }, 3, 3)).toBe(true);
		expect(isIndexable({ indexable: 'auto' }, 2, 3)).toBe(false);
		expect(isIndexable({ indexable: 'yes' }, 0, 3)).toBe(true);
		expect(isIndexable({ indexable: 'no' }, 9, 3)).toBe(false);
		expect(
			landingLink('', { categoryUrl: 'https://s.example/phones', category: 'phones', brand: 'a b', grade: '' }, 's.example'),
		).toBe('https://s.example/phones?brand=a%20b');
		expect(landingLink('/l/{category}/{brand}', { categoryUrl: '', category: 'c', brand: 'b', grade: '' }, 's.example')).toBe(
			'https://s.example/l/c/b',
		);
		expect(landingLink('l', { categoryUrl: '', category: '', brand: '', grade: '' }, 's.example')).toBe('https://s.example/l');
		const all = /** @type {any} */ ([{ categoryId: 'c', brandId: null, grade: null }]);
		expect(landingFor(all, { categoryId: 'c', brandId: null, grade: null })).toBe(all[0]);
		expect(landingFor(all, { categoryId: 'c', brandId: 'b', grade: null })).toBeNull();
	});

	it('builds Atlas Search stages that pin the website', () => {
		expect(
			namesMatching('acme pho', [
				{ id: 'b1', name: 'Acme Phones' },
				{ id: 'b2', name: 'Other' },
			]),
		).toEqual(['b1']);
		expect(namesMatching('  ', [{ id: 'b1', name: 'Acme' }])).toEqual([]);
		const stage = searchStage(' pixel ', { index: 'idx', websiteId: 'web_1', brandIds: ['b1'], categoryIds: ['c1'] });
		expect(stage.$search.compound.filter).toContainEqual({ equals: { path: 'websiteId', value: 'web_1' } });
		expect(stage.$search.compound.should).toHaveLength(4);
		expect(
			searchStage('x', { index: 'i', websiteId: 'w', brandIds: [], categoryIds: [] }).$search.compound.should,
		).toHaveLength(2);
		expect(SEARCH_INDEX_DEFINITION.mappings.fields.websiteId).toEqual({ type: 'token' });
	});

	it('gives grade conditions and views, fills policies and writes llms-full.txt', () => {
		const grades = gradesByKey([
			{ key: 'a', label: 'A', condition: 'refurbished' },
			{ key: 'b', label: 'B' },
		]);
		expect(gradeCondition({ kind: 'physical' }, { grade: 'a' }, grades, 'used')).toBe('refurbished');
		expect(gradeCondition({ kind: 'physical' }, { grade: 'b' }, grades, 'used')).toBe('used');
		expect(gradeCondition({ kind: 'physical' }, { grade: null }, grades, 'used')).toBe('new');
		expect(gradeCondition({ kind: 'digital' }, { grade: 'a' }, grades, 'used')).toBe('');
		expect(
			gradeView(/** @type {any} */ ({ key: 'b', label: 'B', description: '', returnDays: null, warrantyDays: 5 })),
		).toMatchObject({
			color: '',
			video: '',
			condition: null,
			warrantyDays: 5,
		});
		expect(
			fillPolicies(
				{ policyReturns: ' {returnDays} days ', policyTerms: '', policyFormat: 'text' },
				{ returnDays: 7, warrantyDays: 60, business: 'S' },
			),
		).toEqual({
			format: 'text',
			policies: { returns: '7 days' },
		});
		expect(
			fillPolicies(
				{ policyWarranty: '<p>{business}: {warrantyMonths} months</p><script>x</script>', policyFormat: 'html' },
				{ returnDays: 7, warrantyDays: 60, business: 'S' },
			),
		).toEqual({ format: 'html', policies: { warranty: '<p>S: 2 months</p>' } });
		const text = buildLlmsFull({
			name: 'Shop',
			description: '',
			home: 'https://s.example/',
			sections: [
				{ name: 'Empty', url: 'https://s.example/e', grades: [], products: [] },
				{ name: 'Loose', url: null, grades: [], products: [{ name: 'P', url: 'https://s.example/p', price: '1' }] },
			],
			headings: { grades: 'Grades' },
		});
		expect(text).toContain('## Loose');
		expect(text).not.toContain('Empty');
	});

	it('checks landing copy requests and reads FAQ suggestions', () => {
		expect(checkLandingAiRequest(null)).toMatchObject({
			ok: true,
			value: { fields: ['h1', 'title', 'description', 'intro', 'faqs'] },
		});
		expect(checkLandingAiRequest({ fields: [] }).ok).toBe(false);
		expect(checkLandingAiRequest({ fields: ['h1'], tone: 'x'.repeat(101) }).ok).toBe(false);
		const prompt = landingPrompt(
			{ category: 'Phones', brand: null, grade: 'Mint', products: ['A'] },
			{ fields: ['h1', 'faqs'], tone: 'warm', language: 'English' },
		);
		expect(prompt.prompt).toContain('Category: Phones');
		expect(prompt.prompt).toContain('Condition grade: Mint');
		expect(prompt.system).toContain('Tone: warm.');
		expect(readSuggestions('{"faqs":"x"}', ['faqs'])).toBeNull();
		expect(readSuggestions('no json', ['faqs'])).toBeNull();
		expect(readSuggestions('{"h1":"' + 'x'.repeat(200) + '"}', ['h1'], prompt.limits)).toEqual({ h1: 'x'.repeat(120) });
	});
});
