/** Mode B headless cores (state machines on a scripted client) and Mode A renderers (structure, a11y, variants, slots). */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createBrands } from '../headless/brands.js';
import { createCollections } from '../headless/collections.js';
import { createFilters, facetVisible } from '../headless/filters.js';
import { createGallery } from '../headless/gallery.js';
import { cardOf, createItems } from '../headless/items.js';
import { createTranslator } from '../headless/strings.js';
import { closestVariant, createVariantPicker } from '../headless/variants.js';
import { createStore } from '../headless/store.js';
import * as brandsUi from '../ui/brands.js';
import * as collectionsUi from '../ui/collections.js';
import * as filtersUi from '../ui/filters.js';
import * as galleryUi from '../ui/gallery.js';
import * as itemsUi from '../ui/items.js';
import * as variantsUi from '../ui/variants.js';
import { createClient, createFakeDom, findAll, itemView } from './helpers.js';

const strings = JSON.parse(readFileSync(new URL('../strings/en.json', import.meta.url), 'utf8'));
const dom = createFakeDom();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('headless store and strings', () => {
	it('freezes snapshots, notifies, unsubscribes and stops after destroy', () => {
		const store = createStore({ n: 1 });
		const seen = vi.fn();
		const off = store.subscribe(seen);
		store.set({ n: 2 });
		expect(Object.isFrozen(store.get())).toBe(true);
		off();
		store.set({ n: 3 });
		expect(seen).toHaveBeenCalledTimes(1);
		store.destroy();
		store.set({ n: 4 });
		expect(store.get().n).toBe(3);
		expect(store.isDestroyed()).toBe(true);
		expect(createTranslator({ a: 'Hi {name} {x}' })('a', { name: 'Ada' })).toBe('Hi Ada {x}');
		expect(createTranslator({})('missing')).toBe('missing');
	});
});

describe('items element', () => {
	const pages = {
		'GET /v1/items': (/** @type {any} */ query) =>
			query.cursor
				? {
						items: [itemView({ id: 'itm_2', title: 'Second', priceMax: 2000, media: [], brand: null, inStock: false })],
						nextCursor: null,
						hasMore: false,
					}
				: { items: [itemView()], nextCursor: 'c1', hasMore: true },
	};

	it('loads, sorts, filters, pages and selects; builds cards with prices and availability', async () => {
		const client = createClient(pages);
		const emit = vi.fn();
		const element = createItems({
			config: { sorts: ['newest', 'price_asc'], default_sort: 'price_asc', page_size: 10 },
			strings,
			client,
			emit,
		});
		expect(element.state()).toMatchObject({ status: 'idle', sort: 'price_asc' });
		await element.actions.load({ collectionId: 'col_1' });
		expect(element.state().items[0]).toMatchObject({
			title: 'Polo',
			priceText: 'From €20.00',
			compareText: '€25.00',
			availabilityText: 'In stock',
			brand: 'Acme',
			image: { url: 'https://cdn.example.com/1.jpg' },
		});
		expect(client.calls[0].query).toMatchObject({ sort: 'price_asc', limit: 10, 'filter[collectionId]': 'col_1' });
		expect(emit).toHaveBeenCalledWith('viewed', { count: 1 });
		await element.actions.loadMore();
		expect(element.state().items.map((i) => i.title)).toEqual(['Polo', 'Second']);
		expect(element.state().items[1]).toMatchObject({ priceText: '€20.00', image: null, availabilityText: 'Sold out' });
		expect((await element.actions.loadMore()).ok).toBe(false);
		expect((await element.actions.setSort('bogus')).ok).toBe(false);
		await element.actions.setSort('newest');
		await element.actions.setFilter('inStock', true);
		expect((await element.actions.setFilter(/** @type {any} */ ('nope'), 1)).ok).toBe(false);
		await element.actions.setFacets({ size: ['s', 'm'], color: [] });
		expect(client.calls.at(-1)?.query).toMatchObject({ 'filter[attr.size]': 's,m', 'filter[inStock]': true, sort: 'newest' });
		expect(element.actions.select('itm_1').ok).toBe(true);
		expect(element.actions.select('itm_x').ok).toBe(false);
		expect(emit).toHaveBeenCalledWith('selected', { itemId: 'itm_1' });
		expect(element.validate({ priceMin: -1, priceMax: 5 })).toEqual([
			{ path: '/priceMin', code: 'amount_invalid', message: 'Enter a whole amount.' },
		]);
		element.destroy();
	});

	it('reports load errors and renders the grid / list with sort, show more, empty state and slots', async () => {
		const failing = createItems({ strings, client: createClient({}) });
		await failing.actions.load();
		expect(failing.state()).toMatchObject({ status: 'error', error: 'This could not be loaded. Please try again.' });
		const element = createItems({ config: { sorts: ['newest', 'title'] }, strings, client: createClient(pages) });
		await element.actions.load();
		const actions = { setSort: vi.fn(), loadMore: vi.fn(), select: vi.fn() };
		const root = itemsUi.render({ state: element.state(), actions, strings, dom, slots: { before: dom.createTextNode('B') } });
		expect(root.attributes).toMatchObject({
			role: 'region',
			'aria-label': 'Items',
			'aria-busy': 'false',
			class: 'ss-items ss-items--grid',
		});
		const [select] = findAll(root, (n) => n.tag === 'select');
		select.dispatch('change', { target: { value: 'title' } });
		expect(actions.setSort).toHaveBeenCalledWith('title');
		findAll(root, (n) => n.tag === 'button')[0].dispatch('click');
		expect(actions.loadMore).toHaveBeenCalled();
		findAll(root, (n) => n.tag === 'a')[0].dispatch('click');
		expect(actions.select).toHaveBeenCalledWith('itm_1');
		expect(root.textContent).toContain('B');
		const list = itemsUi.render({
			state: { ...element.state(), items: [], hasMore: false, status: 'ready', sorts: ['newest'] },
			actions,
			strings,
			dom,
			theme: { variant: 'list' },
		});
		expect(list.attributes.class).toContain('ss-items--list');
		expect(list.textContent).toContain('Nothing to show here yet.');
		expect(itemsUi.styles).toContain('var(--ss-');
		expect(
			cardOf(itemView({ priceMin: null, media: [] }), { t: createTranslator(strings), locale: 'en' }).priceText,
		).toBeNull();
	});
});

describe('variants element', () => {
	const routes = { 'GET /v1/items/polo': () => itemView() };

	it('picks the first purchasable variant, marks available values and lands on the closest variant', async () => {
		const emit = vi.fn();
		const picker = createVariantPicker({ strings, client: createClient(routes), emit });
		await picker.actions.load('polo');
		expect(picker.state()).toMatchObject({
			status: 'ready',
			selection: { size: 's', color: 'navy' },
			priceText: '€20.00',
			compareText: '€25.00',
			availabilityText: 'In stock',
			purchasable: true,
		});
		const size = picker.state().options[0];
		expect(size?.values).toEqual([
			{ value: 's', label: 'S', selected: true, available: true },
			{ value: 'm', label: 'M', selected: false, available: false },
		]);
		const moved = picker.actions.select('size', 'm');
		expect(moved.ok && moved.value.id).toBe('var_3');
		expect(picker.state().selection).toEqual({ size: 'm', color: 'red' });
		expect(picker.state().availabilityText).toBe('Only a few left');
		expect(emit).toHaveBeenCalledWith('selected', { itemId: 'itm_1', variantId: 'var_3' });
		expect(picker.actions.select('size', 'xl').ok).toBe(false);
		expect(picker.validate()).toEqual([]);
		await picker.actions.load('polo', { variantId: 'var_2' });
		expect(picker.state().purchasable).toBe(false);
		expect(picker.validate()[0]?.code).toBe('not_purchasable');
		expect(closestVariant([], { size: 's' })).toBeNull();
		expect(closestVariant([{ id: 'a', options: { size: 's' }, purchasable: false }], { size: 's' })?.id).toBe('a');
		const failing = createVariantPicker({ strings, client: createClient({}) });
		await failing.actions.load('nope');
		expect(failing.state().status).toBe('error');
		const empty = createVariantPicker({
			strings,
			client: createClient({ 'GET /v1/items/x': () => ({ id: 'x', title: 'X', variants: [], options: [] }) }),
		});
		await empty.actions.load('x');
		expect(empty.state()).toMatchObject({ variant: null, priceText: null });
		picker.destroy();
	});

	it('renders buttons (pressed, unavailable) and selects', async () => {
		const picker = createVariantPicker({ strings, client: createClient(routes) });
		await picker.actions.load('polo');
		const actions = { select: vi.fn() };
		const root = variantsUi.render({ state: picker.state(), actions, strings, dom });
		expect(root.attributes).toMatchObject({ role: 'group', 'aria-label': 'Options' });
		const buttons = findAll(root, (n) => n.tag === 'button');
		expect(buttons.map((b) => b.attributes['aria-pressed'])).toEqual(['true', 'false', 'true', 'false']);
		expect(buttons[1].attributes.class).toContain('ss-variants__value--unavailable');
		buttons[1].dispatch('click');
		expect(actions.select).toHaveBeenCalledWith('size', 'm');
		const selects = variantsUi.render({
			state: picker.state(),
			actions,
			strings,
			dom,
			theme: { variant: 'selects' },
			slots: { after: dom.createTextNode('A') },
		});
		const [select] = findAll(selects, (n) => n.tag === 'select');
		select.dispatch('change', { target: { value: 's' } });
		expect(actions.select).toHaveBeenCalledWith('size', 's');
		expect(selects.textContent).toContain('M (unavailable)');
		expect(variantsUi.styles).toContain('var(--ss-');
	});
});

describe('attributes element (filters)', () => {
	const facets = {
		'GET /v1/attributes:facets': () => ({
			items: [
				{
					key: 'size',
					label: 'Size',
					unit: null,
					visibility: { type: 'always' },
					values: [
						{ value: 's', label: 'S', count: 2 },
						{ value: 'm', label: 'M', count: 1 },
					],
				},
				{
					key: 'fit',
					label: 'Fit',
					visibility: { type: 'attribute', attributeKey: 'size', values: ['m'] },
					values: [{ value: 'slim', label: 'Slim', count: 1 }],
				},
				{
					key: 'warranty',
					label: 'Warranty',
					visibility: { type: 'brand', brandIds: ['brd_1'] },
					values: [{ value: 'y', label: 'Yes', count: 1 }],
				},
				{ key: 'empty', label: 'Empty', values: [] },
			],
		}),
	};

	it('shows conditional facets, toggles, clears and hands the selection to items', async () => {
		const emit = vi.fn();
		const filters = createFilters({ strings, client: createClient(facets), emit });
		await filters.actions.load({ collectionId: 'col_1' });
		expect(filters.state().facets.map((f) => f.key)).toEqual(['size']);
		filters.actions.toggle('size', 'm');
		expect(filters.state().facets.map((f) => f.key)).toEqual(['size', 'fit']);
		filters.actions.toggle('fit', 'slim');
		expect(filters.actions.selection()).toEqual({ size: ['m'], fit: ['slim'] });
		expect(filters.state().count).toBe(2);
		filters.actions.toggle('size', 'm');
		expect(filters.actions.selection()).toEqual({});
		expect(filters.actions.toggle('size', 'xl').ok).toBe(false);
		filters.actions.toggle('size', 's');
		filters.actions.clear();
		expect(filters.state().count).toBe(0);
		expect(emit).toHaveBeenCalledWith('changed', { count: 0 });
		await filters.actions.load({ brandId: 'brd_1' });
		expect(filters.state().facets.map((f) => f.key)).toEqual(['size', 'warranty']);
		expect(facetVisible({}, {}, null)).toBe(true);
		expect(facetVisible({ visibility: { type: 'brand' } }, {}, null)).toBe(false);
		expect(filters.validate()).toEqual([]);
		const failing = createFilters({ strings, client: createClient({}) });
		await failing.actions.load();
		expect(failing.state().status).toBe('error');
		filters.destroy();
	});

	it('renders checkbox groups with counts and a clear button', async () => {
		const filters = createFilters({ strings, client: createClient(facets) });
		await filters.actions.load();
		filters.actions.toggle('size', 's');
		const actions = { toggle: vi.fn(), clear: vi.fn() };
		const root = filtersUi.render({ state: filters.state(), actions, strings, dom, theme: { variant: 'bar' } });
		expect(root.attributes.class).toContain('ss-filters--bar');
		const boxes = findAll(root, (n) => n.tag === 'input');
		expect(boxes[0].attributes.checked).toBe('checked');
		boxes[1].dispatch('change');
		expect(actions.toggle).toHaveBeenCalledWith('size', 'm');
		findAll(root, (n) => n.tag === 'button')[0].dispatch('click');
		expect(actions.clear).toHaveBeenCalled();
		expect(root.textContent).toContain('(2)');
		const none = filtersUi.render({ state: { ...filters.state(), count: 0 }, actions, strings, dom });
		expect(findAll(none, (n) => n.tag === 'button')).toHaveLength(0);
		expect(filtersUi.styles).toContain('var(--ss-');
	});
});

describe('collections element', () => {
	const tree = {
		'GET /v1/collections': () => ({
			items: [
				{
					id: 'c1',
					slug: 'clothing',
					title: 'Clothing',
					depth: 1,
					children: [{ id: 'c2', slug: 'tops', title: 'Tops', depth: 2, children: [] }],
				},
				{ id: 'c3', slug: 'sale', title: 'Sale', depth: 1 },
			],
		}),
	};

	it('expands, collapses, selects with a path', async () => {
		const emit = vi.fn();
		const element = createCollections({ strings, client: createClient(tree), emit });
		await element.actions.load({ activeId: 'c2' });
		expect(element.state()).toMatchObject({
			activeId: 'c2',
			path: [
				{ id: 'c1', title: 'Clothing' },
				{ id: 'c2', title: 'Tops' },
			],
		});
		expect(element.state().tree[0]?.expanded).toBe(true);
		element.actions.toggle('c1');
		expect(element.state().tree[0]?.expanded).toBe(false);
		expect(element.actions.toggle('zz').ok).toBe(false);
		expect(element.actions.select('c3').ok).toBe(true);
		expect(element.actions.select('zz').ok).toBe(false);
		expect(emit).toHaveBeenCalledWith('selected', { collectionId: 'c3' });
		expect(element.validate()).toEqual([]);
		const failing = createCollections({ strings, client: createClient({}) });
		await failing.actions.load();
		expect(failing.state().status).toBe('error');
		const plain = createCollections({ strings, client: createClient(tree) });
		await plain.actions.load();
		expect(plain.state().path).toEqual([]);
		element.destroy();
	});

	it('renders a tree with toggles and aria-current, and cards', async () => {
		const element = createCollections({ strings, client: createClient(tree) });
		await element.actions.load({ activeId: 'c2' });
		const actions = { toggle: vi.fn(), select: vi.fn() };
		const root = collectionsUi.render({ state: element.state(), actions, strings, dom });
		expect(root.attributes).toMatchObject({ role: 'navigation', 'aria-label': 'Collections' });
		const buttons = findAll(root, (n) => n.tag === 'button');
		expect(buttons[0].attributes['aria-expanded']).toBe('true');
		buttons[0].dispatch('click');
		expect(actions.toggle).toHaveBeenCalledWith('c1');
		const active = buttons.find((b) => b.attributes['aria-current'] === 'true');
		active.dispatch('click');
		expect(actions.select).toHaveBeenCalledWith('c2');
		const cards = collectionsUi.render({ state: element.state(), actions, strings, dom, theme: { variant: 'cards' } });
		expect(findAll(cards, (n) => n.tag === 'button').map((b) => b.textContent)).toEqual(['Clothing', 'Sale']);
		element.actions.toggle('c1');
		const collapsed = collectionsUi.render({ state: element.state(), actions, strings, dom });
		expect(findAll(collapsed, (n) => n.tag === 'button')[0].attributes['aria-label']).toBe('Show Clothing');
		expect(collectionsUi.styles).toContain('var(--ss-');
	});
});

describe('brands element', () => {
	const brands = {
		'GET /v1/brands': () => ({
			items: [
				{
					id: 'b1',
					slug: 'acme',
					name: 'Acme',
					logo: { url: 'https://cdn.example.com/acme.svg', alt: null },
					collectionIds: [],
				},
				{ id: 'b2', slug: 'zed', name: 'Zed', logo: null, collectionIds: ['col_9'] },
			],
		}),
	};

	it('loads (optionally per collection), selects and clears', async () => {
		const emit = vi.fn();
		const element = createBrands({ strings, client: createClient(brands), emit });
		await element.actions.load({ collectionId: 'col_1' });
		expect(element.state().brands.map((b) => b.name)).toEqual(['Acme']);
		await element.actions.load();
		element.actions.select('b2');
		expect(element.state().brands.find((b) => b.id === 'b2')?.selected).toBe(true);
		expect(element.actions.select('zz').ok).toBe(false);
		element.actions.select(null);
		expect(element.state().selectedId).toBeNull();
		expect(emit).toHaveBeenCalledWith('selected', { brandId: null });
		expect(element.validate()).toEqual([]);
		const failing = createBrands({ strings, client: createClient({}) });
		await failing.actions.load();
		expect(failing.state().status).toBe('error');
		element.destroy();
	});

	it('renders logos (alt = name) or names, toggling the selection', async () => {
		const element = createBrands({ strings, client: createClient(brands) });
		await element.actions.load();
		element.actions.select('b1');
		const actions = { select: vi.fn() };
		const root = brandsUi.render({ state: element.state(), actions, strings, dom });
		const [logo] = findAll(root, (n) => n.tag === 'img');
		expect(logo.attributes.alt).toBe('Acme');
		const buttons = findAll(root, (n) => n.tag === 'button');
		buttons[0].dispatch('click');
		expect(actions.select).toHaveBeenCalledWith(null);
		buttons[1].dispatch('click');
		expect(actions.select).toHaveBeenCalledWith('b2');
		const list = brandsUi.render({ state: element.state(), actions, strings, dom, theme: { variant: 'list' } });
		expect(findAll(list, (n) => n.tag === 'img')).toHaveLength(0);
		expect(brandsUi.styles).toContain('var(--ss-');
	});
});

describe('media element (gallery)', () => {
	const routes = { 'GET /v1/items/polo': () => itemView() };

	it('shows media with wrapping next / previous, narrows to a variant', async () => {
		const emit = vi.fn();
		const gallery = createGallery({ strings, client: createClient(routes), emit });
		await gallery.actions.load('polo');
		expect(gallery.state()).toMatchObject({ title: 'Polo', index: 0, positionText: '1 / 2' });
		gallery.actions.next();
		gallery.actions.next();
		expect(gallery.state().index).toBe(0);
		gallery.actions.previous();
		expect(gallery.state().index).toBe(1);
		expect(gallery.actions.show(0).ok).toBe(true);
		expect(gallery.actions.show(9).ok).toBe(false);
		expect(emit).toHaveBeenCalledWith('shown', { index: 0 });
		gallery.actions.forVariant('var_1');
		expect(gallery.state().media.map((m) => m.id)).toEqual(['med_1']);
		gallery.actions.forVariant(null);
		expect(gallery.validate()).toEqual([]);
		const empty = createGallery({ strings, client: createClient({ 'GET /v1/items/x': () => ({ title: 'X' }) }) });
		await empty.actions.load('x');
		expect(empty.actions.next().ok).toBe(false);
		expect(empty.actions.previous().ok).toBe(false);
		expect(empty.state().positionText).toBeNull();
		const failing = createGallery({ strings, client: createClient({}) });
		await failing.actions.load('x');
		expect(failing.state().status).toBe('error');
		gallery.destroy();
	});

	it('renders the current media with navigation and thumbnails, a strip, and an empty state', async () => {
		const gallery = createGallery({ strings, client: createClient(routes) });
		await gallery.actions.load('polo');
		const actions = { next: vi.fn(), previous: vi.fn(), show: vi.fn() };
		const root = galleryUi.render({ state: gallery.state(), actions, strings, dom });
		expect(root.attributes['aria-label']).toBe('Gallery of Polo');
		const [main] = findAll(root, (n) => n.tag === 'img');
		expect(main.attributes).toMatchObject({
			src: 'https://cdn.example.com/1.jpg',
			srcset: 'a 320w',
			alt: 'Front',
			width: '800',
		});
		const buttons = findAll(root, (n) => n.tag === 'button');
		buttons[0].dispatch('click');
		buttons[1].dispatch('click');
		buttons[3].dispatch('click');
		expect(actions.previous).toHaveBeenCalled();
		expect(actions.next).toHaveBeenCalled();
		expect(actions.show).toHaveBeenCalledWith(1);
		gallery.actions.show(1);
		const video = galleryUi.render({ state: gallery.state(), actions, strings, dom });
		expect(findAll(video, (n) => n.tag === 'video')).toHaveLength(1);
		const strip = galleryUi.render({ state: gallery.state(), actions, strings, dom, theme: { variant: 'strip' } });
		expect(findAll(strip, (n) => n.tag === 'li')).toHaveLength(2);
		const empty = galleryUi.render({ state: { ...gallery.state(), media: [], title: null }, actions, strings, dom });
		expect(empty.textContent).toContain('No pictures yet.');
		expect(empty.attributes['aria-label']).toBe('Gallery');
		expect(galleryUi.styles).toContain('var(--ss-');
		await tick();
	});
});
