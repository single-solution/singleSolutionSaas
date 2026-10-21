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
import { byLabel, byText, cleanup, click, render, type } from '@ss/ui/testing';
import manifest from '../manifest.json' with { type: 'json' };
import { TABS } from '../app/dashboard/tabs.js';
import { TEXTS } from '../app/dashboard/texts.js';
import { editorButton, editorOf, factsOf, openRow, openRowMenu, rowMenu, rowNames, rowOf } from './dashboard-rows.js';

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
		// the page is titled by its section; the greeting is the (i)'s text
		expect(container.querySelector('h1')?.textContent).toBe('Overview');
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="About this page"]')));
		expect(container.textContent).toContain('Welcome back, Merchant');
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

/**
 * The record lists of Settings: a faked list that answers every write with an empty list.
 * @param {string} name `fields` or `consents`
 * @param {unknown[]} items
 */
const serveList = (name, items) =>
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path, /** @type {RequestInit | undefined} */ init) =>
			path.endsWith(`/${name}`) && init?.method !== 'PUT'
				? new Response(JSON.stringify({ items }), { status: 200 })
				: new Response(JSON.stringify({ items: [] }), { status: 200 }),
		),
	);

/** @returns {Array<[string, RequestInit | undefined]>} the writes the page sent */
const writes = () =>
	vi
		.mocked(fetch)
		.mock.calls.filter(([, init]) => init?.method === 'PUT' || init?.method === 'DELETE')
		.map(([path, init]) => [String(path), init]);

describe('Settings → Custom fields (A6)', () => {
	const F = TEXTS.settings.field;
	const field = (/** @type {string} */ key, /** @type {string} */ visibility, extra = {}) => ({
		key,
		label: key.toUpperCase(),
		type: 'boolean',
		options: [],
		required: false,
		visibility,
		help: '',
		...extra,
	});
	/** The section on a faked list of fields. @param {unknown[]} items */
	const open = async (items) => {
		const { FieldsSection } = await import('../app/dashboard/fields.js');
		serveList('fields', items);
		const view = render(
			<DashboardProvider manifest={manifest} texts={TEXTS}>
				<FieldsSection websiteId={`web_${(website += 1)}`} />
			</DashboardProvider>,
		);
		return view;
	};

	it('shows skeleton rows while the fields load', async () => {
		const view = await open([]);
		expect(view.container.querySelector('[role="status"][aria-busy]')).not.toBeNull();
		await settle();
		expect(view.container.querySelector('[role="status"][aria-busy]')).toBeNull();
		expect(view.container.textContent).toContain(TEXTS.settings.field.none);
	});

	it('lists the fields as rows with their type, who sees them, the key and a Required dot', async () => {
		const { container } = await open([field('first', 'edit', { required: true }), field('second', 'staff')]);
		await settle();
		expect(rowNames(container)).toEqual(['FIRST', 'SECOND']);
		expect(factsOf(rowOf(container, 'FIRST'))).toEqual({
			meta: `${TEXTS.settings.fieldTypes.boolean} · ${TEXTS.settings.fieldVisibility.edit}`,
			value: 'first',
			status: F.required_badge,
		});
		expect(factsOf(rowOf(container, 'SECOND'))).toEqual({
			meta: `${TEXTS.settings.fieldTypes.boolean} · ${TEXTS.settings.fieldVisibility.staff}`,
			value: 'second',
			status: '',
		});
	});

	it("says there are no fields yet with the one Add action, and an unconnected database's way out", async () => {
		const { container } = await open([]);
		await settle();
		expect(container.textContent).toContain(F.none);
		expect(container.querySelectorAll('button')).toHaveLength(1);
		expect(byText(container, F.add, 'button')).toBeDefined();
		cleanup();
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(JSON.stringify({ status: 409, type: 'urn:problem:database_not_connected' }), { status: 409 }),
			),
		);
		const { FieldsSection } = await import('../app/dashboard/fields.js');
		const closed = render(
			<DashboardProvider manifest={manifest} texts={TEXTS}>
				<FieldsSection websiteId={`web_${(website += 1)}`} />
			</DashboardProvider>,
		);
		await settle();
		expect(closed.container.textContent).toContain(F.needsDatabase);
	});

	it("moves a field in the row's menu: the first cannot go up, and the new order is saved", async () => {
		const { container } = await open([field('first', 'edit'), field('second', 'staff')]);
		await settle();
		const items = await openRowMenu(container, 'FIRST');
		expect(items.map((item) => item.textContent)).toEqual([F.up, F.down, F.delete]);
		expect(items[0]?.disabled).toBe(true);
		await act(async () => click(/** @type {HTMLElement} */ (items[1])));
		await settle();
		const [put] = writes();
		expect(put?.[0]).toMatch(/\/fields$/);
		expect(put?.[1]?.method).toBe('PUT');
		expect(JSON.parse(String(put?.[1]?.body))).toEqual({ order: ['second', 'first'] });
	});

	it("deletes a field with the row's menu", async () => {
		const { container } = await open([field('first', 'edit'), field('second', 'staff')]);
		await settle();
		await rowMenu(container, 'SECOND', F.delete);
		await settle();
		expect(writes().map(([path, init]) => [init?.method, path.replace(/^.*\/fields/, '/fields')])).toEqual([
			['DELETE', '/fields/second'],
		]);
	});

	it('opens a field in place under its row on a click, saves it by itself and closes', async () => {
		const { container } = await open([field('first', 'edit', { help: 'Old help' }), field('second', 'staff')]);
		await settle();
		const form = await openRow(container, 'FIRST');
		// the editor sits right under the row it edits
		expect(rowOf(container, 'FIRST').nextElementSibling).toBe(form);
		expect(form.getAttribute('aria-label')).toBe(F.editTitle);
		// the key of a saved field cannot change
		expect(byLabel(form, F.key).disabled).toBe(true);
		expect(byLabel(form, F.key).value).toBe('first');
		await type(byLabel(form, F.label), '  Company  ');
		await type(byLabel(form, F.help), 'New help');
		await click(editorButton(container, TEXTS.save));
		await settle();
		const [put] = writes();
		expect(put?.[0]).toMatch(/\/fields\/first$/);
		expect(JSON.parse(String(put?.[1]?.body))).toEqual({
			label: 'Company',
			type: 'boolean',
			options: [],
			required: false,
			visibility: 'edit',
			help: 'New help',
		});
		expect(editorOf(container)).toBeNull();
	});

	it('Cancel and a second click on the row close the editor and nothing is sent', async () => {
		const { container } = await open([field('first', 'edit')]);
		await settle();
		await openRow(container, 'FIRST');
		await click(editorButton(container, TEXTS.cancel));
		await settle();
		expect(editorOf(container)).toBeNull();
		expect(writes()).toEqual([]);
		await openRow(container, 'FIRST');
		await openRow(container, 'FIRST');
		expect(editorOf(container)).toBeNull();
	});

	it('adds a new field at the top: Save waits for a key and a label, and choices take their options', async () => {
		const { container } = await open([]);
		await settle();
		await click(byText(container, F.add, 'button'));
		const form = editorOf(container);
		expect(editorButton(container, TEXTS.save).disabled).toBe(true);
		await type(byLabel(form, F.key), 'size');
		await type(byLabel(form, F.label), 'Size');
		expect(editorButton(container, TEXTS.save).disabled).toBe(false);
		await type(byLabel(form, F.type), 'choice');
		await type(byLabel(form, F.options), 'S, M\nL');
		await click(editorButton(container, TEXTS.save));
		await settle();
		const [put] = writes();
		expect(put?.[0]).toMatch(/\/fields\/size$/);
		expect(JSON.parse(String(put?.[1]?.body))).toMatchObject({ label: 'Size', type: 'choice', options: ['S', 'M', 'L'] });
	});
});

describe('Settings → Consents (A2)', () => {
	const C = TEXTS.settings.consent;
	const consent = (/** @type {string} */ key, /** @type {'agreement' | 'marketing'} */ purpose) => ({
		key,
		label: key.toUpperCase(),
		url: '',
		version: '1',
		required: purpose === 'agreement',
		purpose,
	});
	/** The section on a faked list of consents. @param {unknown[]} items */
	const open = async (items) => {
		const { ConsentsSection } = await import('../app/dashboard/consents.js');
		serveList('consents', items);
		return render(
			<DashboardProvider manifest={manifest} texts={TEXTS}>
				<ConsentsSection websiteId={`web_${(website += 1)}`} />
			</DashboardProvider>,
		);
	};

	it('lists the consents as rows with their purpose, key, version and a Required dot', async () => {
		const { container } = await open([consent('terms', 'agreement'), consent('news', 'marketing')]);
		expect(container.querySelector('[role="status"][aria-busy]')).not.toBeNull();
		await settle();
		expect(rowNames(container)).toEqual(['TERMS', 'NEWS']);
		expect(factsOf(rowOf(container, 'TERMS'))).toEqual({
			meta: `${TEXTS.settings.consentPurposes.agreement} · terms`,
			value: `${C.columns.version} 1`,
			status: C.required_badge,
		});
		expect(factsOf(rowOf(container, 'NEWS'))).toEqual({
			meta: `${TEXTS.settings.consentPurposes.marketing} · news`,
			value: `${C.columns.version} 1`,
			status: '',
		});
	});

	it('says there are no consents yet with the one Add action', async () => {
		const { container } = await open([]);
		await settle();
		expect(container.textContent).toContain(C.none);
		expect(container.querySelectorAll('button')).toHaveLength(1);
		expect(byText(container, C.add, 'button')).toBeDefined();
	});

	it("moves a consent in the row's menu and saves the new order", async () => {
		const { container } = await open([consent('terms', 'agreement'), consent('news', 'marketing')]);
		await settle();
		await rowMenu(container, 'TERMS', C.down);
		await settle();
		const [put] = writes();
		expect(put?.[0]).toMatch(/\/consents$/);
		expect(JSON.parse(String(put?.[1]?.body))).toEqual({ order: ['news', 'terms'] });
	});

	it("deletes a consent with the row's menu", async () => {
		const { container } = await open([consent('terms', 'agreement')]);
		await settle();
		await rowMenu(container, 'TERMS', C.delete);
		await settle();
		const [call] = writes();
		expect(call?.[1]?.method).toBe('DELETE');
		expect(call?.[0]).toMatch(/\/consents\/terms$/);
	});

	it('opens a consent in place, and a marketing one is never required', async () => {
		const { container } = await open([consent('terms', 'agreement')]);
		await settle();
		const form = await openRow(container, 'TERMS');
		expect(form.getAttribute('aria-label')).toBe(C.editTitle);
		expect(byLabel(form, C.key).disabled).toBe(true);
		expect(byLabel(form, C.required).checked).toBe(true);
		await type(byLabel(form, C.url), 'https://shop.example.com/terms');
		await type(byLabel(form, C.purpose), 'marketing');
		// a marketing consent has no Required box, and is saved as not required
		expect(() => byLabel(form, C.required)).toThrow();
		await click(editorButton(container, TEXTS.save));
		await settle();
		const [put] = writes();
		expect(put?.[0]).toMatch(/\/consents\/terms$/);
		expect(JSON.parse(String(put?.[1]?.body))).toEqual({
			label: 'TERMS',
			url: 'https://shop.example.com/terms',
			version: '1',
			required: false,
			purpose: 'marketing',
		});
		expect(editorOf(container)).toBeNull();
	});

	it('Cancel closes the editor and nothing is sent; a new consent needs a key, words and a version', async () => {
		const { container } = await open([consent('terms', 'agreement')]);
		await settle();
		await openRow(container, 'TERMS');
		await click(editorButton(container, TEXTS.cancel));
		await settle();
		expect(editorOf(container)).toBeNull();
		expect(writes()).toEqual([]);
		await click(byText(container, C.add, 'button'));
		expect(editorButton(container, TEXTS.save).disabled).toBe(true);
		await type(byLabel(editorOf(container), C.key), 'privacy');
		await type(byLabel(editorOf(container), C.label), 'Privacy policy');
		expect(editorButton(container, TEXTS.save).disabled).toBe(false);
	});
});
