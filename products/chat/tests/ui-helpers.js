/* global document, window */
/**
 * Helpers of the widget tests (jsdom): a fake fetch routing by method and path, hand-driven timers, widget configs and
 * finders inside shadow roots.
 * @module
 */
import { vi } from 'vitest';
import strings from '../strings/en.json' with { type: 'json' };
import { WIDGET_ATTRIBUTE } from '../core/widgets.js';

export const BASE = 'https://chat.example.dev';
export const START = Date.parse('2026-10-01T10:00:00Z');
/** The English widget texts. */
export const TEXTS = strings;

/**
 * A widget config.
 * @param {string[]} features
 * @param {Record<string, any>} [settings]
 * @param {{ format?: Record<string, unknown>, timeZone?: string }} [look] the website's Format and business time zone
 */
export const configOf = (features, settings = {}, look = {}) => ({
	texts: { ...strings },
	theme: { mode: /** @type {const} */ ('light') },
	customCss: '',
	...look,
	features,
	settings,
});

/** Let pending promises settle. */
export const flush = async () => {
	for (let i = 0; i < 15; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** @param {number} status @param {unknown} [body] */
export const answer = (status, body = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status });
/** @param {number} status @param {string} code @param {Record<string, unknown>} [extra] */
export const problem = (status, code, extra = {}) =>
	answer(status, { type: `${BASE}/problems/${code}`, title: code, status, detail: `Detail of ${code}.`, ...extra });

/** @typedef {{ method: string, path: string, url: URL, body: any, headers: Record<string, string> }} Call */
/** @typedef {(call: Call) => Response | Promise<Response>} Route */

/**
 * `window.fetch` answering by `METHOD /path`; every call is recorded.
 * @param {Record<string, Route>} routes
 */
export const serve = (routes) => {
	/** @type {Call[]} */
	const calls = [];
	const spy = vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
		const url = new URL(String(input));
		const body = init?.body;
		const call = {
			method: init?.method ?? 'GET',
			path: url.pathname,
			url,
			body: typeof body === 'string' ? JSON.parse(body) : body,
			headers: /** @type {Record<string, string>} */ (init?.headers ?? {}),
		};
		calls.push(call);
		const route = routes[`${call.method} ${call.path}`];
		return route ? route(call) : answer(404);
	});
	/** @param {string} key `METHOD /path` */
	const all = (key) => calls.filter((c) => `${c.method} ${c.path}` === key);
	/** @param {string} key */
	const last = (key) => all(key).at(-1);
	return { calls, spy, all, last, routes };
};

/** Timers the tests drive. */
export const clock = () => {
	let id = 0;
	/** @type {Map<number, { task: () => void, due: number, ms: number }>} */
	const timers = new Map();
	const self = {
		time: START,
		timers,
		now: () => self.time,
		/** @param {() => void} task @param {number} ms */
		schedule: (task, ms) => {
			id += 1;
			timers.set(id, { task, due: self.time + ms, ms });
			return id;
		},
		/** @param {number} timer */
		cancel: (timer) => void timers.delete(timer),
		/** Delays of the pending timers. */
		pending: () => [...timers.values()].map((timer) => timer.ms),
		/** Move time on, firing due timers in order. @param {number} ms */
		advance: async (ms) => {
			const target = self.time + ms;
			for (;;) {
				const next = [...timers].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
				if (!next) break;
				timers.delete(next[0]);
				self.time = next[1].due;
				next[1].task();
				await flush();
			}
			self.time = target;
			await flush();
		},
	};
	return self;
};

/** @param {boolean} hidden */
export const setHiddenTab = (hidden) => {
	Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
	document.dispatchEvent(new window.Event('visibilitychange'));
};

/** @param {string | null} token */
export const script = (token) => {
	const node = document.createElement('script');
	node.src = `${BASE}/widget.js`;
	if (token) node.dataset.token = token;
	return node;
};

/** @param {string} key */
export const place = (key) => {
	const host = document.createElement('div');
	host.setAttribute(WIDGET_ATTRIBUTE, key);
	document.body.append(host);
	return host;
};

/** @param {Element} host */
export const shadow = (host) => /** @type {ShadowRoot} */ (host.shadowRoot);
/** @param {ParentNode} scope @param {string} text */
export const buttonIn = (scope, text) => {
	const found = [...scope.querySelectorAll('button')].find((b) => b.textContent === text);
	if (!found) throw new Error(`no button ${text}`);
	return /** @type {HTMLButtonElement} */ (found);
};
/** A visible button? @param {ParentNode} scope @param {string} text */
export const shows = (scope, text) =>
	[...scope.querySelectorAll('button')].some((b) => b.textContent === text && !b.closest('[hidden]'));
/** @param {ParentNode} scope @param {string} label @returns {any} */
export const fieldIn = (scope, label) => {
	const found = /** @type {HTMLLabelElement | undefined} */ (
		[...scope.querySelectorAll('label')].find((l) => l.textContent === label && !l.classList.contains('check'))
	);
	if (!found) throw new Error(`no field ${label}`);
	return /** @type {ShadowRoot} */ (found.getRootNode()).getElementById(found.htmlFor);
};
/** @param {ParentNode} scope @param {string} text @returns {HTMLInputElement} */
export const checkIn = (scope, text) => {
	const found = [...scope.querySelectorAll('label.check')].find((l) => (l.textContent ?? '').startsWith(text));
	if (!found) throw new Error(`no check ${text}`);
	return /** @type {HTMLInputElement} */ (found.querySelector('input'));
};
/** @param {Element} node */
export const submit = async (node) => {
	const form = /** @type {HTMLFormElement} */ (node.tagName === 'FORM' ? node : node.closest('form'));
	form.dispatchEvent(new window.Event('submit', { cancelable: true }));
	await flush();
};
/** @param {HTMLElement} node */
export const click = async (node) => {
	node.click();
	await flush();
};
/** @param {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} node @param {string} value */
export const change = async (node, value) => {
	const target = node;
	target.value = value;
	target.dispatchEvent(new window.Event('change'));
	await flush();
};
/** Choose a file in a file input. @param {HTMLInputElement} input @param {File | null} file */
export const choose = async (input, file) => {
	Object.defineProperty(input, 'files', { configurable: true, value: file ? [file] : [] });
	input.dispatchEvent(new window.Event('change'));
	await flush();
};
/** All texts of the elements matching a selector. @param {ParentNode} scope @param {string} selector */
export const textsIn = (scope, selector) => [...scope.querySelectorAll(selector)].map((node) => node.textContent ?? '');

/** Reset the page between tests. */
export const resetPage = () => {
	document.body.replaceChildren();
	window.localStorage.clear();
	window.sessionStorage.clear();
	delete (/** @type {any} */ (window).SSChat);
	Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
	vi.restoreAllMocks();
};
