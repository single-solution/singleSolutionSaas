/**
 * The pack's elements inside the real `@ss/web` Loader (`boot`), the way a compiled website bundle runs them: headless
 * factories adapted to element definitions and renderers given `dom`, exactly like the delivery runtime does. Shows
 * the embed hosting another product's element through the Loader's public API only, and rendering nothing without it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { boot } from '@ss/web/loader';
import { createReviewsBlock } from '../headless/embed.js';
import { createGallery } from '../headless/gallery.js';
import { createPriceBlock } from '../headless/priceBlock.js';
import { createStructuredData } from '../headless/structuredData.js';
import * as embed from '../ui/embed.js';
import * as gallery from '../ui/gallery.js';
import * as priceBlock from '../ui/priceBlock.js';
import * as structuredData from '../ui/structuredData.js';
import { flush, page, strings } from './helpers.js';

/**
 * A Part E §4 factory as an `@ss/web/element` definition (what the delivery runtime's `adaptHeadless` does).
 * @param {string} key
 * @param {(options: any) => any} factory
 */
const definition = (key, factory) => ({
	key,
	create: (/** @type {any} */ { config, strings: catalog, emit, store }) => {
		const inner = factory({ config, strings: catalog, emit });
		const sync = () => store.setState(inner.state());
		sync();
		const off = inner.subscribe(sync);
		return {
			actions: inner.actions,
			destroy: () => {
				off();
				inner.destroy();
			},
		};
	},
});

/**
 * A renderer module given `dom` (the runtime's `adaptRenderer`).
 * @param {any} mod
 * @param {any} win
 */
const renderer = (mod, win) => ({
	render: (/** @type {any} */ props) => mod.render({ ...props, dom: win.document }),
	...(mod.update
		? { update: (/** @type {any} */ node, /** @type {any} */ props) => mod.update(node, { ...props, dom: win.document }) }
		: {}),
});

/**
 * @param {string} key
 * @param {any} win
 * @param {(options: any) => any} factory
 * @param {any} mod
 * @param {string} [slot]
 */
const element = (key, win, factory, mod, slot) => ({
	key,
	config: {},
	strings,
	headless: definition(key, factory),
	renderer: renderer(mod, win),
	...(slot ? { placement: { selectors: [{ selector: `[data-ss-slot="${slot}"]`, position: 'append' }] } } : {}),
});

/**
 * The other product's element (as the Reviews product's UI would be): a plain definition and renderer.
 * @param {any} win
 */
const reviewsDisplay = (win) => ({
	key: 'display',
	strings: {},
	headless: { key: 'display', create: () => ({ actions: { refresh: async () => ({ ok: true, value: null }) } }) },
	renderer: {
		render: () => {
			const node = win.document.createElement('p');
			node.className = 'reviews';
			node.textContent = '4.8 ★ (120 reviews)';
			return node;
		},
	},
});

const HTML = `<main data-ss-item-id="itm_1" data-ss-item-title="Desk lamp" data-ss-item-price="89" data-ss-item-currency="EUR">
  <img data-ss-item-image src="https://shop.example/lamp.jpg" alt="">
  <div data-ss-slot="gallery"></div><div data-ss-slot="price"></div><div data-ss-slot="reviews"></div>
</main>`;

/** @type {Array<{ destroy: () => void }>} */
const running = [];
afterEach(() => {
	for (const instance of running.splice(0)) instance.destroy();
});

describe('the pack in the Loader', () => {
	it('mounts the elements in their slots and hosts the other product element via SS.elements', async () => {
		const win = page(HTML, { url: 'https://shop.example/lamp', lang: 'de-DE' });
		/** @type {string[]} */
		const seen = [];
		const instance = boot({
			websiteId: 'web_0123456789abcdefghjkmnpq',
			env: 'live',
			window: win,
			storage: null,
			bundle: {
				elements: [
					element('gallery', win, createGallery, gallery, 'gallery'),
					element('price_block', win, createPriceBlock, priceBlock, 'price'),
					element('structured_data', win, createStructuredData, structuredData),
					element('reviews_block', win, createReviewsBlock, embed, 'reviews'),
					reviewsDisplay(win),
				],
			},
		});
		running.push(instance);
		instance.on('*', (event) => void seen.push(event.type));
		await instance.ready();
		await flush(10);
		expect(instance.list().map((entry) => `${entry.key}:${entry.status}`)).toEqual([
			'gallery:mounted',
			'price_block:mounted',
			'structured_data:mounted',
			'reviews_block:mounted',
			'display:mounted',
		]);
		const doc = win.document;
		expect(doc.querySelector('[data-ss-slot="gallery"] .ss-gallery img')?.getAttribute('alt')).toBe('Desk lamp');
		expect(doc.querySelector('[data-ss-slot="price"] .ss-price__now')?.textContent).toMatch(/^89,00\s€$/u);
		expect(JSON.parse(doc.querySelector('script[type="application/ld+json"]')?.textContent ?? '{}')).toMatchObject({
			'@type': 'Product',
			name: 'Desk lamp',
			offers: { price: '89', priceCurrency: 'EUR' },
		});
		const block = doc.querySelector('[data-ss-slot="reviews"] .ss-embed');
		expect(block?.hidden).toBe(false);
		expect(block?.querySelector('[data-ss-element="display"] .reviews')?.textContent).toBe('4.8 ★ (120 reviews)');
		expect(seen).toContain('reviews_block.embedded@1');
		expect(seen).toContain('gallery.shown@1');
		expect(win.SS.elements.get('reviews_block').state().status).toBe('active');
	});

	it('renders nothing for an embed whose product is not on the website', async () => {
		const win = page(HTML);
		const instance = boot({
			websiteId: 'web_1123456789abcdefghjkmnpq',
			env: 'live',
			window: win,
			storage: null,
			bundle: { elements: [element('reviews_block', win, createReviewsBlock, embed, 'reviews')] },
		});
		running.push(instance);
		await instance.ready();
		await flush(10);
		const block = win.document.querySelector('[data-ss-slot="reviews"] .ss-embed');
		expect(block?.hidden).toBe(true);
		expect(block?.children.length).toBe(0);
		expect(win.SS.elements.get('reviews_block').state().status).toBe('absent');
	});
	it("hosts its own product's element when two products deliver the same key (F.18 namespaced ids)", async () => {
		const win = page(HTML, { url: 'https://shop.example/lamp' });
		const other = {
			...reviewsDisplay(win),
			product: 'gallery-reviews',
			renderer: {
				render: () => {
					const node = win.document.createElement('p');
					node.className = 'other';
					return node;
				},
			},
		};
		const instance = boot({
			websiteId: 'web_0123456789abcdefghjkmnpq',
			env: 'live',
			window: win,
			storage: null,
			bundle: {
				elements: [
					{ ...element('reviews_block', win, createReviewsBlock, embed, 'reviews'), product: 'pdp' },
					other,
					{ ...reviewsDisplay(win), product: 'reviews' },
				],
			},
		});
		running.push(instance);
		await instance.ready();
		await flush(10);
		const block = win.document.querySelector('[data-ss-slot="reviews"] .ss-embed');
		expect(block?.hidden).toBe(false);
		expect(block?.querySelector('[data-ss-id="reviews:display"] .reviews')).not.toBeNull();
		expect(block?.querySelector('.other')).toBeNull();
	});
});
