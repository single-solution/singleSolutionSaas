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
import { DashboardProvider } from '@ss/ui/dashboard';
import { byText, cleanup, click, render } from '@ss/ui/testing';
import manifest from '../manifest.json' with { type: 'json' };
import { TABS } from '../app/dashboard/tabs.js';
import { TEXTS } from '../app/dashboard/texts.js';

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
	domain: 'shop.example.com',
	who: /** @type {const} */ ({ kind: 'merchant', id: 'm_1', name: 'Merchant' }),
	support: { channels: [{ type: /** @type {const} */ ('email'), label: 'Email', url: 'mailto:help@example.com' }] },
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

/**
 * Accounts' Overview inside the dashboard's words and feature names, as the dashboard page renders it.
 * @param {ReturnType<typeof props>} tab
 */
const overviewOf = (tab) => (
	<DashboardProvider manifest={manifest} texts={TEXTS}>
		<TABS.overview {...tab} />
	</DashboardProvider>
);

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("Accounts's dashboard Overview", () => {
	it('with Custom fields on and no field yet, asks for one and opens Settings', async () => {
		serve({ featuresOn: ['email_password', 'custom_fields'] });
		const tab = props();
		const { container } = render(overviewOf(tab));
		await settle();
		expect(container.querySelector('h1')?.textContent).toBe('Welcome back, Merchant');
		expect(needs(container)).toContain('Custom fields is on, but no field is set up yet');
		click(byText(container, 'Add a field', 'button'));
		// the setup step says why and has its own button to the same section
		const row = /** @type {HTMLElement} */ (byText(container, 'Add a custom field', 'span').closest('li'));
		expect(row.textContent).toContain('Sign-up and My account ask for nothing more until a field is added.');
		click(byText(row, 'Add a field', 'button'));
		expect(tab.open.mock.calls).toEqual([
			['settings', 'custom_fields'],
			['settings', 'custom_fields'],
		]);
		expect(tile(container, 'Custom fields')).toBe('Custom fields0');
	});

	it('counts the fields once there are some; without the database it says to connect it first', async () => {
		serve({ featuresOn: ['custom_fields'], fields: [{ key: 'company' }, { key: 'size' }] });
		const first = render(overviewOf(props()));
		await settle();
		expect(needs(first.container)).not.toContain('Custom fields is on, but no field is set up yet');
		expect(byText(first.container, 'Add a custom field', 'span').className).toContain('line-through');
		cleanup();
		serve({ featuresOn: ['custom_fields'], fields: null });
		const second = render(overviewOf(props()));
		await settle();
		expect(second.container.textContent).toContain('Connect the database first');
		expect(second.container.textContent).not.toContain('Add a custom field');
	});

	it('reads no custom fields while the feature is off', async () => {
		serve({ featuresOn: ['email_password'] });
		const { container } = render(overviewOf(props()));
		await settle();
		expect(reads()).toEqual([`/v1/dashboard/websites/web_${website}/overview`]);
		expect(container.textContent).not.toContain('Custom fields');
	});

	it("shows the grace end, the widget's last visit and the changes in the viewer's time zone, UTC on hover", async () => {
		viewerIn('America/New_York');
		serve();
		const { container } = render(overviewOf(props()));
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
		const tokyo = render(overviewOf(props()));
		await settle();
		expect(tokyo.container.textContent).toContain('Last seen Oct 6, 2026, 8:15 AM GMT+9');
	});

	it('the server and the first render in the browser print UTC', async () => {
		viewerIn('America/New_York');
		serve();
		render(overviewOf(props()));
		await settle();
		// the answer this page already loaded shows at once, as the server would print it
		const html = renderToString(overviewOf(props(true)));
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

/** An item of the open More menu. @param {string} label */
const menuItem = (label) =>
	/** @type {HTMLButtonElement} */ (
		[...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === label)
	);

describe('Settings → Custom fields (A6)', () => {
	it('lists the fields with their type and who sees them, and saves a new order', async () => {
		const { FieldsSection } = await import('../app/dashboard/fields.js');
		const field = (/** @type {string} */ key, /** @type {string} */ visibility) => ({
			key,
			label: key.toUpperCase(),
			type: 'boolean',
			options: [],
			required: false,
			visibility,
			help: '',
		});
		serve({ featuresOn: ['custom_fields'], fields: [field('first', 'edit'), field('second', 'staff')] });
		const { container } = render(
			<DashboardProvider manifest={manifest} texts={TEXTS}>
				<FieldsSection websiteId={`web_${(website += 1)}`} />
			</DashboardProvider>,
		);
		await settle();
		expect(container.textContent).toContain(TEXTS.settings.fieldTypes.boolean);
		expect(container.textContent).toContain(TEXTS.settings.fieldVisibility.staff);
		// the row's own actions are in its More menu: the first field cannot go up
		click(
			/** @type {HTMLButtonElement} */ (container.querySelector(`button[aria-label="${TEXTS.settings.field.more}: FIRST"]`)),
		);
		expect(menuItem(TEXTS.settings.field.up).disabled).toBe(true);
		click(menuItem(TEXTS.settings.field.down));
		await settle();
		const put = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PUT');
		expect(String(put?.[0])).toMatch(/\/fields$/);
		expect(JSON.parse(String(put?.[1]?.body))).toEqual({ order: ['second', 'first'] });
	});
});

describe('Settings → Consents (A2)', () => {
	it('lists the consents with their purpose, and saves a new order', async () => {
		const { ConsentsSection } = await import('../app/dashboard/consents.js');
		const consent = (/** @type {string} */ key, /** @type {'agreement' | 'marketing'} */ purpose) => ({
			key,
			label: key.toUpperCase(),
			url: '',
			version: '1',
			required: purpose === 'agreement',
			purpose,
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (/** @type {string} */ path, /** @type {RequestInit | undefined} */ init) =>
				path.endsWith('/consents') && init?.method !== 'PUT'
					? new Response(JSON.stringify({ items: [consent('terms', 'agreement'), consent('news', 'marketing')] }), {
							status: 200,
						})
					: new Response(JSON.stringify({ items: [] }), { status: 200 }),
			),
		);
		const { container } = render(
			<DashboardProvider manifest={manifest} texts={TEXTS}>
				<ConsentsSection websiteId={`web_${(website += 1)}`} />
			</DashboardProvider>,
		);
		await settle();
		expect(container.textContent).toContain(TEXTS.settings.consentPurposes.marketing);
		expect(container.textContent).toContain(TEXTS.settings.consent.required_badge);
		click(
			/** @type {HTMLButtonElement} */ (container.querySelector(`button[aria-label="${TEXTS.settings.consent.more}: TERMS"]`)),
		);
		click(menuItem(TEXTS.settings.consent.down));
		await settle();
		const put = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PUT');
		expect(String(put?.[0])).toMatch(/\/consents$/);
		expect(JSON.parse(String(put?.[1]?.body))).toEqual({ order: ['news', 'terms'] });
	});
});
