// @vitest-environment jsdom
/**
 * The shared list editor (`ListEditor` in `app/dashboard/lists.js`) through the editors that use it, in the browser
 * (jsdom) on a faked dashboard API: the records are a table with useful columns and a row menu, a click on a row opens
 * the fields in a drawer that edits the draft only, Add stops at the limit, the Save bar is the only save control, and
 * a page that is the whole editor leaves out the card title.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byLabel, byText, cleanup, click, keydown, render, type } from '@ss/ui/testing';
import { CouriersEditor, TaxRulesEditor, UnitStatesEditor, ZonesEditor, BookingSchedulesEditor } from '../app/dashboard/lists.js';
import { ReasonsEditor } from '../app/dashboard/merchant-lists.js';
import { closeDrawer, drawerOf, inDashboard, openRow, rowMenu, rowNames } from './dashboard-provider.js';

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

describe('the list editor table', () => {
	it('shows a skeleton table while the list loads, then a row per record with its columns', async () => {
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
		const cells = container.querySelector('tbody')?.textContent ?? '';
		expect(cells).toContain('https://t.example/{tracking}');
		expect(cells).toContain('Courier API keys 2');
		expect(/** @type {HTMLButtonElement} */ (byText(container, 'Add', 'button')).disabled).toBe(false);
	});

	it('edits a record in the drawer without saving, and saves it with the Save bar only', async () => {
		serve({ couriers: [{ key: 'swift', name: 'Swift', trackingUrl: 'https://t.example/{tracking}', connection: '' }] });
		const { container } = render(inDashboard(<CouriersEditor websiteId={WEBSITE} />));
		await settle();
		// no Save bar until something changed, and no Save or Cancel button inside the card
		expect(byTextOrNull(document.body, 'Save list')).toBeNull();
		expect(container.querySelector('[data-entry]')).toBeNull();
		const drawer = await openRow(container, 'Swift');
		expect(drawer.querySelector('h2')?.textContent).toBe('Swift');
		type(byLabel(drawer, 'Name'), 'Swift Post');
		// Done closes the drawer; the draft is not saved
		await closeDrawer();
		expect(drawerOf()).toBeNull();
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

	it('moves and removes a record from its row menu, and a new record opens in the drawer', async () => {
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
		type(byLabel(drawerOf(), 'Name'), 'Refurbished');
		await closeDrawer();
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
		// the first one counts against the customer: a pill, the others none
		expect(container.querySelectorAll('tbody tr')[0]?.textContent).toContain('Yes');
		expect(container.querySelectorAll('tbody tr')[1]?.textContent).not.toContain('Yes');
		cleanup();
		serve({ cancel_reasons: [] });
		const empty = render(inDashboard(<ReasonsEditor websiteId={WEBSITE} list="cancel_reasons" />));
		await settle();
		expect(empty.container.textContent).toContain('Nothing yet.');
		expect(/** @type {HTMLButtonElement} */ (byText(empty.container, 'Add', 'button')).disabled).toBe(false);
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
		const rows = [...container.querySelectorAll('tbody tr')].map((row) => row.textContent);
		expect(rows[0]).toContain('7.5%');
		expect(rows[0]).toContain('All');
		expect(rows[1]).toContain('0%');
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
		const row = container.querySelector('tbody tr');
		expect(row?.textContent).toContain('Home');
		const numbers = [...(row?.querySelectorAll('td') ?? [])].map((cell) => cell.textContent);
		expect(numbers).toContain('3');
		expect(numbers).toContain('2');
		const drawer = await openRow(container, 'Home');
		expect(drawer.querySelectorAll('[data-rate]')).toHaveLength(2);
		await closeDrawer();
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
		const cells = [...(container.querySelectorAll('tbody tr')[0]?.querySelectorAll('td') ?? [])].map(
			(cell) => cell.textContent,
		);
		expect(cells).toContain('2');
		expect(cells).toContain('1');
		const drawer = await openRow(container, 'Main');
		expect(drawer.querySelectorAll('[data-window]')).toHaveLength(2);
	});
});

/** A button by its text, or null. @param {HTMLElement} root @param {string} text */
function byTextOrNull(root, text) {
	return [...root.querySelectorAll('button')].find((button) => button.textContent === text) ?? null;
}
