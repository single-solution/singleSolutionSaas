/**
 * Sitemaps list canonical addresses only (SEO audit G8, phase S1; Google: a sitemap names the canonical URLs): a
 * product or category whose canonical address points at another page is left out; one whose canonical is its own
 * address stays.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, readyShop, storedCategory } from './helpers.js';
import { EMPTY_SEO } from '../core/catalog-content.js';
import { COLLECTIONS } from '../core/model.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;

beforeAll(async () => {
	shop = await readyShop();
	const data = await shop.db();
	await data.collection(COLLECTIONS.categories).insertMany([
		storedCategory({ id: 'cat_cups', slug: 'cups', name: 'Cups' }),
		storedCategory({
			id: 'cat_old',
			slug: 'old-cups',
			name: 'Old cups',
			seo: { ...EMPTY_SEO, canonicalUrl: '/categories/cups' },
		}),
		storedCategory({
			id: 'cat_self',
			slug: 'tea',
			name: 'Tea',
			seo: { ...EMPTY_SEO, canonicalUrl: `${ORIGIN}/categories/tea` },
		}),
	]);
	await shop.seedProduct({ slug: 'cup', name: 'Cup', categoryIds: ['cat_cups', 'cat_self'] });
	await shop.seedProduct({ slug: 'cup-copy', name: 'Cup copy', seo: { ...EMPTY_SEO, canonicalUrl: '/products/cup' } });
	await shop.seedProduct({
		slug: 'teapot',
		name: 'Teapot',
		seo: { ...EMPTY_SEO, canonicalUrl: `${ORIGIN}/products/teapot` },
	});
	await shop.seedProduct({
		slug: 'elsewhere',
		name: 'Elsewhere',
		seo: { ...EMPTY_SEO, canonicalUrl: 'https://other.example.com/products/elsewhere' },
	});
});
afterAll(async () => shop.product.close());

describe('the sitemap', () => {
	it('leaves out products and categories whose canonical address is another page', async () => {
		const text = (await shop.api('GET', '/v1/seo/sitemap.xml')).text;
		const locs = [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
		expect(locs.sort()).toEqual(
			[
				`${ORIGIN}/`,
				`${ORIGIN}/categories/cups`,
				`${ORIGIN}/categories/tea`,
				`${ORIGIN}/products/cup`,
				`${ORIGIN}/products/teapot`,
			].sort(),
		);
		// the same in the files of a split sitemap
		const categories = (await shop.api('GET', '/v1/seo/sitemaps/categories')).text;
		expect(categories).not.toContain('old-cups');
		const products = (await shop.api('GET', '/v1/seo/sitemaps/products-1')).text;
		expect(products).not.toContain('cup-copy');
		expect(products).not.toContain('elsewhere');
	});
});
