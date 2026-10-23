// @vitest-environment jsdom
/**
 * `@ss/ui/dashboard`, the product dashboard every product shares: the dashboard API helpers, the product's words over
 * the shared ones, the shared pieces (loading, outcome, settings and texts forms, Re-seal), the standard
 * tabs with the product's own parts, and the whole page (session, sidebar for merchants and Owners, website switch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DashboardProvider,
	DefaultsTab,
	DevelopersTab,
	Loaded,
	OverviewTab,
	Outcome,
	PricesTab,
	ProductDashboard,
	ResealCard,
	SectionsPage,
	SettingsForms,
	SettingsTab,
	TextsTab,
	call,
	fill,
	hasSettings,
	toneOf,
	useDashboard,
	useLoad,
	withDependents,
} from '../src/dashboard.js';
import { DASHBOARD_TEXTS, dashboardTexts, formatCredits, useDisplayLocale } from '../src/index.js';
import { describeProblem } from '../src/problems.js';
import { act, allByRole, byLabel, byText, cleanup, click, render, type } from '../src/testing.js';

/** @typedef {import('../src/dashboard.js').TabProps} TabProps */
/** @typedef {{ status?: number, body?: unknown } | ((body: any) => { status?: number, body?: unknown })} Route */

afterEach(() => {
	cleanup();
	window.history.replaceState(null, '', window.location.pathname);
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	window.history.replaceState(null, '', '/');
});

const MANIFEST = {
	features: [
		{ key: 'notes', name: 'Notes', description: 'Keep notes.', dependsOn: [] },
		{ key: 'inbox', name: 'Inbox', description: 'Read them.', dependsOn: ['notes'] },
		{ key: 'alerts', name: 'Alerts', description: 'Be told.', dependsOn: ['inbox'] },
		{ key: 'digest', name: 'Digest', description: 'A daily mail.', dependsOn: ['alerts'] },
	],
};
const TEXTS = dashboardTexts({ title: 'Notes', settings: { navSearch: 'Our own words' } });

/** Every request the fake product answered. @type {Array<{ method: string, path: string, body: any }>} */
let requests = [];

/**
 * The product's dashboard API, answering `METHOD path` from `routes` (404 otherwise).
 * @param {Record<string, Route>} routes
 */
const serve = (routes) => {
	requests = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
			const method = init.method ?? 'GET';
			const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
			requests.push({ method, path, body });
			const route = routes[`${method} ${path}`];
			const answer =
				typeof route === 'function' ? route(body) : (route ?? { status: 404, body: { status: 404, title: 'Not found' } });
			const status = answer.status ?? 200;
			return { ok: status < 400, status, json: async () => answer.body ?? null };
		}),
	);
};

/** @param {unknown} body */
const ok = (body) => ({ body });

/** Lets fetches and the transitions they start finish. */
const settle = async () => {
	for (let i = 0; i < 3; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

/** A website id no earlier test loaded (answers are kept per page). */
let sites = 0;
const freshSite = () => `w${(sites += 1)}`;

/** @param {import('react').ReactNode} node @param {import('../src/dashboard.js').DashboardCategories} [categories] */
const inDashboard = (node, categories) => (
	<DashboardProvider manifest={MANIFEST} texts={TEXTS} {...(categories ? { categories } : {})}>
		{node}
	</DashboardProvider>
);

/**
 * Opens a view of the list beside the page by its address (the id of its row).
 * @param {ParentNode} root
 * @param {string} id
 */
const openSection = (root, id) => {
	click(/** @type {HTMLElement} */ (root.querySelector(`[role="option"][data-ss-id="${id}"]`)));
};

/** What the page's (i) says: opens it and gives the page's text. @param {ParentNode} root */
const aboutOf = (root) => {
	const about = /** @type {HTMLElement} */ (root.querySelector('button[aria-label="About this page"]'));
	// a click elsewhere closes it in a browser; here it is closed and opened again
	if (about.getAttribute('aria-expanded') === 'true') click(about);
	click(about);
	return root.textContent;
};

/** The breadcrumbs of the open page. @param {ParentNode} root */
const crumbsOf = (root) =>
	[...root.querySelectorAll('nav[aria-label="Breadcrumb"] li')].map((li) => li.textContent).filter(Boolean);

/** The rows of the list beside the page. @param {ParentNode} root */
const navLinks = (root) => [...root.querySelectorAll('[role="option"]')].map((row) => row.textContent);

/**
 * The props a tab gets for a website.
 * @param {string} websiteId
 * @param {Partial<TabProps>} [parts]
 * @returns {TabProps}
 */
const tabProps = (websiteId, parts = {}) => ({
	websiteId,
	merchantId: 'mer_1',
	domain: 'shop.example.com',
	who: { kind: 'admin', id: 'a1', name: 'Alex Morgan', role: 'portal_owner' },
	support: { channels: [{ type: /** @type {const} */ ('email'), label: 'Email', url: 'mailto:help@example.com' }] },
	portal: 'https://portal.example.com',
	open: () => undefined,
	...parts,
});

/** @param {string} label */
const button = (label) => byText(document.body, label, 'button');

/**
 * The buttons labeled `label`, in page order.
 * @param {ParentNode} root
 * @param {string} label
 * @returns {HTMLButtonElement[]}
 */
const buttonsOf = (root, label) => [...root.querySelectorAll('button')].filter((el) => el.textContent?.trim() === label);

/** The More button of the page header (null when there is none). @param {HTMLElement} root */
const moreOf = (root) => root.querySelector('[data-ss-part="header"] button[aria-haspopup="menu"]');

const SCHEMA = { type: 'object', properties: { greeting: { type: 'string', title: 'Greeting' } } };

describe('dashboard API', () => {
	it('answers data, nothing on 204, the problem, a bare status, and 503 when the product is not reached', async () => {
		serve({
			'GET /a': ok({ n: 1 }),
			'DELETE /b': { status: 204 },
			'PUT /c': { status: 422, body: { status: 422, title: 'Bad' } },
			'GET /d': { status: 500 },
		});
		expect(await call('GET', '/a')).toEqual({ ok: true, data: { n: 1 } });
		expect(await call('DELETE', '/b')).toEqual({ ok: true, data: null });
		expect(await call('PUT', '/c', { value: 1 })).toEqual({ ok: false, problem: { status: 422, title: 'Bad' } });
		expect(await call('GET', '/d')).toEqual({ ok: false, problem: { status: 500 } });
		const sent = /** @type {any} */ (fetch).mock.calls;
		expect(sent[2][1]).toMatchObject({ method: 'PUT', credentials: 'same-origin', body: '{"value":1}' });
		expect(sent[2][1].headers).toEqual({ 'content-type': 'application/json' });
		expect(sent[0][1].headers).toBeUndefined();
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
		const offline = await call('GET', '/a');
		expect(offline.ok).toBe(false);
		if (!offline.ok) {
			expect(describeProblem(offline.problem)).toBe('We could not reach the server. Check your connection.');
		}
		// a body that is not JSON
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, json: () => Promise.reject(new Error('x')) }));
		expect(await call('GET', '/a')).toEqual({ ok: false, problem: { status: 502 } });
	});

	it('a resource that failed to load shows Try again, which loads it again and shows the content', async () => {
		let calls = 0;
		serve({ 'GET /flaky': () => (calls++ === 0 ? { status: 503, body: null } : ok({ n: 7 })) });
		function Probe() {
			const loaded = useLoad('/flaky');
			return <Loaded answer={loaded.answer}>{(data) => `n=${data.n}`}</Loaded>;
		}
		const view = render(inDashboard(<Probe />));
		await settle();
		expect(view.container.textContent).toContain(TEXTS.failed);
		expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
		await act(async () => byText(view.container, TEXTS.tryAgain, 'button').click());
		await settle();
		expect(view.container.textContent).toBe('n=7');
		// a failed answer without a way to fetch again (a save, say) shows no button
		view.rerender(inDashboard(<Loaded answer={{ ok: false, problem: { status: 503 } }}>{() => 'content'}</Loaded>));
		expect(view.container.querySelector('button')).toBeNull();
	});

	it('loads a resource, shows its last answer at once when opened again, reloads, and loads nothing for null', async () => {
		let round = 0;
		serve({ 'GET /cached': () => ok({ round: (round += 1) }), 'GET /other': ok({ other: true }) });
		/** @type {() => void} */
		let reload = () => undefined;
		/** @param {{ path: string | null }} props */
		function Probe({ path }) {
			const loaded = useLoad(path);
			reload = loaded.reload;
			return <p>{loaded.answer ? JSON.stringify(loaded.answer) : 'none'}</p>;
		}
		const first = render(<Probe path="/cached" />);
		expect(first.container.textContent).toBe('none');
		await settle();
		expect(first.container.textContent).toContain('"round":1');
		act(() => reload());
		await settle();
		expect(first.container.textContent).toContain('"round":2');
		first.rerender(<Probe path="/other" />);
		expect(first.container.textContent).toBe('none');
		await settle();
		expect(first.container.textContent).toContain('"other":true');
		first.rerender(<Probe path={null} />);
		expect(first.container.textContent).toBe('none');
		first.unmount();
		const again = render(<Probe path="/cached" />);
		// the last answer at once, then the fresh one
		expect(again.container.textContent).toContain('"round":2');
		await settle();
		expect(again.container.textContent).toContain('"round":3');
		expect(requests.filter((request) => request.path === '/other')).toHaveLength(1);
	});

	it('fills placeholders and keeps unknown ones', () => {
		expect(fill('{a} and {b}', { a: 1 })).toBe('1 and {b}');
	});
});

describe('dashboard words', () => {
	it('lays the product title and words over the shared ones, group by group, and again changes nothing', () => {
		const own = dashboardTexts({
			title: 'Chat',
			settings: { navSearch: 'Chat search' },
			overview: { noBooking: { title: 'No booking URL' } },
			list: ['a', 'b'],
		});
		expect(own.title).toBe('Chat');
		expect(own.settings.navSearch).toBe('Chat search');
		expect(own.settings.advanced).toBe(DASHBOARD_TEXTS.settings.advanced);
		expect(own.overview.noBooking.title).toBe('No booking URL');
		expect(own.list).toEqual(['a', 'b']);
		expect(Object.isFrozen(own.overview.noBooking)).toBe(true);
		expect(dashboardTexts(own)).toEqual(own);
	});

	it('needs a provider; names features by key, at most `max` of them', () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		function Bare() {
			useDashboard();
			return null;
		}
		expect(() => render(<Bare />)).toThrow(/DashboardProvider/);
		function Names() {
			const { namesOf } = useDashboard();
			return <p>{`${namesOf(['notes', 'inbox', 'alerts', 'gone'], 2)} | ${namesOf(['gone', 'notes'])}`}</p>;
		}
		const { container } = render(inDashboard(<Names />));
		expect(container.textContent).toBe('Notes, Inbox and 2 more | gone, Notes');
	});
});

describe('shared pieces', () => {
	it('helpers: features with settings, connection tones, features switched off together', () => {
		expect(hasSettings({ schema: SCHEMA })).toBe(true);
		expect(hasSettings({ schema: { type: 'object', properties: {} } })).toBe(false);
		expect(hasSettings({})).toBe(false);
		expect(['connected', 'test_failed', 'not_connected'].map(toneOf)).toEqual(['success', 'danger', 'warning']);
		const features = [
			{ key: 'notes', dependsOn: [] },
			{ key: 'inbox', dependsOn: ['notes'] },
			{ key: 'alerts', dependsOn: ['inbox'] },
			{ key: 'other', dependsOn: [] },
		];
		expect([...withDependents(features, ['notes', 'inbox', 'alerts', 'other'], 'notes')]).toEqual(['notes', 'inbox', 'alerts']);
		expect([...withDependents(features, ['notes', 'alerts'], 'notes')]).toEqual(['notes']);
	});

	it('Loaded shows a skeleton, the problem, or the content; Outcome shows saved or the problem', () => {
		const { container, rerender } = render(inDashboard(<Loaded answer={null}>{() => 'content'}</Loaded>));
		expect(container.querySelector('[aria-busy="true"], [role="status"]')).not.toBeNull();
		rerender(
			inDashboard(
				<Loaded answer={null} skeleton={<p>own skeleton</p>}>
					{() => 'content'}
				</Loaded>,
			),
		);
		expect(container.textContent).toBe('own skeleton');
		rerender(inDashboard(<Loaded answer={{ ok: false, problem: { status: 503 } }}>{() => 'content'}</Loaded>));
		expect(container.textContent).toContain(TEXTS.failed);
		rerender(inDashboard(<Loaded answer={{ ok: true, data: { n: 2 } }}>{(data) => `n=${data.n}`}</Loaded>));
		expect(container.textContent).toBe('n=2');
		rerender(inDashboard(<Outcome result={null} />));
		expect(container.textContent).toBe('');
		rerender(inDashboard(<Outcome result={{ ok: true, data: null }} />));
		expect(container.textContent).toBe('Saved');
		rerender(
			inDashboard(<Outcome result={{ ok: false, problem: { status: 422, code: 'product_rule', title: 'Too long' } }} />),
		);
		expect(container.textContent).toContain('Too long');
	});

	it('SettingsForms saves each changed setting, resets with DELETE (a website) or PUT null (defaults), and adds the notice', async () => {
		serve({
			'PUT /s/notes.greeting': ok({}),
			'DELETE /s/notes.greeting': { status: 204 },
			'PUT /s/inbox.greeting': { status: 422, body: { status: 422, code: 'product_rule', title: 'Too long' } },
		});
		const reload = vi.fn();
		const notice = vi.fn((/** @type {string} */ key, /** @type {Record<string, unknown>} */ values) =>
			key === 'notes' ? <p>{`notice ${values.greeting}`}</p> : null,
		);
		/** @type {import('../src/dashboard.js').FeatureSettings[]} */
		const features = [
			{ key: 'notes', name: 'Notes', schema: SCHEMA, values: { greeting: { value: 'Hi', source: 'website' } } },
			{ key: 'inbox', name: 'Inbox', on: false, schema: SCHEMA, values: { greeting: { value: 'Yo', source: 'default' } } },
			{ key: 'alerts', name: 'Alerts', schema: { type: 'object', properties: {} }, values: {} },
		];
		const { container, rerender } = render(
			inDashboard(
				<SettingsForms
					features={features}
					saveUrl={(key) => `/s/${key}`}
					resetBody={false}
					savedSource="website"
					reload={reload}
					notice={notice}
				/>,
			),
		);
		expect(container.textContent).not.toContain('Alerts');
		expect(container.textContent).toContain(TEXTS.settings.off);
		expect(container.textContent).toContain('notice Hi');
		expect(notice).toHaveBeenCalledWith('notes', { greeting: 'Hi' }, features);
		const [notes, inbox] = /** @type {HTMLElement[]} */ ([...container.querySelectorAll('[data-field="greeting"]')]);
		type(/** @type {HTMLInputElement} */ (notes?.querySelector('input')), 'Hello');
		expect(container.textContent).toContain('notice Hello');
		// one sticky bar saves every edited setting of every feature; it is there only while something is edited
		expect(buttonsOf(container, 'Save changes')).toHaveLength(1);
		expect(container.textContent).toContain('You have unsaved changes');
		await act(async () => buttonsOf(container, 'Save changes')[0]?.click());
		expect(requests).toEqual([{ method: 'PUT', path: '/s/notes.greeting', body: { value: 'Hello' } }]);
		expect(buttonsOf(container, 'Save changes')).toHaveLength(0);
		expect(container.textContent).toContain('Saved');
		expect(reload).toHaveBeenCalledTimes(1);
		await act(async () => byText(notes ?? container, 'Reset', 'button').click());
		expect(requests.at(-1)).toEqual({ method: 'DELETE', path: '/s/notes.greeting', body: undefined });
		// a failed save keeps the edit and shows the problem on that card
		const inboxInput = /** @type {HTMLInputElement} */ (inbox?.querySelector('input'));
		type(inboxInput, 'Hey');
		await act(async () => buttonsOf(container, 'Save changes')[0]?.click());
		expect(container.textContent).toContain('Too long');
		expect(inboxInput.value).toBe('Hey');
		// Discard drops the edits and the bar
		await act(async () => buttonsOf(container, 'Discard')[0]?.click());
		expect(buttonsOf(container, 'Save changes')).toHaveLength(0);
		expect(inboxInput.value).toBe('Yo');
		// defaults reset with PUT { value: null }
		serve({ 'PUT /d/inbox.greeting': ok({}) });
		rerender(
			inDashboard(
				<SettingsForms features={features} saveUrl={(key) => `/d/${key}`} resetBody savedSource="default" reload={reload} />,
			),
		);
		const resets = buttonsOf(container, 'Reset');
		expect(resets).toHaveLength(1);
		await act(async () => resets[0]?.click());
		expect(requests).toEqual([{ method: 'PUT', path: '/d/inbox.greeting', body: { value: null } }]);
		rerender(
			inDashboard(
				<SettingsForms features={features.slice(2)} saveUrl={() => ''} resetBody savedSource="default" reload={reload} />,
			),
		);
		// no form on the page (only the toasts of the saves above)
		expect(container.querySelector('form, section, [role="switch"], input')).toBeNull();
	});

	it('ResealCard reports what was re-sealed, websites to try again, or the problem', async () => {
		/** @type {any} */
		let answer = ok({ resealed: 3, current: 1, unreadable: 0, failedWebsites: [] });
		serve({ 'POST /v1/dashboard/reseal': () => answer });
		const { container } = render(inDashboard(<ResealCard />));
		// the page's title is the header's: the card holds the button and its answer only
		expect(container.querySelector('h1, h2, h3')).toBeNull();
		await act(async () => button(TEXTS.reseal.button).click());
		expect(container.textContent).toContain('3 re-sealed, 1 already on the current key, 0 could not');
		expect(container.textContent).toContain(TEXTS.reseal.finished);
		answer = ok({ resealed: 0, current: 4, unreadable: 0, failedWebsites: ['w1', 'w2'] });
		await act(async () => button(TEXTS.reseal.button).click());
		expect(container.textContent).toContain('2 websites could not be reached');
		// values no key opens: never "can be removed"; what to enter again, part by part
		answer = ok({
			resealed: 0,
			current: 3,
			unreadable: 3,
			failedWebsites: [],
			unreadableIn: { connections: 2, keys: 1 },
		});
		await act(async () => button(TEXTS.reseal.button).click());
		expect(container.textContent).not.toContain(TEXTS.reseal.finished);
		expect(container.textContent).toContain('Keep ENCRYPTION_KEY_PREVIOUS');
		expect(container.textContent).toContain('2 secrets in Connections (type them again on each website)');
		expect(container.textContent).toContain('1 signing keys (press Reconnect for this product in the Portal)');
		expect(container.textContent).toContain('Remove ENCRYPTION_KEY_PREVIOUS only when "could not be opened" is 0.');
		answer = { status: 500, body: { status: 500, code: 'product_rule', title: 'Broken' } };
		await act(async () => button(TEXTS.reseal.button).click());
		expect(container.textContent).toContain('Broken');
	});
});

describe('standard tabs', () => {
	const FEATURES = [
		{ key: 'notes', name: 'Notes', description: 'Keep notes.', dependsOn: [], millicreditsPerHour: 1000, on: true },
		{ key: 'inbox', name: 'Inbox', description: 'Read them.', dependsOn: ['notes'], millicreditsPerHour: 500, on: true },
		{ key: 'alerts', name: 'Alerts', description: 'Be told.', dependsOn: ['inbox'], millicreditsPerHour: 250, on: false },
	];

	it('Overview: the kit Overview with the product parts from useMore, and Check again', async () => {
		const id = freshSite();
		const base = `/v1/dashboard/websites/${id}`;
		serve({
			[`GET ${base}/overview`]: ok({
				website: { websiteId: id, merchantId: 'mer_1', domain: 'shop.example.com' },
				status: { status: 'active', graceEndsAt: null },
				featuresOn: ['notes'],
				todayMillicredits: 1000,
				checklist: { connections: [], widget: null, website: { version: 0, requires: [], missing: [] } },
				recentChanges: [],
			}),
			[`POST ${base}/website-settings/refresh`]: ok({}),
			[`GET ${base}/extra`]: ok({ count: 0 }),
		});
		/** @type {import('../src/dashboard.js').UseOverviewMore} */
		const useMore = (overview, props) => {
			const extra = useLoad(overview?.ok ? `/v1/dashboard/websites/${props.websiteId}/extra` : null);
			return extra.answer?.ok
				? {
						needs: [{ key: 'own', tone: 'warning', title: 'No widgets yet', effect: 'Nothing shows.' }],
						children: <p>own part</p>,
					}
				: {};
		};
		const { container } = render(inDashboard(<OverviewTab {...tabProps(id)} useMore={useMore} />));
		await settle();
		// a page: Notes > Overview in the header, the greeting behind the (i)
		expect(container.querySelector('h1')?.textContent).toBe('Overview');
		expect(container.querySelector('button[aria-label="About this page"]')).not.toBeNull();
		expect(container.textContent).toContain('No widgets yet');
		expect(container.textContent).toContain('own part');
		await act(async () => button('Check again').click());
		await settle();
		expect(requests.filter((request) => request.method === 'POST')).toEqual([
			{ method: 'POST', path: `${base}/website-settings/refresh`, body: undefined },
		]);
		expect(requests.filter((request) => request.path === `${base}/overview`)).toHaveLength(2);
		// without useMore: the kit Overview alone
		cleanup();
		const plain = render(inDashboard(<OverviewTab {...tabProps(id)} />));
		await settle();
		expect(plain.container.textContent).not.toContain('own part');
	});

	/** The settings of the features of the sample product, for the Settings tab (a merchant gets only the ones that are on). */
	const settingsOf = (/** @type {string[]} */ keys = ['notes', 'inbox', 'alerts']) => ({
		features: keys.map((key) => {
			const feature = /** @type {(typeof FEATURES)[number]} */ (FEATURES.find((entry) => entry.key === key));
			return {
				key,
				name: feature.name,
				on: feature.on,
				schema: SCHEMA,
				values: { greeting: { value: key === 'notes' ? 'Hi' : '', source: key === 'notes' ? 'website' : 'default' } },
			};
		}),
	});
	const LINKS = {
		connections: [{ name: 'database', label: 'Database', neededBy: ['inbox'], status: 'test_failed' }],
	};
	/** The switches in the rows of the list, in order. @param {ParentNode} root */
	const switchesOf = (root) =>
		/** @type {HTMLButtonElement[]} */ ([...root.querySelectorAll('[role="option"] [role="switch"]')]);
	/** The row of a feature in the list. @param {ParentNode} root @param {string} id */
	const rowOf = (root, id) => /** @type {HTMLElement} */ (root.querySelector(`[role="option"][data-ss-id="${id}"]`));

	it('Settings: a row for every feature with its price and switch; an Owner switches one after a confirmation with the cost, what goes off with it and the warnings', async () => {
		const id = freshSite();
		const base = `/v1/dashboard/websites/${id}`;
		serve({
			[`GET ${base}/settings`]: ok(settingsOf()),
			[`GET ${base}/features`]: ok({ features: FEATURES }),
			[`GET ${base}/connections`]: ok(LINKS),
			[`PUT ${base}/features`]: ok({}),
		});
		const open = vi.fn();
		const { container } = render(
			inDashboard(
				<SettingsTab
					{...tabProps(id, { open })}
					warnings={(on) => (on.includes('notes') ? [] : ['Nothing starts a note.'])}
				/>,
				[
					{ title: 'Writing', features: ['notes'] },
					{ title: 'Reading', features: ['inbox', 'alerts'] },
				],
			),
		);
		expect(container.querySelector('[data-ss-page][aria-busy="true"]')).not.toBeNull();
		await settle();
		// every feature has a row, on or off, under its category; the key numbers are beside the page
		expect([...container.querySelectorAll('[role="option"]')].map((row) => row.getAttribute('data-ss-id'))).toEqual([
			'notes',
			'inbox',
			'alerts',
		]);
		expect([...container.querySelectorAll('button[aria-pressed]')].map((chip) => chip.textContent)).toEqual([
			'All3',
			'Writing1',
			'Reading2',
		]);
		const facts = container.querySelector('[aria-label="Key numbers"]')?.textContent ?? '';
		expect(facts).toContain('On2');
		expect(facts).toContain('Off1');
		expect(facts).toContain('1.5 credits/h');
		expect(container.querySelectorAll('table')).toHaveLength(0);
		// a row says the price and how many settings the website changed
		expect(rowOf(container, 'notes').textContent).toContain('1 changed');
		expect(rowOf(container, 'alerts').textContent).toContain('0.25 credits/h');
		expect(rowOf(container, 'alerts').textContent).not.toContain('changed');
		// a feature whose connection fails says so in its row (the reason in place of the price) and on its page
		expect(rowOf(container, 'inbox').textContent).toContain('Not working: connect Database');
		expect(rowOf(container, 'notes').textContent).not.toContain('Not working');
		openSection(container, 'inbox');
		expect(container.querySelector('#section-inbox')?.textContent).toContain('Not working: connect Database');
		click(byText(container.querySelector('#section-inbox') ?? container, 'Connect Database', 'button'));
		expect(open).toHaveBeenCalledWith('developers', 'connection-database');
		openSection(container, 'notes');
		const checks = () => switchesOf(container).map((box) => box.getAttribute('aria-checked') === 'true');
		expect(checks()).toEqual([true, true, false]);
		// Alerts needs Inbox (on): it can be switched on; a click on the switch does not open the page
		expect(switchesOf(container)[2]?.disabled).toBe(false);
		expect(container.querySelector('h1')?.textContent).toBe('Notes');
		click(/** @type {HTMLElement} */ (switchesOf(container)[2]));
		expect(container.querySelector('h1')?.textContent).toBe('Notes');
		let dialog = /** @type {HTMLElement} */ (document.querySelector('[role="dialog"]'));
		expect(dialog.textContent).toContain('Switch on Alerts?');
		expect(dialog.textContent).toContain('New hourly cost: 1.75 credits/h');
		expect(dialog.textContent).not.toContain('Also turned off');
		click(byText(dialog, 'Cancel', 'button'));
		await settle();
		expect(requests.some((request) => request.method === 'PUT')).toBe(false);
		// nothing changes until the confirmation
		expect(checks()).toEqual([true, true, false]);
		// switching Notes off switches off the feature that needs it, and the product's warning is in the confirmation
		click(/** @type {HTMLElement} */ (switchesOf(container)[0]));
		dialog = /** @type {HTMLElement} */ (document.querySelector('[role="dialog"]'));
		expect(dialog.textContent).toContain('Switch off Notes?');
		expect(dialog.textContent).toContain('New hourly cost: 0 credits/h');
		expect(dialog.textContent).toContain('Also turned off: Inbox');
		expect(dialog.textContent).toContain('Nothing starts a note.');
		await act(async () => byText(dialog, 'Switch off', 'button').click());
		await settle();
		expect(requests.find((request) => request.method === 'PUT')).toEqual({
			method: 'PUT',
			path: `${base}/features`,
			body: { on: [] },
		});
		// the lists were read again after the save
		expect(requests.filter((request) => request.path === `${base}/features`)).toHaveLength(3);
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it('Settings: a feature that is off has a page that says what it is and how to switch it on; one that needs another is blocked', async () => {
		const id = freshSite();
		const base = `/v1/dashboard/websites/${id}`;
		const catalog = [
			...FEATURES,
			{
				key: 'digest',
				name: 'Digest',
				description: 'A daily mail.',
				dependsOn: ['alerts'],
				millicreditsPerHour: 100,
				on: false,
			},
		];
		serve({
			[`GET ${base}/settings`]: ok(settingsOf()),
			[`GET ${base}/features`]: ok({ features: catalog }),
			[`GET ${base}/connections`]: ok({ connections: [] }),
			[`PUT ${base}/features`]: ok({}),
		});
		const { container } = render(inDashboard(<SettingsTab {...tabProps(id)} />));
		await settle();
		// Digest needs Alerts, which is off: its switch is off the table and its row says why
		expect(switchesOf(container)[3]?.disabled).toBe(true);
		expect(rowOf(container, 'digest').textContent).toContain('Needs Alerts to be on');
		openSection(container, 'digest');
		expect(container.querySelector('h1')?.textContent).toBe('Digest');
		expect(container.textContent).toContain('A daily mail.');
		expect(container.textContent).toContain('Needs Alerts to be on');
		expect(buttonsOf(container, 'Switch on')).toHaveLength(0);
		// Alerts can be switched on: its page says so, with the button that asks the same as the switch
		openSection(container, 'alerts');
		expect(window.location.hash).toBe('#alerts');
		expect(container.querySelector('h1')?.textContent).toBe('Alerts');
		expect(container.textContent).toContain('Be told.');
		expect(container.textContent).toContain('Switch on Alerts to set it up.');
		// its settings are not drawn
		expect(container.querySelector('#section-alerts')?.textContent).not.toContain('Greeting');
		click(byText(container.querySelector('#section-alerts') ?? container, 'Switch on', 'button'));
		const dialog = /** @type {HTMLElement} */ (document.querySelector('[role="dialog"]'));
		expect(dialog.textContent).toContain('Switch on Alerts?');
		await act(async () => byText(dialog, 'Switch on', 'button').click());
		await settle();
		expect(requests.find((request) => request.method === 'PUT')?.body).toEqual({ on: ['notes', 'inbox', 'alerts'] });
	});

	it('Settings: a failed switch shows the problem and keeps the features as they were', async () => {
		const id = freshSite();
		const base = `/v1/dashboard/websites/${id}`;
		serve({
			[`GET ${base}/settings`]: ok(settingsOf(['notes'])),
			[`GET ${base}/features`]: ok({ features: FEATURES.map((feature) => ({ ...feature, on: false })) }),
			[`PUT ${base}/features`]: { status: 409, body: { status: 409, code: 'product_rule', title: 'No credits' } },
		});
		const { container } = render(inDashboard(<SettingsTab {...tabProps(id)} />));
		await settle();
		// no connections answer (a failed read is no reason to hide the features)
		expect(switchesOf(container).map((box) => box.disabled)).toEqual([false, true, true]);
		click(/** @type {HTMLElement} */ (switchesOf(container)[0]));
		await act(async () =>
			byText(/** @type {HTMLElement} */ (document.querySelector('[role="dialog"]')), 'Switch on', 'button').click(),
		);
		await settle();
		expect(document.body.textContent).toContain('No credits');
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(switchesOf(container)[0]?.getAttribute('aria-checked')).toBe('false');
	});

	it('Settings: if connections fail to load, features needing a connection show "Could not check the connection" with Retry', async () => {
		const id = freshSite();
		const base = `/v1/dashboard/websites/${id}`;
		let connectionAttempts = 0;
		serve({
			[`GET ${base}/settings`]: ok(settingsOf(['notes', 'inbox'])),
			[`GET ${base}/features`]: ok({ features: FEATURES }),
			[`GET ${base}/connections`]: () => {
				connectionAttempts += 1;
				if (connectionAttempts === 1) return { status: 500, body: { status: 500, title: 'Down' } };
				return ok(LINKS);
			},
		});
		const { container } = render(inDashboard(<SettingsTab {...tabProps(id)} links={LINKS.connections} />));
		await settle();
		expect(rowOf(container, 'inbox').textContent).toContain('Could not check the connection');
		openSection(container, 'inbox');
		expect(container.querySelector('#section-inbox')?.textContent).toContain('Could not check the connection');
		const retryButton = byText(container.querySelector('#section-inbox') ?? container, 'Retry', 'button');
		expect(retryButton).not.toBeNull();
		click(retryButton);
		await settle();
		expect(container.querySelector('#section-inbox')?.textContent).toContain('Not working: connect Database');
	});

	it('Settings: a merchant sees the switches locked, which features are on, and is told to ask support', async () => {
		const id = freshSite();
		const base = `/v1/dashboard/websites/${id}`;
		serve({
			// a merchant's settings are only the features that are on
			[`GET ${base}/settings`]: ok(settingsOf(['notes', 'inbox'])),
			[`GET ${base}/features`]: ok({ features: FEATURES }),
			[`GET ${base}/connections`]: ok(LINKS),
		});
		const { container } = render(
			inDashboard(<SettingsTab {...tabProps(id, { who: { kind: 'merchant', id: 'm1', name: 'Sam' } })} />),
		);
		await settle();
		expect(switchesOf(container).every((box) => box.disabled)).toBe(true);
		expect(container.querySelectorAll('[role="option"]')).toHaveLength(3);
		expect(rowOf(container, 'notes').textContent).toContain('On');
		expect(rowOf(container, 'alerts').textContent).toContain('Off');
		expect(rowOf(container, 'inbox').textContent).toContain('Not working: connect Database');
		openSection(container, 'alerts');
		expect(container.textContent).toContain('Ask support to switch it on: help@example.com (Email).');
		expect(buttonsOf(container, 'Switch on')).toHaveLength(0);
		// a click on a locked switch asks nothing
		click(/** @type {HTMLElement} */ (switchesOf(container)[2]));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it('Settings: a feature that is on has its settings all open on one page: the groups, the notice and extras of the product, and Advanced last, with one save bar', async () => {
		const id = freshSite();
		const base = `/v1/dashboard/websites/${id}`;
		const GROUPED = {
			type: 'object',
			properties: {
				subject: { type: 'string', title: 'Subject', 'x-ui': { group: 'Basics' } },
				sender: { type: 'string', title: 'Sender', 'x-ui': { group: 'Messages' } },
				limit: { type: 'integer', title: 'Daily limit', 'x-ui': { group: 'Limits' } },
				salt: { type: 'string', title: 'Hash salt', 'x-ui': { advanced: true } },
			},
		};
		serve({
			[`GET ${base}/settings`]: ok({
				features: [
					{
						key: 'notes',
						name: 'Notes',
						on: true,
						schema: SCHEMA,
						values: { greeting: { value: 'Hi', source: 'default' } },
					},
					{
						key: 'inbox',
						name: 'Inbox',
						on: true,
						schema: GROUPED,
						values: Object.fromEntries(
							Object.keys(GROUPED.properties).map((name) => [name, { value: '', source: 'default' }]),
						),
					},
					// off: it has a row and a page, but its settings are not drawn
					{
						key: 'alerts',
						name: 'Alerts',
						on: false,
						schema: SCHEMA,
						values: { greeting: { value: '', source: 'default' } },
					},
				],
			}),
			[`GET ${base}/features`]: ok({ features: FEATURES }),
			[`PUT ${base}/settings/notes.greeting`]: ok({}),
		});
		const { container } = render(
			inDashboard(
				<SettingsTab
					{...tabProps(id)}
					notice={(key) => <p>{`notice for ${key}`}</p>}
					extras={{
						notes: <p>notes extra</p>,
						inbox: {
							items: [
								{ id: 'rules', label: 'Rules', content: <p>rules list</p> },
								{ id: 'beside', label: 'Beside', top: true, content: <p>beside inbox</p> },
							],
						},
					}}
					sections={[{ id: 'own', label: 'Own section', group: 'Lists', content: <p>own section</p> }]}
				/>,
				[
					{ title: 'Writing', features: ['notes'] },
					{ title: 'Reading', features: ['inbox', 'alerts'] },
				],
			),
		);
		await settle();
		// the list has a row for each feature, on or off, with the categories as its filter chips
		const ALL = ['notes', 'inbox', 'inbox.beside', 'alerts', 'own'];
		const idsOf = () => [...container.querySelectorAll('[role="option"]')].map((row) => row.getAttribute('data-ss-id'));
		expect(idsOf()).toEqual(ALL);
		const chips = [...container.querySelectorAll('button[aria-pressed]')].map((chip) => chip.textContent);
		expect(chips).toEqual(['All5', 'Writing1', 'Reading3', 'Lists1']);
		// one view: Notes, with the notice and its extra; Inbox is not on the page yet
		expect(crumbsOf(container)).toEqual(['Notes', 'Settings', 'Notes']);
		expect(container.querySelector('h1')?.textContent).toBe('Notes');
		expect(container.textContent).toContain('notice for notes');
		expect(container.textContent).toContain('notes extra');
		// the old description is behind the (i), not in a heading of the body
		expect(container.querySelector('#section-notes h2, #section-notes h3')).toBeNull();
		expect(container.textContent).not.toContain('Keep notes.');
		expect(aboutOf(container)).toContain('Keep notes.');
		expect(container.textContent).not.toContain('Daily limit');
		type(/** @type {HTMLInputElement} */ (container.querySelector('[data-field="greeting"] input')), 'Hey');
		await act(async () => byText(container, 'Save changes', 'button').click());
		await settle();
		expect(requests.filter((request) => request.method === 'PUT')).toEqual([
			{ method: 'PUT', path: `${base}/settings/notes.greeting`, body: { value: 'Hey' } },
		]);
		// Inbox has three groups and Advanced settings: they are all on its one page, none behind a tab or another row; its
		// list editor is one more part of the page under its heading
		openSection(container, 'inbox');
		// a view marked `top` is listed beside the feature, not under it
		expect(idsOf()).toEqual(ALL);
		for (const name of ['subject', 'sender', 'limit', 'salt'])
			expect(/** @type {HTMLElement} */ (container.querySelector(`[data-field="${name}"]`)).closest('[hidden]')).toBeNull();
		// Advanced is open too, the last part of the page, headed "Advanced" (no closed box)
		expect(container.querySelector('#section-inbox [aria-expanded]')).toBeNull();
		expect([...container.querySelectorAll('#section-inbox > section > h2')].map((heading) => heading.textContent)).toEqual([
			'Settings',
			'Rules',
			'Advanced',
		]);
		expect(
			container
				.querySelector('#section-inbox > section:last-of-type')
				?.contains(container.querySelector('[data-field="salt"]')),
		).toBe(true);
		expect(
			container
				.querySelector('#section-inbox > section:first-of-type')
				?.contains(container.querySelector('[data-field="salt"]')),
		).toBe(false);
		expect(container.textContent).toContain('rules list');
		// the crumbs name the feature; its address is its own, and an old address of one of its groups opens it too
		expect(crumbsOf(container)).toEqual(['Notes', 'Settings', 'Inbox']);
		expect(container.querySelector('h1')?.textContent).toBe('Inbox');
		expect(window.location.hash).toBe('#inbox');
		openSection(container, 'inbox.beside');
		expect(container.textContent).toContain('beside inbox');
		openSection(container, 'own');
		expect(container.textContent).toContain('own section');
		expect(window.location.hash).toBe('#own');
		// without the product parts: the kit's forms only
		cleanup();
		const plain = render(inDashboard(<SettingsTab {...tabProps(id)} />));
		await settle();
		expect(plain.container.textContent).not.toContain('notice for');
		expect(aboutOf(plain.container)).toContain('Keep notes.');
	});

	it('Settings: a setting that starts from the Portal says so and links to its section, until the website saves its own', async () => {
		const id = freshSite();
		const schema = {
			type: 'object',
			properties: {
				language: { type: 'string', title: 'Language', default: '', 'x-ui': { defaultFrom: 'region.language' } },
				greeting: { type: 'string', title: 'Greeting', default: 'Hi' },
			},
		};
		serve({
			[`GET /v1/dashboard/websites/${id}/settings`]: ok({
				features: [
					{
						key: 'notes',
						name: 'Notes',
						on: true,
						schema,
						values: {
							language: { value: 'fr-CA', source: 'portal', from: 'region.language' },
							greeting: { value: 'Hi', source: 'built-in' },
						},
					},
				],
			}),
			[`GET /v1/dashboard/websites/${id}/features`]: ok({ features: FEATURES.slice(0, 1) }),
		});
		const { container } = render(inDashboard(<SettingsTab {...tabProps(id)} />));
		await settle();
		const notes = [...container.querySelectorAll('[data-inherited]')];
		expect(notes).toHaveLength(1);
		expect(notes[0]?.textContent).toBe('Using your website’s language. Change it in the Portal');
		// an Owner or Support admin opens the merchant's page of the website, a merchant their own
		expect(notes[0]?.querySelector('a')?.getAttribute('href')).toBe(
			`https://portal.example.com/admin/merchants/mer_1/websites/${id}/settings#region`,
		);
		expect(notes[0]?.querySelector('a')?.getAttribute('target')).toBe('_blank');
		expect(byLabel(container, 'Language').value).toBe('fr-CA');
		// typing a value of its own takes the note away (the website then saves its own)
		type(byLabel(container, 'Language'), 'de-CH');
		expect(container.querySelector('[data-inherited]')).toBeNull();
		cleanup();
		const merchant = render(
			inDashboard(<SettingsTab {...tabProps(id, { who: { kind: 'merchant', id: 'mer_1', name: 'Acme' } })} />),
		);
		await settle();
		expect(merchant.container.querySelector('[data-inherited] a')?.getAttribute('href')).toBe(
			`https://portal.example.com/websites/${id}/settings#region`,
		);
	});

	it('Settings: says so when the product has no feature yet; a feature without settings has a page that says so', async () => {
		const id = freshSite();
		serve({
			[`GET /v1/dashboard/websites/${id}/settings`]: ok({ features: [] }),
			[`GET /v1/dashboard/websites/${id}/features`]: ok({ features: [] }),
		});
		const { container } = render(inDashboard(<SettingsTab {...tabProps(id)} />));
		await settle();
		expect(container.textContent).toContain(TEXTS.settings.nothingOn);
		expect(container.querySelector('[role="option"]')).toBeNull();
		expect(container.querySelector('h1')?.textContent).toBe('Settings');
		cleanup();
		// a feature that is on and has nothing to set
		const other = freshSite();
		serve({
			[`GET /v1/dashboard/websites/${other}/settings`]: ok({ features: [] }),
			[`GET /v1/dashboard/websites/${other}/features`]: ok({ features: FEATURES.slice(0, 1) }),
		});
		const plain = render(inDashboard(<SettingsTab {...tabProps(other)} />));
		await settle();
		// one feature is the whole page: no list beside it
		expect(plain.container.querySelector('[role="option"]')).toBeNull();
		expect(plain.container.querySelector('h1')?.textContent).toBe('Settings');
		expect(plain.container.textContent).toContain(TEXTS.settings.none);
	});

	it('Settings: shows the page skeleton while it loads and the problem in the page, with Try again, when the settings or the features fail', async () => {
		const id = freshSite();
		serve({
			[`GET /v1/dashboard/websites/${id}/settings`]: { status: 500, body: { status: 500, code: 'internal_error' } },
			[`GET /v1/dashboard/websites/${id}/features`]: ok({ features: FEATURES }),
		});
		const { container } = render(inDashboard(<SettingsTab {...tabProps(id)} />));
		expect(container.querySelector('[data-ss-page][aria-busy="true"]')).not.toBeNull();
		expect(container.querySelector('h1')?.textContent).toBe('Settings');
		await settle();
		expect(container.querySelector('[aria-busy="true"]')).toBeNull();
		expect(container.textContent).toContain('Try again');
		cleanup();
		const other = freshSite();
		serve({
			[`GET /v1/dashboard/websites/${other}/settings`]: ok({ features: [] }),
			[`GET /v1/dashboard/websites/${other}/features`]: { status: 500, body: { status: 500, code: 'internal_error' } },
		});
		const second = render(inDashboard(<SettingsTab {...tabProps(other)} />));
		await settle();
		expect(second.container.textContent).toContain('Try again');
	});

	it('Texts: a row per screen with how many texts were changed, each text a field in place, one save bar', async () => {
		const id = freshSite();
		const base = `/v1/dashboard/websites/${id}`;
		serve({
			[`GET ${base}/texts`]: ok({
				texts: [
					{ key: 'cart.title', english: 'Your cart', value: 'Your cart', source: 'built-in' },
					{ key: 'cart.empty', english: 'Nothing here', value: 'Nothing here', source: 'built-in' },
					{ key: 'signIn.title', english: 'Sign in', value: 'Welcome back', source: 'website' },
				],
			}),
			[`PUT ${base}/texts/cart.title`]: (body) =>
				body.value === 'bad'
					? { status: 400, body: { status: 400, code: 'validation_failed', detail: 'Keep {name}' } }
					: ok({}),
			[`PUT ${base}/texts/cart.empty`]: ok({}),
			[`DELETE ${base}/texts/signIn.title`]: { status: 204 },
		});
		const { container } = render(inDashboard(<TextsTab {...tabProps(id)} />));
		await settle();
		// a row per screen: how many texts, how many were changed
		expect(navLinks(container)).toEqual(['Cart2 texts · 0 changed', 'Sign in1 text · 1 changed']);
		expect(crumbsOf(container)).toEqual(['Notes', 'Texts', 'Cart']);
		expect(container.querySelector('h1')?.textContent).toBe('Cart');
		expect(aboutOf(container)).toContain(TEXTS.texts.help);
		// only the open screen is drawn: every text of it is a field with its English words as the label
		expect(container.querySelector('#section-text-signIn')).toBeNull();
		expect(container.querySelector('table')).toBeNull();
		const page = /** @type {HTMLElement} */ (container.querySelector('#section-text-cart'));
		expect([...page.querySelectorAll('label')].map((label) => label.textContent)).toEqual(['Your cart', 'Nothing here']);
		expect(page.textContent).toContain('Shown in Cart › Title');
		expect(page.textContent).not.toContain('Reset to default');
		const title = byLabel(container, 'Your cart');
		expect(title.value).toBe('Your cart');
		// no save bar until a text is edited; typing the saved words again is no edit
		expect(buttonsOf(container, 'Save changes')).toHaveLength(0);
		type(title, 'My cart');
		expect(buttonsOf(container, 'Save changes')).toHaveLength(1);
		type(title, 'Your cart');
		expect(buttonsOf(container, 'Save changes')).toHaveLength(0);
		// a refused text keeps what was typed and says why under its field; the other text still saves
		type(title, 'bad');
		type(byLabel(container, 'Nothing here'), 'Nada');
		await act(async () => buttonsOf(container, 'Save changes')[0]?.click());
		await settle();
		expect(requests.filter((request) => request.method === 'PUT').map((request) => [request.path, request.body])).toEqual([
			[`${base}/texts/cart.title`, { value: 'bad' }],
			[`${base}/texts/cart.empty`, { value: 'Nada' }],
		]);
		expect(byLabel(container, 'Your cart').value).toBe('bad');
		expect(page.textContent).toContain('Keep {name}');
		expect(buttonsOf(container, 'Save changes')).toHaveLength(1);
		// typing again clears the reason; Discard forgets the edit and the bar goes
		type(byLabel(container, 'Your cart'), 'My cart');
		expect(page.textContent).not.toContain('Keep {name}');
		await act(async () => buttonsOf(container, 'Discard')[0]?.click());
		expect(byLabel(container, 'Your cart').value).toBe('Your cart');
		expect(buttonsOf(container, 'Save changes')).toHaveLength(0);
		// a changed text can be reset to the default at once
		openSection(container, 'text-signIn');
		expect(window.location.hash).toBe('#text-signIn');
		expect(container.querySelector('h1')?.textContent).toBe('Sign in');
		expect(byLabel(container, 'Sign in').value).toBe('Welcome back');
		await act(async () => buttonsOf(container, TEXTS.reset)[0]?.click());
		await settle();
		expect(requests.filter((request) => request.method === 'DELETE').map((request) => request.path)).toEqual([
			`${base}/texts/signIn.title`,
		]);
	});

	it('Texts: one save bar for the edits of every screen', async () => {
		const id = freshSite();
		const base = `/v1/dashboard/websites/${id}`;
		serve({
			[`GET ${base}/texts`]: ok({
				texts: [
					{ key: 'cart.title', english: 'Your cart', value: 'Your cart', source: 'built-in' },
					{ key: 'signIn.title', english: 'Sign in', value: 'Sign in', source: 'built-in' },
				],
			}),
			[`PUT ${base}/texts/cart.title`]: ok({}),
			[`PUT ${base}/texts/signIn.title`]: ok({}),
		});
		const { container } = render(inDashboard(<TextsTab {...tabProps(id)} />));
		await settle();
		type(byLabel(container, 'Your cart'), 'My cart');
		openSection(container, 'text-signIn');
		type(byLabel(container, 'Sign in'), 'Log in');
		expect(buttonsOf(container, 'Save changes')).toHaveLength(1);
		await act(async () => buttonsOf(container, 'Save changes')[0]?.click());
		await settle();
		expect(requests.filter((request) => request.method === 'PUT').map((request) => request.body)).toEqual([
			{ value: 'My cart' },
			{ value: 'Log in' },
		]);
		expect(buttonsOf(container, 'Save changes')).toHaveLength(0);
	});

	it('Texts: a long text is a multi-line box', async () => {
		const id = freshSite();
		const long = 'Thank you for your order. We will email you as soon as it ships, and again when it arrives.';
		serve({
			[`GET /v1/dashboard/websites/${id}/texts`]: ok({
				texts: [
					{ key: 'done.thanks', english: long, value: long, source: 'built-in' },
					{ key: 'done.title', english: 'Done', value: 'Done', source: 'built-in' },
				],
			}),
		});
		const { container } = render(inDashboard(<TextsTab {...tabProps(id)} />));
		await settle();
		expect(byLabel(container, long).tagName).toBe('TEXTAREA');
		expect(byLabel(container, 'Done').tagName).toBe('INPUT');
	});

	it('Texts: a search across all the screens keeps the list and shows the matches as fields, paged', async () => {
		const id = freshSite();
		const base = `/v1/dashboard/websites/${id}`;
		serve({
			[`GET ${base}/texts`]: ok({
				texts: [
					{ key: 'cart.title', english: 'Your cart', value: 'Your cart', source: 'built-in' },
					{ key: 'cart.empty', english: 'Nothing here', value: 'Nothing here', source: 'built-in' },
					{ key: 'signIn.title', english: 'Sign in', value: 'Welcome back', source: 'website' },
				],
			}),
			[`PUT ${base}/texts/signIn.title`]: ok({}),
		});
		const { container } = render(inDashboard(<TextsTab {...tabProps(id)} />));
		await settle();
		const search = () =>
			/** @type {HTMLInputElement} */ (container.querySelector('input[type="search"][aria-label="Find a text by its words"]'));
		type(search(), 'welcome');
		await settle();
		// the list stays; the crumbs say these are results; the matches are fields, not a table
		expect(container.querySelector('[role="listbox"][aria-label="Texts"]')).not.toBeNull();
		expect(crumbsOf(container)).toEqual(['Notes', 'Texts', TEXTS.texts.results]);
		const shown = () =>
			[...container.querySelectorAll('label')]
				.filter((label) => label.closest('[hidden]') === null)
				.map((label) => label.textContent);
		expect(shown()).toEqual(['Sign in']);
		expect(container.querySelector('table')).toBeNull();
		expect(container.querySelector('[data-ss-part="footer"]')?.textContent).toContain('1');
		type(search(), 'zzz');
		await settle();
		expect(container.textContent).toContain(TEXTS.texts.none);
		// a match is edited in place and saves with the page's one Save bar
		type(search(), 'welcome');
		await settle();
		type(byLabel(container, 'Sign in'), 'Hello again');
		await act(async () => buttonsOf(container, 'Save changes')[0]?.click());
		await settle();
		expect(requests.filter((request) => request.method === 'PUT').map((request) => request.body)).toEqual([
			{ value: 'Hello again' },
		]);
		// clearing the search brings the screen back
		type(search(), '');
		await settle();
		expect(crumbsOf(container)).toEqual(['Notes', 'Texts', 'Cart']);
		expect(container.querySelector('#section-text-cart input')).not.toBeNull();
	});

	it('Texts: shows the page skeleton with the sidebar while it loads', async () => {
		const id = freshSite();
		serve({ [`GET /v1/dashboard/websites/${id}/texts`]: ok({ texts: [] }) });
		const { container } = render(inDashboard(<TextsTab {...tabProps(id)} />));
		expect(container.querySelector('[data-ss-page][aria-busy="true"]')).not.toBeNull();
		expect(container.querySelector('h1')?.textContent).toBe('Texts');
		await settle();
		expect(container.querySelector('[aria-busy="true"]')).toBeNull();
	});

	it('Developers: the connections come first; saves and tests a value, removes after a confirmation, with the product forms and hints', async () => {
		const id = freshSite();
		const base = `/v1/dashboard/websites/${id}/connections`;
		serve({
			[`GET /v1/dashboard/websites/${id}/features`]: ok({ features: FEATURES }),
			[`GET ${base}`]: ok({
				connections: [
					{
						name: 'database',
						label: 'Database',
						neededBy: ['notes', 'inbox'],
						status: 'connected',
						last4: 'abcd',
						message: 'Fine',
					},
					{ name: 'mail', label: 'Mail', kind: 'secret', neededBy: [], status: 'not_connected' },
					{ name: 'storage', label: 'Storage', neededBy: ['alerts'], status: 'test_failed' },
				],
			}),
			[`PUT ${base}/mail`]: ok({}),
			[`PUT ${base}/storage`]: ok({}),
			[`POST ${base}/database/test`]: { status: 502, body: { status: 502, code: 'product_rule', title: 'Cannot reach it' } },
			[`DELETE ${base}/database`]: { status: 204 },
		});
		const { container } = render(
			inDashboard(
				<DevelopersTab
					{...tabProps(id)}
					connections={{
						hint: (name) => (name === 'database' ? 'Your MongoDB address.' : null),
						form: (item, save) =>
							item.name === 'storage' ? (
								<button type="button" onClick={() => void save({ bucket: 'b' })}>
									Save storage
								</button>
							) : null,
					}}
				/>,
			),
		);
		await settle();
		// the connections are the first rows of the list, with their state as a dot and who needs them as the line; the developer parts follow
		expect(navLinks(container)).toEqual([
			'DatabaseConnectedNeeded by: Notes, Inbox',
			'MailNot connectedOptional',
			'StorageTest failedNeeded by: Alerts',
			'Widget script',
			'Feature docs',
		]);
		expect(crumbsOf(container)).toEqual(['Notes', 'Developers', 'Database']);
		const header = () => /** @type {HTMLElement} */ (container.querySelector('[data-ss-part="header"]'));
		const card = (/** @type {string} */ name) =>
			/** @type {HTMLElement} */ (container.querySelector(`#section-connection-${name}`));
		// the page is one rich card: its name, its state, the product's hint as the help line
		expect(card('database').querySelector('h2')?.textContent).toBe('Database');
		expect(card('database').textContent).toContain('Connected');
		expect(aboutOf(container)).toContain('Needed by: Notes, Inbox');
		expect(container.textContent).toContain('••••abcd');
		expect(container.textContent).toContain('Fine');
		expect(container.textContent).toContain('Your MongoDB address.');
		// Test is a button of the header, not of the body
		expect(buttonsOf(header(), TEXTS.connections.test)).toHaveLength(1);
		expect(
			buttonsOf(/** @type {HTMLElement} */ (container.querySelector('#section-connection-database')), 'Test'),
		).toHaveLength(0);
		await act(async () => buttonsOf(container, TEXTS.connections.test)[0]?.click());
		await settle();
		expect(container.textContent).toContain('Cannot reach it');
		// Mail: a value field, Save and test sends it trimmed, and the field empties; nothing saved yet, so no Remove menu
		openSection(container, 'connection-mail');
		expect(crumbsOf(container)).toEqual(['Notes', 'Developers', 'Mail']);
		expect(aboutOf(container)).toContain('Optional');
		expect(card('mail').textContent).toContain('Not connected');
		// More holds only the folded Test and shows only where the header is narrow (below 48rem)
		expect(moreOf(container)?.closest('.relative')?.className ?? '@3xl:hidden').toContain('@3xl:hidden');
		const token = byLabel(
			/** @type {HTMLElement} */ (container.querySelector('#section-connection-mail')),
			TEXTS.connections.value,
		);
		type(token, '  secret  ');
		await act(async () =>
			byText(container.querySelector('#section-connection-mail') ?? container, TEXTS.connections.save, 'button').click(),
		);
		await settle();
		expect(requests.find((request) => request.method === 'PUT')).toEqual({
			method: 'PUT',
			path: `${base}/mail`,
			body: { value: 'secret' },
		});
		expect(token.value).toBe('');
		// Storage: the product's own form, and its state
		openSection(container, 'connection-storage');
		expect(card('storage').textContent).toContain('Test failed');
		await act(async () => button('Save storage').click());
		await settle();
		expect(requests.filter((request) => request.method === 'PUT').at(-1)).toEqual({
			method: 'PUT',
			path: `${base}/storage`,
			body: { value: { bucket: 'b' } },
		});
		// Remove sits in the menu of what is saved, after a confirmation
		openSection(container, 'connection-database');
		const menu = /** @type {HTMLElement} */ (header().querySelector('button[aria-haspopup="menu"]'));
		expect(menu.getAttribute('aria-label')).toBe('More actions');
		click(menu);
		// the folded Test is a row of the menu too (hidden where its button shows); Remove is the last row
		click(/** @type {HTMLElement} */ (allByRole(container, 'menuitem').at(-1)));
		const dialog = /** @type {HTMLElement} */ (document.querySelector('[role="dialog"]'));
		expect(dialog.textContent).toContain('Remove Database?');
		click(byText(dialog, 'Cancel', 'button'));
		await settle();
		expect(requests.some((request) => request.method === 'DELETE')).toBe(false);
		click(menu);
		click(/** @type {HTMLElement} */ (allByRole(container, 'menuitem').at(-1)));
		await act(async () =>
			byText(/** @type {HTMLElement} */ (document.querySelector('[role="dialog"]')), 'Remove', 'button').click(),
		);
		await settle();
		expect(requests.filter((request) => request.method === 'DELETE')).toEqual([
			{ method: 'DELETE', path: `${base}/database`, body: undefined },
		]);
	});

	it('Developers: the database, the storage, the AI provider key and the links belong to the Portal: a note and a link to it, no form, no Remove', async () => {
		const id = freshSite();
		const base = `/v1/dashboard/websites/${id}/connections`;
		serve({
			[`GET /v1/dashboard/websites/${id}/features`]: ok({ features: FEATURES }),
			[`GET ${base}`]: ok({
				connections: [
					{ name: 'database', label: 'Database', kind: 'database', neededBy: ['notes'], status: 'connected', managed: true },
					{ name: 'storage', label: 'Storage', kind: 'storage', neededBy: [], status: 'test_failed', managed: true },
					{
						name: 'link_accounts',
						label: 'Link to Accounts',
						kind: 'link',
						neededBy: ['notes'],
						status: 'not_connected',
						managed: true,
					},
					{
						name: 'ai_shared',
						label: 'AI provider',
						kind: 'secret',
						neededBy: ['notes'],
						status: 'connected',
						managed: true,
					},
					{ name: 'ai', label: 'AI key', kind: 'secret', neededBy: [], status: 'not_connected', managed: false },
				],
			}),
			[`POST ${base}/database/test`]: ok({}),
		});
		const { container } = render(inDashboard(<DevelopersTab {...tabProps(id)} />));
		await settle();
		for (const [name, words] of /** @type {const} */ ([
			['database', TEXTS.connections.managed.database],
			['storage', TEXTS.connections.managed.storage],
			['link_accounts', TEXTS.connections.managed.link],
			['ai_shared', TEXTS.connections.managed.secret],
		])) {
			openSection(container, `connection-${name}`);
			const section = /** @type {HTMLElement} */ (container.querySelector(`#section-connection-${name}`));
			expect(section.querySelectorAll('h2')).toHaveLength(1);
			expect(section.textContent).toContain(TEXTS.managed.title);
			expect(section.textContent).toContain(words);
			// the way to change it is the Portal, at the section that holds it; nothing is typed or removed here
			const link = /** @type {HTMLAnchorElement} */ (section.querySelector('a[href^="https://portal.example.com"]'));
			expect(link.getAttribute('href')).toBe(
				`https://portal.example.com/admin/merchants/mer_1/websites/${id}/settings#${name === 'link_accounts' ? 'links' : 'connections'}`,
			);
			expect(section.querySelector('input')).toBeNull();
			expect(moreOf(container)?.closest('.relative')?.className ?? '@3xl:hidden').toContain('@3xl:hidden');
			expect(buttonsOf(section, TEXTS.connections.save)).toHaveLength(0);
		}
		// the database and the storage can be tested here; a link cannot
		openSection(container, 'connection-database');
		expect(buttonsOf(container, TEXTS.connections.test)).toHaveLength(1);
		openSection(container, 'connection-link_accounts');
		expect(buttonsOf(container, TEXTS.connections.test)).toHaveLength(0);
		openSection(container, 'connection-database');
		await act(async () => buttonsOf(container, TEXTS.connections.test)[0]?.click());
		await settle();
		expect(requests.some((request) => request.method === 'POST' && request.path === `${base}/database/test`)).toBe(true);
		// the product's own provider key still has its field
		openSection(container, 'connection-ai');
		expect(
			/** @type {HTMLElement} */ (container.querySelector('#section-connection-ai')).querySelector('input'),
		).not.toBeNull();
	});

	it('Developers: with no connections, or with them left out, the list holds the developer parts only and nothing is asked for', async () => {
		const id = freshSite();
		serve({
			[`GET /v1/dashboard/websites/${id}/features`]: ok({ features: FEATURES }),
			[`GET /v1/dashboard/websites/${id}/connections`]: ok({ connections: [] }),
		});
		const empty = render(inDashboard(<DevelopersTab {...tabProps(id)} />));
		await settle();
		expect(navLinks(empty.container)).toEqual(['Widget script', 'Feature docs']);
		expect(empty.container.querySelector('[role="radio"], [data-ss-chip]')).toBeNull();
		cleanup();
		requests.length = 0;
		const left = render(inDashboard(<DevelopersTab {...tabProps(id)} connections={null} />));
		await settle();
		expect(navLinks(left.container)).toEqual(['Widget script', 'Feature docs']);
		expect(requests.some((request) => request.path.endsWith('/connections'))).toBe(false);
	});

	it('Developers: shows the page skeleton while loading and the problem in the page when the connections failed', async () => {
		const id = freshSite();
		serve({
			[`GET /v1/dashboard/websites/${id}/features`]: ok({ features: FEATURES }),
			[`GET /v1/dashboard/websites/${id}/connections`]: { status: 500, body: { status: 500, title: 'Down' } },
		});
		const { container } = render(inDashboard(<DevelopersTab {...tabProps(id)} />));
		expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
		expect(crumbsOf(container)).toEqual(['Notes', 'Developers']);
		await settle();
		expect(container.querySelector('[aria-busy="true"]')).toBeNull();
		expect(container.textContent).toContain(TEXTS.failed);
		expect(byText(container, TEXTS.tryAgain, 'button')).toBeTruthy();
	});

	it('Developers: the product sections or the widget script, and the searchable docs rows; the id and tokens are in the Portal', async () => {
		const id = freshSite();
		serve({ [`GET /v1/dashboard/websites/${id}/features`]: ok({ features: FEATURES }) });
		const { container } = render(inDashboard(<DevelopersTab {...tabProps(id)} connections={null} />));
		await settle();
		expect(navLinks(container)).toEqual(['Widget script', 'Feature docs']);
		expect(crumbsOf(container)).toEqual(['Notes', 'Developers', 'Widget script']);
		// no heading in the body: what the script is for is behind the (i)
		expect(container.querySelector('#section-script h2, #section-script h3')).toBeNull();
		expect(container.textContent).not.toContain(TEXTS.developers.scriptHelp);
		expect(aboutOf(container)).toContain(TEXTS.developers.scriptHelp);
		// nothing here repeats what the Portal shows: no website id, no token text, no link to the tokens
		expect(container.textContent).not.toContain(id);
		expect(container.textContent).not.toContain('server token');
		expect(container.querySelector('a[href="https://portal.example.com"]')).toBeNull();
		expect(container.textContent).toContain(`${window.location.origin}/widget.js`);
		// the docs are rows of the features, each a link to its docs, the ones that are off marked, with a search above them
		openSection(container, 'docs');
		expect(crumbsOf(container)).toEqual(['Notes', 'Developers', 'Feature docs']);
		expect(container.querySelector('#section-docs table, #section-docs ul, #section-docs ol')).toBeNull();
		const docs = () => [...container.querySelectorAll('#section-docs [data-ss-row]')];
		expect(docs().map((row) => row.querySelector('a')?.textContent)).toEqual(['Notes', 'Inbox', 'Alerts']);
		expect(docs().map((row) => row.querySelector('.tabular-nums')?.textContent)).toEqual(['On', 'On', 'Off']);
		expect(container.querySelector('a[href="/docs#feature-notes"]')).not.toBeNull();
		const search = /** @type {HTMLInputElement} */ (
			container.querySelector('input[type="search"][aria-label="Find a feature"]')
		);
		type(search, 'inb');
		await settle();
		expect(docs().map((row) => row.querySelector('a')?.textContent)).toEqual(['Inbox']);
		type(search, 'zzz');
		await settle();
		expect(container.textContent).toContain(TEXTS.developers.none);
		// the search belongs to the docs: the script page has none
		openSection(container, 'script');
		expect(container.querySelector('input[type="search"][aria-label="Find a feature"]')).toBeNull();
		cleanup();
		const own = render(
			inDashboard(
				<DevelopersTab
					{...tabProps(id)}
					connections={null}
					sections={[{ id: 'snippets', label: 'Snippets', content: <section>own sections</section> }]}
				/>,
			),
		);
		await settle();
		expect(navLinks(own.container)).toEqual(['Snippets', 'Feature docs']);
		expect(own.container.textContent).toContain('own sections');
		expect(own.container.textContent).not.toContain('widget.js');
	});

	it('Defaults: the global settings (reset with PUT null) and texts, with the product notice; no theme or Format', async () => {
		serve({
			'GET /v1/dashboard/defaults': ok({
				features: [{ key: 'notes', name: 'Notes', schema: SCHEMA, values: { greeting: { value: 'Hi', source: 'default' } } }],
				texts: [{ key: 'hello.title', english: 'Hello', value: 'Hey', source: 'default' }],
				recentChanges: [{ who: { name: 'Alex' }, detail: 'Changed the default greeting', at: '2026-10-04T14:30:00.000Z' }],
			}),
			'PUT /v1/dashboard/defaults/notes.greeting': ok({}),
			'PUT /v1/dashboard/defaults/text.hello.title': ok({}),
		});
		const { container } = render(inDashboard(<DefaultsTab notice={(key) => <p>{`default notice ${key}`}</p>} />));
		await settle();
		// a page with the intro behind the (i), the first feature open
		expect(crumbsOf(container)).toEqual(['Notes', 'Defaults', 'Notes']);
		expect(container.textContent).not.toContain(TEXTS.defaults.intro);
		expect(aboutOf(container)).toContain(TEXTS.defaults.intro);
		expect(container.textContent).toContain('default notice notes');
		expect(container.querySelector('[data-ss-page] h2, #section-notes h3')).toBeNull();
		// the sidebar: every feature, then the texts by screen, and Recent changes (the theme and Format are the Portal's)
		expect(navLinks(container)).toEqual(['Notes', 'Hello1 text · 1 changed', 'Recent changes']);
		await act(async () => byText(container, 'Reset', 'button').click());
		openSection(container, 'text-hello');
		expect(crumbsOf(container)).toEqual(['Notes', 'Defaults', 'Hello']);
		// a text is a field in place, reset at once
		expect(byLabel(container, 'Hello').value).toBe('Hey');
		await act(async () => byText(container, TEXTS.reset, 'button').click());
		await settle();
		expect(requests.filter((request) => request.method === 'PUT')).toEqual([
			{ method: 'PUT', path: '/v1/dashboard/defaults/notes.greeting', body: { value: null } },
			{ method: 'PUT', path: '/v1/dashboard/defaults/text.hello.title', body: { value: null } },
		]);
		// the settings and the texts share one Save bar
		type(byLabel(container, 'Hello'), 'Howdy');
		openSection(container, 'notes');
		type(byLabel(container, 'Greeting'), 'Yo');
		expect(buttonsOf(container, 'Save changes')).toHaveLength(1);
		await act(async () => buttonsOf(container, 'Save changes')[0]?.click());
		await settle();
		expect(requests.filter((request) => request.method === 'PUT').slice(2)).toEqual([
			{ method: 'PUT', path: '/v1/dashboard/defaults/notes.greeting', body: { value: 'Yo' } },
			{ method: 'PUT', path: '/v1/dashboard/defaults/text.hello.title', body: { value: 'Howdy' } },
		]);
		expect(buttonsOf(container, 'Save changes')).toHaveLength(0);
		// Recent changes is rich rows, without a card or an ol
		openSection(container, 'changes');
		expect(crumbsOf(container)).toEqual(['Notes', 'Defaults', 'Recent changes']);
		const changes = /** @type {HTMLElement} */ (container.querySelector('#section-changes [data-ss-row]'));
		expect(changes.textContent).toContain('Alex');
		expect(changes.textContent).toContain('Changed the default greeting');
		expect(container.querySelector('#section-changes ol, #section-changes ul')).toBeNull();
		cleanup();
		render(inDashboard(<DefaultsTab />));
		await settle();
		expect(document.body.textContent).not.toContain('default notice');
	});

	it('Prices: by category, reads each price as credits, refuses a bad one, saves them all', async () => {
		/** @type {any} */
		let saved = ok({});
		serve({
			'GET /v1/dashboard/prices': ok({
				features: FEATURES,
				recentChanges: [{ who: { name: 'Alex' }, detail: 'Changed the price of Notes', at: '2026-10-04T14:30:00.000Z' }],
			}),
			'PUT /v1/dashboard/prices': () => saved,
		});
		const { container } = render(
			inDashboard(<PricesTab />, [
				{ title: 'Writing', features: ['notes'] },
				{ title: 'Reading', features: ['inbox', 'alerts'] },
			]),
		);
		await settle();
		expect(navLinks(container)).toEqual(['Writing', 'Reading', TEXTS.reseal.title, 'Recent changes']);
		expect(crumbsOf(container)).toEqual(['Notes', 'Prices', 'Writing']);
		expect(container.querySelector('h1')?.textContent).toBe('Writing');
		// no heading and no description in the body: what the prices are is behind the (i)
		expect(container.querySelector('#section-prices-writing h2, #section-prices-writing h3')).toBeNull();
		expect(container.textContent).not.toContain(TEXTS.prices.intro);
		expect(aboutOf(container)).toContain(TEXTS.prices.intro);
		expect(byLabel(container, 'Notes').value).toBe('1');
		expect(container.textContent).not.toContain('You have unsaved prices');
		type(byLabel(container, 'Notes'), '1.5');
		expect(container.textContent).toContain('You have unsaved prices');
		// the category with a price not saved yet says how many in the sidebar
		expect(navLinks(container)).toEqual(['WritingChanged1', 'Reading', TEXTS.reseal.title, 'Recent changes']);
		openSection(container, 'prices-reading');
		expect(crumbsOf(container)).toEqual(['Notes', 'Prices', 'Reading']);
		type(byLabel(container, 'Inbox'), 'lots');
		await act(async () => button('Save').click());
		await settle();
		// a price that is not credits is refused, nothing is sent
		expect(requests.some((request) => request.method === 'PUT')).toBe(false);
		type(byLabel(container, 'Inbox'), '2.5');
		await act(async () => button('Save').click());
		await settle();
		expect(requests.find((request) => request.method === 'PUT')?.body).toEqual({
			prices: { notes: 1500, inbox: 2500, alerts: 250 },
		});
		expect(byLabel(container, 'Inbox').value).toBe('0.5');
		saved = { status: 403, body: { status: 403, code: 'product_rule', title: 'Owners only' } };
		type(byLabel(container, 'Inbox'), '3');
		await act(async () => button('Save').click());
		await settle();
		expect(container.textContent).toContain('Owners only');
		expect(byLabel(container, 'Inbox').value).toBe('3');
		openSection(container, 'security');
		expect(crumbsOf(container)).toEqual(['Notes', 'Prices', TEXTS.reseal.title]);
		expect(container.querySelector('#section-security h2, #section-security h3')).toBeNull();
		expect(container.querySelector('#section-security')?.textContent).not.toContain(TEXTS.reseal.intro);
		expect(aboutOf(container)).toContain(TEXTS.reseal.intro);
		expect(button(TEXTS.reseal.button)).toBeTruthy();
		// Recent changes is rich rows
		openSection(container, 'changes');
		expect(crumbsOf(container)).toEqual(['Notes', 'Prices', 'Recent changes']);
		expect(container.querySelector('#section-changes [data-ss-row]')).not.toBeNull();
	});
});

describe('ProductDashboard', () => {
	/**
	 * A session answer.
	 * @param {Record<string, unknown>} who
	 */
	const session = (who) =>
		ok({
			who,
			portalUrl: 'https://portal.example.com',
			branding: { name: 'Acme' },
			support: { channels: [{ type: /** @type {const} */ ('email'), label: 'Email', url: 'mailto:help@example.com' }] },
			switcher: [
				{ merchantName: 'Bright Shop', websites: [{ websiteId: 'p1', domain: 'bright.example.com' }] },
				{ merchantName: 'Other', websites: [{ websiteId: 'p2', domain: 'other.example.com' }] },
			],
		});
	const OWNER = { kind: 'admin', id: 'a1', name: 'Alex', role: 'portal_owner' };
	// React names the section's view transition with CSS.escape, which jsdom lacks
	beforeEach(() => vi.stubGlobal('CSS', { escape: (/** @type {string} */ text) => text }));
	const MERCHANT = { kind: 'merchant', id: 'm1', name: 'Sam' };

	/** The labels of the sidebar. */
	const sidebar = () => [...document.querySelectorAll('nav[aria-label="Main"] a')].map((link) => link.textContent?.trim());

	/** The sidebar item of the section shown. */
	const current = () => document.querySelector('nav[aria-label="Main"] [aria-current="page"]')?.textContent?.trim();

	it('shows the loading state, then the sign-in hint or the problem when there is no session', async () => {
		serve({ 'GET /v1/dashboard/session': { status: 401, body: { status: 401 } } });
		const { container } = render(<ProductDashboard manifest={MANIFEST} texts={TEXTS} />);
		// the page's own skeleton: the same header and panes as the page that is coming
		expect(container.querySelector('[role="status"]')?.textContent).toBe(TEXTS.loading);
		expect(container.querySelector('[data-ss-page][aria-busy="true"]')).not.toBeNull();
		await settle();
		expect(container.textContent).toContain(TEXTS.signedOut);
		cleanup();
		serve({ 'GET /v1/dashboard/session': { status: 500, body: { status: 500, code: 'product_rule', title: 'Down' } } });
		const second = render(<ProductDashboard manifest={MANIFEST} texts={TEXTS} />);
		await settle();
		expect(second.container.textContent).toContain('Down');
	});

	it('a merchant gets the five website tabs, picks a website, and switches sections inside the page', async () => {
		/** @type {Array<{ props: TabProps, tab: string }>} */
		const seen = [];
		/** @param {string} tab */
		const probe = (tab) =>
			function Probe(/** @type {TabProps} */ props) {
				seen.push({ props, tab });
				return (
					<p>
						{`${tab} of ${props.websiteId} on ${props.domain}`}
						<button type="button" onClick={() => props.open('settings')}>
							open settings
						</button>
					</p>
				);
			};
		serve({ 'GET /v1/dashboard/session': session(MERCHANT) });
		const tabs = { overview: probe('overview'), settings: probe('settings') };
		render(<ProductDashboard manifest={MANIFEST} texts={TEXTS} tabs={tabs} />);
		await settle();
		expect(sidebar()).toEqual(['Overview', 'Settings', 'Texts', 'Developers']);
		expect(document.body.textContent).toContain(TEXTS.pickWebsite);
		expect(document.body.textContent).toContain('Notes');
		// Back to Portal and the docs sit at the bottom of the sidebar, not in a header that pages replace
		const portal = document.querySelector('[data-ss-part="sidebar-bottom"] a[href="https://portal.example.com"]');
		expect(portal?.textContent).toBe(TEXTS.backToPortal);
		const docs = document.querySelector('[data-ss-part="sidebar-bottom"] a[href="/docs"]');
		expect(docs?.textContent).toBe(TEXTS.developers.openDocs);
		const picker = /** @type {HTMLSelectElement} */ (document.querySelector('select'));
		expect([...picker.options].map((option) => option.textContent)).toEqual([
			TEXTS.pickWebsite,
			'bright.example.com',
			'other.example.com',
		]);
		type(picker, 'p1');
		await settle();
		expect(window.location.search).toBe('?websiteId=p1&view=overview');
		expect(document.body.textContent).toContain('overview of p1 on bright.example.com');
		expect(document.querySelector('header nav[aria-label="Breadcrumb"]')?.textContent).toContain('bright.example.com');
		expect(document.body.textContent).not.toContain('Admin view');
		await act(async () => button('open settings').click());
		await settle();
		expect(window.location.search).toBe('?websiteId=p1&view=settings');
		expect(current()).toBe('Settings');
		// a sidebar link switches inside the page; with a modifier key it is left to the browser
		const overview = /** @type {HTMLAnchorElement} */ ([...document.querySelectorAll('nav[aria-label="Main"] a')][0]);
		const opened = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
		act(() => {
			overview.dispatchEvent(opened);
		});
		expect(window.location.search).toBe('?websiteId=p1&view=settings');
		click(overview);
		await settle();
		expect(window.location.search).toBe('?websiteId=p1&view=overview');
		expect(current()).toBe('Overview');
		// Back follows the address
		window.history.replaceState(null, '', '?websiteId=p1&view=settings');
		await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));
		await settle();
		expect(current()).toBe('Settings');
		expect(seen.at(-1)?.props.who).toEqual(MERCHANT);
		// the Owner tabs are not a merchant's: an address naming one opens the Overview
		window.history.replaceState(null, '', '?websiteId=p1&view=prices');
		await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));
		await settle();
		expect(current()).toBe('Overview');
	});

	it("shows a website's dates and numbers in its Format locale (the words stay US English)", async () => {
		function Probe() {
			const locale = useDisplayLocale();
			return <p>{`locale ${locale}: ${formatCredits(1234500, { locale })}`}</p>;
		}
		serve({
			'GET /v1/dashboard/session': session(MERCHANT),
			'GET /v1/dashboard/websites/p1/format': ok({ format: { locale: 'de-DE' }, sources: {} }),
			'GET /v1/dashboard/websites/p2/format': ok({ format: { locale: '' }, sources: {} }),
		});
		window.history.replaceState(null, '', '?websiteId=p1&view=overview');
		render(<ProductDashboard manifest={MANIFEST} texts={TEXTS} tabs={{ overview: Probe }} />);
		await settle();
		await settle();
		expect(document.body.textContent).toContain('locale de-DE: 1.234,5 credits');
		window.history.replaceState(null, '', '?websiteId=p2&view=overview');
		await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));
		await settle();
		await settle();
		expect(document.body.textContent).toContain('locale en-US: 1,234.5 credits');
	});

	it('an Owner gets Defaults and Prices (no website needed), the merchant names, the Admin view banner and new tabs', async () => {
		serve({ 'GET /v1/dashboard/session': session(OWNER) });
		window.history.replaceState(null, '', '/dashboard');
		/** @param {TabProps} props */
		const Plain = (props) => <p>{`tab for ${props.websiteId}`}</p>;
		render(
			<ProductDashboard
				manifest={MANIFEST}
				texts={dashboardTexts({ title: 'Notes', tabs: { lists: 'Lists', audit: 'Audit' } })}
				tabs={{
					defaults: Plain,
					prices: Plain,
					overview: Plain,
					lists: { component: Plain, icon: 'sliders', kind: 'settings' },
					audit: { component: Plain, icon: 'clock', kind: 'activity', global: true },
				}}
			/>,
		);
		await settle();
		expect(sidebar()).toEqual(['Overview', 'Settings', 'Texts', 'Developers', 'Lists', 'Defaults', 'Prices', 'Audit']);
		expect(current()).toBe('Defaults');
		expect(document.body.textContent).toContain('tab for null');
		const picker = /** @type {HTMLSelectElement} */ (document.querySelector('select'));
		expect([...picker.options].map((option) => option.textContent).slice(1)).toEqual([
			'Bright Shop / bright.example.com',
			'Other / other.example.com',
		]);
		// picking a website from an Owner tab opens its Overview
		type(picker, 'p2');
		await settle();
		expect(window.location.search).toBe('?websiteId=p2&view=overview');
		expect(document.body.textContent).toContain('Editing as admin: changes go live on other.example.com');
		const adminNote = document.querySelector('[data-ss-part="sidebar-bottom"] p');
		expect(adminNote?.className).toContain('text-warning');
		expect(adminNote?.className).toContain('bg-warning-soft');
		expect(document.body.textContent).toContain('tab for p2');
		// from a website tab, the same tab of the other website
		click(/** @type {HTMLElement} */ ([...document.querySelectorAll('nav[aria-label="Main"] a')][4]));
		await settle();
		type(picker, 'p1');
		await settle();
		expect(window.location.search).toBe('?websiteId=p1&view=lists');
		// a website that is not in the switcher: pick one
		window.history.replaceState(null, '', '?websiteId=gone&view=lists');
		await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));
		await settle();
		expect(document.body.textContent).toContain(TEXTS.pickWebsite);
	});

	it('opens a sub-page of the tab it is on from a link, with one history entry and no page reload', async () => {
		const Parts = () => (
			<SectionsPage
				tab="settings"
				sections={[
					{ id: 'one', label: 'One', content: <p>first part</p> },
					{ id: 'two', label: 'Two', content: <p>second part</p> },
				]}
			/>
		);
		serve({ 'GET /v1/dashboard/session': session(MERCHANT) });
		window.history.replaceState(null, '', '?websiteId=p1&view=settings');
		render(<ProductDashboard manifest={MANIFEST} texts={TEXTS} tabs={{ settings: Parts }} />);
		await settle();
		const before = window.history.length;
		click(/** @type {HTMLElement} */ (document.querySelector('[role="option"][data-ss-id="two"]')));
		await settle();
		expect(window.location.search).toBe('?websiteId=p1&view=settings');
		expect(window.location.hash).toBe('#two');
		expect(window.history.length).toBe(before + 1);
		expect(document.querySelector('h1')?.textContent).toBe('Two');
		// the tab's crumb leads back to its first sub-page
		click(
			/** @type {HTMLElement} */ (
				document.querySelector('nav[aria-label="Breadcrumb"] a[href="?websiteId=p1&view=settings"]')
			),
		);
		await settle();
		expect(window.location.hash).toBe('');
		expect(document.querySelector('h1')?.textContent).toBe('One');
	});

	it('an old link to the Features tab opens Settings, where the features are now', async () => {
		/** @param {TabProps} props */
		const Where = (props) => <p>{`settings of ${props.websiteId}`}</p>;
		serve({ 'GET /v1/dashboard/session': session(MERCHANT) });
		window.history.replaceState(null, '', '?websiteId=p1&view=features');
		render(<ProductDashboard manifest={MANIFEST} texts={TEXTS} tabs={{ settings: Where }} />);
		await settle();
		expect(current()).toBe('Settings');
		expect(document.body.textContent).toContain('settings of p1');
	});

	it('an old link to the Connections tab opens Developers, where the connections are now', async () => {
		/** @param {TabProps} props */
		const Where = (props) => <p>{`developers of ${props.websiteId}`}</p>;
		serve({ 'GET /v1/dashboard/session': session(MERCHANT) });
		window.history.replaceState(null, '', '?websiteId=p1&view=connections#connection-database');
		render(<ProductDashboard manifest={MANIFEST} texts={TEXTS} tabs={{ developers: Where }} />);
		await settle();
		expect(current()).toBe('Developers');
		expect(document.body.textContent).toContain('developers of p1');
		expect(sidebar()).not.toContain('Connections');
	});

	it('moves to a sub-page of the tab it is already on when another tab asks to open it', async () => {
		/** @type {TabProps['open'] | null} */
		let open = null;
		/** @param {TabProps} props */
		const Parts = (props) => {
			open = props.open;
			return (
				<SectionsPage
					tab="developers"
					sections={[
						{ id: 'one', label: 'One', content: <p>first part</p> },
						{ id: 'two', label: 'Two', content: <p>second part</p> },
					]}
				/>
			);
		};
		serve({ 'GET /v1/dashboard/session': session(MERCHANT) });
		window.history.replaceState(null, '', '?websiteId=p1&view=developers');
		render(<ProductDashboard manifest={MANIFEST} texts={TEXTS} tabs={{ developers: Parts }} />);
		await settle();
		await act(async () => /** @type {NonNullable<typeof open>} */ (open)('developers', 'two'));
		await settle();
		expect(document.querySelector('h1')?.textContent).toBe('Two');
	});

	it('refuses a new tab without its icon and kind', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		serve({ 'GET /v1/dashboard/session': session(OWNER) });
		/** @type {unknown} */
		let failure = null;
		try {
			render(<ProductDashboard manifest={MANIFEST} texts={TEXTS} tabs={{ lists: () => null }} />);
			await settle();
		} catch (error) {
			failure = error;
		}
		expect(String(failure)).toContain('the new tab “lists” needs { component, icon, kind }');
	});
});
