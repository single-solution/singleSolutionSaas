// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { SeoPreview } from '../src/SeoPreview.js';
import {
	SEO_PREVIEW_CSS,
	SEO_PREVIEW_TEXTS,
	SERP_LIMITS,
	breadcrumbOf,
	estimateWidth,
	fitWidth,
	measureOf,
	seoPreview,
	seoPreviewModel,
} from '../src/seo-preview.js';
import { cleanup, render } from '../src/testing.js';

afterEach(cleanup);

describe('text width without a canvas (the estimate)', () => {
	it('measures Latin letters by their Arial widths, so narrow letters fit more than wide ones', () => {
		expect(estimateWidth('i', 20)).toBeCloseTo(4.44, 1);
		expect(estimateWidth('W', 20)).toBeCloseTo(18.88, 1);
		expect(estimateWidth('iiiiiiiiii', 20)).toBeLessThan(estimateWidth('WWWWWWWWWW', 20) / 3);
	});
	it('measures any script: accented letters as their base letter, wide scripts at a full em, marks at nothing', () => {
		expect(estimateWidth('é', 20)).toBeCloseTo(estimateWidth('e', 20), 5);
		expect(estimateWidth('東京', 20)).toBe(40);
		expect(estimateWidth('한국', 14)).toBe(28);
		expect(estimateWidth('é', 20)).toBeCloseTo(estimateWidth('e', 20), 5);
		expect(estimateWidth('Привет', 20)).toBeGreaterThan(50);
		expect(estimateWidth('مرحبا', 20)).toBeGreaterThan(40);
		expect(estimateWidth('', 20)).toBe(0);
	});
	it('a measure without a canvas falls back to the estimate', () => {
		const measure = measureOf(null);
		expect(measure('Hello', SERP_LIMITS.title.font)).toBeCloseTo(estimateWidth('Hello', 20), 5);
		expect(measure('Hello', SERP_LIMITS.description.font)).toBeCloseTo(estimateWidth('Hello', 14), 5);
	});
	it('a measure uses the canvas when there is one', () => {
		/** @type {string[]} */
		const fonts = [];
		const context = {
			font: '',
			/** @param {string} text */
			measureText(text) {
				fonts.push(this.font);
				return { width: text.length * 10 };
			},
		};
		const measure = measureOf(context);
		expect(measure('abc', '20px Arial')).toBe(30);
		expect(fonts).toEqual(['20px Arial']);
	});
});

describe('fitting a text into a width', () => {
	const measure = (/** @type {string} */ text) => [...text].length * 10;
	it('keeps a text that fits', () => {
		expect(fitWidth('Short title', 600, measure, '20px Arial')).toEqual({ text: 'Short title', cut: false, width: 110 });
	});
	it('cuts a longer text at a word with an ellipsis, as search results do', () => {
		const fitted = fitWidth('one two three four five six', 120, measure, '20px Arial');
		expect(fitted.cut).toBe(true);
		expect(fitted.text).toBe('one two…');
		expect(measure(fitted.text)).toBeLessThanOrEqual(120);
		expect(fitted.width).toBe(270);
	});
	it('cuts a text without spaces (Chinese, Japanese, Thai) between characters, never inside one', () => {
		const fitted = fitWidth('東京都の新しいお店です', 50, measure, '20px Arial');
		expect(fitted).toEqual({ text: '東京都の…', cut: true, width: 110 });
		const emoji = fitWidth('👍🏽👍🏽👍🏽👍🏽', 30, (text) => text.length * 5, '20px Arial');
		expect(emoji.text.startsWith('👍🏽')).toBe(true);
		expect(emoji.text).not.toMatch(/\uD83D$/);
	});
});

describe('the breadcrumb of an address', () => {
	it('is the host without www and each path part', () => {
		expect(breadcrumbOf('https://www.shop.example.com/products/blue-mug')).toEqual({
			host: 'shop.example.com',
			trail: 'https://shop.example.com › products › blue-mug',
		});
		expect(breadcrumbOf('https://shop.example.com/')).toEqual({ host: 'shop.example.com', trail: 'https://shop.example.com' });
	});
	it('reads encoded parts as words and is empty for something that is not an address', () => {
		expect(breadcrumbOf('https://shop.example.com/caf%C3%A9?x=1').trail).toBe('https://shop.example.com › café');
		expect(breadcrumbOf('not an address')).toEqual({ host: '', trail: '' });
	});
});

describe('the preview model', () => {
	const measure = (/** @type {string} */ text, /** @type {string} */ font) =>
		[...text].length * (font.startsWith('20') ? 10 : 7);
	it('fills the result and the share card, with each width against Google’s usual one', () => {
		const model = seoPreviewModel(
			{
				title: 'Blue Mug | Northwind',
				description: 'A mug.',
				url: 'https://northwind.example/products/blue-mug',
				siteName: 'Northwind',
				image: 'https://cdn.example/mug.jpg',
			},
			measure,
		);
		expect(model.site).toBe('Northwind');
		expect(model.trail).toBe('https://northwind.example › products › blue-mug');
		expect(model.title).toEqual({ text: 'Blue Mug | Northwind', cut: false, width: 200, limit: 600, empty: false });
		expect(model.description).toEqual({ text: 'A mug.', cut: false, width: 42, limit: 920, empty: false });
		expect(model.card).toEqual({
			domain: 'northwind.example',
			title: 'Blue Mug | Northwind',
			description: 'A mug.',
			image: 'https://cdn.example/mug.jpg',
		});
	});
	it('marks a title or description past the usual width as one that may be cut', () => {
		const model = seoPreviewModel({ title: 'x'.repeat(61), description: 'y '.repeat(70), url: '' }, measure);
		expect(model.title.cut).toBe(true);
		expect(model.title.width).toBe(610);
		expect(model.description.cut).toBe(true);
		expect(model.site).toBe('');
	});
	it('takes the site name from the address without one, keeps only web images, and knows empty texts', () => {
		const model = seoPreviewModel({ title: '  ', url: 'https://www.example.org/a', image: 'javascript:alert(1)' }, measure);
		expect(model.site).toBe('example.org');
		expect(model.title.empty).toBe(true);
		expect(model.description.empty).toBe(true);
		expect(model.card.image).toBe('');
		expect(seoPreviewModel({ image: '/media/a.png', url: 'https://example.org/' }, measure).card.image).toBe(
			'https://example.org/media/a.png',
		);
	});
});

describe('the preview part (DOM, for widgets)', () => {
	const words = { ...SEO_PREVIEW_TEXTS };
	it('draws the search result and the share card, and redraws on update', () => {
		const view = seoPreview(document, {
			title: 'Blue Mug | Northwind',
			description: 'A mug for tea.',
			url: 'https://northwind.example/products/blue-mug',
			siteName: 'Northwind',
			image: 'https://cdn.example/mug.jpg',
		});
		document.body.append(view.node);
		const result = /** @type {HTMLElement} */ (view.node.querySelector('[data-part="result"]'));
		expect(result.getAttribute('aria-label')).toBe(words.result);
		expect(result.querySelector('.ss-seo-title')?.textContent).toBe('Blue Mug | Northwind');
		expect(result.querySelector('.ss-seo-trail')?.textContent).toBe('https://northwind.example › products › blue-mug');
		expect(result.querySelector('.ss-seo-text')?.textContent).toBe('A mug for tea.');
		const card = /** @type {HTMLElement} */ (view.node.querySelector('[data-part="card"]'));
		expect(card.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/mug.jpg');
		expect(card.querySelector('.ss-seo-domain')?.textContent).toBe('northwind.example');
		expect(view.node.querySelector('.ss-seo-warn')).toBeNull();
		view.update({ title: 'W'.repeat(80), description: '', url: 'https://northwind.example/', image: '' });
		expect(view.node.querySelector('.ss-seo-title')?.textContent).toMatch(/…$/);
		expect(view.node.querySelector('.ss-seo-warn')?.textContent).toContain(words.titleCut);
		expect(view.node.querySelector('[data-part="result"] .ss-seo-text')?.textContent).toBe(words.noDescription);
		expect(view.node.querySelector('[data-part="card"] img')).toBeNull();
		expect(view.node.querySelector('[data-part="card"] .ss-seo-noimage')?.textContent).toBe(words.noImage);
		view.node.remove();
	});
	it('shows each width against its limit and takes the widget’s own words', () => {
		const view = seoPreview(
			document,
			{ title: 'Hi', url: 'https://a.example/' },
			{ texts: { titleWidth: 'Title {width} / {limit}', result: 'Search' }, measure: (text) => text.length * 10 },
		);
		expect(view.node.querySelector('[data-part="result"]')?.getAttribute('aria-label')).toBe('Search');
		expect(view.node.querySelector('.ss-seo-meter')?.textContent).toContain('Title 20 / 600');
	});
	it('has its own styles for light and dark', () => {
		expect(SEO_PREVIEW_CSS).toContain('.ss-seo-title');
		expect(SEO_PREVIEW_CSS).toContain("data-ss-mode='dark'");
		expect(SEO_PREVIEW_CSS).toContain('prefers-color-scheme: dark');
	});
});

describe('<SeoPreview> (React, for dashboards)', () => {
	it('draws the same part and follows its props', () => {
		const { container, rerender } = render(
			<SeoPreview title="Grade A | Shop" description="Like new." url="https://shop.example/grades/a" siteName="Shop" />,
		);
		expect(container.querySelector('.ss-seo-title')?.textContent).toBe('Grade A | Shop');
		rerender(<SeoPreview title="Grade B | Shop" description="" url="https://shop.example/grades/b" />);
		expect(container.querySelector('.ss-seo-title')?.textContent).toBe('Grade B | Shop');
		expect(container.querySelector('.ss-seo-trail')?.textContent).toBe('https://shop.example › grades › b');
		expect(document.head.querySelectorAll('style[data-ss-seo-preview]').length).toBe(1);
	});
});
