// @vitest-environment jsdom
/**
 * The merchant's own lists in Settings (jsdom, on a faked dashboard API): office hours by weekday with minutes and
 * dated exceptions (C9); page types with their nudges, seeded with the four shop ones (C6); the file types visitors may
 * send with a cap each (C11); Book-a-slot's questions and services (C10); tags, topics and priorities (C7). Each editor adds, changes, moves and removes entries and saves the whole list with one PUT,
 * checked as the server checks it.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byText, cleanup, click, render, type } from '@ss/ui/testing';
import { DashboardProvider } from '@ss/ui/dashboard';
import manifest from '../manifest.json' with { type: 'json' };
import {
	BookingQuestionsEditor,
	BookingServicesEditor,
	LabelsEditor,
	OfficeExceptionsEditor,
	OfficeHoursEditor,
	PageTypesEditor,
	UploadTypesEditor,
} from '../app/dashboard/lists.js';
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

/** The entry tabs. @param {ParentNode} root */
const tabs = (root) => /** @type {HTMLElement[]} */ ([...root.querySelectorAll('[role="tab"]')]);

/** Shows the `index`-th entry (one entry is shown at a time). @param {ParentNode} root @param {number} index */
const pick = (root, index) => click(/** @type {HTMLElement} */ (tabs(root)[index]));

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
		type(field(container, 'Day'), '7');
		type(field(container, 'Opens'), '22:00');
		type(field(container, 'Closes'), '02:15');
		await save(container);
		expect(saved.office_hours).toEqual([
			[
				{ day: 1, start: '09:30', end: '17:45' },
				{ day: 7, start: '22:00', end: '02:15' },
			],
		]);
		expect(container.textContent).toContain('Saved');
		// a bad time is refused with the server's words
		pick(container, 0);
		type(field(container, 'Closes'), '25:00');
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
		type(field(container, 'Date'), '2026-12-24');
		// the second date's own window
		click(button(container, 'Add window'));
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

describe('page types (C6)', () => {
	it('starts with the four shop page types; the merchant renames, adds with a path pattern, moves and removes', async () => {
		serve();
		const { container } = render(inDashboard(<PageTypesEditor websiteId={WEBSITE} />));
		await settle();
		expect(tabs(container).map((tab) => tab.textContent)).toEqual(['Product page', 'Category page', 'Deals page', 'Cart']);
		pick(container, 3);
		type(field(container, 'Name'), 'Basket');
		pick(container, 0);
		type(field(container, 'Idle nudge'), 'Still deciding on {product}?');
		click(button(container, 'Add'));
		type(field(container, 'Key'), 'menu');
		type(field(container, 'Name'), 'Menu');
		type(field(container, 'Path pattern'), '/menu/**');
		// the deals page goes, the menu moves up one
		pick(container, 2);
		click(button(container, 'Remove'));
		pick(container, 3);
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="Move up"]')));
		await save(container);
		expect(saved.page_types).toEqual([
			[
				{ key: 'product', name: 'Product page', path: '', nudge: 'Still deciding on {product}?' },
				{ key: 'category', name: 'Category page', path: '', nudge: '' },
				{ key: 'menu', name: 'Menu', path: '/menu/**', nudge: '' },
				{ key: 'cart', name: 'Basket', path: '', nudge: '' },
			],
		]);
		// other is the type of pages that match none
		pick(container, 0);
		type(field(container, 'Key'), 'other');
		await save(container);
		expect(container.textContent).toContain('Page type 1: a unique key');
	});
});

describe('upload types (C11)', () => {
	it('starts with today’s five types at 5 MB; adds a video with its own cap and refuses a cap over 100 MB', async () => {
		serve();
		const { container } = render(inDashboard(<UploadTypesEditor websiteId={WEBSITE} />));
		await settle();
		expect(
			[0, 1, 2, 3, 4].map((index) => {
				pick(container, index);
				return field(container, 'Type').value;
			}),
		).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);
		expect(optionsOf(field(container, 'Type'))).toContain('HEIC photo (image/heic)');
		expect(optionsOf(field(container, 'Type'))).toContain('Ogg audio (voice notes) (audio/ogg)');
		click(button(container, 'Add'));
		type(field(container, 'Type'), 'video/quicktime');
		type(field(container, 'Largest file (MB)'), '60');
		await save(container);
		expect(saved.upload_types?.[0]?.slice(4)).toEqual([
			{ type: 'application/pdf', maxMb: 5 },
			{ type: 'video/quicktime', maxMb: 60 },
		]);
		type(field(container, 'Largest file (MB)'), '500');
		await save(container);
		expect(container.textContent).toContain('File type 6: the largest file as whole MB, 1–100.');
	});
});

describe('booking questions and services (C10)', () => {
	it('starts with name, email and phone; adds a choice question, and a service', async () => {
		serve();
		const questions = render(inDashboard(<BookingQuestionsEditor websiteId={WEBSITE} />)).container;
		await settle();
		expect(tabs(questions).map((tab) => tab.textContent)).toEqual(['Name', 'Email', 'Phone']);
		expect(field(questions, 'Required').checked).toBe(true);
		click(button(questions, 'Add'));
		type(field(questions, 'Key'), 'seating');
		type(field(questions, 'Question'), 'Seating');
		type(field(questions, 'Answer'), 'choice');
		type(field(questions, 'Options'), 'Inside\n\nTerrace ');
		await save(questions);
		expect(saved.booking_questions?.[0]?.[3]).toEqual({
			key: 'seating',
			label: 'Seating',
			type: 'choice',
			required: false,
			options: ['Inside', 'Terrace'],
		});
		cleanup();
		const services = render(inDashboard(<BookingServicesEditor websiteId={WEBSITE} />)).container;
		await settle();
		expect(services.textContent).toContain('Nothing yet.');
		click(button(services, 'Add'));
		type(field(services, 'Key'), 'dinner');
		type(field(services, 'Name'), 'Dinner');
		await save(services);
		expect(saved.booking_services).toEqual([[{ key: 'dinner', name: 'Dinner', description: '' }]]);
	});
});

describe('tags, topics and priorities (C7)', () => {
	it('priorities start as Urgent, High, Normal and Low; tags start empty and take a key, a name and when it fits', async () => {
		serve();
		const priorities = render(inDashboard(<LabelsEditor websiteId={WEBSITE} list="priorities" />)).container;
		await settle();
		expect(tabs(priorities).map((tab) => tab.textContent)).toEqual(['Urgent', 'High', 'Normal', 'Low']);
		cleanup();
		const tags = render(inDashboard(<LabelsEditor websiteId={WEBSITE} list="tags" />)).container;
		await settle();
		expect(tags.textContent).toContain('Nothing yet.');
		click(button(tags, 'Add'));
		type(field(tags, 'Key'), 'vip');
		type(field(tags, 'Name'), 'VIP');
		type(field(tags, 'When it fits'), 'A repeat customer');
		await save(tags);
		expect(saved.tags).toEqual([[{ key: 'vip', name: 'VIP', description: 'A repeat customer' }]]);
	});
});
