// @vitest-environment jsdom
/**
 * The page frame of the dashboard (layout contract 2026-10-17): the breadcrumbs `Product › Section › sub-page` that
 * every tab draws, and `SectionsPage`, the one page with an inner navigation (the sub-pages are `InnerNav` items, each
 * its own `#address`, with counts and dots).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardProvider } from '../src/dashboard-parts.js';
import { FrameContext, LoadedPage, SectionsPage, navGroupsOf, useCrumbs } from '../src/dashboard-page.js';
import { dashboardTexts } from '../src/dashboard-texts.js';
import { act, byText, cleanup, click, render } from '../src/testing.js';

afterEach(() => {
	cleanup();
	window.history.replaceState(null, '', '/');
});

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

/** The links of the inner navigation. @param {ParentNode} root */
const navLinks = (root) => [...root.querySelectorAll('nav[aria-label] a[href^="#"]')].map((a) => a.textContent);

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
		const { container } = render(inDashboard(<Crumbs tab="features" rest={[{ label: 'Catalog' }]} />, frame));
		expect(JSON.parse(container.querySelector('[data-crumbs]')?.textContent ?? '[]')).toEqual([
			{ label: 'Notes', href: '?websiteId=w1&view=overview' },
			{ label: 'Features', href: '?websiteId=w1&view=features' },
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

describe('navGroupsOf', () => {
	it('groups the sections by their group; the parts of a section in a group join it, named after their section', () => {
		const groups = navGroupsOf(SPECS());
		expect(groups.map((g) => g.label)).toEqual(['First', 'Second']);
		expect(groups[0]?.items.map((item) => item.id)).toEqual(['one', 'two']);
		expect(groups[1]?.items.map((item) => item.id)).toEqual(['multi.a', 'multi.b']);
		expect(groups[1]?.items.map((item) => item.label)).toEqual(['Multi › Part A', 'Multi › Part B']);
	});

	it('makes a section with parts and no group a group of its own, headed by its label, its parts named as they are', () => {
		const groups = navGroupsOf([
			{ id: 'a', label: 'A', content: null },
			{
				id: 'multi',
				label: 'Multi',
				children: [
					{ id: 'multi.a', label: 'Part A' },
					{ id: 'multi.b', label: 'Part B' },
				],
			},
		]);
		expect(groups.map((g) => g.label)).toEqual([undefined, 'Multi']);
		expect(groups[1]?.items.map((item) => item.label)).toEqual(['Part A', 'Part B']);
	});

	it('turns the badge into the count and the status into the dot, every item its own #address', () => {
		const [first] = navGroupsOf(SPECS());
		expect(first?.items[0]).toMatchObject({ id: 'one', count: '3', href: '#one' });
		expect(first?.items[1]).toMatchObject({ id: 'two', dot: 'attention', dotLabel: 'Needs setup', href: '#two' });
	});

	it('marks a locked section, which is still opened', () => {
		const [group] = navGroupsOf([
			{ id: 'a', label: 'A', locked: true },
			{ id: 'b', label: 'B' },
		]);
		expect(group?.items[0]).toMatchObject({ id: 'a', locked: true });
		expect(group?.items[1]).not.toHaveProperty('locked');
	});

	it('leaves the label out of a group of sections that have none', () => {
		const groups = navGroupsOf([
			{ id: 'a', label: 'A' },
			{ id: 'b', label: 'B' },
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0]).not.toHaveProperty('label');
	});
});

describe('SectionsPage', () => {
	it('draws a Page whose crumbs end in the open sub-page, and the sub-pages in the inner navigation', () => {
		const frame = { hrefOf: (/** @type {string} */ tab) => `?view=${tab}`, home: '?view=overview' };
		const { container } = render(inDashboard(<SectionsPage tab="settings" sections={SPECS()} />, frame));
		expect(container.querySelector('[data-ss-page]')).not.toBeNull();
		expect(crumbsOf(container)).toEqual(['Notes', 'Settings', 'One']);
		expect(container.querySelector('h1')?.textContent).toBe('One');
		expect(navLinks(container)).toEqual(expect.arrayContaining(['One3', 'TwoNeeds setup', 'Multi › Part A', 'Multi › Part B']));
		expect(container.querySelectorAll('h2')).toHaveLength(0);
	});

	it('opens a sub-page from its link: its address is the hash, the page before is one Back away', async () => {
		const { container } = render(inDashboard(<SectionsPage tab="settings" sections={SPECS()} />));
		expect(panel('one')?.hidden).toBe(false);
		expect(panel('two')).toBeNull();
		click(/** @type {HTMLElement} */ ([...container.querySelectorAll('a[href="#two"]')].at(-1)));
		expect(window.location.hash).toBe('#two');
		expect(panel('two')?.hidden).toBe(false);
		expect(panel('one')?.hidden).toBe(true);
		expect(container.querySelector('h1')?.textContent).toBe('Two');
		window.history.back();
		await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
		expect(panel('one')?.hidden).toBe(false);
	});

	it('names the parent of a part in the crumbs', () => {
		window.history.replaceState(null, '', '/#multi.b');
		const { container } = render(inDashboard(<SectionsPage tab="settings" sections={SPECS()} />));
		expect(crumbsOf(container)).toEqual(['Notes', 'Settings', 'Multi', 'Part B']);
		expect(container.querySelector('h1')?.textContent).toBe('Part B');
	});

	it('shows one section without any inner navigation, and its title is the tab', () => {
		const { container } = render(
			inDashboard(<SectionsPage tab="developers" sections={[{ id: 'only', label: 'Only', content: <p>just this</p> }]} />),
		);
		expect(container.querySelector('nav[aria-label="Sections"]')).toBeNull();
		expect(crumbsOf(container)).toEqual(['Notes', 'Developers']);
		expect(byText(container, 'just this')).toBeTruthy();
	});

	it('keeps an opened sub-page mounted, so an edit in it is not lost', () => {
		const { container } = render(inDashboard(<SectionsPage tab="settings" sections={SPECS()} />));
		click(/** @type {HTMLElement} */ ([...container.querySelectorAll('a[href="#two"]')].at(-1)));
		click(/** @type {HTMLElement} */ ([...container.querySelectorAll('a[href="#one"]')].at(-1)));
		expect(panel('two')?.hidden).toBe(true);
		expect(panel('two')?.textContent).toBe('second body');
	});

	it('shows what an open sub-page says about itself behind the (i) and in the header', () => {
		const sections = [
			{ id: 'a', label: 'A', info: 'About A', facts: [{ label: 'On', value: '2' }], content: <p>a</p> },
			{ id: 'b', label: 'B', content: <p>b</p> },
		];
		const { container } = render(inDashboard(<SectionsPage tab="features" sections={sections} />));
		expect(container.querySelector('button[aria-label="About this page"]')).not.toBeNull();
		expect(container.querySelector('[aria-label="Key numbers"]')?.textContent).toContain('2');
		click(/** @type {HTMLElement} */ ([...container.querySelectorAll('a[href="#b"]')].at(-1)));
		expect(container.querySelector('button[aria-label="About this page"]')).toBeNull();
	});

	it('says what the page is for after what the open sub-page says about itself, both behind the (i)', () => {
		const sections = [
			{ id: 'a', label: 'A', info: 'About A', content: <p>a</p> },
			{ id: 'b', label: 'B', content: <p>b</p> },
		];
		const { container } = render(inDashboard(<SectionsPage tab="defaults" sections={sections} info="For every website" />));
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="About this page"]')));
		const text = container.textContent ?? '';
		expect(text.indexOf('About A')).toBeGreaterThan(-1);
		expect(text.indexOf('For every website')).toBeGreaterThan(text.indexOf('About A'));
		// a sub-page with nothing of its own says only what the page is for
		click(/** @type {HTMLElement} */ ([...container.querySelectorAll('a[href="#b"]')].at(-1)));
		expect(container.textContent).not.toContain('About A');
		expect(container.textContent).toContain('For every website');
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

	it("words the navigation's search box with the tab's own label", () => {
		const { container } = render(
			inDashboard(<SectionsPage tab="settings" sections={SPECS()} searchFrom={2} searchLabel="Search our settings" />),
		);
		expect(container.querySelector('input[type="search"][aria-label="Search our settings"]')).not.toBeNull();
	});

	it('gives a result that is a table all of the body (no padding), as a sub-page that is a table does', () => {
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

	it('lets the tab put its own content in place of the sub-pages (a search result)', () => {
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

	it('ends the crumbs in the name of the result when the tab gives one', () => {
		const { container } = render(
			inDashboard(
				<SectionsPage tab="texts" sections={SPECS()} resultLabel="Search results">
					<p>search results</p>
				</SectionsPage>,
			),
		);
		expect(crumbsOf(container)).toEqual(['Notes', 'Texts', 'Search results']);
		expect(container.querySelector('h1')?.textContent).toBe('Search results');
		// the navigation stays
		expect(container.querySelector('nav[aria-label="Texts"]')).not.toBeNull();
	});
});

describe('LoadedPage', () => {
	it("draws the page skeleton with the crumbs and the tab's own skeleton while the answer is not there", () => {
		const { container } = render(
			inDashboard(
				<LoadedPage answer={null} tab="features" skeleton={<p>my skeleton</p>}>
					{() => <p>never</p>}
				</LoadedPage>,
			),
		);
		expect(container.querySelector('[data-ss-page][aria-busy="true"]')).not.toBeNull();
		expect(crumbsOf(container)).toEqual(['Notes', 'Features']);
		expect(byText(container, 'my skeleton')).toBeTruthy();
		expect(container.textContent).not.toContain('never');
	});

	it('says what went wrong in the page, with Try again when it can be fetched again', () => {
		const retry = vi.fn();
		const answer = { ok: false, problem: { status: 500, code: 'internal_error' }, retry };
		const { container } = render(
			inDashboard(
				<LoadedPage answer={/** @type {any} */ (answer)} tab="features">
					{() => <p>never</p>}
				</LoadedPage>,
			),
		);
		expect(crumbsOf(container)).toEqual(['Notes', 'Features']);
		expect(container.textContent).toContain(TEXTS.failed);
		click(byText(container, TEXTS.tryAgain, 'button'));
		expect(retry).toHaveBeenCalledTimes(1);
	});

	it('hands the data to the tab, which draws its own page', () => {
		const answer = { ok: true, data: { name: 'Ready' } };
		const { container } = render(
			inDashboard(
				<LoadedPage answer={/** @type {any} */ (answer)} tab="features">
					{(/** @type {{ name: string }} */ data) => <p>{data.name}</p>}
				</LoadedPage>,
			),
		);
		expect(byText(container, 'Ready')).toBeTruthy();
	});
});
