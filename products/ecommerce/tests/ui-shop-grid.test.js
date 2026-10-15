// @vitest-environment jsdom
/* global document, window */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STORAGE_KEYS } from '../core/widgets.js';
import { mountProductGrid, pageNumbers } from '../ui/product-grid.js';
import {
	codeOf,
	currencyOf,
	fill,
	formatsOf,
	h,
	keepFocus,
	mountShop,
	problemText,
	productCard,
	ratingText,
	settingsOf,
	textsOf,
	warrantyText,
} from '../ui/shop-common.js';
import {
	COMPARE_EVENT,
	clearCompare,
	compareIds,
	onCompareChange,
	removeCompare,
	toggleCompare,
} from '../ui/shop-compare-store.js';
import { activeCount, clearedFilters, emptyKnown, filterControls, flattenCategories, remember } from '../ui/shop-filters.js';
import { savedOf } from '../ui/shop-saved.js';
import {
	$,
	$$,
	buttonOf,
	click,
	configOf,
	fail,
	flush,
	makeShop,
	ok,
	place,
	resetPage,
	setValue,
	submit,
	text,
	textOf,
} from './ui-shop-helpers.js';

beforeEach(resetPage);
afterEach(resetPage);

/** @param {string} id @param {Record<string, unknown>} [over] */
const card = (id, over = {}) => ({
	id,
	slug: id,
	name: `Phone ${id}`,
	price: 100000,
	compareAtPrice: 120000,
	currency: 'USD',
	image: `https://cdn.example.com/${id}.png`,
	url: `https://shop.example.com/products/${id}`,
	inStock: true,
	rating: { average: 4.5, count: 2 },
	brand: { id: 'brd_1', name: 'Acme' },
	grades: ['Like new'],
	variantCount: 1,
	...over,
});

const FACETS = {
	categories: [{ id: 'cat_1', slug: 'phones', name: 'Phones', count: 3 }],
	brands: [{ id: 'brd_1', slug: 'acme', name: 'Acme', count: 3 }],
	price: { min: 50000, max: 150000 },
	attributes: [
		{
			id: 'atr_1',
			slug: 'storage',
			name: 'Storage',
			unit: 'GB',
			type: 'number',
			values: [
				{ value: 128, label: '128 GB', count: 2 },
				{ value: 256, label: '256 GB', count: 1 },
			],
		},
		{
			id: 'atr_2',
			slug: 'fast-charging',
			name: 'Fast charging',
			unit: '',
			type: 'yes_no',
			values: [{ value: true, label: 'true', count: 1 }],
		},
		{ id: 'atr_3', name: 'Color', unit: '', type: 'choice', values: [{ value: 'red', label: 'Red', count: 1 }] },
	],
	grades: [{ key: 'a', label: 'Like new', count: 2 }],
};

/** The category tree as `GET /v1/shop/categories` answers it. */
const TREE = {
	items: [
		{
			id: 'cat_1',
			slug: 'phones',
			name: 'Phones',
			status: 'active',
			count: 3,
			children: [{ id: 'cat_2', slug: 'android', name: 'Android', status: 'active', count: 2, children: [] }],
		},
		{ id: 'cat_3', slug: 'tablets', name: 'Tablets', status: 'coming_soon', count: 0, children: [] },
		{ bad: true },
	],
};

/** The brands as `GET /v1/shop/brands` answers them. */
const BRANDS = {
	items: [
		{ id: 'brd_1', slug: 'acme', name: 'Acme', count: 3 },
		{ id: 'brd_2', slug: 'zeta', name: 'Zeta', count: 2 },
		{ id: 'brd_3', slug: 'empty', name: 'Empty', count: 0 },
	],
};

/**
 * Mount the grid.
 * @param {ReturnType<typeof makeShop>} fake
 * @param {Record<string, string>} [data]
 * @param {Record<string, any>} [settings]
 */
const mountGrid = async (fake, data = {}, settings = {}) => {
	const host = place('product_grid', data);
	await mountProductGrid({
		host,
		config: configOf(['catalog', ...(fake.shop.has('wishlist') ? ['wishlist'] : [])], settings),
		shop: fake.shop,
		win: window,
	});
	await flush();
	return host;
};

const listing = () => {
	/** @type {Array<(call: any) => any>} */
	const queue = [];
	return {
		queue,
		/** @param {any} call */
		route: (call) => {
			const next = queue.shift();
			return next ? next(call) : ok({ items: [], nextCursor: null, facets: null });
		},
	};
};

/**
 * The checkbox of the label with this text.
 * @param {HTMLElement} host
 * @param {string} label
 * @returns {any}
 */
const checkOf = (host, label) => {
	const found = $$(host, '.filter-panel label.check').find((node) => node.textContent === label);
	if (!found) throw new Error(`no check ${label}`);
	return found.querySelector('input');
};

describe('product grid', () => {
	it('gives each picture its size, so the page does not move while it loads (G14)', async () => {
		const pages = listing();
		pages.queue.push(() =>
			ok({
				items: [
					card('prd_a', { imageSize: { width: 800, height: 600 } }),
					card('prd_b', {
						cardImages: [
							{ url: 'https://cdn.example.com/1.png', alt: 'Red', width: 400, height: 500 },
							{ url: 'https://cdn.example.com/2.png', alt: 'Blue' },
						],
					}),
					card('prd_c', { imageSize: null }),
				],
				nextCursor: null,
				facets: null,
			}),
		);
		const host = await mountGrid(makeShop({ features: ['catalog'], routes: { 'GET /v1/shop/products': pages.route } }));
		const sizes = (/** @type {Element} */ card) =>
			[...card.querySelectorAll('img')].map((img) => [img.getAttribute('width'), img.getAttribute('height')]);
		const [single, quad, none] = $$(host, 'li.card');
		expect(sizes(single)).toEqual([['800', '600']]);
		expect(sizes(quad)).toEqual([
			['400', '500'],
			[null, null],
		]);
		expect(sizes(none)).toEqual([[null, null]]);
	});

	it('starts from the data attributes, counts, pages and loads more with the cursor', async () => {
		const pages = listing();
		pages.queue.push(
			() =>
				ok({
					items: [
						card('prd_a', {
							priceMax: 150000,
							featured: true,
							cardImages: [
								{ url: 'https://cdn.example.com/1.png', alt: 'Red' },
								{ url: 'https://cdn.example.com/2.png', alt: '' },
								{ url: null, alt: 'Gone' },
								{ url: 'https://cdn.example.com/3.png', alt: 'Blue' },
								{ url: 'https://cdn.example.com/4.png', alt: 'Green' },
								{ url: 'https://cdn.example.com/5.png', alt: 'Gold' },
							],
						}),
						card('prd_b', {
							inStock: false,
							image: null,
							rating: { average: 0, count: 0 },
							cardImages: [{ url: 'https://cdn.example.com/only.png', alt: 'Only' }],
						}),
					],
					nextCursor: 'c1',
					hasMore: true,
					total: 5,
					capped: false,
					facets: FACETS,
				}),
			() => ok({ items: [card('prd_c', { compareAtPrice: null, grades: [] })], nextCursor: 'c2', facets: null }),
			() => ok({ items: [card('prd_e')], nextCursor: null, page: 3, facets: null }),
		);
		const fake = makeShop({ features: ['catalog'], routes: { 'GET /v1/shop/products': pages.route } });
		const host = await mountGrid(fake, {
			category: 'phones',
			query: 'pixel',
			limit: '2',
			brand: 'acme, brd_2',
			grade: 'a',
			deal: 'dl_1',
			featured: '1',
			sort: 'updated',
		});
		expect(host.getAttribute('data-ss-mounted')).toBe('product-grid');
		expect(fake.all('GET /v1/shop/products')[0]?.query).toEqual({
			q: 'pixel',
			category: 'phones',
			brand: 'acme,brd_2',
			grade: 'a',
			featured: '1',
			deal: 'dl_1',
			sort: 'updated',
			limit: '2',
			count: '1',
		});
		// the categories, the brands of the category; no deals while that feature is off
		expect(fake.last('GET /v1/shop/categories')?.query).toEqual({ include: 'coming_soon' });
		expect(fake.last('GET /v1/shop/brands')?.query).toEqual({ category: 'phones' });
		expect(fake.all('GET /v1/shop/deals')).toHaveLength(0);
		const page = textOf(host);
		expect(page).toContain('Phone prd_a');
		expect(page).toContain(text('shop.priceRange', { min: 'USD 1,000.00', max: 'USD 1,500.00' }));
		expect(page).toContain('USD 1,200.00');
		expect(page).toContain(text('shop.rating', { average: '4.5', count: 2 }));
		expect(page).toContain(text('shop.outOfStock'));
		expect(page).toContain('Like new');
		expect($(host, 'a.name').getAttribute('href')).toBe('https://shop.example.com/products/prd_a');
		const [first, second] = $$(host, 'li.card');
		expect(first.querySelector('.badge.accent').textContent).toBe(text('shop.featured'));
		expect([...first.querySelectorAll('.quad img')].map((img) => img.getAttribute('alt'))).toEqual([
			'Red',
			'Phone prd_a',
			'Blue',
			'Green',
		]);
		expect(second.querySelector('.quad')).toBeNull();
		expect(second.querySelector('img').getAttribute('src')).toBe('https://cdn.example.com/only.png');
		expect(second.querySelector('.badge.accent')).toBeNull();
		// no wishlist or compare toggles while those features are off
		expect($$(host, '[data-wish], [data-compare]')).toHaveLength(0);
		// the footer: how many, page numbers and Load more
		const summary = () => $(host, '.foot .meta').textContent;
		expect(summary()).toBe(`${text('grid.showing', { from: 1, to: 2 })} · ${text('grid.total', { count: 5 })}`);
		const numbers = () => $$(host, '.pages button').map((b) => b.textContent);
		expect(numbers()).toEqual([text('grid.prevPage'), '1', '2', '3', text('grid.nextPage')]);
		expect($(host, '.pages [aria-current="page"]').textContent).toBe('1');
		expect(buttonOf(host, text('grid.prevPage')).disabled).toBe(true);
		await click(buttonOf(host, text('grid.more')));
		expect(fake.all('GET /v1/shop/products')[1]?.query.cursor).toBe('c1');
		expect(fake.all('GET /v1/shop/products')[1]?.query.count).toBeUndefined();
		expect($$(host, 'li.card')).toHaveLength(3);
		expect(summary()).toBe(`${text('grid.showing', { from: 1, to: 3 })} · ${text('grid.total', { count: 5 })}`);
		expect($(host, '.pages [aria-current="page"]').textContent).toBe('2');
		await click(buttonOf(host, text('grid.pageLabel', { n: 3 })));
		const third = fake.all('GET /v1/shop/products')[2]?.query;
		expect(third?.page).toBe('3');
		expect(third?.cursor).toBeUndefined();
		expect(third?.count).toBeUndefined();
		expect($$(host, 'li.card')).toHaveLength(1);
		expect(summary()).toBe(`${text('grid.showing', { from: 5, to: 5 })} · ${text('grid.total', { count: 5 })}`);
		expect(buttonOf(host, text('grid.nextPage')).disabled).toBe(true);
		expect(buttonOf(host, text('grid.more')).hidden).toBe(true);
		// the facets of the first page stay while other pages are shown
		expect($(host, '#ss-grid-category')).not.toBeNull();
	});

	it('filters by category, several brands, grades and attribute values, price, stock, featured and deal', async () => {
		/** @type {any[]} */
		const asked = [];
		const fake = makeShop({
			features: ['catalog', 'deals'],
			routes: {
				'GET /v1/shop/products': (call) => {
					asked.push(call.query);
					return ok({ items: [card('prd_a')], nextCursor: null, total: 1, facets: FACETS });
				},
				'GET /v1/shop/categories': () => ok(TREE),
				'GET /v1/shop/brands': () => ok(BRANDS),
				'GET /v1/shop/deals': () => ok({ items: [{ id: 'dl_1', name: 'Autumn sale' }] }),
			},
		});
		const host = await mountGrid(fake, {}, { catalog: { pageSize: 12 } });
		expect(asked[0]).toEqual({ sort: 'newest', limit: '12', count: '1' });
		expect(fake.last('GET /v1/shop/brands')?.query).toEqual({});
		expect(fake.last('GET /v1/shop/deals')?.query).toEqual({ limit: '50' });
		// the filters open behind their button where the widget is narrow
		const toggle = buttonOf(host, text('grid.filters'));
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect($(host, '.filter-panel').hasAttribute('data-open')).toBe(false);
		await click(toggle);
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		expect($(host, '.filter-panel').hasAttribute('data-open')).toBe(true);
		// the category tree: counts from the facets, a child indented, coming soon not to be chosen
		const category = $(host, '#ss-grid-category');
		const options = [...category.options].map((/** @type {any} */ o) => [o.value, o.textContent, o.disabled]);
		expect(options).toEqual([
			['', text('grid.allCategories'), false],
			['phones', text('grid.facetValue', { value: 'Phones', count: 3 }), false],
			['android', ' Android', false],
			['tablets', text('grid.comingSoonOption', { name: 'Tablets' }), true],
		]);
		await setValue(category, 'android');
		expect(asked.at(-1).category).toBe('android');
		expect(fake.last('GET /v1/shop/brands')?.query).toEqual({ category: 'android' });
		// brands of the category (a brand without products is left out), counts from the facets
		expect(textOf(host)).not.toContain('Empty');
		await setValue(checkOf(host, text('grid.facetValue', { value: 'Acme', count: 3 })), true);
		expect(asked.at(-1).brand).toBe('acme');
		await setValue(checkOf(host, 'Zeta'), true);
		expect(asked.at(-1).brand).toBe('acme,zeta');
		await setValue(checkOf(host, text('grid.facetValue', { value: 'Acme', count: 3 })), false);
		expect(asked.at(-1).brand).toBe('zeta');
		expect(toggle.textContent).toBe(text('grid.filtersCount', { count: 2 }));
		// prices
		const prices = () => $$(host, '.filter-panel input[inputmode="decimal"]');
		expect(prices()[0].placeholder).toBe('500.00');
		await setValue(prices()[0], '500');
		expect(asked.at(-1).minPrice).toBe('50000');
		const count = asked.length;
		await setValue(prices()[1], 'abc');
		expect(asked).toHaveLength(count);
		expect($(host, '[role="status"]').textContent).toBe(text('grid.priceInvalid'));
		await submit($(host, 'form'));
		expect(asked).toHaveLength(count);
		await setValue(prices()[1], '1500.5');
		expect(asked.at(-1).maxPrice).toBe('150050');
		// grades and attribute values by slug, several at once
		await setValue(checkOf(host, text('grid.facetValue', { value: 'Like new', count: 2 })), true);
		expect(asked.at(-1).grade).toBe('a');
		await setValue(checkOf(host, text('grid.facetValue', { value: '128 GB', count: 2 })), true);
		expect(asked.at(-1)['attr.storage']).toBe('128');
		await setValue(checkOf(host, text('grid.facetValue', { value: '256 GB', count: 1 })), true);
		expect(asked.at(-1)['attr.storage']).toBe('128,256');
		await setValue(checkOf(host, text('grid.facetValue', { value: '128 GB', count: 2 })), false);
		expect(asked.at(-1)['attr.storage']).toBe('256');
		expect(textOf(host)).toContain(text('grid.facetValue', { value: text('shop.yes'), count: 1 }));
		await setValue(checkOf(host, text('grid.facetValue', { value: 'Red', count: 1 })), true);
		expect(asked.at(-1)['attr.atr_3']).toBe('red');
		// in stock, featured, a deal
		await setValue(checkOf(host, text('grid.inStock')), true);
		expect(asked.at(-1).inStock).toBe('true');
		await setValue(checkOf(host, text('grid.featured')), true);
		expect(asked.at(-1).featured).toBe('1');
		const deal = $(host, '#ss-grid-deal');
		expect([...deal.options].map((/** @type {any} */ o) => o.textContent)).toEqual([text('grid.anyDeal'), 'Autumn sale']);
		await setValue(deal, 'dl_1');
		expect(asked.at(-1).deal).toBe('dl_1');
		// sorts include recently updated and fewest sold
		const sorts = [...$(host, '#ss-grid-sort').options].map((/** @type {any} */ o) => o.value);
		expect(sorts).toContain('updated');
		expect(sorts).toContain('sold_asc');
		await setValue($(host, '#ss-grid-sort'), 'sold_asc');
		expect(asked.at(-1).sort).toBe('sold_asc');
		$(host, 'input[type="search"]').value = ' phone ';
		await submit($(host, 'form'));
		expect(asked.at(-1).q).toBe('phone');
		expect(asked.at(-1).count).toBe('1');
		await click(buttonOf(host, text('grid.clearFilters')));
		expect(asked.at(-1)).toEqual({ q: 'phone', sort: 'sold_asc', limit: '12', count: '1' });
		expect(fake.last('GET /v1/shop/brands')?.query).toEqual({});
		expect(toggle.textContent).toBe(text('grid.filters'));
	});

	it('keeps chosen values the facets no longer list, and shows no filters without facets', async () => {
		const pages = listing();
		pages.queue.push(() =>
			ok({
				items: [card('prd_a')],
				nextCursor: null,
				facets: { ...FACETS, categories: [], brands: [], price: null, attributes: [], grades: [] },
			}),
		);
		const fake = makeShop({ features: ['catalog'], routes: { 'GET /v1/shop/products': pages.route } });
		const host = await mountGrid(
			fake,
			{ category: 'cat_9', brand: 'brd_9', grade: 'z' },
			{ catalog: { grades: { a: 'Like new' } } },
		);
		expect($(host, '#ss-grid-category').value).toBe('cat_9');
		expect(checkOf(host, 'brd_9').checked).toBe(true);
		expect(checkOf(host, 'z').checked).toBe(true);
		// the website's grades are offered before any facet names them
		expect(checkOf(host, 'Like new').checked).toBe(false);
		expect($$(host, '.filter-panel input[inputmode="decimal"]')).toHaveLength(0);
		// a choice made before the panel opens it
		expect($(host, '.filter-panel').hasAttribute('data-open')).toBe(true);
		expect($(host, '.foot .meta').textContent).toBe('');

		resetPage();
		const empty = makeShop({
			features: ['catalog'],
			routes: { 'GET /v1/shop/products': () => ok({ items: [card('prd_a')], nextCursor: null, facets: null }) },
		});
		const bare = await mountGrid(empty);
		expect($(bare, '.filter-panel').hidden).toBe(true);
		expect(buttonOf(bare, text('grid.filters')).hidden).toBe(true);
		expect($(bare, '.pages').children).toHaveLength(0);
	});

	it('says a coming-soon category is coming soon, and pages with gaps up to a capped total', async () => {
		const fake = makeShop({
			features: ['catalog'],
			routes: {
				'GET /v1/shop/products': (call) =>
					call.query.category === 'tablets'
						? ok({ items: [], nextCursor: null, total: 0, facets: null })
						: ok({ items: [card('prd_a'), card('prd_b')], nextCursor: 'c', total: 10000, capped: true, facets: FACETS }),
				'GET /v1/shop/categories': () => ok(TREE),
				'GET /v1/shop/brands': () => fail(500, 'internal_error'),
			},
		});
		const host = await mountGrid(fake, { category: 'tablets', limit: '2' });
		expect($(host, '[role="status"]').textContent).toBe(text('grid.comingSoon', { name: 'Tablets' }));
		// the chosen coming-soon category stays shown
		expect([...$(host, '#ss-grid-category').options].find((/** @type {any} */ o) => o.value === 'tablets').disabled).toBe(
			false,
		);
		await setValue($(host, '#ss-grid-category'), '');
		expect($(host, '.foot .meta').textContent).toContain(text('grid.totalCapped', { count: 10000 }));
		expect($$(host, '.pages button').map((b) => b.textContent)).toEqual([
			text('grid.prevPage'),
			'1',
			'2',
			'500',
			text('grid.nextPage'),
		]);
		expect($$(host, '.pages .gap')).toHaveLength(1);
		await click(buttonOf(host, text('grid.nextPage')));
		expect(fake.last('GET /v1/shop/products')?.query.page).toBe('2');
		await click(buttonOf(host, text('grid.prevPage')));
		expect(fake.last('GET /v1/shop/products')?.query.page).toBe('1');
		expect(pageNumbers(1, 1)).toEqual([1]);
		expect(pageNumbers(5, 9)).toEqual([1, 0, 4, 5, 6, 0, 9]);
		expect(pageNumbers(2, 3)).toEqual([1, 2, 3]);
	});

	it('shows the first values of a long list and the rest with Show all', async () => {
		const many = Array.from({ length: 12 }, (_, i) => ({ id: `brd_${i}`, slug: `b${i}`, name: `Brand ${i}`, count: 1 }));
		/** @type {any[]} */
		const asked = [];
		const fake = makeShop({
			features: ['catalog'],
			routes: {
				'GET /v1/shop/products': (call) => {
					asked.push(call.query);
					return ok({ items: [card('prd_a')], nextCursor: null, facets: { ...FACETS, brands: [] } });
				},
				'GET /v1/shop/brands': () => ok({ items: many }),
				'GET /v1/shop/categories': () => fail(500, 'internal_error'),
			},
		});
		const host = await mountGrid(fake, { brand: 'b11' });
		const brands = () => $$(host, '.filter-panel fieldset')[0].querySelectorAll('label.check');
		// eight first, and the chosen one
		expect(brands()).toHaveLength(9);
		expect(checkOf(host, 'Brand 11').checked).toBe(true);
		await click(buttonOf(host, text('grid.showAll', { count: 12 })));
		expect(brands()).toHaveLength(12);
		expect(buttonOf(host, text('grid.showFewer')).getAttribute('aria-expanded')).toBe('true');
		await click(buttonOf(host, text('grid.showFewer')));
		expect(brands()).toHaveLength(9);
		// the category select falls back to the facets when the tree cannot be read
		expect([...$(host, '#ss-grid-category').options].map((/** @type {any} */ o) => o.value)).toEqual(['', 'phones']);
		// a new search forgets the attribute values seen before
		expect(textOf(host)).toContain('Storage');
		const before = asked.length;
		$(host, 'input[type="search"]').value = 'x';
		await submit($(host, 'form'));
		expect(asked).toHaveLength(before + 1);
	});

	it('shows the empty and error states', async () => {
		const pages = listing();
		pages.queue.push(
			() => ok({ items: [], nextCursor: null, facets: FACETS }),
			() => fail(500, 'internal_error'),
			() => fail(422, 'validation_failed'),
			() => ok({ items: [card('prd_a')], nextCursor: 'c1', facets: FACETS }),
			() => fail(503, 'unavailable'),
		);
		const fake = makeShop({ features: ['catalog'], routes: { 'GET /v1/shop/products': pages.route } });
		const host = await mountGrid(fake);
		const status = () => $(host, '[role="status"]').textContent;
		expect(status()).toBe(text('grid.empty'));
		await submit($(host, 'form'));
		expect(status()).toBe(text('grid.error'));
		await submit($(host, 'form'));
		expect(status()).toBe(text('grid.error'));
		await submit($(host, 'form'));
		expect($$(host, 'li.card')).toHaveLength(1);
		await click(buttonOf(host, text('grid.more')));
		expect($$(host, 'li.card')).toHaveLength(1);
		expect(status()).toBe(text('grid.error'));
	});

	it('drops an answer that a newer search replaced', async () => {
		/** @type {(value: any) => void} */
		let release = () => undefined;
		const pages = listing();
		pages.queue.push(
			() => new Promise((resolve) => (release = resolve)),
			() => ok({ items: [card('prd_new')], nextCursor: null, facets: FACETS }),
		);
		const fake = makeShop({ features: ['catalog'], routes: { 'GET /v1/shop/products': pages.route } });
		const host = await mountGrid(fake);
		await submit($(host, 'form'));
		release(ok({ items: [card('prd_old')], nextCursor: null, facets: FACETS }));
		await flush();
		expect(textOf(host)).toContain('Phone prd_new');
		expect(textOf(host)).not.toContain('Phone prd_old');
	});

	it('saves to the wishlist when signed in and toggles compare', async () => {
		let saved = [card('prd_a')];
		let refuse = false;
		const fake = makeShop({
			features: ['catalog', 'wishlist', 'compare'],
			routes: {
				'GET /v1/shop/products': () => ok({ items: [card('prd_a'), card('prd_b')], nextCursor: null, facets: FACETS }),
				'GET /v1/shop/wishlist': () => ok({ items: saved, max: 200 }),
				'POST /v1/shop/wishlist/items/prd_b': () => {
					if (refuse) return fail(422, 'validation_failed');
					saved = [...saved, card('prd_b')];
					return ok({ items: saved, max: 200 });
				},
				'DELETE /v1/shop/wishlist/items/prd_a': () => {
					saved = saved.filter((item) => item.id !== 'prd_a');
					return ok({ items: saved, max: 200 });
				},
			},
		});
		const host = await mountGrid(fake, {}, { compare: { max: 1 } });
		const wish = (/** @type {string} */ id) => $(host, `[data-wish="${id}"]`);
		const status = () => $(host, '[role="status"]').textContent;
		expect(wish('prd_a').getAttribute('aria-label')).toBe(text('grid.saveLabel', { name: 'Phone prd_a' }));
		await click(wish('prd_a'));
		expect(status()).toBe(text('wishlist.signIn'));
		expect(fake.all('GET /v1/shop/wishlist')).toHaveLength(0);

		fake.identify('sign-in-1');
		await flush();
		expect(wish('prd_a').getAttribute('aria-pressed')).toBe('true');
		expect(wish('prd_a').textContent).toBe(text('grid.saved'));
		expect(wish('prd_b').getAttribute('aria-pressed')).toBe('false');
		await click(wish('prd_b'));
		expect(status()).toBe(text('wishlist.added', { name: 'Phone prd_b' }));
		expect(wish('prd_b').getAttribute('aria-pressed')).toBe('true');
		await click(wish('prd_a'));
		expect(status()).toBe(text('wishlist.removed', { name: 'Phone prd_a' }));
		expect(wish('prd_a').getAttribute('aria-pressed')).toBe('false');
		saved = saved.filter((item) => item.id !== 'prd_b');
		fake.identify('sign-in-2');
		await flush();
		refuse = true;
		await click(wish('prd_b'));
		expect(status()).toBe(text('wishlist.failed'));

		const compare = (/** @type {string} */ id) => $(host, `[data-compare="${id}"]`);
		await click(compare('prd_a'));
		expect(compareIds(window)).toEqual(['prd_a']);
		expect(compare('prd_a').getAttribute('aria-pressed')).toBe('true');
		await click(compare('prd_b'));
		expect(status()).toBe(text('compare.full', { max: 1 }));
		await click(compare('prd_a'));
		expect(compareIds(window)).toEqual([]);
		expect(compare('prd_a').getAttribute('aria-pressed')).toBe('false');
	});
});

describe('the compare list in the browser', () => {
	it('keeps product ids in localStorage and announces changes', () => {
		/** @type {string[][]} */
		const heard = [];
		const stop = onCompareChange(window, (ids) => heard.push(ids));
		expect(toggleCompare(window, 'prd_1', 3)).toEqual({ ok: true, ids: ['prd_1'] });
		expect(toggleCompare(window, 'bad id', 3).ok).toBe(false);
		toggleCompare(window, 'prd_2', 3);
		expect(window.localStorage.getItem(STORAGE_KEYS.compare)).toBe('["prd_1","prd_2"]');
		removeCompare(window, 'prd_1');
		expect(compareIds(window)).toEqual(['prd_2']);
		window.dispatchEvent(new window.StorageEvent('storage', { key: STORAGE_KEYS.compare }));
		window.dispatchEvent(new window.StorageEvent('storage', { key: 'other' }));
		clearCompare(window);
		expect(heard).toEqual([['prd_1'], ['prd_1', 'prd_2'], ['prd_2'], ['prd_2'], []]);
		stop();
		toggleCompare(window, 'prd_3', 3);
		expect(heard).toHaveLength(5);
		window.localStorage.setItem(STORAGE_KEYS.compare, '{bad');
		expect(compareIds(window)).toEqual([]);
		window.localStorage.setItem(STORAGE_KEYS.compare, '["prd_1", 5, "x", "prd_1"]');
		expect(compareIds(window)).toEqual(['prd_1']);
		window.localStorage.setItem(STORAGE_KEYS.compare, '{"a":1}');
		expect(compareIds(window)).toEqual([]);
	});

	it('keeps the list in memory when the browser has no storage or it is full', () => {
		const events = new EventTarget();
		const base = {
			CustomEvent: window.CustomEvent,
			addEventListener: events.addEventListener.bind(events),
			removeEventListener: events.removeEventListener.bind(events),
			dispatchEvent: events.dispatchEvent.bind(events),
		};
		const blocked = /** @type {any} */ ({
			...base,
			get localStorage() {
				throw new Error('blocked');
			},
		});
		toggleCompare(blocked, 'prd_1', 4);
		expect(compareIds(blocked)).toEqual(['prd_1']);
		const none = /** @type {any} */ ({ ...base, localStorage: undefined });
		expect(compareIds(none)).toEqual([]);
		const full = /** @type {any} */ ({
			...base,
			localStorage: {
				getItem: () => null,
				setItem: () => {
					throw new Error('full');
				},
			},
		});
		expect(toggleCompare(full, 'prd_2', 4).ok).toBe(true);
	});
});

describe('shared helpers', () => {
	it('fills texts, reads settings with defaults and formats', () => {
		const config = configOf([], {});
		const t = textsOf(config);
		expect(t('grid.facetValue', { value: 'x', count: 2 })).toBe('x (2)');
		expect(t('no.such.key')).toBe('no.such.key');
		expect(problemText(config, 'cart.coupon.', 'coupon_expired', 'cart.problem.unavailable')).toBe(
			text('cart.coupon.coupon_expired'),
		);
		expect(problemText(config, 'cart.coupon.', 'nope', 'cart.problem.unavailable')).toBe(text('cart.problem.unavailable'));
		expect(problemText(config, 'cart.coupon.', '', 'cart.problem.unavailable')).toBe(text('cart.problem.unavailable'));
		const settings = settingsOf({ ...config, settings: /** @type {any} */ (undefined) });
		expect(settings.currency).toBe('');
		expect(settings.catalog.pageSize).toBe(24);
		expect(settings.checkout.address.required).toEqual(['name', 'phone', 'line1', 'city']);
		expect(settings.compare.max).toBe(4);
		const full = settingsOf(
			configOf([], {
				checkout: { paymentMethods: ['cod'], pickupLocations: [{ id: 'loc_1', name: 'Shop' }], delivery: { cities: ['A'] } },
			}),
		);
		expect(full.checkout.paymentMethods).toEqual(['cod']);
		expect(full.checkout.cities).toEqual(['A']);
		expect(currencyOf(settings, 'nope', 'USD')).toBe('USD');
		expect(currencyOf(full)).toBe('USD');
		expect(codeOf({ ok: false, status: 0, data: null })).toBe('offline');
		expect(codeOf({ ok: false, status: 500, data: null })).toBe('');
		expect(codeOf({ ok: false, status: 409, data: { type: 'https://x/problems/slot_taken' } })).toBe('slot_taken');
		// money and dates by the website's Format and business time zone (widget config) and the viewer (PLAN 0.8.10 K7)
		const viewer = { navigator: { language: 'en-US' } };
		const plain = formatsOf(config, viewer);
		expect(plain.dateText(null)).toBe('');
		expect(plain.dateText('not a date')).toBe('');
		expect(plain.money(250000, 'USD')).toBe('USD 2,500.00');
		expect(plain.money(undefined, 'USD')).toBe('USD 0.00');
		const business = formatsOf(
			{
				...config,
				format: { locale: 'fr-FR', currencyDisplay: 'custom', currencySymbol: '€', wholeUnits: true, times: 'business' },
				timeZone: 'Asia/Tokyo',
			},
			viewer,
		);
		expect(business.money(1250000, 'EUR')).toBe('12 500 €');
		expect(business.dateText('2026-03-12T20:00:00Z', { time: false })).toBe('13 mars 2026');
		expect(business.dateText('2026-03-12T20:00:00Z')).toBe('13 mars 2026, 05:00');
		expect(business.timeText('2026-03-12T20:00:00Z', 'UTC')).toBe('20:00');
		expect(business.dateText('2026-03-12T20:00:00Z', { time: false, zone: 'Nowhere/Never' })).toBe('12 mars 2026');
		expect(ratingText(t, null)).toBe('');
		expect(ratingText(t, { average: 0, count: 0 })).toBe('');
	});

	it('builds cards and keeps the focus across a re-render', async () => {
		const host = place('x');
		let root = /** @type {HTMLElement | null} */ (null);
		mountShop({
			host,
			config: configOf([]),
			name: 'test',
			render: (node) => {
				root = node;
			},
		});
		const box = /** @type {HTMLElement} */ (/** @type {unknown} */ (root));
		const doc = document;
		const t = textsOf(configOf([]));
		const formats = formatsOf(configOf([]), window);
		const node = productCard(doc, t, formats, { ...card('prd_x'), image: null, brand: 'Plain', grades: [], rating: undefined });
		expect(node.querySelector('img')).toBeNull();
		expect(node.textContent).toContain('Plain');
		const nobrand = productCard(doc, t, formats, { ...card('prd_y'), brand: null });
		expect(nobrand.querySelectorAll('.meta')).toHaveLength(2);
		const render = () =>
			fill(
				box,
				h(doc, 'button', { 'data-focus': 'one' }, 'One'),
				null,
				'',
				h(doc, 'button', { 'data-focus': 'bad key!' }, 'Two'),
			);
		render();
		/** @type {HTMLElement} */ (box.querySelector('[data-focus="one"]')).focus();
		keepFocus(box, render);
		expect(host.shadowRoot?.activeElement?.textContent).toBe('One');
		/** @type {HTMLElement} */ (box.querySelector('[data-focus="bad key!"]')).focus();
		keepFocus(box, render);
		expect(host.shadowRoot?.activeElement).toBeNull();
		expect(COMPARE_EVENT).toBe('ss-ecommerce:compare');
	});

	it('reads the catalog and checkout settings and words warranties', () => {
		const settings = settingsOf(
			configOf([], {
				catalog: {
					pageSize: 100,
					lowStockShown: 3,
					grades: [{ key: 'a', label: 'Like new' }, { key: 'b' }, { label: 'x' }, null],
				},
				checkout: { policyFormat: 'html' },
			}),
		);
		expect(settings.catalog).toEqual({
			pageSize: 60,
			lowStockShown: 3,
			grades: [
				{ key: 'a', label: 'Like new' },
				{ key: 'b', label: 'b' },
			],
		});
		expect(settings.checkout.policyFormat).toBe('html');
		expect(settingsOf(configOf([], { catalog: { grades: 'a' } })).catalog.grades).toEqual([]);
		expect(settingsOf(configOf([])).checkout.policyFormat).toBe('text');
		const t = textsOf(configOf([]));
		expect(warrantyText(t, null)).toBe('');
		expect(warrantyText(t, 0)).toBe('');
		expect(warrantyText(t, 1.5)).toBe('');
		expect(warrantyText(t, 60)).toBe(text('shop.warrantyMonths', { months: 2 }));
		expect(warrantyText(t, 7)).toBe(text('shop.warrantyDays', { days: 7 }));
	});

	it('reads sparse categories and facets, and keeps a chosen attribute the facets no longer know', () => {
		expect(flattenCategories(null)).toEqual([]);
		expect(flattenCategories([{ id: 'cat_1' }, { id: 'cat_2', slug: 'b' }])).toEqual([
			{ id: 'cat_1', slug: 'cat_1', name: 'cat_1', depth: 0, status: 'active' },
			{ id: 'cat_2', slug: 'b', name: 'b', depth: 0, status: 'active' },
		]);
		const known = emptyKnown();
		remember(known, null);
		remember(known, {
			attributes: [
				{ id: 'atr_1', name: 'Size', type: 'text' },
				{ id: 'atr_2', name: 'Fit', type: 'text', values: [{ value: 'slim' }] },
			],
		});
		expect(known.attributes.get('atr_1')?.unit).toBe('');
		expect([...(known.attributes.get('atr_2')?.values ?? [])]).toEqual([['slim', 'slim']]);
		const t = textsOf(configOf([]));
		/** @type {any[]} */
		const changes = [];
		const parts = filterControls({
			doc: document,
			t,
			filters: {
				q: '',
				category: '',
				brands: [],
				grades: [],
				attributes: new Map([['gone', ['x']]]),
				minPrice: '5',
				maxPrice: '',
				inStock: false,
				featured: false,
				deal: 'dl_9',
				sort: 'newest',
			},
			facets: { attributes: [{ id: 'atr_2', name: 'Fit', type: 'text' }] },
			known,
			currency: 'USD',
			expanded: new Set(),
			onChange: (event, patch) => changes.push([event, patch]),
		});
		const text = parts.map((part) => part.textContent).join('|');
		expect(text).toContain('gone');
		expect(text).toContain('slim');
		const deal = /** @type {HTMLSelectElement} */ (
			parts.find((part) => part.querySelector('#ss-grid-deal'))?.querySelector('select')
		);
		expect(deal.value).toBe('dl_9');
		const price = /** @type {HTMLInputElement} */ (
			parts.find((part) => part.querySelector('#ss-grid-min'))?.querySelector('#ss-grid-min')
		);
		expect(price.placeholder).toBe('');
		const gone = /** @type {HTMLInputElement} */ (
			parts.find((part) => part.textContent?.startsWith('gone'))?.querySelector('input')
		);
		gone.checked = false;
		gone.dispatchEvent(new window.Event('change'));
		expect(changes.at(-1)).toEqual(['load', { attributes: new Map([['gone', []]]) }]);
		expect(activeCount(/** @type {any} */ ({ ...clearedFilters(), q: '', sort: 'newest' }))).toBe(0);
	});

	it('shares one wishlist per shop and reads it again after a new sign-in', async () => {
		let reads = 0;
		const fake = makeShop({
			signIn: 'a',
			routes: {
				'GET /v1/shop/wishlist': () => {
					reads += 1;
					return reads === 1 ? fail(500, 'internal_error') : ok({ items: [{ id: 'prd_1' }] });
				},
			},
		});
		const saved = savedOf(fake.shop);
		expect(savedOf(fake.shop)).toBe(saved);
		expect([...(await saved.ids())]).toEqual([]);
		expect([...(await saved.ids())]).toEqual([]);
		fake.identify('b');
		expect([...(await saved.ids())]).toEqual(['prd_1']);
		fake.identify(null);
		expect([...(await saved.ids())]).toEqual([]);
		let heard = 0;
		const stop = saved.onChange(() => (heard += 1));
		stop();
		expect(heard).toBe(0);
	});
});
