// @vitest-environment jsdom
/**
 * The dashboard's Overview in the browser (jsdom), on a faked dashboard API (PLAN 0.6 "Overviews talk"): the kit's
 * Overview with Payments' own part — the gateways ready, and, while Bank transfer is on (the settings are read only
 * then), what it misses before payers see it (PLAN 0.8.10 P2) — and its times computed in UTC and shown in the viewer's
 * local time (owner 2026-10-14): UTC on the server and in the first render, then the viewer's zone, with UTC on hover.
 */
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byText, cleanup, click, render } from '@ss/ui/testing';
import { TABS } from '../app/dashboard/tabs.js';

/** The dashboard keeps each answer it loaded for the page: each render opens its own website. */
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
 * The overview, and the website's settings with these Bank transfer values.
 * @param {{ featuresOn?: string[], bank?: Record<string, unknown> }} [options]
 */
const serve = ({ featuresOn = [], bank = {} } = {}) =>
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path) => {
			if (path.endsWith('/overview')) return new Response(JSON.stringify(overview(featuresOn)), { status: 200 });
			if (path.endsWith('/settings')) {
				const entries = Object.entries(bank).map(([name, value]) => [name, { value, source: 'website' }]);
				const features = [{ key: 'bank_transfer', on: true, values: Object.fromEntries(entries) }];
				return new Response(JSON.stringify({ features }), { status: 200 });
			}
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

/** The tab's props for a new website (or the last one's with `same`). */
const props = (same = false) => ({
	websiteId: `web_${same ? website : (website += 1)}`,
	who: /** @type {const} */ ({ kind: 'merchant', id: 'm_1', name: 'Merchant' }),
	support: { email: 'help@example.com', phone: '' },
	portal: 'https://portal.example.com',
	open: vi.fn(),
});

/** @param {HTMLElement} container the "Needs you" items */
const needs = (container) => [...container.querySelectorAll('section[aria-label="Needs you"] li')];

/** @param {HTMLElement} container the text of the Gateways ready tile */
const gateways = (container) => byText(container, 'Gateways ready', 'span').parentElement?.parentElement?.textContent;

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("Payments's dashboard Overview: bank transfer readiness (PLAN 0.8.10 P2)", () => {
	it('says what is missing before payers see bank transfer, and counts it ready once they are told how to pay', async () => {
		const Overview = TABS.overview;
		/** @type {Array<[Record<string, unknown>, string]>} */
		const missing = [
			[
				{ requireDetails: true },
				'Set the account holder name and the account number or IBAN in Settings, or turn off Require bank details and write instructions that tell payers how to pay.',
			],
			[
				{ requireDetails: true, accountHolder: 'Northwind Ltd', instructions: 'Ask us.' },
				'Set the account number or IBAN in Settings, or turn off Require bank details',
			],
			[
				{ requireDetails: false, bankName: 'Example Bank' },
				'Write instructions in Settings that tell payers how to pay, or set the account number or IBAN.',
			],
		];
		for (const [bank, help] of missing) {
			cleanup();
			serve({ featuresOn: ['bank_transfer'], bank });
			const tab = props();
			const { container } = render(<Overview {...tab} />);
			await settle();
			const item = needs(container).find((li) =>
				li.textContent?.startsWith('Bank transfer is on, but payers do not see it yet'),
			);
			expect(item?.textContent).toContain(help);
			expect(gateways(container)).toContain('Gateways ready0');
			click(byText(container, 'Open Settings', 'button'));
			expect(tab.open).toHaveBeenCalledWith('settings');
		}
		cleanup();
		serve({ featuresOn: ['bank_transfer'], bank: { requireDetails: false, instructions: 'We send our details by email.' } });
		const { container } = render(<Overview {...props()} />);
		await settle();
		expect(needs(container).map((li) => li.textContent)).toEqual([expect.stringContaining('in grace until')]);
		expect(byText(container, 'Finish the bank transfer details', 'span').className).toContain('line-through');
		expect(gateways(container)).toContain('Gateways ready1');
	});

	it('reads no settings while Bank transfer is off', async () => {
		serve({ featuresOn: ['stripe'] });
		const Overview = TABS.overview;
		const { container } = render(<Overview {...props()} />);
		await settle();
		expect(vi.mocked(fetch).mock.calls.map(([path]) => String(path))).toEqual([
			`/v1/dashboard/websites/web_${website}/overview`,
		]);
		expect(container.textContent).not.toContain('Bank transfer');
	});
});

describe("Payments's dashboard times", () => {
	it("Overview shows the grace end, the widget's last visit and the changes in the viewer's time zone, UTC on hover", async () => {
		viewerIn('America/New_York');
		serve();
		const Overview = TABS.overview;
		const { container } = render(<Overview {...props()} />);
		await settle();
		const text = container.textContent ?? '';
		expect(text).toContain('Payments is in grace until Oct 4, 2026, 10:30 AM EDT');
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
		for (const words of ['Oct 4, 2026, 2:30 PM UTC', 'Oct 5, 2026, 11:15 PM UTC', '>Oct 6, 2026, 8:00 AM UTC</time>'])
			expect(html).toContain(words);
		expect(html).not.toContain('EDT');
	});
});
