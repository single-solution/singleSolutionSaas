// @vitest-environment jsdom
/**
 * The dashboard page in the browser (jsdom), on a faked dashboard API (PLAN 0.6 "Overviews talk"): opened from the
 * Portal for a website, it greets the signed-in person with this product's name, says what needs them with the buttons
 * that open the right section or read business.json again, and shows the setup and Recent changes in the viewer's
 * local time.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { byText, cleanup, click, render } from '@ss/ui/testing';
import Dashboard from '../app/dashboard/page.js';
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

/** The signed-in merchant's session, from the Portal's `/sso`. */
const SESSION = {
	who: { kind: 'merchant', id: 'mer_1', name: 'Acme' },
	portalUrl: 'https://portal.example.com',
	branding: { name: 'Single Solution' },
	support: { email: 'help@example.com', phone: '' },
	switcher: [{ merchantName: 'Acme', websites: [{ websiteId: WEBSITE, domain: 'shop.example.com' }] }],
};

/** The dashboard API: the session, the overview, and business.json read again on request. */
const serve = () =>
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
			if (path === '/v1/dashboard/session') return new Response(JSON.stringify(SESSION), { status: 200 });
			if (path === `${BASE}/overview`) return new Response(JSON.stringify(OVERVIEW), { status: 200 });
			if (path === `${BASE}/business/refresh` && init.method === 'POST')
				return new Response(JSON.stringify({ found: false }), { status: 200 });
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

// React names the section's view transition with CSS.escape, which jsdom lacks
beforeEach(() => vi.stubGlobal('CSS', { escape: (/** @type {string} */ text) => text }));

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('the dashboard', () => {
	it('opens the Overview of the website: this product greets the merchant and says what needs them', async () => {
		viewerIn('America/New_York');
		serve();
		window.history.replaceState(null, '', `/dashboard?websiteId=${WEBSITE}`);
		const { container } = render(<Dashboard />);
		await settle();
		expect(container.textContent).toContain(TEXTS.title);
		expect(container.querySelector('h1')?.textContent).toBe('Welcome back, Acme');
		const needs = [...container.querySelectorAll('section[aria-label="Needs you"] li p:first-child')].map((p) => p.textContent);
		expect(needs).toEqual([
			`${TEXTS.title} is in grace until Oct 4, 2026, 10:30 AM EDT`,
			'Database (MongoDB) is not connected',
			'The widget has not been seen on shop.example.com',
			'business.json was not found on shop.example.com',
		]);
		expect(byText(container, 'Contact support', 'a').getAttribute('href')).toBe('mailto:help@example.com');
		click(byText(container, 'Check again', 'button'));
		await settle();
		expect(vi.mocked(fetch)).toHaveBeenCalledWith(`${BASE}/business/refresh`, expect.objectContaining({ method: 'POST' }));
		// the setup and Recent changes, in the viewer's time
		expect(container.textContent).toContain('1 of 4 done');
		expect(container.textContent).toContain('Ada Admin · Features: notes on');
		// a button opens another section of the page
		click(byText(container, 'Connect', 'button'));
		await settle();
		expect(window.location.search).toBe(`?websiteId=${WEBSITE}&view=connections`);
	});
});
