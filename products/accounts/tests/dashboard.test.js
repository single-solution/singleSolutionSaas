// @vitest-environment jsdom
/**
 * The dashboard's Overview in the browser (jsdom), on a faked dashboard API (PLAN 0.6 "Overviews talk"): the kit's
 * Overview with Accounts' own part while Custom fields is on (the fields counted, a field to add while there is none;
 * the list is not read while the feature is off), and its times computed in UTC and shown in the viewer's local time
 * (owner 2026-10-14): UTC on the server and in the first render, then the viewer's zone, with UTC on hover.
 */
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byText, cleanup, click, render } from '@ss/ui/testing';
import { TABS } from '../app/dashboard/tabs.js';

/** The dashboard keeps each answer it loaded for the page: each test opens its own website. */
let website = 0;

/**
 * The overview answer: a grace period, the widget's last visit and a change, at known instants (UTC).
 * @param {string[]} [featuresOn]
 */
const overview = (featuresOn = []) => ({
	website: { websiteId: `web_${website}`, domain: 'shop.example.com', merchantId: 'm_1', merchantName: 'Merchant' },
	status: { status: 'grace', graceEndsAt: '2026-10-04T14:30:00.000Z' },
	featuresOn,
	todayMillicredits: 0,
	checklist: {
		connections: [],
		widget: { installed: true, lastSeenAt: '2026-10-05T23:15:00.000Z' },
		business: { found: true, fetchedAt: null },
	},
	recentChanges: [
		{
			who: { kind: 'user', id: 'u_1', name: 'Alex Morgan' },
			what: 'settings',
			detail: 'Settings',
			at: '2026-10-06T08:00:00.000Z',
		},
	],
});

/**
 * The overview, and the custom fields (`fields`; null: the database is not connected, 409).
 * @param {{ featuresOn?: string[], fields?: unknown[] | null }} [options]
 */
const serve = ({ featuresOn = [], fields = [] } = {}) =>
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path) => {
			if (path.endsWith('/overview')) return new Response(JSON.stringify(overview(featuresOn)), { status: 200 });
			if (path.endsWith('/fields') && fields) return new Response(JSON.stringify({ items: fields }), { status: 200 });
			if (path.endsWith('/fields'))
				return new Response(JSON.stringify({ status: 409, title: 'Connect the database' }), { status: 409 });
			return new Response(JSON.stringify({ status: 404, title: 'Not found' }), { status: 404 });
		}),
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

/** The tab's props for a new website (or the same as the last call's with `same`). */
const props = (same = false) => ({
	websiteId: `web_${same ? website : (website += 1)}`,
	who: /** @type {const} */ ({ kind: 'merchant', id: 'm_1', name: 'Merchant' }),
	support: { email: 'help@example.com', phone: '' },
	portal: 'https://portal.example.com',
	open: vi.fn(),
});

/** @param {HTMLElement} container the titles of the "Needs you" items, in order */
const needs = (container) =>
	[...container.querySelectorAll('section[aria-label="Needs you"] li p:first-child')].map((p) => p.textContent);

/** @param {HTMLElement} container @param {string} label the text of the number tile with this label */
const tile = (container, label) => byText(container, label, 'span').parentElement?.parentElement?.textContent;

/** @returns {string[]} the paths the tab read */
const reads = () => vi.mocked(fetch).mock.calls.map(([path]) => String(path));

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("Accounts's dashboard Overview", () => {
	it('with Custom fields on and no field yet, asks for one and opens Settings', async () => {
		serve({ featuresOn: ['email_password', 'custom_fields'] });
		const Overview = TABS.overview;
		const tab = props();
		const { container } = render(<Overview {...tab} />);
		await settle();
		expect(container.querySelector('h1')?.textContent).toBe('Welcome back, Merchant');
		expect(needs(container)).toContain('Custom fields is on, but no field is set up yet');
		click(byText(container, 'Add a field', 'button'));
		click(byText(container, 'Add a custom field', 'button'));
		expect(tab.open.mock.calls).toEqual([['settings'], ['settings']]);
		expect(tile(container, 'Custom fields')).toBe('Custom fields0');
	});

	it('counts the fields once there are some; without the database it says to connect it first', async () => {
		serve({ featuresOn: ['custom_fields'], fields: [{ key: 'company' }, { key: 'size' }] });
		const Overview = TABS.overview;
		const first = render(<Overview {...props()} />);
		await settle();
		expect(needs(first.container)).not.toContain('Custom fields is on, but no field is set up yet');
		expect(byText(first.container, 'Add a custom field', 'span').className).toContain('line-through');
		cleanup();
		serve({ featuresOn: ['custom_fields'], fields: null });
		const second = render(<Overview {...props()} />);
		await settle();
		expect(second.container.textContent).toContain('Connect the database first');
		expect(second.container.textContent).not.toContain('Add a custom field');
	});

	it('reads no custom fields while the feature is off', async () => {
		serve({ featuresOn: ['email_password'] });
		const Overview = TABS.overview;
		const { container } = render(<Overview {...props()} />);
		await settle();
		expect(reads()).toEqual([`/v1/dashboard/websites/web_${website}/overview`]);
		expect(container.textContent).not.toContain('Custom fields');
	});

	it("shows the grace end, the widget's last visit and the changes in the viewer's time zone, UTC on hover", async () => {
		viewerIn('America/New_York');
		serve();
		const Overview = TABS.overview;
		const { container } = render(<Overview {...props()} />);
		await settle();
		const text = container.textContent ?? '';
		expect(text).toContain('Accounts is in grace until Oct 4, 2026, 10:30 AM EDT');
		expect(text).toContain('Last seen Oct 5, 2026, 7:15 PM EDT');
		const change = container.querySelector('ol time');
		expect([change?.textContent, change?.getAttribute('title'), change?.getAttribute('datetime')]).toEqual([
			'Oct 6, 2026, 4:00 AM EDT',
			'Oct 6, 2026, 8:00 AM UTC',
			'2026-10-06T08:00:00.000Z',
		]);
		// a viewer far east: the widget's last visit is already the next day there
		cleanup();
		viewerIn('Asia/Tokyo');
		const tokyo = render(<Overview {...props()} />);
		await settle();
		expect(tokyo.container.textContent).toContain('Last seen Oct 6, 2026, 8:15 AM GMT+9');
	});

	it('the server and the first render in the browser print UTC', async () => {
		viewerIn('America/New_York');
		serve();
		const Overview = TABS.overview;
		render(<Overview {...props()} />);
		await settle();
		// the answer this page already loaded shows at once, as the server would print it
		const html = renderToString(<Overview {...props(true)} />);
		for (const words of [
			'Oct 4, 2026, 2:30 PM UTC',
			'Last seen ',
			'Oct 5, 2026, 11:15 PM UTC',
			'>Oct 6, 2026, 8:00 AM UTC</time>',
		])
			expect(html).toContain(words);
		expect(html).not.toContain('EDT');
	});
});
