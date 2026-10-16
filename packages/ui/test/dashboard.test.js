// @vitest-environment jsdom
/**
 * `@ss/ui/dashboard`, the product dashboard every product shares: the dashboard API helpers, the product's words over
 * the shared ones, the shared pieces (loading, outcome, settings / texts / theme / Format forms, Re-seal), the standard
 * tabs with the product's own parts, and the whole page (session, sidebar for merchants and Owners, website switch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ConnectionsTab,
	DashboardProvider,
	DefaultsTab,
	DevelopersTab,
	FeaturesTab,
	FormatForm,
	Loaded,
	OverviewTab,
	Outcome,
	PricesTab,
	ProductDashboard,
	ResealCard,
	SettingsForms,
	SettingsTab,
	TextsForm,
	ThemeForm,
	call,
	fill,
	hasSettings,
	toneOf,
	useDashboard,
	useLoad,
	withDependents,
} from '../src/dashboard.js';
import { DASHBOARD_TEXTS, dashboardTexts, formatCredits, useDisplayLocale } from '../src/index.js';
import { act, allByRole, byLabel, byText, cleanup, click, render, type } from '../src/testing.js';

/** @typedef {import('../src/dashboard.js').TabProps} TabProps */
/** @typedef {{ status?: number, body?: unknown } | ((body: any) => { status?: number, body?: unknown })} Route */

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	window.history.replaceState(null, '', '/');
});

const MANIFEST = {
	features: [
		{ key: 'notes', name: 'Notes' },
		{ key: 'inbox', name: 'Inbox' },
		{ key: 'alerts', name: 'Alerts' },
	],
};
const TEXTS = dashboardTexts({ title: 'Notes', settings: { looksHelp: 'Our own words' } });

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

/** @param {import('react').ReactNode} node */
const inDashboard = (node) => (
	<DashboardProvider manifest={MANIFEST} texts={TEXTS}>
		{node}
	</DashboardProvider>
);

/**
 * The props a tab gets for a website.
 * @param {string} websiteId
 * @param {Partial<TabProps>} [parts]
 * @returns {TabProps}
 */
const tabProps = (websiteId, parts = {}) => ({
	websiteId,
	domain: 'shop.example.com',
	who: { kind: 'admin', id: 'a1', name: 'Alex Morgan', role: 'owner' },
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
		expect(await call('GET', '/a')).toEqual({ ok: false, problem: { status: 503 } });
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
			settings: { formatHelp: 'Chat format' },
			overview: { noBooking: { title: 'No booking URL' } },
			list: ['a', 'b'],
		});
		expect(own.title).toBe('Chat');
		expect(own.settings.formatHelp).toBe('Chat format');
		expect(own.settings.theme).toBe(DASHBOARD_TEXTS.settings.theme);
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
		expect(container.innerHTML).toBe('');
	});

	it('TextsForm finds, saves and resets a text (DELETE for a website, PUT null for defaults)', async () => {
		serve({
			'PUT /t/greeting.hello': ok({}),
			'DELETE /t/greeting.hello': { status: 204 },
			'PUT /dt/greeting.hello': ok({}),
			'PUT /t/button.send': { status: 422, body: { status: 422, code: 'product_rule', title: 'Keep {name}' } },
		});
		const reload = vi.fn();
		const texts = [
			{ key: 'greeting.hello', english: 'Hello {name}', value: 'Hi {name}', source: 'website' },
			{ key: 'button.send', english: 'Send', value: 'Send', source: 'default' },
		];
		const { container, rerender } = render(
			inDashboard(
				<TextsForm texts={texts} saveUrl={(key) => `/t/${key}`} resetBody={false} savedSource="website" reload={reload} />,
			),
		);
		type(byLabel(container, TEXTS.settings.textsFilter), 'SEND');
		expect(container.textContent).not.toContain('Hello {name}');
		expect(container.textContent).toContain('Send');
		type(byLabel(container, TEXTS.settings.textsFilter), '');
		const hello = /** @type {HTMLInputElement} */ (
			container.querySelector('input[aria-describedby="text-greeting-hello-english"]')
		);
		expect(hello.value).toBe('Hi {name}');
		type(hello, 'Hey {name}');
		const saves = buttonsOf(container, 'Save');
		await act(async () => saves[0]?.click());
		expect(requests.at(-1)).toEqual({ method: 'PUT', path: '/t/greeting.hello', body: { value: 'Hey {name}' } });
		expect(container.textContent).toContain('Saved');
		const send = /** @type {HTMLInputElement} */ (
			container.querySelector('input[aria-describedby="text-button-send-english"]')
		);
		type(send, 'Go');
		await act(async () => saves[1]?.click());
		expect(container.textContent).toContain('Keep {name}');
		expect(send.value).toBe('Go');
		await act(async () => button(TEXTS.reset).click());
		expect(requests.at(-1)).toEqual({ method: 'DELETE', path: '/t/greeting.hello', body: undefined });
		rerender(
			inDashboard(<TextsForm texts={texts} saveUrl={(key) => `/dt/${key}`} resetBody savedSource="website" reload={reload} />),
		);
		await act(async () => button(TEXTS.reset).click());
		expect(requests.at(-1)).toEqual({ method: 'PUT', path: '/dt/greeting.hello', body: { value: null } });
		expect(reload).toHaveBeenCalledTimes(4);
	});

	it('ThemeForm and FormatForm save their draft and show the outcome', async () => {
		const reload = vi.fn();
		const saveTheme = vi.fn(async () => /** @type {const} */ ({ ok: true, data: null }));
		const theme = { colors: {}, fontFamily: 'inherit', radius: 8, mode: 'auto', customCss: '' };
		const { container } = render(inDashboard(<ThemeForm theme={theme} save={saveTheme} reload={reload} />));
		click(byLabel(container, TEXTS.settings.modes.dark));
		type(byLabel(container, TEXTS.settings.fontFamily), 'Inter');
		type(byLabel(container, TEXTS.settings.radius), '12');
		type(byLabel(container, TEXTS.settings.accent), '#112233');
		type(byLabel(container, TEXTS.settings.customCss), '.x{}');
		expect(byLabel(container, TEXTS.settings.accent).value).toBe('#112233');
		await act(async () => button('Save').click());
		expect(saveTheme).toHaveBeenCalledWith({
			colors: { accent: '#112233' },
			fontFamily: 'Inter',
			radius: 12,
			mode: 'dark',
			customCss: '.x{}',
		});
		expect(container.textContent).toContain('Saved');
		cleanup();
		const saveFormat = vi.fn(
			async () => /** @type {const} */ ({ ok: false, problem: { status: 422, code: 'product_rule', title: 'Bad locale' } }),
		);
		const format = {
			locale: '',
			currencyDisplay: 'code',
			currencySymbols: { CHF: 'Fr.' },
			wholeUnits: false,
			times: 'viewer',
		};
		const second = render(inDashboard(<FormatForm format={format} save={saveFormat} reload={reload} />));
		type(byLabel(second.container, TEXTS.settings.locale), ' fr-FR ');
		click(byLabel(second.container, TEXTS.settings.currencyDisplays.symbol));
		// one symbol per currency (K5): add PKR, keep CHF, a row without a symbol is left out
		await act(async () => button(TEXTS.settings.addSymbol).click());
		await act(async () => button(TEXTS.settings.addSymbol).click());
		const rows = second.container.querySelectorAll('li');
		type(byLabel(/** @type {HTMLElement} */ (rows[1]), TEXTS.settings.currency), 'pkr');
		type(byLabel(/** @type {HTMLElement} */ (rows[1]), TEXTS.settings.symbol), 'Rs');
		type(byLabel(/** @type {HTMLElement} */ (rows[2]), TEXTS.settings.currency), 'EUR');
		click(byLabel(second.container, TEXTS.settings.timesOptions.business));
		click(byLabel(second.container, TEXTS.settings.wholeUnits));
		await act(async () => button('Save').click());
		expect(saveFormat).toHaveBeenCalledWith({
			locale: 'fr-FR',
			currencyDisplay: 'symbol',
			currencySymbols: { CHF: 'Fr.', PKR: 'Rs' },
			wholeUnits: true,
			times: 'business',
		});
		expect(second.container.textContent).toContain('Bad locale');
		expect(reload).toHaveBeenCalledTimes(2);
	});

	it('ResealCard reports what was re-sealed, websites to try again, or the problem', async () => {
		/** @type {any} */
		let answer = ok({ resealed: 3, current: 1, unreadable: 0, failedWebsites: [] });
		serve({ 'POST /v1/dashboard/reseal': () => answer });
		const { container } = render(inDashboard(<ResealCard />));
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
				website: { domain: 'shop.example.com' },
				status: { status: 'active', graceEndsAt: null },
				featuresOn: ['notes'],
				todayMillicredits: 1000,
				checklist: { connections: [], widget: null, business: { found: false } },
				recentChanges: [],
			}),
			[`POST ${base}/business/refresh`]: ok({}),
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
		expect(container.textContent).toContain('Welcome back, Alex Morgan');
		expect(container.textContent).toContain('No widgets yet');
		expect(container.textContent).toContain('own part');
		await act(async () => button('Check again').click());
		await settle();
		expect(requests.filter((request) => request.method === 'POST')).toEqual([
			{ method: 'POST', path: `${base}/business/refresh`, body: undefined },
		]);
		expect(requests.filter((request) => request.path === `${base}/overview`)).toHaveLength(2);
		// without useMore: the kit Overview alone
		cleanup();
		const plain = render(inDashboard(<OverviewTab {...tabProps(id)} />));
		await settle();
		expect(plain.container.textContent).not.toContain('own part');
	});

	it('Features: admins switch a feature off with the ones that need it, see warnings and confirm the cost', async () => {
		const id = freshSite();
		const base = `/v1/dashboard/websites/${id}`;
		serve({
			[`GET ${base}/features`]: ok({ features: FEATURES }),
			[`GET ${base}/connections`]: ok({
				connections: [{ name: 'database', label: 'Database', neededBy: ['inbox'], status: 'test_failed' }],
			}),
			[`PUT ${base}/features`]: ok({}),
		});
		const { container } = render(
			inDashboard(
				<FeaturesTab {...tabProps(id)} warnings={(on) => (on.includes('notes') ? [] : ['Nothing starts a note.'])} />,
			),
		);
		await settle();
		expect(container.textContent).toContain('Price: 1 credits/h');
		expect(container.textContent).toContain('Needs: Notes');
		expect(container.textContent).toContain('Not working: connect Database');
		const boxes = /** @type {HTMLButtonElement[]} */ ([...container.querySelectorAll('[role="switch"]')]);
		const checks = () => boxes.map((box) => box.getAttribute('aria-checked') === 'true');
		expect(checks()).toEqual([true, true, false]);
		// Alerts needs Inbox (on): it can be switched on; Save is enabled only once something changed
		expect(boxes[2]?.disabled).toBe(false);
		expect(/** @type {HTMLButtonElement} */ (button('Save')).disabled).toBe(true);
		click(/** @type {HTMLElement} */ (boxes[2]));
		click(/** @type {HTMLElement} */ (boxes[0]));
		expect(checks()).toEqual([false, false, false]);
		expect(container.textContent).toContain('Nothing starts a note.');
		click(button('Save'));
		const dialog = /** @type {HTMLElement} */ (document.querySelector('[role="dialog"]'));
		expect(dialog.textContent).toContain('New hourly cost: 0 credits/h');
		expect(dialog.textContent).toContain('Also turned off: Notes, Inbox');
		expect(dialog.textContent).toContain('Nothing starts a note.');
		await act(async () => byText(dialog, 'Save', 'button').click());
		await settle();
		expect(requests.find((request) => request.method === 'PUT')).toEqual({
			method: 'PUT',
			path: `${base}/features`,
			body: { on: [] },
		});
		expect(container.textContent).toContain('Saved');
		// merchants read them only, and are told whom to contact
		cleanup();
		const merchant = render(
			inDashboard(<FeaturesTab {...tabProps(id, { who: { kind: 'merchant', id: 'm1', name: 'Sam' } })} />),
		);
		await settle();
		expect(merchant.container.textContent).toContain('To change features, contact help@example.com (Email).');
		expect(
			[...merchant.container.querySelectorAll('[role="switch"]')].every(
				(box) => /** @type {HTMLButtonElement} */ (box).disabled,
			),
		).toBe(true);
		expect(merchant.container.textContent).not.toContain('Save');
	});

	it('Features: a failed save keeps the picks and shows the problem; Cancel closes', async () => {
		const id = freshSite();
		const base = `/v1/dashboard/websites/${id}`;
		serve({
			[`GET ${base}/features`]: ok({ features: FEATURES.map((feature) => ({ ...feature, on: false })) }),
			[`GET ${base}/connections`]: { status: 500 },
			[`PUT ${base}/features`]: { status: 409, body: { status: 409, code: 'product_rule', title: 'No credits' } },
		});
		const { container } = render(inDashboard(<FeaturesTab {...tabProps(id)} />));
		await settle();
		const boxes = /** @type {HTMLButtonElement[]} */ ([...container.querySelectorAll('[role="switch"]')]);
		// Inbox needs Notes, which is off
		expect(boxes[1]?.disabled).toBe(true);
		click(/** @type {HTMLElement} */ (boxes[0]));
		click(button('Save'));
		click(byText(/** @type {HTMLElement} */ (document.querySelector('[role="dialog"]')), 'Cancel', 'button'));
		await settle();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		click(button('Save'));
		await act(async () =>
			byText(/** @type {HTMLElement} */ (document.querySelector('[role="dialog"]')), 'Save', 'button').click(),
		);
		await settle();
		expect(container.textContent).toContain('No credits');
		expect(boxes[0]?.getAttribute('aria-checked')).toBe('true');
	});

	it('Settings: the product sections, the feature forms with its notice and cards, then texts, theme and Format', async () => {
		const id = freshSite();
		const base = `/v1/dashboard/websites/${id}`;
		serve({
			[`GET ${base}/settings`]: ok({
				features: [{ key: 'notes', name: 'Notes', schema: SCHEMA, values: { greeting: { value: 'Hi', source: 'default' } } }],
			}),
			[`GET ${base}/texts`]: ok({ texts: [{ key: 'hello', english: 'Hello', value: 'Hello', source: 'default' }] }),
			[`GET ${base}/theme`]: ok({
				theme: { colors: { accent: '#000000' }, fontFamily: 'inherit', radius: 4, mode: 'auto', customCss: '' },
			}),
			[`GET ${base}/format`]: ok({
				format: { locale: '', currencyDisplay: 'code', currencySymbols: {}, wholeUnits: false, times: 'viewer' },
			}),
			[`PUT ${base}/settings/notes.greeting`]: ok({}),
			[`PUT ${base}/texts/hello`]: ok({}),
			[`PUT ${base}/theme`]: ok({}),
			[`PUT ${base}/format`]: ok({}),
		});
		const { container } = render(
			inDashboard(
				<SettingsTab
					{...tabProps(id)}
					sections={<section>own section</section>}
					notice={(key) => <p>{`notice for ${key}`}</p>}
					featureCards={(features) => <p>{`cards for ${features.length}`}</p>}
				/>,
			),
		);
		await settle();
		expect(container.textContent?.indexOf('own section')).toBe(0);
		expect(container.textContent).toContain('notice for notes');
		expect(container.textContent).toContain('cards for 1');
		expect(container.textContent).toContain('Our own words');
		type(/** @type {HTMLInputElement} */ (container.querySelector('[data-field="greeting"] input')), 'Hey');
		type(/** @type {HTMLInputElement} */ (container.querySelector('input[aria-describedby="text-hello-english"]')), 'Howdy');
		for (const save of [...buttonsOf(container, 'Save changes'), ...buttonsOf(container, 'Save')])
			await act(async () => save.click());
		await settle();
		expect(requests.filter((request) => request.method === 'PUT').map((request) => request.path)).toEqual([
			`${base}/settings/notes.greeting`,
			`${base}/texts/hello`,
			`${base}/theme`,
			`${base}/format`,
		]);
		// without the product parts: the kit's forms only
		cleanup();
		const plain = render(inDashboard(<SettingsTab {...tabProps(id)} />));
		await settle();
		expect(plain.container.textContent).not.toContain('notice for');
		expect(plain.container.textContent).toContain('Notes');
	});

	it('Connections: saves and tests a value, removes after a confirmation, with the product forms and hints', async () => {
		const id = freshSite();
		const base = `/v1/dashboard/websites/${id}/connections`;
		serve({
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
					{ name: 'mail', label: 'Mail', kind: 'token', neededBy: [], status: 'not_connected' },
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
				<ConnectionsTab
					{...tabProps(id)}
					hint={(name) => (name === 'database' ? 'Your MongoDB address.' : null)}
					form={(item, save) =>
						item.name === 'storage' ? (
							<button type="button" onClick={() => void save({ bucket: 'b' })}>
								Save storage
							</button>
						) : null
					}
				/>,
			),
		);
		await settle();
		expect(container.textContent).toContain('Needed by: Notes, Inbox');
		expect(container.textContent).toContain('Optional');
		expect(container.textContent).toContain('••••abcd');
		expect(container.textContent).toContain('Fine');
		expect(container.textContent).toContain('Your MongoDB address.');
		expect(container.textContent).toContain('Test failed');
		const token = byLabel(container, TEXTS.connections.token);
		expect(byLabel(container, TEXTS.connections.value)).toBeTruthy();
		type(token, '  secret  ');
		const mailCard = /** @type {HTMLElement} */ (token.closest('section, article, div[class*="rounded-card"]') ?? container);
		await act(async () => byText(mailCard, TEXTS.connections.save, 'button').click());
		await settle();
		expect(requests.find((request) => request.method === 'PUT')).toEqual({
			method: 'PUT',
			path: `${base}/mail`,
			body: { value: 'secret' },
		});
		expect(token.value).toBe('');
		await act(async () => button('Save storage').click());
		await settle();
		expect(requests.filter((request) => request.method === 'PUT').at(-1)).toEqual({
			method: 'PUT',
			path: `${base}/storage`,
			body: { value: { bucket: 'b' } },
		});
		await act(async () => buttonsOf(container, TEXTS.connections.test)[0]?.click());
		await settle();
		expect(container.textContent).toContain('Cannot reach it');
		// Remove sits in the menu of what is saved (not of Mail, which has nothing saved), after a confirmation
		const menus = /** @type {HTMLElement[]} */ ([...container.querySelectorAll('button[aria-haspopup="menu"]')]);
		expect(menus.map((menu) => menu.getAttribute('aria-label'))).toEqual([
			'More actions for Database',
			'More actions for Storage',
		]);
		click(/** @type {HTMLElement} */ (menus[0]));
		click(/** @type {HTMLElement} */ (allByRole(container, 'menuitem')[0]));
		const dialog = /** @type {HTMLElement} */ (document.querySelector('[role="dialog"]'));
		expect(dialog.textContent).toContain('Remove Database?');
		click(byText(dialog, 'Cancel', 'button'));
		await settle();
		expect(requests.some((request) => request.method === 'DELETE')).toBe(false);
		click(/** @type {HTMLElement} */ (menus[0]));
		click(/** @type {HTMLElement} */ (allByRole(container, 'menuitem')[0]));
		await act(async () =>
			byText(/** @type {HTMLElement} */ (document.querySelector('[role="dialog"]')), 'Remove', 'button').click(),
		);
		await settle();
		expect(requests.filter((request) => request.method === 'DELETE')).toEqual([
			{ method: 'DELETE', path: `${base}/database`, body: undefined },
		]);
	});

	it('Connections: says when there are none', async () => {
		const id = freshSite();
		serve({ [`GET /v1/dashboard/websites/${id}/connections`]: ok({ connections: [] }) });
		const { container } = render(inDashboard(<ConnectionsTab {...tabProps(id)} />));
		await settle();
		expect(container.textContent).toContain(TEXTS.connections.none);
	});

	it('Developers: the docs, website id and tokens, then the product sections or the widget script', async () => {
		const id = freshSite();
		serve({ [`GET /v1/dashboard/websites/${id}/features`]: ok({ features: FEATURES }) });
		const { container } = render(inDashboard(<DevelopersTab {...tabProps(id)} />));
		await settle();
		expect(container.textContent).toContain(`This website’s id: ${id}`);
		expect(container.textContent).toContain('Alerts (off)');
		expect(container.querySelector('a[href="/docs#feature-notes"]')).not.toBeNull();
		expect(container.querySelector('a[href="https://portal.example.com"]')?.textContent).toBe(TEXTS.developers.manageTokens);
		expect(container.textContent).toContain(`${window.location.origin}/widget.js`);
		cleanup();
		const own = render(
			inDashboard(
				<DevelopersTab {...tabProps(id)} links={<a href="/docs#seo">SEO</a>}>
					<section>own sections</section>
				</DevelopersTab>,
			),
		);
		await settle();
		expect(own.container.textContent).toContain('own sections');
		expect(own.container.textContent).not.toContain('widget.js');
		expect(own.container.querySelector('a[href="/docs#seo"]')).not.toBeNull();
	});

	it('Defaults: the global settings (reset with PUT null), texts, theme and Format, with the product notice', async () => {
		serve({
			'GET /v1/dashboard/defaults': ok({
				features: [{ key: 'notes', name: 'Notes', schema: SCHEMA, values: { greeting: { value: 'Hi', source: 'default' } } }],
				texts: [{ key: 'hello', english: 'Hello', value: 'Hey', source: 'default' }],
				theme: { theme: { colors: {}, fontFamily: 'inherit', radius: 4, mode: 'auto', customCss: '' } },
				format: { format: { locale: '', currencyDisplay: 'code', currencySymbols: {}, wholeUnits: false, times: 'viewer' } },
				recentChanges: [],
			}),
			'PUT /v1/dashboard/defaults/notes.greeting': ok({}),
			'PUT /v1/dashboard/defaults/text.hello': ok({}),
			'PUT /v1/dashboard/defaults/theme': ok({}),
			'PUT /v1/dashboard/defaults/format': ok({}),
		});
		const { container } = render(inDashboard(<DefaultsTab notice={(key) => <p>{`default notice ${key}`}</p>} />));
		await settle();
		expect(container.textContent).toContain(TEXTS.defaults.intro);
		expect(container.textContent).toContain('default notice notes');
		await act(async () => byText(container, 'Reset', 'button').click());
		await act(async () => button(TEXTS.reset).click());
		const saves = buttonsOf(container, 'Save');
		for (const save of saves.slice(-2)) await act(async () => save.click());
		await settle();
		expect(requests.filter((request) => request.method === 'PUT')).toEqual([
			{ method: 'PUT', path: '/v1/dashboard/defaults/notes.greeting', body: { value: null } },
			{ method: 'PUT', path: '/v1/dashboard/defaults/text.hello', body: { value: null } },
			{
				method: 'PUT',
				path: '/v1/dashboard/defaults/theme',
				body: { value: { colors: {}, fontFamily: 'inherit', radius: 4, mode: 'auto', customCss: '' } },
			},
			{
				method: 'PUT',
				path: '/v1/dashboard/defaults/format',
				body: { value: { locale: '', currencyDisplay: 'code', currencySymbols: {}, wholeUnits: false, times: 'viewer' } },
			},
		]);
		cleanup();
		render(inDashboard(<DefaultsTab />));
		await settle();
		expect(document.body.textContent).not.toContain('default notice');
	});

	it('Prices: reads each price as credits, refuses a bad one, saves them all', async () => {
		/** @type {any} */
		let saved = ok({});
		serve({
			'GET /v1/dashboard/prices': ok({ features: FEATURES, recentChanges: [] }),
			'PUT /v1/dashboard/prices': () => saved,
		});
		const { container } = render(inDashboard(<PricesTab />));
		await settle();
		expect(byLabel(container, 'Notes').value).toBe('1');
		type(byLabel(container, 'Inbox'), 'lots');
		expect(/** @type {HTMLButtonElement} */ (button('Save')).disabled).toBe(true);
		type(byLabel(container, 'Inbox'), '2.5');
		await act(async () => button('Save').click());
		await settle();
		expect(requests.find((request) => request.method === 'PUT')?.body).toEqual({
			prices: { notes: 1000, inbox: 2500, alerts: 250 },
		});
		expect(byLabel(container, 'Inbox').value).toBe('0.5');
		saved = { status: 403, body: { status: 403, code: 'product_rule', title: 'Owners only' } };
		type(byLabel(container, 'Inbox'), '3');
		await act(async () => button('Save').click());
		await settle();
		expect(container.textContent).toContain('Owners only');
		expect(byLabel(container, 'Inbox').value).toBe('3');
		expect(container.textContent).toContain(TEXTS.reseal.title);
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
	const OWNER = { kind: 'admin', id: 'a1', name: 'Alex', role: 'owner' };
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
		expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe(TEXTS.loading);
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
		expect(sidebar()).toEqual(['Overview', 'Features', 'Settings', 'Connections', 'Developers']);
		expect(document.body.textContent).toContain(TEXTS.pickWebsite);
		expect(document.body.textContent).toContain('Notes');
		expect(document.querySelector('a[href="https://portal.example.com"]')?.textContent).toBe(TEXTS.backToPortal);
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
		expect(sidebar()).toEqual([
			'Overview',
			'Features',
			'Settings',
			'Connections',
			'Developers',
			'Lists',
			'Defaults',
			'Prices',
			'Audit',
		]);
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
		expect(document.body.textContent).toContain('Admin view: Other / other.example.com');
		expect(document.body.textContent).toContain('tab for p2');
		// from a website tab, the same tab of the other website
		click(/** @type {HTMLElement} */ ([...document.querySelectorAll('nav[aria-label="Main"] a')][5]));
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
