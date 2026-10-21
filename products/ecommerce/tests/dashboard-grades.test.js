// @vitest-environment jsdom
/**
 * The condition grades editor (`GradesEditor` in `app/dashboard/grades.js`) in the browser (jsdom) on a faked dashboard
 * API: the grades are rich rows (swatch and name, a dot when it is not offered, condition, return and warranty times and
 * what each is for on one line, the key at the right) with a row menu, a click on a row opens the fields in a drawer whose Done applies them to the draft
 * only (a grade without a name stays open), and the Save bar is the only save control.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byLabel, byText, cleanup, click, render, type } from '@ss/ui/testing';
import { GradesEditor } from '../app/dashboard/grades.js';
import { closeEditor, drawerOf, factsOf, inDashboard, openRow, rowMenu, rowNames, rowsOf } from './dashboard-provider.js';

const WEBSITE = 'web_1';

/** A saved grade. @param {Record<string, any>} [patch] */
const grade = (patch = {}) => ({
	key: 'a',
	label: 'Grade A',
	description: '',
	returnTime: { amount: 14, unit: 'days' },
	warrantyTime: null,
	categoryId: null,
	categoryIds: [],
	typeKeys: [],
	color: '#2a9d8f',
	video: '',
	content: { summary: '', bullets: [] },
	active: true,
	condition: 'refurbished',
	seo: { title: '', description: '', body: '', faqs: [] },
	...patch,
});

/** The lists the editor saved. @type {any[][]} */
let saved = [];

/** The dashboard API holding the grades list. @param {any[]} list @param {{ late?: boolean }} [options] */
const serve = (list, options = {}) => {
	saved = [];
	/** @type {Array<() => void>} */
	const waiting = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ _path, /** @type {RequestInit} */ init = {}) => {
			if (init.method === 'PUT') {
				const { value } = JSON.parse(String(init.body));
				saved.push(value);
				list = value;
			} else if (options.late) await new Promise((resolve) => waiting.push(() => resolve(undefined)));
			return new Response(JSON.stringify({ value: list }), { status: 200 });
		}),
	);
	return { release: () => waiting.splice(0).forEach((go) => go()) };
};

/** The Save bar's button, or null while nothing changed. */
const saveButton = () => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Save list') ?? null;

const settle = async () => {
	for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('the condition grades list', () => {
	it('shows a skeleton while the grades load, then a row per grade with its facts', async () => {
		const api = serve(
			[grade(), grade({ key: 'b', label: 'Grade B', active: false, condition: 'used', categoryIds: ['c1', 'c2'] })],
			{ late: true },
		);
		const { container } = render(inDashboard(<GradesEditor websiteId={WEBSITE} />));
		await settle();
		expect(container.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
		expect(container.querySelector('h2')?.textContent).toBe('Condition grades');
		expect(/** @type {HTMLButtonElement} */ (byText(container, 'Add grade', 'button')).disabled).toBe(true);
		api.release();
		await settle();
		expect(container.querySelector('[aria-busy="true"]')).toBeNull();
		expect(rowNames(container)).toEqual(['Grade A', 'Grade B']);
		const [first, second] = rowsOf(container).map(factsOf);
		expect(first?.meta).toContain('Refurbished');
		expect(first?.meta).toContain('Returns 14 days · warranty as set');
		expect(first?.meta).toContain('All categories');
		expect(first?.value).toBe('a');
		expect(first?.status).toBe('');
		expect(second?.meta).toContain('2 categories');
		expect(second?.status).toBe('Not offered');
		expect(/** @type {HTMLButtonElement} */ (byText(container, 'Add grade', 'button')).disabled).toBe(false);
	});

	it('leaves the card title out on a page that says it already', async () => {
		serve([]);
		const { container } = render(inDashboard(<GradesEditor websiteId={WEBSITE} bare />));
		await settle();
		expect(container.querySelector('h2')).toBeNull();
		expect(container.textContent).toContain('Nothing yet.');
		expect(byText(container, 'Add grade', 'button')).toBeTruthy();
		// the empty state has the one Add action, not a second one in the header
		expect([...container.querySelectorAll('button')].filter((button) => button.textContent === 'Add grade')).toHaveLength(1);
	});

	it('edits a grade in the drawer on a working copy, and saves with the Save bar only', async () => {
		serve([grade()]);
		const { container } = render(inDashboard(<GradesEditor websiteId={WEBSITE} />));
		await settle();
		expect(saveButton()).toBeNull();
		const drawer = await openRow(container, 'Grade A');
		expect(drawer.querySelector('h2')?.textContent).toBe('Edit Grade A');
		type(byLabel(drawer, 'Name'), 'Grade A+');
		// the table still shows the saved name until Done; Cancel throws the change away
		expect(rowNames(container)).toEqual(['Grade A']);
		await act(async () => click(byText(drawer, 'Cancel', 'button')));
		expect(drawerOf()).toBeNull();
		expect(rowNames(container)).toEqual(['Grade A']);
		expect(saveButton()).toBeNull();
		const again = await openRow(container, 'Grade A');
		type(byLabel(again, 'Name'), 'Grade A+');
		await closeEditor();
		expect(drawerOf()).toBeNull();
		expect(rowNames(container)).toEqual(['Grade A+']);
		expect(saved).toEqual([]);
		await act(async () => click(byText(document.body, 'Save list', 'button')));
		await settle();
		expect(saved).toHaveLength(1);
		expect(saved[0]?.[0]).toMatchObject({ key: 'a', label: 'Grade A+', condition: 'refurbished' });
		expect(container.textContent).toContain('Saved');
	});

	it('keeps the drawer open for a grade without a name, then adds it to the end of the table', async () => {
		serve([grade()]);
		const { container } = render(inDashboard(<GradesEditor websiteId={WEBSITE} />));
		await settle();
		await act(async () => click(byText(container, 'Add grade', 'button')));
		expect(drawerOf().querySelector('h2')?.textContent).toBe('New grade');
		await closeEditor();
		expect(drawerOf()).not.toBeNull();
		expect(drawerOf().textContent).toContain('Give the grade a name.');
		type(byLabel(drawerOf(), 'Name'), 'Grade C');
		await closeEditor();
		expect(drawerOf()).toBeNull();
		expect(rowNames(container)).toEqual(['Grade A', 'Grade C']);
	});

	it('moves and removes a grade from its row menu', async () => {
		serve([grade(), grade({ key: 'b', label: 'Grade B' }), grade({ key: 'c', label: 'Grade C' })]);
		const { container } = render(inDashboard(<GradesEditor websiteId={WEBSITE} />));
		await settle();
		await rowMenu(container, 'Grade C', 'Move up');
		expect(rowNames(container)).toEqual(['Grade A', 'Grade C', 'Grade B']);
		await rowMenu(container, 'Grade A', 'Remove');
		expect(rowNames(container)).toEqual(['Grade C', 'Grade B']);
		await act(async () => click(byText(document.body, 'Save list', 'button')));
		await settle();
		expect(saved[0]?.map((/** @type {{ key: string }} */ one) => one.key)).toEqual(['c', 'b']);
	});
});
