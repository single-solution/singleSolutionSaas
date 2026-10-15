// @vitest-environment jsdom
/**
 * The merchant's own lists in Settings (jsdom, on a faked dashboard API): office hours by weekday with minutes and
 * dated exceptions (C9). Each editor adds, changes, moves and removes entries and saves the whole list with one PUT,
 * checked as the server checks it.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byText, cleanup, click, render, type } from '@ss/ui/testing';
import { DashboardProvider } from '@ss/ui/dashboard';
import manifest from '../manifest.json' with { type: 'json' };
import { OfficeExceptionsEditor, OfficeHoursEditor } from '../app/dashboard/lists.js';
import { TEXTS } from '../app/dashboard/texts.js';
import { LISTS } from '../adapters/lists.js';

const WEBSITE = 'web_1';
const BASE = `/v1/dashboard/websites/${WEBSITE}`;

/** The lists the editors saved, by list name. @type {Record<string, any[]>} */
let saved = {};

/**
 * The dashboard API: each list answers its items (`start`, else its seed) and a save checked as the server checks it.
 * @param {Record<string, any[]>} [start]
 */
const serve = (start = {}) => {
	saved = {};
	/** @type {Record<string, any[]>} */
	const items = { ...start };
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
			const name = path.startsWith(`${BASE}/lists/`) ? path.slice(`${BASE}/lists/`.length) : '';
			if (Object.hasOwn(LISTS, name)) {
				const list = /** @type {keyof typeof LISTS} */ (name);
				if (init.method === 'PUT') {
					const body = JSON.parse(String(init.body));
					(saved[name] ??= []).push(body.value);
					const checked = LISTS[list].check(body.value);
					const errors = checked.ok ? [] : checked.errors.map((message) => ({ path: '/value', message }));
					if (!checked.ok) return new Response(JSON.stringify({ status: 422, errors }), { status: 422 });
					items[name] = checked.value;
				}
				return new Response(JSON.stringify({ value: items[name] ?? LISTS[list].seed }), { status: 200 });
			}
			return new Response(JSON.stringify({ status: 404, title: 'Not found' }), { status: 404 });
		}),
	);
};

/**
 * A dashboard piece inside the dashboard's provider (its words and feature names), as the page renders it.
 * @param {import('react').ReactNode} node
 */
const inDashboard = (node) => (
	<DashboardProvider manifest={manifest} texts={TEXTS}>
		{node}
	</DashboardProvider>
);

/** Let the loads answer. */
const settle = async () => {
	for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

/**
 * The control of the `index`-th label `label`.
 * @param {ParentNode} root
 * @param {string} label
 * @param {number} [index]
 * @returns {HTMLInputElement}
 */
const field = (root, label, index = 0) => {
	const found = [...root.querySelectorAll('label')].filter((l) => l.textContent?.trim().startsWith(label))[index];
	if (!found) throw new Error(`no label “${label}” #${index}`);
	return /** @type {HTMLInputElement} */ (document.getElementById(/** @type {HTMLLabelElement} */ (found).htmlFor));
};

/**
 * The button whose whole text is `text` (Add is also part of Add window).
 * @param {ParentNode} root
 * @param {string} text
 */
const button = (root, text) => {
	const found = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
	return /** @type {HTMLButtonElement} */ (found ?? byText(root, text, 'button'));
};

/** The options of a select, as shown. @param {HTMLInputElement} select */
const optionsOf = (select) => [.../** @type {HTMLSelectElement} */ (/** @type {unknown} */ (select)).options].map((o) => o.text);

/** Save the list and let it answer. @param {ParentNode} root */
const save = async (root) => {
	click(button(root, 'Save list'));
	await settle();
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('office hours and their exceptions (C9)', () => {
	it('names the weekdays from Intl, keeps minutes, and saves ISO weekday numbers', async () => {
		serve({ office_hours: [{ day: 1, start: '09:30', end: '17:45' }] });
		const { container } = render(inDashboard(<OfficeHoursEditor websiteId={WEBSITE} />));
		await settle();
		expect(optionsOf(field(container, 'Day'))).toEqual([
			'Monday',
			'Tuesday',
			'Wednesday',
			'Thursday',
			'Friday',
			'Saturday',
			'Sunday',
		]);
		expect(field(container, 'Opens').value).toBe('09:30');
		click(button(container, 'Add'));
		type(field(container, 'Day', 1), '7');
		type(field(container, 'Opens', 1), '22:00');
		type(field(container, 'Closes', 1), '02:15');
		await save(container);
		expect(saved.office_hours).toEqual([
			[
				{ day: 1, start: '09:30', end: '17:45' },
				{ day: 7, start: '22:00', end: '02:15' },
			],
		]);
		expect(container.textContent).toContain('Saved');
		// a bad time is refused with the server's words
		type(field(container, 'Closes', 0), '25:00');
		await save(container);
		expect(container.textContent).toContain('Window 1: a day from 1 (Monday) to 7 (Sunday)');
	});

	it('adds a holiday closed all day, and a date with its own hours', async () => {
		serve();
		const { container } = render(inDashboard(<OfficeExceptionsEditor websiteId={WEBSITE} />));
		await settle();
		expect(container.textContent).toContain('Nothing yet.');
		click(button(container, 'Add'));
		type(field(container, 'Date'), '2026-12-25');
		type(field(container, 'Name'), ' Holiday ');
		expect(container.textContent).toContain('Closed all day.');
		click(button(container, 'Add'));
		type(field(container, 'Date', 1), '2026-12-24');
		// the second date's own window
		click(
			/** @type {HTMLButtonElement} */ (
				[...container.querySelectorAll('button')].filter((b) => b.textContent === 'Add window')[1]
			),
		);
		type(field(container, 'Closes'), '12:30');
		await save(container);
		expect(saved.office_exceptions).toEqual([
			[
				{ date: '2026-12-25', name: 'Holiday', hours: [] },
				{ date: '2026-12-24', name: '', hours: [{ start: '09:00', end: '12:30' }] },
			],
		]);
	});
});
