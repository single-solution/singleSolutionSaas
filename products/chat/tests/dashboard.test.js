// @vitest-environment jsdom
/**
 * The dashboard's Overview in the browser (jsdom), on a faked dashboard API (PLAN 0.6 "Overviews talk"): the kit's
 * Overview with Chat's own part while the Book-a-slot tool is on (its booking URL asked for while missing; the
 * settings are read only then), and its times computed in UTC and shown in the viewer's local time (owner
 * 2026-10-14): UTC on the server and in the first render, then the viewer's zone, with UTC on hover. Also the AI label
 * warning of Settings.
 */
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byText, cleanup, click, render } from '@ss/ui/testing';
import { DashboardProvider } from '@ss/ui/dashboard';
import manifest from '../manifest.json' with { type: 'json' };
import { aiLabelNotice } from '../app/dashboard/settings.js';
import { TABS } from '../app/dashboard/tabs.js';
import { TEXTS } from '../app/dashboard/texts.js';

/**
 * A dashboard piece inside the dashboard's provider (its words and feature names), as the page renders it.
 * @param {import('react').ReactNode} node
 */
const inDashboard = (node) => (
	<DashboardProvider manifest={manifest} texts={TEXTS}>
		{node}
	</DashboardProvider>
);

/** The dashboard keeps each answer it loaded for the page: each test opens its own website. */
let website = 0;

/**
 * The overview answer: a grace period, the widget's last visit and a change, at known instants (UTC).
 * @param {string[]} featuresOn
 */
const overview = (featuresOn) => ({
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
 * The overview, and the website's settings with the Book-a-slot tool's booking URL.
 * @param {{ featuresOn?: string[], bookingUrl?: string }} [options]
 */
const serve = ({ featuresOn = [], bookingUrl = '' } = {}) =>
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path) => {
			const settings = { features: [{ key: 'book_slot', on: true, values: { bookingUrl: { value: bookingUrl } } }] };
			const body = path.endsWith('/overview') ? overview(featuresOn) : path.endsWith('/settings') ? settings : null;
			return body
				? new Response(JSON.stringify(body), { status: 200 })
				: new Response(JSON.stringify({ status: 404, title: 'Not found' }), { status: 404 });
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

/** The tab's props for a new website (or the last one's with `same`). */
const props = (same = false) => ({
	websiteId: `web_${same ? website : (website += 1)}`,
	domain: 'shop.example.com',
	who: /** @type {const} */ ({ kind: 'merchant', id: 'm_1', name: 'Merchant' }),
	support: { email: 'help@example.com', phone: '' },
	portal: 'https://portal.example.com',
	open: vi.fn(),
});

/** @param {HTMLElement} container the titles of the "Needs you" items */
const needs = (container) =>
	[...container.querySelectorAll('section[aria-label="Needs you"] li p:first-child')].map((p) => p.textContent);

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("Chat's dashboard Overview", () => {
	it('with the Book-a-slot tool on and no booking URL, asks for it and opens Settings', async () => {
		serve({ featuresOn: ['visitor_chat', 'book_slot'] });
		const Overview = TABS.overview;
		const tab = props();
		const { container } = render(inDashboard(<Overview {...tab} />));
		await settle();
		expect(container.querySelector('h1')?.textContent).toBe('Welcome back, Merchant');
		expect(needs(container)).toContain('The Book-a-slot tool is on, but no booking URL is set');
		click(byText(container, 'Set the URL', 'button'));
		click(byText(container, 'Set the booking URL', 'button'));
		expect(tab.open.mock.calls).toEqual([['settings'], ['settings']]);
	});

	it('asks for nothing once the URL is set, and reads no settings while the tool is off', async () => {
		serve({ featuresOn: ['book_slot'], bookingUrl: 'https://book.example.com/api' });
		const Overview = TABS.overview;
		const set = render(inDashboard(<Overview {...props()} />));
		await settle();
		expect(needs(set.container)).not.toContain('The Book-a-slot tool is on, but no booking URL is set');
		expect(byText(set.container, 'Set the booking URL', 'span').className).toContain('line-through');
		cleanup();
		serve({ featuresOn: ['visitor_chat'] });
		const off = render(inDashboard(<Overview {...props()} />));
		await settle();
		expect(vi.mocked(fetch).mock.calls.map(([path]) => String(path))).toEqual([
			`/v1/dashboard/websites/web_${website}/overview`,
		]);
		expect(off.container.textContent).not.toContain('booking URL');
	});

	it("shows the grace end, the widget's last visit and the changes in the viewer's time zone, UTC on hover", async () => {
		viewerIn('America/New_York');
		serve();
		const Overview = TABS.overview;
		const { container } = render(inDashboard(<Overview {...props()} />));
		await settle();
		const text = container.textContent ?? '';
		expect(text).toContain('Chat is in grace until Oct 4, 2026, 10:30 AM EDT');
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
		const tokyo = render(inDashboard(<Overview {...props()} />));
		await settle();
		expect(tokyo.container.textContent).toContain('Last seen Oct 6, 2026, 8:15 AM GMT+9');
	});

	it('the server and the first render in the browser print UTC', async () => {
		viewerIn('America/New_York');
		serve();
		const Overview = TABS.overview;
		render(inDashboard(<Overview {...props()} />));
		await settle();
		// the answer this page already loaded shows at once, as the server would print it
		const html = renderToString(inDashboard(<Overview {...props(true)} />));
		for (const words of ['Oct 4, 2026, 2:30 PM UTC', 'Oct 5, 2026, 11:15 PM UTC', '>Oct 6, 2026, 8:00 AM UTC</time>'])
			expect(html).toContain(words);
		expect(html).not.toContain('EDT');
	});
});

describe('the AI label warning (PLAN 0.8.3 AI, C1)', () => {
	it('shows on the AI replies card whenever the label is hidden: label off, or never disclose on', () => {
		/** @param {Record<string, unknown>} values */
		const shown = (values) => {
			const notice = aiLabelNotice('ai_replies', values);
			return notice === null ? null : renderToString(notice);
		};
		expect(shown({ showAiLabel: true, neverDisclose: false })).toBeNull();
		expect(shown({ showAiLabel: false, neverDisclose: false })).toContain('EU AI Act');
		// never disclose hides the label even while Show the AI label is on
		expect(shown({ showAiLabel: true, neverDisclose: true })).toContain('EU AI Act');
		expect(aiLabelNotice('ai_caps', { showAiLabel: false })).toBeNull();
	});
});
