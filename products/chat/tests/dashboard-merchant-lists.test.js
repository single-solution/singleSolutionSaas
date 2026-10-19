// @vitest-environment jsdom
/**
 * The merchant's own lists in Settings (jsdom, on a faked dashboard API): office hours by weekday with minutes and
 * dated exceptions (C9); page types with their nudges, seeded with the four shop ones (C6); the file types visitors may
 * send with a cap each (C11); Book-a-slot's questions and services (C10); tags, topics and priorities (C7). Each editor
 * is a table (a row menu moves and removes an entry; a click on a row opens its fields in a drawer), adds, changes,
 * moves and removes entries and saves the whole list with one PUT from the Save bar, checked as the server checks it.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byText, cleanup, click, render, type } from '@ss/ui/testing';
import {
	BookingQuestionsEditor,
	BookingServicesEditor,
	LabelsEditor,
	OfficeExceptionsEditor,
	OfficeHoursEditor,
	PageTypesEditor,
	UploadTypesEditor,
} from '../app/dashboard/lists.js';
import { LISTS } from '../adapters/lists.js';
import { closeDrawer, drawerOf, inDashboard, openRow, rowMenu, rowNames } from './dashboard-provider.js';

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

/**
 * Open the `index`-th row's entry in the drawer.
 * @param {HTMLElement} root
 * @param {number} index
 */
const openAt = async (root, index) => {
	const cell = /** @type {HTMLElement} */ (root.querySelectorAll('tbody tr')[index]?.querySelector('th, td'));
	await act(async () => click(cell));
	return drawerOf();
};

/** Add an entry: it opens in the drawer. @param {HTMLElement} root */
const add = async (root) => {
	await act(async () => click(button(root, 'Add')));
	return drawerOf();
};

/** Close the drawer, save the list with the Save bar and let it answer. */
const save = async () => {
	if (drawerOf()) await closeDrawer();
	await act(async () => click(button(document.body, 'Save list')));
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
		// a row is a weekday with its opening and closing time
		expect(rowNames(container)).toEqual(['Monday']);
		expect(container.querySelector('tbody')?.textContent).toContain('09:30');
		expect(container.querySelector('tbody')?.textContent).toContain('17:45');
		const first = await openRow(container, 'Monday');
		expect(optionsOf(field(first, 'Day'))).toEqual([
			'Monday',
			'Tuesday',
			'Wednesday',
			'Thursday',
			'Friday',
			'Saturday',
			'Sunday',
		]);
		expect(field(first, 'Opens').value).toBe('09:30');
		await closeDrawer();
		const second = await add(container);
		type(field(second, 'Day'), '7');
		type(field(second, 'Opens'), '22:00');
		type(field(second, 'Closes'), '02:15');
		await save();
		expect(saved.office_hours).toEqual([
			[
				{ day: 1, start: '09:30', end: '17:45' },
				{ day: 7, start: '22:00', end: '02:15' },
			],
		]);
		expect(rowNames(container)).toEqual(['Monday', 'Sunday']);
		expect(container.textContent).toContain('Saved');
		// a bad time is refused with the server's words
		const again = await openAt(container, 0);
		type(field(again, 'Closes'), '25:00');
		await save();
		expect(container.textContent).toContain('Window 1: a day from 1 (Monday) to 7 (Sunday)');
	});

	it('adds a holiday closed all day, and a date with its own hours', async () => {
		serve();
		const { container } = render(inDashboard(<OfficeExceptionsEditor websiteId={WEBSITE} />));
		await settle();
		expect(container.textContent).toContain('Nothing yet.');
		const holiday = await add(container);
		type(field(holiday, 'Date'), '2026-12-25');
		type(field(holiday, 'Name'), ' Holiday ');
		expect(holiday.textContent).toContain('Closed all day.');
		await closeDrawer();
		const eve = await add(container);
		type(field(eve, 'Date'), '2026-12-24');
		// the second date's own window
		await act(async () => click(button(eve, 'Add window')));
		type(field(eve, 'Closes'), '12:30');
		await closeDrawer();
		// a row is the holiday's name (else its date) with its date and hours
		expect(rowNames(container)).toEqual(['Holiday', '2026-12-24']);
		expect(container.querySelector('tbody')?.textContent).toContain('09:00–12:30');
		await save();
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
		expect(rowNames(container)).toEqual(['Product page', 'Category page', 'Deals page', 'Cart']);
		const cart = await openRow(container, 'Cart');
		type(field(cart, 'Name'), 'Basket');
		await closeDrawer();
		const product = await openRow(container, 'Product page');
		type(field(product, 'Idle nudge'), 'Still deciding on {product}?');
		await closeDrawer();
		const menu = await add(container);
		type(field(menu, 'Key'), 'menu');
		type(field(menu, 'Name'), 'Menu');
		type(field(menu, 'Path pattern'), '/menu/**');
		await closeDrawer();
		// the deals page goes, the menu moves up one
		await rowMenu(container, 'Deals page', 'Remove');
		await rowMenu(container, 'Menu', 'Move up');
		expect(rowNames(container)).toEqual(['Product page', 'Category page', 'Menu', 'Basket']);
		await save();
		expect(saved.page_types).toEqual([
			[
				{ key: 'product', name: 'Product page', path: '', nudge: 'Still deciding on {product}?' },
				{ key: 'category', name: 'Category page', path: '', nudge: '' },
				{ key: 'menu', name: 'Menu', path: '/menu/**', nudge: '' },
				{ key: 'cart', name: 'Basket', path: '', nudge: '' },
			],
		]);
		// other is the type of pages that match none
		const first = await openRow(container, 'Product page');
		type(field(first, 'Key'), 'other');
		await save();
		expect(container.textContent).toContain('Page type 1: a unique key');
	});
});

describe('upload types (C11)', () => {
	it('starts with today’s five types at 5 MB; adds a video with its own cap and refuses a cap over 100 MB', async () => {
		serve();
		const { container } = render(inDashboard(<UploadTypesEditor websiteId={WEBSITE} />));
		await settle();
		// a row is the type's name with its largest file
		expect(rowNames(container)).toHaveLength(5);
		expect(rowNames(container)[0]).toContain('(image/jpeg)');
		const types = [];
		for (const index of [0, 1, 2, 3, 4]) {
			types.push(field(await openAt(container, index), 'Type').value);
			await closeDrawer();
		}
		expect(types).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);
		const added = await add(container);
		expect(optionsOf(field(added, 'Type'))).toContain('HEIC photo (image/heic)');
		expect(optionsOf(field(added, 'Type'))).toContain('Ogg audio (voice notes) (audio/ogg)');
		type(field(added, 'Type'), 'video/quicktime');
		type(field(added, 'Largest file (MB)'), '60');
		await save();
		expect(saved.upload_types?.[0]?.slice(4)).toEqual([
			{ type: 'application/pdf', maxMb: 5 },
			{ type: 'video/quicktime', maxMb: 60 },
		]);
		const last = await openAt(container, 5);
		type(field(last, 'Largest file (MB)'), '500');
		await save();
		expect(container.textContent).toContain('File type 6: the largest file as whole MB, 1–100.');
	});
});

describe('booking questions and services (C10)', () => {
	it('starts with name, email and phone; adds a choice question, and a service', async () => {
		serve();
		const questions = render(inDashboard(<BookingQuestionsEditor websiteId={WEBSITE} />)).container;
		await settle();
		expect(rowNames(questions)).toEqual(['Name', 'Email', 'Phone']);
		const name = await openRow(questions, 'Name');
		expect(field(name, 'Required').checked).toBe(true);
		await closeDrawer();
		const seating = await add(questions);
		type(field(seating, 'Key'), 'seating');
		type(field(seating, 'Question'), 'Seating');
		type(field(seating, 'Answer'), 'choice');
		type(field(seating, 'Options'), 'Inside\n\nTerrace ');
		await save();
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
		const dinner = await add(services);
		type(field(dinner, 'Key'), 'dinner');
		type(field(dinner, 'Name'), 'Dinner');
		await save();
		expect(saved.booking_services).toEqual([[{ key: 'dinner', name: 'Dinner', description: '' }]]);
	});
});

describe('tags, topics and priorities (C7)', () => {
	it('priorities start as Urgent, High, Normal and Low; tags start empty and take a key, a name and when it fits', async () => {
		serve();
		const priorities = render(inDashboard(<LabelsEditor websiteId={WEBSITE} list="priorities" />)).container;
		await settle();
		expect(rowNames(priorities)).toEqual(['Urgent', 'High', 'Normal', 'Low']);
		cleanup();
		const tags = render(inDashboard(<LabelsEditor websiteId={WEBSITE} list="tags" />)).container;
		await settle();
		expect(tags.textContent).toContain('Nothing yet.');
		const vip = await add(tags);
		type(field(vip, 'Key'), 'vip');
		type(field(vip, 'Name'), 'VIP');
		type(field(vip, 'When it fits'), 'A repeat customer');
		await save();
		expect(saved.tags).toEqual([[{ key: 'vip', name: 'VIP', description: 'A repeat customer' }]]);
	});
});
