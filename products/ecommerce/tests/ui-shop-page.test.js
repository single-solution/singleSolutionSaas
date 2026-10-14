// @vitest-environment jsdom
/* global window */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountProductPage } from '../ui/product-page.js';
import { axesOf, pickVariant } from '../ui/shop-page-parts.js';
import { compareIds } from '../ui/shop-compare-store.js';
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

/** @param {Record<string, unknown>} [over] */
const product = (over = {}) => ({
	id: 'prd_1',
	slug: 'phone',
	name: 'Phone One',
	kind: 'physical',
	summary: 'A good phone.',
	description: 'First part.\n\nSecond part.',
	price: 100000,
	compareAtPrice: null,
	currency: 'EUR',
	inStock: true,
	url: 'https://shop.example.com/products/phone',
	media: [
		{ url: 'https://cdn.example.com/1.png', alt: 'Front', type: 'image/png' },
		{ url: 'https://cdn.example.com/2.mp4', alt: 'Video', type: 'video/mp4' },
		{ url: null, alt: 'Gone', type: 'image/png' },
	],
	options: [
		{ name: 'Color', values: ['Red', 'Blue', 'Green'] },
		{ name: 'Storage', values: ['128 GB', '256 GB'] },
	],
	variants: [
		{
			id: 'var_r1',
			name: 'Red / 128 GB',
			options: { Color: 'Red', Storage: '128 GB' },
			price: 100000,
			compareAtPrice: 110000,
			inStock: false,
			grade: null,
		},
		{
			id: 'var_b1',
			name: 'Blue / 128 GB',
			options: { Color: 'Blue', Storage: '128 GB' },
			price: 105000,
			compareAtPrice: null,
			inStock: true,
			grade: { key: 'a', label: 'Like new', description: 'Hardly used' },
		},
		{
			id: 'var_b2',
			name: 'Blue / 256 GB',
			options: { Color: 'Blue', Storage: '256 GB' },
			price: 120000,
			compareAtPrice: null,
			inStock: true,
			grade: null,
		},
	],
	specs: [
		{ id: 'atr_1', name: 'Screen', value: 6.1, unit: 'in', comparable: true },
		{ id: 'atr_2', name: 'Dual SIM', value: true, unit: '', comparable: false },
		{ id: 'atr_3', name: 'eSIM', value: false, unit: '', comparable: false },
		{ id: 'atr_4', name: 'Chip', value: 'X1', unit: '', comparable: false },
	],
	brand: { id: 'brd_1', slug: 'acme', name: 'Acme' },
	breadcrumb: [],
	tags: [],
	rating: { average: 4, count: 3 },
	booking: null,
	seo: { title: '', description: '' },
	...over,
});

/**
 * @param {ReturnType<typeof makeShop>} fake
 * @param {string} ref
 * @param {Record<string, any>} [settings]
 */
const mountPage = async (fake, ref = 'phone', settings = {}) => {
	const host = place('product_page', ref ? { product: ref } : {});
	await mountProductPage({
		host,
		config: configOf(['catalog'], { currency: 'EUR', ...settings }),
		shop: fake.shop,
		win: window,
	});
	await flush();
	return host;
};

describe('product page', () => {
	it('shows the product, picks variants and adds to the cart', async () => {
		const fake = makeShop({
			features: ['catalog', 'checkout'],
			routes: { 'GET /v1/shop/products/phone': () => ok(product()) },
		});
		const host = await mountPage(fake);
		const page = textOf(host);
		expect(page).toContain('Phone One');
		expect(page).toContain('Acme');
		expect(page).toContain(text('shop.rating', { average: '4.0', count: 3 }));
		expect(page).toContain('A good phone.');
		expect(page).toContain('EUR 1,050.00');
		expect(page).toContain(text('page.grade', { grade: 'Like new' }));
		expect(page).toContain('Hardly used');
		expect(page).toContain(text('page.inStock'));
		expect(page).toContain('6.1 in');
		expect(page).toContain(text('shop.yes'));
		expect(page).toContain(text('shop.no'));
		expect(page).toContain('Second part.');
		// gallery: two shown images, video thumbnail as a number
		expect($(host, '.gallery .main img').getAttribute('alt')).toBe('Front');
		expect($$(host, '.thumbs button')).toHaveLength(2);
		await click(buttonOf(host, text('page.nextImage')));
		expect($(host, '.gallery .main video')).not.toBeNull();
		await click(buttonOf(host, text('page.prevImage')));
		expect($(host, '.gallery .main img')).not.toBeNull();
		await click(buttonOf(host, text('page.showImage', { n: 2, total: 2 })));
		expect($(host, '.thumbs button[aria-current="true"]').getAttribute('aria-label')).toBe(
			text('page.showImage', { n: 2, total: 2 }),
		);
		// variant picker: Green does not exist, Red / 256 GB does not exist, Red / 128 GB is out of stock
		const color = $(host, '#ss-page-option-0');
		expect([...color.options].find((/** @type {any} */ o) => o.value === 'Green').disabled).toBe(true);
		expect([...color.options].find((/** @type {any} */ o) => o.value === 'Red').textContent).toBe(
			text('page.optionOutOfStock', { value: 'Red' }),
		);
		await setValue($(host, '#ss-page-option-1'), '256 GB');
		expect(textOf(host)).toContain('EUR 1,200.00');
		// quantity stepper
		const qty = $(host, '#ss-page-qty');
		await click(buttonOf(host, text('page.more')));
		await click(buttonOf(host, text('page.more')));
		await click(buttonOf(host, text('page.less')));
		expect(qty.value).toBe('2');
		await setValue(qty, '500');
		expect(qty.value).toBe('99');
		await setValue(qty, 'x');
		expect(qty.value).toBe('1');
		await setValue(qty, '3');
		await click(buttonOf(host, text('page.addToCart')));
		expect(fake.cart.state().lines).toEqual([{ productId: 'prd_1', variantId: 'var_b2', quantity: 3 }]);
		expect(buttonOf(host, text('page.added'))).toBeTruthy();
		expect($(host, '.buy-status, [role="status"]')).toBeTruthy();
		expect(textOf(host)).toContain(text('page.addedStatus', { name: 'Phone One' }));
		// out of stock variant: Add to cart disabled; Red exists only with 128 GB, so picking Red moves there
		await setValue($(host, '#ss-page-option-0'), 'Red');
		expect($(host, '#ss-page-option-1').value).toBe('128 GB');
		expect(textOf(host)).toContain(text('page.outOfStock'));
		expect(buttonOf(host, text('page.addToCart')).disabled).toBe(true);
		// a combination that does not exist moves to the nearest variant with the value picked
		await setValue($(host, '#ss-page-option-1'), '256 GB');
		expect($(host, '#ss-page-option-0').value).toBe('Blue');
		expect(textOf(host)).toContain('EUR 1,200.00');
		expect(textOf(host)).not.toContain(text('page.noVariant'));
	});

	it('opens the variant whose own address the page was opened at (variantQuery, E13)', async () => {
		const base = product();
		/** @param {string} query */
		const at = (query) => `https://shop.example.com/products/phone${query}`;
		const page = {
			...base,
			variants: base.variants.map((v) => ({
				...v,
				url: at(v.id === 'var_b2' ? '?color=blue&storage=256-gb' : v.id === 'var_b1' ? '?color=blue' : '?color=red'),
			})),
		};
		const routes = { 'GET /v1/shop/products/phone': () => ok(page) };
		// a link from a feed or a search result names Blue / 256 GB: that variant shows, not the first one in stock
		const linked = makeShop({
			features: ['catalog', 'checkout'],
			routes,
			url: at('?storage=256-gb&color=blue&utm_source=feed'),
		});
		const host = await mountPage(linked);
		expect($(host, '#ss-page-option-0').value).toBe('Blue');
		expect($(host, '#ss-page-option-1').value).toBe('256 GB');
		expect(textOf(host)).toContain('EUR 1,200.00');
		await click(buttonOf(host, text('page.addToCart')));
		expect(linked.cart.state().lines).toEqual([{ productId: 'prd_1', variantId: 'var_b2', quantity: 1 }]);
		// the address naming the most of a variant wins; an out-of-stock variant is still the one shown
		resetPage();
		const red = await mountPage(makeShop({ features: ['catalog'], routes, url: at('?color=red') }));
		expect($(red, '#ss-page-option-0').value).toBe('Red');
		expect(textOf(red)).toContain(text('page.outOfStock'));
		// an address naming no variant opens the first one in stock
		resetPage();
		const plain = await mountPage(makeShop({ features: ['catalog'], routes, url: at('?color=green') }));
		expect($(plain, '#ss-page-option-0').value).toBe('Blue');
		expect($(plain, '#ss-page-option-1').value).toBe('128 GB');
	});

	it('shows the price after deals with the saving, as the page answer gives it (G4)', async () => {
		const base = product();
		const page = {
			...base,
			variants: base.variants.map((v) =>
				v.id === 'var_b1'
					? { ...v, price: 95000, compareAtPrice: 105000, deal: { id: 'dl_1', name: 'Autumn sale', savings: 10000 } }
					: { ...v, deal: null },
			),
		};
		const fake = makeShop({ features: ['catalog', 'deals'], routes: { 'GET /v1/shop/products/phone': () => ok(page) } });
		const host = await mountPage(fake);
		expect(textOf(host)).toContain('EUR 950.00');
		expect(textOf(host)).toContain('EUR 1,050.00');
		expect(textOf(host)).toContain(text('page.save', { amount: 'EUR 100.00' }));
		expect(textOf(host)).toContain('Autumn sale');
		await setValue($(host, '#ss-page-option-1'), '256 GB');
		expect(textOf(host)).not.toContain(text('page.save', { amount: 'EUR 100.00' }));
		expect(textOf(host)).not.toContain('Autumn sale');
		await setValue($(host, '#ss-page-option-0'), 'Red');
		expect(textOf(host)).toContain('EUR 1,000.00');
		expect(textOf(host)).toContain('EUR 1,100.00');
		// one read: the page answer has every variant's price
		expect(fake.all('GET /v1/shop/products/phone')).toHaveLength(1);
	});

	it('says when the product is missing or cannot be read', async () => {
		const missing = await mountPage(makeShop({ features: ['catalog'] }));
		expect(textOf(missing)).toContain(text('page.notFound'));
		const none = await mountPage(makeShop({ features: ['catalog'] }), '');
		expect(textOf(none)).toContain(text('page.notFound'));
		const broken = await mountPage(
			makeShop({ features: ['catalog'], routes: { 'GET /v1/shop/products/phone': () => fail(500, 'internal_error') } }),
		);
		expect(textOf(broken)).toContain(text('page.error'));
	});

	it('shows a digital item with no options, media or specs', async () => {
		const fake = makeShop({
			features: ['catalog', 'checkout'],
			routes: {
				'GET /v1/shop/products/phone': () =>
					ok(
						product({
							kind: 'digital',
							media: [{ url: 'https://cdn.example.com/1.png', alt: 'Only', type: 'image/png' }],
							options: [],
							variants: [
								{ id: 'var_1', name: '', options: {}, price: 5000, compareAtPrice: null, inStock: true, grade: null },
							],
							specs: [],
							description: '',
							summary: '',
							brand: null,
							rating: { average: 0, count: 0 },
						}),
					),
			},
		});
		const host = await mountPage(fake);
		expect(textOf(host)).toContain(text('page.digitalNote'));
		expect($$(host, '.thumbs')).toHaveLength(0);
		expect(textOf(host)).not.toContain(text('page.specs'));
		await click(buttonOf(host, text('page.addToCart')));
		expect(fake.cart.state().lines[0]?.variantId).toBe('var_1');

		resetPage();
		const empty = makeShop({
			features: ['catalog'],
			routes: { 'GET /v1/shop/products/phone': () => ok(product({ media: [], variants: [] })) },
		});
		const bare = await mountPage(empty);
		expect($(bare, '.gallery').children).toHaveLength(0);
		expect(textOf(bare)).toContain(text('page.noVariant'));
	});

	it('picks a booking slot before adding to the cart', async () => {
		let slotCalls = 0;
		const fake = makeShop({
			features: ['catalog', 'checkout', 'bookings'],
			routes: {
				'GET /v1/shop/products/phone': () =>
					ok(
						product({
							kind: 'service',
							options: [],
							variants: [
								{ id: 'var_1', name: '', options: {}, price: 5000, compareAtPrice: null, inStock: true, grade: null },
							],
							booking: { durationMinutes: 30 },
						}),
					),
				'GET /v1/shop/slots': () => {
					slotCalls += 1;
					if (slotCalls === 1)
						return ok({
							productId: 'prd_1',
							durationMinutes: 30,
							timeZone: 'Europe/Paris',
							slots: [
								{ start: '2026-10-09T05:00:00.000Z', end: '2026-10-09T05:30:00.000Z' },
								{ start: '2026-10-09T05:30:00.000Z', end: '2026-10-09T06:00:00.000Z' },
								{ start: '2026-10-10T05:00:00.000Z', end: '2026-10-10T05:30:00.000Z' },
							],
						});
					if (slotCalls === 2)
						return ok({
							productId: 'prd_1',
							durationMinutes: 30,
							timeZone: 'Bad/Zone',
							slots: [{ start: '2026-10-10T05:00:00.000Z', end: '2026-10-10T05:30:00.000Z' }],
						});
					if (slotCalls === 3) return fail(500, 'internal_error');
					return ok({
						productId: 'prd_1',
						durationMinutes: 30,
						timeZone: 'Bad/Zone',
						slots: [{ start: '2026-10-20T05:00:00.000Z', end: '2026-10-20T05:30:00.000Z' }],
					});
				},
			},
		});
		const host = await mountPage(fake);
		expect(textOf(host)).toContain(text('page.duration', { minutes: 30 }));
		expect($(host, '#ss-page-qty')).toBeNull();
		expect(buttonOf(host, text('page.addToCart')).disabled).toBe(true);
		expect(textOf(host)).toContain(text('page.chooseSlotFirst'));
		const picker = $(host, '#ss-page-slot');
		expect($$(host, '#ss-page-slot optgroup')).toHaveLength(2);
		expect(fake.calls.find((c) => c.path === '/v1/shop/slots')?.query.productId).toBe('prd_1');
		await click(buttonOf(host, text('page.laterSlots')));
		expect(textOf(host)).toContain(text('page.noMoreSlots'));
		await click(buttonOf(host, text('page.laterSlots')));
		expect(textOf(host)).toContain(text('page.slotsError'));
		await click(buttonOf(host, text('page.laterSlots')));
		expect($$(host, '#ss-page-slot optgroup')).toHaveLength(3);
		await setValue(picker, '2026-10-09T05:30:00.000Z');
		await click(buttonOf(host, text('page.addToCart')));
		expect(fake.cart.state().lines).toEqual([
			{ productId: 'prd_1', variantId: 'var_1', quantity: 1, slot: '2026-10-09T05:30:00.000Z' },
		]);
		await setValue(picker, '');
		expect(buttonOf(host, text('page.addToCart')).disabled).toBe(true);
	});

	it('says when no times are free', async () => {
		const fake = makeShop({
			features: ['catalog', 'checkout', 'bookings'],
			routes: {
				'GET /v1/shop/products/phone': () =>
					ok(
						product({
							kind: 'service',
							options: [],
							variants: [
								{ id: 'var_1', name: '', options: {}, price: 5000, compareAtPrice: null, inStock: true, grade: null },
							],
							booking: { durationMinutes: 30 },
						}),
					),
				'GET /v1/shop/slots': () => ok({ productId: 'prd_1', durationMinutes: 30, timeZone: '', slots: [] }),
			},
		});
		const host = await mountPage(fake);
		expect(textOf(host)).toContain(text('page.noSlots'));
	});

	it('lets a guest set an alert with a phone and a target price when the settings allow (EN-1)', async () => {
		let alertAnswer = ok({ id: 'alr_1' }, 201);
		const fake = makeShop({
			features: ['catalog', 'alerts'],
			routes: {
				'GET /v1/shop/products/phone': () => ok(product()),
				'POST /v1/shop/alerts': () => alertAnswer,
			},
		});
		const host = await mountPage(fake, 'phone', { alerts: { guests: true, targetPrice: true } });
		expect(textOf(host)).not.toContain(text('alerts.signIn'));
		await setValue($(host, '#ss-page-alert-phone'), '+44 7700 900123', 'input');
		await setValue($(host, '#ss-page-alert-target'), '999.5', 'input');
		await click(buttonOf(host, text('alerts.priceDrop')));
		expect(fake.last('POST /v1/shop/alerts')?.body).toEqual({
			kind: 'price_drop',
			productId: 'prd_1',
			variantId: 'var_b1',
			phone: '+44 7700 900123',
			targetPrice: 99950,
		});
		expect(textOf(host)).toContain(text('alerts.priceSet'));
		// what the guest typed stays when the variant changes; a bad price or phone is told
		await setValue($(host, '#ss-page-option-0'), 'Red');
		await flush();
		expect($(host, '#ss-page-alert-phone').value).toBe('+44 7700 900123');
		await setValue($(host, '#ss-page-alert-target'), 'cheap', 'input');
		await click(buttonOf(host, text('alerts.priceDrop')));
		expect(textOf(host)).toContain(text('alerts.targetInvalid'));
		expect(fake.all('POST /v1/shop/alerts')).toHaveLength(1);
		alertAnswer = fail(422, 'validation_failed');
		await click(buttonOf(host, text('alerts.backInStock')));
		expect(fake.last('POST /v1/shop/alerts')?.body).toEqual({
			kind: 'back_in_stock',
			productId: 'prd_1',
			variantId: 'var_r1',
			phone: '+44 7700 900123',
		});
		expect(textOf(host)).toContain(text('alerts.checkPhone'));
		// a guest without the setting is asked to sign in, and a price field shows only with targetPrice
		const plain = await mountPage(makeShop({ features: ['catalog', 'alerts'], routes: fake.routes }), 'phone');
		expect(textOf(plain)).toContain(text('alerts.signIn'));
		expect($(plain, '#ss-page-alert-target')).toBeNull();
	});

	it('sets alerts, saves to the wishlist and compares when signed in', async () => {
		let saved = /** @type {any[]} */ ([]);
		let alertAnswer = ok({ id: 'alr_1' }, 201);
		const fake = makeShop({
			features: ['catalog', 'alerts', 'wishlist', 'compare'],
			routes: {
				'GET /v1/shop/products/phone': () => ok(product()),
				'GET /v1/shop/wishlist': () => ok({ items: saved }),
				'POST /v1/shop/wishlist/items/prd_1': () => {
					saved = [{ id: 'prd_1' }];
					return ok({ items: saved });
				},
				'DELETE /v1/shop/wishlist/items/prd_1': () => fail(500, 'internal_error'),
				'POST /v1/shop/alerts': () => alertAnswer,
			},
		});
		const host = await mountPage(fake, 'phone', { compare: { max: 1 } });
		expect(textOf(host)).toContain(text('alerts.signIn'));
		await click(buttonOf(host, text('page.wishlistSave')));
		expect(textOf(host)).toContain(text('wishlist.signIn'));
		fake.identify('s1');
		await flush();
		expect(textOf(host)).not.toContain(text('alerts.signIn'));
		// the chosen variant is in stock: only the price-drop alert
		expect(() => buttonOf(host, text('alerts.backInStock'))).toThrow();
		await click(buttonOf(host, text('alerts.priceDrop')));
		expect(fake.last('POST /v1/shop/alerts')?.body).toEqual({ kind: 'price_drop', productId: 'prd_1', variantId: 'var_b1' });
		expect(fake.last('POST /v1/shop/alerts')?.key).toBe('key-1');
		expect(textOf(host)).toContain(text('alerts.priceSet'));
		await setValue($(host, '#ss-page-option-0'), 'Red');
		await flush();
		alertAnswer = fail(422, 'validation_failed');
		await click(buttonOf(host, text('alerts.backInStock')));
		expect(textOf(host)).toContain(text('alerts.problem.validation_failed'));
		alertAnswer = fail(500, 'internal_error');
		await click(buttonOf(host, text('alerts.backInStock')));
		expect(textOf(host)).toContain(text('alerts.failed'));
		alertAnswer = ok({ id: 'alr_2' }, 201);
		await click(buttonOf(host, text('alerts.backInStock')));
		expect(textOf(host)).toContain(text('alerts.stockSet'));
		await click(buttonOf(host, text('page.wishlistSave')));
		await flush();
		expect(textOf(host)).toContain(text('wishlist.added', { name: 'Phone One' }));
		expect(buttonOf(host, text('page.wishlistSaved')).getAttribute('aria-pressed')).toBe('true');
		await click(buttonOf(host, text('page.wishlistSaved')));
		expect(textOf(host)).toContain(text('wishlist.failed'));
		await click(buttonOf(host, text('page.compare')));
		await flush();
		expect(compareIds(window)).toEqual(['prd_1']);
		expect(buttonOf(host, text('page.compare')).getAttribute('aria-pressed')).toBe('true');
		window.localStorage.setItem('ss-ecommerce-compare', '["prd_9"]');
		await click(buttonOf(host, text('page.compare')));
		expect(textOf(host)).toContain(text('compare.full', { max: 1 }));
	});

	it('finds the variant of chosen options', () => {
		const item = /** @type {any} */ (product());
		const axes = axesOf(item);
		expect(pickVariant(axes, item.variants, { Color: 'Blue', Storage: '256 GB' })?.id).toBe('var_b2');
		expect(pickVariant(axes, item.variants, { Color: 'Green', Storage: '256 GB' })).toBeNull();
	});
});

describe('reviews block', () => {
	const review = (/** @type {string} */ id, over = {}) => ({
		id,
		name: 'Ana',
		rating: 5,
		title: 'Great',
		body: 'Loved it',
		reply: '',
		createdAt: '2026-10-01T10:00:00.000Z',
		...over,
	});

	it('lists reviews with the summary, loads more and lets a signed-in shopper write one', async () => {
		let page = 0;
		/** @type {any} */
		let post = ok({ id: 'rev_9', status: 'pending' }, 201);
		const fake = makeShop({
			features: ['catalog', 'reviews'],
			routes: {
				'GET /v1/shop/products/phone': () => ok(product()),
				'GET /v1/shop/products/prd_1/reviews': (call) => {
					page += 1;
					const summary = { average: 4.5, count: 3, stars: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 2 } };
					if (call.query.cursor === 'r2')
						return ok({
							items: [review('rev_3', { name: '', title: '', body: '' })],
							nextCursor: null,
							hasMore: false,
							summary,
						});
					return ok({
						items: [review('rev_1', { reply: 'Thanks!' }), review('rev_2')],
						nextCursor: page === 1 ? 'r2' : null,
						hasMore: page === 1,
						summary,
					});
				},
				'POST /v1/shop/reviews': () => post,
			},
		});
		const host = await mountPage(fake);
		expect(textOf(host)).toContain(text('reviews.summary', { average: '4.5', count: 3 }));
		expect(textOf(host)).toContain(text('reviews.starCount', { rating: '5', count: 2 }));
		expect(textOf(host)).toContain('Thanks!');
		expect(textOf(host)).toContain(text('reviews.signIn'));
		await click(buttonOf(host, text('reviews.more')));
		expect($$(host, 'li.review')).toHaveLength(3);
		expect(textOf(host)).toContain(text('reviews.anonymous'));
		expect(buttonOf(host, text('reviews.more')).hidden).toBe(true);

		fake.identify('s1');
		await flush();
		const form = () => $(host, 'form.box');
		$(host, '#ss-review-rating').value = '4';
		$(host, '#ss-review-title').value = ' Nice ';
		$(host, '#ss-review-body').value = 'Works';
		await submit(form());
		expect(fake.last('POST /v1/shop/reviews')?.body).toEqual({ productId: 'prd_1', rating: 4, title: 'Nice', body: 'Works' });
		expect(textOf(host)).toContain(text('reviews.pending'));

		fake.identify('s2');
		await flush();
		post = ok({ id: 'rev_10', status: 'approved' }, 201);
		await submit(form());
		expect(textOf(host)).toContain(text('reviews.thanks'));

		fake.identify('s3');
		await flush();
		post = fail(500, 'internal_error');
		await submit(form());
		expect(textOf(host)).toContain(text('reviews.failed'));
		post = fail(403, 'review_not_allowed');
		await submit(form());
		expect(textOf(host)).toContain(text('reviews.problem.review_not_allowed'));
		expect(form()).toBeNull();
		fake.identify('s4');
		await flush();
		post = fail(409, 'already_reviewed');
		await submit(form());
		expect(textOf(host)).toContain(text('reviews.problem.already_reviewed'));
	});

	it('shows no reviews and errors', async () => {
		const fake = makeShop({
			features: ['catalog', 'reviews'],
			routes: {
				'GET /v1/shop/products/phone': () => ok(product()),
				'GET /v1/shop/products/prd_1/reviews': () =>
					ok({ items: [], nextCursor: null, hasMore: false, summary: { average: 0, count: 0, stars: {} } }),
			},
		});
		const host = await mountPage(fake);
		expect(textOf(host)).toContain(text('reviews.none'));
		resetPage();
		const broken = await mountPage(
			makeShop({ features: ['catalog', 'reviews'], routes: { 'GET /v1/shop/products/phone': () => ok(product()) } }),
		);
		expect(textOf(broken)).toContain(text('reviews.error'));
	});
});
