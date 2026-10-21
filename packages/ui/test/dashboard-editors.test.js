// @vitest-environment jsdom
/**
 * The unsaved edits of the Settings tab and the Defaults tab (KP-1b): what a save, a reset, a discard and text that is
 * not valid JSON do to them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardProvider, SettingsTab } from '../src/dashboard.js';
import { dashboardTexts } from '../src/index.js';
import { act, byLabel, cleanup, click, render, type } from '../src/testing.js';

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	window.history.replaceState(null, '', '/');
});

const MANIFEST = { features: [{ key: 'notes', name: 'Notes', description: 'Keep notes.', dependsOn: [] }] };
const TEXTS = dashboardTexts({ title: 'Notes' });
const SCHEMA = {
	type: 'object',
	properties: {
		greeting: { type: 'string', title: 'Greeting' },
		flags: { type: 'array', title: 'Flags', items: { type: 'boolean' } },
	},
};
const CATALOG = [{ key: 'notes', name: 'Notes', description: 'Keep notes.', dependsOn: [], millicreditsPerHour: 1000, on: true }];

/** What the fake product holds for the settings of the website, changed by the saves. */
let saved = { greeting: 'Hi', flags: [true] };
/** @type {Array<{ method: string, path: string, body: any }>} */
let requests = [];
/** Answers held back, the oldest first (a slow server): `release` lets the next one go. @type {Array<() => void>} */
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
				const data = settingsAnswer();
				if (how.slow && requests.filter((r) => r.path === path).length > 1)
					await new Promise((resolve) => held.push(() => resolve(undefined)));
				return answer(data);
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

describe('Reset to default drops that setting\'s unsaved edit (180)', () => {
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
