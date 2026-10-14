// @vitest-environment jsdom
/**
 * The dashboard's times in the browser (jsdom), on a faked dashboard API: computed in UTC and shown in the viewer's
 * local time (owner 2026-10-14). Overview's grace end, the widget's last visit and Recent changes print UTC on the
 * server and in the first render, then the same style in the viewer's time zone, with UTC on hover.
 */
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@ss/ui/testing';
import { TABS } from '../app/dashboard/tabs.js';

const WEBSITE = 'web_1';

/** The overview answer: a grace period, the widget's last visit and a change, at known instants (UTC). */
const OVERVIEW = {
	status: { status: 'grace', graceEndsAt: '2026-10-04T14:30:00.000Z' },
	featuresOn: [],
	todayMillicredits: 0,
	checklist: { connections: [], widget: { installed: true, lastSeenAt: '2026-10-05T23:15:00.000Z' }, business: { found: true } },
	recentChanges: [
		{
			who: { kind: 'user', id: 'u_1', name: 'Alex Morgan' },
			what: 'settings',
			detail: 'Settings',
			at: '2026-10-06T08:00:00.000Z',
		},
	],
};

/** Only the overview answers; every other load of the tab fails (the tab still shows). */
const serve = () =>
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path) =>
			path === `/v1/dashboard/websites/${WEBSITE}/overview`
				? new Response(JSON.stringify(OVERVIEW), { status: 200 })
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
	domain: 'shop.example.com',
	who: /** @type {const} */ ({ kind: 'merchant', id: 'm_1', name: 'Merchant' }),
	support: { email: 'help@example.com', phone: '' },
	portal: 'https://portal.example.com',
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("Chat's dashboard times", () => {
	it("Overview shows the grace end, the widget's last visit and the changes in the viewer's time zone, UTC on hover", async () => {
		viewerIn('America/New_York');
		serve();
		const Overview = TABS.overview;
		const { container } = render(<Overview {...props} />);
		await settle();
		const text = container.textContent ?? '';
		expect(text).toContain('In grace until Oct 4, 2026, 10:30 AM EDT');
		expect(text).toContain('Last seen Oct 5, 2026, 7:15 PM EDT');
		const change = container.querySelector('time');
		expect([change?.textContent, change?.getAttribute('title'), change?.getAttribute('datetime')]).toEqual([
			'Oct 6, 2026, 4:00 AM EDT',
			'Oct 6, 2026, 8:00 AM UTC',
			'2026-10-06T08:00:00.000Z',
		]);
		// a viewer far east: the widget's last visit is already the next day there
		cleanup();
		viewerIn('Asia/Tokyo');
		const tokyo = render(<Overview {...props} />);
		await settle();
		expect(tokyo.container.textContent).toContain('Last seen Oct 6, 2026, 8:15 AM GMT+9');
	});

	it('the server and the first render in the browser print UTC', async () => {
		viewerIn('America/New_York');
		serve();
		const Overview = TABS.overview;
		render(<Overview {...props} />);
		await settle();
		// the answer this page already loaded shows at once, as the server would print it
		const html = renderToString(<Overview {...props} />);
		for (const words of [
			'In grace until Oct 4, 2026, 2:30 PM UTC',
			'Last seen Oct 5, 2026, 11:15 PM UTC',
			'>Oct 6, 2026, 8:00 AM UTC</time>',
		])
			expect(html).toContain(words);
		expect(html).not.toContain('EDT');
	});
});
