// @vitest-environment jsdom
/**
 * The unsaved edits of the Settings tab and the Defaults tab (KP-1b): what a save, a reset, a discard and text that is
 * not valid JSON do to them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardProvider, PricesTab, SettingsTab, TextsTab } from '../src/dashboard.js';
import { dashboardTexts } from '../src/index.js';
import { act, byLabel, cleanup, click, render, type } from '../src/testing.js';

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	window.history.replaceState(null, '', '/');
});

const MANIFEST = {
	features: [
		{ key: 'notes', name: 'Notes', description: 'Keep notes.', dependsOn: [] },
		{ key: 'inbox', name: 'Inbox', description: 'Read them.', dependsOn: [] },
	],
};
const TEXTS = dashboardTexts({ title: 'Notes' });
const SCHEMA = {
	type: 'object',
	properties: {
		greeting: { type: 'string', title: 'Greeting' },
		flags: { type: 'array', title: 'Flags', items: { type: 'boolean' } },
	},
};
const CATALOG = [
	{ key: 'notes', name: 'Notes', description: 'Keep notes.', dependsOn: [], millicreditsPerHour: 1000, on: true },
	{ key: 'inbox', name: 'Inbox', description: 'Read them.', dependsOn: [], millicreditsPerHour: 500, on: true },
];

/** What the fake product holds for the settings of the website, changed by the saves. */
let saved = { greeting: 'Hi', flags: [true] };
/** The hourly price of Notes in credits and the words of one text, changed by the saves. */
let price = 1;
let words = 'Hello';
/** @type {Array<{ method: string, path: string, body: any }>} */
let requests = [];
/** Answers held back, the oldest first (a slow server): calling one lets that answer go. @type {Array<() => void>} */
let held = [];

/** The settings answer for the website, from what the product holds. */
const settingsAnswer = () => ({
	features: [
		{
			key: 'notes',
			name: 'Notes',
			on: true,
			schema: SCHEMA,
			values: {
				greeting: { value: saved.greeting, source: 'website' },
				flags: { value: saved.flags, source: 'default' },
			},
		},
	],
});

/**
 * The product's API. A GET of the settings waits for `release()` once `slow` is set (the reload after a save).
 * @param {string} base
 * @param {{ slow?: boolean }} [how]
 */
const serve = (base, how = {}) => {
	requests = [];
	held = [];
	saved = { greeting: 'Hi', flags: [true] };
	price = 1;
	words = 'Hello';
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
			const method = init.method ?? 'GET';
			const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
			requests.push({ method, path, body });
			/** @param {unknown} data @param {number} [status] */
			const answer = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
			if (method === 'PUT' && path.startsWith(`${base}/settings/notes.`)) {
				const name = /** @type {'greeting' | 'flags'} */ (path.split('.').pop());
				saved = { ...saved, [name]: body.value };
				return answer({});
			}
			if (method === 'DELETE' && path.startsWith(`${base}/settings/notes.`)) {
				saved = { ...saved, [path.split('.').pop() ?? '']: name0(path) };
				return answer(null, 204);
			}
			if (method === 'GET' && path === `${base}/settings`) {
				if (how.slow && requests.filter((r) => r.path === path).length > 1)
					await new Promise((resolve) => held.push(() => resolve(undefined)));
				return answer(settingsAnswer());
			}
			// every read after the first waits for its turn when the server is `slow` (the read after a save)
			const waits = async () => {
				if (how.slow && requests.filter((r) => r.path === path && r.method === 'GET').length > 1)
					await new Promise((resolve) => held.push(() => resolve(undefined)));
			};
			if (path === '/v1/dashboard/prices') {
				if (method === 'PUT') {
					price = body.prices.notes / 1000;
					return answer({});
				}
				await waits();
				return answer({
					features: [{ key: 'notes', name: 'Notes', millicreditsPerHour: price * 1000, on: true }],
					recentChanges: [],
				});
			}
			if (path === `${base}/texts/screen.title` && method === 'PUT') {
				words = body.value;
				return answer({});
			}
			if (path === `${base}/texts`) {
				await waits();
				return answer({ texts: [{ key: 'screen.title', english: 'Title', value: words, source: 'default' }] });
			}
			if (method === 'GET' && path === `${base}/features`) return answer({ features: CATALOG });
			if (method === 'GET' && path === `${base}/connections`) return answer({ connections: [] });
			return answer({ status: 404, title: 'Not found' }, 404);
		}),
	);
};

/** The default a Reset gives back. @param {string} path */
const name0 = (path) => (path.endsWith('greeting') ? 'Hello' : []);

const settle = async () => {
	for (let i = 0; i < 3; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

let sites = 0;
/** A website id no earlier test loaded (answers are kept per page). */
const freshSite = () => `ed${(sites += 1)}`;

/** @param {import('react').ReactNode} node */
const inDashboard = (node) => (
	<DashboardProvider manifest={MANIFEST} texts={TEXTS}>
		{node}
	</DashboardProvider>
);

/** @param {string} id */
const tab = (id) => ({
	websiteId: id,
	merchantId: 'mer_1',
	domain: 'shop.example.com',
	who: /** @type {const} */ ({ kind: 'admin', id: 'a1', name: 'Alex Morgan', role: 'owner' }),
	support: { channels: [] },
	portal: 'https://portal.example.com',
	open: () => undefined,
});

/** @param {ParentNode} root @param {string} label */
const buttonsOf = (root, label) => [...root.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);

/** Opens the page of the website's Settings with its first feature on screen. @param {string} id */
const openSettings = async (id) => {
	serve(`/v1/dashboard/websites/${id}`);
	const view = render(inDashboard(<SettingsTab {...tab(id)} />));
	await settle();
	return view;
};

describe('text that is not valid JSON is never saved (189)', () => {
	it('keeps Save off while a raw JSON box holds text that is not JSON, and turns it on again when it is', async () => {
		const id = freshSite();
		const { container } = await openSettings(id);
		type(byLabel(container, 'Flags'), '[oops');
		expect(container.textContent).toContain('Enter valid JSON.');
		const save = /** @type {HTMLButtonElement} */ (buttonsOf(container, 'Save changes')[0]);
		expect(save.disabled).toBe(true);
		click(save);
		await settle();
		expect(requests.filter((r) => r.method === 'PUT')).toEqual([]);
		type(byLabel(container, 'Flags'), '[false]');
		expect(/** @type {HTMLButtonElement} */ (buttonsOf(container, 'Save changes')[0]).disabled).toBe(false);
		await act(async () => buttonsOf(container, 'Save changes')[0]?.click());
		await settle();
		expect(requests.filter((r) => r.method === 'PUT')).toEqual([
			{ method: 'PUT', path: `/v1/dashboard/websites/${id}/settings/notes.flags`, body: { value: [false] } },
		]);
	});

	it('Discard clears text that is not valid JSON, so the box shows the saved value again', async () => {
		const id = freshSite();
		const { container } = await openSettings(id);
		type(byLabel(container, 'Flags'), '[oops');
		await act(async () => buttonsOf(container, 'Discard')[0]?.click());
		expect(JSON.parse(byLabel(container, 'Flags').value)).toEqual([true]);
		expect(container.textContent).not.toContain('Enter valid JSON.');
		expect(buttonsOf(container, 'Save changes')).toHaveLength(0);
	});
});

describe("Reset to default drops that setting's unsaved edit (180)", () => {
	it('shows the default, closes the bar when it was the only edit, and Save puts nothing back', async () => {
		const id = freshSite();
		const { container } = await openSettings(id);
		const field = /** @type {HTMLElement} */ (container.querySelector('[data-field="greeting"]'));
		type(/** @type {HTMLInputElement} */ (field.querySelector('input')), 'Mine');
		expect(buttonsOf(container, 'Save changes')).toHaveLength(1);
		await act(async () => buttonsOf(field, 'Reset')[0]?.click());
		await settle();
		expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
		expect(/** @type {HTMLInputElement} */ (field.querySelector('input')).value).toBe('Hello');
		expect(buttonsOf(container, 'Save changes')).toHaveLength(0);
		expect(requests.filter((r) => r.method === 'PUT')).toEqual([]);
	});

	it('keeps the other edits of the page', async () => {
		const id = freshSite();
		const { container } = await openSettings(id);
		type(byLabel(container, 'Flags'), '[false]');
		type(byLabel(container, 'Greeting'), 'Mine');
		const field = /** @type {HTMLElement} */ (container.querySelector('[data-field="greeting"]'));
		await act(async () => buttonsOf(field, 'Reset')[0]?.click());
		await settle();
		expect(buttonsOf(container, 'Save changes')).toHaveLength(1);
		expect(JSON.parse(byLabel(container, 'Flags').value)).toEqual([false]);
	});
});

describe('Discard can be undone (KP-1a left over)', () => {
	/** The toasts on the page. */
	const toasts = () => /** @type {HTMLElement} */ (document.querySelector('[aria-live="polite"]'));

	it('Discard drops the edits, the toast "Changes discarded" brings them back with Undo', async () => {
		const id = freshSite();
		const { container } = await openSettings(id);
		type(byLabel(container, 'Greeting'), 'Mine');
		type(byLabel(container, 'Flags'), '[false]');
		await act(async () => buttonsOf(container, 'Discard')[0]?.click());
		expect(byLabel(container, 'Greeting').value).toBe('Hi');
		expect(buttonsOf(container, 'Save changes')).toHaveLength(0);
		expect(toasts().textContent).toContain('Changes discarded');
		await act(async () => buttonsOf(toasts(), 'Undo')[0]?.click());
		expect(byLabel(container, 'Greeting').value).toBe('Mine');
		expect(JSON.parse(byLabel(container, 'Flags').value)).toEqual([false]);
		expect(buttonsOf(container, 'Save changes')).toHaveLength(1);
	});

	it('an edit made after Discard stays when Undo brings the others back', async () => {
		const id = freshSite();
		const { container } = await openSettings(id);
		type(byLabel(container, 'Greeting'), 'Mine');
		await act(async () => buttonsOf(container, 'Discard')[0]?.click());
		type(byLabel(container, 'Greeting'), 'Newer');
		await act(async () => buttonsOf(toasts(), 'Undo')[0]?.click());
		expect(byLabel(container, 'Greeting').value).toBe('Newer');
	});
});

describe('after Save the old values never flash (179)', () => {
	it('keeps the saved values on screen until the fresh data has arrived, then shows the fresh data', async () => {
		const id = freshSite();
		serve(`/v1/dashboard/websites/${id}`, { slow: true });
		const { container } = render(inDashboard(<SettingsTab {...tab(id)} />));
		await settle();
		type(byLabel(container, 'Greeting'), 'Mine');
		type(byLabel(container, 'Flags'), '[false]');
		await act(async () => buttonsOf(container, 'Save changes')[0]?.click());
		await settle();
		// the product has the new values; the page has not been read again yet
		expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(2);
		expect(held).toHaveLength(1);
		expect(buttonsOf(container, 'Save changes')).toHaveLength(0);
		expect(byLabel(container, 'Greeting').value).toBe('Mine');
		expect(JSON.parse(byLabel(container, 'Flags').value)).toEqual([false]);
		// somebody else changed it meanwhile: the fresh data wins once it is there
		saved = { ...saved, greeting: 'Other' };
		await act(async () => held[0]?.());
		await settle();
		expect(byLabel(container, 'Greeting').value).toBe('Other');
		expect(JSON.parse(byLabel(container, 'Flags').value)).toEqual([false]);
	});
});

describe('after Save the old texts and prices never flash either (179)', () => {
	it('Texts: the saved words stay until the fresh read is there', async () => {
		const id = freshSite();
		serve(`/v1/dashboard/websites/${id}`, { slow: true });
		const { container } = render(inDashboard(<TextsTab {...tab(id)} />));
		await settle();
		type(byLabel(container, 'Title'), 'Headline');
		await act(async () => buttonsOf(container, 'Save changes')[0]?.click());
		await settle();
		expect(held).toHaveLength(1);
		expect(byLabel(container, 'Title').value).toBe('Headline');
		await act(async () => held[0]?.());
		await settle();
		expect(byLabel(container, 'Title').value).toBe('Headline');
	});

	it('Prices: the saved price stays until the fresh read is there', async () => {
		serve('/v1/dashboard/websites/none', { slow: true });
		const { container } = render(inDashboard(<PricesTab />));
		await settle();
		expect(byLabel(container, 'Notes').value).toBe('1');
		type(byLabel(container, 'Notes'), '2.5');
		await act(async () => buttonsOf(document.body, 'Save')[0]?.click());
		await settle();
		expect(held).toHaveLength(1);
		expect(byLabel(container, 'Notes').value).toBe('2.5');
		// the product rounds it: the fresh read wins
		price = 2;
		await act(async () => held[0]?.());
		await settle();
		expect(byLabel(container, 'Notes').value).toBe('2');
	});
});

describe('rows with unsaved changes are marked (KP-1a left over)', () => {
	/** The rows of the list that carry the word "Changed". @param {ParentNode} root */
	const markedRows = (root) =>
		[...root.querySelectorAll('[role="option"]')]
			.filter((row) => row.querySelector('[data-ss-changed]'))
			.map((row) => row.getAttribute('data-ss-id'));

	it('Settings: the row of a feature with edits says Changed, in words, until Save or Discard', async () => {
		const id = freshSite();
		const { container } = await openSettings(id);
		expect(markedRows(container)).toEqual([]);
		type(byLabel(container, 'Greeting'), 'Mine');
		expect(markedRows(container)).toEqual(['notes']);
		expect(container.querySelector('[role="option"][data-ss-id="notes"]')?.textContent).toContain('Changed');
		await act(async () => buttonsOf(container, 'Discard')[0]?.click());
		expect(markedRows(container)).toEqual([]);
		type(byLabel(container, 'Greeting'), 'Again');
		await act(async () => buttonsOf(container, 'Save changes')[0]?.click());
		await settle();
		expect(markedRows(container)).toEqual([]);
	});
});
