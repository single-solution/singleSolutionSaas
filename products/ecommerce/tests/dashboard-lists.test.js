// @vitest-environment jsdom
/**
 * The shared list editor (`ListEditor` in `app/dashboard/lists.js`) through the editors that use it, in the browser
 * (jsdom) on a faked dashboard API: the records are rich rows (name, facts, value, a dot) with a row menu, a click on a
 * row opens the fields under it (a long record in a drawer) that edit the draft only, Add stops at the limit, an empty
 * list is an empty state with the one Add action, the Save bar is the only save control, and a page that is the whole
 * editor leaves out the card title.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byLabel, byText, cleanup, click, keydown, render, type } from '@ss/ui/testing';
import { CouriersEditor, TaxRulesEditor, UnitStatesEditor, ZonesEditor, BookingSchedulesEditor } from '../app/dashboard/lists.js';
import { ReasonsEditor } from '../app/dashboard/merchant-lists.js';
import {
	closeEditor,
	drawerOf,
	editorOf,
	factsOf,
	inDashboard,
	openRow,
	rowMenu,
	rowNames,
	rowOf,
	rowsOf,
} from './dashboard-provider.js';

const WEBSITE = 'web_1';

/** The lists the editor saved, by list. @type {Record<string, any[]>} */
let saved = {};

/**
 * The dashboard API: the lists it holds, and a save that is kept.
 * @param {Record<string, any>} lists by list name
 * @param {{ late?: boolean }} [options] `late`: the lists answer only when `release` is called
 */
const serve = (lists, options = {}) => {
	saved = {};
	/** @type {Array<() => void>} */
	const waiting = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
			const name = path.split('/lists/')[1] ?? '';
			if (!(name in lists)) return new Response(JSON.stringify({ status: 404 }), { status: 404 });
			if (init.method === 'PUT') {
				const { value } = JSON.parse(String(init.body));
				(saved[name] ??= []).push(value);
				lists[name] = value;
			} else if (options.late) await new Promise((resolve) => waiting.push(() => resolve(undefined)));
			return new Response(JSON.stringify({ value: lists[name] }), { status: 200 });
		}),
	);
	return { release: () => waiting.splice(0).forEach((go) => go()) };
};

/** Let the loads answer. */
const settle = async () => {
	for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('the list editor rows', () => {
	it('shows a skeleton while the list loads, then a row per record with its facts', async () => {
		const api = serve(
			{ couriers: [{ key: 'swift', name: 'Swift', trackingUrl: 'https://t.example/{tracking}', connection: 'courier_2' }] },
			{ late: true },
		);
		const { container } = render(inDashboard(<CouriersEditor websiteId={WEBSITE} />));
		await settle();
		expect(container.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
		// the title and Add are there while it loads; Add waits for the list
		expect(container.querySelector('h2')?.textContent).toBe('Couriers');
		expect(/** @type {HTMLButtonElement} */ (byText(container, 'Add', 'button')).disabled).toBe(true);
		api.release();
		await settle();
		expect(container.querySelector('[aria-busy="true"]')).toBeNull();
		expect(rowNames(container)).toEqual(['Swift']);
		const facts = factsOf(rowOf(container, 'Swift'));
		expect(facts.meta).toBe('https://t.example/{tracking}');
		expect(facts.value).toBe('Courier API keys 2');
		expect(/** @type {HTMLButtonElement} */ (byText(container, 'Add', 'button')).disabled).toBe(false);
	});

	it('edits a record under its row without saving, and saves it with the Save bar only', async () => {
		serve({ couriers: [{ key: 'swift', name: 'Swift', trackingUrl: 'https://t.example/{tracking}', connection: '' }] });
		const { container } = render(inDashboard(<CouriersEditor websiteId={WEBSITE} />));
		await settle();
		// no Save bar until something changed, and no Save or Cancel button inside the card
		expect(byTextOrNull(document.body, 'Save list')).toBeNull();
		expect(container.querySelector('[data-entry]')).toBeNull();
		const fields = await openRow(container, 'Swift');
		// a few fields open in place, under their row, not in a drawer
		expect(drawerOf()).toBeNull();
		type(byLabel(fields, 'Name'), 'Swift Post');
		// Done closes the fields; the draft is not saved
		await closeEditor();
		expect(container.querySelector('[data-entry]')).toBeNull();
		expect(saved.couriers).toBeUndefined();
		expect(rowNames(container)).toEqual(['Swift Post']);
		await act(async () => click(byText(document.body, 'Save list', 'button')));
		await settle();
		expect(saved.couriers).toEqual([
			[{ key: 'swift', name: 'Swift Post', trackingUrl: 'https://t.example/{tracking}', connection: '' }],
		]);
		expect(container.textContent).toContain('Saved');
		expect(byTextOrNull(document.body, 'Save list')).toBeNull();
	});

	it('moves and removes a record from its row menu, and a new record opens under its row', async () => {
		serve({
			unit_states: [
				{ key: 'new', label: 'New' },
				{ key: 'used', label: 'Used' },
			],
		});
		const { container } = render(inDashboard(<UnitStatesEditor websiteId={WEBSITE} />));
		await settle();
		await rowMenu(container, 'Used', 'Move up');
		expect(rowNames(container)).toEqual(['Used', 'New']);
		// an end of the list cannot move further
		await act(async () => click(/** @type {HTMLElement} */ (container.querySelector('button[aria-haspopup]'))));
		const up = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === 'Move up');
		expect(up?.hasAttribute('disabled') || up?.getAttribute('aria-disabled') === 'true').toBe(true);
		await keydown(document, 'Escape');
		await rowMenu(container, 'New', 'Remove');
		expect(rowNames(container)).toEqual(['Used']);
		await act(async () => click(byText(container, 'Add', 'button')));
		type(byLabel(editorOf(), 'Name'), 'Refurbished');
		await closeEditor();
		expect(rowNames(container)).toEqual(['Used', 'Refurbished']);
		await act(async () => click(byText(document.body, 'Save list', 'button')));
		await settle();
		expect(saved.unit_states).toEqual([
			[
				{ key: 'used', label: 'Used' },
				{ key: 'refurbished', label: 'Refurbished' },
			],
		]);
	});

	it('stops Add at the limit and says so when the list is empty', async () => {
		const reasons = Array.from({ length: 30 }, (_, index) => ({
			key: `r${index}`,
			label: `Reason ${index}`,
			countsAgainst: index === 0,
		}));
		serve({ cancel_reasons: reasons });
		const { container } = render(inDashboard(<ReasonsEditor websiteId={WEBSITE} list="cancel_reasons" />));
		await settle();
		expect(rowNames(container)).toHaveLength(30);
		expect(/** @type {HTMLButtonElement} */ (byText(container, 'Add', 'button')).disabled).toBe(true);
		// the first one counts against the customer: a dot, the others none
		expect(factsOf(/** @type {HTMLElement} */ (rowsOf(container)[0])).status).toBe('Counts against');
		expect(factsOf(/** @type {HTMLElement} */ (rowsOf(container)[1])).status).toBe('');
		cleanup();
		serve({ cancel_reasons: [] });
		const empty = render(inDashboard(<ReasonsEditor websiteId={WEBSITE} list="cancel_reasons" />));
		await settle();
		expect(empty.container.textContent).toContain('Nothing yet.');
		// the empty state carries the one Add action
		expect([...empty.container.querySelectorAll('button')].filter((one) => one.textContent === 'Add')).toHaveLength(1);
		expect(/** @type {HTMLButtonElement} */ (byText(empty.container, 'Add', 'button')).disabled).toBe(false);
		await act(async () => click(byText(empty.container, 'Add', 'button')));
		expect(rowNames(empty.container)).toEqual(['Reason 1']);
	});

	it('leaves the card title out when the page already says it', async () => {
		serve({ couriers: [] });
		const titled = render(inDashboard(<CouriersEditor websiteId={WEBSITE} />));
		await settle();
		expect(titled.container.querySelector('h2')?.textContent).toBe('Couriers');
		cleanup();
		serve({ couriers: [] });
		const bare = render(inDashboard(<CouriersEditor websiteId={WEBSITE} bare />));
		await settle();
		expect(bare.container.querySelector('h2')).toBeNull();
		// the help line and Add are still there
		expect(bare.container.textContent).toContain('Staff pick the courier when an order ships.');
		expect(byText(bare.container, 'Add', 'button')).toBeTruthy();
	});
});

describe('the editors with longer records', () => {
	it('lists tax rules with their percent and where they apply', async () => {
		serve({
			tax_rules: [
				{ name: 'Standard', percent: 7.5, categoryIds: [], regions: [] },
				{ name: 'Food', percent: 0, categoryIds: ['cat_food', 'cat_drink'], regions: [{ country: 'US', region: 'CA' }] },
			],
		});
		const { container } = render(inDashboard(<TaxRulesEditor websiteId={WEBSITE} />));
		await settle();
		expect(rowNames(container)).toEqual(['Standard', 'Food']);
		const [standard, food] = rowsOf(container).map(factsOf);
		expect(standard?.value).toBe('7.5%');
		expect(standard?.meta).toBe('Categories: All · Regions: All');
		expect(food?.value).toBe('0%');
		expect(food?.meta).toBe('Categories: 2 · Regions: 1');
		const drawer = await openRow(container, 'Food');
		const categories = /** @type {unknown} */ (byLabel(drawer, 'Category ids (one per line, empty: all)'));
		expect(/** @type {HTMLTextAreaElement} */ (categories).value).toContain('cat_food');
	});

	it('lists delivery zones with their places and rates, and edits the rates in a large drawer', async () => {
		serve({
			delivery_zones: [
				{
					key: 'home',
					name: 'Home',
					match: { countries: ['US'], regions: ['CA', 'NV'], cities: [], areas: [], postcodes: [] },
					rates: [
						{
							key: 'standard',
							name: 'Standard',
							kind: 'delivery',
							price: 500,
							freeOver: 0,
							minDays: 1,
							maxDays: 3,
							condition: { by: 'none', min: 0, max: 0 },
							locations: [],
						},
						{
							key: 'express',
							name: 'Express',
							kind: 'delivery',
							price: 1500,
							freeOver: 0,
							minDays: 1,
							maxDays: 1,
							condition: { by: 'none', min: 0, max: 0 },
							locations: [],
						},
					],
				},
			],
		});
		const { container } = render(inDashboard(<ZonesEditor websiteId={WEBSITE} currency="USD" />));
		await settle();
		const facts = factsOf(rowOf(container, 'Home'));
		expect(facts.meta).toBe('Places: 3');
		expect(facts.value).toBe('Rates: 2');
		const drawer = await openRow(container, 'Home');
		expect(drawer.querySelectorAll('[data-rate]')).toHaveLength(2);
		await closeEditor();
	});

	it('lists booking schedules with their weekly windows', async () => {
		serve({
			booking_schedules: [
				{
					key: 'main',
					name: 'Main',
					weekly: [
						{ day: 1, start: '09:00', end: '17:00' },
						{ day: 2, start: '09:00', end: '17:00' },
					],
					exceptions: [{ date: '2026-12-25', name: 'Holiday', hours: [] }],
				},
			],
		});
		const { container } = render(inDashboard(<BookingSchedulesEditor websiteId={WEBSITE} />));
		await settle();
		const facts = factsOf(rowOf(container, 'Main'));
		expect(facts.value).toBe('Weekly windows: 2');
		expect(facts.meta).toBe('Exceptions: 1');
		const drawer = await openRow(container, 'Main');
		expect(drawer.querySelectorAll('[data-window]')).toHaveLength(2);
	});
});

/** A button by its text, or null. @param {HTMLElement} root @param {string} text */
function byTextOrNull(root, text) {
	return [...root.querySelectorAll('button')].find((button) => button.textContent === text) ?? null;
}
