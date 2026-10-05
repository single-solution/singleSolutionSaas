import { describe, expect, it } from 'vitest';
import { cardConfig, cardView, chipSlides } from '../core/card.js';
import { dealsOf, timeLeft } from '../core/deals.js';
import { DEFAULT_FIELDS, attributesOf, digitsOf, fieldMap, formatMoney, recordsOf, toItem, toItems } from '../core/items.js';
import { chooseMedia, heroConfig } from '../core/media.js';
import { activeTab, contactHref, footerOf, navCards, tabsOf } from '../core/nav.js';
import { applyQuery, comparator, facetsOf, hasFilters, pageWindow, parseQuery, toSearch, valuesOf } from '../core/query.js';
import { pickItems } from '../core/select.js';
import { apiUrl, catalogParams, facetCountsOf, sourceConfig } from '../core/source.js';
import { cssValue, fontOf, themeCss, themeVars } from '../core/theme.js';
import { at, bool, first, hash, int, objects, oneOf, safeUrl, str, strings } from '../core/util.js';
import { ITEMS } from './helpers.js';

const items = () => toItems(ITEMS, fieldMap({}));

describe('core/util', () => {
	it('reads typed config values with fallbacks and bounds', () => {
		expect(int(5, 1, 0, 3)).toBe(3);
		expect(int('5', 1, 0, 3)).toBe(1);
		expect(str('  hi  ', 'x', 1)).toBe('h');
		expect(str(1, 'x')).toBe('x');
		expect(bool('yes', true)).toBe(true);
		expect(oneOf('b', ['a', 'b'], 'a')).toBe('b');
		expect(oneOf('c', ['a', 'b'], 'a')).toBe('a');
		expect(strings([' a ', '', 3, 'b'], 1)).toEqual(['a']);
		expect(strings('a')).toEqual([]);
		expect(objects([{}, 1, null, { a: 1 }], 5)).toEqual([{}, { a: 1 }]);
		expect(objects('x', 5)).toEqual([]);
	});

	it('accepts only safe links and media sources', () => {
		expect(safeUrl('/a?b#c')).toBe('/a?b#c');
		expect(safeUrl('https://x.example/y')).toBe('https://x.example/y');
		expect(safeUrl('mailto:a@b.co')).toBe('mailto:a@b.co');
		expect(safeUrl('mailto:a@b.co', { src: true })).toBeNull();
		expect(safeUrl('javascript:alert(1)')).toBeNull();
		expect(safeUrl('data:text/html,x', { src: true })).toBeNull();
		expect(safeUrl('//evil.example')).toBeNull();
		expect(safeUrl('/a b')).toBeNull();
		expect(safeUrl('')).toBeNull();
		expect(safeUrl(5)).toBeNull();
	});

	it('hashes stably and reads nested paths', () => {
		expect(hash('abc', 4)).toBe(hash('abc', 4));
		expect(hash('abc', 0)).toBe(0);
		expect(at({ a: [{ b: 1 }] }, 'a.0.b')).toBe(1);
		expect(at({ a: 1 }, 'a.b')).toBeUndefined();
		expect(first({ b: '', c: 2 }, 'a|b|c')).toBe(2);
		expect(first({}, 'a')).toBeUndefined();
	});
});

describe('core/items', () => {
	it('maps any JSON shape through the field map', () => {
		expect(fieldMap({ title: 'name', id: '', bogus: 'x' })).toEqual({ ...DEFAULT_FIELDS, title: 'name' });
		expect(fieldMap(null)).toEqual(DEFAULT_FIELDS);
		const item = toItem(
			{
				sku: 7,
				name: 'Thing',
				link: 'javascript:x',
				images: [{ url: 'https://c.example/t.png', alt: 'A thing' }],
				price: { amount: 100, currency: 'USD' },
				currency: 'usd',
			},
			fieldMap({}),
			3,
		);
		expect(item).toMatchObject({
			id: '7',
			title: 'Thing',
			href: null,
			image: 'https://c.example/t.png',
			imageAlt: 'A thing',
			price: 100,
			currency: null,
			order: 3,
		});
		expect(toItem({ id: 'x' }, fieldMap({}), 0)).toBeNull();
		expect(toItem('x', fieldMap({}), 0)).toBeNull();
	});

	it('reads variants, stock, attributes and the contracts item snapshot', () => {
		const [lamp, floor, chair] = items();
		expect(lamp?.inStock).toBe(true);
		expect(lamp?.variants.map((v) => v.attrs)).toEqual([{ colour: ['white'] }, { colour: ['black'] }]);
		expect(floor?.attrs.featured).toEqual(['true']);
		expect(chair?.inStock).toBe(false);
		const snapshot = toItem(
			{
				itemId: 'itm_9',
				title: 'Snap',
				currency: 'GBP',
				variants: [{ variantId: 'v', price: 700, inventory: 0 }, { price: 500 }],
			},
			fieldMap({}),
			0,
		);
		expect(snapshot).toMatchObject({ id: 'itm_9', price: 700, currency: 'GBP', inStock: false });
		expect(
			toItem({ id: 'a', title: 'B', variants: [{ price: 900 }, { price: 300 }] }, fieldMap({ price: 'none' }), 0)?.price,
		).toBe(300);
		expect(attributesOf({ a: [1, true, { x: 1 }], b: [], c: null })).toEqual({ a: ['1', 'true'] });
		expect(attributesOf('x')).toEqual({});
	});

	it('finds records, drops duplicates and caps', () => {
		expect(recordsOf({ data: [1] })).toEqual([1]);
		expect(recordsOf({ results: [2] })).toEqual([2]);
		expect(recordsOf({ nope: 1 })).toEqual([]);
		expect(toItems({ items: [...ITEMS, ITEMS[0]] }, fieldMap({})).length).toBe(5);
		expect(toItems(ITEMS, fieldMap({}), 2).length).toBe(2);
	});

	it('formats minor units with the currency’s own digits, never guessing a currency', () => {
		expect(digitsOf('EUR')).toBe(2);
		expect(digitsOf('JPY')).toBe(0);
		expect(digitsOf('KWD')).toBe(3);
		expect(digitsOf('nope')).toBe(2);
		expect(formatMoney(123456, 'EUR', 'en')).toBe('€1,234.56');
		expect(formatMoney(1234, 'JPY', 'en')).toBe('¥1,234');
		expect(formatMoney(1234, 'EUR', 'not a locale')).toContain('12.34');
		expect(formatMoney(1234, null)).toBe('');
		expect(formatMoney(null, 'EUR')).toBe('');
		expect(formatMoney(1, 'XX')).toBe('');
	});
});

describe('core/query', () => {
	const facets = facetsOf([
		{ key: 'brand' },
		{ key: 'colour', multi: false },
		{ key: 'price', type: 'values' },
		{ key: 'in_stock', type: 'toggle' },
		{ key: 'q' },
		{ key: 'Bad' },
		'x',
	]);

	it('declares facets (reserved and invalid keys dropped, price is a range)', () => {
		expect(facets.map((f) => [f.key, f.type, f.multi])).toEqual([
			['brand', 'values', true],
			['colour', 'values', false],
			['price', 'range', true],
			['in_stock', 'toggle', true],
		]);
		expect(facetsOf(null)).toEqual([]);
	});

	it('parses and writes the URL form, keeping unrelated parameters', () => {
		const query = parseQuery(
			'?brand=Lumo,Sitwell&brand=Lumo&colour=white,black&min=100&max=x&sort=price_asc&page=3&q=%20lamp%20&utm=1',
			{ facets },
		);
		expect(query).toEqual({
			q: 'lamp',
			sort: 'price_asc',
			page: 3,
			filters: { brand: ['Lumo', 'Sitwell'], colour: ['white'] },
			min: 100,
			max: null,
		});
		expect(toSearch(query, { base: '?utm=1&page=9&colour=x', facets })).toBe(
			'?utm=1&q=lamp&brand=Lumo%2CSitwell&colour=white&min=100&sort=price_asc&page=3',
		);
		expect(toSearch(parseQuery(''), {})).toBe('');
		expect(parseQuery('?sort=bogus', { sorts: ['newest', 'title_asc'] }).sort).toBe('newest');
		expect(parseQuery('', { sorts: ['newest'], sort: 'title_asc' }).sort).toBe('newest');
		expect(parseQuery('', { sorts: [] }).sort).toBe('relevance');
		const prefixed = parseQuery('?g_brand=Lumo&brand=Other&g_page=2', { prefix: 'g_', facets });
		expect(prefixed).toMatchObject({ filters: { brand: ['Lumo'] }, page: 2 });
		expect(toSearch(prefixed, { prefix: 'g_', base: '?brand=Other&g_page=2', facets })).toBe(
			'?brand=Other&g_brand=Lumo&g_page=2',
		);
		expect(hasFilters(prefixed)).toBe(true);
		expect(hasFilters({ ...prefixed, filters: { brand: [] } })).toBe(false);
		expect(hasFilters({ ...prefixed, filters: {}, max: 5 })).toBe(true);
	});

	it('filters, counts disjunctively, sorts and pages local items', () => {
		const all = items();
		const query = { ...parseQuery('', { facets }), filters: { brand: ['lumo'] } };
		const result = applyQuery(all, query, { size: 1, facets });
		expect(result.total).toBe(2);
		expect(result.pages).toBe(2);
		expect(result.items.map((i) => i.id)).toEqual(['itm_1']);
		const brand = result.facets.find((f) => f.key === 'brand');
		expect(brand?.values).toEqual([
			{ value: 'Lumo', count: 2 },
			{ value: 'Oakline', count: 2 },
			{ value: 'Sitwell', count: 1 },
		]);
		expect(result.facets.find((f) => f.key === 'price')?.range).toEqual({ min: 4500, max: 12000 });
		expect(result.facets.find((f) => f.key === 'in_stock')?.values).toEqual([{ value: '1', count: 2 }]);
		expect(
			applyQuery(all, { ...query, filters: {}, q: 'lamp black', min: 5000, max: 20000 }, { size: 10 }).items.map((i) => i.id),
		).toEqual(['itm_2']);
		expect(applyQuery(all, { ...query, filters: {}, min: 10, max: 9000 }, { size: 10 }).total).toBe(2);
		expect(
			applyQuery([], query, { size: 5, facets: [{ key: 'price', label: '', type: 'range', multi: true }] }).facets[0]?.range,
		).toBeNull();
		expect(applyQuery(all, { ...query, filters: {}, page: 99 }, { size: 2 }).items.map((i) => i.id)).toEqual(['itm_5']);
	});

	it('sorts by every order with stable ties', () => {
		const all = items();
		/** @param {any} sort */
		const ids = (sort) => [...all].sort(comparator(sort, 'en')).map((i) => i.id);
		expect(ids('relevance')).toEqual(['itm_1', 'itm_2', 'itm_3', 'itm_4', 'itm_5']);
		expect(ids('newest')).toEqual(['itm_2', 'itm_1', 'itm_3', 'itm_4', 'itm_5']);
		expect(ids('price_asc')).toEqual(['itm_1', 'itm_5', 'itm_2', 'itm_4', 'itm_3']);
		expect(ids('price_desc')).toEqual(['itm_3', 'itm_4', 'itm_2', 'itm_5', 'itm_1']);
		expect(ids('title_asc')).toEqual(['itm_3', 'itm_4', 'itm_1', 'itm_2', 'itm_5']);
		const pair = /** @type {import('../core/items.js').Item[]} */ ([
			...toItems([{ id: 'n', title: 'N' }], fieldMap({})),
			all[0],
		]);
		expect([...pair].sort(comparator('price_asc')).map((i) => i.id)).toEqual(['itm_1', 'n']);
		expect([...pair].sort(comparator('price_desc')).map((i) => i.id)).toEqual(['itm_1', 'n']);
	});

	it('reads facet values and builds page windows', () => {
		const [lamp] = items();
		expect(valuesOf(/** @type {any} */ (lamp), 'collection')).toEqual(['lighting']);
		expect(valuesOf(/** @type {any} */ (lamp), 'colour')).toEqual(['white', 'black']);
		expect(valuesOf(/** @type {any} */ ({ ...lamp, brand: '', inStock: false }), 'brand')).toEqual([]);
		expect(valuesOf(/** @type {any} */ ({ ...lamp, inStock: false }), 'in_stock')).toEqual([]);
		expect(pageWindow(5, 10)).toEqual([1, null, 4, 5, 6, null, 10]);
		expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
	});
});

describe('core/card and core/select', () => {
	it('builds cards with chip slides per variant, badges and prices', () => {
		const [lamp, floor, chair] = items();
		const config = cardConfig({ chip_attributes: ['colour', 'finish'], max_chips: 2, show_brand: false });
		expect(chipSlides(/** @type {any} */ (lamp), config)).toEqual([
			['white', 'matte'],
			['black', 'matte'],
		]);
		expect(chipSlides(/** @type {any} */ (floor), config)).toEqual([['black']]);
		expect(chipSlides(/** @type {any} */ (lamp), cardConfig({}))).toEqual([]);
		const view = cardView(/** @type {any} */ (lamp), config);
		expect(view).toMatchObject({ brand: '', price: 4500, compareAt: 5000, badges: ['new'], soldOut: false });
		expect(view.phase).toBeGreaterThanOrEqual(0);
		expect(cardView(/** @type {any} */ (chair), cardConfig({ show_badges: false })).soldOut).toBe(true);
		expect(cardView(/** @type {any} */ (lamp), cardConfig({ show_price: false })).compareAt).toBeNull();
		expect(cardConfig({ image_ratio: '9/9', cycle_ms: 10 })).toMatchObject({ ratio: '1/1', cycleMs: 1000 });
		expect(cardConfig('x').cycle).toBe(true);
	});

	it('picks items by rule', () => {
		const all = items();
		/** @param {any} rule */
		const ids = (rule) => pickItems(all, { count: 3, ...rule }).map((i) => i.id);
		expect(ids({ strategy: 'rank' })).toEqual(['itm_2', 'itm_1', 'itm_4']);
		expect(ids({ strategy: 'featured' })).toEqual(['itm_2']);
		expect(ids({ strategy: 'featured', attribute: 'new' })).toEqual(['itm_1']);
		expect(ids({ strategy: 'newest' })).toEqual(['itm_2', 'itm_1', 'itm_3']);
		expect(ids({ strategy: 'manual', ids: ['itm_3', 'nope', 'itm_1'] })).toEqual(['itm_3', 'itm_1']);
		expect(ids({ collection: 'storage', sort: 'price_asc' })).toEqual(['itm_5', 'itm_4']);
		expect(ids({})).toEqual(['itm_1', 'itm_2', 'itm_3']);
	});
});

describe('core/source', () => {
	it('reads the source configuration safely', () => {
		expect(sourceConfig({})).toMatchObject({
			kind: 'page',
			url: null,
			product: 'catalog',
			pageId: 'ss-items',
			currency: null,
			locale: '',
		});
		expect(sourceConfig({ source: 'json' }).kind).toBe('page');
		// api sources need no URL and no key: the Loader passes the product's client (F.18)
		const api = sourceConfig({ source: 'api', currency: 'EUR', locale: 'de-DE', page_data_id: 'my-data' });
		expect(api).toMatchObject({ kind: 'api', product: 'catalog', currency: 'EUR', locale: 'de-DE', pageId: 'my-data' });
		expect(api).not.toHaveProperty('key');
		expect(sourceConfig({ source: 'api', locale: '!!', page_data_id: '1x' }, 'page', 'deals')).toMatchObject({
			product: 'deals',
			locale: '',
			pageId: 'ss-items',
		});
		expect(sourceConfig({ source: 'api', source_product: 'search' }).product).toBe('search');
		expect(sourceConfig({ source: 'api', source_product: 'nope' }).product).toBe('catalog');
		expect(sourceConfig({}, 'api').kind).toBe('api');
	});

	it('builds product API calls', () => {
		expect(apiUrl('https://c.example/', '/v1/items', { a: 1, b: '', c: null, d: undefined })).toBe(
			'https://c.example/v1/items?a=1',
		);
		expect(apiUrl('https://c.example', '/v1/x', {})).toBe('https://c.example/v1/x');
		const query = {
			q: 'lamp',
			sort: /** @type {const} */ ('price_asc'),
			page: 2,
			filters: { brand: ['A', 'B'] },
			min: 1,
			max: 9,
		};
		expect(catalogParams(query, { size: 10 })).toEqual({
			limit: 10,
			sort: 'price_asc',
			q: 'lamp',
			cursor: null,
			page: 2,
			'filter[brand]': 'A,B',
			'filter[price_min]': 1,
			'filter[price_max]': 9,
		});
		expect(catalogParams({ ...query, sort: 'relevance', min: null, max: null }, { size: 5, cursor: 'c1' })).toMatchObject({
			sort: null,
			page: null,
			cursor: 'c1',
		});
		expect(
			facetCountsOf([
				{ key: 'brand', values: [{ value: 'A', count: 2 }, { value: 1 }], range: { min: 1, max: 2 } },
				{ key: 'x', values: 'no', range: { min: 'a' } },
				3,
			]),
		).toEqual([
			{ key: 'brand', values: [{ value: 'A', count: 2 }], range: { min: 1, max: 2 } },
			{ key: 'x', values: [], range: null },
		]);
		expect(facetCountsOf(null)).toEqual([]);
	});
});

describe('core/media', () => {
	const hero = heroConfig({
		video: { src: 'https://cdn.example.com/v.mp4', poster: 'https://cdn.example.com/p.jpg', min_viewport_width: 600 },
		image: { src: 'https://cdn.example.com/i.jpg' },
		cta_href: '/go',
		secondary_href: 'javascript:x',
		layout: 'split',
		height: 'xl',
	});

	it('reads the hero configuration', () => {
		expect(hero).toMatchObject({ layout: 'split', height: 'md', cta: '/go', secondary: null, image: { priority: true } });
		expect(heroConfig({}).video.slow).toEqual(['slow-2g', '2g', '3g']);
		expect(heroConfig({ video: { skip_connections: ['4g'] } }).video.slow).toEqual(['4g']);
	});

	it('never plays the video on Save-Data, slow connections, reduced motion or narrow screens', () => {
		expect(chooseMedia(hero, { width: 1200 })).toEqual({
			video: 'https://cdn.example.com/v.mp4',
			poster: 'https://cdn.example.com/p.jpg',
			reason: 'video',
		});
		expect(chooseMedia(hero, { saveData: true }).reason).toBe('save_data');
		expect(chooseMedia(hero, { effectiveType: '3g' }).reason).toBe('slow_connection');
		expect(chooseMedia(hero, { effectiveType: '4g', reducedMotion: true }).reason).toBe('reduced_motion');
		expect(chooseMedia(hero, { width: 500 })).toMatchObject({
			video: null,
			poster: 'https://cdn.example.com/p.jpg',
			reason: 'viewport',
		});
		expect(chooseMedia(heroConfig({ video: { src: 'https://c.example/v.mp4', autoplay: false } }), {}).reason).toBe('click');
		expect(
			chooseMedia(heroConfig({ video: { src: 'https://c.example/v.mp4', respect_save_data: false } }), { saveData: true })
				.reason,
		).toBe('video');
		expect(chooseMedia(heroConfig({ image: { src: 'https://c.example/i.jpg' } }), {})).toEqual({
			video: null,
			poster: 'https://c.example/i.jpg',
			reason: 'no_video',
		});
	});
});

describe('core/theme', () => {
	it('turns tokens into CSS variables and refuses unsafe values', () => {
		const config = {
			colors: { primary: '#123456', text: 'red;}body{x', surface: 'url(x)' },
			fonts: { body: 'system-ui', weight_bold: '700' },
			radius: { sm: '2px' },
			space_unit: 5,
			shadows: { md: '0 1px 2px rgb(0 0 0 / 0.2)' },
			motion_ms: 300,
			motion_easing: 'ease',
		};
		const vars = Object.fromEntries(themeVars(config));
		expect(vars).toMatchObject({
			'--ss-color-primary': '#123456',
			'--ss-font-body': 'system-ui',
			'--ss-font-heading': 'system-ui',
			'--ss-radius-sm': '2px',
			'--ss-space-1': '5px',
			'--ss-space-8': '40px',
			'--ss-motion-duration': '300ms',
			'--ss-motion-easing': 'ease',
		});
		expect(vars['--ss-color-text']).toBeUndefined();
		expect(vars['--ss-color-surface']).toBeUndefined();
		expect(Object.fromEntries(themeVars({ motion: 'none' }))['--ss-motion-duration']).toBe('0ms');
		expect(Object.fromEntries(themeVars({ motion: 'reduced' }))['--ss-motion-duration']).toBe('100ms');
		expect(Object.fromEntries(themeVars({ motion: 'reduced' }, { reducedMotion: true }))['--ss-motion-duration']).toBe('0ms');
		expect(themeCss({ colors: { primary: '#000' } }, '.x')).toMatch(/^\.x\{--ss-color-primary:#000;--ss-space-1:4px;/);
		expect(themeCss({})).toMatch(/^:root\{/);
		expect(cssValue(4)).toBe('4');
		expect(cssValue('')).toBeNull();
	});

	it('loads only https woff2 fonts with a plain family name', () => {
		expect(fontOf({ fonts: { family: 'Brand Sans', url: 'https://f.example/b.woff2' } })).toEqual({
			family: 'Brand Sans',
			url: 'https://f.example/b.woff2',
		});
		expect(fontOf({ fonts: { family: 'X', url: 'http://f.example/b.woff2' } })).toBeNull();
		expect(fontOf({ fonts: { family: 'X"', url: 'https://f.example/b.woff2' } })).toBeNull();
		expect(fontOf({})).toBeNull();
	});
});

describe('core/nav and core/deals', () => {
	it('normalises navigation cards and tabs', () => {
		expect(
			navCards(
				[
					{ name: 'Lighting', href: '/c/lighting', logo: 'https://c.example/l.svg', count: 4 },
					{ title: '' },
					{ id: 'x', label: 'Plain', url: 'javascript:x' },
				],
				5,
			),
		).toEqual([
			{ id: '0', title: 'Lighting', href: '/c/lighting', image: 'https://c.example/l.svg', count: 4 },
			{ id: 'x', title: 'Plain', href: null, image: null, count: null },
		]);
		const tabs = tabsOf(
			[
				{ key: 'home', href: '/', icon: 'home' },
				{ key: 'shop', href: '/shop', icon: 'nope', label: 'Shop' },
				{ key: 'Bad', href: '/' },
				{ key: 'x', href: 'javascript:x' },
				{ key: 'out', href: 'https://other.example' },
			],
			(key) => (key === 'home' ? 'Start' : null),
		);
		expect(tabs).toEqual([
			{ key: 'home', href: '/', icon: 'home', label: 'Start' },
			{ key: 'shop', href: '/shop', icon: 'home', label: 'Shop' },
			{ key: 'out', href: 'https://other.example', icon: 'home', label: 'out' },
		]);
		expect(activeTab(tabs, '/')).toBe('home');
		expect(activeTab(tabs, '/shop/item')).toBe('shop');
		expect(activeTab(tabs, '/shopping')).toBeNull();
		expect(
			activeTab(
				[
					{ key: 'a', href: '/a/' },
					{ key: 'b', href: '/a/b?x=1' },
				],
				'/a/b/c',
			),
		).toBe('b');
	});

	it('builds contact links for any numbering plan', () => {
		expect(contactHref('phone', '+1 (555) 010-99+9', null)).toBe('tel:+1555010999');
		expect(contactHref('phone', '12', null)).toBeNull();
		expect(contactHref('whatsapp', '+44 20 7946 0000', null)).toBe('https://wa.me/442079460000');
		expect(contactHref('whatsapp', '123', null)).toBeNull();
		expect(contactHref('email', 'hello@example.com', null)).toBe('mailto:hello@example.com');
		expect(contactHref('email', 'nope', null)).toBeNull();
		expect(contactHref('link', 'Map', 'https://maps.example/x')).toBe('https://maps.example/x');
		const footer = footerOf({
			business_name: 'Shop',
			contacts: [
				{ kind: 'phone', value: '+1 555 0100' },
				{ kind: 'x', value: '' },
			],
			hours: [{ days: 'Mon–Fri', time: '9–5' }, { days: '' }],
			socials: [
				{ label: 'Social', href: 'https://s.example' },
				{ label: '', href: '/' },
			],
			links: [
				{ label: 'Returns', href: '/returns' },
				{ label: 'Bad', href: 'javascript:x' },
			],
			show_year: false,
		});
		expect(footer).toEqual({
			name: 'Shop',
			contacts: [{ kind: 'phone', label: '', value: '+1 555 0100', href: 'tel:+15550100' }],
			hours: [{ days: 'Mon–Fri', time: '9–5' }],
			socials: [{ label: 'Social', href: 'https://s.example' }],
			links: [{ label: 'Returns', href: '/returns' }],
			year: false,
		});
	});

	it('reads deals-page cards and the time left', () => {
		const deals = dealsOf(
			{
				items: [
					{
						id: 'dl_1',
						name: 'Evening deal',
						badge: { label: '-15%' },
						schedule: { activeUntil: '2026-10-03T00:00:00.000Z' },
						currency: 'EUR',
						items: [{ itemId: 'itm_1', title: 'Lamp', url: '/l', unitAmount: 5000, price: 4250 }],
					},
					{ id: 'dl_2', name: 'Bad end', endsAt: 'never', items: [] },
					{ id: '', name: 'No id' },
				],
			},
			{ currency: 'USD' },
		);
		expect(deals).toHaveLength(2);
		expect(deals[0]).toMatchObject({
			badge: '-15%',
			endsAt: '2026-10-03T00:00:00.000Z',
			items: [{ id: 'itm_1', price: 4250, compareAt: 5000, currency: 'EUR' }],
		});
		expect(deals[1]).toMatchObject({ endsAt: null, badge: '', description: '' });
		expect(
			dealsOf([{ id: 'd', name: 'N', items: [{ itemId: 'i', title: 'T', price: 1 }] }], { currency: 'USD' })[0]?.items[0]
				?.currency,
		).toBe('USD');
		expect(dealsOf('x')).toEqual([]);
		const now = Date.parse('2026-10-01T21:30:00Z');
		expect(timeLeft('2026-10-03T00:00:00.000Z', now)).toEqual({ days: 1, hours: 2, minutes: 30 });
		expect(timeLeft('2026-10-01T00:00:00Z', now)).toBeNull();
		expect(timeLeft(null, now)).toBeNull();
	});
});
