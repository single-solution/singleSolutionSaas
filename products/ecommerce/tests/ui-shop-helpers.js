/* global document, window */
/**
 * Helpers of the shopper widget tests (jsdom): a fake `Shop` routing calls by `METHOD /path` and recording them, the
 * widget config with the English texts, timers the tests run by hand, and finders inside shadow roots.
 * @module
 */
import strings from '../strings/en.json' with { type: 'json' };
import { createCartStore } from '../ui/cart-store.js';

/** The English widget texts. */
export const TEXTS = /** @type {Record<string, string>} */ (strings);

/**
 * A widget config.
 * @param {string[]} features
 * @param {Record<string, any>} [settings]
 */
export const configOf = (features, settings = {}) => ({
	texts: { ...TEXTS },
	theme: { mode: /** @type {const} */ ('light') },
	customCss: '',
	features,
	settings: { currency: 'PKR', ...settings },
});

/** @param {unknown} data @param {number} [status] @returns {Answer} */
export const ok = (data, status = 200) => ({ ok: true, status, data });
/** @param {number} status @param {string} code @param {Record<string, unknown>} [extra] @returns {Answer} */
export const fail = (status, code, extra = {}) => ({
	ok: false,
	status,
	data: { type: `https://ecommerce.example.dev/problems/${code}`, title: code, status, ...extra },
});

/** @typedef {{ method: string, path: string, query: Record<string, string>, body: any, key: string | undefined, signIn: string | null }} Call */
/** @typedef {{ ok: boolean, status: number, data: any }} Answer */
/** @typedef {(call: Call) => Answer | Promise<Answer>} Route */

/** A Storage kept in memory. */
export const memoryStorage = () => {
	/** @type {Map<string, string>} */
	const map = new Map();
	return /** @type {Storage} */ (
		/** @type {unknown} */ ({
			getItem: (/** @type {string} */ key) => map.get(key) ?? null,
			setItem: (/** @type {string} */ key, /** @type {string} */ value) => void map.set(key, String(value)),
			removeItem: (/** @type {string} */ key) => void map.delete(key),
		})
	);
};

/**
 * A fake `Shop`.
 * @param {{ features?: string[], signIn?: string | null, routes?: Record<string, Route>, url?: string,
 *   documents?: Record<string, { ok: boolean, status: number, text: string }> | null }} [options] `documents`: answers
 *   of `shop.document(path)` (null: the runtime has no `document`)
 */
export const makeShop = ({
	features = [],
	signIn = null,
	routes = {},
	url = 'https://shop.example.com/cart',
	documents = null,
} = {}) => {
	/** @type {Call[]} */
	const calls = [];
	/** @type {string[]} */
	const went = [];
	let identity = signIn;
	/** @type {Set<(signIn: string | null) => void>} */
	const listeners = new Set();
	const cart = createCartStore({ storage: memoryStorage() });
	let keys = 0;
	let page = url;
	/** @type {any} */
	const shop = {
		call: async (/** @type {string} */ path, /** @type {any} */ init = {}) => {
			const target = new URL(path, 'https://ecommerce.example.dev');
			/** @type {Call} */
			const call = {
				method: init.method ?? 'GET',
				path: target.pathname,
				query: Object.fromEntries(target.searchParams),
				body: init.body,
				key: init.idempotencyKey,
				signIn: identity,
			};
			calls.push(call);
			const route = routes[`${call.method} ${call.path}`];
			return route ? route(call) : fail(404, 'not_found');
		},
		signIn: () => identity,
		onIdentity: (/** @type {(signIn: string | null) => void} */ listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		cart,
		has: (/** @type {string} */ feature) => features.includes(feature),
		go: (/** @type {string} */ to) => void went.push(to),
		location: () => new URL(page),
		newKey: () => `key-${(keys += 1)}`,
	};
	if (documents)
		shop.document = async (/** @type {string} */ path) => {
			calls.push({ method: 'GET', path, query: {}, body: undefined, key: undefined, signIn: identity });
			return documents[path] ?? { ok: false, status: 404, text: '' };
		};
	/** @param {string} key `METHOD /path` */
	const all = (key) => calls.filter((call) => `${call.method} ${call.path}` === key);
	return {
		shop: /** @type {import('../ui/widget.js').Shop} */ (shop),
		calls,
		went,
		cart,
		routes,
		all,
		/** @param {string} key */
		last: (key) => all(key).at(-1),
		/** @param {string | null} next */
		identify: (next) => {
			identity = next;
			for (const listener of listeners) listener(next);
		},
		/** @param {string} next */
		setPage: (next) => {
			page = next;
		},
	};
};

/** Let pending promises settle. */
export const flush = async () => {
	for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Timers run by hand (`win.setTimeout` of the cart's pause). */
export const handTimers = () => {
	let id = 0;
	/** @type {Map<number, () => void>} */
	const tasks = new Map();
	return {
		/** @param {() => void} task */
		setTimeout: (task) => {
			id += 1;
			tasks.set(id, task);
			return id;
		},
		/** @param {number} timer */
		clearTimeout: (timer) => void tasks.delete(timer),
		pending: () => tasks.size,
		/** Run every pending task, then let promises settle. */
		run: async () => {
			const due = [...tasks.values()];
			tasks.clear();
			for (const task of due) task();
			await flush();
		},
	};
};

/**
 * A host element in the page.
 * @param {string} key
 * @param {Record<string, string>} [data]
 */
export const place = (key, data = {}) => {
	const host = document.createElement('div');
	host.setAttribute('data-ss-ecommerce', key);
	for (const [name, value] of Object.entries(data)) host.dataset[name] = value;
	document.body.append(host);
	return host;
};

/** @param {HTMLElement} host @param {string} selector @returns {any} */
export const $ = (host, selector) => host.shadowRoot?.querySelector(selector) ?? null;
/** @param {HTMLElement} host @param {string} selector @returns {any[]} */
export const $$ = (host, selector) => [...(host.shadowRoot?.querySelectorAll(selector) ?? [])];
/** The widget's text (without its CSS, so failed assertions stay short). @param {HTMLElement} host */
export const textOf = (host) => host.shadowRoot?.querySelector('[part="root"]')?.textContent ?? '';
/**
 * The button with this text (or aria-label).
 * @param {HTMLElement} host
 * @param {string} text
 * @returns {HTMLButtonElement}
 */
export const buttonOf = (host, text) => {
	const found = $$(host, 'button').find((b) => b.textContent === text || b.getAttribute('aria-label') === text);
	if (!found) throw new Error(`no button ${text}`);
	return found;
};
/** @param {Element} node */
export const click = async (node) => {
	/** @type {HTMLElement} */ (node).click();
	await flush();
};
/**
 * Set a control's value and send its event.
 * @param {any} control
 * @param {string | boolean} value
 * @param {string} [event]
 */
export const setValue = async (control, value, event = 'change') => {
	Object.assign(control, typeof value === 'boolean' ? { checked: value } : { value });
	control.dispatchEvent(new window.Event(event, { bubbles: true }));
	await flush();
};
/** @param {any} form */
export const submit = async (form) => {
	form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
	await flush();
};
/** @param {string} key @param {Record<string, string | number>} [values] */
export const text = (key, values = {}) =>
	String(TEXTS[key] ?? key).replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole));

/** Clear the page and the browser's storage. */
export const resetPage = () => {
	document.body.replaceChildren();
	window.localStorage.clear();
};
