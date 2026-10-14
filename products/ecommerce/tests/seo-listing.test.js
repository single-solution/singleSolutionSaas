/**
 * Listing heads as Google's pagination and faceted-navigation guidance asks (SEO audit G7, G12, phase S1): every page
 * after the first keeps its own address as canonical, also when it is not indexed; a filtered list is not indexed and
 * names itself as canonical (never the category); the ItemList holds the products the page shows, in its order; FAQ
 * markup only while the merchant asks for it (the questions stay in the answer, to be shown on the page).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, readyShop, storedCategory } from './helpers.js';
import { COLLECTIONS } from '../core/model.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;

/** @param {string} path */
const head = async (path) => {
	const answer = await shop.api('GET', path);
	if (answer.status !== 200) throw new Error(`${path}: ${answer.status} ${answer.text}`);
	return answer.json;
};
/** @param {string} jsonLd @param {string} type */
const nodeOf = (jsonLd, type) => JSON.parse(jsonLd)['@graph'].find((/** @type {any} */ node) => node['@type'] === type);
/** @param {string} jsonLd */
const listed = (jsonLd) => (nodeOf(jsonLd, 'ItemList')?.itemListElement ?? []).map((/** @type {any} */ item) => item.name);

beforeAll(async () => {
	shop = await readyShop();
	const data = await shop.db();
	await data.collection(COLLECTIONS.categories).insertOne(
		storedCategory({
			id: 'cat_mugs',
			slug: 'mugs',
			name: 'Mugs',
			faqs: [{ question: 'Microwave safe?', answer: 'Yes.' }],
		}),
	);
	// newest first: Mug C, Mug B, Mug A
	for (const [index, name] of ['Mug A', 'Mug B', 'Mug C'].entries())
		await shop.seedProduct({
			slug: name.toLowerCase().replace(' ', '-'),
			name,
			categoryIds: ['cat_mugs'],
			publishedAt: new Date(Date.UTC(2026, 9, 1 + index)),
		});
	await shop.setting('catalog', 'pageSize', 2);
});
afterAll(async () => shop.product.close());

describe('canonical addresses', () => {
	it('keeps its own address as canonical on pages after the first, indexed or not', async () => {
		const second = await head('/v1/seo/listing?category=mugs&page=2');
		expect(second).toMatchObject({ canonical: `${ORIGIN}/categories/mugs?page=2`, robots: 'index, follow' });
		await shop.setting('seo', 'pagedListings', 'noindex');
		const hidden = await head('/v1/seo/listing?category=mugs&page=2');
		expect(hidden).toMatchObject({ canonical: `${ORIGIN}/categories/mugs?page=2`, robots: 'noindex, follow' });
		expect(nodeOf(hidden.jsonLd, 'CollectionPage').url).toBe(`${ORIGIN}/categories/mugs?page=2`);
		const first = await head('/v1/seo/listing?category=mugs&page=1');
		expect(first).toMatchObject({ canonical: `${ORIGIN}/categories/mugs`, robots: 'index, follow' });
		await shop.setting('seo', 'pagedListings', 'index');
	});

	it('gives a filtered list its own address as canonical, its filters in one order', async () => {
		const filtered = await head('/v1/seo/listing?category=mugs&minPrice=500&attr.color=red&page=2');
		expect(filtered).toMatchObject({
			robots: 'noindex, follow',
			canonical: `${ORIGIN}/categories/mugs?attr.color=red&minPrice=500&page=2`,
		});
		const sorted = await head('/v1/seo/listing?category=mugs&sort=price_asc&cursor=abc');
		expect(sorted).toMatchObject({ robots: 'noindex, follow', canonical: `${ORIGIN}/categories/mugs?sort=price_asc` });
	});
});

describe('the ItemList', () => {
	it('lists the products the page shows, in its order', async () => {
		expect(listed((await head('/v1/seo/listing?category=mugs')).jsonLd)).toEqual(['Mug C', 'Mug B']);
		expect(listed((await head('/v1/seo/listing?category=mugs&page=2')).jsonLd)).toEqual(['Mug A']);
		expect(listed((await head('/v1/seo/listing?category=mugs&limit=1')).jsonLd)).toEqual(['Mug C']);
		expect(listed((await head('/v1/seo/listing?category=mugs&sort=name')).jsonLd)).toEqual(['Mug A', 'Mug B']);
		expect(listed((await head('/v1/seo/listing?category=mugs&page=9')).jsonLd)).toEqual([]);
		expect(listed((await head('/v1/seo/categories/mugs')).jsonLd)).toEqual(['Mug C', 'Mug B']);
	});
});

describe('FAQ markup', () => {
	it('answers the questions but marks them up only while faqMarkup is on', async () => {
		const off = await head('/v1/seo/listing?category=mugs');
		expect(off.faqs).toEqual([{ question: 'Microwave safe?', answer: 'Yes.' }]);
		expect(nodeOf(off.jsonLd, 'FAQPage')).toBeUndefined();
		expect(nodeOf((await head('/v1/seo/categories/mugs')).jsonLd, 'FAQPage')).toBeUndefined();
		await shop.setting('seo', 'faqMarkup', true);
		expect(nodeOf((await head('/v1/seo/listing?category=mugs')).jsonLd, 'FAQPage').mainEntity).toHaveLength(1);
		expect(nodeOf((await head('/v1/seo/categories/mugs')).jsonLd, 'FAQPage').mainEntity).toHaveLength(1);
		await shop.setting('seo', 'faqMarkup', false);
	});
});
