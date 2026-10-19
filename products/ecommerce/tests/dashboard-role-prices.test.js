// @vitest-environment jsdom
/**
 * The role prices editor in Settings → Role prices (PLAN 0.8.10 E19, the guide's promise), in the browser (jsdom) on a
 * faked dashboard API: it lists the saved roles in a table, opens one in a drawer, adds one, moves and removes rows from
 * the row menu, refuses a percent outside 0–90 before saving, and saves the whole list with one PUT that the server's
 * check takes. The Settings sections show Role prices with the feature only.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byLabel, byText, cleanup, click, render, type } from '@ss/ui/testing';
import { RolePricesEditor } from '../app/dashboard/lists.js';
import { TABS } from '../app/dashboard/tabs.js';
import { checkRolePrices } from '../core/role-pricing.js';
import { closeDrawer, drawerOf, inDashboard, openRow, rowMenu, rowNames } from './dashboard-provider.js';

const WEBSITE = 'web_1';
const PATH = `/v1/dashboard/websites/${WEBSITE}/lists/role_prices`;

/** The lists the editor saved. @type {any[]} */
let saved = [];

/** The list the faked API holds. @type {any} */
let list = [];

/** The dashboard API: the saved list, and a save checked as the server checks it. */
const serve = () => {
	saved = [];
	list = [{ role: 'wholesale', percent: 15, label: 'Trade price' }];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
			if (path !== PATH) return new Response(JSON.stringify({ status: 404 }), { status: 404 });
			if (init.method === 'PUT') {
				const { value } = JSON.parse(String(init.body));
				saved.push(value);
				const checked = checkRolePrices(value);
				if (!checked.ok)
					return new Response(
						JSON.stringify({ status: 422, errors: checked.errors.map((message) => ({ path: '/value', message })) }),
						{ status: 422 },
					);
				list = checked.value;
			}
			return new Response(JSON.stringify({ value: list }), { status: 200 });
		}),
	);
};

/** The list's own Add button (not Add price). @param {HTMLElement} root */
const addButton = (root) =>
	/** @type {HTMLElement} */ ([...root.querySelectorAll('button')].find((button) => button.textContent === 'Add'));

/** Let the loads answer. */
const settle = async () => {
	for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('the role prices editor', () => {
	it('lists the roles in a table, adds one and saves the list the server takes', async () => {
		serve();
		const { container } = render(inDashboard(<RolePricesEditor websiteId={WEBSITE} currency="USD" />));
		await settle();
		// a row per role: the role, what it gets and its quote label
		expect(rowNames(container)).toEqual(['wholesale']);
		expect(container.querySelector('tbody')?.textContent).toContain('15% off');
		expect(container.querySelector('tbody')?.textContent).toContain('Trade price');
		// a click on the row opens its fields in a drawer; nothing is saved yet
		const first = await openRow(container, 'wholesale');
		expect(byLabel(first, 'Accounts role').getAttribute('value') ?? '').toBe('wholesale');
		expect(/** @type {HTMLInputElement} */ (byLabel(first, 'Percent off (0–90)')).value).toBe('15');
		await closeDrawer();
		expect(drawerOf()).toBeNull();
		// Add opens the new role in the drawer
		await act(async () => click(addButton(container)));
		const second = drawerOf();
		expect(second.querySelectorAll('[data-entry]')).toHaveLength(1);
		type(byLabel(second, 'Accounts role'), 'staff');
		type(byLabel(second, 'Percent off (0–90)'), '95');
		await closeDrawer();
		expect(rowNames(container)).toEqual(['wholesale', 'staff']);
		await act(async () => click(byText(container, 'Save list', 'button')));
		await settle();
		// refused before anything is sent
		expect(saved).toHaveLength(0);
		expect(container.textContent).toContain('staff: the percent is a number from 0 to 90.');
		await openRow(container, 'staff');
		type(byLabel(drawerOf(), 'Percent off (0–90)'), '10');
		await closeDrawer();
		await act(async () => click(byText(container, 'Save list', 'button')));
		await settle();
		expect(saved).toEqual([
			[
				{ role: 'wholesale', kind: 'percent', percent: 15, label: 'Trade price' },
				{ role: 'staff', kind: 'percent', percent: 10, label: '' },
			],
		]);
		expect(checkRolePrices(saved[0]).ok).toBe(true);
		expect(container.textContent).toContain('Saved');
		// the server's refusal is listed (a role twice)
		await act(async () => click(addButton(container)));
		type(byLabel(drawerOf(), 'Accounts role'), 'staff');
		type(byLabel(drawerOf(), 'Percent off (0–90)'), '5');
		await closeDrawer();
		await act(async () => click(byText(container, 'Save list', 'button')));
		await settle();
		expect(container.textContent).toContain("Role 'staff' is listed twice.");
	});

	it('moves and removes a row from its menu and keeps the limit and the empty text', async () => {
		serve();
		list = [
			{ role: 'wholesale', percent: 15 },
			{ role: 'staff', percent: 10 },
			{ role: 'member', percent: 5 },
		];
		const { container } = render(inDashboard(<RolePricesEditor websiteId={WEBSITE} currency="USD" />));
		await settle();
		expect(rowNames(container)).toEqual(['wholesale', 'staff', 'member']);
		await rowMenu(container, 'member', 'Move up');
		expect(rowNames(container)).toEqual(['wholesale', 'member', 'staff']);
		await rowMenu(container, 'wholesale', 'Move down');
		expect(rowNames(container)).toEqual(['member', 'wholesale', 'staff']);
		await rowMenu(container, 'wholesale', 'Remove');
		expect(rowNames(container)).toEqual(['member', 'staff']);
		await act(async () => click(byText(container, 'Save list', 'button')));
		await settle();
		expect(saved.map((value) => value.map((/** @type {any} */ entry) => entry.role))).toEqual([['member', 'staff']]);
		// Discard forgets the draft
		await rowMenu(container, 'staff', 'Remove');
		expect(rowNames(container)).toEqual(['member']);
		await act(async () => click(byText(document.body, 'Cancel', 'button')));
		expect(rowNames(container)).toEqual(['member', 'staff']);
		// every row removed: the empty text
		await rowMenu(container, 'member', 'Remove');
		await rowMenu(container, 'staff', 'Remove');
		expect(container.textContent).toContain('Nothing yet.');
	});

	it('gives a role fixed prices per product or variant (E31)', async () => {
		serve();
		const { container } = render(inDashboard(<RolePricesEditor websiteId={WEBSITE} currency="USD" />));
		await settle();
		const first = await openRow(container, 'wholesale');
		type(byLabel(first, 'Price'), 'prices');
		await closeDrawer();
		expect(container.querySelector('tbody')?.textContent).toContain('0 prices');
		// no price yet: refused before anything is sent
		await act(async () => click(byText(container, 'Save list', 'button')));
		await settle();
		expect(saved).toHaveLength(0);
		expect(container.textContent).toContain('wholesale: add at least one price.');
		const again = await openRow(container, 'wholesale');
		await act(async () => click(byText(again, 'Add price', 'button')));
		const row = /** @type {HTMLElement} */ (again.querySelector('[data-price]'));
		type(byLabel(row, 'Product id (prd_…)'), 'prd_lamp');
		type(byLabel(row, 'Price (USD)'), '12.50');
		await closeDrawer();
		await act(async () => click(byText(container, 'Save list', 'button')));
		await settle();
		expect(saved).toEqual([
			[
				{
					role: 'wholesale',
					kind: 'prices',
					prices: [{ productId: 'prd_lamp', variantId: null, price: 1250 }],
					label: 'Trade price',
				},
			],
		]);
		expect(checkRolePrices(saved[0]).ok).toBe(true);
	});
});

describe('Settings → Role pricing', () => {
	it('lists the editor under Role pricing while the feature is on, and nothing while it is off', async () => {
		/** @param {boolean} on */
		const answer = (on) => ({
			features: ['catalog', 'checkout', 'role_pricing'].map((key) => ({
				key,
				name: key,
				on: key !== 'role_pricing' || on,
				schema: {
					type: 'object',
					properties: key === 'role_pricing' ? {} : { x: { type: 'string', title: 'X', default: '' } },
				},
				values: {},
			})),
		});
		serve();
		const Settings = TABS.settings;
		const props = {
			websiteId: WEBSITE,
			domain: 'shop.example.com',
			who: /** @type {const} */ ({ kind: 'admin', id: 'a_1', name: 'Admin', role: 'owner' }),
			support: { channels: [] },
			portal: 'https://portal.example.com',
			open: () => undefined,
		};
		const original = fetch;
		/** @param {boolean} on */
		const stub = (on) =>
			vi.stubGlobal(
				'fetch',
				vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init) =>
					path === `/v1/dashboard/websites/${WEBSITE}/settings`
						? new Response(JSON.stringify(answer(on)), { status: 200 })
						: original(path, init),
				),
			);
		stub(true);
		const on = render(inDashboard(<Settings {...props} />));
		await settle();
		click(/** @type {HTMLElement} */ (on.container.querySelector('nav a[href="#role_pricing"]')));
		await settle();
		expect(on.container.textContent).toContain('Role prices');
		expect(rowNames(on.container)).toEqual(['wholesale']);
		cleanup();
		stub(false);
		const off = render(inDashboard(<Settings {...props} />));
		await settle();
		expect(off.container.querySelector('nav a[href="#role_pricing"]')).toBeNull();
		expect(rowNames(off.container)).toEqual([]);
	});
});
