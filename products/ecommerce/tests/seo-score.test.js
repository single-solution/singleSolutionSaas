/**
 * The SEO score per record (PLAN 0.8.10 E42; SEO audit §3.2 A, phase S12): the checks of a product's, category's,
 * brand's and deal's own SEO copy and the 0–100 score, worked out on read and never stored; staff reads carry it while
 * the `seo` feature is on, and the staff product list sorts and filters by it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brandScore, categoryScore, dealScore, productScore, seoScore } from '../core/seo-score.js';
import { ALL, readyShop } from './helpers.js';

/** Every feature but stock per location (one stock count per variant). */
const FEATURES = ALL.filter((feature) => feature !== 'multi_location');

/** Some words. @param {number} n */
const words = (n) => Array.from({ length: n }, (_, index) => `word${index}`).join(' ');

describe('the score of a record', () => {
	const strong = {
		name: 'Linen shirt',
		seo: {
			title: 'Linen shirt for hot summer days',
			description: 'A breathable linen shirt, woven from flax, that keeps you cool on the hottest summer days.',
			focusKeyword: 'Linen  SHIRT',
		},
		text: `A linen shirt woven from flax. ${words(60)}\n\nCare: wash cold.`,
		images: [{ alt: 'The shirt from the front' }],
		inCategory: true,
	};

	it('passes every check of well written copy', () => {
		expect(seoScore(strong)).toEqual({
			score: 100,
			checks: [
				{ key: 'title_length', ok: true },
				{ key: 'description', ok: true },
				{ key: 'focus_keyword', ok: true },
				{ key: 'keyword_in_title', ok: true },
				{ key: 'keyword_in_description', ok: true },
				{ key: 'keyword_in_text', ok: true },
				{ key: 'text_length', ok: true },
				{ key: 'image_alt', ok: true },
				{ key: 'in_category', ok: true },
			],
		});
	});

	it('fails what is missing, too long or too short', () => {
		const weak = seoScore({
			name: 'Shirt',
			seo: { title: '', description: 'Short.', focusKeyword: '' },
			text: 'Too short.',
			images: [],
			inCategory: false,
		});
		expect(weak.score).toBe(0);
		expect(weak.checks.every((check) => !check.ok)).toBe(true);
		// a keyword only past the first paragraph, a photo without its text, a title cut by search engines
		const mixed = seoScore({
			...strong,
			seo: { ...strong.seo, title: `${strong.seo.title} ${'x'.repeat(40)}` },
			text: `${words(60)}\n\nOur linen shirt.`,
			images: [{ alt: 'front' }, { alt: ' ' }],
		});
		expect(mixed.checks.filter((check) => !check.ok).map((check) => check.key)).toEqual([
			'title_length',
			'keyword_in_text',
			'image_alt',
		]);
		expect(mixed.score).toBe(67);
	});

	it('scores each kind of record by what it has', () => {
		const seo = { title: '', description: '', focusKeyword: '' };
		const product = productScore(/** @type {any} */ ({ name: 'Mug', seo, description: '', media: [], categoryIds: ['cat_1'] }));
		expect(product.checks.map((check) => check.key)).toContain('in_category');
		// a category or brand without its image needs none; with one, its text
		const category = categoryScore(
			/** @type {any} */ ({
				name: 'Mugs',
				seo,
				description: words(30),
				content: { summary: words(30), bullets: [] },
				image: null,
			}),
		);
		expect(category.checks.map((check) => check.key)).not.toContain('image_alt');
		expect(category.checks.find((check) => check.key === 'text_length')?.ok).toBe(true);
		const brand = brandScore(/** @type {any} */ ({ name: 'Acme', seo, description: '', logo: { key: 'k', alt: '' } }));
		expect(brand.checks.find((check) => check.key === 'image_alt')?.ok).toBe(false);
		// a deal has no focus keyword
		const deal = dealScore(
			/** @type {any} */ ({ name: 'Summer sale', seo: { title: '', description: '' }, content: '', banner: null }),
		);
		expect(deal.checks.map((check) => check.key)).toEqual(['title_length', 'description', 'text_length']);
		expect(deal.score).toBe(33);
	});
});

describe('the score on staff reads', () => {
	/** @type {Awaited<ReturnType<typeof readyShop>>} */
	let shop;
	/** @type {Record<string, any>} */
	const ids = {};

	/** @param {string} method @param {string} path @param {unknown} [body] */
	const api = async (method, path, body) => {
		const answer = await shop.api(method, path, body);
		if (answer.status >= 300) throw new Error(`${method} ${path}: ${answer.status} ${answer.text}`);
		return answer.json;
	};
	/** @param {string} query */
	const names = async (query) =>
		(await api('GET', `/v1/products?${query}`)).items.map((/** @type {any} */ row) => `${row.name} ${row.seoScore}`);

	beforeAll(async () => {
		shop = await readyShop({ features: FEATURES });
		ids.category = await api('POST', '/v1/categories', {
			name: 'Shirts',
			description: words(60),
			seo: { focusKeyword: 'shirts', description: 'Shirts of linen and cotton for every day of the summer, in every size.' },
		});
		ids.brand = await api('POST', '/v1/brands', { name: 'Acme' });
		const product = (/** @type {string} */ name, /** @type {Record<string, unknown>} */ more = {}) => {
			shop.advance(1000);
			return api('POST', '/v1/products', { name, status: 'active', price: 1000, stock: 1, ...more });
		};
		ids.weak = await product('Weak');
		ids.fair = await product('Fair linen shirt', { categoryIds: [ids.category.id], seo: { focusKeyword: 'linen shirt' } });
		ids.good = await product('Good linen shirt', {
			categoryIds: [ids.category.id],
			description: `A linen shirt. ${words(60)}`,
			seo: {
				focusKeyword: 'linen shirt',
				description: 'A breathable linen shirt, woven from flax, that keeps you cool on the hottest summer days.',
			},
		});
		ids.deal = await api('POST', '/v1/deals', { name: 'Summer sale', type: 'percent', value: 10 });
	});
	afterAll(async () => shop?.product.close());

	it('adds the score and its checks to products, categories, brands and deals', async () => {
		const good = await api('GET', `/v1/products/${ids.good.id}`);
		expect(good.seo).toMatchObject({ focusKeyword: 'linen shirt', score: 89 });
		expect(good.seo.checks.find((/** @type {any} */ check) => check.key === 'image_alt')).toEqual({
			key: 'image_alt',
			ok: false,
		});
		expect(ids.good.seo.score).toBe(89);
		// "Shirts | Shop" is a title of a good length, as the page shows it
		expect((await api('GET', `/v1/categories/${ids.category.id}`)).seo.score).toBe(86);
		expect((await api('GET', '/v1/brands')).items[0].seo).toMatchObject({ score: 14 });
		expect((await api('GET', `/v1/deals/${ids.deal.id}`)).seo).toMatchObject({ title: '', score: 33 });
		// nothing for shoppers
		expect((await shop.visitor('GET', `/v1/shop/products/${ids.good.slug}`)).json.seo).not.toHaveProperty('score');
	});

	it('judges the title the page shows: the title pattern around the name (review L10)', async () => {
		// 55 characters of name: with the default pattern "{name} | {business}" the page title is 62
		const long = await api('POST', '/v1/products', { name: 'A'.repeat(55), status: 'draft', price: 1000 });
		const check = (/** @type {any} */ record) =>
			record.seo.checks.find((/** @type {any} */ entry) => entry.key === 'title_length').ok;
		expect(check(await api('GET', `/v1/products/${long.id}`))).toBe(false);
		// a title written as the whole title is judged as written
		const whole = await api('PATCH', `/v1/products/${long.id}`, {
			seo: { title: 'A linen shirt for the summer', titleMode: 'as_written' },
		});
		expect(check(whole)).toBe(true);
		const brand = await api('POST', '/v1/brands', { name: 'B'.repeat(55) });
		expect(check((await api('GET', '/v1/brands')).items.find((/** @type {any} */ row) => row.id === brand.id))).toBe(false);
		await api('DELETE', `/v1/brands/${brand.id}`);
		await api('DELETE', `/v1/products/${long.id}`);
	});

	it('sorts and filters the product list by the score', async () => {
		expect(await names('')).toEqual(['Good linen shirt 89', 'Fair linen shirt 44', 'Weak 11']);
		expect(await names('sort=seo_score')).toEqual(['Weak 11', 'Fair linen shirt 44', 'Good linen shirt 89']);
		expect(await names('seoBelow=50&q=shirt')).toEqual(['Fair linen shirt 44']);
		// the counts follow the filter
		expect((await api('GET', '/v1/products/count?seoBelow=50')).count).toBe(2);
		expect((await api('GET', '/v1/products/counts?seoBelow=50&by=status')).groups).toEqual({ active: 2 });
		const first = await api('GET', '/v1/products?sort=seo_score&limit=2');
		expect(first.items.map((/** @type {any} */ row) => row.name)).toEqual(['Weak', 'Fair linen shirt']);
		expect(first.hasMore).toBe(true);
		const next = await api('GET', `/v1/products?sort=seo_score&limit=2&cursor=${first.nextCursor}`);
		expect(next).toMatchObject({ items: [{ name: 'Good linen shirt' }], hasMore: false });
		expect((await shop.api('GET', '/v1/products?sort=name')).json.errors[0].path).toBe('/sort');
		expect((await shop.api('GET', '/v1/products?seoBelow=101')).json.errors[0].path).toBe('/seoBelow');
	});

	it('leaves the score out while SEO is off', async () => {
		await shop.switchOn(FEATURES.filter((feature) => feature !== 'seo' && feature !== 'landing_pages'));
		try {
			expect((await api('GET', `/v1/products/${ids.good.id}`)).seo.score).toBeUndefined();
			expect((await api('GET', '/v1/products')).items[0].seoScore).toBeUndefined();
			expect((await shop.api('GET', '/v1/products?sort=seo_score')).status).toBe(403);
		} finally {
			await shop.switchOn(FEATURES);
		}
	});
});
