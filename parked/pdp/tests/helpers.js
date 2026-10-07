/** Shared test fixtures: the string catalog, a sample item, an event recorder, jsdom pages and Loader adapters. */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

/** @type {Record<string, string>} */
export const strings = JSON.parse(readFileSync(new URL('../strings/en.json', import.meta.url), 'utf8'));

/** A generic item (no store, country or category assumed). */
export const ITEM = Object.freeze({
	id: 'itm_1',
	title: 'Linen shirt',
	brand: 'Acme',
	url: 'https://shop.example/shirts/linen',
	price: '49.90',
	currency: 'USD',
	availability: 'InStock',
	images: ['https://shop.example/1.jpg', 'https://shop.example/2.jpg'],
	faq: [{ question: 'Washable?', answer: 'Yes, at 30 °C.' }],
});

/** Records `emit(name, data)` calls. */
export const events = () => {
	/** @type {Array<[string, Record<string, unknown>]>} */
	const list = [];
	return {
		list,
		emit: (/** @type {string} */ name, /** @type {Record<string, unknown>} */ data) => void list.push([name, data]),
	};
};

/** Let queued microtasks and timers run. */
export const flush = async (rounds = 5) => {
	for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * A jsdom page.
 * @param {string} body
 * @param {{ url?: string, head?: string, lang?: string }} [options]
 */
export const page = (body, { url = 'https://shop.example/shirts/linen', head = '', lang = 'en-US' } = {}) => {
	const dom = new JSDOM(`<!doctype html><html lang="${lang}"><head>${head}</head><body>${body}</body></html>`, {
		url,
		pretendToBeVisual: true,
	});
	return /** @type {any} */ (dom.window);
};

/**
 * Stub `fetch` on a window with JSON responses by URL (unknown URLs answer 404).
 * @param {any} win
 * @param {Record<string, unknown>} responses
 */
export const stubFetch = (win, responses) => {
	/** @type {Array<{ url: string, init: any }>} */
	const calls = [];
	Object.defineProperty(win, 'fetch', {
		configurable: true,
		value: async (/** @type {string} */ url, /** @type {any} */ init) => {
			calls.push({ url, init });
			const known = Object.hasOwn(responses, url);
			return { ok: known, status: known ? 200 : 404, text: async () => (known ? JSON.stringify(responses[url]) : '') };
		},
	});
	return calls;
};

/**
 * Mount a headless factory + renderer module like the Loader does (render, then re-render on change through
 * `update` when the module has one), with `dom` = the window's document.
 * @param {any} win
 * @param {(options: any) => any} factory
 * @param {any} mod renderer module
 * @param {{ key: string, config?: Record<string, unknown>, emit?: (name: string, data: any) => void, target?: any }} options
 */
export const mount = (win, factory, mod, { key, config = {}, emit = () => {}, target }) => {
	const instance = factory({ config, strings, emit });
	const container = win.document.createElement('div');
	container.setAttribute('data-ss-element', key);
	(target ?? win.document.body).append(container);
	const props = () => ({ state: instance.state(), actions: instance.actions, strings, theme: {}, slots: {}, dom: win.document });
	let node = mod.render(props());
	container.append(node);
	instance.subscribe(() => {
		const next = mod.update ? mod.update(node, props()) : mod.render(props());
		if (next !== node) {
			node.replaceWith(next);
			node = next;
		}
	});
	return { instance, container, node: () => node };
};
