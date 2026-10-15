// @vitest-environment jsdom
/**
 * The dashboard's Overview in the browser (jsdom), on a faked dashboard API (PLAN 0.6 "Overviews talk"): it greets the
 * signed-in person, says what needs them with the buttons that open the right section or read business.json again,
 * and shows the setup and Recent changes in the viewer's local time (UTC on the server and in the first render).
 */
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byText, cleanup, click, render } from '@ss/ui/testing';
import { TABS } from '../app/dashboard/tabs.js';
import { TEXTS } from '../app/dashboard/texts.js';

const WEBSITE = 'web_1';
const BASE = `/v1/dashboard/websites/${WEBSITE}`;

/** The overview answer: the sample feature on, its database not connected, the widget never seen, a change. */
const OVERVIEW = {
	website: { websiteId: WEBSITE, domain: 'shop.example.com', merchantId: 'mer_1', merchantName: 'Acme' },
	status: { status: 'grace', graceEndsAt: '2026-10-04T14:30:00.000Z' },
	featuresOn: ['notes'],
	todayMillicredits: 2500,
	checklist: {
		connections: [{ name: 'database', label: 'Database (MongoDB)', neededBy: ['notes'], status: 'not_connected' }],
		widget: { installed: false, lastSeenAt: '2026-09-20T23:15:00.000Z' },
		business: { found: false, fetchedAt: null },
	},
	recentChanges: [
		{
			who: { kind: 'admin', id: 'adm_1', name: 'Ada Admin' },
			what: 'features',
			detail: 'Features: notes on',
			at: '2026-10-01T10:00:00.000Z',
		},
	],
};

/** The dashboard API: the overview, and business.json read again on request. */
const serve = () =>
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) =>
			path === `${BASE}/overview` || (path === `${BASE}/business/refresh` && init.method === 'POST')
				? new Response(JSON.stringify(path.endsWith('/overview') ? OVERVIEW : { found: false }), { status: 200 })
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

/** The tab's props: a merchant's session; `open` shows another section. */
const props = () => ({
	websiteId: WEBSITE,
	who: /** @type {const} */ ({ kind: 'merchant', id: 'mer_1', name: 'Acme' }),
	support: { email: 'help@example.com', phone: '' },
	portal: 'https://portal.example.com',
	open: vi.fn(),
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('the dashboard Overview', () => {
	it('greets the merchant and says what needs them, most urgent first, with the right buttons', async () => {
		viewerIn('America/New_York');
		serve();
		const Overview = TABS.overview;
		const tab = props();
		const { container } = render(<Overview {...tab} />);
		await settle();
		expect(container.querySelector('h1')?.textContent).toBe('Welcome back, Acme');
		const needs = [...container.querySelectorAll('section[aria-label="Needs you"] li p:first-child')].map((p) => p.textContent);
		expect(needs).toEqual([
			`${TEXTS.title} is in grace until Oct 4, 2026, 10:30 AM EDT`,
			'Database (MongoDB) is not connected',
			'The widget has not been seen on shop.example.com',
			'business.json was not found on shop.example.com',
		]);
		expect(container.textContent).toContain(`${TEXTS.title} is in grace until Oct 4, 2026, 10:30 AM EDT, and 3 more`);
		expect(byText(container, 'Contact support', 'a').getAttribute('href')).toBe('mailto:help@example.com');
		click(byText(container, 'Connect', 'button'));
		click(byText(container, 'Get the script', 'button'));
		expect(tab.open.mock.calls).toEqual([['connections'], ['developers']]);
		click(byText(container, 'Check again', 'button'));
		await settle();
		expect(vi.mocked(fetch)).toHaveBeenCalledWith(`${BASE}/business/refresh`, expect.objectContaining({ method: 'POST' }));
		// the setup and Recent changes, in the viewer's time
		expect(container.textContent).toContain('1 of 4 done');
		expect(container.textContent).toContain('Last seen Sep 20, 2026, 7:15 PM EDT');
		expect(container.textContent).toContain('Ada Admin · Features: notes on');
		expect(container.textContent).toContain('2.5 credits');
	});

	it('prints UTC on the server and in the first render', async () => {
		viewerIn('America/New_York');
		serve();
		const Overview = TABS.overview;
		render(<Overview {...props()} />);
		await settle();
		// the answer this page already loaded shows at once, as the server would print it
		const html = renderToString(<Overview {...props()} />);
		for (const words of ['Oct 4, 2026, 2:30 PM UTC', 'Sep 20, 2026, 11:15 PM UTC', 'Oct 1, 2026, 10:00 AM UTC'])
			expect(html).toContain(words);
		expect(html).not.toContain('EDT');
	});
});
