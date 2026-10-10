/* global document, window */
/**
 * Helpers of the admin widget tests (jsdom): a fake fetch routing by method and path, a fixed ticket source, widget
 * configs, mounting an admin widget and finders inside its shadow root.
 * @module
 */
import { vi } from 'vitest';
import strings from '../strings/en.json' with { type: 'json' };

export const BASE = 'https://shop-product.example.dev';
const TEXTS = /** @type {Record<string, string>} */ (strings);

/** Let pending promises settle. */
export const flush = async () => {
	for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** @param {number} status @param {unknown} [body] */
export const answer = (status, body = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status });
/** @param {number} status @param {string} detail @param {Record<string, unknown>} [extra] */
export const problem = (status, detail, extra = {}) => answer(status, { type: `${BASE}/problems/x`, status, detail, ...extra });

/** @typedef {{ method: string, path: string, url: URL, body: any, headers: Record<string, string> }} Call */
/** @typedef {(call: Call) => Response | Promise<Response>} Route */

/**
 * `window.fetch` answering by `METHOD /path`; every call is recorded.
 * @param {Record<string, Route>} routes
 */
const serve = (routes) => {
	/** @type {Call[]} */
	const calls = [];
	vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
		const url = new URL(String(input));
		const body = init?.body;
		/** @type {any} */
		let parsed = body;
		if (typeof body === 'string')
			try {
				parsed = JSON.parse(body);
			} catch {
				parsed = body;
			}
		const call = {
			method: init?.method ?? 'GET',
			path: url.pathname,
			url,
			body: parsed,
			headers: /** @type {Record<string, string>} */ (init?.headers ?? {}),
		};
		calls.push(call);
		const route = routes[`${call.method} ${call.path}`];
		if (!route) return answer(404, { detail: `no route ${call.method} ${call.path}` });
		return route(call);
	});
	/** @param {string} key */
	const all = (key) => calls.filter((c) => `${c.method} ${c.path}` === key);
	return { calls, all, last: (/** @type {string} */ key) => all(key).at(-1), routes };
};

/** A ticket source with a fixed ticket (or none). @param {string | null} [ticket] */
const tickets = (ticket = 't1') => {
	/** @type {Set<(signedIn: boolean) => void>} */
	const listeners = new Set();
	const self = {
		value: ticket,
		current: () => self.value,
		onChange: (/** @type {(signedIn: boolean) => void} */ fn) => {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		stop: () => {},
		/** @param {boolean} value */
		emit: (value) => {
			for (const fn of listeners) fn(value);
		},
	};
	return self;
};

/**
 * Mount an admin widget with a fake server.
 * @param {(input: any) => Promise<void>} mount
 * @param {{ features: string[], settings?: Record<string, any>, routes?: Record<string, Route>, ticket?: string | null,
 *   format?: Record<string, unknown>, timeZone?: string }} options `format` and `timeZone`: the website's Format and
 *   business time zone (widget config)
 */
export const mountWith = async (mount, { features, settings = {}, routes = {}, ticket = 't1', format, timeZone }) => {
	const host = document.createElement('div');
	document.body.append(host);
	const server = serve(routes);
	const source = tickets(ticket);
	/** @type {Array<{ name: string, text: string }>} */
	const saved = [];
	/** @type {string[]} */
	const opened = [];
	await mount({
		host,
		config: {
			texts: { ...TEXTS },
			theme: { mode: 'light' },
			customCss: '',
			features,
			settings: { currency: 'PKR', ...settings },
			...(format ? { format } : {}),
			...(timeZone ? { timeZone } : {}),
		},
		api: {
			base: BASE,
			tickets: source,
			fetch: (/** @type {any} */ input, /** @type {any} */ init) => window.fetch(input, init),
		},
		win: window,
		save: (/** @type {string} */ name, /** @type {string} */ text) => saved.push({ name, text }),
		open: (/** @type {string} */ url) => opened.push(url),
	});
	await flush();
	const root = /** @type {ShadowRoot} */ (host.shadowRoot);
	return { host, root, server, saved, opened, tickets: source };
};

/** The visible text of a node. @param {ParentNode} scope */
export const textOf = (scope) => /** @type {any} */ (scope).textContent ?? '';

/** A section's panel. @param {ParentNode} root @param {string} key */
export const panelOf = (root, key) => /** @type {HTMLElement} */ (root.querySelector(`[data-panel="${key}"]`));

/** Show a section. @param {ParentNode} root @param {string} key */
export const openTab = async (root, key) => {
	/** @type {HTMLElement} */ (root.querySelector(`[data-section="${key}"]`)).click();
	await flush();
	return panelOf(root, key);
};

/**
 * A button by its text (visible ones first).
 * @param {ParentNode} scope @param {string} text @param {number} [index]
 */
export const buttonIn = (scope, text, index = 0) => {
	const found = [...scope.querySelectorAll('button')].filter((b) => b.textContent === text && !b.closest('[hidden]'));
	const button = found[index];
	if (!button) throw new Error(`no button ${text}`);
	return /** @type {HTMLButtonElement} */ (button);
};
/** A visible button? @param {ParentNode} scope @param {string} text */
export const shows = (scope, text) =>
	[...scope.querySelectorAll('button')].some((b) => b.textContent === text && !b.closest('[hidden]'));

/**
 * The control of a labelled field.
 * @param {ParentNode} scope @param {string} label @param {number} [index]
 * @returns {any}
 */
export const fieldIn = (scope, label, index = 0) => {
	const found = [...scope.querySelectorAll('label')].filter(
		(l) => l.textContent === label && !l.classList.contains('check') && !l.closest('[hidden]'),
	);
	const node = /** @type {HTMLLabelElement | undefined} */ (found[index]);
	if (!node) throw new Error(`no field ${label}`);
	return /** @type {ShadowRoot} */ (node.getRootNode()).getElementById(node.htmlFor);
};
/** A checkbox by its label. @param {ParentNode} scope @param {string} text @returns {HTMLInputElement} */
export const checkIn = (scope, text) => {
	const found = [...scope.querySelectorAll('label.check')].find((l) => (l.textContent ?? '') === text && !l.closest('[hidden]'));
	if (!found) throw new Error(`no check ${text}`);
	return /** @type {HTMLInputElement} */ (found.querySelector('input'));
};
/** @param {HTMLElement} node */
export const click = async (node) => {
	node.click();
	await flush();
};
/** Set a value and fire `change`. @param {any} node @param {string} value */
export const change = async (node, value) => {
	Object.assign(node, { value });
	node.dispatchEvent(new window.Event('change'));
	await flush();
};
/** Tick or untick a checkbox. @param {HTMLInputElement} box @param {boolean} value */
export const tick = async (box, value) => {
	Object.assign(box, { checked: value });
	box.dispatchEvent(new window.Event('change'));
	await flush();
};
/** Set an input's value (no event). @param {any} node @param {string} value */
export const type = (node, value) => {
	Object.assign(node, { value });
};
/** Submit the form of a node. @param {Element} node */
export const submit = async (node) => {
	const form = /** @type {HTMLFormElement} */ (node.tagName === 'FORM' ? node : node.closest('form'));
	form.dispatchEvent(new window.Event('submit', { cancelable: true }));
	await flush();
};
/** Choose files in a file input. @param {HTMLInputElement} input @param {File[]} files */
export const choose = async (input, files) => {
	Object.defineProperty(input, 'files', { configurable: true, value: files });
	input.dispatchEvent(new window.Event('change'));
	await flush();
};
/** Texts of the status lines. @param {ParentNode} scope */
export const statuses = (scope) =>
	[...scope.querySelectorAll('[role="status"]')]
		.filter((node) => !node.closest('[hidden]'))
		.map((node) => node.textContent ?? '')
		.filter(Boolean);

/** Reset the page between tests. */
export const resetPage = () => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
};
