/* global document -- these helpers run in the jsdom test environment */
/** Test doubles and fixtures shared by the unit tests (no network: `fetch` is always injected). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The pack's folder (a path, not a URL: jsdom replaces the global URL). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The string catalog. */
export const strings = /** @type {Record<string, string>} */ (
	JSON.parse(readFileSync(path.join(ROOT, 'strings/en.json'), 'utf8'))
);

/** A generic catalogue: no store, category or currency is special. */
export const ITEMS = Object.freeze([
	{
		id: 'itm_1',
		title: 'Desk lamp',
		url: '/items/desk-lamp',
		image: 'https://cdn.example.com/lamp.jpg',
		price: 4500,
		compareAtPrice: 5000,
		currency: 'EUR',
		brand: 'Lumo',
		badges: ['new'],
		collections: ['lighting'],
		attributes: { colour: ['white', 'black'], finish: 'matte' },
		variants: [
			{ price: 4500, attributes: { colour: 'white' }, inventory: 3 },
			{ price: 4800, attributes: { colour: 'black' }, inventory: 0 },
		],
		rank: 5,
		createdAt: '2026-09-01T00:00:00Z',
	},
	{
		id: 'itm_2',
		title: 'Floor lamp',
		url: '/items/floor-lamp',
		image: 'https://cdn.example.com/floor.jpg',
		price: 12000,
		currency: 'EUR',
		brand: 'Lumo',
		collections: ['lighting'],
		attributes: { colour: 'black', featured: true },
		inStock: true,
		rank: 9,
		createdAt: '2026-09-20T00:00:00Z',
	},
	{
		id: 'itm_3',
		title: 'Armchair',
		url: '/items/armchair',
		price: 30000,
		currency: 'EUR',
		brand: 'Sitwell',
		collections: ['seating'],
		attributes: { colour: 'green' },
		inStock: false,
		createdAt: '2026-08-01T00:00:00Z',
	},
	{
		id: 'itm_4',
		title: 'Bookshelf',
		url: '/items/bookshelf',
		price: 18000,
		currency: 'EUR',
		brand: 'Oakline',
		collections: ['storage'],
		attributes: { colour: 'oak' },
		rank: 1,
	},
	{ id: 'itm_5', title: 'Side table', url: '/items/side-table', price: 9000, brand: 'Oakline', collections: ['storage'] },
]);

/**
 * A fake `fetch`: `routes` maps a URL prefix to a JSON body (or `{ status, body }`); every call is recorded.
 * @param {Record<string, unknown>} routes
 */
export const fakeFetch = (routes) => {
	/** @type {Array<{ url: string, init: any }>} */
	const calls = [];
	/** @param {string} url @param {any} [init] */
	const fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		const key = Object.keys(routes).find((prefix) => String(url).startsWith(prefix));
		if (key === undefined) throw new TypeError('network down');
		const route = /** @type {any} */ (routes[key]);
		const {
			status = 200,
			body = route,
			raw,
			length,
		} = route && typeof route === 'object' && 'status' in route ? route : { body: route };
		const text = raw ?? JSON.stringify(body);
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: { get: (/** @type {string} */ name) => (name === 'content-length' && length ? String(length) : null) },
			text: async () => text,
		};
	};
	return { fetch: /** @type {typeof globalThis.fetch} */ (/** @type {unknown} */ (fetch)), calls };
};

/** Let pending promises and microtasks run. */
export const flush = async () => {
	for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * Mount an element like the Loader does: render, then re-render on every state change (replacing the node).
 * @param {{ state: () => any, actions: any, subscribe: (fn: () => void) => () => void, strings: Record<string, string> }} instance
 * @param {(props: any) => any} render
 * @param {{ container?: any, props?: Record<string, unknown> }} [options]
 */
export const mount = (instance, render, { container = document.body, props = {} } = {}) => {
	const view = () =>
		render({
			state: instance.state(),
			actions: instance.actions,
			strings: instance.strings,
			dom: document,
			slots: {},
			theme: {},
			...props,
		});
	let node = view();
	container.append(node);
	const off = instance.subscribe(() => {
		const next = view();
		node.replaceWith(next);
		node = next;
	});
	return {
		node: () => node,
		destroy: () => {
			off();
			node.remove();
		},
	};
};

/**
 * Put JSON data in the page like a website would.
 * @param {unknown} data
 * @param {string} [id]
 */
export const pageScript = (data, id = 'ss-items') => {
	const script = document.createElement('script');
	script.type = 'application/json';
	script.id = id;
	script.textContent = JSON.stringify(data);
	document.body.append(script);
	return script;
};

/**
 * A stand-in IntersectionObserver (jsdom has none) that tests trigger by hand.
 * @returns {{ IO: any, observers: any[] }}
 */
export const fakeIntersection = () => {
	/** @type {any[]} */
	const observers = [];
	/** @param {(entries: any[]) => void} callback */
	const IO = function IntersectionObserver(callback) {
		const observer = {
			targets: /** @type {any[]} */ ([]),
			observe: (/** @type {any} */ target) => observer.targets.push(target),
			disconnect: () => {
				observer.targets.length = 0;
			},
			/** @param {boolean} visible */
			fire: (visible) => callback(observer.targets.map((target) => ({ target, isIntersecting: visible }))),
		};
		observers.push(observer);
		return observer;
	};
	return { IO, observers };
};
