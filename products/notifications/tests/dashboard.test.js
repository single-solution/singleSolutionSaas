// @vitest-environment jsdom
/**
 * Settings → Templates in the browser (jsdom), on a faked dashboard API (parity P1): every product's message by
 * channel with its state — the product's default words, the merchant's edited version, switched off, or WhatsApp not set
 * up — and Edit (from the default words), Reset to default and Switch off, never for Accounts' sign-in messages. The
 * Overview (PLAN 0.6 "Overviews talk"): the templates counted, a webhook URL asked for while Outgoing webhooks is on
 * without one (the list is read only then), and times computed in UTC and shown in the viewer's local time (owner
 * 2026-10-14): UTC on the server and in the first render.
 */
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardProvider } from '@ss/ui/dashboard';
import { fill } from '@ss/ui/dashboard';
import { byLabel, byText, cleanup, click, render, type } from '@ss/ui/testing';
import manifest from '../manifest.json' with { type: 'json' };
import { TABS } from '../app/dashboard/tabs.js';
import { TemplatesSection } from '../app/dashboard/templates.js';
import { TEXTS } from '../app/dashboard/texts.js';
import { drawerButton, drawerOf, factsOf, openMenuOf, openRow, rowMenu, rowNames, rowOf, rowsOf } from './dashboard-rows.js';

const WEBSITE = 'web_1';
const BASE = `/v1/dashboard/websites/${WEBSITE}`;
const T = TEXTS.settings.template;

/** The products' messages as `GET …/messages` answers them. */
const CATALOG = {
	items: [
		{
			productId: 'accounts',
			key: 'accounts.password_reset',
			name: 'Password reset link',
			values: ['link', 'minutes', 'business'],
			required: true,
			urgent: true,
			sensitive: true,
			channels: { email: { subject: 'Reset your password for {business}', text: 'Choose a new password: {link}' } },
		},
		{
			productId: 'chat',
			key: 'chat.staff_new_message',
			name: 'New chat message',
			values: ['visitor', 'preview', 'link', 'business'],
			required: true,
			channels: {
				email: { subject: 'New chat message from {visitor}', text: '{visitor}: {preview}' },
				sms: { text: 'New chat from {visitor}: {preview}' },
				whatsapp: null,
			},
		},
	],
	off: [{ key: 'chat.staff_new_message', channel: 'sms' }],
	// the other products of the Portal's directory with their names, a product made later included
	products: [
		{ productId: 'accounts', name: 'Accounts' },
		{ productId: 'bookings', name: 'Bookings' },
		{ productId: 'chat', name: 'Chat' },
		{ productId: 'ecommerce', name: 'Ecommerce' },
	],
	unavailable: ['bookings', 'ecommerce'],
};
/** The merchant's own templates: an edited Chat alert and a key of their own. */
const TEMPLATES = {
	items: [
		{
			key: 'chat.staff_new_message',
			channel: 'email',
			language: 'default',
			subject: 'Chat: {visitor}',
			text: 'Reply soon: {preview}',
			required: true,
			urgent: false,
			sensitive: false,
			providerTemplate: '',
			buttons: [],
		},
		{
			key: 'welcome',
			channel: 'sms',
			language: 'default',
			subject: '',
			text: 'Welcome!',
			required: false,
			urgent: false,
			sensitive: false,
			providerTemplate: '',
			buttons: [],
		},
	],
};

/** @type {Array<{ path: string, method: string, body: unknown }>} */
let calls = [];
/** @param {{ items: object[], off: object[], products: object[], unavailable: string[] }} [catalog] @param {{ items: object[] }} [templates] */
const serve = (catalog = CATALOG, templates = TEMPLATES) => {
	calls = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
			calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
			const body = path === `${BASE}/messages` ? catalog : path === `${BASE}/templates` ? templates : {};
			return new Response(init.method === 'DELETE' ? null : JSON.stringify(body), {
				status: init.method === 'DELETE' ? 204 : 200,
				headers: { 'content-type': 'application/json' },
			});
		}),
	);
};
const settle = async () => {
	for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** The writes the page sent. */
const writes = () => calls.filter((call) => call.method !== 'GET');

describe('Settings → Templates: the products’ messages (parity P1)', () => {
	it('shows skeleton rows while the templates load', async () => {
		serve();
		const { container } = render(<TemplatesSection websiteId={WEBSITE} />);
		expect(container.querySelector('[role="status"][aria-busy]')).not.toBeNull();
		await settle();
		expect(container.querySelector('[role="status"][aria-busy]')).toBeNull();
		expect(rowsOf(container)).toHaveLength(5);
	});

	it('an empty list is an empty state with the one Add action, which opens a blank template', async () => {
		serve({ items: [], off: [], products: [], unavailable: [] }, { items: [] });
		const { container } = render(<TemplatesSection websiteId={WEBSITE} />);
		await settle();
		expect(rowsOf(container)).toHaveLength(0);
		expect(container.textContent).toContain(T.none);
		expect(container.querySelectorAll('button')).toHaveLength(1);
		await click(byText(container, T.add, 'button'));
		expect(byLabel(drawerOf(), T.key).value).toBe('');
	});

	it('lists each message by channel with its state, then the other templates', async () => {
		serve();
		const { container } = render(<TemplatesSection websiteId={WEBSITE} />);
		await settle();
		expect(rowNames(container)).toEqual([
			'Password reset link',
			'New chat message',
			'New chat message',
			'New chat message',
			'welcome',
		]);
		const rows = rowsOf(container).map(factsOf);
		// the line of facts: channel, product (by the name the directory gives), flags, then the key and the words
		expect(rows[0]).toEqual({
			meta: `Email · Accounts · ${T.required_badge} · ${T.urgent_badge} · ${T.sensitive_badge} · accounts.password_reset · Reset your password for {business}`,
			value: T.default,
			status: T.states.default,
		});
		expect(rows[1]).toEqual({
			meta: `Email · Chat · ${T.required_badge} · chat.staff_new_message · Chat: {visitor}`,
			value: T.default,
			status: T.states.edited,
		});
		expect(rows[2]?.status).toBe(T.states.off);
		expect(rows[3]?.status).toBe(T.states.not_set_up);
		expect(rows[3]?.meta).toContain(T.notSetUpHelp);
		expect(rows[4]).toEqual({ meta: `SMS · ${T.own} · Welcome!`, value: T.default, status: '' });
		expect(container.textContent).toContain(T.unavailable.replace('{products}', 'Bookings, Ecommerce'));
	});

	it('a click on a row opens it in a drawer, from the default words; the key and channel of a product’s message stay fixed', async () => {
		serve();
		const { container } = render(<TemplatesSection websiteId={WEBSITE} />);
		await settle();
		const dialog = await openRow(container, 'Password reset link');
		expect(dialog.textContent).toContain('Password reset link');
		expect(dialog.textContent).toContain('Template accounts.password_reset by Email, in the default language.');
		expect(dialog.textContent).toContain('Values it can use: {link}, {minutes}, {business}.');
		expect(/** @type {HTMLTextAreaElement} */ (dialog.querySelector('textarea')).value).toBe('Choose a new password: {link}');
		expect(dialog.querySelector('select')).toBeNull();
	});

	it('names a message’s long values, and takes a long sample for them in the preview', async () => {
		serve({
			...CATALOG,
			items: [
				{
					productId: 'chat',
					key: 'chat.transcript',
					name: 'Chat transcript',
					values: ['transcript', 'date', 'business'],
					longValues: ['transcript'],
					required: true,
					channels: { email: { subject: 'Your chat with {business}', text: 'Your chat from {date}:\n\n{transcript}' } },
				},
			],
			off: [],
		});
		const { container } = render(<TemplatesSection websiteId={WEBSITE} />);
		await settle();
		const dialog = await openRow(container, 'Chat transcript');
		expect(dialog.textContent).toContain(T.longValuesHelp.replace('{values}', '{transcript}'));
		// the long value's sample is a text box of up to 50,000 characters; the others stay one line of 1,000
		const sample = /** @type {HTMLTextAreaElement} */ (
			[...dialog.querySelectorAll('textarea')].find((box) => box.labels?.[0]?.textContent?.includes('transcript'))
		);
		expect(sample.maxLength).toBe(50_000);
		const date = /** @type {HTMLInputElement} */ (
			[...dialog.querySelectorAll('input')].find((box) => box.labels?.[0]?.textContent === 'date')
		);
		expect(date.maxLength).toBe(1000);
	});

	it('the row menu: Edit first, then what the row can do; nothing more for Accounts’ sign-in messages', async () => {
		serve();
		const { container } = render(<TemplatesSection websiteId={WEBSITE} />);
		await settle();
		/** The labels of the open menu of the row at `at`, which stays open. @param {number} at */
		const menuAt = async (at) => openMenuOf(/** @type {HTMLElement} */ (rowsOf(container)[at]));
		const labels = (/** @type {HTMLButtonElement[]} */ items) => items.map((item) => item.textContent);
		// Accounts' reset link can neither be switched off nor has an edited version: only Edit
		expect(labels(await menuAt(0))).toEqual([T.edit]);
		await act(async () => click(/** @type {HTMLElement} */ (container.querySelector('[data-ss-row] button[aria-haspopup]'))));
		// an edited message: Reset to default and Switch off
		const edited = await menuAt(1);
		expect(labels(edited)).toEqual([T.edit, T.reset, T.switchOff]);
		await act(async () => click(/** @type {HTMLElement} */ (edited[2])));
		await settle();
		expect(calls.find((call) => call.method === 'PUT')).toEqual({
			path: `${BASE}/messages/chat.staff_new_message/email`,
			method: 'PUT',
			body: { off: true },
		});
	});

	it('the menu of a switched-off message offers Switch on again, a not set up one Set up, and a template of your own Duplicate and Delete', async () => {
		serve();
		const { container } = render(<TemplatesSection websiteId={WEBSITE} />);
		await settle();
		/** @param {number} at */
		const menuAt = async (at) => {
			const row = /** @type {HTMLElement} */ (rowsOf(container)[at]);
			await act(async () => click(/** @type {HTMLElement} */ (row.querySelector('button[aria-haspopup]'))));
			const labels = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
			await act(async () => click(/** @type {HTMLElement} */ (row.querySelector('button[aria-haspopup]'))));
			return labels;
		};
		expect(await menuAt(2)).toEqual([T.edit, T.switchOn]);
		expect(await menuAt(3)).toEqual([T.setUp, T.switchOff]);
		expect(await menuAt(4)).toEqual([T.edit, T.duplicate, T.delete]);
	});

	it('saves a template of your own from the drawer, which closes; Cancel sends nothing', async () => {
		serve();
		const { container } = render(<TemplatesSection websiteId={WEBSITE} />);
		await settle();
		const dialog = await openRow(container, 'welcome');
		expect(byLabel(dialog, T.key).value).toBe('welcome');
		await type(byLabel(dialog, T.text), 'Welcome aboard!');
		await click(drawerButton(TEXTS.cancel));
		await settle();
		expect(drawerOf()).toBeNull();
		expect(writes()).toEqual([]);
		await openRow(container, 'welcome');
		await type(byLabel(drawerOf(), T.text), 'Welcome aboard!');
		await click(drawerButton(TEXTS.save));
		await settle();
		expect(writes()).toEqual([
			{
				path: `${BASE}/templates`,
				method: 'PUT',
				body: {
					key: 'welcome',
					channel: 'sms',
					language: 'default',
					subject: '',
					text: 'Welcome aboard!',
					required: false,
					urgent: false,
					sensitive: false,
					providerTemplate: '',
					buttons: [],
				},
			},
		]);
		expect(drawerOf()).toBeNull();
	});

	it('Delete asks first in a small dialog, then removes the template', async () => {
		serve();
		const { container } = render(<TemplatesSection websiteId={WEBSITE} />);
		await settle();
		await rowMenu(container, 'welcome', T.delete);
		await settle();
		expect(document.body.textContent).toContain(T.deleteTitle);
		expect(writes()).toEqual([]);
		await click(byText(document.body, T.delete, '[role="dialog"] button'));
		await settle();
		expect(writes().map((call) => [call.method, call.path])).toEqual([['DELETE', `${BASE}/templates/welcome/sms/default`]]);
	});

	it('the search and the Channel and Product filters narrow the rows', async () => {
		serve();
		const { container } = render(<TemplatesSection websiteId={WEBSITE} />);
		await settle();
		await type(/** @type {HTMLInputElement} */ (container.querySelector('input[type="search"], input')), 'welcome');
		await settle();
		expect(rowNames(container)).toEqual(['welcome']);
		await type(/** @type {HTMLInputElement} */ (container.querySelector('input[type="search"], input')), 'zzz');
		await settle();
		expect(container.textContent).toContain(T.noMatch);
		await type(/** @type {HTMLInputElement} */ (container.querySelector('input[type="search"], input')), '');
		await settle();
		// the Channel filter: SMS has two rows
		const chooseFilter = async (/** @type {string} */ filter, /** @type {string} */ option) => {
			const trigger = /** @type {HTMLElement} */ (container.querySelector(`button[aria-label="${filter}"]`));
			await act(async () => click(trigger));
			const entry = [...document.querySelectorAll('[role^="menuitem"]')].find((one) => one.textContent === option);
			await act(async () => click(/** @type {HTMLElement} */ (entry)));
		};
		await chooseFilter(T.channel, fill(T.channelCount, { channel: 'SMS', count: 2 }));
		expect(rowNames(container)).toEqual(['New chat message', 'welcome']);
		await chooseFilter(T.columns.product, T.own);
		expect(rowNames(container)).toEqual(['welcome']);
	});
});

describe('Overview (PLAN 0.6 "Overviews talk")', () => {
	/** The dashboard keeps each answer it loaded for the page: each test opens its own website. */
	let website = 0;
	/**
	 * The overview answer: a grace period, the widget's last visit and a change, at known instants (UTC).
	 * @param {string[]} featuresOn
	 */
	const overview = (featuresOn) => ({
		website: { websiteId: `web_o${website}`, domain: 'shop.example.com', merchantId: 'm_1', merchantName: 'Merchant' },
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
	 * The overview, the merchant's templates and the webhook URLs.
	 * @param {{ featuresOn?: string[], urls?: string[] }} [options]
	 */
	const serveOverview = ({ featuresOn = [], urls = [] } = {}) =>
		vi.stubGlobal(
			'fetch',
			vi.fn(async (/** @type {string} */ path) => {
				const body = path.endsWith('/overview')
					? overview(featuresOn)
					: path.endsWith('/templates')
						? TEMPLATES
						: path.endsWith('/lists/webhook_urls')
							? { value: urls }
							: null;
				return body
					? new Response(JSON.stringify(body), { status: 200 })
					: new Response(JSON.stringify({ status: 404, title: 'Not found' }), { status: 404 });
			}),
		);
	/** @param {string} timeZone the viewer's browser's */
	const viewerIn = (timeZone) => {
		const real = Intl.DateTimeFormat.prototype.resolvedOptions;
		vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(
			/** @this {Intl.DateTimeFormat} */
			function () {
				return { ...real.call(this), timeZone };
			},
		);
	};
	/** The tab's props for a new website (or the last one's with `same`). */
	const props = (same = false) => ({
		websiteId: `web_o${same ? website : (website += 1)}`,
		merchantId: 'm_1',
		domain: 'shop.example.com',
		who: /** @type {const} */ ({ kind: 'merchant', id: 'm_1', name: 'Merchant' }),
		support: { channels: [{ type: /** @type {const} */ ('email'), label: 'Email', url: 'mailto:help@example.com' }] },
		portal: 'https://portal.example.com',
		open: vi.fn(),
	});
	/**
	 * Notifications' Overview inside the dashboard's words and feature names, as the dashboard page renders it.
	 * @param {ReturnType<typeof props>} tab
	 */
	const overviewOf = (tab) => (
		<DashboardProvider manifest={manifest} texts={TEXTS}>
			<TABS.overview {...tab} />
		</DashboardProvider>
	);
	/** @param {HTMLElement} container the titles of the "Needs you" items */
	const needs = (container) =>
		[...container.querySelectorAll('section[aria-label="Needs you"] li p:first-child')].map((p) => p.textContent);

	it('Developers lists the template keys as rows with their channels', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (/** @type {string} */ path) => {
				const body = path.endsWith('/templates')
					? TEMPLATES
					: path.endsWith('/features')
						? { features: [] }
						: path.endsWith('/connections')
							? { connections: [] }
							: {};
				return new Response(JSON.stringify(body), { status: 200 });
			}),
		);
		const { container } = render(
			<DashboardProvider manifest={manifest} texts={TEXTS}>
				<TABS.developers {...props()} />
			</DashboardProvider>,
		);
		await settle();
		// the view is picked in the list beside the page
		await act(async () => click(rowOf(container, TEXTS.developers.keys)));
		await settle();
		const keys = rowsOf(container).filter((row) => row.textContent?.includes(TEXTS.developers.keyColumns.channels));
		expect(keys.map((row) => factsOf(row).meta)).toEqual([
			`${TEXTS.developers.keyColumns.channels}: Email`,
			`${TEXTS.developers.keyColumns.channels}: SMS`,
		]);
		expect(keys.map((row) => row.querySelector('span.truncate')?.textContent)).toEqual(['chat.staff_new_message', 'welcome']);
	});

	it('counts the templates; with Outgoing webhooks on and no address, asks for one and opens its section of Settings', async () => {
		serveOverview({ featuresOn: ['email', 'webhooks'] });
		const tab = props();
		const { container } = render(overviewOf(tab));
		await settle();
		// the page is titled by its section; the greeting is the (i)'s text
		expect(container.querySelector('h1')?.textContent).toBe('Overview');
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="About this page"]')));
		expect(container.textContent).toContain('Welcome back, Merchant');
		expect(needs(container)).toContain('Outgoing webhooks is on, but no address is added yet');
		click(byText(container, 'Add an address', 'button'));
		expect(container.textContent).toContain(
			'Outgoing webhooks send nothing until at least one address on your server is added.',
		);
		click(byText(container, 'Add address', 'button'));
		expect(tab.open.mock.calls).toEqual([
			['settings', 'webhooks'],
			['settings', 'webhooks'],
		]);
		expect(byText(container, 'Templates', 'span').parentElement?.parentElement?.textContent).toBe('Templates2');
	});

	it('reads no webhook addresses while the feature is off, and asks for none once one is added', async () => {
		serveOverview({ featuresOn: ['email'] });
		render(overviewOf(props()));
		await settle();
		expect(vi.mocked(fetch).mock.calls.map(([path]) => String(path))).not.toContain(
			`/v1/dashboard/websites/web_o${website}/lists/webhook_urls`,
		);
		cleanup();
		serveOverview({ featuresOn: ['webhooks'], urls: ['https://hooks.example.com/ss'] });
		const added = render(overviewOf(props()));
		await settle();
		expect(needs(added.container)).not.toContain('Outgoing webhooks is on, but no address is added yet');
		expect(byText(added.container, 'Add a webhook address', 'span').className).toContain('line-through');
	});

	it("shows the grace end, the widget's last visit and the changes in the viewer's zone; UTC first", async () => {
		viewerIn('America/New_York');
		serveOverview();
		const { container } = render(overviewOf(props()));
		await settle();
		const text = container.textContent ?? '';
		expect(text).toContain('Notifications is in grace until Oct 4, 2026, 10:30 AM EDT');
		expect(text).toContain('Last seen Oct 5, 2026, 7:15 PM EDT');
		const change = container.querySelector('ol time');
		expect([change?.textContent, change?.getAttribute('title'), change?.getAttribute('datetime')]).toEqual([
			'Oct 6, 2026, 4:00 AM EDT',
			'Oct 6, 2026, 8:00 AM UTC',
			'2026-10-06T08:00:00.000Z',
		]);
		// the server (and the first render in the browser) print UTC, with the answer this page already loaded
		const html = renderToString(overviewOf(props(true)));
		for (const words of ['Oct 4, 2026, 2:30 PM UTC', 'Oct 5, 2026, 11:15 PM UTC', '>Oct 6, 2026, 8:00 AM UTC</time>'])
			expect(html).toContain(words);
		expect(html).not.toContain('EDT');
	});
});
