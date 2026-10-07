// @vitest-environment jsdom
/* global document, window */
import { afterEach, describe, expect, it, vi } from 'vitest';
import strings from '../strings/en.json' with { type: 'json' };
import { WIDGET_ATTRIBUTE, WIDGET_GLOBAL } from '../core/widgets.js';
import { REFRESH_BEFORE_MS, mountInbox } from '../ui/inbox.js';
import { ADMIN_CONFIG_PATH, CONFIG_PATH, startWidget } from '../ui/widget.js';

const BASE = 'https://product.example.dev';
/** @param {string[]} [features] */
const configOf = (features = ['notes']) => ({
	texts: { ...strings },
	theme: { mode: /** @type {const} */ ('light') },
	customCss: '',
	features,
	settings: { maxLength: 10 },
});

/** @param {string} key */
const place = (key) => {
	const host = document.createElement('div');
	host.setAttribute(WIDGET_ATTRIBUTE, key);
	document.body.append(host);
	return host;
};

/** @param {string | null} token */
const script = (token) => {
	const node = document.createElement('script');
	node.src = `${BASE}/widget.js`;
	if (token) node.dataset.token = token;
	return node;
};

/** Let pending promises settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** @param {number} status @param {unknown} [body] */
const answer = (status, body = {}) => new Response(JSON.stringify(body), { status });

/**
 * `window.fetch` answering by path.
 * @param {Record<string, () => Response | Promise<Response>>} routes
 */
const serve = (routes) =>
	vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
		const route = routes[new URL(String(input)).pathname];
		return route ? route() : answer(404);
	});

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('visitor widget', () => {
	it('mounts with data-token once the config says its feature is on, checks the note and sends it', async () => {
		const host = place('note_form');
		const fetch = serve({ [CONFIG_PATH]: () => answer(200, configOf()), '/v1/notes': () => answer(201, { id: 'note_1' }) });
		await startWidget({ window, script: script(null) }).ready;
		expect(fetch).not.toHaveBeenCalled();
		expect(host.shadowRoot).toBeNull();
		await startWidget({ window, script: script('browser-token') }).ready;
		expect(fetch).toHaveBeenCalledWith(`${BASE}${CONFIG_PATH}`, { headers: { authorization: 'Bearer browser-token' } });
		const root = /** @type {ShadowRoot} */ (host.shadowRoot);
		const form = /** @type {HTMLFormElement} */ (root.querySelector('form'));
		const text = /** @type {HTMLTextAreaElement} */ (root.querySelector('textarea'));
		const email = /** @type {HTMLInputElement} */ (root.querySelector('input'));
		const status = /** @type {HTMLElement} */ (root.querySelector('[role="status"]'));
		expect(root.querySelector('h2')?.textContent).toBe(strings['form.title']);

		form.dispatchEvent(new window.Event('submit', { cancelable: true }));
		expect(status.textContent).toBe(strings['form.empty']);
		text.value = 'x'.repeat(11);
		form.dispatchEvent(new window.Event('submit', { cancelable: true }));
		expect(status.textContent).toBe('A note can have at most 10 characters.');
		text.value = 'Hello';
		email.value = 'nope';
		form.dispatchEvent(new window.Event('submit', { cancelable: true }));
		expect(status.textContent).toBe(strings['form.badEmail']);
		expect(fetch).toHaveBeenCalledTimes(1);

		email.value = '';
		form.dispatchEvent(new window.Event('submit', { cancelable: true }));
		await flush();
		expect(fetch).toHaveBeenLastCalledWith(`${BASE}/v1/notes`, expect.objectContaining({ method: 'POST' }));
		const init = /** @type {RequestInit} */ (fetch.mock.calls.at(-1)?.[1]);
		expect(init.headers).toMatchObject({ authorization: 'Bearer browser-token' });
		expect(JSON.parse(String(init.body))).toEqual({ text: 'Hello', email: null });
		expect(status.textContent).toBe(strings['form.sent']);

		fetch.mockResolvedValue(answer(500));
		text.value = 'Again';
		form.dispatchEvent(new window.Event('submit', { cancelable: true }));
		await flush();
		expect(status.textContent).toBe(strings['form.failed']);
	});

	it('renders nothing while the feature is off, the product refuses or cannot be reached', async () => {
		const host = place('note_form');
		serve({ [CONFIG_PATH]: () => answer(200, configOf([])) });
		await startWidget({ window, script: script('t') }).ready;
		vi.restoreAllMocks();
		serve({ [CONFIG_PATH]: () => answer(403, { title: 'product_unavailable' }) });
		await startWidget({ window, script: script('t') }).ready;
		vi.restoreAllMocks();
		vi.spyOn(window, 'fetch').mockRejectedValue(new TypeError('offline'));
		await startWidget({ window, script: script('t') }).ready;
		expect(host.shadowRoot).toBeNull();
	});
});

describe('admin widget', () => {
	it('mounts after admin({ getTicket }), lists the notes with the ticket and renews it before expiry', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		vi.setSystemTime(Date.parse('2026-10-01T10:00:00Z'));
		const host = place('inbox');
		const notes = [
			{ id: 'note_1', text: 'Hello', email: 'sam@example.com', createdAt: '2026-10-01T09:00:00Z' },
			{ id: 'note_2', text: 'Hi', email: null, createdAt: '2026-10-01T08:00:00Z' },
		];
		/** @type {Response} */
		let list = answer(200, { items: notes });
		const fetch = serve({ [ADMIN_CONFIG_PATH]: () => answer(200, configOf()), '/v1/admin/notes': () => list });
		const getTicket = vi.fn(async () => ({ ticket: 'ticket-1', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }));
		const widgets = startWidget({ window, script: null });
		expect(/** @type {any} */ (window)[WIDGET_GLOBAL].admin).toBe(widgets.admin);
		await widgets.admin({ getTicket });
		await vi.advanceTimersByTimeAsync(0);
		expect(getTicket).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledWith(`${window.location.origin}/v1/admin/notes`, {
			headers: { authorization: 'Bearer ticket-1' },
		});
		const root = /** @type {ShadowRoot} */ (host.shadowRoot);
		expect(root.querySelectorAll('li')).toHaveLength(2);
		expect(root.querySelector('[role="status"]')?.textContent).toBe('2 notes');
		expect(root.textContent).toContain(strings['inbox.anonymous']);

		list = answer(200, { items: [] });
		await vi.advanceTimersByTimeAsync(15 * 60_000 - REFRESH_BEFORE_MS);
		expect(getTicket).toHaveBeenCalledTimes(2);
		expect(root.querySelector('[role="status"]')?.textContent).toBe(strings['inbox.empty']);

		list = answer(401);
		await vi.advanceTimersByTimeAsync(15 * 60_000 - REFRESH_BEFORE_MS);
		expect(root.querySelector('[role="status"]')?.textContent).toBe(strings['inbox.failed']);

		getTicket.mockRejectedValue(new Error('signed out'));
		await vi.advanceTimersByTimeAsync(15 * 60_000 - REFRESH_BEFORE_MS);
		expect(root.querySelector('[role="status"]')?.textContent).toBe(strings['inbox.signedOut']);
		expect(root.querySelectorAll('li')).toHaveLength(0);
	});

	it('renders nothing without a ticket or while the feature is off', async () => {
		const host = place('inbox');
		serve({ [ADMIN_CONFIG_PATH]: () => answer(200, configOf([])) });
		const { admin } = startWidget({ window, script: null });
		await admin({ getTicket: async () => Promise.reject(new Error('no')) });
		await admin({ getTicket: async () => /** @type {any} */ ({}) });
		await admin({ getTicket: async () => ({ ticket: 't', expiresAt: '2099-01-01T00:00:00Z' }) });
		expect(host.shadowRoot).toBeNull();
	});

	it('shows Signed out when a later ticket is missing, and stops renewing when unmounted', async () => {
		const cancel = vi.fn();
		/** @type {Array<() => void>} */
		const tasks = [];
		const options = {
			base: BASE,
			first: { ticket: 't', expiresAt: '2099-01-01T00:00:00Z' },
			getTicket: async () => /** @type {any} */ ({}),
			config: configOf(),
			fetch: async () => answer(200, { items: [] }),
			schedule: (/** @type {() => void} */ task) => tasks.push(task),
			cancel,
			now: () => 0,
		};
		mountInbox({ host: place('inbox'), ...options, first: /** @type {any} */ (null) }).unmount();
		await flush();
		expect(cancel).not.toHaveBeenCalled();
		const host = place('inbox');
		const widget = mountInbox({ host, ...options });
		await flush();
		expect(tasks).toHaveLength(1);
		tasks[0]?.();
		await flush();
		expect(host.shadowRoot?.querySelector('[role="status"]')?.textContent).toBe(strings['inbox.signedOut']);
		widget.unmount();
		expect(cancel).toHaveBeenCalledWith(1);
	});

	it('starts from the bundle entry when the script loads', async () => {
		vi.spyOn(window, 'fetch').mockResolvedValue(answer(404));
		await import('../ui/entry.js');
		expect(typeof (/** @type {any} */ (window)[WIDGET_GLOBAL].admin)).toBe('function');
	});
});
