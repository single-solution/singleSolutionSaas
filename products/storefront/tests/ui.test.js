// @vitest-environment jsdom
/* global window, document -- these tests run in the jsdom environment */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContactFooter, createMobileTabBar, createNoticeBar } from '../headless/blocks.js';
import { createCards as rawCreateCards, createTrendingBand as rawCreateTrendingBand } from '../headless/cards.js';
import { createDealsPage as rawCreateDealsPage } from '../headless/dealsPage.js';
import { createFilters as rawCreateFilters } from '../headless/filters.js';
import { createGrid as rawCreateGrid } from '../headless/grid.js';
import { createHero } from '../headless/hero.js';
import { createBrandCards, createCategoryCards } from '../headless/navCards.js';
import { createSearchOverlay as rawCreateSearchOverlay } from '../headless/searchOverlay.js';
import { createTheme } from '../headless/theme.js';
import {
	footerStyles,
	noticeStyles,
	renderContactFooter,
	renderMobileTabBar,
	renderNoticeBar,
	tabBarStyles,
} from '../ui/blocks.js';
import { bandStyles, renderCards, renderTrendingBand, styles as cardsStyles } from '../ui/cards.js';
import { render as renderDeals, styles as dealsStyles } from '../ui/dealsPage.js';
import { QUERY_EVENT, el, icon, navigate, pageData, refocus, trapTab } from '../ui/dom.js';
import { render as renderFilters, styles as filterStyles } from '../ui/filters.js';
import { render as renderGrid, styles as gridStyles } from '../ui/grid.js';
import { render as renderHero, styles as heroStyles } from '../ui/hero.js';
import { renderBrandCards, renderCategoryCards, styles as navStyles } from '../ui/navCards.js';
import { render as renderSearch, styles as searchStyles } from '../ui/searchOverlay.js';
import { render as renderTheme } from '../ui/theme.js';
import { ITEMS, fakeIntersection, flush, mount, pageScript, strings, viaLoader } from './helpers.js';

const createGrid = viaLoader(rawCreateGrid);
const createFilters = viaLoader(rawCreateFilters);
const createCards = viaLoader(rawCreateCards);
const createTrendingBand = viaLoader(rawCreateTrendingBand);
const createSearchOverlay = viaLoader(rawCreateSearchOverlay);
const createDealsPage = viaLoader(rawCreateDealsPage);

/** @param {string} url */
const goTo = (url) => window.history.replaceState(null, '', url);
/** @param {any} node */
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
/** Click a link without navigating (jsdom cannot navigate). @param {any} node */
const follow = (node) => {
	document.addEventListener('click', (event) => event.preventDefault(), { once: true });
	click(node);
};
/** @param {any} node @param {string} key @param {Record<string, unknown>} [extra] */
const key = (node, key, extra = {}) =>
	node.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
/** @param {string} selector */
const $ = (selector) => /** @type {any} */ (document.querySelector(selector));
/** @param {string} selector */
const $$ = (selector) => /** @type {any[]} */ ([...document.querySelectorAll(selector)]);

beforeEach(() => {
	document.body.innerHTML = '';
	document.documentElement.lang = 'en';
	goTo('/list');
});
afterEach(() => {
	vi.useRealTimers();
	delete (/** @type {any} */ (window).IntersectionObserver);
});

describe('ui/dom helpers', () => {
	it('builds safe DOM, reads page data and keeps focus', async () => {
		const onClick = vi.fn();
		const node = el(document, 'button', { type: 'button', disabled: false, hidden: true, 'data-x': 1, onclick: onClick }, [
			'a',
			null,
			['b', false],
			el(document, 'span'),
		]);
		expect(node.outerHTML).toBe('<button type="button" hidden="" data-x="1">ab<span></span></button>');
		click(node);
		expect(onClick).toHaveBeenCalled();
		pageScript({ a: 1 }, 'good');
		const bad = pageScript('x', 'bad');
		bad.textContent = '{nope';
		expect(pageData(document, 'good')).toEqual({ a: 1 });
		expect(pageData(document, 'bad')).toBeUndefined();
		expect(pageData(document, 'missing')).toBeUndefined();
		expect(pageData(/** @type {any} */ ({}), 'good')).toBeUndefined();
		const heard = vi.fn();
		window.addEventListener(QUERY_EVENT, heard);
		navigate(window, '?a=1');
		expect(window.location.search).toBe('?a=1');
		navigate(window, '?a=2', { replace: true });
		expect(heard).toHaveBeenCalledTimes(2);
		navigate(null, '?x');
		const svg = icon(document, 'M0 0');
		expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
		expect(
			icon(/** @type {any} */ ({ createElement: (/** @type {string} */ t) => document.createElement(t) }), 'M0 0').tagName,
		).toBe('SVG');
		const actions = {};
		const first = el(document, 'div', {}, [el(document, 'input', { type: 'search', 'data-k': 'q', value: 'abc' })]);
		document.body.append(first);
		refocus(document, actions, first);
		first.querySelector('input').focus();
		const second = el(document, 'div', {}, [el(document, 'input', { type: 'search', 'data-k': 'q', value: 'abcd' })]);
		refocus(document, actions, second);
		first.replaceWith(second);
		await flush();
		expect(document.activeElement).toBe(second.querySelector('input'));
		expect(/** @type {any} */ (document.activeElement).selectionStart).toBe(4);
	});

	it('traps Tab inside a modal container', () => {
		const a = el(document, 'button');
		const b = el(document, 'button');
		const box = el(document, 'div', {}, [a, b]);
		document.body.append(box);
		b.focus();
		const forward = new window.KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
		trapTab(forward, box);
		expect(document.activeElement).toBe(a);
		const back = new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true });
		trapTab(back, box);
		expect(document.activeElement).toBe(b);
		trapTab(new window.KeyboardEvent('keydown', { key: 'a' }), box);
		trapTab(forward, el(document, 'div'));
		trapTab(forward, {});
		expect(back.defaultPrevented).toBe(true);
	});
});

describe('ui/grid', () => {
	it('renders crawlable pages from page data and follows the URL', async () => {
		goTo('/list?brand=Lumo&utm=1');
		pageScript(ITEMS);
		const grid = createGrid({ config: { page_size: 1, pagination: 'links', filter_keys: ['brand'] }, strings });
		const view = mount(grid, renderGrid);
		expect(view.node().getAttribute('role')).toBe('region');
		await flush();
		expect($$('.ss-grid__list > li')).toHaveLength(1);
		expect($('.ss-grid__count').textContent).toBe('Results: 2');
		const next = $('a[rel="next"]');
		expect(next.getAttribute('href')).toBe('?utm=1&brand=Lumo&page=2');
		expect($('a[aria-current="page"]').textContent).toBe('1');
		expect($('.ss-grid__more')).toBeNull();
		click(next);
		await flush();
		expect(window.location.search).toBe('?utm=1&brand=Lumo&page=2');
		expect($('.ss-card__link').textContent).toBe('Floor lamp');
		expect($('a[rel="prev"]').getAttribute('href')).toBe('?utm=1&brand=Lumo');
		// a modified click keeps the browser's own behaviour (new tab)
		const modified = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
		/** @type {boolean | null} */
		let prevented = null;
		document.addEventListener(
			'click',
			(event) => {
				prevented = event.defaultPrevented;
				event.preventDefault();
			},
			{ once: true },
		);
		$('a[rel="prev"]').dispatchEvent(modified);
		expect(prevented).toBe(false);
		const select = $('.ss-grid__sort select');
		select.value = 'price_desc';
		select.dispatchEvent(new window.Event('change'));
		await flush();
		expect(window.location.search).toBe('?utm=1&brand=Lumo&sort=price_desc');
		expect($('.ss-card__link').textContent).toBe('Floor lamp');
		window.history.pushState(null, '', '/list?brand=Sitwell');
		window.dispatchEvent(new window.PopStateEvent('popstate'));
		await flush();
		expect($('.ss-card__link').textContent).toBe('Armchair');
		window.history.pushState(null, '', '/list?brand=Nobody');
		window.dispatchEvent(new window.Event(QUERY_EVENT));
		await flush();
		expect($('.ss-grid__empty').textContent).toBe(strings['grid.empty']);
		view.destroy();
	});

	it('appends pages on scroll (infinite) and after "load more", moving focus to the first new card', async () => {
		const { IO, observers } = fakeIntersection();
		/** @type {any} */ (window).IntersectionObserver = IO;
		pageScript(ITEMS);
		const grid = createGrid({ config: { page_size: 2 }, strings });
		mount(grid, renderGrid);
		await flush();
		expect($$('.ss-grid__list > li')).toHaveLength(2);
		const observer = observers.at(-1);
		expect(observer.targets[0]).toBe($('.ss-grid__more'));
		observer.fire(true);
		await flush();
		expect($$('.ss-grid__list > li')).toHaveLength(4);
		expect(window.location.search).toBe('?page=2');
		click($('.ss-grid__more'));
		await flush();
		expect($$('.ss-grid__list > li')).toHaveLength(5);
		expect(document.activeElement?.textContent).toBe('Side table');
		expect($('.ss-grid__more')).toBeNull();
		observers.at(-1)?.fire(false);
	});

	it('shows errors, cycles chips on screen and honours reduced motion', async () => {
		vi.useFakeTimers();
		const failing = createGrid({
			config: { source: 'api', source_url: 'https://down.example' },
			strings,
			fetch: /** @type {any} */ (async () => Promise.reject(new Error('down'))),
		});
		mount(failing, renderGrid);
		await vi.advanceTimersByTimeAsync(1);
		expect($('.ss-grid__error').getAttribute('role')).toBe('alert');
		document.body.innerHTML = '';
		pageScript(ITEMS);
		const grid = createGrid({ config: { card: { chip_attributes: ['colour'], cycle_ms: 1000 } }, strings });
		mount(grid, renderGrid);
		await vi.advanceTimersByTimeAsync(1);
		const layers = $$('.ss-card__chips');
		expect(layers.map((l) => l.textContent)).toEqual(['white', 'black', 'black', 'green', 'oak']);
		expect(layers[0].className).toContain('is-on');
		await vi.advanceTimersByTimeAsync(1000);
		expect(layers[1].className).toContain('is-on');
		expect(layers[0].getAttribute('aria-hidden')).toBe('true');
		const card = layers[0].closest('.ss-card');
		card.dispatchEvent(new window.Event('mouseenter'));
		await vi.advanceTimersByTimeAsync(2000);
		expect(layers[1].className).toContain('is-on');
		card.dispatchEvent(new window.Event('mouseleave'));
		await vi.advanceTimersByTimeAsync(1000);
		expect(layers[0].className).toContain('is-on');
		document.body.innerHTML = '';
		await vi.advanceTimersByTimeAsync(500);
		pageScript(ITEMS);
		const still = createGrid({ config: { card: { chip_attributes: ['colour'] } }, strings });
		mount(still, renderGrid, { props: { reducedMotion: true } });
		await vi.advanceTimersByTimeAsync(1);
		const first = $('.ss-card__chips');
		await vi.advanceTimersByTimeAsync(5000);
		expect(first.className).toContain('is-on');
	});
});

describe('ui/filters', () => {
	it('writes facet changes to the URL, and the grid follows', async () => {
		pageScript(ITEMS);
		const filters = createFilters({
			config: {
				facets: [{ key: 'brand' }, { key: 'colour', multi: false }, { key: 'in_stock', type: 'toggle' }, { key: 'price' }],
				currency: 'EUR',
			},
			strings,
		});
		const grid = createGrid({ config: { filter_keys: ['brand', 'colour', 'in_stock'] }, strings });
		mount(filters, renderFilters);
		mount(grid, renderGrid);
		await flush();
		expect($('.ss-filters').tagName).toBe('ASIDE');
		expect($$('fieldset legend').map((l) => l.textContent)).toEqual(['Brand', 'colour', 'In stock only', 'Price']);
		expect($('input[type="radio"]')).not.toBeNull();
		const lumo = $('input[data-k="brand:Lumo"]');
		lumo.focus();
		lumo.click();
		await flush();
		expect(window.location.search).toBe('?brand=Lumo');
		expect($$('.ss-grid__list > li')).toHaveLength(2);
		expect(/** @type {any} */ (document.activeElement)?.getAttribute('data-k')).toBe('brand:Lumo');
		expect($('.ss-filters__chip').textContent).toBe('Lumo ×');
		const form = $('.ss-filters__range');
		form.elements.min.value = '50';
		form.elements.max.value = '';
		form.dispatchEvent(new window.Event('submit', { cancelable: true }));
		await flush();
		expect(window.location.search).toBe('?brand=Lumo&min=5000');
		expect($$('.ss-grid__list > li')).toHaveLength(1);
		expect($('input[name="min"]').value).toBe('50');
		click($('.ss-filters__chip'));
		await flush();
		expect(window.location.search).toBe('?min=5000');
		click($('.ss-filters__clear'));
		await flush();
		expect(window.location.search).toBe('');
		expect($('.ss-filters__active')).toBeNull();
	});

	it('opens the sheet as a modal and supports the top bar', async () => {
		pageScript(ITEMS);
		const sheet = createFilters({ config: { layout: 'sheet', show_counts: false }, strings });
		mount(sheet, renderFilters);
		await flush();
		expect($('.ss-filters__panel').hidden).toBe(true);
		expect($('.ss-filters__count')).toBeNull();
		click($('.ss-filters__toggle'));
		await flush();
		const panel = $('.ss-filters__panel');
		expect(panel.hidden).toBe(false);
		expect(panel.getAttribute('role')).toBe('dialog');
		expect($('.ss-filters__toggle').getAttribute('aria-expanded')).toBe('true');
		key(panel, 'Tab');
		key(panel, 'Escape');
		await flush();
		expect($('.ss-filters__panel').hidden).toBe(true);
		expect(document.activeElement).toBe($('.ss-filters__toggle'));
		document.body.innerHTML = '';
		pageScript(ITEMS);
		const bar = createFilters({ config: { layout: 'top_bar', facets: [{ key: 'brand' }, { key: 'nothing' }] }, strings });
		mount(bar, renderFilters);
		await flush();
		expect($$('details summary').map((s) => s.textContent)).toEqual(['Brand']);
		key($('.ss-filters__panel'), 'Escape');
		const range = $('form');
		expect(range).toBeNull();
		document.body.innerHTML = '';
		const broken = createFilters({
			config: { source: 'json', source_url: 'https://down.example/x.json' },
			strings,
			fetch: /** @type {any} */ (async () => Promise.reject(new Error('x'))),
		});
		mount(broken, renderFilters);
		await flush();
		expect($('.ss-filters__error')).not.toBeNull();
	});

	it('reads range input in the currency’s own digits', async () => {
		pageScript([{ id: 'a', title: 'A', price: 1500, currency: 'JPY' }]);
		const filters = createFilters({ config: { facets: [{ key: 'price' }] }, strings });
		mount(filters, renderFilters);
		await flush();
		expect($('input[name="min"]').getAttribute('placeholder')).toBe('1500');
		const form = $('.ss-filters__range');
		form.elements.min.value = 'abc';
		form.elements.max.value = '2000';
		form.dispatchEvent(new window.Event('submit', { cancelable: true }));
		await flush();
		expect(window.location.search).toBe('?max=2000');
	});
});

describe('ui/searchOverlay', () => {
	/** A document whose window records navigation (jsdom cannot navigate). */
	const withWindow = () => {
		const assign = vi.fn();
		const fakeWindow = { document, location: { assign, pathname: '/', search: '' } };
		const dom = new Proxy(document, {
			get: (target, name) =>
				name === 'defaultView'
					? fakeWindow
					: typeof (/** @type {any} */ (target)[name]) === 'function'
						? /** @type {any} */ (target)[name].bind(target)
						: /** @type {any} */ (target)[name],
		});
		return { dom, assign };
	};

	it('opens with / and the button, suggests, navigates options and closes with Escape', async () => {
		pageScript(ITEMS);
		const { dom, assign } = withWindow();
		const search = createSearchOverlay({ config: { results_path: '/search' }, strings });
		mount(search, renderSearch, { props: { dom } });
		await flush();
		expect($('.ss-search').getAttribute('role')).toBe('search');
		expect($('.ss-search__dialog').hidden).toBe(true);
		const field = document.createElement('input');
		document.body.append(field);
		field.focus();
		key(field, '/');
		expect($('.ss-search__dialog').hidden).toBe(true);
		key(document.body, '/');
		await flush();
		expect($('.ss-search__dialog').hidden).toBe(false);
		expect(document.activeElement).toBe($('.ss-search input'));
		const input = $('.ss-search input');
		input.value = 'lamp';
		input.dispatchEvent(new window.Event('input'));
		await flush();
		expect($$('[role="option"]').map((o) => o.textContent)).toEqual(['Desk lamp€45.00', 'Floor lamp€120.00']);
		expect(document.activeElement?.getAttribute('data-k')).toBe('q');
		key($('.ss-search input'), 'ArrowDown');
		await flush();
		expect($('.ss-search input').getAttribute('aria-activedescendant')).toBe('ss-search-0');
		expect($('[aria-selected="true"]').id).toBe('ss-search-0');
		key($('.ss-search input'), 'ArrowUp');
		key($('.ss-search input'), 'x');
		await flush();
		$('.ss-search form').dispatchEvent(new window.Event('submit', { cancelable: true }));
		await flush();
		expect(assign).toHaveBeenCalledWith('/search?q=lamp');
		key($('.ss-search__dialog'), 'Tab');
		key($('.ss-search__dialog'), 'Escape');
		await flush();
		expect($('.ss-search__dialog').hidden).toBe(true);
		expect(document.activeElement).toBe($('.ss-search__open'));
		click($('.ss-search__open'));
		await flush();
		$('.ss-search form').dispatchEvent(new window.Event('submit', { cancelable: true }));
		click($('.ss-search__close'));
		await flush();
		expect(assign).toHaveBeenCalledTimes(2);
	});

	it('shows status messages without a hotkey', async () => {
		const search = createSearchOverlay({
			config: { hotkey: false, source: 'api', source_url: 'https://down.example' },
			strings,
			fetch: /** @type {any} */ (async () => Promise.reject(new Error('x'))),
		});
		mount(search, renderSearch);
		await search.actions.setQuery('desk');
		await flush();
		expect($('.ss-search__status').textContent).toBe(strings['storefront.error']);
		key(document.body, '/');
		expect($('.ss-search__dialog').hidden).toBe(true);
	});
});

describe('ui/hero', () => {
	const config = {
		image: { src: 'https://cdn.example.com/hero.jpg', mobile_src: 'https://cdn.example.com/hero-m.jpg' },
		video: { src: 'https://cdn.example.com/hero.mp4', poster: 'https://cdn.example.com/poster.jpg' },
		cta_href: '/start',
		layout: 'centered',
	};
	/** @param {Record<string, unknown> | undefined} connection */
	const setConnection = (connection) =>
		Object.defineProperty(window.navigator, 'connection', { value: connection, configurable: true });
	afterEach(() => setConnection(undefined));

	it('attaches the video only after load and idle, and lets visitors pause it', async () => {
		const play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined);
		const pause = vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
		/** @type {any} */ (window).requestIdleCallback = (/** @type {() => void} */ fn) => fn();
		const emit = vi.fn();
		const hero = createHero({ config, strings: { ...strings, 'hero.headline': 'Hello', 'hero.text': 'World' }, emit });
		mount(hero, renderHero);
		const video = $('video');
		expect(video.getAttribute('preload')).toBe('none');
		expect(video.muted).toBe(true);
		expect($('img').getAttribute('fetchpriority')).toBe('high');
		expect($('source').getAttribute('srcset')).toBe('https://cdn.example.com/hero-m.jpg');
		expect($('h2').textContent).toBe('Hello');
		await flush();
		expect(video.getAttribute('src')).toBe('https://cdn.example.com/hero.mp4');
		expect(play).toHaveBeenCalled();
		video.dispatchEvent(new window.Event('playing'));
		await flush();
		expect($('video')).toBe(video);
		expect(video.className).toContain('is-on');
		expect($('.ss-hero__pause').textContent).toBe(strings['hero.pause']);
		click($('.ss-hero__pause'));
		await flush();
		expect(pause).toHaveBeenCalled();
		expect(video.hasAttribute('data-paused')).toBe(true);
		expect($('.ss-hero__pause').textContent).toBe(strings['hero.play']);
		click($('.ss-hero__pause'));
		await flush();
		expect(video.hasAttribute('data-paused')).toBe(false);
		follow($('.ss-hero__cta'));
		expect(emit).toHaveBeenCalledWith('action', { action: 'cta' });
		delete (/** @type {any} */ (window).requestIdleCallback);
	});

	it('keeps the poster on Save-Data and slow connections, and waits until the video is near', async () => {
		setConnection({ saveData: true });
		mount(createHero({ config, strings }), renderHero);
		expect($('video')).toBeNull();
		expect($('img').getAttribute('src')).toBe('https://cdn.example.com/hero.jpg');
		expect($('h2')).toBeNull();
		document.body.innerHTML = '';
		setConnection({ effectiveType: '2g' });
		mount(createHero({ config: { ...config, image: { priority: false } }, strings }), renderHero);
		expect($('video')).toBeNull();
		expect($('img').getAttribute('src')).toBe('https://cdn.example.com/poster.jpg');
		expect($('img').getAttribute('loading')).toBe('lazy');
		document.body.innerHTML = '';
		setConnection({ effectiveType: '4g' });
		vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined);
		vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
		const { IO, observers } = fakeIntersection();
		/** @type {any} */ (window).IntersectionObserver = IO;
		vi.useFakeTimers();
		mount(createHero({ config, strings }), renderHero);
		await vi.advanceTimersByTimeAsync(300);
		expect($('video').getAttribute('src')).toBeNull();
		observers[0].fire(true);
		expect($('video').getAttribute('src')).toBe('https://cdn.example.com/hero.mp4');
		observers[0].fire(false);
		observers[0].fire(true);
		mount(createHero({ config, strings }), renderHero, { props: { reducedMotion: true } });
		expect($$('video')).toHaveLength(1);
	});
});

describe('ui sections, navigation and blocks', () => {
	it('cards: a rail of cards; trending band: a marquee of names', async () => {
		pageScript(ITEMS);
		mount(createCards({ config: { layout: 'rail', count: 2 }, strings }), renderCards);
		await flush();
		expect($('.ss-cards__list--rail').getAttribute('tabindex')).toBe('0');
		expect($$('.ss-card')).toHaveLength(2);
		expect($('.ss-card del').textContent).toBe('Was€50.00');
		expect($('.ss-card__badge').textContent).toBe('new');
		document.body.innerHTML = '';
		pageScript(ITEMS);
		mount(createTrendingBand({ config: { layout: 'marquee' }, strings }), renderTrendingBand);
		await flush();
		expect($('.ss-band__marquee').className).toContain('is-moving');
		expect($$('.ss-band__names')).toHaveLength(2);
		expect($$('.ss-band__names')[1].getAttribute('aria-hidden')).toBe('true');
		document.body.innerHTML = '';
		pageScript(ITEMS);
		mount(createTrendingBand({ config: { layout: 'marquee' }, strings }), renderTrendingBand, {
			props: { reducedMotion: true },
		});
		await flush();
		expect($$('.ss-band__names')).toHaveLength(1);
		document.body.innerHTML = '';
		pageScript([]);
		const empty = document.createElement('p');
		mount(createCards({ strings }), renderCards, { props: { slots: { empty } } });
		await flush();
		expect(document.body.contains(empty)).toBe(true);
		document.body.innerHTML = '';
		mount(
			createCards({
				config: { source: 'api', source_url: 'https://down.example' },
				strings,
				fetch: /** @type {any} */ (async () => Promise.reject(new Error('x'))),
			}),
			renderCards,
		);
		await flush();
		expect($('[role="alert"]')).not.toBeNull();
	});

	it('category and brand cards are navigation landmarks', async () => {
		mount(
			createCategoryCards({
				config: {
					cards: [{ title: 'Lighting', href: '/c/lighting', image: 'https://c.example/l.jpg', count: 3 }],
					show_counts: true,
				},
				strings,
			}),
			renderCategoryCards,
		);
		await flush();
		expect($('nav').getAttribute('aria-label')).toBe('Categories');
		expect($('.ss-nav__card').getAttribute('href')).toBe('/c/lighting');
		expect($('.ss-nav__count').textContent).toBe('3 items');
		document.body.innerHTML = '';
		mount(
			createBrandCards({
				config: {
					cards: [{ title: 'Lumo', image: 'https://c.example/lumo.svg' }, { title: 'Plain' }],
					show_names: false,
					layout: 'rail',
				},
				strings,
			}),
			renderBrandCards,
		);
		await flush();
		expect($('nav').getAttribute('aria-label')).toBe('Brands');
		expect($('img').getAttribute('alt')).toBe('Lumo');
		expect($$('.ss-nav__name').map((n) => n.textContent)).toEqual(['Plain']);
		expect($('a')).toBeNull();
	});

	it('deals page: deals with time left and load more', async () => {
		const deal = (/** @type {string} */ id) => ({
			id,
			name: `Deal ${id}`,
			badge: { label: 'Hot' },
			description: 'Every evening.',
			endsAt: '2030-01-01T00:00:00Z',
			items: [{ itemId: 'i', title: 'T', price: 900, unitAmount: 1000, currency: 'EUR' }],
		});
		/** @type {any} */
		const fetch = async (/** @type {string} */ url) => ({
			ok: true,
			status: 200,
			headers: { get: () => null },
			text: async () =>
				JSON.stringify(
					url.includes('cursor') ? { items: [deal('b')], nextCursor: null } : { items: [deal('a')], nextCursor: 'n' },
				),
		});
		mount(
			createDealsPage({
				config: { source: 'api', source_url: 'https://deals.example', layout: 'list' },
				strings,
				fetch,
				now: () => Date.parse('2029-12-31T22:00:00Z'),
			}),
			renderDeals,
		);
		await flush();
		expect($('.ss-deals__left').textContent).toBe('Ends in 0d 2h 0m');
		expect($('.ss-deals__head h3').textContent).toBe('Deal a');
		click($('.ss-deals__more'));
		await flush();
		expect($$('.ss-deals__deal')).toHaveLength(2);
		expect($('.ss-deals__more')).toBeNull();
		document.body.innerHTML = '';
		mount(createDealsPage({ strings }), renderDeals);
		await flush();
		expect($('.ss-deals p').textContent).toBe(strings['deals_page.empty']);
		document.body.innerHTML = '';
		mount(
			createDealsPage({
				config: { source: 'api', source_url: 'https://down.example' },
				strings,
				fetch: /** @type {any} */ (async () => Promise.reject(new Error('x'))),
			}),
			renderDeals,
		);
		await flush();
		expect($('[role="alert"]')).not.toBeNull();
	});

	it('notice bar: dismiss, empty text hides it', async () => {
		const emit = vi.fn();
		mount(
			createNoticeBar({
				config: { link_href: '/sale', sticky: true },
				strings: { ...strings, 'notice_bar.text': 'Free returns' },
				emit,
			}),
			renderNoticeBar,
		);
		expect($('.ss-notice a').textContent).toBe('Free returns');
		expect($('.ss-notice').className).toContain('ss-notice--sticky');
		click($('.ss-notice__close'));
		await flush();
		expect($('.ss-notice').hidden).toBe(true);
		expect(emit).toHaveBeenCalledWith('dismissed', {});
		document.body.innerHTML = '';
		mount(createNoticeBar({ config: { dismissible: false }, strings }), renderNoticeBar);
		expect($('.ss-notice').hidden).toBe(true);
		expect($('.ss-notice__close')).toBeNull();
	});

	it('mobile tab bar marks the current page and follows navigation', async () => {
		goTo('/deals/today');
		const tabs = createMobileTabBar({
			config: {
				tabs: [
					{ key: 'home', href: '/', icon: 'home' },
					{ key: 'deals', href: '/deals', icon: 'tag', label: 'Deals' },
				],
			},
			strings,
		});
		mount(tabs, renderMobileTabBar);
		await flush();
		expect($('[aria-current="page"]').textContent).toBe('Deals');
		expect($$('svg')).toHaveLength(2);
		window.history.pushState(null, '', '/');
		window.dispatchEvent(new window.PopStateEvent('popstate'));
		await flush();
		expect($('[aria-current="page"]').getAttribute('href')).toBe('/');
		follow($('.ss-tabbar__tab'));
		document.body.innerHTML = '';
		mount(createMobileTabBar({ config: { show_labels: false }, strings }), renderMobileTabBar);
		expect($('.ss-tabbar__tab').getAttribute('aria-label')).toBe('Home');
	});

	it('contact footer lists contacts, hours, socials and links', () => {
		mount(
			createContactFooter({
				config: {
					business_name: 'Shop',
					contacts: [
						{ kind: 'phone', label: 'Call', value: '+1 555 0100' },
						{ kind: 'address', value: '1 Main St' },
						{ kind: 'link', value: 'Somewhere' },
					],
					hours: [{ days: 'Mon–Fri', time: '9–17' }],
					socials: [{ label: 'Social', href: 'https://social.example/shop' }],
					links: [{ label: 'Returns', href: '/returns' }],
				},
				strings,
			}),
			renderContactFooter,
		);
		expect($('footer').getAttribute('role')).toBe('contentinfo');
		expect($('a[href="tel:+15550100"]').textContent).toBe('+1 555 0100');
		expect($('address').textContent).toBe('1 Main St');
		expect($('dt').textContent).toBe('Mon–Fri');
		expect($('a[href="https://social.example/shop"]').getAttribute('rel')).toBe('noopener noreferrer me');
		expect($('.ss-footer__legal').textContent).toBe(`© ${new Date().getFullYear()} Shop`);
		document.body.innerHTML = '';
		mount(createContactFooter({ config: { show_year: false }, strings }), renderContactFooter);
		expect($('.ss-footer__legal')).toBeNull();
	});

	it('theme writes tokens on the page root and loads the web font', async () => {
		const add = vi.fn();
		Object.defineProperty(document, 'fonts', { value: { add }, configurable: true });
		/** @type {any} */ (window).FontFace = function FontFace(/** @type {string} */ family, /** @type {string} */ source) {
			return { family, source, load: async () => undefined };
		};
		const theme = createTheme({
			config: {
				colors: { primary: '#0a0a0a' },
				motion: 'reduced',
				fonts: { family: 'Brand', url: 'https://f.example/b.woff2' },
			},
		});
		const view = mount(theme, renderTheme, { props: { reducedMotion: true } });
		await flush();
		expect(document.documentElement.style.getPropertyValue('--ss-color-primary')).toBe('#0a0a0a');
		expect(document.documentElement.style.getPropertyValue('--ss-motion-duration')).toBe('0ms');
		expect(view.node().hidden).toBe(true);
		expect(add).toHaveBeenCalledTimes(1);
		expect(add.mock.calls[0]?.[0].source).toBe('url("https://f.example/b.woff2") format("woff2")');
		delete (/** @type {any} */ (window).FontFace);
	});

	it('ships token-only styles', () => {
		for (const css of [
			gridStyles,
			cardsStyles,
			bandStyles,
			filterStyles,
			searchStyles,
			heroStyles,
			navStyles,
			dealsStyles,
			noticeStyles,
			tabBarStyles,
			footerStyles,
		]) {
			expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
			expect(css).toMatch(/var\(--ss-/);
			expect(css).toMatch(/:focus-visible|ss-tabbar|ss-footer/);
		}
		expect(gridStyles).toContain('prefers-reduced-motion');
		expect(bandStyles).toContain('prefers-reduced-motion');
	});
});
