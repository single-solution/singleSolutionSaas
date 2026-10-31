// @vitest-environment jsdom
/**
 * The page frame of the dashboard (layout contract 2026-10-17): the breadcrumbs `Product › Section › sub-page` that
 * every tab draws, and `SectionsPage`, the one page with several views (a list of rich rows beside the page, each view
 * its own `#address`, with counts, dots and locks; a section with parts is one row whose page shows every part).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardProvider, dashboardTexts } from '../src/dashboard-parts.js';
import { FrameContext, LoadedPage, SectionsPage, useCrumbs } from '../src/dashboard-page.js';
import { act, allByRole, byText, cleanup, click, render, type } from '../src/testing.js';

afterEach(() => {
	cleanup();
	Reflect.deleteProperty(window, 'matchMedia');
	window.history.replaceState(null, '', '/');
});

/** Pretend the window is a phone (or not). @param {boolean} narrow */
const phone = (narrow) => {
	Object.defineProperty(window, 'matchMedia', {
		configurable: true,
		value: (/** @type {string} */ query) => ({
			matches: narrow && query.includes('max-width'),
			addEventListener: () => {},
			removeEventListener: () => {},
		}),
	});
};

const TEXTS = dashboardTexts({ title: 'Notes' });
const MANIFEST = { features: [] };

/** @param {import('react').ReactNode} node @param {{ hrefOf: (tab: string) => string, home: string } | null} [frame] */
const inDashboard = (node, frame = null) => (
	<DashboardProvider manifest={MANIFEST} texts={TEXTS}>
		<FrameContext.Provider value={frame}>{node}</FrameContext.Provider>
	</DashboardProvider>
);

/** @param {ParentNode} root */
const crumbsOf = (root) =>
	[...root.querySelectorAll('nav[aria-label="Breadcrumb"] li')].map((li) => li.textContent).filter(Boolean);

/** The rows of the list. @param {HTMLElement} root */
const rows = (root) => allByRole(root, 'option');

/** The text of each row of the list. @param {HTMLElement} root */
const rowTexts = (root) => rows(root).map((row) => row.textContent);

/** The row of a view. @param {HTMLElement} root @param {string} id */
const rowOf = (root, id) => /** @type {HTMLElement} */ (rows(root).find((row) => row.dataset.ssId === id));

/** @param {string} id */
const panel = (id) => /** @type {HTMLElement | null} */ (document.getElementById(`section-${id}`));

/** @returns {import('../src/blocks.js').SectionSpec[]} */
const SPECS = () => [
	{ id: 'one', label: 'One', group: 'First', badge: '3', content: <p>first body</p> },
	{ id: 'two', label: 'Two', group: 'First', status: 'attention', statusLabel: 'Needs setup', content: <p>second body</p> },
	{
		id: 'multi',
		label: 'Multi',
		group: 'Second',
		children: [
			{ id: 'multi.a', label: 'Part A', content: <p>part a body</p> },
			{ id: 'multi.b', label: 'Part B', content: <p>part b body</p> },
		],
	},
];

describe('the crumbs of a tab', () => {
	/** @param {{ tab: string, rest?: Array<{ label: string }> }} props */
	function Crumbs({ tab, rest = [] }) {
		const crumbs = useCrumbs();
		return <pre data-crumbs="">{JSON.stringify(crumbs(tab, ...rest))}</pre>;
	}

	it('are Product > Section > sub-page, each a link to the frame address', () => {
		const frame = { hrefOf: (/** @type {string} */ tab) => `?websiteId=w1&view=${tab}`, home: '?websiteId=w1&view=overview' };
		const { container } = render(inDashboard(<Crumbs tab="texts" rest={[{ label: 'Catalog' }]} />, frame));
		expect(JSON.parse(container.querySelector('[data-crumbs]')?.textContent ?? '[]')).toEqual([
			{ label: 'Notes', href: '?websiteId=w1&view=overview' },
			{ label: 'Texts', href: '?websiteId=w1&view=texts' },
			{ label: 'Catalog' },
		]);
	});

	it('are Product > Overview on the Overview', () => {
		const frame = { hrefOf: (/** @type {string} */ tab) => `?view=${tab}`, home: '?view=overview' };
		const { container } = render(inDashboard(<Crumbs tab="overview" />, frame));
		expect(JSON.parse(container.querySelector('[data-crumbs]')?.textContent ?? '[]')).toEqual([
			{ label: 'Notes', href: '?view=overview' },
			{ label: 'Overview' },
		]);
	});

	it('use a plain address of their own when no frame is around (a tab on its own)', () => {
		const { container } = render(inDashboard(<Crumbs tab="texts" />));
		expect(JSON.parse(container.querySelector('[data-crumbs]')?.textContent ?? '[]')).toEqual([
			{ label: 'Notes', href: '?view=overview' },
			{ label: 'Texts' },
		]);
	});
});

describe('SectionsPage', () => {
	it('draws a Page whose crumbs end in the open view, and the views as rich rows in the list beside it', () => {
		const frame = { hrefOf: (/** @type {string} */ tab) => `?view=${tab}`, home: '?view=overview' };
		const { container } = render(inDashboard(<SectionsPage tab="settings" sections={SPECS()} />, frame));
		expect(container.querySelector('[data-ss-page]')).not.toBeNull();
		expect(crumbsOf(container)).toEqual(['Notes', 'Settings', 'One']);
		expect(container.querySelector('h1')?.textContent).toBe('One');
		// a section with parts is ONE row; the badge is the row's value, the status its dot with its words
		expect(container.querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe('Settings');
		expect(rowTexts(container)).toEqual(['One3', 'TwoNeeds setup', 'Multi']);
		expect(container.querySelector('nav[aria-label="Settings"]')).toBeNull();
		// the first row is open
		expect(rowOf(container, 'one').getAttribute('aria-selected')).toBe('true');
		expect(rowOf(container, 'two').getAttribute('aria-selected')).toBe('false');
	});

	it('makes a row of the icon, the label, the status, the badge, the meta line and a lock', () => {
		const sections = [
			{
				id: 'a',
				label: 'Alpha',
				icon: /** @type {const} */ ('sliders'),
				status: /** @type {const} */ ('success'),
				statusLabel: 'On',
				badge: 4,
				meta: ['Line one', 'Line two'],
				content: <p>a</p>,
			},
			{
				id: 'b',
				label: 'Beta',
				locked: true,
				status: /** @type {const} */ ('danger'),
				statusLabel: 'Failing',
				meta: 'Only line',
				content: <p>b</p>,
			},
		];
		const { container } = render(inDashboard(<SectionsPage tab="settings" sections={sections} />));
		const [alpha, beta] = rows(container);
		expect(alpha?.textContent).toBe('AlphaOnLine one · Line two4');
		expect(alpha?.querySelector('svg')).not.toBeNull();
		expect(beta?.textContent).toBe('BetaFailingOnly lineLocked');
		expect(beta?.querySelector('[role="img"][aria-label="Locked"]')).not.toBeNull();
		expect(alpha?.querySelector('[role="img"]')).toBeNull();
		// a locked view is still opened
		click(/** @type {Element} */ (beta?.querySelector('[role="img"]')));
		expect(window.location.hash).toBe('#b');
	});

	it('opens a view from its row: its address is the hash, the page before is one Back away', async () => {
		const { container } = render(inDashboard(<SectionsPage tab="settings" sections={SPECS()} />));
		expect(panel('one')?.hidden).toBe(false);
		expect(panel('two')).toBeNull();
		click(rowOf(container, 'two'));
		expect(window.location.hash).toBe('#two');
		expect(panel('two')?.hidden).toBe(false);
		expect(panel('one')?.hidden).toBe(true);
		expect(container.querySelector('h1')?.textContent).toBe('Two');
		expect(rowOf(container, 'two').getAttribute('aria-selected')).toBe('true');
		window.history.back();
		await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
		expect(panel('one')?.hidden).toBe(false);
	});

	it('shows every part of a section with parts stacked under its own heading, all open', () => {
		window.history.replaceState(null, '', '/#multi');
		const { container } = render(inDashboard(<SectionsPage tab="settings" sections={SPECS()} />));
		expect(crumbsOf(container)).toEqual(['Notes', 'Settings', 'Multi']);
		expect(container.querySelector('h1')?.textContent).toBe('Multi');
		expect([...container.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['Part A', 'Part B']);
		expect(panel('multi')?.textContent).toBe('Part Apart a bodyPart Bpart b body');
		expect(panel('multi.b')?.getAttribute('aria-labelledby')).toBe('title-multi.b');
		expect(panel('multi')?.hidden).toBe(false);
	});

	it('opens the row of a part from the address of the part, or of anything deeper than the row', () => {
		window.history.replaceState(null, '', '/#multi.b');
		const { container } = render(inDashboard(<SectionsPage tab="settings" sections={SPECS()} />));
		expect(crumbsOf(container)).toEqual(['Notes', 'Settings', 'Multi']);
		expect(rowOf(container, 'multi').getAttribute('aria-selected')).toBe('true');
		cleanup();
		window.history.replaceState(null, '', '/#multi.something-old');
		const old = render(inDashboard(<SectionsPage tab="settings" sections={SPECS()} />));
		expect(crumbsOf(old.container)).toEqual(['Notes', 'Settings', 'Multi']);
	});

	it('takes the header parts of a section with parts from itself, else from its first part', () => {
		/** @type {import('../src/dashboard-page.js').Section[]} */
		const sections = [
			{
				id: 'a',
				label: 'A',
				children: [
					{ id: 'a.1', label: 'One', info: 'About one', facts: [{ label: 'On', value: '2' }], content: <p>1</p> },
					{ id: 'a.2', label: 'Two', info: 'About two', content: <p>2</p> },
				],
			},
			{ id: 'b', label: 'B', info: 'About b', toolbar: <p>tools of b</p>, content: <p>b</p> },
		];
		const { container } = render(inDashboard(<SectionsPage tab="features" sections={sections} />));
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="About this page"]')));
		expect(container.textContent).toContain('About one');
		expect(container.textContent).not.toContain('About two');
		expect(container.querySelector('[aria-label="Key numbers"]')?.textContent).toContain('2');
		cleanup();
		const own = render(
			inDashboard(
				<SectionsPage
					tab="features"
					sections={sections.map((section) => (section.id === 'a' ? { ...section, info: 'About a' } : section))}
				/>,
			),
		);
		click(/** @type {HTMLElement} */ (own.container.querySelector('button[aria-label="About this page"]')));
		expect(own.container.textContent).toContain('About a');
		expect(own.container.textContent).not.toContain('About one');
	});

	it('shows one section without any list, and its title is the tab', () => {
		const { container } = render(
			inDashboard(<SectionsPage tab="developers" sections={[{ id: 'only', label: 'Only', content: <p>just this</p> }]} />),
		);
		expect(container.querySelector('[role="listbox"]')).toBeNull();
		expect(crumbsOf(container)).toEqual(['Notes', 'Developers']);
		expect(byText(container, 'just this')).toBeTruthy();
	});

	it('keeps an opened view mounted, so an edit in it is not lost', () => {
		const { container } = render(inDashboard(<SectionsPage tab="settings" sections={SPECS()} />));
		click(rowOf(container, 'two'));
		click(rowOf(container, 'one'));
		expect(panel('two')?.hidden).toBe(true);
		expect(panel('two')?.textContent).toBe('second body');
	});

	it('shows what an open view says about itself behind the (i) and in the header', () => {
		const sections = [
			{ id: 'a', label: 'A', info: 'About A', facts: [{ label: 'On', value: '2' }], content: <p>a</p> },
			{ id: 'b', label: 'B', content: <p>b</p> },
		];
		const { container } = render(inDashboard(<SectionsPage tab="features" sections={sections} />));
		expect(container.querySelector('button[aria-label="About this page"]')).not.toBeNull();
		expect(container.querySelector('[aria-label="Key numbers"]')?.textContent).toContain('2');
		click(rowOf(container, 'b'));
		expect(container.querySelector('button[aria-label="About this page"]')).toBeNull();
	});

	it('says what the page is for after what the open view says about itself, both behind the (i)', () => {
		const sections = [
			{ id: 'a', label: 'A', info: 'About A', content: <p>a</p> },
			{ id: 'b', label: 'B', content: <p>b</p> },
		];
		const { container } = render(inDashboard(<SectionsPage tab="defaults" sections={sections} info="For every website" />));
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="About this page"]')));
		const text = container.textContent ?? '';
		expect(text.indexOf('About A')).toBeGreaterThan(-1);
		expect(text.indexOf('For every website')).toBeGreaterThan(text.indexOf('About A'));
		// a view with nothing of its own says only what the page is for
		click(rowOf(container, 'b'));
		expect(container.textContent).not.toContain('About A');
		expect(container.textContent).toContain('For every website');
	});

	it('shows the toolbar and footer of the open view only while it is open', () => {
		const sections = [
			{ id: 'a', label: 'A', toolbar: <p>tools of a</p>, footer: <p>pages of a</p>, content: <p>a</p> },
			{ id: 'b', label: 'B', content: <p>b</p> },
		];
		const { container } = render(inDashboard(<SectionsPage tab="features" sections={sections} />));
		expect(container.querySelector('[data-ss-part="toolbar"]')?.textContent).toBe('tools of a');
		expect(container.querySelector('[data-ss-part="footer"]')?.textContent).toBe('pages of a');
		click(rowOf(container, 'b'));
		expect(container.querySelector('[data-ss-part="toolbar"]')).toBeNull();
		expect(container.querySelector('[data-ss-part="footer"]')).toBeNull();
	});

	it('draws the empty state when there is no section, and a message when it failed', () => {
		const { container } = render(inDashboard(<SectionsPage tab="settings" sections={[]} empty={<p>nothing at all</p>} />));
		expect(byText(container, 'nothing at all')).toBeTruthy();
		cleanup();
		const failed = render(inDashboard(<SectionsPage tab="settings" sections={SPECS()} error="It broke" />));
		expect(byText(failed.container, 'It broke')).toBeTruthy();
	});

	it('draws the page skeleton while it loads', () => {
		const { container } = render(inDashboard(<SectionsPage tab="settings" sections={SPECS()} loading />));
		expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
		expect(container.textContent).not.toContain('first body');
	});

	it('draws the skeleton of the list too while it loads, when the tab asks for it', () => {
		const { container } = render(inDashboard(<SectionsPage tab="settings" sections={[]} loading withNav />));
		expect(container.querySelector('[data-ss-page][aria-busy="true"]')).not.toBeNull();
		const statuses = (/** @type {HTMLElement} */ root) => root.querySelectorAll('[role="status"]').length;
		const withList = statuses(container);
		cleanup();
		const without = render(inDashboard(<SectionsPage tab="settings" sections={[]} loading />));
		expect(withList).toBeGreaterThan(statuses(without.container));
	});

	it("words the list's search box with the tab's own label, from searchFrom views", () => {
		const { container } = render(
			inDashboard(<SectionsPage tab="settings" sections={SPECS()} searchFrom={3} searchLabel="Search our settings" />),
		);
		expect(container.querySelector('input[type="search"][aria-label="Search our settings"]')).not.toBeNull();
		cleanup();
		const few = render(
			inDashboard(<SectionsPage tab="settings" sections={SPECS()} searchFrom={4} searchLabel="Search our settings" />),
		);
		expect(few.container.querySelector('input[type="search"]')).toBeNull();
	});

	it('searches the rows by label, meta and the labels of their parts, whatever the case', () => {
		const sections = [
			{ id: 'a', label: 'Alpha', meta: 'Sends mail', content: <p>a</p> },
			{ id: 'b', label: 'Beta', content: <p>b</p> },
			{ id: 'c', label: 'Gamma', children: [{ id: 'c.1', label: 'Delivery times', content: <p>c</p> }] },
		];
		const { container } = render(inDashboard(<SectionsPage tab="settings" sections={sections} searchFrom={2} />));
		const box = /** @type {HTMLInputElement} */ (container.querySelector('input[type="search"]'));
		type(box, 'BET');
		expect(rowTexts(container)).toEqual(['Beta']);
		type(box, 'sends');
		expect(rowTexts(container)).toEqual(['AlphaSends mail']);
		type(box, 'delivery');
		expect(rowTexts(container)).toEqual(['Gamma']);
		type(box, 'zzz');
		expect(rows(container)).toHaveLength(0);
		expect(container.textContent).toContain('No match');
		// the open view stays open while it is searched out of the list
		expect(container.querySelector('h1')?.textContent).toBe('Alpha');
	});

	it('turns the groups into filter chips with their counts, only with two or more groups', () => {
		const { container } = render(inDashboard(<SectionsPage tab="settings" sections={SPECS()} />));
		const chips = () => [...container.querySelectorAll('button[aria-pressed]')];
		expect(chips().map((chip) => chip.textContent)).toEqual(['All3', 'First2', 'Second1']);
		expect(chips()[0]?.getAttribute('aria-pressed')).toBe('true');
		click(/** @type {Element} */ (chips()[2]));
		expect(rowTexts(container)).toEqual(['Multi']);
		// the open view (One) is filtered out of the list but stays open
		expect(container.querySelector('h1')?.textContent).toBe('One');
		expect(panel('one')?.hidden).toBe(false);
		click(/** @type {Element} */ (chips()[0]));
		expect(rows(container)).toHaveLength(3);
		cleanup();
		const one = render(
			inDashboard(
				<SectionsPage
					tab="settings"
					sections={[
						{ id: 'a', label: 'A', group: 'Only group', content: <p>a</p> },
						{ id: 'b', label: 'B', group: 'Only group', content: <p>b</p> },
					]}
				/>,
			),
		);
		expect(one.container.querySelector('button[aria-pressed]')).toBeNull();
	});

	it('shows the list alone on a phone until a view is named, and Back clears the name', async () => {
		phone(true);
		const { container } = render(inDashboard(<SectionsPage tab="settings" sections={SPECS()} />));
		expect(rows(container)).toHaveLength(3);
		expect(container.querySelector('[data-ss-part="body"]')).toBeNull();
		click(rowOf(container, 'two'));
		expect(window.location.hash).toBe('#two');
		expect(container.querySelector('[role="listbox"]')).toBeNull();
		expect(panel('two')?.hidden).toBe(false);
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="Back to the list"]')));
		expect(window.location.hash).toBe('');
		expect(rows(container)).toHaveLength(3);
		expect(container.querySelector('[data-ss-part="body"]')).toBeNull();
		// the browser's Back button returns to the view
		window.history.back();
		await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
		expect(panel('two')?.hidden).toBe(false);
	});

	it('opens the view of the address at once on a phone', () => {
		phone(true);
		window.history.replaceState(null, '', '/#two');
		const { container } = render(inDashboard(<SectionsPage tab="settings" sections={SPECS()} />));
		expect(container.querySelector('[role="listbox"]')).toBeNull();
		expect(container.querySelector('h1')?.textContent).toBe('Two');
	});

	it('gives a result that is a table all of the body (no padding), as a view that is a table does', () => {
		const sections = [
			{ id: 'a', label: 'A', content: <p>a</p> },
			{ id: 'b', label: 'B', content: <p>b</p> },
		];
		const padded = render(
			inDashboard(
				<SectionsPage tab="texts" sections={sections}>
					<p>results</p>
				</SectionsPage>,
			),
		);
		expect(padded.container.querySelector('[data-ss-part="body"]')?.getAttribute('role')).toBe('region');
		cleanup();
		const flush = render(
			inDashboard(
				<SectionsPage tab="texts" sections={sections} flushChildren>
					<p>results</p>
				</SectionsPage>,
			),
		);
		expect(flush.container.querySelector('[data-ss-part="body"]')?.getAttribute('role')).toBeNull();
	});

	it('lets the tab put its own content in place of the views (a search result)', () => {
		const { container } = render(
			inDashboard(
				<SectionsPage tab="texts" sections={SPECS()}>
					<p>search results</p>
				</SectionsPage>,
			),
		);
		expect(byText(container, 'search results')).toBeTruthy();
		expect(panel('one')?.hidden ?? true).toBe(true);
	});

	it('ends the crumbs in the name of the result when the tab gives one, and the list stays', () => {
		const { container } = render(
			inDashboard(
				<SectionsPage tab="texts" sections={SPECS()} resultLabel="Search results">
					<p>search results</p>
				</SectionsPage>,
			),
		);
		expect(crumbsOf(container)).toEqual(['Notes', 'Texts', 'Search results']);
		expect(container.querySelector('h1')?.textContent).toBe('Search results');
		expect(container.querySelector('[role="listbox"][aria-label="Texts"]')).not.toBeNull();
	});
});

describe('LoadedPage', () => {
	it("draws the page skeleton with the crumbs and the tab's own skeleton while the answer is not there", () => {
		const { container } = render(
			inDashboard(
				<LoadedPage answer={null} tab="texts" skeleton={<p>my skeleton</p>}>
					{() => <p>never</p>}
				</LoadedPage>,
			),
		);
		expect(container.querySelector('[data-ss-page][aria-busy="true"]')).not.toBeNull();
		expect(crumbsOf(container)).toEqual(['Notes', 'Texts']);
		expect(byText(container, 'my skeleton')).toBeTruthy();
		expect(container.textContent).not.toContain('never');
	});

	it('says what went wrong in the page, with Try again when it can be fetched again', () => {
		const retry = vi.fn();
		const answer = { ok: false, problem: { status: 500, code: 'internal_error' }, retry };
		const { container } = render(
			inDashboard(
				<LoadedPage answer={/** @type {any} */ (answer)} tab="texts">
					{() => <p>never</p>}
				</LoadedPage>,
			),
		);
		expect(crumbsOf(container)).toEqual(['Notes', 'Texts']);
		expect(container.textContent).toContain(TEXTS.failed);
		click(byText(container, TEXTS.tryAgain, 'button'));
		expect(retry).toHaveBeenCalledTimes(1);
	});

	it('hands the data to the tab, which draws its own page', () => {
		const answer = { ok: true, data: { name: 'Ready' } };
		const { container } = render(
			inDashboard(
				<LoadedPage answer={/** @type {any} */ (answer)} tab="texts">
					{(/** @type {{ name: string }} */ data) => <p>{data.name}</p>}
				</LoadedPage>,
			),
		);
		expect(byText(container, 'Ready')).toBeTruthy();
	});
});
