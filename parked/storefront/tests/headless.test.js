import { describe, expect, it, vi } from 'vitest';
import { createMobileTabBar, createContactFooter, createNoticeBar } from '../headless/blocks.js';
import { createCards as rawCreateCards, createTrendingBand as rawCreateTrendingBand } from '../headless/cards.js';
import { createDealsPage as rawCreateDealsPage } from '../headless/dealsPage.js';
import { createFilters as rawCreateFilters } from '../headless/filters.js';
import { createGrid as rawCreateGrid } from '../headless/grid.js';
import { createHero } from '../headless/hero.js';
import { createCore, emitter, fail, ok } from '../headless/kit.js';
import { createBrandCards, createCategoryCards } from '../headless/navCards.js';
import { createSearchOverlay as rawCreateSearchOverlay } from '../headless/searchOverlay.js';
import { MAX_BYTES, createSource, getJson } from '../headless/source.js';
import { createTheme, themeCss } from '../headless/theme.js';
import { sourceConfig } from '../core/source.js';
import { ITEMS, fakeFetch, strings, viaLoader } from './helpers.js';

const createGrid = viaLoader(rawCreateGrid);
const createFilters = viaLoader(rawCreateFilters);
const createCards = viaLoader(rawCreateCards);
const createTrendingBand = viaLoader(rawCreateTrendingBand);
const createSearchOverlay = viaLoader(rawCreateSearchOverlay);
const createDealsPage = viaLoader(rawCreateDealsPage);

const API = 'https://catalog.example.com';
const KEY = 'pk_live_0123456789abcdef';

describe('headless/kit', () => {
	it('keeps immutable snapshots, notifies, and stops after destroy', () => {
		expect(ok(1)).toEqual({ ok: true, value: 1 });
		expect(fail('x')).toEqual({ ok: false, problem: { code: 'x' } });
		expect(fail('x', 'why')).toEqual({ ok: false, problem: { code: 'x', detail: 'why' } });
		const core = createCore({ n: 0 }, { strings: { 'a.b': 'Hi {name}' } });
		const element = core.expose({});
		const seen = vi.fn();
		const off = element.subscribe(seen);
		core.set({ n: 1 });
		expect(Object.isFrozen(element.state())).toBe(true);
		expect(element.t('a.b', { name: 'X' })).toBe('Hi X');
		expect(element.validate(null)).toEqual([]);
		off();
		core.set({ n: 2 });
		expect(seen).toHaveBeenCalledTimes(1);
		element.destroy();
		core.set({ n: 3 });
		expect(element.state().n).toBe(2);
		expect(createCore({}, {}).strings).toEqual({});
		const emit = emitter(() => {
			throw new Error('host');
		});
		expect(() => emit('x')).not.toThrow();
		expect(() => emitter(undefined)('x')).not.toThrow();
	});
});

describe('headless/source', () => {
	it('fetches JSON without cookies, with the pk_ key, and refuses bad or huge answers', async () => {
		const { fetch, calls } = fakeFetch({
			'https://a/ok': { items: [] },
			'https://a/404': { status: 404, body: {} },
			'https://a/big': { status: 200, body: {}, length: MAX_BYTES + 1 },
			'https://a/huge': { status: 200, raw: 'x'.repeat(MAX_BYTES + 1) },
			'https://a/bad': { status: 200, raw: '{nope' },
		});
		expect(await getJson(fetch, 'https://a/ok', { key: KEY })).toEqual({ ok: true, value: { items: [] } });
		expect(calls[0]?.init).toMatchObject({
			credentials: 'omit',
			headers: { authorization: `Bearer ${KEY}`, accept: 'application/json' },
		});
		expect(await getJson(fetch, 'https://a/404')).toEqual({ ok: false, problem: { code: 'source_failed', status: 404 } });
		expect((await getJson(fetch, 'https://a/big')).ok).toBe(false);
		expect(await getJson(fetch, 'https://a/huge')).toEqual(fail('source_too_large'));
		expect(await getJson(fetch, 'https://a/bad')).toEqual(fail('source_invalid'));
		expect(await getJson(fetch, 'https://down/')).toEqual(fail('source_unreachable'));
		expect(calls[1]?.init.headers.authorization).toBeUndefined();
	});

	it('times out slow sources', async () => {
		vi.useFakeTimers();
		try {
			/** @type {any} */
			const slow = (/** @type {string} */ _url, /** @type {any} */ init) =>
				new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
			const pending = getJson(slow, 'https://slow/', { timeoutMs: 50 });
			await vi.advanceTimersByTimeAsync(60);
			expect(await pending).toEqual(fail('source_unreachable'));
		} finally {
			vi.useRealTimers();
		}
	});

	it('loads a JSON file once, retries after a failure, and fills the default currency', async () => {
		let healthy = false;
		const { fetch, calls } = fakeFetch({});
		/** @type {any} */
		const flaky = async (/** @type {string} */ url, /** @type {any} */ init) => {
			calls.push({ url, init });
			if (!healthy) throw new TypeError('down');
			return {
				ok: true,
				status: 200,
				headers: { get: () => null },
				text: async () => JSON.stringify([{ id: 'a', title: 'A', price: 100 }]),
			};
		};
		const source = createSource(sourceConfig({ source: 'json', source_url: '/items.json', currency: 'CHF' }), { fetch: flaky });
		expect((await source.all()).ok).toBe(false);
		healthy = true;
		const loaded = await source.all();
		expect(loaded.ok && loaded.value[0]?.currency).toBe('CHF');
		await source.all();
		expect(calls).toHaveLength(2);
		source.provide([{ id: 'p', title: 'P', currency: 'EUR' }]);
		const provided = await source.all();
		expect(provided.ok && provided.value[0]).toMatchObject({ id: 'p', currency: 'EUR' });
		expect(await createSource(sourceConfig({}), { fetch }).all()).toEqual({ ok: true, value: [] });
		expect(typeof createSource(sourceConfig({})).api).toBe('function');
	});
});

describe('headless/grid', () => {
	it('lists page data by URL query with crawlable page links, sort and load more', async () => {
		const emit = vi.fn();
		const grid = createGrid({
			config: { page_size: 2, filter_keys: ['brand', 'colour'], card: { chip_attributes: ['colour'] } },
			strings,
			emit,
		});
		expect(grid.state().status).toBe('idle');
		const started = await grid.actions.start({ search: '?brand=Lumo,Oakline&utm=1', data: ITEMS });
		expect(started).toEqual({ ok: true, value: { search: '?brand=Lumo,Oakline&utm=1' } });
		const state = grid.state();
		expect(state).toMatchObject({ status: 'ready', total: 4, pages: 2, hasMore: true });
		expect(state.items.map((c) => c.id)).toEqual(['itm_1', 'itm_2']);
		expect(state.links).toEqual({
			prev: null,
			next: '?utm=1&brand=Lumo%2COakline&page=2',
			pages: [
				{ page: 1, search: '?utm=1&brand=Lumo%2COakline' },
				{ page: 2, search: '?utm=1&brand=Lumo%2COakline&page=2' },
			],
		});
		expect((await grid.actions.setSearch('?brand=Lumo,Oakline&utm=1')).ok).toBe(true);
		const more = await grid.actions.loadMore();
		expect(more).toEqual({ ok: true, value: { search: '?utm=1&brand=Lumo%2COakline&page=2' } });
		expect(grid.state()).toMatchObject({
			first: 2,
			hasMore: false,
			links: { prev: '?utm=1&brand=Lumo%2COakline', next: null },
		});
		expect(grid.state().items.map((c) => c.id)).toEqual(['itm_1', 'itm_2', 'itm_4', 'itm_5']);
		expect(emit).toHaveBeenCalledWith('action', { action: 'load_more' });
		expect(await grid.actions.loadMore()).toEqual(fail('nothing_more'));
		expect(await grid.actions.sortBy('bogus')).toEqual(fail('invalid_sort'));
		const sorted = await grid.actions.sortBy('price_desc');
		expect(sorted.ok && sorted.value.search).toBe('?utm=1&brand=Lumo%2COakline&sort=price_desc');
		expect(grid.state().items.map((c) => c.id)).toEqual(['itm_4', 'itm_2']);
		const page = await grid.actions.goTo(2);
		expect(page.ok && page.value.search).toContain('page=2');
		expect(grid.state().query.page).toBe(2);
		expect(grid.validate({ sort: 'x' })).toHaveLength(1);
		expect(grid.validate({ sort: 'newest' })).toEqual([]);
		expect(grid.validate(null)).toEqual([]);
		expect(grid.state()).toMatchObject({
			pagination: 'infinite',
			columns: { mobile: 2, tablet: 3, desktop: 4 },
			cycleMs: 2000,
			pageId: 'ss-items',
		});
	});

	it('reads the Catalog API with cursors, and reports errors', async () => {
		const { fetch, calls } = fakeFetch({
			[`${API}/v1/items?limit=2&page=1`]: { items: ITEMS.slice(0, 2), next: 'c2', total: 5, facets: [] },
			[`${API}/v1/items?limit=2&cursor=c2`]: { items: ITEMS.slice(2, 4), nextCursor: null },
		});
		const grid = createGrid({
			config: {
				source: 'api',
				source_url: API,
				source_key: KEY,
				page_size: 2,
				pagination: 'load_more',
				columns: { mobile: 9 },
			},
			strings,
			fetch,
		});
		await grid.actions.start({});
		expect(grid.state()).toMatchObject({
			total: 5,
			pages: 3,
			hasMore: true,
			next: 'c2',
			pagination: 'load_more',
			columns: { mobile: 4 },
		});
		await grid.actions.loadMore();
		expect(grid.state().items).toHaveLength(4);
		expect(grid.state()).toMatchObject({ next: null, hasMore: true });
		expect(calls.map((c) => c.init.headers.authorization)).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`]);
		const failing = createGrid({ config: { source: 'api', source_url: 'https://down.example', page_size: 2 }, strings, fetch });
		const result = await failing.actions.start({});
		expect(result.ok).toBe(false);
		expect(failing.state()).toMatchObject({ status: 'error', error: strings['storefront.error'] });
		const unknown = createGrid({
			config: { source: 'api', source_url: `${API}/odd` },
			fetch: fakeFetch({ [`${API}/odd`]: null }).fetch,
		});
		await unknown.actions.start({});
		expect(unknown.state()).toMatchObject({ status: 'ready', total: null, pages: null, items: [], links: { pages: [] } });
	});

	it('drops superseded responses', async () => {
		/** @type {Array<() => void>} */
		const release = [];
		/** @type {any} */
		const fetch = (/** @type {string} */ url) =>
			new Promise((resolve) =>
				release.push(() =>
					resolve({
						ok: true,
						status: 200,
						headers: { get: () => null },
						text: async () => JSON.stringify({ items: [{ id: url, title: url }] }),
					}),
				),
			);
		const grid = createGrid({ config: { source: 'api', source_url: API }, fetch });
		const first = grid.actions.start({ search: '?q=a' });
		const second = grid.actions.setSearch('?q=b');
		release[1]?.();
		release[0]?.();
		expect(await first).toEqual(fail('superseded'));
		expect((await second).ok).toBe(true);
		expect(grid.state().query.q).toBe('b');
	});
});

describe('headless/filters', () => {
	it('counts facets, toggles values and ranges, and writes the URL', async () => {
		const emit = vi.fn();
		const filters = createFilters({
			config: {
				facets: [{ key: 'brand' }, { key: 'colour', multi: false }, { key: 'in_stock', type: 'toggle' }, { key: 'price' }],
				currency: 'EUR',
				layout: 'sheet',
				max_values: 2,
			},
			strings,
			emit,
		});
		await filters.actions.start({ search: '?colour=green', data: ITEMS });
		const state = filters.state();
		expect(state).toMatchObject({
			status: 'ready',
			layout: 'sheet',
			currency: 'EUR',
			digits: 2,
			filtered: true,
			active: [{ key: 'colour', value: 'green' }],
		});
		expect(state.facets.find((f) => f.key === 'brand')?.values).toEqual([{ value: 'Sitwell', count: 1, selected: false }]);
		expect(state.facets.find((f) => f.key === 'colour')?.values.find((v) => v.value === 'green')).toEqual({
			value: 'green',
			count: 1,
			selected: true,
		});
		expect(state.facets.find((f) => f.key === 'price')?.range).toEqual({ min: 30000, max: 30000 });
		const replaced = await filters.actions.toggle('colour', 'black');
		expect(replaced.ok && replaced.value.search).toBe('?colour=black');
		expect(emit).toHaveBeenCalledWith('action', { action: 'filter' });
		await filters.actions.toggle('brand', 'Lumo');
		const added = await filters.actions.toggle('brand', 'Oakline');
		expect(added.ok && added.value.search).toBe('?colour=black&brand=Lumo%2COakline');
		const removed = await filters.actions.toggle('brand', 'Oakline');
		expect(removed.ok && removed.value.search).toBe('?colour=black&brand=Lumo');
		await filters.actions.toggle('brand', 'Lumo');
		expect(filters.state().query.filters).toEqual({ colour: ['black'] });
		expect(await filters.actions.toggle('nope', 'x')).toEqual(fail('invalid_filter'));
		expect(await filters.actions.toggle('brand', '')).toEqual(fail('invalid_filter'));
		expect(await filters.actions.setRange(500, 100)).toEqual(fail('invalid_range'));
		const ranged = await filters.actions.setRange(5000, null);
		expect(ranged.ok && ranged.value.search).toBe('?colour=black&min=5000');
		expect((await filters.actions.setRange(-1, 1.5)).ok).toBe(true);
		expect(filters.state().query).toMatchObject({ min: null, max: null });
		await filters.actions.setRange(1, 2);
		const noPrice = await filters.actions.clear('price');
		expect(noPrice.ok && noPrice.value.search).toBe('?colour=black');
		await filters.actions.clear('colour');
		await filters.actions.toggle('in_stock', '1');
		const all = await filters.actions.clear();
		expect(all.ok && all.value.search).toBe('');
		expect(await filters.actions.setOpen(true)).toEqual(ok(true));
		expect(filters.state().open).toBe(true);
		expect(filters.validate({ min: 5, max: 1 })).toHaveLength(1);
		expect(filters.validate({ min: 1, max: 5 })).toEqual([]);
		expect(filters.validate('x')).toEqual([]);
		expect((await filters.actions.setSearch('')).ok).toBe(true);
		expect((await filters.actions.setSearch('?brand=Lumo')).ok).toBe(true);
		expect(filters.state().active).toEqual([{ key: 'brand', value: 'Lumo' }]);
	});

	it('uses the defaults, the first item’s currency, and reports errors', async () => {
		const filters = createFilters({ strings });
		await filters.actions.start({ data: ITEMS });
		expect(filters.state().facets.map((f) => f.key)).toEqual(['brand', 'price']);
		expect(filters.state()).toMatchObject({ layout: 'sidebar', counts: true, currency: 'EUR' });
		const broken = createFilters({
			config: { source: 'json', source_url: 'https://down.example/x.json' },
			strings,
			fetch: fakeFetch({}).fetch,
		});
		await broken.actions.start({});
		expect(broken.state().status).toBe('error');
	});

	it('drops superseded counts', async () => {
		/** @type {Array<() => void>} */
		const release = [];
		/** @type {any} */
		const fetch = () =>
			new Promise((resolve) =>
				release.push(() =>
					resolve({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{"items":[]}' }),
				),
			);
		const filters = createFilters({ config: { source: 'api', source_url: API }, fetch });
		const first = filters.actions.start({ search: '?brand=a' });
		const second = filters.actions.setSearch('?brand=b');
		release[1]?.();
		release[0]?.();
		expect(await first).toEqual(fail('superseded'));
		expect((await second).ok).toBe(true);
	});
});

describe('headless/cards and trending band', () => {
	it('picks cards from local data and from the Catalog', async () => {
		const cards = createCards({
			config: { collection: 'lighting', count: 1, layout: 'rail', card: { cycle_chips: false } },
			strings,
		});
		expect(await cards.actions.start({ data: ITEMS })).toEqual(ok({ count: 1 }));
		expect(cards.state()).toMatchObject({ status: 'ready', layout: 'rail', cycleMs: 0 });
		expect((await cards.actions.reload()).ok).toBe(true);
		const { fetch, calls } = fakeFetch({ [`${API}/v1/items`]: { items: ITEMS } });
		const band = createTrendingBand({ config: { source: 'api', source_url: API, source_key: KEY, count: 2 }, strings, fetch });
		await band.actions.start();
		// Catalog has no rank: the API's `sort=trending` order is kept
		expect(band.state().items.map((c) => c.id)).toEqual(['itm_1', 'itm_2']);
		expect(band.state().layout).toBe('strip');
		expect(calls[0]?.url).toBe(`${API}/v1/items?limit=2&sort=trending`);
		const manual = createTrendingBand({
			config: { source: 'api', source_url: API, strategy: 'manual', item_ids: ['itm_3', 'itm_1'] },
			fetch,
		});
		await manual.actions.start();
		expect(manual.state().items.map((c) => c.id)).toEqual(['itm_3', 'itm_1']);
		expect(calls[1]?.url).toBe(`${API}/v1/items?filter%5Bid%5D=itm_3%2Citm_1`);
		const newest = createCards({ config: { source: 'api', source_url: API, strategy: 'newest' }, fetch });
		await newest.actions.start();
		expect(calls[2]?.url).toContain('sort=newest');
	});

	it('reports errors and refuses a reload while loading', async () => {
		const cards = createCards({
			config: { source: 'api', source_url: 'https://down.example' },
			strings,
			fetch: fakeFetch({}).fetch,
		});
		const pending = cards.actions.start();
		expect(await cards.actions.reload()).toEqual(fail('busy'));
		expect((await pending).ok).toBe(false);
		expect(cards.state().status).toBe('error');
	});
});

describe('headless/searchOverlay', () => {
	it('suggests local results, moves the active option and submits', async () => {
		const emit = vi.fn();
		const search = createSearchOverlay({ config: { results_path: '/find?x=1', param: 'term', max_results: 2 }, strings, emit });
		await search.actions.start({ data: ITEMS });
		await search.actions.open();
		expect(search.state().open).toBe(true);
		expect(await search.actions.setQuery('l')).toEqual(ok([]));
		expect(search.state()).toMatchObject({ status: 'idle', href: '/find?x=1&term=l' });
		expect(await search.actions.move(1)).toEqual(ok(-1));
		await search.actions.setQuery('lamp');
		expect(search.state().results.map((i) => i.id)).toEqual(['itm_1', 'itm_2']);
		expect(await search.actions.move(1)).toEqual(ok(0));
		expect(await search.actions.move(1)).toEqual(ok(1));
		expect(await search.actions.move(1)).toEqual(ok(-1));
		expect(await search.actions.move(-1)).toEqual(ok(1));
		expect(await search.actions.submit()).toEqual(ok({ href: '/items/floor-lamp' }));
		expect(emit).toHaveBeenLastCalledWith('action', { action: 'result' });
		await search.actions.move(1);
		expect(await search.actions.submit()).toEqual(ok({ href: '/find?x=1&term=lamp' }));
		expect(emit).toHaveBeenLastCalledWith('action', { action: 'search' });
		await search.actions.close();
		expect(search.state()).toMatchObject({ open: false, active: -1 });
		await search.actions.setQuery('');
		expect(search.state().href).toBe('/find?x=1');
		expect(await search.actions.submit()).toEqual(fail('empty_query'));
		expect(search.validate('x'.repeat(101))).toHaveLength(1);
		expect(search.validate('ok')).toEqual([]);
	});

	it('asks Site Search with the pk_ key and handles failures and stale answers', async () => {
		const { fetch, calls } = fakeFetch({ [`${API}/v1/search`]: { results: ITEMS.slice(0, 1) } });
		const search = createSearchOverlay({ config: { source: 'api', source_url: API, source_key: KEY, param: 'Bad!' }, fetch });
		await search.actions.setQuery('desk');
		expect(search.state().results.map((i) => i.id)).toEqual(['itm_1']);
		expect(search.state().href).toBe('/search?q=desk');
		expect(calls[0]?.url).toBe(`${API}/v1/search?q=desk&limit=8`);
		const down = createSearchOverlay({
			config: { source: 'api', source_url: 'https://down.example', api_path: '/v1/items' },
			fetch,
		});
		expect((await down.actions.setQuery('desk')).ok).toBe(false);
		expect(down.state().status).toBe('error');
		/** @type {Array<() => void>} */
		const release = [];
		/** @type {any} */
		const slow = () =>
			new Promise((resolve) =>
				release.push(() => resolve({ ok: true, status: 200, headers: { get: () => null }, text: async () => '[]' })),
			);
		const racing = createSearchOverlay({ config: { source: 'api', source_url: API }, fetch: slow });
		const first = racing.actions.setQuery('aa');
		const second = racing.actions.setQuery('bb');
		release[1]?.();
		release[0]?.();
		expect(await first).toEqual(fail('superseded'));
		expect((await second).ok).toBe(true);
		expect((await racing.actions.start()).ok).toBe(true);
		expect((await createSearchOverlay().actions.setQuery(/** @type {any} */ (null))).ok).toBe(true);
	});
});

describe('headless blocks', () => {
	it('hero: calls to action and the video state', async () => {
		const emit = vi.fn();
		const hero = createHero({ config: { cta_href: '/start', secondary_href: '/more' }, emit });
		expect(await hero.actions.follow('primary')).toEqual(ok('/start'));
		expect(await hero.actions.follow('secondary')).toEqual(ok('/more'));
		expect(emit.mock.calls).toEqual([
			['action', { action: 'cta' }],
			['action', { action: 'secondary_cta' }],
		]);
		await hero.actions.setPlaying(true);
		expect(hero.state().playing).toBe(true);
		expect(createHero().state().layout).toBe('overlay');
	});

	it('navigation cards: configured, page data and a JSON file', async () => {
		const cards = createCategoryCards({ config: { cards: [{ title: 'Lighting', href: '/c/lighting' }], columns: 3 } });
		expect(cards.state()).toMatchObject({ cards: [{ title: 'Lighting' }], columns: 3, logos: false });
		await cards.actions.start({});
		expect(cards.state().status).toBe('ready');
		await cards.actions.start({ data: [{ title: 'Page', href: '/p' }] });
		expect(cards.state().cards.map((c) => c.title)).toEqual(['Page']);
		const { fetch } = fakeFetch({
			'https://c.example/brands.json': { items: [{ name: 'Lumo', logo: 'https://c.example/l.svg' }] },
			'https://c.example/down': { status: 500, body: {} },
		});
		const brands = createBrandCards({ config: { source: 'json', source_url: 'https://c.example/brands.json' }, fetch });
		expect(brands.state()).toMatchObject({ columns: 6, logos: true });
		expect(await brands.actions.start()).toEqual(ok(1));
		const down = createBrandCards({ config: { source: 'json', source_url: 'https://c.example/down' }, fetch });
		expect((await down.actions.start()).ok).toBe(false);
		expect(down.state().status).toBe('error');
		expect(typeof createCategoryCards().actions.start).toBe('function');
	});

	it('deals page: Deals API with cursors, JSON file and page data', async () => {
		const deal = (/** @type {string} */ id) => ({
			id,
			name: `Deal ${id}`,
			schedule: { activeUntil: '2026-10-02T12:00:00Z' },
			currency: 'EUR',
			items: [{ itemId: 'i', title: 'T', price: 900, unitAmount: 1000 }],
		});
		const { fetch, calls } = fakeFetch({
			[`${API}/v1/deals-page?limit=1&cursor=n2`]: { items: [deal('b')], nextCursor: null, hasMore: false },
			[`${API}/v1/deals-page?limit=1`]: { items: [deal('a')], nextCursor: 'n2', hasMore: true },
			'https://c.example/deals.json': [deal('j')],
		});
		const now = () => Date.parse('2026-10-02T10:00:00Z');
		const page = createDealsPage({
			config: { source: 'api', source_url: API, source_key: KEY, page_size: 1 },
			strings,
			fetch,
			now,
		});
		await page.actions.start();
		expect(page.state()).toMatchObject({
			status: 'ready',
			next: 'n2',
			deals: [{ id: 'a', left: { days: 0, hours: 2, minutes: 0 }, items: [{ compareAt: 1000 }] }],
		});
		await page.actions.loadMore();
		expect(page.state().deals.map((d) => d.id)).toEqual(['a', 'b']);
		expect(await page.actions.loadMore()).toEqual(fail('nothing_more'));
		expect(calls[0]?.init.headers.authorization).toBe(`Bearer ${KEY}`);
		const file = createDealsPage({
			config: { source: 'json', source_url: 'https://c.example/deals.json', show_countdown: false, layout: 'list' },
			fetch,
			now,
		});
		await file.actions.start();
		expect(file.state()).toMatchObject({ layout: 'list', next: null, deals: [{ id: 'j', left: null }] });
		const fromPage = createDealsPage({ now });
		await fromPage.actions.start({ data: { items: [deal('p')] } });
		expect(fromPage.state().deals.map((d) => d.id)).toEqual(['p']);
		await createDealsPage().actions.start();
		const down = createDealsPage({ config: { source: 'api', source_url: 'https://down.example' }, strings, fetch });
		expect((await down.actions.start()).ok).toBe(false);
		expect(down.state().error).toBe(strings['storefront.error']);
	});

	it('notice bar, tab bar, footer and theme', async () => {
		const emit = vi.fn();
		const notice = createNoticeBar({ config: { link_href: '/sale', tone: 'warning' }, emit });
		expect(notice.state()).toMatchObject({ href: '/sale', tone: 'warning', dismissible: true });
		expect(await notice.actions.dismiss()).toEqual(ok(true));
		expect(notice.state().dismissed).toBe(true);
		expect(emit).toHaveBeenCalledWith('dismissed', {});
		const fixed = createNoticeBar({ config: { dismissible: false } });
		expect(await fixed.actions.dismiss()).toEqual(ok(false));

		const tabs = createMobileTabBar({
			config: {
				tabs: [
					{ key: 'home', href: '/', icon: 'home' },
					{ key: 'deals', href: '/deals', icon: 'tag', label: 'Offers' },
				],
			},
			strings,
			emit,
		});
		expect(tabs.state().tabs.map((tab) => tab.label)).toEqual(['Home', 'Offers']);
		expect(await tabs.actions.setPath('/deals/today')).toEqual(ok('deals'));
		expect(await tabs.actions.setPath(/** @type {any} */ (undefined))).toEqual(ok('home'));
		await tabs.actions.select('deals');
		expect(emit).toHaveBeenLastCalledWith('action', { action: 'tab_deals' });
		expect(createMobileTabBar().state().tabs).toEqual([{ key: 'home', href: '/', icon: 'home', label: 'home' }]);

		expect(createContactFooter({ config: { business_name: 'Shop' } }).state().name).toBe('Shop');
		expect(createContactFooter().state().contacts).toEqual([]);

		const theme = createTheme({
			config: { colors: { primary: '#123' }, motion: 'reduced', fonts: { family: 'F', url: 'https://f.example/f.woff2' } },
		});
		expect(theme.state().font).toEqual({ family: 'F', url: 'https://f.example/f.woff2' });
		expect(Object.fromEntries(theme.state().vars)['--ss-motion-duration']).toBe('100ms');
		expect(Object.fromEntries(theme.state().reducedVars)['--ss-motion-duration']).toBe('0ms');
		expect(theme.actions).toEqual({});
		expect(themeCss({})).toContain(':root{');
		expect(createTheme().state().font).toBeNull();
	});
});
