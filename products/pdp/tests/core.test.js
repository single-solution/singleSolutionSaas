import { describe, expect, it } from 'vitest';
import { altText, fillText, formatMoney, itemViewedData, minorUnits, savings } from '../core/display.js';
import {
	ITEM_FIELDS,
	mapFields,
	mergeRaw,
	normaliseItem,
	parseAvailability,
	parseCurrency,
	parsePrice,
	validateItem,
	vocabulary,
} from '../core/item.js';
import { absolute, compact, faqJsonLd, priceValidUntil, productJsonLd, resolveCondition, scriptJson } from '../core/jsonld.js';
import { deviceOf, elementStatus, matchRoute, selectRelated, shareHref, shareTarget, stickyVisible } from '../core/page.js';
import { itemFromSnapshot } from '../core/snapshot.js';
import { bool, fillUrl, int, isHttpsUrl, oneOf, pick, safeUrl, someOf, text } from '../core/util.js';

describe('core/util', () => {
	it('bounds untrusted values', () => {
		expect(text('  a \n b  ')).toBe('a b');
		expect(text(12.5)).toBe('12.5');
		expect(text(Number.NaN)).toBe('');
		expect(text({})).toBe('');
		expect(text('😀😀😀', 2)).toBe('😀😀');
		expect(int('42', 0, 100, 1)).toBe(42);
		expect(int(4.2, 0, 100, 1)).toBe(1);
		expect(int(200, 0, 100, 1)).toBe(1);
		expect(int('x', 0, 100, 7)).toBe(7);
		expect(oneOf('b', ['a', 'b'], 'a')).toBe('b');
		expect(oneOf('z', ['a', 'b'], 'a')).toBe('a');
		expect(bool('yes', false)).toBe(false);
		expect(bool(true, false)).toBe(true);
		expect(someOf(['a', 'x', 'a'], ['a', 'b'], ['b'])).toEqual(['a']);
		expect(someOf('a', ['a', 'b'], ['b'])).toEqual(['b']);
	});

	it('allows only http(s) and relative URLs', () => {
		expect(safeUrl('https://cdn.example/a.jpg')).toBe('https://cdn.example/a.jpg');
		expect(safeUrl('http://cdn.example/a.jpg')).toBe('http://cdn.example/a.jpg');
		expect(safeUrl('/img/a.jpg')).toBe('/img/a.jpg');
		expect(safeUrl('img/a.jpg')).toBe('img/a.jpg');
		expect(safeUrl('javascript:alert(1)')).toBe('');
		expect(safeUrl('data:image/png;base64,AAAA')).toBe('');
		expect(safeUrl('//evil.example/x')).toBe('');
		expect(safeUrl('https://x/"onerror=')).toBe('');
		expect(safeUrl(`https://x/${'a'.repeat(2100)}`)).toBe('');
		expect(isHttpsUrl('https://api.example/items/1.json')).toBe(true);
		expect(isHttpsUrl('http://api.example/items/1.json')).toBe(false);
		expect(isHttpsUrl('/items/1.json')).toBe(false);
	});

	it('fills URL templates with encoded values and picks dot paths', () => {
		expect(fillUrl('https://a.example/{slug}?q={missing}', { slug: 'a b/c' })).toBe('https://a.example/a%20b%2Fc?q=');
		const json = { data: { items: [{ name: 'X' }] } };
		expect(pick(json, 'data.items.0.name')).toBe('X');
		expect(pick(json, '')).toBe(json);
		expect(pick(json, 'data.nope')).toBeUndefined();
		expect(pick(json, 'data.toString')).toBeUndefined();
		expect(pick(json, Array.from({ length: 13 }, () => 'a').join('.'))).toBeUndefined();
	});
});

describe('core/item', () => {
	it('parses prices, currencies, availability and vocabulary tokens', () => {
		expect(parsePrice(1299)).toBe('1299');
		expect(parsePrice('0099.50')).toBe('99.50');
		expect(parsePrice('1,299.00')).toBe('');
		expect(parsePrice(-1)).toBe('');
		expect(parsePrice(Number.POSITIVE_INFINITY)).toBe('');
		expect(parseCurrency('eur')).toBe('EUR');
		expect(parseCurrency('euro')).toBe('');
		expect(vocabulary('https://schema.org/InStock')).toBe('instock');
		expect(parseAvailability('https://schema.org/InStock')).toBe('in_stock');
		expect(parseAvailability('SoldOut')).toBe('out_of_stock');
		expect(parseAvailability('PreOrder')).toBe('preorder');
		expect(parseAvailability('', 3)).toBe('in_stock');
		expect(parseAvailability(undefined, '0')).toBe('out_of_stock');
		expect(parseAvailability('whatever')).toBe('');
	});

	it('normalises a raw item into a bounded, frozen model', () => {
		const item = normaliseItem({
			id: 'itm_1',
			name: 'Linen shirt',
			brand: { name: 'Acme' },
			description: '<b>Soft</b>   linen',
			url: '/shirts/linen',
			gtin: '0123456789012',
			price: '49.90',
			compareAtPrice: 59.9,
			currency: 'usd',
			availability: 'InStock',
			images: [
				'https://cdn.example/1.jpg',
				{ url: '/2.jpg', alt: 'Back', width: '800', height: 600, srcset: '/2.jpg 1x, /2@2x.jpg 2x' },
				{ type: 'video', src: '/v.mp4', poster: '/p.jpg' },
				{ src: 'javascript:alert(1)' },
				42,
			],
			ratingValue: '4.567',
			ratingCount: 12,
			faq: [{ q: 'Washable?', a: 'Yes' }, { question: 'No answer' }],
			related: [{ title: 'Other', url: '/o', images: [{ src: '/o.jpg' }], price: 10 }, { title: 'No URL' }],
			attributes: { Material: 'Linen', Empty: '' },
		});
		expect(Object.isFrozen(item)).toBe(true);
		expect(item).toMatchObject({
			id: 'itm_1',
			title: 'Linen shirt',
			brand: 'Acme',
			description: '<b>Soft</b> linen',
			price: '49.90',
			compareAtPrice: '59.9',
			currency: 'USD',
			availability: 'in_stock',
			gtin: '0123456789012',
			ratingValue: 4.57,
			ratingCount: 12,
		});
		expect(item.images.map((image) => image.type)).toEqual(['image', 'image', 'video']);
		expect(item.images[1]).toMatchObject({ src: '/2.jpg', alt: 'Back', width: 800, height: 600 });
		expect(item.faq).toEqual([{ question: 'Washable?', answer: 'Yes' }]);
		expect(item.related).toEqual([expect.objectContaining({ title: 'Other', image: '/o.jpg', price: '10' })]);
		expect(item.attributes).toEqual([{ name: 'Material', value: 'Linen' }]);
		expect(normaliseItem(null).title).toBe('');
		expect(normaliseItem({ gtin: '12ab', ratingValue: 9, ratingCount: 1 })).toMatchObject({ gtin: '', ratingValue: 0 });
		expect(normaliseItem({ attributes: [{ name: 'Size', value: 'M' }, 'x'] }).attributes).toEqual([
			{ name: 'Size', value: 'M' },
		]);
		expect(normaliseItem({ images: Array.from({ length: 80 }, (_, i) => `/${i}.jpg`) }).images).toHaveLength(50);
	});

	it('maps merchant JSON fields and overlays raw data', () => {
		const json = { data: { product: { name: 'Lamp', cost: { amount: '20' }, currency: 'EUR' } } };
		expect(mapFields(json, { root: 'data.product', title: 'name', price: 'cost.amount' })).toEqual({
			title: 'Lamp',
			price: '20',
			currency: 'EUR',
		});
		expect(mapFields([1], {})).toEqual({});
		expect(mergeRaw({ title: 'A', price: '1' }, { title: '', price: '2', images: [], foo: 'x' })).toEqual({
			title: 'A',
			price: '2',
		});
		expect(ITEM_FIELDS).toContain('compareAtPrice');
	});

	it('validates raw item data', () => {
		expect(validateItem('x')).toEqual([{ path: '', code: 'item_invalid' }]);
		expect(validateItem({ title: 'A', price: '1', currency: 'EUR' })).toEqual([]);
		expect(validateItem({ price: 'abc' }).map((p) => p.code)).toEqual(['title_required', 'price_invalid']);
		expect(validateItem({ title: 'A', price: '5' }).map((p) => p.code)).toEqual(['currency_required']);
	});
});

describe('core/display', () => {
	it('formats money with the locale and currency it is given', () => {
		expect(formatMoney('', 'EUR')).toBe('');
		expect(formatMoney('1234.5', 'EUR', { locale: 'de-DE' })).toMatch(/^1\.234,50\s€$/u);
		expect(formatMoney('1234.5', 'USD', { locale: 'en-US', display: 'code', digits: 0 })).toMatch(/USD\s?1,235/);
		expect(formatMoney('1500', 'JPY', { locale: 'ja-JP' })).toMatch(/1,500/);
		expect(formatMoney('12', '', { locale: 'en-US' })).toBe('12');
		expect(formatMoney('12', 'EUR', { locale: 'not a locale!' })).toMatch(/12/);
	});

	it('computes savings exactly', () => {
		expect(savings('80', '100')).toEqual({ amount: '20', percent: 20 });
		expect(savings('0.1', '0.3')).toEqual({ amount: '0.2', percent: 67 });
		expect(savings('100', '80')).toBeNull();
		expect(savings('', '80')).toBeNull();
		expect(savings('1', '0')).toBeNull();
	});

	it('builds alt text from the template unless the merchant wrote one', () => {
		const base = { title: 'Lamp', brand: 'Acme', template: '{brand} {title} ({index}/{total})', single: '{title}' };
		expect(altText({ ...base, stored: '', index: 1, total: 3 })).toBe('Acme Lamp (2/3)');
		expect(altText({ ...base, stored: 'lamp', index: 0, total: 1 })).toBe('Lamp');
		expect(altText({ ...base, stored: 'Brass lamp, lit', index: 0, total: 3 })).toBe('Brass lamp, lit');
		const long = altText({ ...base, stored: 'x'.repeat(200), index: 0, total: 1 });
		expect([...long]).toHaveLength(125);
		expect(long.endsWith('…')).toBe(true);
		expect(fillText('{a} {b}', { a: 1 })).toBe('1 {b}');
	});

	it('converts prices to minor units for item.viewed@1', () => {
		expect(minorUnits('12.5', 'EUR')).toBe(1250);
		expect(minorUnits('1500', 'JPY')).toBe(1500);
		expect(minorUnits('1', 'XYZ1')).toBeNull();
		expect(minorUnits('', 'EUR')).toBeNull();
		const item = normaliseItem({ id: 'itm_1', price: '9.99', currency: 'USD' });
		expect(itemViewedData(item)).toEqual({ itemId: 'itm_1', price: { amount: 999, currency: 'USD' } });
		expect(itemViewedData(normaliseItem({ id: 'sku 1' }))).toBeNull();
		expect(itemViewedData(normaliseItem({ id: 'a1' }))).toEqual({ itemId: 'a1' });
	});
});

describe('core/jsonld', () => {
	const item = normaliseItem({
		id: 'itm_1',
		title: 'Linen shirt',
		brand: 'Acme',
		description: 'Soft linen',
		url: '/shirts/linen',
		sku: 'LS-1',
		price: '49.90',
		currency: 'USD',
		availability: 'in_stock',
		condition: 'Grade A',
		images: ['/1.jpg', { type: 'video', src: '/v.mp4' }],
		ratingValue: 4.5,
		ratingCount: 3,
	});

	it('maps conditions through the merchant mapping, then schema.org tokens', () => {
		expect(resolveCondition('Grade A', { used: ['grade a'] }, '')).toBe('used');
		expect(resolveCondition('https://schema.org/RefurbishedCondition', {}, '')).toBe('refurbished');
		expect(resolveCondition('new', {}, '')).toBe('new');
		expect(resolveCondition('Mint', {}, 'used')).toBe('used');
		expect(resolveCondition('', {}, '')).toBe('');
	});

	it('emits a valid schema.org Product with an Offer', () => {
		const node = productJsonLd(item, {
			pageUrl: 'https://shop.example/shirts/linen?ref=x',
			condition: 'used',
			validUntil: priceValidUntil(Date.UTC(2026, 0, 1), 30),
			seller: 'Acme Store',
			offer: true,
			rating: true,
		});
		expect(node).toEqual({
			'@context': 'https://schema.org',
			'@type': 'Product',
			'@id': 'https://shop.example/shirts/linen#product',
			name: 'Linen shirt',
			description: 'Soft linen',
			url: 'https://shop.example/shirts/linen',
			image: ['https://shop.example/1.jpg'],
			sku: 'LS-1',
			brand: { '@type': 'Brand', name: 'Acme' },
			itemCondition: 'https://schema.org/UsedCondition',
			aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.5, reviewCount: 3, bestRating: 5, worstRating: 1 },
			offers: {
				'@type': 'Offer',
				url: 'https://shop.example/shirts/linen',
				price: '49.90',
				priceCurrency: 'USD',
				priceValidUntil: '2026-01-31',
				availability: 'https://schema.org/InStock',
				itemCondition: 'https://schema.org/UsedCondition',
				seller: { '@type': 'Organization', name: 'Acme Store' },
			},
		});
	});

	it('never invents values', () => {
		const bare = productJsonLd(normaliseItem({ title: 'Thing', price: '5' }), {
			pageUrl: '',
			condition: '',
			validUntil: '',
			seller: '',
			offer: true,
			rating: true,
		});
		expect(bare).toEqual({ '@context': 'https://schema.org', '@type': 'Product', name: 'Thing' });
		expect(
			productJsonLd(normaliseItem({}), { pageUrl: '', condition: '', validUntil: '', seller: '', offer: true, rating: true }),
		).toBeNull();
		expect(
			productJsonLd(item, {
				pageUrl: 'https://s.example/',
				condition: '',
				validUntil: '',
				seller: '',
				offer: false,
				rating: false,
			}),
		).not.toHaveProperty('offers');
		expect(priceValidUntil(0, 0)).toBe('');
		expect(compact({ a: '', b: [], c: { '@type': 'X' }, d: { '@type': 'Y', e: 1 } })).toEqual({ d: { '@type': 'Y', e: 1 } });
		expect(absolute('/a', 'not a url')).toBe('');
		expect(absolute('ftp://x/a', '')).toBe('');
	});

	it('builds FAQPage markup and escapes script text', () => {
		expect(faqJsonLd([], 'https://s.example/')).toBeNull();
		expect(faqJsonLd([{ question: 'Q?', answer: 'A' }], 'https://s.example/p')).toEqual({
			'@context': 'https://schema.org',
			'@type': 'FAQPage',
			url: 'https://s.example/p',
			mainEntity: [{ '@type': 'Question', name: 'Q?', acceptedAnswer: { '@type': 'Answer', text: 'A' } }],
		});
		const text = scriptJson({ name: '</script><script>alert(1)</script>  ' });
		expect(text).not.toContain('<');
		expect(text).toContain('\\u2028');
		expect(JSON.parse(text).name).toContain('</script>');
	});
});

describe('core/page', () => {
	it('matches route patterns', () => {
		expect(matchRoute('/p/{slug}', '/p/linen%20shirt')).toEqual({ slug: 'linen shirt' });
		expect(matchRoute('/p/{slug}', '/p/linen/')).toEqual({ slug: 'linen' });
		expect(matchRoute('/{category}/*/{id}', '/shirts/x/42?a=1')).toEqual({ category: 'shirts', id: '42' });
		expect(matchRoute('/p/{slug}', '/q/linen')).toBeNull();
		expect(matchRoute('/p/{slug}', '/p')).toBeNull();
		expect(matchRoute('/p/{slug}', '/p/a/b')).toBeNull();
		expect(matchRoute('/p/*', '/p//')).toBeNull();
		expect(matchRoute('/p/{slug}', '/p/%E0%A4%A')).toBeNull();
		expect(matchRoute('p/{slug}', '/p/a')).toBeNull();
	});

	it('selects related items by strategy, never the item itself', () => {
		const item = normaliseItem({ id: 'a', title: 'A', url: '/a', brand: 'Acme', category: 'Lamps' });
		const list = normaliseItem({
			related: [
				{ id: 'a', title: 'A again', url: '/a2' },
				{ title: 'Same URL', url: '/a' },
				{ id: 'b', title: 'B', url: '/b', brand: 'acme', category: 'Chairs' },
				{ id: 'c', title: 'C', url: '/c', brand: 'Other', category: 'lamps' },
			],
		}).related;
		expect(selectRelated(item, list, { strategy: 'provided', count: 4 }).map((e) => e.id)).toEqual(['b', 'c']);
		expect(selectRelated(item, list, { strategy: 'same_brand', count: 4 }).map((e) => e.id)).toEqual(['b']);
		expect(selectRelated(item, list, { strategy: 'same_category', count: 4 }).map((e) => e.id)).toEqual(['c']);
		expect(selectRelated(item, list, { strategy: 'provided', count: 1 })).toHaveLength(1);
	});

	it('builds share links and UTM-tagged targets', () => {
		expect(shareHref('whatsapp', { url: 'https://s.example/p?a=1', text: 'Hi & bye', image: '' })).toBe(
			'https://wa.me/?text=Hi%20%26%20bye%20https%3A%2F%2Fs.example%2Fp%3Fa%3D1',
		);
		expect(shareHref('email', { url: 'https://s.example/', text: 'T', image: '' })).toBe(
			'mailto:?subject=T&body=https%3A%2F%2Fs.example%2F',
		);
		expect(shareHref('native', { url: 'u', text: 't', image: '' })).toBe('');
		expect(shareTarget('https://s.example/p', 'x', true)).toBe('https://s.example/p?utm_source=x&utm_medium=share');
		expect(shareTarget('https://s.example/p', 'x', false)).toBe('https://s.example/p');
		expect(shareTarget('mailto:a@b.c', 'x', true)).toBe('mailto:a@b.c');
		expect(shareTarget('nope', 'x', true)).toBe('nope');
	});

	it('decides sticky-bar visibility', () => {
		const rules = { devices: ['mobile'], mode: /** @type {const} */ ('after_cta'), scrollPercent: 30, hideUnavailable: true };
		const view = { device: 'mobile', ctaVisible: false, scrolled: 0, available: true, dismissed: false };
		expect(deviceOf(375)).toBe('mobile');
		expect(deviceOf(800)).toBe('tablet');
		expect(deviceOf(1280)).toBe('desktop');
		expect(stickyVisible(rules, view)).toBe(true);
		expect(stickyVisible(rules, { ...view, ctaVisible: true })).toBe(false);
		expect(stickyVisible(rules, { ...view, device: 'desktop' })).toBe(false);
		expect(stickyVisible(rules, { ...view, available: false })).toBe(false);
		expect(stickyVisible(rules, { ...view, dismissed: true })).toBe(false);
		expect(stickyVisible({ ...rules, mode: 'always' }, { ...view, ctaVisible: true })).toBe(true);
		expect(stickyVisible({ ...rules, mode: 'after_scroll' }, { ...view, scrolled: 10 })).toBe(false);
		expect(stickyVisible({ ...rules, mode: 'after_scroll' }, { ...view, scrolled: 40 })).toBe(true);
	});

	it('reads another product element status from the Loader list', () => {
		const list = [
			{ key: 'display', status: 'mounted' },
			{ key: 'capture', status: 'armed' },
			{ key: 'badges', status: 'failed' },
		];
		expect(elementStatus(list, 'display')).toBe('active');
		expect(elementStatus(list, 'capture')).toBe('waiting');
		expect(elementStatus(list, 'badges')).toBe('absent');
		expect(elementStatus(list, 'widget')).toBe('absent');
		expect(elementStatus(null, 'widget')).toBe('absent');
	});
});

describe('core/snapshot', () => {
	it('reads meta, attributes, media and inline JSON with increasing precedence', () => {
		const raw = itemFromSnapshot({
			meta: [
				['og:title', 'Meta title'],
				['og:image', 'https://cdn.example/og.jpg'],
				['product:price:amount', '10'],
				['product:price:currency', 'EUR'],
				['product:brand', 'Meta brand'],
				['product:brand', 'Second brand'],
				['ss:item-id', 'itm_meta'],
				['ss:item:compare-at-price', '12'],
				['description', ''],
				['viewport', 'width=device-width'],
			],
			attributes: {
				'data-ss-item-id': 'itm_attr',
				'data-ss-item-title': 'Attr title',
				'data-ss-item-rating': '4',
				'data-ss-item-image': 'x',
			},
			media: [
				{
					tag: 'img',
					src: '/a.jpg',
					alt: 'A',
					width: '10',
					height: '10',
					srcset: null,
					'data-ss-zoom': '/a-big.jpg',
					poster: null,
				},
			],
			json: JSON.stringify({ title: 'JSON title', faq: [{ question: 'Q', answer: 'A' }] }),
		});
		expect(raw).toMatchObject({
			id: 'itm_attr',
			title: 'JSON title',
			price: '10',
			currency: 'EUR',
			brand: 'Meta brand',
			compareAtPrice: '12',
			ratingValue: '4',
			faq: [{ question: 'Q', answer: 'A' }],
		});
		expect(raw.images).toEqual([expect.objectContaining({ type: 'image', src: '/a.jpg', zoom: '/a-big.jpg' })]);
		expect(itemFromSnapshot({ meta: [['og:image', '/og.jpg']] }).images).toEqual(['/og.jpg']);
		expect(itemFromSnapshot({ json: '{broken' })).toEqual({});
		expect(itemFromSnapshot({ json: '[1]' })).toEqual({});
		expect(itemFromSnapshot({ json: 'x'.repeat(300_000) })).toEqual({});
		expect(itemFromSnapshot({ media: [{ tag: 'video', 'data-ss-item-image': '/v.mp4', poster: '/p.jpg' }] }).images).toEqual([
			expect.objectContaining({ type: 'video', src: '/v.mp4', poster: '/p.jpg' }),
		]);
		expect(itemFromSnapshot({})).toEqual({});
	});
});
