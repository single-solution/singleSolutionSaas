import { describe, expect, it } from 'vitest';
import { createItemElement, createStore, readItem, sourceSettings } from '../headless/base.js';
import {
	EMBED_TARGETS,
	createAlertsBlock,
	createConfiguratorEmbed,
	createDealPill,
	createGradeShowcase,
	createReviewsBlock,
} from '../headless/embed.js';
import { createFaq } from '../headless/faq.js';
import { createGallery } from '../headless/gallery.js';
import { createHostedPage } from '../headless/hostedPage.js';
import { createPriceBlock } from '../headless/priceBlock.js';
import { createRelated } from '../headless/related.js';
import { createShare } from '../headless/share.js';
import { createStickyBuyBar } from '../headless/stickyBuyBar.js';
import { createStructuredData } from '../headless/structuredData.js';
import { createTranslator } from '../headless/strings.js';
import { ITEM, events, strings } from './helpers.js';

describe('headless/base', () => {
	it('keeps immutable snapshots and stops notifying after destroy', () => {
		const store = createStore({ a: 1 });
		/** @type {number[]} */
		const seen = [];
		const off = store.subscribe((state) => seen.push(state.a));
		store.set({ a: 2 });
		expect(Object.isFrozen(store.get())).toBe(true);
		off();
		store.set({ a: 3 });
		store.destroy();
		store.set({ a: 4 });
		expect(seen).toEqual([2]);
		expect(store.get().a).toBe(3);
		expect(store.destroyed()).toBe(true);
	});

	it('reads the source settings and overlays the JSON source on the page data', async () => {
		expect(sourceSettings({ source_url: 'https://a.example/{id}.json', source_fields: { title: 'name', bad: 'a b' } })).toEqual(
			{
				url: 'https://a.example/{id}.json',
				fields: { title: 'name' },
			},
		);
		/** @type {string[]} */
		const urls = [];
		const { item, sourceFailed } = await readItem(
			{
				page: () => ({ attributes: { 'data-ss-item-id': 'itm_1', 'data-ss-item-title': 'Page title' } }),
				fetchJson: async (url) => {
					urls.push(url);
					return { product: { name: 'Remote title', price: '10', currency: 'EUR' } };
				},
				context: { path: '/x', params: { slug: 'lamp' } },
			},
			{ url: 'https://a.example/{id}/{slug}.json?p={path}', fields: { root: 'product', title: 'name' } },
		);
		expect(urls).toEqual(['https://a.example/itm_1/lamp.json?p=%2Fx']);
		expect(item).toMatchObject({ id: 'itm_1', title: 'Remote title', price: '10', currency: 'EUR' });
		expect(sourceFailed).toBe(false);
		const failed = await readItem(
			{
				read: () => ({ title: 'Kept' }),
				fetchJson: async () => {
					throw new Error('down');
				},
			},
			{ url: 'https://a.example/x.json', fields: {} },
		);
		expect(failed).toMatchObject({ sourceFailed: true, item: { title: 'Kept' } });
		const insecure = await readItem({ fetchJson: async () => ({}) }, { url: 'http://a.example/x', fields: {} });
		expect(insecure.sourceFailed).toBe(true);
		const broken = await readItem(
			{
				read: () => {
					throw new Error('x');
				},
			},
			{ url: '', fields: {} },
		);
		expect(broken.item.title).toBe('');
	});

	it('loads, validates with messages, and reports a failing source', async () => {
		const sent = events();
		const core = createItemElement({
			strings,
			emit: sent.emit,
			prefix: 'faq',
			extra: {},
			config: { source_url: 'https://a.example/x' },
		});
		const result = await core.actions.load({
			fetchJson: async () => {
				throw new Error('down');
			},
		});
		expect(result).toEqual({ ok: false, problem: { code: 'source_failed' }, error: { code: 'source_failed' } });
		expect(sent.list).toEqual([['source_failed', {}]]);
		expect(core.validate({ price: 'x' })[0]?.message).toBe('Check the item data: title is missing or invalid.');
		expect(core.validate('x')[0]?.message).toContain('item');
		expect((await core.actions.setItem({})).ok).toBe(false);
		expect(await core.actions.load()).toMatchObject({ ok: false, error: { code: 'item_missing' } });
	});

	it('translates with placeholders and shows missing keys', () => {
		const t = createTranslator({ hello: 'Hi {name} {other}' });
		expect(t('hello', { name: 'Ann' })).toBe('Hi Ann {other}');
		expect(t('missing')).toBe('missing');
	});
});

describe('headless/gallery', () => {
	it('navigates, wraps around, zooms and builds alt text from the template', async () => {
		const sent = events();
		const gallery = createGallery({ config: { priority_index: 1, video: false }, strings, emit: sent.emit });
		expect(gallery.state().status).toBe('idle');
		await gallery.actions.setItem({
			title: 'Lamp',
			images: ['/1.jpg', { src: '/2.jpg', alt: 'Lit brass lamp' }, { type: 'video', src: '/v.mp4' }, '/3.jpg'],
		});
		const state = gallery.state();
		expect(state.status).toBe('ready');
		expect(state.images.map((image) => image.alt)).toEqual(['Lamp, image 1 of 3', 'Lit brass lamp', 'Lamp, image 3 of 3']);
		expect(state.index).toBe(1);
		await gallery.actions.next();
		await gallery.actions.next();
		expect(gallery.state().index).toBe(0);
		await gallery.actions.prev();
		expect(gallery.state().index).toBe(2);
		await gallery.actions.first();
		await gallery.actions.last();
		expect(gallery.state().index).toBe(2);
		expect((await gallery.actions.select(2)).ok).toBe(true);
		expect((await gallery.actions.openZoom()).ok).toBe(true);
		expect(gallery.state().zoomed).toBe(true);
		await gallery.actions.closeZoom();
		expect(gallery.state().zoomed).toBe(false);
		expect(sent.list.map(([name]) => name)).toEqual([
			'image_changed',
			'image_changed',
			'image_changed',
			'image_changed',
			'image_changed',
			'zoom_opened',
		]);
		expect(gallery.validate({})).toHaveLength(1);
		gallery.destroy();
	});

	it('is empty without images and refuses zoom when switched off', async () => {
		const gallery = createGallery({ config: { zoom: false }, strings });
		await gallery.actions.setItem({ title: 'No images' });
		expect(gallery.state().status).toBe('empty');
		expect((await gallery.actions.select(1)).ok).toBe(false);
		expect((await gallery.actions.openZoom()).ok).toBe(false);
		const single = createGallery({ config: { zoom: false }, strings });
		await single.actions.setItem({ title: 'One', images: ['/1.jpg'] });
		expect(single.state().images[0]?.alt).toBe('One');
		expect((await single.actions.openZoom()).ok).toBe(false);
		expect(createGallery({}).state().layout).toBe('carousel');
	});
});

describe('headless/priceBlock', () => {
	it('formats the price, savings and availability, and applies variants', async () => {
		const sent = events();
		const price = createPriceBlock({ config: { locale: 'en-US', savings: 'both' }, strings, emit: sent.emit });
		await price.actions.load({ read: () => ({ ...ITEM, compareAtPrice: '60' }) });
		expect(price.state().view).toEqual({
			price: '$49.90',
			compareAt: '$60.00',
			saving: '$10.10',
			percent: 17,
			availability: 'in_stock',
		});
		expect((await price.actions.setVariant({ price: '55', availability: 'OutOfStock' })).ok).toBe(true);
		expect(price.state().view).toMatchObject({ price: '$55.00', compareAt: '', availability: 'out_of_stock' });
		expect((await price.actions.setVariant({ price: 'free' })).ok).toBe(false);
		expect((await price.actions.setVariant(null)).ok).toBe(false);
		expect(sent.list).toEqual([['variant_applied', {}]]);
		const pageLocale = createPriceBlock({ strings });
		await pageLocale.actions.load({ read: () => ITEM, context: { locale: 'de-DE' } });
		expect(pageLocale.state().view.price).toMatch(/^49,90\s\$$/u);
		const none = createPriceBlock({ strings });
		expect((await none.actions.setVariant({ price: '1' })).ok).toBe(false);
		await none.actions.setItem({ title: 'No price' });
		expect(none.state().status).toBe('empty');
	});
});

describe('headless/structuredData', () => {
	it('builds Product JSON-LD with the condition mapping and item.viewed data', async () => {
		const data = createStructuredData({
			config: {
				condition_map: { refurbished: ['Grade B'] },
				price_valid_days: 10,
				seller_name: 'Shop',
				track_item_viewed: true,
			},
			strings,
			now: () => Date.UTC(2026, 9, 1),
		});
		await data.actions.load({ read: () => ({ ...ITEM, condition: 'Grade B' }), context: { url: 'https://shop.example/lamp' } });
		const state = data.state();
		expect(state.node).toMatchObject({
			'@type': 'Product',
			itemCondition: 'https://schema.org/RefurbishedCondition',
			offers: { priceValidUntil: '2026-10-11', seller: { name: 'Shop' } },
		});
		expect(JSON.parse(state.json)).toEqual(state.node);
		expect(state.viewed).toEqual({ itemId: 'itm_1', price: { amount: 4990, currency: 'USD' } });
	});

	it('skips pages that already carry Product markup and honours the default condition', async () => {
		const data = createStructuredData({ config: { default_condition: 'new', condition_map: { used: 'x' } }, strings });
		await data.actions.load({ read: () => ITEM, context: { hasProductJsonLd: true } });
		expect(data.state()).toMatchObject({ node: null, json: '', skipped: true, viewed: null });
		const always = createStructuredData({ config: { skip_if_present: false, default_condition: 'new' }, strings });
		await always.actions.load({ read: () => ITEM, context: { hasProductJsonLd: true } });
		expect(always.state().node?.itemCondition).toBe('https://schema.org/NewCondition');
		const empty = createStructuredData({ strings });
		await empty.actions.load();
		expect(empty.state()).toMatchObject({ status: 'empty', node: null });
	});
});

describe('headless/embed', () => {
	/** @param {Array<{ key: string, status: string }>} list @param {Record<string, unknown>} [mounted] */
	const loader = (list, mounted = {}) => {
		/** @type {Map<string, () => void>} */
		const handlers = new Map();
		return {
			handlers,
			list: () => list,
			get: (/** @type {string} */ key) => mounted[key],
			on: (/** @type {string} */ type, /** @type {() => void} */ handler) => {
				handlers.set(type, handler);
				return () => handlers.delete(type);
			},
		};
	};

	it('is absent without the other product, active while its element is mounted', async () => {
		const sent = events();
		const reviews = createReviewsBlock({ strings, emit: sent.emit });
		expect(reviews.state()).toMatchObject({ key: 'reviews_block', target: 'display', status: 'idle', refresh: true });
		expect(await reviews.actions.connect(null)).toMatchObject({ ok: false, error: { code: 'elements_unavailable' } });
		expect(reviews.state().status).toBe('absent');

		const list = [{ key: 'display', status: 'armed' }];
		/** @type {Record<string, unknown>} */
		const mounted = {};
		const api = loader(list, mounted);
		expect((await reviews.actions.connect(api)).ok).toBe(true);
		expect(reviews.state().status).toBe('waiting');
		list[0] = { key: 'display', status: 'mounted' };
		mounted.display = { actions: {} };
		api.handlers.get('display.shown')?.();
		expect(reviews.state().status).toBe('active');
		expect(sent.list).toEqual([['embedded', { target: 'display' }]]);
		await reviews.actions.recheck();
		reviews.destroy();
		expect(api.handlers.size).toBe(0);
	});

	it('targets a configured element key and validates targets', async () => {
		const alerts = createAlertsBlock({ config: { target: 'notify_me' }, strings });
		expect(alerts.state().target).toBe('notify_me');
		await alerts.actions.connect(loader([]));
		expect(alerts.state().status).toBe('absent');
		expect(createDealPill({ config: { target: 'Bad Key' } }).state().target).toBe(EMBED_TARGETS.deal_pill);
		expect(createConfiguratorEmbed({ strings }).validate({ target: 'Bad Key' })[0]).toMatchObject({ code: 'target_invalid' });
		expect(createGradeShowcase({ strings }).validate({ target: 'ok_key' })).toEqual([]);
		const noOn = createGradeShowcase({});
		await noOn.actions.connect({ list: () => [{ key: 'showcase', status: 'mounted' }], get: () => undefined });
		expect(noOn.state().status).toBe('waiting');
		await createGradeShowcase({}).actions.recheck();
	});
});

describe('headless/related', () => {
	it('selects related items from the page or the list URL', async () => {
		const sent = events();
		const related = createRelated({
			config: { strategy: 'same_brand', list_url: 'https://a.example/{brand}.json' },
			strings,
			emit: sent.emit,
		});
		/** @type {string[]} */
		const urls = [];
		await related.actions.load({
			read: () => ITEM,
			fetchJson: async (url) => {
				urls.push(url);
				return {
					items: [
						{ id: 'b', title: 'B', url: '/b', brand: 'Acme', price: 5 },
						{ id: 'c', title: 'C', url: '/c', brand: 'Other' },
					],
				};
			},
			context: { locale: 'en-US' },
		});
		expect(urls).toEqual(['https://a.example/Acme.json']);
		expect(related.state().items).toEqual([expect.objectContaining({ id: 'b', priceText: '$5.00' })]);
		await related.actions.open(0);
		await related.actions.open(5);
		expect(sent.list).toEqual([['clicked', { index: 0, itemId: 'b' }]]);
	});

	it('keeps the page list when the list URL fails or is not https', async () => {
		const sent = events();
		const failing = createRelated({
			config: { list_url: 'https://a.example/x.json', show_price: false },
			strings,
			emit: sent.emit,
		});
		await failing.actions.load({
			read: () => ({ ...ITEM, related: [{ title: 'P', url: '/p', price: 1 }] }),
			fetchJson: async () => {
				throw new Error('down');
			},
		});
		expect(failing.state().items).toEqual([expect.objectContaining({ title: 'P', priceText: '' })]);
		expect(sent.list).toEqual([['source_failed', {}]]);
		const insecure = createRelated({ config: { list_url: 'http://a.example/x.json' }, strings });
		await insecure.actions.load({ read: () => ITEM, fetchJson: async () => [] });
		expect(insecure.state().items).toEqual([]);
		const array = createRelated({ config: { list_url: 'https://a.example/x.json' }, strings });
		await array.actions.load({ read: () => ITEM, fetchJson: async () => [{ title: 'Z', url: '/z' }] });
		expect(array.state().items).toHaveLength(1);
		const odd = createRelated({ config: { list_url: 'https://a.example/x.json' }, strings });
		await odd.actions.load({ read: () => ITEM, fetchJson: async () => 'nope' });
		expect(odd.state().items).toEqual([]);
		const empty = createRelated({ strings });
		await empty.actions.load({ read: () => ({}) });
		expect(empty.state().status).toBe('empty');
	});
});

describe('headless/faq', () => {
	it('merges item and manual questions, dedupes, caps and builds FAQPage JSON-LD', async () => {
		const sent = events();
		const faq = createFaq({
			config: {
				entries: [
					{ question: 'Shipping?', answer: 'Fast' },
					{ question: 'washable?', answer: 'dup' },
				],
				count: 2,
			},
			strings,
			emit: sent.emit,
		});
		await faq.actions.load({ read: () => ITEM, context: { url: 'https://shop.example/lamp' } });
		expect(faq.state().entries.map((entry) => entry.question)).toEqual(['Washable?', 'Shipping?']);
		expect(JSON.parse(faq.state().json)).toMatchObject({ '@type': 'FAQPage', url: 'https://shop.example/lamp' });
		await faq.actions.opened(1);
		await faq.actions.opened(9);
		expect(sent.list).toEqual([['opened', { index: 1 }]]);
		const manual = createFaq({
			config: { source: 'manual', structured_data: false, entries: [{ question: 'Q', answer: 'A' }] },
			strings,
		});
		await manual.actions.load({ read: () => ITEM });
		expect(manual.state()).toMatchObject({ json: '', entries: [{ question: 'Q', answer: 'A' }] });
		const itemOnly = createFaq({ config: { source: 'item', entries: [{ question: 'Q', answer: 'A' }] }, strings });
		await itemOnly.actions.setItem(ITEM);
		expect(itemOnly.state().entries).toHaveLength(1);
		const none = createFaq({});
		await none.actions.load();
		expect(none.state().entries).toEqual([]);
	});
});

describe('headless/stickyBuyBar', () => {
	it('shows by rule and asks the renderer to press the page button', async () => {
		const sent = events();
		const bar = createStickyBuyBar({ config: { locale: 'en-US', dismissible: true }, strings, emit: sent.emit });
		await bar.actions.load({ read: () => ITEM });
		expect(bar.state()).toMatchObject({ visible: false, price: '$49.90', availability: 'in_stock' });
		expect((await bar.actions.buy()).ok).toBe(false);
		await bar.actions.setViewport({ width: 375, ctaVisible: false, scrolled: 150 });
		expect(bar.state().visible).toBe(true);
		expect(await bar.actions.buy()).toEqual({ ok: true, value: 'click' });
		await bar.actions.setViewport({ device: 'desktop' });
		expect(bar.state().visible).toBe(false);
		await bar.actions.setViewport({ device: 'mobile' });
		expect((await bar.actions.dismiss()).ok).toBe(true);
		expect(bar.state().visible).toBe(false);
		expect(sent.list).toEqual([
			['clicked', { action: 'click' }],
			['dismissed', {}],
		]);
	});

	it('honours the scroll mode, unavailable items and non-dismissible bars', async () => {
		const bar = createStickyBuyBar({
			config: { mode: 'after_scroll', scroll_percent: 50, devices: ['desktop'], show_price: false, action: 'scroll' },
			strings,
		});
		await bar.actions.setItem({ ...ITEM, availability: 'OutOfStock' });
		await bar.actions.setViewport({ width: 1400, scrolled: 80 });
		expect(bar.state().visible).toBe(false);
		const keep = createStickyBuyBar({ config: { hide_unavailable: false, mode: 'always', action: 'scroll' }, strings });
		await keep.actions.setItem({ ...ITEM, availability: 'OutOfStock' });
		await keep.actions.setViewport({ device: 'unknown' });
		expect(keep.state()).toMatchObject({ visible: true, price: '$49.90' });
		expect(await keep.actions.buy()).toEqual({ ok: true, value: 'scroll' });
		expect((await keep.actions.dismiss()).ok).toBe(false);
		expect(bar.state().price).toBe('');
	});
});

describe('headless/share', () => {
	it('builds share links with UTM tags and reports shares', async () => {
		const sent = events();
		const share = createShare({ config: { channels: ['copy', 'x', 'pinterest'], utm: true }, strings, emit: sent.emit });
		await share.actions.load({ read: () => ITEM, context: { url: 'https://shop.example/lamp' } });
		const links = share.state().links;
		expect(links.map((link) => link.channel)).toEqual(['copy', 'x', 'pinterest']);
		expect(links[0]?.url).toBe('https://shop.example/shirts/linen?utm_source=copy&utm_medium=share');
		expect(links[2]?.href).toContain(encodeURIComponent('https://shop.example/1.jpg'));
		expect((await share.actions.share('x')).ok).toBe(true);
		expect((await share.actions.share('email')).ok).toBe(false);
		await share.actions.copied(true);
		expect(share.state().copied).toBe(true);
		expect(sent.list).toEqual([['shared', { channel: 'x' }]]);
		const nothing = createShare({});
		await nothing.actions.load();
		expect(nothing.state().links).toEqual([]);
	});
});

describe('headless/hostedPage', () => {
	it('matches the route, reads the item with the route parameters and builds metadata', async () => {
		const page = createHostedPage({
			config: { source_url: 'https://api.example/items/{slug}.json', robots: 'noindex', slots: ['gallery', 'Bad Slot'] },
			strings,
		});
		/** @type {string[]} */
		const urls = [];
		await page.actions.load({
			fetchJson: async (url) => {
				urls.push(url);
				return { ...ITEM, description: 'A lamp.' };
			},
			context: { path: '/p/linen-shirt', url: 'https://shop.example/p/linen-shirt?x=1' },
		});
		expect(urls).toEqual(['https://api.example/items/linen-shirt.json']);
		expect(page.state()).toMatchObject({
			matched: true,
			slots: ['gallery'],
			meta: {
				title: 'Linen shirt',
				description: 'A lamp.',
				canonical: 'https://shop.example/p/linen-shirt',
				robots: 'noindex',
			},
		});
		const other = createHostedPage({
			config: { canonical_url: 'https://shop.example/items/{slug}', set_title: false, set_description: false },
			strings,
		});
		await other.actions.load({ read: () => ITEM, context: { path: '/p/lamp' } });
		expect(other.state().meta).toEqual({
			title: '',
			description: '',
			canonical: 'https://shop.example/items/lamp',
			robots: 'index',
		});
		const mismatch = createHostedPage({ strings });
		expect(await mismatch.actions.load({ read: () => ITEM, context: { path: '/shop' } })).toMatchObject({
			ok: false,
			problem: { code: 'route_mismatch' },
		});
		expect(mismatch.state()).toMatchObject({ status: 'empty', matched: false });
		expect((await createHostedPage({}).actions.load()).ok).toBe(false);
	});
});
