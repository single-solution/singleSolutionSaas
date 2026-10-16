// @vitest-environment jsdom
/* global window */
/**
 * The catalog admin's SEO editors show the page as a search result and as a share card (R7 #105), redrawn as the
 * merchant types: products, categories, brands and landing pages.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALL, SETTINGS, detailOf, dialogOf, pick, rowsOf, start } from './ui-admin-catalog-data.js';
import { answer, buttonIn, checkIn, click, fieldIn, openTab, panelOf, resetPage, textOf } from './ui-admin-helpers.js';

beforeEach(resetPage);
afterEach(resetPage);

const WITH_SEO = {
	...SETTINGS,
	seo: {
		domain: 'shop.example.com',
		siteName: 'Northwind',
		titleTemplate: '{name} | {business}',
		productTitle: '',
		categoryTitle: '',
		productDescription: '',
		categoryDescription: '',
		defaultDescription: 'Phones and more.',
		defaultImage: '/share.png',
	},
};

/** Type into a field as a person does (an input event that bubbles). @param {any} node @param {string} value */
const typeIn = (node, value) => {
	node.value = value;
	node.dispatchEvent(new window.Event('input', { bubbles: true }));
};

/** The preview's parts in a scope. @param {ParentNode} scope */
const previewOf = (scope) => ({
	title: scope.querySelector('[data-part="result"] .ss-seo-title')?.textContent ?? null,
	trail: scope.querySelector('[data-part="result"] .ss-seo-trail')?.textContent ?? null,
	text: scope.querySelector('[data-part="result"] .ss-seo-text')?.textContent ?? null,
	warn: scope.querySelector('.ss-seo-warn')?.textContent ?? '',
	image: scope.querySelector('[data-part="card"] img')?.getAttribute('src') ?? null,
});

describe('catalog admin: search result and share preview', () => {
	it('a product: its title and description as search engines get them, redrawn as the merchant types', async () => {
		const { root } = await start(ALL, {}, WITH_SEO);
		const panel = panelOf(root, 'products');
		await click(buttonIn(detailOf(panel), 'Edit'));
		const editor = detailOf(panel);
		expect(textOf(editor)).toContain('Search result preview');
		expect(previewOf(editor)).toEqual({
			title: 'Phone',
			trail: 'https://shop.example.com › products › phone',
			text: 'A phone',
			warn: '',
			image: 'https://cdn.example/a.jpg',
		});
		// the title pattern takes the own title once it is not as written
		const asWritten = checkIn(editor, 'Use the page title as written (the title pattern is not added)');
		asWritten.checked = false;
		asWritten.dispatchEvent(new window.Event('change', { bubbles: true }));
		expect(previewOf(editor).title).toBe('Phone | Northwind');
		typeIn(fieldIn(editor, 'Page title'), 'An extraordinarily long product title that goes on and on past the usual width');
		expect(previewOf(editor).title).toMatch(/…$/);
		expect(previewOf(editor).warn).toContain('The title may be cut in search results.');
		// no own description: the summary is too short, so the description is the page's text
		typeIn(fieldIn(editor, 'Meta description'), '');
		expect(previewOf(editor).text).toBe('Long text');
		typeIn(fieldIn(editor, 'Social sharing image'), '/phone-card.png');
		expect(previewOf(editor).image).toBe('https://shop.example.com/phone-card.png');
	});

	it('a brand and a landing page', async () => {
		const { root } = await start(
			ALL,
			{
				'GET /v1/admin/landings': () =>
					answer(200, {
						items: [
							{
								id: 'lnd_1',
								categoryId: 'cat_b',
								brandId: 'brd_1',
								facet: null,
								h1: 'Acme phones',
								title: '',
								description: '',
								intro: '',
								faqs: [],
								indexable: 'auto',
								url: 'https://shop.example.com/phones?brand=acme',
							},
						],
					}),
			},
			WITH_SEO,
		);
		const brands = await openTab(root, 'brands');
		expect(rowsOf(brands)).toContain('Acme');
		await pick(brands, 'Acme');
		await click(buttonIn(detailOf(brands), 'Edit'));
		const dialog = dialogOf(root);
		expect(previewOf(dialog)).toMatchObject({
			title: 'Acme | Northwind',
			text: 'Makers',
			image: 'https://shop.example.com/share.png',
		});
		typeIn(fieldIn(dialog, 'Name'), 'Acme Labs');
		expect(previewOf(dialog).title).toBe('Acme Labs | Northwind');
		await click(buttonIn(dialog, 'Cancel'));

		const landings = await openTab(root, 'landings');
		await click(buttonIn(detailOf(landings), 'Edit'));
		const editor = dialogOf(root);
		expect(previewOf(editor)).toMatchObject({
			title: 'Acme phones | Northwind',
			trail: 'https://shop.example.com › phones',
			text: 'Phones and more.',
		});
		typeIn(fieldIn(editor, 'Page title'), 'Acme phones on sale');
		typeIn(fieldIn(editor, 'Meta description'), 'Every Acme phone, tested.');
		expect(previewOf(editor)).toMatchObject({ title: 'Acme phones on sale | Northwind', text: 'Every Acme phone, tested.' });
	});

	it('shows no preview without the SEO settings in the widget config', async () => {
		const { root } = await start(ALL);
		const panel = panelOf(root, 'products');
		await click(buttonIn(detailOf(panel), 'Edit'));
		expect(detailOf(panel).querySelector('.ss-seo')).toBeNull();
	});
});
