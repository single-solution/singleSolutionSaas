// @vitest-environment jsdom
/* global document, window */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STORAGE_KEYS } from '../core/widgets.js';
import { mountProductGrid } from '../ui/product-grid.js';
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
} from '../ui/shop-common.js';
import {
	COMPARE_EVENT,
	clearCompare,
	compareIds,
	onCompareChange,
	removeCompare,
	toggleCompare,
} from '../ui/shop-compare-store.js';
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
	currency: 'PKR',
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
			name: 'Storage',
			unit: 'GB',
			type: 'number',
			values: [
				{ value: 128, count: 2 },
				{ value: 256, count: 1 },
			],
		},
		{ id: 'atr_2', name: 'Fast charging', unit: '', type: 'boolean', values: [{ value: true, count: 1 }] },
		{ id: 'atr_3', name: 'Colour', unit: '', type: 'choice', values: [{ value: 'Red', count: 1 }] },
	],
	grades: [{ key: 'a', label: 'Like new', count: 2 }],
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
			return next ? next(call) : ok({ items: [], next: null, facets: null });
		},
	};
};

describe('product grid', () => {
	it('lists products from the data attributes and loads more with the cursor', async () => {
		const pages = listing();
		pages.queue.push(
			() =>
				ok({
					items: [card('prd_a'), card('prd_b', { inStock: false, image: null, rating: { average: 0, count: 0 } })],
					next: 'c1',
					facets: FACETS,
				}),
			() => ok({ items: [card('prd_c', { compareAtPrice: null, grades: [] })], next: null, facets: null }),
		);
		const fake = makeShop({ features: ['catalog'], routes: { 'GET /v1/shop/products': pages.route } });
		const host = await mountGrid(fake, { category: 'phones', query: 'pixel', limit: '2' });
		expect(host.getAttribute('data-ss-mounted')).toBe('product-grid');
		expect(fake.calls[0]?.query).toEqual({ q: 'pixel', category: 'phones', sort: 'newest', limit: '2' });
		const page = textOf(host);
		expect(page).toContain('Phone prd_a');
		expect(page).toContain('PKR 1,000.00');
		expect(page).toContain('PKR 1,200.00');
		expect(page).toContain(text('shop.rating', { average: '4.5', count: 2 }));
		expect(page).toContain(text('shop.outOfStock'));
		expect(page).toContain('Like new');
		expect($(host, 'a.name').getAttribute('href')).toBe('https://shop.example.com/products/prd_a');
		expect($$(host, 'li.card')).toHaveLength(2);
		// no wishlist or compare toggles while those features are off
		expect($$(host, '[data-wish], [data-compare]')).toHaveLength(0);
		await click(buttonOf(host, text('grid.more')));
		expect(fake.calls[1]?.query.cursor).toBe('c1');
		expect($$(host, 'li.card')).toHaveLength(3);
		expect(buttonOf(host, text('grid.more')).hidden).toBe(true);
	});

	it('filters by facets, price, stock, attributes and grade, sorts and searches', async () => {
		/** @type {any[]} */
		const asked = [];
		const fake = makeShop({
			features: ['catalog'],
			routes: {
				'GET /v1/shop/products': (call) => {
					asked.push(call.query);
					return ok({ items: [card('prd_a')], next: null, facets: FACETS });
				},
			},
		});
		const host = await mountGrid(fake, {}, { catalog: { pageSize: 12 } });
		expect(asked[0]).toEqual({ sort: 'newest', limit: '12' });
		const selects = () => $$(host, 'details select');
		await setValue(selects()[0], 'phones');
		expect(asked.at(-1).category).toBe('phones');
		await setValue(selects()[1], 'acme');
		expect(asked.at(-1).brand).toBe('acme');
		expect($(host, 'details').hasAttribute('open')).toBe(true);
		const prices = $$(host, 'details input[inputmode="decimal"]');
		expect(prices[0].placeholder).toBe('500.00');
		await setValue(prices[0], '500');
		expect(asked.at(-1).minPrice).toBe('50000');
		const count = asked.length;
		await setValue($$(host, 'details input[inputmode="decimal"]')[1], 'abc');
		expect(asked).toHaveLength(count);
		expect($(host, '[role="status"]').textContent).toBe(text('grid.priceInvalid'));
		await submit($(host, 'form'));
		expect(asked).toHaveLength(count);
		await setValue($$(host, 'details input[inputmode="decimal"]')[1], '1500.5');
		expect(asked.at(-1).maxPrice).toBe('150050');
		const boxes = () => $$(host, 'details input[type="checkbox"]');
		await setValue(boxes()[0], true);
		expect(asked.at(-1).inStock).toBe('true');
		await setValue(boxes()[1], true);
		expect(asked.at(-1)['attr.atr_1']).toBe('128');
		await setValue(boxes()[2], true);
		expect(asked.at(-1)['attr.atr_1']).toBe('128,256');
		await setValue(boxes()[1], false);
		expect(asked.at(-1)['attr.atr_1']).toBe('256');
		expect(textOf(host)).toContain(text('grid.facetValue', { value: text('shop.yes'), count: 1 }));
		expect(textOf(host)).toContain(text('grid.facetValue', { value: '128 GB', count: 2 }));
		expect(textOf(host)).toContain(text('grid.facetValue', { value: 'Red', count: 1 }));
		await setValue(selects()[2], 'a');
		expect(asked.at(-1).grade).toBe('a');
		await setValue($(host, '#ss-grid-sort'), 'price_asc');
		expect(asked.at(-1).sort).toBe('price_asc');
		$(host, 'input[type="search"]').value = ' phone ';
		await submit($(host, 'form'));
		expect(asked.at(-1).q).toBe('phone');
		await click(buttonOf(host, text('grid.clearFilters')));
		expect(asked.at(-1)).toEqual({ q: 'phone', sort: 'price_asc', limit: '12' });
		expect($(host, 'details').hasAttribute('open')).toBe(false);
	});

	it('keeps a chosen category or brand the facets no longer list, and shows no filters without facets', async () => {
		const pages = listing();
		pages.queue.push(() =>
			ok({
				items: [card('prd_a')],
				next: null,
				facets: { ...FACETS, categories: [], brands: [], price: null, attributes: [], grades: [] },
			}),
		);
		const fake = makeShop({ features: ['catalog'], routes: { 'GET /v1/shop/products': pages.route } });
		const host = await mountGrid(fake, { category: 'cat_9', brand: 'brd_9' });
		const selects = $$(host, 'details select');
		expect(selects[0].value).toBe('cat_9');
		expect(selects[1].value).toBe('brd_9');
		expect($$(host, 'details input[inputmode="decimal"]')).toHaveLength(0);

		resetPage();
		const empty = makeShop({
			features: ['catalog'],
			routes: { 'GET /v1/shop/products': () => ok({ items: [card('prd_a')], next: null, facets: null }) },
		});
		const bare = await mountGrid(empty);
		expect($(bare, 'details')).toBeNull();
	});

	it('shows the empty and error states', async () => {
		const pages = listing();
		pages.queue.push(
			() => ok({ items: [], next: null, facets: FACETS }),
			() => fail(500, 'internal_error'),
			() => fail(422, 'validation_failed'),
			() => ok({ items: [card('prd_a')], next: 'c1', facets: FACETS }),
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
			() => ok({ items: [card('prd_new')], next: null, facets: FACETS }),
		);
		const fake = makeShop({ features: ['catalog'], routes: { 'GET /v1/shop/products': pages.route } });
		const host = await mountGrid(fake);
		await submit($(host, 'form'));
		release(ok({ items: [card('prd_old')], next: null, facets: FACETS }));
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
				'GET /v1/shop/products': () => ok({ items: [card('prd_a'), card('prd_b')], next: null, facets: FACETS }),
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
		expect(currencyOf(full)).toBe('PKR');
		expect(codeOf({ ok: false, status: 0, data: null })).toBe('offline');
		expect(codeOf({ ok: false, status: 500, data: null })).toBe('');
		expect(codeOf({ ok: false, status: 409, data: { type: 'https://x/problems/slot_taken' } })).toBe('slot_taken');
		// money and dates by the website's Format and business time zone (widget config) and the viewer (PLAN 0.8.10 K7)
		const viewer = { navigator: { language: 'en-US' } };
		const plain = formatsOf(config, viewer);
		expect(plain.dateText(null)).toBe('');
		expect(plain.dateText('not a date')).toBe('');
		expect(plain.money(250000, 'PKR')).toBe('PKR 2,500.00');
		expect(plain.money(undefined, 'PKR')).toBe('PKR 0.00');
		const business = formatsOf(
			{
				...config,
				format: { locale: 'en-GB', currencyDisplay: 'custom', currencySymbol: 'Rs', wholeUnits: true, times: 'business' },
				timeZone: 'Asia/Karachi',
			},
			viewer,
		);
		expect(business.money(1250000, 'PKR')).toBe('Rs 12,500');
		expect(business.dateText('2026-03-12T20:00:00Z', { time: false })).toBe('13 Mar 2026');
		expect(business.dateText('2026-03-12T20:00:00Z')).toBe('13 Mar 2026, 01:00');
		expect(business.timeText('2026-03-12T20:00:00Z', 'UTC')).toBe('20:00');
		expect(business.dateText('2026-03-12T20:00:00Z', { time: false, zone: 'Nowhere/Never' })).toBe('12 Mar 2026');
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
