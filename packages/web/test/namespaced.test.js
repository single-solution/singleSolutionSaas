// @vitest-environment jsdom
/* global window, document */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { defineElement } from '../src/element.js';
import { boot, elementId } from '../src/loader.js';
import { ENDPOINT, KEY, WEBSITE_ID, memoryStorage, scriptedFetch } from './helpers.js';

/** @type {Array<{ destroy: () => void }>} */
const cleanup = [];
/** @type {any} */
const win = window;

/** @type {any[]} */
let contexts = [];

/** @param {string} key */
const headless = (key) =>
	defineElement({
		key,
		initialState: { n: 0 },
		create: (context) => {
			contexts.push(context);
			return { actions: { close: () => context.emit('dismissed') } };
		},
	});
const renderer = { render: (/** @type {any} */ { h, element }) => h('p', null, element.key) };

const client = () => {
	const made = createClient({
		key: KEY,
		endpoint: ENDPOINT,
		websiteId: WEBSITE_ID,
		storage: memoryStorage(),
		fetch: scriptedFetch({ status: 202 }),
		defaultConsent: { analytics: true },
	});
	cleanup.push(made);
	return made;
};

/** @param {any} bundle @param {any} [extra] */
const start = (bundle, extra = {}) => {
	const instance = boot({ websiteId: WEBSITE_ID, env: 'test', storage: memoryStorage(), bundle, ...extra });
	cleanup.push(instance);
	return instance;
};

beforeEach(() => {
	vi.useFakeTimers();
	contexts = [];
	document.body.innerHTML = '<main></main>';
});
afterEach(() => {
	for (const item of cleanup.splice(0)) item.destroy();
	vi.useRealTimers();
	delete win.SS;
});

describe('namespaced element ids (F.18)', () => {
	it('runs the same key from two products and addresses them by <product>:<key>', async () => {
		const loader = start(
			{
				elements: [
					{ key: 'deals_page', product: 'storefront', headless: headless('deals_page'), renderer },
					{ key: 'deals_page', product: 'deals', headless: headless('deals_page'), renderer },
					{ key: 'hero', product: 'storefront', headless: headless('hero'), renderer },
					{ key: 'hero', product: 'storefront', headless: headless('hero'), renderer },
					{ key: 'bad', product: 'Not A Slug', headless: headless('bad'), renderer },
				],
			},
			{ client: client() },
		);
		await vi.advanceTimersByTimeAsync(0);
		await loader.ready();
		expect(loader.list().map((entry) => entry.id)).toEqual(['storefront:deals_page', 'deals:deals_page', 'storefront:hero']);
		expect(loader.get('storefront:deals_page')).toBeDefined();
		expect(loader.get('deals:deals_page')).not.toBe(loader.get('storefront:deals_page'));
		// un-namespaced lookups work while unambiguous
		expect(loader.get('deals_page')).toBeUndefined();
		expect(loader.get('hero')).toBe(loader.get('storefront:hero'));
		expect(loader.get('nope:hero')).toBeUndefined();
		expect(win.SS.elements.get('storefront:hero')).toBe(loader.get('hero'));
		const containers = [...document.querySelectorAll('[data-ss-element="deals_page"]')];
		expect(containers.map((node) => node.getAttribute('data-ss-id'))).toEqual(['storefront:deals_page', 'deals:deals_page']);
		expect(containers[1]?.getAttribute('data-ss-product')).toBe('deals');
		expect(elementId({ key: 'x' })).toBe('x');
	});

	it('publishes element events under the plain and the namespaced name', async () => {
		const loader = start({
			elements: [
				{ key: 'deals_page', product: 'storefront', headless: headless('deals_page'), renderer },
				{ key: 'deals_page', product: 'deals', headless: headless('deals_page'), renderer },
			],
		});
		/** @type {string[]} */
		const seen = [];
		win.SS.on('deals:deals_page.dismissed', () => seen.push('deals'));
		win.SS.on('storefront:deals_page.shown@1', () => seen.push('storefront shown'));
		win.SS.on('deals_page.dismissed', () => seen.push('plain'));
		await vi.advanceTimersByTimeAsync(0);
		await loader.ready();
		await loader.get('deals:deals_page')?.actions.close?.();
		expect(seen).toEqual(['storefront shown', 'plain', 'deals']);
	});

	it('passes read-API clients for the products an element reads', async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }));
		const loader = start(
			{
				elements: [
					{
						key: 'grid',
						product: 'storefront',
						headless: headless('grid'),
						renderer,
						reads: { catalog: { baseUrl: 'https://catalog.example' }, 'Bad Slug': { baseUrl: 'https://x.example' } },
					},
					{ key: 'plain', headless: headless('plain'), renderer, reads: { search: { baseUrl: 'not a url' } } },
				],
			},
			{ client: client(), fetch },
		);
		await vi.advanceTimersByTimeAsync(0);
		await loader.ready();
		expect(Object.keys(contexts[0].clients)).toEqual(['catalog']);
		expect(Object.keys(contexts[1].clients)).toEqual([]);
		const result = await contexts[0].clients.catalog.get('/v1/items', { query: { limit: 2 } });
		expect(result.ok).toBe(true);
		expect(fetch).toHaveBeenCalledWith(
			'https://catalog.example/v1/items?limit=2',
			expect.objectContaining({ headers: expect.objectContaining({ authorization: `Bearer ${KEY}` }) }),
		);
	});

	it('keeps frequency caps per key while unique and per id when shared', async () => {
		const storage = memoryStorage();
		const capped = { frequency: { maxPerVisitor: 1 } };
		const first = boot({
			websiteId: WEBSITE_ID,
			env: 'test',
			storage,
			bundle: { elements: [{ key: 'hero', product: 'storefront', headless: headless('hero'), renderer, placement: capped }] },
		});
		await vi.advanceTimersByTimeAsync(0);
		await first.ready();
		first.destroy();
		const second = boot({
			websiteId: WEBSITE_ID,
			env: 'test',
			storage,
			bundle: {
				elements: [
					{ key: 'hero', product: 'storefront', headless: headless('hero'), renderer, placement: capped },
					{ key: 'hero', product: 'other', headless: headless('hero'), renderer, placement: capped },
				],
			},
		});
		cleanup.push(second);
		await vi.advanceTimersByTimeAsync(0);
		await second.ready();
		// the id-keyed caps are fresh for both (the earlier cap was stored under the plain key)
		expect(second.list().map((entry) => entry.status)).toEqual(['mounted', 'mounted']);
	});
});
