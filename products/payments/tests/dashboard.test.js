// @vitest-environment jsdom
/**
 * The dashboard's Overview in the browser (jsdom), on a faked dashboard API (PLAN 0.6 "Overviews talk"): the shared
 * Overview with Payments' own part — the gateways ready, and, while Bank transfer is on (the settings are read only
 * then), what it misses before payers see it (PLAN 0.8.10 P2).
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardProvider } from '@ss/ui/dashboard';
import { byText, cleanup, click, render } from '@ss/ui/testing';
import manifest from '../manifest.json' with { type: 'json' };
import { TABS } from '../app/dashboard/tabs.js';
import { TEXTS } from '../app/dashboard/texts.js';

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

/** @param {HTMLElement} container the "Needs you" items */
const needs = (container) => [...container.querySelectorAll('section[aria-label="Needs you"] li')];

/** @param {HTMLElement} container the text of the Gateways ready tile */
const gateways = (container) => byText(container, 'Gateways ready', 'span').parentElement?.parentElement?.textContent;

/**
 * Payments' Overview with the dashboard's words and feature names around it.
 * @param {ReturnType<typeof props>} tab
 */
const Overview = (tab) => (
	<DashboardProvider manifest={manifest} texts={TEXTS}>
		<TABS.overview {...tab} />
	</DashboardProvider>
);

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("Payments's dashboard Overview: bank transfer readiness (PLAN 0.8.10 P2)", () => {
	it('says what is missing before payers see bank transfer, and counts it ready once they are told how to pay', async () => {
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
		const { container } = render(<Overview {...props()} />);
		await settle();
		expect(vi.mocked(fetch).mock.calls.map(([path]) => String(path))).toEqual([
			`/v1/dashboard/websites/web_${website}/overview`,
		]);
		expect(container.textContent).not.toContain('Bank transfer');
	});
});
