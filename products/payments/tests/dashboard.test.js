// @vitest-environment jsdom
/**
 * The dashboard's Overview in the browser (jsdom), on a faked dashboard API (PLAN 0.6 "Overviews talk"): the shared
 * Overview with Payments' own part — the ways to pay ready, and, while Manual payment methods is on (its list is read
 * only then), the methods payers do not see yet and Storage missing while a method takes proofs (fixed-choices P1, P2).
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
 * The overview, the website's manual payment methods and its connections (storage connected or not).
 * @param {{ featuresOn?: string[], methods?: unknown[], storage?: boolean }} [options]
 */
const serve = ({ featuresOn = [], methods = [], storage = false } = {}) =>
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path) => {
			if (path.endsWith('/overview')) return new Response(JSON.stringify(overview(featuresOn)), { status: 200 });
			if (path.endsWith('/lists/manual_methods')) return new Response(JSON.stringify({ value: methods }), { status: 200 });
			if (path.endsWith('/connections')) {
				const connections = [{ name: 'storage', status: storage ? 'connected' : 'missing' }];
				return new Response(JSON.stringify({ connections }), { status: 200 });
			}
			return new Response(JSON.stringify({ status: 404, title: 'Not found' }), { status: 404 });
		}),
	);

/** A method paid first, with an account (rows given) and proof upload on or off. */
const transfer = (/** @type {Array<[string, string]>} */ rows, proof = false, instructions = '') => ({
	key: 'bank_transfer',
	name: 'Bank transfer',
	kind: 'pay_first',
	details: '',
	instructions,
	proof,
	accounts: [{ label: '', currency: '', rows: rows.map(([label, value]) => ({ label, value })) }],
});

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

/** @param {HTMLElement} container the text of the Ways to pay ready tile */
const gateways = (container) => byText(container, 'Ways to pay ready', 'span').parentElement?.parentElement?.textContent;

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

describe("Payments's dashboard Overview: manual payment methods (P1, P2)", () => {
	it('names the methods payers do not see yet, and counts them ready once payers are told how to pay', async () => {
		serve({
			featuresOn: ['manual_payments'],
			methods: [
				transfer([
					['Account holder', ''],
					['IBAN', ''],
				]),
				{ ...transfer([]), key: 'cod', name: 'Cash', kind: 'on_delivery' },
			],
		});
		const tab = props();
		let { container } = render(<Overview {...tab} />);
		await settle();
		const item = needs(container).find((li) =>
			li.textContent?.startsWith('Payers do not see some of your manual payment methods yet'),
		);
		expect(item?.textContent).toContain('instructions that tell payers how to pay, to: Bank transfer.');
		// cash on delivery is always ready
		expect(gateways(container)).toContain('Ways to pay ready1');
		click(byText(container, 'Open Settings', 'button'));
		expect(tab.open).toHaveBeenCalledWith('settings');
		for (const method of [transfer([['IBAN', 'DE89']]), transfer([], false, 'We send our details by email.')]) {
			cleanup();
			serve({ featuresOn: ['manual_payments'], methods: [method] });
			({ container } = render(<Overview {...props()} />));
			await settle();
			expect(needs(container).map((li) => li.textContent)).toEqual([expect.stringContaining('in grace until')]);
			expect(byText(container, 'Finish your manual payment methods', 'span').className).toContain('line-through');
			expect(gateways(container)).toContain('Ways to pay ready1');
		}
	});

	it('warns about Storage only while a method takes proofs and Storage is not connected', async () => {
		const warning = 'Payers cannot upload payment proofs yet';
		/** @type {Array<[boolean, boolean, boolean]>} proof on, storage connected, warned */
		const cases = [
			[false, false, false],
			[true, true, false],
			[true, false, true],
		];
		for (const [proof, storage, warned] of cases) {
			cleanup();
			serve({ featuresOn: ['manual_payments'], methods: [transfer([['IBAN', 'DE89']], proof)], storage });
			const tab = props();
			const { container } = render(<Overview {...tab} />);
			await settle();
			const item = needs(container).find((li) => li.textContent?.startsWith(warning));
			expect(Boolean(item)).toBe(warned);
			if (item) {
				expect(item.textContent).toContain('Proof upload is on for Bank transfer, but Storage is not connected');
				click(byText(container, 'Open Connections', 'button'));
				expect(tab.open).toHaveBeenCalledWith('connections');
			}
			// the connections are read only while a method takes proofs
			expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).endsWith('/connections'))).toBe(proof);
		}
	});

	it('reads no list while Manual payment methods is off', async () => {
		serve({ featuresOn: ['stripe'] });
		const { container } = render(<Overview {...props()} />);
		await settle();
		expect(vi.mocked(fetch).mock.calls.map(([path]) => String(path))).toEqual([
			`/v1/dashboard/websites/web_${website}/overview`,
		]);
		expect(container.textContent).not.toContain('Finish your manual payment methods');
	});
});
