// @vitest-environment jsdom
/**
 * The dashboard's times in the browser (jsdom), on a faked dashboard API: computed in UTC and shown in the viewer's
 * local time (owner 2026-10-14). Overview's grace end, the search index's last answer, the widget's last visit and
 * Recent changes print UTC on the server and in the first render, then the same style in the viewer's time zone, with
 * UTC on hover.
 */
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@ss/ui/testing';
import { TABS } from '../app/dashboard/tabs.js';
import { inDashboard } from './dashboard-provider.js';

const WEBSITE = 'web_1';
const BASE = `/v1/dashboard/websites/${WEBSITE}`;

/** The answers of the overview's loads, at known instants (UTC). @type {Record<string, unknown>} */
const ANSWERS = {
	[`${BASE}/overview`]: {
		website: { domain: 'shop.example.com' },
		status: { status: 'grace', graceEndsAt: '2026-10-04T14:30:00.000Z' },
		featuresOn: ['catalog'],
		todayMillicredits: 0,
		checklist: {
			connections: [
				{
					name: 'storage',
					label: 'Storage',
					neededBy: ['catalog'],
					status: 'connected',
					testedAt: '2026-10-03T09:45:00.000Z',
				},
			],
			widget: { installed: true, lastSeenAt: '2026-10-05T23:15:00.000Z' },
			website: { version: 1, requires: [], missing: [] },
		},
		recentChanges: [
			{
				who: { kind: 'user', id: 'u_1', name: 'Alex Morgan' },
				what: 'settings',
				detail: 'Settings',
				at: '2026-10-06T08:00:00.000Z',
			},
		],
	},
	[`${BASE}/connections`]: { connections: [] },
	[`${BASE}/search-index`]: {
		search: 'atlas',
		index: 'products_search',
		state: { missing: false, at: '2026-10-02T18:05:00.000Z', message: '' },
	},
};

/** The overview's loads answer; every other load fails (the tab still shows). */
const serve = () =>
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path) =>
			path in ANSWERS
				? new Response(JSON.stringify(ANSWERS[path]), { status: 200 })
				: new Response(JSON.stringify({ status: 404, title: 'Not found' }), { status: 404 }),
		),
	);

/**
 * The viewer's browser in a time zone (what `Intl.DateTimeFormat().resolvedOptions()` answers there).
 * @param {string} timeZone
 */
const viewerIn = (timeZone) => {
	const real = Intl.DateTimeFormat.prototype.resolvedOptions;
	vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(
		/** @this {Intl.DateTimeFormat} */
		function () {
			return { ...real.call(this), timeZone };
		},
	);
};

/** Let the loads answer. */
const settle = async () => {
	for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

const props = {
	websiteId: WEBSITE,
	who: /** @type {const} */ ({ kind: 'merchant', id: 'm_1', name: 'Merchant' }),
	support: { channels: [{ type: /** @type {const} */ ('email'), label: 'Email', url: 'mailto:help@example.com' }] },
	domain: 'shop.example.com',
	portal: 'https://portal.example.com',
	open: () => undefined,
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('Ecommerce’s dashboard times', () => {
	it('Overview shows every time in the viewer’s time zone, and Recent changes with UTC on hover', async () => {
		viewerIn('America/New_York');
		serve();
		const Overview = TABS.overview;
		const { container } = render(inDashboard(<Overview {...props} />));
		await settle();
		const text = container.textContent ?? '';
		expect(text).toContain('Ecommerce is in grace until Oct 4, 2026, 10:30 AM EDT');
		expect(text).toContain('Create the Atlas Search index products_searchAnswered Oct 2, 2026, 2:05 PM EDT');
		expect(text).toContain('Last seen Oct 5, 2026, 7:15 PM EDT');
		const change = container.querySelector('time[datetime="2026-10-06T08:00:00.000Z"]');
		expect([change?.textContent, change?.getAttribute('title'), change?.getAttribute('datetime')]).toEqual([
			'Oct 6, 2026, 4:00 AM EDT',
			'Oct 6, 2026, 8:00 AM UTC',
			'2026-10-06T08:00:00.000Z',
		]);
		// a viewer far east: the widget's last visit is already the next day there
		cleanup();
		viewerIn('Asia/Tokyo');
		const tokyo = render(inDashboard(<Overview {...props} />));
		await settle();
		expect(tokyo.container.textContent).toContain('Last seen Oct 6, 2026, 8:15 AM GMT+9');
	});

	it('the server and the first render in the browser print UTC', async () => {
		viewerIn('America/New_York');
		serve();
		const Overview = TABS.overview;
		render(inDashboard(<Overview {...props} />));
		await settle();
		// the answers this page already loaded show at once, as the server would print them
		const html = renderToString(inDashboard(<Overview {...props} />));
		for (const words of [
			'in grace until <time',
			'>Oct 4, 2026, 2:30 PM UTC</time>',
			'>Oct 2, 2026, 6:05 PM UTC</time>',
			'>Oct 5, 2026, 11:15 PM UTC</time>',
			'>Oct 6, 2026, 8:00 AM UTC</time>',
		])
			expect(html).toContain(words);
		expect(html).not.toContain('EDT');
	});
});
