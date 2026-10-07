/** The page side of an item source: data snapshot (parsed by the core), shared JSON fetch, page context. */
import { query, queryAll, winOf } from './dom.js';

const MEDIA = ['data-ss-item-image', 'src', 'alt', 'width', 'height', 'srcset', 'data-ss-zoom', 'poster'];
const BLOB = 'script[type="application/json"][data-ss-item]';

/**
 * Item root of element `key`: the nearest `[data-ss-item-id]` around its container, the first one, or `<html>`.
 * @param {import('./dom.js').DomLike} dom
 * @param {string} key
 */
export const itemRoot = (dom, key) =>
	query(dom, `[data-ss-element="${key}"]`)?.closest?.('[data-ss-item-id]') ??
	query(dom, '[data-ss-item-id]') ??
	dom.documentElement;

/**
 * @param {import('./dom.js').DomLike} dom
 * @param {string} key
 * @returns {import('../core/snapshot.js').PageSnapshot}
 */
export const snapshot = (dom, key) => {
	const root = itemRoot(dom, key);
	return {
		meta: queryAll(dom, 'meta[property],meta[name]').map((tag) => [
			String(tag.getAttribute('property') || tag.getAttribute('name')),
			String(tag.getAttribute('content') ?? ''),
		]),
		attributes: Object.fromEntries(
			[...(root?.attributes ?? [])].filter((a) => a.name.startsWith('data-ss-item-')).map((a) => [a.name, a.value]),
		),
		media: queryAll(root, '[data-ss-item-image]').map((node) => ({
			...Object.fromEntries(MEDIA.map((name) => [name, node.getAttribute(name)])),
			tag: String(node.tagName).toLowerCase(),
			src: node.getAttribute('src') ?? query(node, 'source')?.getAttribute('src') ?? null,
		})),
		json: String((query(root, BLOB) ?? query(dom, BLOB))?.textContent ?? ''),
	};
};

/**
 * GET a public JSON document: no cookies, ≤ 256 KB, 8 s; one response per URL shared by every element on the page.
 * @param {any} win
 * @param {string} url
 * @returns {Promise<unknown>}
 */
export const fetchJson = (win, url) => {
	if (typeof win?.fetch !== 'function') return Promise.reject(new TypeError('no fetch'));
	if (!(win.ssPdpJson instanceof Map)) Object.defineProperty(win, 'ssPdpJson', { value: new Map(), configurable: true });
	/** @type {Map<string, Promise<unknown>>} */
	const cache = win.ssPdpJson;
	if (!cache.has(url)) {
		const abort = typeof win.AbortController === 'function' ? new win.AbortController() : null;
		const timer = win.setTimeout?.(() => abort?.abort(), 8000);
		const pending = Promise.resolve()
			.then(() => win.fetch(url, { credentials: 'omit', headers: { accept: 'application/json' }, signal: abort?.signal }))
			.then(async (response) => {
				const body = response.ok ? await response.text() : '';
				if (body === '' || body.length > 262_144) throw new TypeError('source unusable');
				return JSON.parse(body);
			})
			.finally(() => win.clearTimeout?.(timer));
		pending.catch(() => cache.delete(url));
		if (cache.size >= 20) cache.clear();
		cache.set(url, pending);
	}
	return /** @type {Promise<unknown>} */ (cache.get(url));
};

/**
 * Path, canonical URL, language, and whether the page has Product structured data of its own.
 * @param {import('./dom.js').DomLike} dom
 * @returns {import('../headless/base.js').PageContext}
 */
export const pageContext = (dom) => {
	const location = winOf(dom)?.location;
	const href = String(location?.href ?? '');
	let url = href;
	try {
		url = new URL(query(dom, 'link[rel="canonical"]')?.getAttribute('href') || href, href || undefined).href;
	} catch {
		/* keep the location */
	}
	return {
		path: String(location?.pathname ?? '/'),
		url,
		locale: String(dom.documentElement?.getAttribute?.('lang') ?? ''),
		hasProductJsonLd: queryAll(dom, 'script[type="application/ld+json"]:not([data-ss-pdp])').some((script) =>
			/"@type"\s*:\s*"Product(?:Group)?"/.test(String(script.textContent)),
		),
	};
};

/**
 * @param {import('./dom.js').DomLike} dom
 * @param {string} key
 * @returns {import('../headless/base.js').ItemSource}
 */
export const pageSource = (dom, key) => ({
	page: () => snapshot(dom, key),
	fetchJson: (url) => fetchJson(winOf(dom), url),
	context: pageContext(dom),
});
