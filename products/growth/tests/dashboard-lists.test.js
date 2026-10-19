// @vitest-environment jsdom
/**
 * Growth's list editor (`ListCard` in `app/dashboard/lists.js`) in the browser (jsdom) on a faked dashboard API: the
 * entries are a table with columns and a row menu, a click on a row opens the fields in a drawer (a funnel's steps
 * inside it) that edits the draft only, the Save bar is the only save, and a refused save names the entry and the field.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byLabel, byText, cleanup, click, render, type } from '@ss/ui/testing';
import { ListCard } from '../app/dashboard/lists.js';
import { closeDrawer, inDashboard, openRow, rowMenu, rowNames } from './dashboard-provider.js';

const WEBSITE = 'web_1';

/** The lists written, by list. @type {Record<string, any[]>} */
let sent = {};

/**
 * The dashboard API: the lists it holds, a save that is kept, or refused with the given errors.
 * @param {Record<string, any[]>} lists
 * @param {Array<{ path: string, message: string }>} [errors] refuse a save with these
 */
const serve = (lists, errors) => {
	sent = {};
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
			const name = path.split('/lists/')[1] ?? '';
			if (!(name in lists)) return new Response(JSON.stringify({ status: 404 }), { status: 404 });
			if (init.method === 'PUT') {
				if (errors) return new Response(JSON.stringify({ status: 422, title: 'Validation failed', errors }), { status: 422 });
				const { value } = JSON.parse(String(init.body));
				(sent[name] ??= []).push(value);
				lists[name] = value;
			}
			return new Response(JSON.stringify({ value: lists[name] }), { status: 200 });
		}),
	);
};

/** Let the loads answer. */
const settle = async () => {
	for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const FUNNEL = {
	key: 'shop',
	name: 'Shop',
	steps: [
		{ name: 'View', kind: 'event', match: 'view_item' },
		{ name: 'Buy', kind: 'event', match: 'purchase' },
	],
};

describe('a Growth list', () => {
	it('shows a skeleton while it loads, then a row per entry with its columns and an empty note when there are none', async () => {
		serve({ funnels: [FUNNEL], seo_ignored: [] });
		const { container } = render(inDashboard(<ListCard websiteId={WEBSITE} name="funnels" bare />));
		expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
		await settle();
		expect(container.querySelector('[aria-busy="true"]')).toBeNull();
		// the page says the title: no card title; the steps are counted
		expect(container.querySelector('h2')).toBeNull();
		expect(rowNames(container)).toEqual(['Shop']);
		expect(container.querySelector('tbody tr')?.textContent).toContain('2');
		cleanup();
		const empty = render(inDashboard(<ListCard websiteId={WEBSITE} name="seo_ignored" bare />));
		await settle();
		expect(empty.container.textContent).toContain('Nothing yet.');
		expect(/** @type {HTMLButtonElement} */ (byText(empty.container, 'Add', 'button')).disabled).toBe(false);
	});

	it('edits a funnel and its steps in a large drawer, and saves the whole list with the Save bar only', async () => {
		serve({ funnels: [FUNNEL] });
		const { container } = render(inDashboard(<ListCard websiteId={WEBSITE} name="funnels" bare />));
		await settle();
		const drawer = await openRow(container, 'Shop');
		expect(drawer.textContent).toContain('1. View');
		expect(drawer.textContent).toContain('2. Buy');
		type(byLabel(drawer, 'Name'), 'Store funnel');
		await closeDrawer();
		expect(sent.funnels).toBeUndefined();
		expect(rowNames(container)).toEqual(['Store funnel']);
		await act(async () => click(byText(document.body, 'Save the list', 'button')));
		await settle();
		expect(sent.funnels).toEqual([[{ ...FUNNEL, name: 'Store funnel' }]]);
	});

	it('moves and removes an entry from its row menu', async () => {
		serve({
			verification_tags: [
				{ name: 'p:domain_verify', content: 'abc' },
				{ name: 'fb:domain', content: 'def' },
			],
		});
		const { container } = render(inDashboard(<ListCard websiteId={WEBSITE} name="verification_tags" bare />));
		await settle();
		await rowMenu(container, 'fb:domain', 'Move up');
		expect(rowNames(container)).toEqual(['fb:domain', 'p:domain_verify']);
		await rowMenu(container, 'p:domain_verify', 'Remove');
		await act(async () => click(byText(document.body, 'Save the list', 'button')));
		await settle();
		expect(sent.verification_tags).toEqual([[{ name: 'fb:domain', content: 'def' }]]);
	});

	it('names the entry and the field when the server refuses the list', async () => {
		serve({ funnels: [FUNNEL] }, [{ path: '/value/0/steps/1/match', message: 'An event name is lower-case.' }]);
		const { container } = render(inDashboard(<ListCard websiteId={WEBSITE} name="funnels" bare />));
		await settle();
		const drawer = await openRow(container, 'Shop');
		type(byLabel(drawer, 'Name'), 'Store funnel');
		await closeDrawer();
		await act(async () => click(byText(document.body, 'Save the list', 'button')));
		await settle();
		expect(container.textContent).toContain('Store funnel, Steps: An event name is lower-case.');
	});
});
