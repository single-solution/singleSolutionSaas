/**
 * The SEO editors' search result and share preview (R7 #105): the head a page will have, worked out from what the
 * editor holds with the same patterns and fallbacks as the SEO answers, and the settings the admin widget gets for it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { previewHead } from '../core/seo-preview.js';
import { ALL, ORIGIN, readyShop } from './helpers.js';

/** @type {import('../core/seo-preview.js').PreviewSettings} */
const SETTINGS = {
	domain: 'shop.example.com',
	siteName: 'Northwind',
	titleTemplate: '{name} | {business}',
	productTitle: '{brand} {name}[ from {minPrice}]',
	categoryTitle: '',
	productDescription: '',
	categoryDescription: 'Browse {name} at {storeName}.',
	defaultDescription: 'Everything for your kitchen.',
	defaultImage: '/share.png',
};

describe('the head a page will have', () => {
	it('a product: its own title in the title pattern, its own description as written, its canonical and share image', () => {
		expect(
			previewHead(
				'product',
				{
					name: 'Blue Mug',
					brand: 'Acme',
					seo: {
						title: 'Blue Mug 350 ml',
						description: 'A mug.',
						canonicalUrl: '/mugs/blue',
						ogImage: 'https://cdn.example/s.jpg',
					},
					url: 'https://shop.example.com/products/blue-mug',
					image: 'https://cdn.example/a.jpg',
				},
				SETTINGS,
			),
		).toEqual({
			title: 'Blue Mug 350 ml | Northwind',
			description: 'A mug.',
			url: 'https://shop.example.com/mugs/blue',
			image: 'https://cdn.example/s.jpg',
			siteName: 'Northwind',
		});
	});

	it('a product without its own: the page part from its pattern (facts of the live catalog left out), the fallbacks', () => {
		const head = previewHead(
			'product',
			{
				name: 'Blue Mug',
				brand: 'Acme',
				summary: 'Short',
				text: 'A sturdy stoneware mug that keeps tea warm for longer than you would think.',
				seo: {},
				url: 'https://shop.example.com/products/blue-mug',
				image: 'https://cdn.example/a.jpg',
			},
			SETTINGS,
		);
		expect(head.title).toBe('Acme Blue Mug | Northwind');
		expect(head.description).toBe('A sturdy stoneware mug that keeps tea warm for longer than you would think.');
		expect(head.url).toBe('https://shop.example.com/products/blue-mug');
		expect(head.image).toBe('https://cdn.example/a.jpg');
		const bare = previewHead('product', { name: 'Blue Mug', seo: { title: 'Mug', titleMode: 'as_written' } }, SETTINGS);
		expect(bare).toMatchObject({
			title: 'Mug',
			description: 'Everything for your kitchen.',
			url: 'https://shop.example.com/',
			image: 'https://shop.example.com/share.png',
		});
	});

	it('a category: its description pattern, then its summary; a brand: its description; a landing page: its heading', () => {
		expect(previewHead('category', { name: 'Mugs', seo: {}, summary: 'All mugs.' }, SETTINGS).description).toBe(
			'Browse Mugs at Northwind.',
		);
		expect(
			previewHead('category', { name: 'Mugs', seo: {}, summary: 'All mugs.' }, { ...SETTINGS, categoryDescription: '' })
				.description,
		).toBe('All mugs.');
		expect(previewHead('brand', { name: 'Acme', seo: {}, text: 'Makers of mugs.' }, SETTINGS)).toMatchObject({
			title: 'Acme | Northwind',
			description: 'Makers of mugs.',
		});
		expect(
			previewHead(
				'landing',
				{ name: 'Acme mugs', seo: { title: '', description: '' }, url: 'https://shop.example.com/m/acme' },
				SETTINGS,
			),
		).toEqual({
			title: 'Acme mugs | Northwind',
			description: 'Everything for your kitchen.',
			url: 'https://shop.example.com/m/acme',
			image: 'https://shop.example.com/share.png',
			siteName: 'Northwind',
		});
	});

	it('never adds the store name twice and leaves out a share image that is not a web address', () => {
		const head = previewHead('product', { name: 'Northwind Mug', seo: { ogImage: 'javascript:x' } }, SETTINGS);
		expect(head.title).toBe('Northwind Mug');
		expect(head.image).toBe('https://shop.example.com/share.png');
	});
});

describe('the admin widget gets what the preview needs', () => {
	/** @type {Awaited<ReturnType<typeof readyShop>>} */
	let shop;
	beforeAll(async () => {
		shop = await readyShop({ features: ALL });
		await shop.setting('seo', 'titleTemplate', '{name} · {business}');
		await shop.setting('seo', 'brandName', 'Northwind');
		await shop.setting('seo', 'defaultDescription', 'Kitchen things.');
		await shop.setting('seo', 'defaultImage', '/share.png');
	});
	afterAll(async () => shop.product.close());

	it('the site, its name and the SEO patterns, in the widget config', async () => {
		const config = await shop.visitor('GET', '/v1/widget/config');
		expect(config.json.settings.seo).toMatchObject({
			domain: new URL(ORIGIN).host,
			siteName: 'Northwind',
			titleTemplate: '{name} · {business}',
			defaultDescription: 'Kitchen things.',
			defaultImage: '/share.png',
			productTitle: expect.any(String),
			categoryTitle: expect.any(String),
			productDescription: expect.any(String),
			categoryDescription: expect.any(String),
		});
	});
});
