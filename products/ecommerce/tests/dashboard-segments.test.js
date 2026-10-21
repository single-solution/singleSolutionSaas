// @vitest-environment jsdom
/**
 * The customer segments editor in Settings → Customers (E11), in the browser (jsdom) on a faked dashboard API: it lists
 * the saved segments as rows (a row opens its rules in a drawer), adds a segment with a tag rule and a spend rule in the shop's currency, refuses
 * a rule without its value before saving, and saves the whole list with one PUT that the server's check takes.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byLabel, byText, cleanup, click, render, type } from '@ss/ui/testing';
import { SegmentsEditor } from '../app/dashboard/lists.js';
import { DEFAULT_SEGMENTS, checkSegments } from '../core/customer-segments.js';
import { closeEditor, drawerOf, inDashboard, openRow, rowNames } from './dashboard-provider.js';

const WEBSITE = 'web_1';
const PATH = `/v1/dashboard/websites/${WEBSITE}/lists/customer_segments`;

/** The lists the editor saved. @type {any[]} */
let saved = [];

const serve = () => {
	saved = [];
	/** @type {any} */
	let list = structuredClone(DEFAULT_SEGMENTS);
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
			if (path !== PATH) return new Response(JSON.stringify({ status: 404 }), { status: 404 });
			if (init.method === 'PUT') {
				const { value } = JSON.parse(String(init.body));
				saved.push(value);
				const checked = checkSegments(value);
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

const settle = async () => {
	for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('the customer segments editor', () => {
	it('lists the segments, adds one with rules and saves the list the server takes', async () => {
		serve();
		const { container } = render(inDashboard(<SegmentsEditor websiteId={WEBSITE} currency="USD" />));
		await settle();
		// a row per segment, its record in a drawer
		expect(rowNames(container)).toHaveLength(3);
		const loyalty = await openRow(container, 'Loyalty members');
		expect(byLabel(loyalty, 'Name').getAttribute('value')).toBe('Loyalty members');
		await closeEditor();
		const add = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Add');
		await act(async () => click(/** @type {HTMLElement} */ (add)));
		const fourth = drawerOf();
		expect(rowNames(container)).toHaveLength(4);
		type(byLabel(fourth, 'Name'), 'Big spenders');
		await act(async () => click(byText(fourth, 'Add rule', 'button')));
		const rules = [...fourth.querySelectorAll('[data-rule]')];
		type(byLabel(/** @type {HTMLElement} */ (rules[1]), 'Rule'), 'spent');
		type(byLabel(/** @type {HTMLElement} */ ([...fourth.querySelectorAll('[data-rule]')][1]), 'Amount (USD)'), '500.50');
		// the tag rule has no value yet: refused before anything is sent
		await closeEditor();
		await act(async () => click(byText(container, 'Save list', 'button')));
		await settle();
		expect(saved).toHaveLength(0);
		expect(container.textContent).toContain('Big spenders: give every rule its value.');
		const again = await openRow(container, 'Big spenders');
		type(byLabel(/** @type {HTMLElement} */ ([...again.querySelectorAll('[data-rule]')][0]), 'Value'), 'vip');
		type(byLabel(again, 'Customers match'), 'any');
		await closeEditor();
		await act(async () => click(byText(container, 'Save list', 'button')));
		await settle();
		expect(saved).toHaveLength(1);
		expect(saved[0].slice(0, 3)).toEqual(DEFAULT_SEGMENTS);
		expect(saved[0][3]).toEqual({
			key: 'big_spenders',
			name: 'Big spenders',
			match: 'any',
			rules: [
				{ field: 'tag', op: 'is', value: 'vip' },
				{ field: 'spent', op: 'gte', value: 50050 },
			],
		});
		expect(checkSegments(saved[0]).ok).toBe(true);
		expect(container.textContent).toContain('Saved');
	});
});
