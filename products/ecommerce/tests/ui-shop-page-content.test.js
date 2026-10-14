// @vitest-environment jsdom
/* global document, window */
/**
 * The product page's catalog content (PLAN 0.8.10 E3–E13): moved slugs, the rich description, the video, the FAQs,
 * the Size guide, photos with sizes and placeholders, variant photos, grades, stock, warranty, attribute and condition
 * pickers, and the shopper's own alerts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountProductPage } from '../ui/product-page.js';
import { richText, safeHref } from '../ui/shop-common.js';
import {
	GRADE_AXIS,
	alertsOf,
	axesOf,
	convertCell,
	gradeVideoUrl,
	nearestVariant,
	photoOf,
	pickVariant,
	stockText,
} from '../ui/shop-page-parts.js';
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
	text,
	textOf,
} from './ui-shop-helpers.js';

beforeEach(resetPage);
afterEach(resetPage);

const BLUR = 'data:image/webp;base64,UklGRhYAAABXRUJQ';

/** @param {Record<string, unknown>} [over] */
const grade = (over = {}) => ({
	key: 'a',
	label: 'Like new',
	description: 'Hardly used',
	color: '#16a34a',
	video: 'dQw4w9WgXcQ',
	videoUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
	content: {
		summary: 'Checked in 40 points.',
		bullets: [
			{ text: 'New battery', icon: 'battery' },
			{ text: 'Boxed', icon: '' },
		],
	},
	condition: 'refurbished',
	warrantyDays: 180,
	returnDays: 14,
	...over,
});

/** @param {Record<string, unknown>} [over] */
const variant = (over = {}) => ({
	id: 'var_1',
	name: 'Black',
	options: { Color: 'Black' },
	attributes: [],
	price: 100000,
	compareAtPrice: null,
	inStock: true,
	soldOut: false,
	stockLeft: null,
	grade: null,
	warrantyDays: null,
	media: [],
	url: 'https://shop.example.com/products/phone',
	...over,
});

/** @param {Record<string, unknown>} [over] */
const product = (over = {}) => ({
	id: 'prd_1',
	slug: 'phone',
	name: 'Phone One',
	kind: 'physical',
	summary: '',
	description: 'Plain words.',
	descriptionHtml: '',
	price: 100000,
	priceMax: 100000,
	compareAtPrice: null,
	currency: 'USD',
	inStock: true,
	featured: false,
	url: 'https://shop.example.com/products/phone',
	media: [],
	video: null,
	options: [{ name: 'Color', values: ['Black'] }],
	variants: [variant()],
	specs: [],
	brand: null,
	breadcrumb: [],
	tags: [],
	rating: { average: 0, count: 0 },
	booking: null,
	sizeChart: null,
	faqs: [],
	seo: { title: '', description: '' },
	...over,
});

/**
 * @param {ReturnType<typeof makeShop>} fake
 * @param {string} [ref]
 * @param {Record<string, any>} [settings]
 */
const mountPage = async (fake, ref = 'phone', settings = {}) => {
	const host = place('product_page', { product: ref });
	await mountProductPage({ host, config: configOf(['catalog'], settings), shop: fake.shop, win: window });
	await flush();
	return host;
};

describe('product page content', () => {
	it('follows a moved slug and builds the rich description from the allowed tags only', async () => {
		const html = [
			'<h3>Why</h3><p>It is <b>fast</b> and <i>light</i> <span>really</span>.<br>New line<!-- note --></p>',
			'<script>window.hacked = true</script><style>p { color: red }</style>',
			'<ul><li>One</li><li><u>Two</u></li></ul><ol><li>Three</li></ol><blockquote>Quote</blockquote><h4>Small</h4>',
			'<p><a href="javascript:alert(1)">bad</a> <a href="https://example.com/x">good</a> <a href="/care">care</a>',
			' <a href="//evil.example">evil</a> <a href="/\\evil.example">evil2</a> <a href="https://u:p@example.com">creds</a>',
			' <a>none</a><img src="x" onerror="window.hacked = true"></p><em onclick="x()">em</em><strong>strong</strong>',
		].join('');
		const fake = makeShop({
			features: ['catalog'],
			routes: {
				'GET /v1/shop/products/Old-Phone': () =>
					ok({ moved: { kind: 'product', slug: 'older-phone', url: 'https://shop.example.com/x' } }),
				'GET /v1/shop/products/older-phone': () =>
					ok({ moved: { slug: 'phone', url: 'https://shop.example.com/products/phone' } }),
				'GET /v1/shop/products/phone': () =>
					ok(
						product({
							descriptionHtml: html,
							featured: true,
							priceMax: 150000,
							variants: [variant(), variant({ id: 'var_2', options: { Color: 'Gold' }, price: 150000 })],
							options: [{ name: 'Color', values: ['Black', 'Gold'] }],
							faqs: [
								{ question: 'Does it ship abroad?', answer: 'Yes.\n\nTo most countries.' },
								{ question: '', answer: 'Skipped' },
							],
						}),
					),
			},
		});
		const host = await mountPage(fake, 'Old-Phone');
		expect(fake.calls.map((call) => call.path)).toEqual([
			'/v1/shop/products/Old-Phone',
			'/v1/shop/products/older-phone',
			'/v1/shop/products/phone',
		]);
		const description = $(host, 'section.description');
		expect(description.querySelector('h2').textContent).toBe(text('page.description'));
		expect(description.querySelector('script, style, img, span, b, i')).toBeNull();
		expect(description.querySelector('h3').textContent).toBe('Why');
		expect(description.querySelector('strong').textContent).toBe('fast');
		expect(description.querySelector('em').textContent).toBe('light');
		expect(description.querySelector('em').getAttribute('onclick')).toBeNull();
		expect(description.textContent).toContain('really');
		expect(description.textContent).not.toContain('hacked');
		expect(description.textContent).not.toContain('Plain words.');
		expect(description.querySelectorAll('br')).toHaveLength(1);
		expect(description.querySelectorAll('ul li, ol li')).toHaveLength(3);
		expect(description.querySelector('u').textContent).toBe('Two');
		expect(description.querySelector('blockquote').textContent).toBe('Quote');
		expect(description.querySelector('h4').textContent).toBe('Small');
		const links = [...description.querySelectorAll('a')].map((a) => [
			a.textContent,
			a.getAttribute('href'),
			a.getAttribute('rel'),
		]);
		expect(links).toEqual([
			['bad', null, null],
			['good', 'https://example.com/x', 'noopener'],
			['care', '/care', null],
			['evil', null, null],
			['evil2', null, null],
			['creds', null, null],
			['none', null, null],
		]);
		expect(/** @type {any} */ (window).hacked).toBeUndefined();
		// Featured, the price range, the FAQs
		expect($(host, '.badge.accent').textContent).toBe(text('shop.featured'));
		expect(textOf(host)).toContain(text('shop.priceRange', { min: 'USD 1,000.00', max: 'USD 1,500.00' }));
		const faqs = $(host, 'section.faqs');
		expect(faqs.querySelectorAll('details')).toHaveLength(1);
		expect(faqs.querySelector('summary').textContent).toBe('Does it ship abroad?');
		expect(faqs.querySelectorAll('p')).toHaveLength(2);
	});

	it('gives up on a slug that moves in a circle, and links to where a retired product went', async () => {
		const circle = await mountPage(
			makeShop({
				features: ['catalog'],
				routes: { 'GET /v1/shop/products/phone': () => ok({ moved: { slug: 'phone', url: '' } }) },
			}),
		);
		expect(textOf(circle)).toBe(text('page.notFound'));
		resetPage();
		let hops = 0;
		const endless = makeShop({
			features: ['catalog'],
			routes: {
				'GET /v1/shop/products/phone': () => {
					hops += 1;
					return ok({ moved: { slug: 'phone-2', url: '' } });
				},
				'GET /v1/shop/products/phone-2': () => {
					hops += 1;
					return ok({ moved: { slug: 'phone', url: '' } });
				},
			},
		});
		const looping = await mountPage(endless);
		expect(hops).toBe(4);
		expect(textOf(looping)).toBe(text('page.notFound'));
		resetPage();
		// a retired product leads to its category: not read again, a link there instead
		const toCategory = makeShop({
			features: ['catalog'],
			routes: {
				'GET /v1/shop/products/phone': () =>
					ok({ moved: { kind: 'category', slug: 'phones', url: 'https://shop.example.com/c/phones' } }),
			},
		});
		const retired = await mountPage(toCategory);
		expect(toCategory.calls).toHaveLength(1);
		expect(textOf(retired)).toContain(text('page.notFound'));
		expect($(retired, '[role="status"] a').getAttribute('href')).toBe('https://shop.example.com/c/phones');
		expect($(retired, '[role="status"] a').textContent).toBe(text('page.movedLink'));
		resetPage();
		const unlinked = await mountPage(
			makeShop({
				features: ['catalog'],
				routes: { 'GET /v1/shop/products/phone': () => ok({ moved: { kind: 'category', slug: 'phones', url: null } }) },
			}),
		);
		expect(textOf(unlinked)).toBe(text('page.notFound'));
		expect($(unlinked, '[role="status"] a')).toBeNull();
	});

	it('plays a video file, a YouTube video in its frame, and links any other address', async () => {
		/** @type {any} */
		let video = { kind: 'file', url: 'https://cdn.example.com/v.mp4', type: 'video/mp4' };
		const fake = makeShop({ features: ['catalog'], routes: { 'GET /v1/shop/products/phone': () => ok(product({ video })) } });
		const file = await mountPage(fake);
		expect($(file, '.player video source').getAttribute('src')).toBe('https://cdn.example.com/v.mp4');
		expect($(file, '.player video source').getAttribute('type')).toBe('video/mp4');
		expect($(file, '.player video').hasAttribute('controls')).toBe(true);
		resetPage();
		video = { kind: 'file', url: 'https://cdn.example.com/v.webm' };
		expect($(await mountPage(fake), '.player video source').hasAttribute('type')).toBe(false);
		resetPage();
		video = { kind: 'youtube', id: 'dQw4w9WgXcQ', url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' };
		const youtube = await mountPage(fake);
		const frame = $(youtube, '.player iframe');
		expect(frame.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
		expect(frame.getAttribute('title')).toBe(text('page.videoTitle', { name: 'Phone One' }));
		expect(frame.getAttribute('loading')).toBe('lazy');
		resetPage();
		video = { kind: 'url', url: 'https://videos.example.com/1' };
		const link = await mountPage(fake);
		expect($(link, 'section[aria-label] a[target="_blank"]').textContent).toBe(text('page.videoLink'));
		resetPage();
		video = { kind: 'url', url: 'http://videos.example.com/1' };
		expect(textOf(await mountPage(fake))).not.toContain(text('page.video'));
	});

	it('shows photos at their sizes with the blur placeholder, and a variant’s own photos while it is picked', async () => {
		const photo = (/** @type {string} */ name, over = {}) => ({
			url: `https://cdn.example.com/${name}.png`,
			alt: name,
			type: 'image/png',
			width: 1200,
			height: 900,
			blur: BLUR,
			sizes: { thumb: `https://cdn.example.com/${name}-t.webp`, detail: `https://cdn.example.com/${name}-d.webp` },
			...over,
		});
		const fake = makeShop({
			features: ['catalog'],
			routes: {
				'GET /v1/shop/products/phone': () =>
					ok(
						product({
							media: [photo('front'), photo('back', { sizes: undefined, blur: 'javascript:x', width: undefined })],
							options: [{ name: 'Color', values: ['Black', 'Gold'] }],
							variants: [
								variant(),
								variant({ id: 'var_2', options: { Color: 'Gold' }, media: [photo('gold'), { url: null, alt: 'Gone' }] }),
							],
						}),
					),
			},
		});
		const host = await mountPage(fake);
		const main = () => $(host, '.gallery .main img');
		expect(main().getAttribute('src')).toBe('https://cdn.example.com/front-d.webp');
		expect(main().getAttribute('width')).toBe('1200');
		expect(main().getAttribute('height')).toBe('900');
		expect(main().classList.contains('blur')).toBe(true);
		expect(main().style.backgroundImage).toContain(BLUR);
		main().dispatchEvent(new window.Event('load'));
		expect(main().classList.contains('blur')).toBe(false);
		expect(main().style.backgroundImage).toBe('');
		expect($$(host, '.thumbs img').map((img) => img.getAttribute('src'))).toEqual([
			'https://cdn.example.com/front-t.webp',
			'https://cdn.example.com/back.png',
		]);
		await click(buttonOf(host, text('page.nextImage')));
		expect(main().getAttribute('src')).toBe('https://cdn.example.com/back.png');
		expect(main().classList.contains('blur')).toBe(false);
		expect(main().hasAttribute('width')).toBe(false);
		// the gold variant's own photo replaces the gallery, from its first photo
		await setValue($(host, '#ss-page-option-0'), 'Gold');
		expect(main().getAttribute('src')).toBe('https://cdn.example.com/gold-d.webp');
		expect($$(host, '.thumbs')).toHaveLength(0);
		await setValue($(host, '#ss-page-option-0'), 'Black');
		expect(main().getAttribute('src')).toBe('https://cdn.example.com/front-d.webp');
	});

	it('picks the condition when variants differ only by grade, with its details, stock and warranty', async () => {
		const fake = makeShop({
			features: ['catalog', 'checkout'],
			routes: {
				'GET /v1/shop/products/phone': () =>
					ok(
						product({
							options: [{ name: 'Color', values: ['Black'] }],
							variants: [
								variant({ grade: grade(), stockLeft: 3, warrantyDays: 180 }),
								variant({
									id: 'var_2',
									price: 80000,
									grade: grade({
										key: 'b',
										label: 'Good',
										color: '',
										video: 'grades/b.mp4',
										videoUrl: 'https://cdn.example.com/grades/b.mp4',
										content: undefined,
										returnDays: null,
									}),
									stockLeft: 40,
									warrantyDays: 45,
								}),
								variant({ id: 'var_3', price: 70000, grade: null, soldOut: true, inStock: false }),
								variant({
									id: 'var_4',
									price: 60000,
									options: { Color: 'Black' },
									grade: grade({ key: 'c', label: 'Fair', video: '', videoUrl: null }),
									inStock: false,
								}),
							],
						}),
					),
			},
		});
		const host = await mountPage(fake, 'phone', { catalog: { lowStockShown: 5 } });
		const condition = $(host, '#ss-page-option-1');
		expect(condition.closest('.field').querySelector('label').textContent).toBe(text('page.condition'));
		expect([...condition.options].map((/** @type {any} */ o) => o.textContent)).toEqual([
			'Like new',
			'Good',
			text('page.optionSoldOut', { value: text('page.gradeNone') }),
			text('page.optionOutOfStock', { value: 'Fair' }),
		]);
		// Like new: its color, content, return days and condition video; only 3 left; 6 months of warranty
		const details = $(host, '.grade');
		expect(details.querySelector('.swatch').style.backgroundColor).toBe('rgb(22, 163, 74)');
		expect(details.textContent).toContain(text('page.grade', { grade: 'Like new' }));
		expect(details.textContent).toContain('Hardly used');
		expect(details.textContent).toContain('Checked in 40 points.');
		expect([...details.querySelectorAll('.bullets li')].map((li) => li.getAttribute('data-icon'))).toEqual(['battery', null]);
		expect(details.textContent).toContain(text('page.returnDays', { days: 14 }));
		expect(details.querySelector('a').getAttribute('href')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
		expect($(host, '.stock').textContent).toBe(text('page.onlyLeft', { count: 3 }));
		expect($(host, '.stock').classList.contains('warning')).toBe(true);
		expect(textOf(host)).toContain(text('shop.warrantyMonths', { months: 6 }));
		// Good: plenty in stock, no swatch, its video file linked by the address the answer gives
		await setValue(condition, 'b');
		expect($(host, '.stock').textContent).toBe(text('page.inStockCount', { count: 40 }));
		expect($(host, '.grade .swatch')).toBeNull();
		expect($(host, '.grade a').getAttribute('href')).toBe('https://cdn.example.com/grades/b.mp4');
		expect(textOf(host)).toContain(text('shop.warrantyDays', { days: 45 }));
		expect(textOf(host)).toContain('USD 800.00');
		// no grade, sold out: shown, and not added to the cart
		await setValue(condition, '');
		expect($(host, '.stock').textContent).toBe(text('page.soldOut'));
		expect($(host, '.grade')).toBeNull();
		expect(buttonOf(host, text('page.addToCart')).disabled).toBe(true);
		await setValue(condition, 'c');
		expect($(host, '.stock').textContent).toBe(text('page.outOfStock'));
		// a grade without a video has no link
		expect($(host, '.grade a')).toBeNull();
	});

	it('picks by attribute when the variants carry attributes and the product names no options', async () => {
		/** @param {string} id @param {string} color @param {string} size @param {Record<string, unknown>} [over] */
		const by = (id, color, size, over = {}) =>
			variant({
				id,
				options: {},
				attributes: [
					{ id: 'atr_c', slug: 'color', name: 'Color', value: color.toLowerCase(), label: color },
					{ id: 'atr_s', slug: 'size', name: 'Size', value: size, label: size },
				],
				...over,
			});
		const fake = makeShop({
			features: ['catalog', 'checkout'],
			routes: {
				'GET /v1/shop/products/phone': () =>
					ok(
						product({
							options: [],
							variants: [
								by('var_rs', 'Red', 'S', { inStock: false }),
								by('var_rm', 'Red', 'M'),
								by('var_bs', 'Blue', 'S', { price: 90000 }),
							],
						}),
					),
			},
		});
		const host = await mountPage(fake);
		expect($(host, '#ss-page-option-0').closest('.field').textContent).toContain('Color');
		expect($(host, '#ss-page-option-1').closest('.field').textContent).toContain('Size');
		// the first variant that can be bought is shown first
		expect($(host, '#ss-page-option-0').value).toBe('Red');
		expect($(host, '#ss-page-option-1').value).toBe('M');
		await setValue($(host, '#ss-page-option-0'), 'Blue');
		expect($(host, '#ss-page-option-1').value).toBe('S');
		expect(textOf(host)).toContain('USD 900.00');
		await click(buttonOf(host, text('page.addToCart')));
		expect(fake.cart.state().lines).toEqual([{ productId: 'prd_1', variantId: 'var_bs', quantity: 1 }]);
	});

	it('shows the Size guide in a dialog with an in/cm switch', async () => {
		const fake = makeShop({
			features: ['catalog'],
			routes: {
				'GET /v1/shop/products/phone': () =>
					ok(
						product({
							sizeChart: {
								id: 'szc_1',
								name: 'Shirts',
								unit: 'in',
								columns: [
									{ key: 'chest', label: 'Chest' },
									{ key: 'fit', label: 'Fit' },
								],
								rows: [
									{ size: 'S', label: 'Small', values: { chest: '36-38', fit: 'Slim' } },
									{ size: 'M', label: '', values: { chest: '40,5' } },
								],
								fitAdvice: 'Take one size up.',
								notes: 'Measured flat.',
							},
						}),
					),
			},
		});
		const host = await mountPage(fake);
		const open = buttonOf(host, text('page.sizeGuide'));
		expect(open.getAttribute('aria-haspopup')).toBe('dialog');
		await click(open);
		const dialog = () => $(host, '[role="dialog"]');
		expect(dialog().getAttribute('aria-modal')).toBe('true');
		expect(dialog().querySelector('h2').textContent).toBe('Shirts');
		expect(host.shadowRoot?.activeElement?.textContent).toBe(text('page.sizeClose'));
		const cells = () => [...dialog().querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent));
		expect(cells()).toEqual([
			['Small', '36-38', 'Slim'],
			['M', '40,5', ''],
		]);
		expect(dialog().textContent).toContain(text('page.fitAdvice'));
		expect(dialog().textContent).toContain('Take one size up.');
		expect(dialog().querySelector('p.meta').textContent).toBe('Measured flat.');
		expect(buttonOf(host, text('page.sizeIn')).getAttribute('aria-pressed')).toBe('true');
		await click(buttonOf(host, text('page.sizeCm')));
		expect(cells()).toEqual([
			['Small', '91.4–96.5', 'Slim'],
			['M', '102.9', ''],
		]);
		expect(buttonOf(host, text('page.sizeCm')).getAttribute('aria-pressed')).toBe('true');
		expect(host.shadowRoot?.activeElement?.textContent).toBe(text('page.sizeCm'));
		// the focus stays inside the dialog
		const overlay = $(host, '.overlay');
		const close = buttonOf(host, text('page.sizeClose'));
		const last = buttonOf(host, text('page.sizeCm'));
		last.focus();
		overlay.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
		expect(host.shadowRoot?.activeElement).toBe(close);
		overlay.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
		expect(host.shadowRoot?.activeElement).toBe(last);
		buttonOf(host, text('page.sizeIn')).focus();
		overlay.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
		overlay.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
		expect(dialog()).not.toBeNull();
		// Escape, Close and a click beside the dialog close it, and the focus goes back
		overlay.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(dialog()).toBeNull();
		expect(host.shadowRoot?.activeElement).toBe(open);
		await click(open);
		await click(buttonOf(host, text('page.sizeClose')));
		expect(dialog()).toBeNull();
		await click(open);
		dialog().click();
		expect(dialog()).not.toBeNull();
		$(host, '.overlay').click();
		expect(dialog()).toBeNull();
	});

	it('shows the alerts already set with Stop, and sets them again', async () => {
		/** @type {any[]} */
		let mine = [
			{ id: 'alr_1', kind: 'price_drop', productId: 'prd_1', variantId: null, status: 'waiting' },
			{ id: 'alr_2', kind: 'back_in_stock', productId: 'prd_1', variantId: 'var_2', status: 'waiting' },
			{ id: 'alr_3', kind: 'price_drop', productId: 'prd_9', variantId: null, status: 'waiting' },
			{ id: 'alr_4', kind: 'back_in_stock', productId: 'prd_1', variantId: 'var_2', status: 'sent' },
		];
		let refuse = false;
		const fake = makeShop({
			features: ['catalog', 'alerts'],
			signIn: 's1',
			routes: {
				'GET /v1/shop/products/phone': () =>
					ok(
						product({
							options: [{ name: 'Color', values: ['Black', 'Gold'] }],
							variants: [variant(), variant({ id: 'var_2', options: { Color: 'Gold' }, inStock: false })],
						}),
					),
				'GET /v1/shop/alerts': () => ok({ items: mine }),
				'DELETE /v1/shop/alerts/alr_1': () => {
					if (refuse) return fail(500, 'internal_error');
					mine = mine.filter((entry) => entry.id !== 'alr_1');
					return { ok: true, status: 204, data: null };
				},
				'POST /v1/shop/alerts': (call) => {
					mine = [...mine, { id: 'alr_9', ...call.body, status: 'waiting' }];
					return ok({ id: 'alr_9' }, 201);
				},
			},
		});
		const host = await mountPage(fake);
		expect(textOf(host)).toContain(text('alerts.priceActive'));
		expect(() => buttonOf(host, text('alerts.priceDrop'))).toThrow();
		await setValue($(host, '#ss-page-option-0'), 'Gold');
		expect(textOf(host)).toContain(text('alerts.stockActive'));
		// one read per sign-in, shared
		expect(fake.all('GET /v1/shop/alerts')).toHaveLength(1);
		refuse = true;
		await click(buttonOf(host, text('alerts.stop')));
		expect(textOf(host)).toContain(text('alerts.stopFailed'));
		refuse = false;
		const stops = $$(host, 'button').filter((b) => b.textContent === text('alerts.stop'));
		await click(/** @type {any} */ (stops.find((b) => b.getAttribute('data-focus') === 'stop.price_drop')));
		expect(fake.last('DELETE /v1/shop/alerts/alr_1')).toBeTruthy();
		expect(textOf(host)).toContain(text('alerts.stopped'));
		await click(buttonOf(host, text('alerts.priceDrop')));
		expect(fake.last('POST /v1/shop/alerts')?.body).toEqual({ kind: 'price_drop', productId: 'prd_1', variantId: 'var_2' });
		expect(textOf(host)).toContain(text('alerts.priceActive'));
		expect(alertsOf(fake.shop)).toBe(alertsOf(fake.shop));
		fake.identify(null);
		expect(await alertsOf(fake.shop).list()).toEqual([]);
	});
});

describe('product page parts', () => {
	it('converts size cells, words stock and grade videos, and keeps safe links only', () => {
		expect(convertCell('40', 'in', 'cm')).toBe('101.6');
		expect(convertCell('101.6', 'cm', 'in')).toBe('40.0');
		expect(convertCell('30 – 32', 'in', 'cm')).toBe('76.2–81.3');
		expect(convertCell('XL', 'in', 'cm')).toBe('XL');
		expect(convertCell('40', 'cm', 'cm')).toBe('40');
		const t = (/** @type {string} */ key, /** @type {any} */ values = {}) => text(key, values);
		const base = { id: 'v', name: '', options: {}, price: 1, compareAtPrice: null, inStock: true, grade: null };
		expect(stockText(t, { ...base, stockLeft: 0 }, 5).text).toBe(text('page.inStock'));
		expect(stockText(t, { ...base, stockLeft: 5 }, 5).tone).toBe('warning');
		expect(stockText(t, { ...base, stockLeft: 6 }, 5).tone).toBe('success');
		const watch = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
		expect(gradeVideoUrl({ videoUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' })).toBe(watch);
		expect(gradeVideoUrl({ videoUrl: 'https://cdn.example.com/a.mp4' })).toBe('https://cdn.example.com/a.mp4');
		// a file the shop has no address for (no storage connected)
		expect(gradeVideoUrl({ videoUrl: null })).toBe('');
		expect(gradeVideoUrl({})).toBe('');
		expect(safeHref(null)).toBe('');
		expect(safeHref('mailto:a@example.com')).toBe('');
		expect(safeHref(' /a/b?c=1 ')).toBe('/a/b?c=1');
		expect(richText(document, '').childNodes).toHaveLength(0);
		expect(richText(document, 42).childNodes).toHaveLength(0);
		const img = photoOf(document, { url: 'https://cdn.example.com/a.png', alt: 'A', sizes: { detail: null } }, 'detail', 'A');
		expect(img.getAttribute('src')).toBe('https://cdn.example.com/a.png');
	});

	it('finds variants by their axes, the condition and the nearest variant', () => {
		const item = {
			options: [{ name: 'Color', values: ['Red', 'Blue'] }],
			variants: [
				{
					id: 'a',
					name: '',
					options: { Color: 'Red' },
					price: 1,
					compareAtPrice: null,
					inStock: true,
					grade: { key: 'x', label: 'X' },
				},
				{
					id: 'b',
					name: '',
					options: { Color: 'Red' },
					price: 1,
					compareAtPrice: null,
					inStock: true,
					grade: { key: 'y', label: 'Y' },
				},
				{ id: 'c', name: '', options: { Color: 'Blue' }, price: 1, compareAtPrice: null, inStock: false, grade: null },
			],
		};
		const axes = axesOf(item);
		expect(axes.map((axis) => axis.key)).toEqual(['Color', GRADE_AXIS]);
		expect(pickVariant(axes, item.variants, { Color: 'Red', [GRADE_AXIS]: 'y' })?.id).toBe('b');
		expect(pickVariant(axes, item.variants, { Color: 'Red' })).toBeNull();
		const color = /** @type {any} */ (axes[0]);
		expect(nearestVariant(axes, item.variants, { Color: 'Red', [GRADE_AXIS]: 'x' }, color, 'Blue')?.id).toBe('c');
		expect(nearestVariant(axes, item.variants, {}, color, 'Green')).toBeNull();
		expect(axesOf({ options: [], variants: [] })).toEqual([]);
	});
});
