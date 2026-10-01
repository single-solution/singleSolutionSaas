import { describe, expect, it, vi } from 'vitest';
import { createAlertsBlock, createReviewsBlock } from '../headless/embed.js';
import { createFaq } from '../headless/faq.js';
import { createGallery } from '../headless/gallery.js';
import { createHostedPage } from '../headless/hostedPage.js';
import { createPriceBlock } from '../headless/priceBlock.js';
import { createRelated } from '../headless/related.js';
import { createShare } from '../headless/share.js';
import { createStickyBuyBar } from '../headless/stickyBuyBar.js';
import { createStructuredData } from '../headless/structuredData.js';
import * as dom from '../ui/dom.js';
import * as embed from '../ui/embed.js';
import * as faq from '../ui/faq.js';
import * as gallery from '../ui/gallery.js';
import * as hostedPage from '../ui/hostedPage.js';
import { fetchJson, pageContext, snapshot } from '../ui/page.js';
import * as priceBlock from '../ui/priceBlock.js';
import * as related from '../ui/related.js';
import * as share from '../ui/share.js';
import * as stickyBuyBar from '../ui/stickyBuyBar.js';
import * as structuredData from '../ui/structuredData.js';
import { ITEM, events, flush, mount, page, stubFetch } from './helpers.js';

const ITEM_HTML = `<div data-ss-item-id="itm_1" data-ss-item-title="Linen shirt" data-ss-item-brand="Acme"
  data-ss-item-price="49.90" data-ss-item-currency="USD" data-ss-item-availability="InStock">
  <img data-ss-item-image src="https://shop.example/1.jpg" width="800" height="800" alt="">
  <img data-ss-item-image src="https://shop.example/2.jpg" alt="Back view" data-ss-zoom="https://shop.example/2-big.jpg">
  <video data-ss-item-image poster="https://shop.example/p.jpg"><source src="https://shop.example/v.mp4"></video>
  <div data-ss-slot="gallery"></div><div data-ss-slot="price"></div><div data-ss-slot="reviews"></div>
  <button data-ss-buy>Buy</button>
</div>`;

/** @param {any} win @param {string} type @param {Record<string, unknown>} [extra] */
const key = (win, type, extra = {}) => new win.KeyboardEvent('keydown', { key: type, bubbles: true, cancelable: true, ...extra });

describe('ui/page', () => {
	it('snapshots the page item data', () => {
		const win = page(ITEM_HTML, {
			head: '<meta property="og:title" content="OG"><meta name="ss:item:sku" content="SKU-1"><meta name="robots">',
		});
		const snap = snapshot(win.document, 'gallery');
		expect(snap.meta).toEqual([
			['og:title', 'OG'],
			['ss:item:sku', 'SKU-1'],
			['robots', ''],
		]);
		expect(snap.attributes).toMatchObject({ 'data-ss-item-id': 'itm_1', 'data-ss-item-price': '49.90' });
		expect(snap.media).toHaveLength(3);
		expect(snap.media?.[2]).toMatchObject({
			tag: 'video',
			src: 'https://shop.example/v.mp4',
			poster: 'https://shop.example/p.jpg',
		});
		expect(snap.json).toBe('');
		const blob = page('<script type="application/json" data-ss-item>{"title":"Blob"}</script>');
		expect(snapshot(blob.document, 'faq').json).toBe('{"title":"Blob"}');
	});

	it('reads the page context: canonical URL, language and existing Product markup', () => {
		const win = page('', {
			head: '<link rel="canonical" href="/shirts/linen"><script type="application/ld+json">{"@type": "Product"}</script>',
			url: 'https://shop.example/shirts/linen?utm=1',
			lang: 'fr-FR',
		});
		expect(pageContext(win.document)).toEqual({
			path: '/shirts/linen',
			url: 'https://shop.example/shirts/linen',
			locale: 'fr-FR',
			hasProductJsonLd: true,
		});
		const plain = page('', { head: '<link rel="canonical" href="http://[bad">' });
		expect(pageContext(plain.document)).toMatchObject({ url: 'https://shop.example/shirts/linen', hasProductJsonLd: false });
	});

	it('fetches JSON once per URL, without cookies, and refuses bad responses', async () => {
		const win = page('');
		const calls = stubFetch(win, { 'https://api.example/a.json': { title: 'A' } });
		const [first, second] = await Promise.all([
			fetchJson(win, 'https://api.example/a.json'),
			fetchJson(win, 'https://api.example/a.json'),
		]);
		expect(first).toEqual({ title: 'A' });
		expect(second).toBe(first);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.init).toMatchObject({ credentials: 'omit', headers: { accept: 'application/json' } });
		await expect(fetchJson(win, 'https://api.example/missing.json')).rejects.toThrow('source unusable');
		await expect(fetchJson(win, 'https://api.example/missing.json')).rejects.toThrow();
		expect(calls).toHaveLength(3);
		for (let i = 0; i < 21; i += 1) void fetchJson(win, `https://api.example/${i}.json`).catch(() => undefined);
		await flush();
		await expect(fetchJson({}, 'https://api.example/a.json')).rejects.toThrow('no fetch');
	});
});

describe('ui/dom', () => {
	it('builds elements and tolerates missing DOM features', () => {
		const win = page('');
		const node = dom.el(win.document, 'p', { hidden: true, title: 'T', skip: false, none: null }, [
			'a',
			1,
			null,
			'',
			win.document.createElement('b'),
		]);
		expect(node.outerHTML).toBe('<p hidden="" title="T">a1<b></b></p>');
		expect(dom.query(win.document, ':::bad')).toBeNull();
		expect(dom.queryAll(win.document, ':::bad')).toEqual([]);
		expect(dom.query(null, 'p')).toBeNull();
		expect(dom.loaderApi(win.document)).toBeNull();
		expect(dom.winOf(/** @type {any} */ (null))).toBeNull();
		expect(dom.BASE_STYLES).toMatch(/var\(--ss-color-focus\)/);
	});
});

describe('ui renderers', () => {
	it('use design tokens only', () => {
		for (const mod of [gallery, priceBlock, related, faq, stickyBuyBar, share, hostedPage, embed]) {
			expect(mod.styles).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
		}
	});
});

describe('ui/gallery', () => {
	it('renders an accessible carousel with eager priority image, thumbnails and keyboard navigation', async () => {
		const win = page(ITEM_HTML);
		const sent = events();
		const view = mount(win, createGallery, gallery, {
			key: 'gallery',
			emit: sent.emit,
			target: win.document.querySelector('[data-ss-slot="gallery"]'),
		});
		expect(view.node().getAttribute('aria-busy')).toBe('true');
		await flush();
		const root = view.node();
		expect(root.getAttribute('role')).toBe('region');
		expect(root.getAttribute('aria-label')).toBe('Product images');
		const main = root.querySelector('.ss-gallery__viewer img');
		expect(main.getAttribute('loading')).toBe('eager');
		expect(main.getAttribute('fetchpriority')).toBe('high');
		expect(main.getAttribute('alt')).toBe('Linen shirt, image 1 of 3');
		expect(main.getAttribute('width')).toBe('800');
		expect(root.querySelectorAll('.ss-gallery__thumb')).toHaveLength(3);

		const viewer = root.querySelector('.ss-gallery__viewer');
		viewer.focus();
		viewer.dispatchEvent(key(win, 'ArrowRight'));
		await flush();
		expect(view.instance.state().index).toBe(1);
		expect(win.document.activeElement.getAttribute('data-ss-focus')).toBe('viewer');
		expect(view.node().querySelector('.ss-gallery__viewer img').getAttribute('alt')).toBe('Back view');
		view.node().querySelector('[data-ss-focus="thumb-2"]').dispatchEvent(key(win, 'End'));
		await flush();
		expect(view.node().querySelector('.ss-gallery__viewer video')).not.toBeNull();
		view.node().querySelector('.ss-gallery__viewer').dispatchEvent(key(win, 'Home'));
		view.node().querySelector('.ss-gallery__viewer').dispatchEvent(key(win, 'x'));
		await flush();
		view.node().querySelector('[data-ss-focus="thumb-1"]').click();
		await flush();
		expect(view.instance.state().index).toBe(1);
		view.node().querySelector('[data-ss-focus="next"]').click();
		view.node().querySelector('[data-ss-focus="prev"]').click();
		await flush();
		expect(sent.list.map(([name]) => name)).toContain('image_changed');
	});

	it('opens the zoom dialog, traps focus, closes with Escape and returns focus', async () => {
		const win = page(ITEM_HTML);
		const view = mount(win, createGallery, gallery, { key: 'gallery' });
		await flush();
		view.node().querySelector('.ss-gallery__btn--zoom').click();
		await flush();
		const dialog = view.node().querySelector('[role="dialog"]');
		expect(dialog.getAttribute('aria-modal')).toBe('true');
		expect(dialog.querySelector('img').getAttribute('src')).toBe('https://shop.example/1.jpg');
		expect(win.document.activeElement.getAttribute('aria-label')).toBe('Close zoom');
		dialog.dispatchEvent(key(win, 'ArrowRight'));
		await flush();
		expect(view.node().querySelector('[role="dialog"] img').getAttribute('src')).toBe('https://shop.example/2-big.jpg');
		view.node().querySelector('[role="dialog"]').dispatchEvent(key(win, 'Tab'));
		expect(win.document.activeElement.getAttribute('aria-label')).toBe('Close zoom');
		view.node().querySelector('[role="dialog"]').dispatchEvent(key(win, 'Escape'));
		await flush();
		expect(view.node().querySelector('[role="dialog"]')).toBeNull();
		expect(win.document.activeElement.getAttribute('data-ss-focus')).toBe('zoom');
		view.node().querySelector('.ss-gallery__viewer').dispatchEvent(key(win, 'Enter'));
		await flush();
		expect(view.instance.state().zoomed).toBe(true);
		view.node().querySelector('.ss-gallery__btn--close').click();
		await flush();
		expect(view.instance.state().zoomed).toBe(false);
	});

	it('swipes, renders grid and stacked layouts, and hides without images', async () => {
		const win = page(ITEM_HTML);
		const view = mount(win, createGallery, gallery, { key: 'gallery' });
		await flush();
		/** @param {string} type @param {string} field @param {number} x @param {number} y */
		const touch = (type, field, x, y) => {
			const event = new win.Event(type);
			Object.defineProperty(event, field, { value: [{ clientX: x, clientY: y }] });
			view.node().querySelector('.ss-gallery__viewer').dispatchEvent(event);
		};
		touch('touchstart', 'touches', 200, 100);
		touch('touchend', 'changedTouches', 100, 110);
		await flush();
		expect(view.instance.state().index).toBe(1);
		touch('touchstart', 'touches', 100, 100);
		touch('touchend', 'changedTouches', 200, 300);
		touch('touchend', 'changedTouches', 300, 100);
		await flush();
		expect(view.instance.state().index).toBe(1);

		const grid = mount(win, createGallery, gallery, {
			key: 'gallery',
			config: { layout: 'grid', lazy: 'all_lazy', aspect_ratio: '4:3' },
		});
		await flush();
		expect(grid.node().className).toContain('ss-gallery--r4x3');
		expect([...grid.node().querySelectorAll('img')].every((img) => img.getAttribute('loading') === 'lazy')).toBe(true);
		grid.node().querySelector('[data-ss-focus="zoom-1"]').click();
		await flush();
		expect(grid.instance.state()).toMatchObject({ index: 1, zoomed: true });
		grid.node().querySelector('.ss-gallery__btn--close').click();
		await flush();
		expect(win.document.activeElement.getAttribute('data-ss-focus')).toBe('zoom-1');

		const stacked = mount(win, createGallery, gallery, {
			key: 'gallery',
			config: { layout: 'stacked', zoom: false, lazy: 'all_eager' },
		});
		await flush();
		expect(stacked.node().querySelectorAll('.ss-gallery__item')).toHaveLength(0);
		expect(stacked.node().querySelectorAll('img[loading="eager"]')).toHaveLength(2);

		const bare = page('<p>No item here</p>');
		const none = mount(bare, createGallery, gallery, { key: 'gallery' });
		await flush();
		expect(none.node().hidden).toBe(true);
		const slot = bare.document.createElement('p');
		const single = gallery.render({
			state: {
				...grid.instance.state(),
				layout: 'carousel',
				images: [grid.instance.state().images[0]],
				index: 0,
				zoomed: false,
			},
			actions: grid.instance.actions,
			strings: {},
			slots: { after: slot },
			dom: bare.document,
		});
		expect(single.querySelector('.ss-gallery__thumb')).toBeNull();
		expect(single.lastChild).toBe(slot);
	});
});

describe('ui/priceBlock', () => {
	it('renders price, savings, availability and copy, and follows the variant event', async () => {
		/** @type {Record<string, (event: unknown) => void>} */
		const handlers = {};
		const win = page(
			ITEM_HTML.replace('data-ss-item-price="49.90"', 'data-ss-item-price="49.90" data-ss-item-compare-at-price="60"'),
		);
		win.SS = { on: (/** @type {string} */ type, /** @type {(event: unknown) => void} */ fn) => (handlers[type] = fn) };
		const view = mount(win, createPriceBlock, priceBlock, {
			key: 'price_block',
			config: { show_taxes: true, show_financing: true, update_event: 'widget.variant_selected' },
		});
		await flush();
		const root = view.node();
		expect(root.getAttribute('role')).toBe('group');
		expect(root.querySelector('.ss-price__now').textContent).toBe('$49.90');
		expect(root.querySelector('s').textContent).toBe('$60.00');
		expect(root.querySelector('.ss-pdp__sr').textContent).toBe('Was');
		expect(root.querySelector('.ss-price__save').textContent).toBe('−17%');
		expect(root.textContent).toContain('In stock');
		expect(root.textContent).toContain('Taxes included.');
		expect(root.textContent).toContain('Instalment payments available.');
		handlers['widget.variant_selected']?.({ data: { price: '39', availability: 'PreOrder' } });
		await flush();
		expect(view.node().querySelector('.ss-price__now').textContent).toBe('$39.00');
		expect(view.node().textContent).toContain('Available to pre-order');
		for (const [savingsMode, expected] of [
			['amount', 'Save $10.10'],
			['both', 'Save $10.10 (17%)'],
			['none', null],
		]) {
			const other = mount(win, createPriceBlock, priceBlock, {
				key: 'price_block',
				config: { savings: savingsMode, show_availability: false },
			});
			await flush();
			expect(other.node().querySelector('.ss-price__save')?.textContent ?? null).toBe(expected);
		}
		const empty = mount(page('<p></p>'), createPriceBlock, priceBlock, { key: 'price_block' });
		await flush();
		expect(empty.node().hidden).toBe(true);
	});
});

describe('ui/structuredData', () => {
	it('embeds Product JSON-LD and sends item.viewed through SS.track', async () => {
		const win = page(ITEM_HTML, { head: '<link rel="canonical" href="https://shop.example/shirts/linen">' });
		const track = vi.fn();
		win.SS = { track };
		const view = mount(win, createStructuredData, structuredData, {
			key: 'structured_data',
			config: { track_item_viewed: true },
		});
		await flush();
		const script = view.node().querySelector('script[type="application/ld+json"]');
		expect(view.node().hidden).toBe(true);
		const node = JSON.parse(script.textContent);
		expect(node).toMatchObject({
			'@context': 'https://schema.org',
			'@type': 'Product',
			name: 'Linen shirt',
			image: ['https://shop.example/1.jpg', 'https://shop.example/2.jpg'],
			offers: { '@type': 'Offer', price: '49.90', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
		});
		expect(track).toHaveBeenCalledTimes(1);
		expect(track).toHaveBeenCalledWith('item.viewed', { itemId: 'itm_1', price: { amount: 4990, currency: 'USD' } });
		// our own markup does not count as the page's
		expect(pageContext(win.document).hasProductJsonLd).toBe(false);

		const marked = page(ITEM_HTML, { head: '<script type="application/ld+json">{"@type":"Product","name":"x"}</script>' });
		const skipped = mount(marked, createStructuredData, structuredData, { key: 'structured_data' });
		await flush();
		expect(skipped.node().querySelector('script')).toBeNull();
	});
});

describe('ui/embed', () => {
	it('hosts the other product element while it is mounted, and refreshes it', async () => {
		const win = page(`${ITEM_HTML}<div data-ss-element="display"><p>Reviews by the Reviews product</p></div>`);
		const refresh = vi.fn(async () => ({ ok: true, value: null }));
		/** @type {Record<string, () => void>} */
		const handlers = {};
		const list = [{ key: 'display', status: 'loading' }];
		/** @type {Record<string, unknown>} */
		const mounted = {};
		win.SS = {
			elements: { list: () => list, get: (/** @type {string} */ k) => mounted[k] },
			on: (/** @type {string} */ type, /** @type {() => void} */ fn) => {
				handlers[type] = fn;
				return () => undefined;
			},
		};
		const view = mount(win, createReviewsBlock, embed, {
			key: 'reviews_block',
			target: win.document.querySelector('[data-ss-slot="reviews"]'),
		});
		await flush();
		expect(view.node().hidden).toBe(true);
		list[0] = { key: 'display', status: 'mounted' };
		mounted.display = { actions: { refresh } };
		handlers['display.shown']?.();
		await flush();
		const root = view.node();
		expect(root.hidden).toBe(false);
		expect(root.getAttribute('aria-label')).toBe('Reviews');
		expect(root.querySelector('[data-ss-element="display"]')?.textContent).toBe('Reviews by the Reviews product');
		expect(win.document.querySelector('[data-ss-slot="reviews"] [data-ss-element="display"]')).not.toBeNull();
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it('renders nothing when the other product is not on the website', async () => {
		const win = page(ITEM_HTML);
		win.SS = { elements: { list: () => [], get: () => undefined } };
		const view = mount(win, createAlertsBlock, embed, { key: 'alerts_block' });
		await flush();
		expect(view.instance.state().status).toBe('absent');
		expect(view.node().hidden).toBe(true);
		expect(view.node().children).toHaveLength(0);
		const alone = mount(page(''), createAlertsBlock, embed, { key: 'alerts_block' });
		await flush();
		expect(alone.instance.state().status).toBe('absent');
		const unlabeled = embed.render({
			state: { ...view.instance.state(), status: 'active' },
			actions: view.instance.actions,
			strings: {},
			dom: win.document,
		});
		expect(unlabeled.getAttribute('aria-label')).toBe('alerts_block');
	});
});

describe('ui/related', () => {
	it('renders crawlable related links and reports clicks', async () => {
		const blob = JSON.stringify({
			related: [
				{ id: 'b', title: 'Wool shirt', url: '/b', image: '/b.jpg', price: 30, brand: 'Acme' },
				{ id: 'c', title: 'Cap', url: '/c' },
			],
		});
		const win = page(`${ITEM_HTML.replace('</div>', `<script type="application/json" data-ss-item>${blob}</script></div>`)}`);
		const sent = events();
		const view = mount(win, createRelated, related, {
			key: 'related',
			emit: sent.emit,
			config: { strategy: 'same_brand', layout: 'grid' },
		});
		await flush();
		const root = view.node();
		expect(root.getAttribute('aria-label')).toBe('More from Acme');
		const links = root.querySelectorAll('a');
		expect(links).toHaveLength(1);
		expect(links[0].getAttribute('href')).toBe('/b');
		expect(root.querySelector('.ss-related__price').textContent).toBe('$30.00');
		links[0].addEventListener('click', (/** @type {any} */ event) => event.preventDefault());
		links[0].click();
		await flush();
		expect(sent.list).toEqual([['clicked', { index: 0, itemId: 'b' }]]);
		const plain = mount(win, createRelated, related, { key: 'related' });
		await flush();
		expect(plain.node().getAttribute('aria-label')).toBe('You may also like');
		expect(plain.node().querySelectorAll('img')).toHaveLength(1);
		const none = mount(page(ITEM_HTML), createRelated, related, { key: 'related' });
		await flush();
		expect(none.node().hidden).toBe(true);
	});
});

describe('ui/faq', () => {
	it('renders native disclosures with FAQPage markup', async () => {
		const blob = JSON.stringify({
			faq: [
				{ question: 'Washable?', answer: 'Yes.' },
				{ question: 'Sizes?', answer: 'S to XL.' },
			],
		});
		const win = page(ITEM_HTML.replace('</div>', `<script type="application/json" data-ss-item>${blob}</script></div>`));
		const sent = events();
		const view = mount(win, createFaq, faq, { key: 'faq', emit: sent.emit, config: { open_first: true } });
		await flush();
		const root = view.node();
		expect(root.getAttribute('aria-label')).toBe('Questions about Linen shirt');
		const details = root.querySelectorAll('details');
		expect(details).toHaveLength(2);
		expect(details[0].open).toBe(true);
		expect(JSON.parse(root.querySelector('script[type="application/ld+json"]').textContent).mainEntity).toHaveLength(2);
		details[1].open = true;
		details[1].dispatchEvent(new win.Event('toggle'));
		details[0].open = false;
		details[0].dispatchEvent(new win.Event('toggle'));
		await flush();
		expect(sent.list).toContainEqual(['opened', { index: 1 }]);
		const manual = mount(page('<p></p>'), createFaq, faq, {
			key: 'faq',
			config: { structured_data: false, entries: [{ question: 'Q', answer: 'A' }] },
		});
		await flush();
		expect(manual.node().getAttribute('aria-label')).toBe('Questions and answers');
		expect(manual.node().querySelector('script')).toBeNull();
		const none = mount(page('<p></p>'), createFaq, faq, { key: 'faq' });
		await flush();
		expect(none.node().hidden).toBe(true);
	});
});

describe('ui/stickyBuyBar', () => {
	it('shows on mobile once the page buy button is out of view and presses it', async () => {
		const win = page(ITEM_HTML);
		Object.defineProperty(win, 'innerWidth', { value: 375, configurable: true });
		Object.defineProperty(win, 'innerHeight', { value: 700, configurable: true });
		const buy = vi.fn();
		win.document.querySelector('[data-ss-buy]').addEventListener('click', buy);
		const sent = events();
		const view = mount(win, createStickyBuyBar, stickyBuyBar, {
			key: 'sticky_buy_bar',
			emit: sent.emit,
			config: { dismissible: true },
		});
		await flush();
		const root = view.node();
		expect(root.hidden).toBe(false);
		expect(root.getAttribute('aria-label')).toBe('Quick buy');
		expect(root.querySelector('.ss-sticky__price').textContent).toBe('$49.90');
		root.querySelector('.ss-sticky__cta').click();
		await flush();
		expect(buy).toHaveBeenCalledTimes(1);
		win.document.querySelector('[data-ss-buy]').getBoundingClientRect = () => ({ top: 100, bottom: 140 });
		win.dispatchEvent(new win.Event('scroll'));
		await flush();
		expect(view.node().hidden).toBe(true);
		win.document.querySelector('[data-ss-buy]').getBoundingClientRect = () => ({ top: -100, bottom: -60 });
		win.dispatchEvent(new win.Event('resize'));
		await flush();
		view.node().querySelector('.ss-sticky__dismiss').click();
		await flush();
		expect(view.node().hidden).toBe(true);
		expect(sent.list.map(([name]) => name)).toEqual(['clicked', 'dismissed']);
	});

	it('uses IntersectionObserver, scrolls to the page button, and shows unavailable items as such', async () => {
		const win = page(ITEM_HTML.replace('InStock', 'OutOfStock'));
		Object.defineProperty(win, 'innerWidth', { value: 375, configurable: true });
		/** @type {Array<(entries: any[]) => void>} */
		const observers = [];
		win.IntersectionObserver = function IntersectionObserver(/** @type {(entries: any[]) => void} */ callback) {
			observers.push(callback);
			return { observe: () => undefined };
		};
		const cta = win.document.querySelector('[data-ss-buy]');
		cta.scrollIntoView = vi.fn();
		const view = mount(win, createStickyBuyBar, stickyBuyBar, {
			key: 'sticky_buy_bar',
			config: { hide_unavailable: false, action: 'scroll', show_price: false },
		});
		await flush();
		observers[0]?.([{ isIntersecting: false }]);
		await flush();
		const button = view.node().querySelector('.ss-sticky__cta');
		expect(button.disabled).toBe(true);
		expect(button.textContent).toBe('Unavailable');
		expect(view.node().querySelector('.ss-sticky__price')).toBeNull();
		const available = mount(page(ITEM_HTML), createStickyBuyBar, stickyBuyBar, {
			key: 'sticky_buy_bar',
			config: { action: 'scroll', mode: 'always', devices: ['desktop'] },
		});
		await flush();
		const target = available.container.ownerDocument.querySelector('[data-ss-buy]');
		target.scrollIntoView = vi.fn();
		available.node().querySelector('.ss-sticky__cta').click();
		await flush();
		expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
		const nowhere = stickyBuyBar.render({
			state: available.instance.state(),
			actions: available.instance.actions,
			strings: {},
			dom: /** @type {any} */ ({
				createElement: (/** @type {string} */ t) => page('').document.createElement(t),
				createTextNode: (/** @type {string} */ t) => page('').document.createTextNode(t),
			}),
		});
		expect(nowhere.getAttribute('role')).toBe('region');
	});
});

describe('ui/share', () => {
	it('shows supported channels, copies the link and opens network pages safely', async () => {
		const win = page(ITEM_HTML);
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(win.navigator, 'clipboard', { value: { writeText }, configurable: true });
		const sent = events();
		const view = mount(win, createShare, share, {
			key: 'share',
			emit: sent.emit,
			config: { channels: ['native', 'copy', 'x'] },
		});
		await flush();
		const root = view.node();
		expect(root.getAttribute('role')).toBe('group');
		expect([...root.querySelectorAll('.ss-share__link')].map((node) => node.textContent)).toEqual(['Copy link', 'X']);
		const link = root.querySelector('a');
		expect(link.getAttribute('rel')).toBe('noopener noreferrer');
		expect(link.getAttribute('target')).toBe('_blank');
		root.querySelector('button').click();
		await flush();
		expect(writeText).toHaveBeenCalledWith('https://shop.example/shirts/linen');
		expect(view.node().querySelector('[role="status"]').textContent).toBe('Link copied.');
		writeText.mockRejectedValueOnce(new Error('denied'));
		view.node().querySelector('button').click();
		await flush();
		expect(view.instance.state().copied).toBe(false);
		link.addEventListener('click', (/** @type {any} */ event) => event.preventDefault());
		link.click();
		await flush();
		expect(sent.list.map(([name, data]) => `${name}:${data.channel}`)).toEqual(['shared:copy', 'shared:copy', 'shared:x']);

		const native = page(ITEM_HTML);
		const shareSheet = vi.fn(async () => undefined);
		Object.defineProperty(native.navigator, 'share', { value: shareSheet, configurable: true });
		const sheet = mount(native, createShare, share, { key: 'share', config: { channels: ['native'] } });
		await flush();
		sheet.node().querySelector('button').click();
		await flush();
		expect(shareSheet).toHaveBeenCalledWith({ url: 'https://shop.example/shirts/linen', title: 'Linen shirt' });
		const none = mount(page(ITEM_HTML), createShare, share, { key: 'share', config: { channels: ['native'] } });
		await flush();
		expect(none.node().hidden).toBe(true);
		const missing = share.render({
			state: { ...view.instance.state(), links: [{ channel: 'telegram', url: 'u', href: '' }] },
			actions: view.instance.actions,
			strings: {},
			dom: win.document,
		});
		missing.querySelector('button').click();
		await flush();
	});
});

describe('ui/hostedPage', () => {
	it('renders the hosted item page, sets metadata and lets the Loader place the other elements', async () => {
		const win = page('', { url: 'https://shop.example/p/linen-shirt?ref=ad' });
		stubFetch(win, {
			'https://api.example/items/linen-shirt.json': {
				...ITEM,
				description: 'Breathable <b>linen</b>.',
				attributes: { Material: 'Linen' },
			},
		});
		const refresh = vi.fn();
		win.SS = { refresh };
		const view = mount(win, createHostedPage, hostedPage, {
			key: 'hosted_page',
			config: { source_url: 'https://api.example/items/{slug}.json', robots: 'noindex', slots: ['gallery', 'reviews'] },
		});
		await flush();
		const root = view.node();
		expect(root.hidden).toBe(false);
		expect(root.getAttribute('data-ss-item-id')).toBe('itm_1');
		expect(root.getAttribute('data-ss-page-type')).toBe('product');
		expect(root.querySelector('h1').textContent).toBe('Linen shirt');
		expect(root.querySelector('.ss-hosted__description').textContent).toBe('Breathable <b>linen</b>.');
		expect(root.querySelector('.ss-hosted__description').children).toHaveLength(0);
		expect([...root.querySelectorAll('[data-ss-slot]')].map((node) => node.getAttribute('data-ss-slot'))).toEqual([
			'gallery',
			'reviews',
		]);
		expect(root.querySelector('dt').textContent).toBe('Material');
		expect(win.document.title).toBe('Linen shirt');
		expect(win.document.querySelector('meta[name="description"]').getAttribute('content')).toBe('Breathable <b>linen</b>.');
		expect(win.document.querySelector('link[rel="canonical"]').getAttribute('href')).toBe('https://shop.example/p/linen-shirt');
		expect(win.document.querySelector('meta[name="robots"]').getAttribute('content')).toBe('noindex');
		expect(refresh).toHaveBeenCalledTimes(1);
		// the other elements read the same item from the hosted page
		expect(snapshot(win.document, 'gallery').json).toContain('"title":"Linen shirt"');

		const elsewhere = page('', { url: 'https://shop.example/about' });
		const none = mount(elsewhere, createHostedPage, hostedPage, { key: 'hosted_page' });
		await flush();
		expect(none.node().hidden).toBe(true);
		const existing = page('', { url: 'https://shop.example/p/lamp', head: '<meta name="description" content="old">' });
		existing.document.body.setAttribute('data-ss-item-title', 'x');
		const plain = mount(existing, createHostedPage, hostedPage, {
			key: 'hosted_page',
			config: { show_image: false, show_attributes: false },
		});
		await flush();
		await plain.instance.actions.setItem({ id: '', title: 'Lamp', images: ['/l.jpg'] });
		await flush();
		expect(plain.node().getAttribute('data-ss-item-id')).toBe('hosted');
		expect(plain.node().querySelector('img')).toBeNull();
	});
});
