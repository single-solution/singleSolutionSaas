// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../src/AppShell.js';
import { Pagination } from '../src/paged.js';
import { ListColumn } from '../src/ListColumn.js';
import { Page, PAGE_TEXTS } from '../src/Page.js';
import { PAGE } from '../src/layout-metrics.js';
import { PageSkeleton } from '../src/skeletons.js';
import { Toolbar } from '../src/Toolbar.js';
import { act, allByRole, byText, cleanup, click, keydown, render } from '../src/testing.js';

afterEach(() => {
	cleanup();
	Reflect.deleteProperty(window, 'matchMedia');
});

const crumbs = [{ label: 'Merchants', href: '/merchants' }, { label: 'Acme', href: '/merchants/acme' }, { label: 'Credits' }];

/** @param {HTMLElement} root @param {string} part */
const part = (root, part) => /** @type {HTMLElement} */ (root.querySelector(`[data-ss-part="${part}"]`));

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

describe('Page header', () => {
	it('has one title, the last crumb, and every other crumb is a link', () => {
		const { container } = render(<Page crumbs={crumbs}>Body</Page>);
		const root = /** @type {HTMLElement} */ (container.querySelector('[data-ss-page]'));
		expect(root).not.toBeNull();
		const title = /** @type {HTMLElement} */ (root.querySelector('h1'));
		expect(title.textContent).toBe('Credits');
		expect(title.closest('a')).toBeNull();
		expect(title.getAttribute('aria-current')).toBe('page');
		const links = [...part(container, 'header').querySelectorAll('nav[aria-label="Breadcrumb"] a')];
		expect(links.map((a) => a.getAttribute('href'))).toEqual(['/merchants', '/merchants/acme']);
		expect(part(container, 'header').className).toContain('h-14');
	});

	it('draws the crumbs with the router link it is given and keeps a step without an address as text', () => {
		/** @param {{ href: string, children?: import('react').ReactNode }} props */
		const RouterLink = ({ href, children }) => (
			<a href={href} data-router="yes">
				{children}
			</a>
		);
		const { container } = render(
			<Page linkAs={RouterLink} crumbs={[{ label: 'Group' }, { label: 'Parent', href: '/p' }, { label: 'Leaf' }]}>
				x
			</Page>,
		);
		expect(container.querySelectorAll('a[data-router="yes"]')).toHaveLength(1);
		expect(byText(container, 'Group').closest('a')).toBeNull();
	});

	it('shows the status pills and at most four facts, each as a link, a filter button or plain text', () => {
		const onFilter = vi.fn();
		const { container } = render(
			<Page
				crumbs={[{ label: 'Orders' }]}
				status={[{ status: 'active', label: 'Live' }]}
				facts={[
					{ label: 'Open', value: 12, onClick: onFilter, active: true },
					{ label: 'Balance', value: '1,250', href: '/balance', tone: 'success' },
					{ label: 'Websites', value: 3, title: 'Websites in this account' },
					{ label: 'Cost', value: '4/day' },
					{ label: 'Fifth', value: 5 },
				]}>
				x
			</Page>,
		);
		const header = part(container, 'header');
		expect(header.textContent).toContain('Live');
		expect(header.textContent).not.toContain('Fifth');
		const filter = /** @type {HTMLElement} */ (byText(header, 'Open').closest('button'));
		expect(filter.getAttribute('aria-pressed')).toBe('true');
		click(filter);
		expect(onFilter).toHaveBeenCalledTimes(1);
		expect(byText(header, 'Balance').closest('a')?.getAttribute('href')).toBe('/balance');
		expect(byText(header, 'Websites').closest('button,a')).toBeNull();
		expect(byText(header, 'Websites').closest('[title]')?.getAttribute('title')).toBe('Websites in this account');
		expect(header.querySelectorAll('[data-ss-fact]')).toHaveLength(4);
	});

	it('puts one primary action, up to two secondary ones and a More menu on the right', () => {
		const primary = vi.fn();
		const second = vi.fn();
		const edit = vi.fn();
		const { container } = render(
			<Page
				crumbs={[{ label: 'Merchants' }]}
				actions={{
					primary: { label: 'Add credits', onClick: primary, icon: 'plus' },
					secondary: [
						{ label: 'Edit', onClick: edit },
						{ label: 'Export', onClick: second, disabled: true },
						{ label: 'Third', onClick: second },
					],
					more: [{ label: 'Delete', onSelect: vi.fn(), danger: true }],
				}}>
				x
			</Page>,
		);
		const header = part(container, 'header');
		click(/** @type {HTMLElement} */ (byText(header, 'Add credits').closest('button')));
		expect(primary).toHaveBeenCalledTimes(1);
		click(/** @type {HTMLElement} */ (byText(header, 'Edit').closest('button')));
		expect(edit).toHaveBeenCalledTimes(1);
		expect(/** @type {HTMLButtonElement} */ (byText(header, 'Export').closest('button')).disabled).toBe(true);
		expect(header.textContent).not.toContain('Third');
		click(/** @type {HTMLElement} */ (header.querySelector(`button[aria-label="${PAGE_TEXTS.more}"]`)));
		// the secondary actions are also rows of More, hidden by the header's width where their buttons show (below)
		expect(allByRole(document.body, 'menuitem').map((el) => el.textContent)).toEqual(['Edit', 'Export', 'Delete']);
	});

	it('has no More menu when there is nothing in it', () => {
		const { container } = render(
			<Page crumbs={[{ label: 'Merchants' }]} actions={{ primary: { label: 'Add', onClick: () => {} } }}>
				x
			</Page>,
		);
		expect(container.querySelector(`button[aria-label="${PAGE_TEXTS.more}"]`)).toBeNull();
	});

	it('folds the secondary actions into More on phones and keeps the primary one', () => {
		phone(true);
		const { container } = render(
			<Page
				crumbs={[{ label: 'Merchants' }]}
				actions={{
					primary: { label: 'Add credits', onClick: () => {} },
					secondary: [{ label: 'Edit', onClick: () => {}, icon: 'sliders' }],
					more: [{ label: 'Delete', onSelect: () => {} }],
				}}>
				x
			</Page>,
		);
		const header = part(container, 'header');
		expect(byText(header, 'Add credits').closest('button')).not.toBeNull();
		expect(header.textContent).not.toContain('Edit');
		click(/** @type {HTMLElement} */ (header.querySelector(`button[aria-label="${PAGE_TEXTS.more}"]`)));
		expect(allByRole(document.body, 'menuitem').map((el) => el.textContent)).toEqual(['Edit', 'Delete']);
	});

	it('runs a folded action when its menu item is picked', () => {
		phone(true);
		const edit = vi.fn();
		const { container } = render(
			<Page crumbs={[{ label: 'Merchants' }]} actions={{ secondary: [{ label: 'Edit', onClick: edit }] }}>
				x
			</Page>,
		);
		click(/** @type {HTMLElement} */ (container.querySelector(`button[aria-label="${PAGE_TEXTS.more}"]`)));
		click(/** @type {HTMLElement} */ (allByRole(document.body, 'menuitem')[0]));
		expect(edit).toHaveBeenCalledTimes(1);
	});

	it('keeps the old page description behind an (i) next to the title', () => {
		const { container } = render(
			<Page crumbs={[{ label: 'Merchants' }]} info="Everyone who pays for a website.">
				x
			</Page>,
		);
		const button = /** @type {HTMLElement} */ (container.querySelector(`button[aria-label="${PAGE_TEXTS.info}"]`));
		expect(button.getAttribute('aria-expanded')).toBe('false');
		expect(container.textContent).not.toContain('Everyone who pays');
		click(button);
		expect(button.getAttribute('aria-expanded')).toBe('true');
		expect(container.textContent).toContain('Everyone who pays');
		keydown(document, 'Escape');
		expect(container.textContent).not.toContain('Everyone who pays');
		click(button);
		act(() => {
			document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		});
		expect(container.textContent).not.toContain('Everyone who pays');
		click(button);
		click(button);
		expect(container.textContent).not.toContain('Everyone who pays');
	});

	it('stays open for another key and for a click inside it', () => {
		const { container } = render(
			<Page crumbs={[{ label: 'Merchants' }]} info={<span data-testid="note">Everyone who pays for a website.</span>}>
				x
			</Page>,
		);
		click(/** @type {HTMLElement} */ (container.querySelector(`button[aria-label="${PAGE_TEXTS.info}"]`)));
		keydown(document, 'Tab');
		expect(container.textContent).toContain('Everyone who pays');
		act(() => {
			container.querySelector('[data-testid="note"]')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		});
		expect(container.textContent).toContain('Everyone who pays');
	});

	it('has no (i) without info', () => {
		const { container } = render(<Page crumbs={[{ label: 'Merchants' }]}>x</Page>);
		expect(container.querySelector(`button[aria-label="${PAGE_TEXTS.info}"]`)).toBeNull();
	});

	it('uses the words it is given', () => {
		const { container } = render(
			<Page crumbs={[{ label: 'Händler' }]} info="x" texts={{ info: 'Über diese Seite' }}>
				x
			</Page>,
		);
		expect(container.querySelector('button[aria-label="Über diese Seite"]')).not.toBeNull();
	});
});

describe('Page areas', () => {
	it('lays out the inner navigation, the toolbar, the one scrolling body and the footer', () => {
		const { container } = render(
			<Page
				crumbs={[{ label: 'Merchants' }]}
				nav={{
					items: [
						{ id: 'a', label: 'Alpha' },
						{ id: 'b', label: 'Beta' },
					],
					value: 'b',
				}}
				toolbar={<Toolbar search={{ onSearch: () => {} }} />}
				footer={<Pagination total={60} page={0} pageSize={25} onPage={() => {}} />}>
				<p>The content</p>
			</Page>,
		);
		const root = /** @type {HTMLElement} */ (container.querySelector('[data-ss-page]'));
		expect(root.className).toBe(PAGE.root);
		expect(container.querySelector('nav[aria-label="Sections"]')).not.toBeNull();
		const toolbar = part(container, 'toolbar');
		const body = part(container, 'body');
		const footer = part(container, 'footer');
		expect(toolbar.querySelector('input[type="search"]')).not.toBeNull();
		expect(body.textContent).toContain('The content');
		expect(footer.textContent).toContain('Showing 1');
		expect(toolbar.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(body.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(body.className).toContain('ss-scroll');
		expect(container.querySelectorAll('.ss-scroll').length).toBeGreaterThanOrEqual(1);
		expect(toolbar.className).toContain('shrink-0');
		expect(footer.className).toContain('shrink-0');
		expect(footer.className).toContain('h-12');
	});

	it('draws neither toolbar, footer nor inner navigation when they are not given', () => {
		const { container } = render(<Page crumbs={[{ label: 'Overview' }]}>x</Page>);
		expect(part(container, 'toolbar')).toBeNull();
		expect(part(container, 'footer')).toBeNull();
		expect(container.querySelector('nav[aria-label="Sections"]')).toBeNull();
	});

	it('pads the body, or lets a list use all of it with flush', () => {
		const padded = render(<Page crumbs={[{ label: 'A' }]}>x</Page>);
		const paddedBody = part(padded.container, 'body');
		expect(paddedBody.innerHTML).toContain('p-4');
		expect(paddedBody.getAttribute('role')).toBe('region');
		expect(paddedBody.getAttribute('tabindex')).toBe('0');
		expect(paddedBody.getAttribute('aria-labelledby')).toBe(padded.container.querySelector('h1')?.id);
		cleanup();
		const flush = render(
			<Page crumbs={[{ label: 'A' }]} flush>
				x
			</Page>,
		);
		const flushBody = part(flush.container, 'body');
		expect(flushBody.innerHTML).not.toContain('p-4');
		expect(flushBody.getAttribute('role')).toBeNull();
	});

	it('fades the body in again when the sub-page changes', () => {
		const first = render(
			<Page crumbs={[{ label: 'A' }]} bodyKey="one">
				<span data-testid="x">one</span>
			</Page>,
		);
		const before = part(first.container, 'body').firstElementChild;
		expect(before?.className).toContain('animate-ss-enter');
		first.rerender(
			<Page crumbs={[{ label: 'A' }]} bodyKey="two">
				<span data-testid="x">two</span>
			</Page>,
		);
		const after = part(first.container, 'body').firstElementChild;
		expect(after).not.toBe(before);
		first.rerender(
			<Page crumbs={[{ label: 'A' }]} bodyKey="two">
				<span data-testid="x">three</span>
			</Page>,
		);
		expect(part(first.container, 'body').firstElementChild).toBe(after);
	});

	it('shows an error in the body, keeps the header and the navigation, and leaves out the toolbar and footer', () => {
		const { container } = render(
			<Page
				crumbs={[{ label: 'Merchants' }]}
				nav={{ items: [{ id: 'a', label: 'Alpha' }], value: 'a' }}
				toolbar={<Toolbar search={{ onSearch: () => {} }} />}
				footer={<Pagination total={10} />}
				error={{ title: 'Nope', message: 'The server said no.' }}>
				<p>The content</p>
			</Page>,
		);
		expect(allByRole(container, 'alert')[0]?.textContent).toContain('The server said no.');
		expect(container.textContent).not.toContain('The content');
		expect(container.querySelector('h1')?.textContent).toBe('Merchants');
		expect(container.querySelector('nav[aria-label="Sections"]')).not.toBeNull();
		expect(part(container, 'toolbar')).toBeNull();
		expect(part(container, 'footer')).toBeNull();
	});

	it('takes an error given as plain text', () => {
		const { container } = render(
			<Page crumbs={[{ label: 'Merchants' }]} error="Could not load">
				x
			</Page>,
		);
		expect(allByRole(container, 'alert')[0]?.textContent).toContain('Could not load');
	});
});

describe('Page loading', () => {
	it('renders its own skeleton with the same areas instead of the content', () => {
		const { container } = render(
			<Page
				loading
				crumbs={[{ label: 'Merchants' }]}
				facts={[{ label: 'Open', value: 1 }]}
				actions={{ primary: { label: 'Add', onClick: () => {} } }}
				nav={{ items: [{ id: 'a', label: 'Alpha' }], value: 'a' }}
				toolbar={<Toolbar />}
				footer={<Pagination total={10} />}>
				<p>The content</p>
			</Page>,
		);
		expect(container.textContent).not.toContain('The content');
		expect(container.textContent).not.toContain('Alpha');
		expect(container.querySelector('h1')?.textContent).toBe('Merchants');
		expect(container.querySelector('[data-ss-page]')?.getAttribute('aria-busy')).toBe('true');
		for (const name of ['header', 'toolbar', 'body', 'footer']) expect(part(container, name)).not.toBeNull();
		expect(allByRole(container, 'status').length).toBeGreaterThan(0);
	});

	it('is exactly as tall and wide as the real page: the skeleton and the page share every class', () => {
		const props = { crumbs: [{ label: 'Merchants' }] };
		const real = render(
			<Page
				{...props}
				nav={{ items: [{ id: 'a', label: 'A' }], value: 'a' }}
				toolbar={<Toolbar />}
				footer={<Pagination total={10} />}>
				x
			</Page>,
		);
		const skeleton = render(<PageSkeleton {...props} nav toolbar footer />);
		for (const name of ['header', 'toolbar', 'body', 'footer'])
			expect(part(skeleton.container, name).className, name).toBe(part(real.container, name).className);
		const rootOf = (/** @type {HTMLElement} */ el) => el.querySelector('[data-ss-page]')?.className;
		expect(rootOf(skeleton.container)).toBe(rootOf(real.container));
		const main = (/** @type {HTMLElement} */ el) => el.querySelector('[data-ss-part="body"]')?.parentElement?.className;
		expect(main(skeleton.container)).toBe(main(real.container));
	});

	it('shows only the areas the page has', () => {
		const { container } = render(<PageSkeleton />);
		expect(part(container, 'toolbar')).toBeNull();
		expect(part(container, 'footer')).toBeNull();
		expect(part(container, 'header')).not.toBeNull();
		expect(container.querySelector('h1')).toBeNull();
	});

	it('draws the body skeleton it is given', () => {
		const { container } = render(
			<PageSkeleton flush>
				<div data-testid="mine" />
			</PageSkeleton>,
		);
		expect(container.querySelector('[data-testid="mine"]')).not.toBeNull();
		expect(part(container, 'body').innerHTML).not.toContain('p-4');
	});
});

describe('Page in the console frame', () => {
	/** @type {import('../src/AppShell.js').NavSection[]} */
	const sections = [{ items: [{ href: '/a', label: 'Alpha', current: true }] }];

	it('opens the navigation sheet from the menu button on phones', () => {
		const { container } = render(
			<AppShell sections={sections}>
				<Page crumbs={[{ label: 'Alpha' }]}>x</Page>
			</AppShell>,
		);
		const button = /** @type {HTMLElement} */ (part(container, 'header').querySelector('button[aria-label="Open navigation"]'));
		expect(button.className).toContain('lg:hidden');
		click(button);
		expect(container.querySelector('[role="dialog"][aria-label="Navigation"]')).not.toBeNull();
	});

	it('uses the frame router link for its crumbs', () => {
		/** @param {{ href: string, children?: import('react').ReactNode }} props */
		const RouterLink = ({ href, children }) => (
			<a href={href} data-router="yes">
				{children}
			</a>
		);
		const { container } = render(
			<AppShell sections={sections} linkAs={RouterLink}>
				<Page crumbs={[{ label: 'Up', href: '/up' }, { label: 'Alpha' }]}>x</Page>
			</AppShell>,
		);
		expect(part(container, 'header').querySelector('a[data-router="yes"][href="/up"]')).not.toBeNull();
	});

	it('hides the frame header while a page draws its own, and gives the page the whole pane', () => {
		const { container } = render(
			<AppShell sections={sections}>
				<Page crumbs={[{ label: 'Alpha' }]}>x</Page>
			</AppShell>,
		);
		const shellHeader = /** @type {HTMLElement} */ (
			[...container.querySelectorAll('header')].find((el) => !el.hasAttribute('data-ss-part'))
		);
		expect(shellHeader.className).toContain('group-has-[[data-ss-page]]/main:hidden');
		const main = /** @type {HTMLElement} */ (container.querySelector('main'));
		expect(main.className).toContain('has-[[data-ss-page]]:flex-1');
	});

	it('does not need a frame', () => {
		const { container } = render(<Page crumbs={[{ label: 'Alone' }]}>x</Page>);
		expect(container.querySelector('button[aria-label="Open navigation"]')).toBeNull();
	});
});

describe('Page header by its own width', () => {
	const crumbs3 = [{ label: 'Merchants', href: '/m' }, { label: 'Acme', href: '/m/acme' }, { label: 'Credits' }];

	it('is a size container above the toolbar menus, and the skeleton shares it', () => {
		const { container } = render(<Page crumbs={crumbs3}>x</Page>);
		expect(part(container, 'header').className).toContain('@container');
		expect(PAGE.header).toContain('@container');
		expect(PAGE.header).toContain('z-[25]');
	});

	it('keeps the title: it cuts its own text, has the full text as a tooltip and is the last to shrink', () => {
		const { container } = render(<Page crumbs={crumbs3}>x</Page>);
		const title = /** @type {HTMLElement} */ (container.querySelector('h1'));
		expect(title.getAttribute('title')).toBe('Credits');
		expect(title.className).toContain('truncate');
		expect(title.closest('li')?.className).toContain('shrink-0');
		// the cluster of title, (i) and status keeps a floor of about 10rem where the header is narrow
		expect(title.closest('div')?.className).toContain('@max-[60rem]:min-w-[10.5rem]');
	});

	it('shows the earlier crumbs only where the header is 40rem wide and cuts them before the title', () => {
		const { container } = render(<Page crumbs={crumbs3}>x</Page>);
		const links = [...container.querySelectorAll('nav[aria-label="Breadcrumb"] a')];
		expect(links).toHaveLength(2);
		for (const link of links) {
			const item = /** @type {HTMLElement} */ (link.closest('li'));
			expect(item.className).toContain('hidden');
			expect(item.className).toContain('@[40rem]:block');
			expect(item.className).toContain('truncate');
			expect(item.className).toContain('shrink');
			expect(item.className).not.toContain('shrink-0');
		}
		expect(links[0]?.getAttribute('title')).toBe('Merchants');
	});

	it('gives way in steps: the third and fourth number at 72rem, all numbers at 60rem, each cutting its own text', () => {
		const { container } = render(
			<Page
				crumbs={[{ label: 'Orders' }]}
				facts={[
					{ label: 'Open', value: 12 },
					{ label: 'Balance', value: '1,250', href: '/b' },
					{ label: 'Websites', value: 3 },
					{ label: 'Cost', value: <b>4/day</b>, title: 'Cost per day' },
				]}>
				x
			</Page>,
		);
		const list = /** @type {HTMLElement} */ (part(container, 'header').querySelector('ul'));
		expect(list.className).toContain('hidden');
		expect(list.className).toContain('@[60rem]:flex');
		expect(list.className).toContain('overflow-hidden');
		const rows = [...list.querySelectorAll(':scope > li')];
		expect(rows.map((li) => li.className.includes('@[72rem]:flex'))).toEqual([false, false, true, true]);
		for (const li of rows) expect(li.className).toContain('min-w-0');
		const chips = [...container.querySelectorAll('[data-ss-fact]')];
		for (const chip of chips) {
			expect(chip.className).toContain('shrink');
			expect(chip.className).not.toContain('shrink-0');
			expect(chip.className).toContain('max-w-full');
			expect(chip.querySelectorAll('span.truncate').length).toBeGreaterThanOrEqual(2);
		}
		// a cut number keeps its full text as a tooltip; one that has its own title keeps that
		expect(chips[0]?.getAttribute('title')).toBe('Open 12');
		expect(chips[1]?.getAttribute('title')).toBe('Balance 1,250');
		expect(chips[3]?.getAttribute('title')).toBe('Cost per day');
	});

	it('shows a status pill as its dot below 32rem, the label staying as tooltip and text', () => {
		const { container } = render(
			<Page
				crumbs={[{ label: 'Merchants' }]}
				status={[
					{ status: 'active', label: 'Live' },
					{ status: 'warning', label: 'Review', title: 'Waiting for the bank' },
				]}>
				x
			</Page>,
		);
		const live = /** @type {HTMLElement} */ (byText(container, 'Live').closest('[title]'));
		// the text stays in the page (read aloud, no display: none); only its size goes to zero where the header is narrow
		expect(live.className).toContain('@max-[32rem]:text-[0px]');
		expect(live.className).toContain('@max-[32rem]:gap-0');
		expect(live.getAttribute('title')).toBe('Live');
		expect(/** @type {HTMLElement} */ (byText(container, 'Review').closest('[title]')).getAttribute('title')).toBe(
			'Waiting for the bank',
		);
		expect(part(container, 'header').textContent).toContain('Live');
	});

	it('hides the secondary buttons below 48rem and shows the same actions as rows of More there', () => {
		const { container } = render(
			<Page
				crumbs={[{ label: 'Merchants' }]}
				actions={{
					primary: { label: 'Add credits', onClick: () => {}, icon: 'plus' },
					secondary: [
						{ label: 'Edit', onClick: () => {} },
						{ label: 'Export', onClick: () => {} },
					],
					more: [{ label: 'Delete', onSelect: () => {}, danger: true }],
				}}>
				x
			</Page>,
		);
		const header = part(container, 'header');
		for (const name of ['Edit', 'Export']) {
			const button = /** @type {HTMLElement} */ (byText(header, name).closest('button'));
			expect(button.className).toContain('@max-3xl:hidden');
		}
		expect(/** @type {HTMLElement} */ (byText(header, 'Add credits').closest('button')).className).not.toContain('hidden');
		const more = /** @type {HTMLElement} */ (header.querySelector(`button[aria-label="${PAGE_TEXTS.more}"]`));
		expect(more.closest('.relative')?.className).not.toContain('@3xl:hidden');
		click(more);
		const rows = allByRole(document.body, 'menuitem');
		expect(rows.map((el) => el.textContent)).toEqual(['Edit', 'Export', 'Delete']);
		expect(rows.map((el) => el.parentElement?.className.includes('@3xl:hidden'))).toEqual([true, true, false]);
	});

	it('shows More only below 48rem when it holds nothing but the secondary actions', () => {
		const { container } = render(
			<Page crumbs={[{ label: 'Merchants' }]} actions={{ secondary: [{ label: 'Edit', onClick: () => {} }] }}>
				x
			</Page>,
		);
		const more = /** @type {HTMLElement} */ (
			part(container, 'header').querySelector(`button[aria-label="${PAGE_TEXTS.more}"]`)
		);
		expect(more.closest('.relative')?.className).toContain('@3xl:hidden');
	});

	it('puts every secondary action in More, without a hide class, when the window is a phone', () => {
		phone(true);
		const { container } = render(
			<Page
				crumbs={[{ label: 'Merchants' }]}
				actions={{
					secondary: [{ label: 'Edit', onClick: () => {} }],
					more: [{ label: 'Delete', onSelect: () => {} }],
				}}>
				x
			</Page>,
		);
		const more = /** @type {HTMLElement} */ (
			part(container, 'header').querySelector(`button[aria-label="${PAGE_TEXTS.more}"]`)
		);
		expect(more.closest('.relative')?.className).not.toContain('@3xl:hidden');
		click(more);
		const rows = allByRole(document.body, 'menuitem');
		expect(rows.map((el) => el.textContent)).toEqual(['Edit', 'Delete']);
		expect(rows.map((el) => el.parentElement?.className.includes('hidden'))).toEqual([false, false]);
	});

	it('shows the primary action as its icon below 28rem, the label staying as aria-label and tooltip', () => {
		const { container } = render(
			<Page crumbs={[{ label: 'Merchants' }]} actions={{ primary: { label: 'Add credits', onClick: () => {}, icon: 'plus' } }}>
				x
			</Page>,
		);
		const button = /** @type {HTMLElement} */ (byText(part(container, 'header'), 'Add credits').closest('button'));
		expect(button.getAttribute('aria-label')).toBe('Add credits');
		expect(button.getAttribute('title')).toBe('Add credits');
		expect(button.className).toContain('@max-md:w-9');
		expect(button.className).toContain('@max-md:px-0');
		expect(byText(button, 'Add credits').className).toContain('@max-md:sr-only');
		expect(byText(button, 'Add credits').className).toContain('truncate');
		expect(button.className).toContain('max-w-[14rem]');
	});

	it('keeps the label of a primary action that has no icon', () => {
		const { container } = render(
			<Page crumbs={[{ label: 'Merchants' }]} actions={{ primary: { label: 'Save', onClick: () => {} } }}>
				x
			</Page>,
		);
		const button = /** @type {HTMLElement} */ (byText(part(container, 'header'), 'Save').closest('button'));
		expect(button.getAttribute('aria-label')).toBeNull();
		expect(button.className).not.toContain('@max-md');
		expect(byText(button, 'Save').className).not.toContain('sr-only');
	});
});

describe('Page with a list', () => {
	const merchants = [
		{ id: 'acme', name: 'Acme Shop' },
		{ id: 'bolt', name: 'Bolt Studio' },
	];

	/** @param {{ selected?: string | null, onBack?: () => void }} props */
	const listOf = ({ selected = null, onBack }) => (
		<ListColumn
			label="Merchants"
			items={merchants}
			idOf={(m) => m.id}
			rowOf={(m) => ({ title: m.name })}
			selected={selected}
			{...(onBack ? { onBack } : {})}
		/>
	);

	const crumbs = [{ label: 'Merchants' }];

	it('draws the column where the inner navigation goes, before the main panel, and not the navigation', () => {
		const { container } = render(
			<Page crumbs={crumbs} nav={{ items: [{ id: 'a', label: 'Alpha' }], value: 'a' }} list={listOf({ selected: 'acme' })}>
				<p>Acme page</p>
			</Page>,
		);
		const column = /** @type {HTMLElement} */ (container.querySelector('[data-ss-list]'));
		expect(column).not.toBeNull();
		expect(container.querySelector('nav[aria-label="Sections"]')).toBeNull();
		expect(allByRole(container, 'option')).toHaveLength(2);
		expect(column.compareDocumentPosition(part(container, 'body')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(part(container, 'body').textContent).toContain('Acme page');
		expect(/** @type {HTMLElement} */ (column.parentElement).className).toBe(PAGE.listArea);
	});

	it('wins over the jump list of four sections, which all still show in the body', () => {
		const sections = ['one', 'two', 'three', 'four'].map((id) => ({
			id,
			label: id.toUpperCase(),
			body: <p>{`Body ${id}`}</p>,
		}));
		const { container } = render(<Page crumbs={crumbs} sections={sections} list={listOf({ selected: 'acme' })} />);
		expect(container.querySelector('nav[aria-label="Sections"]')).toBeNull();
		expect(container.querySelector('[data-ss-list]')).not.toBeNull();
		expect(part(container, 'body').textContent).toContain('Body four');
	});

	it('fades the body in again when the picked item changes', () => {
		const { container, rerender } = render(
			<Page crumbs={crumbs} list={listOf({ selected: 'acme' })}>
				x
			</Page>,
		);
		const before = /** @type {HTMLElement} */ (part(container, 'body').firstElementChild);
		expect(before.className).toContain('animate-ss-enter');
		rerender(
			<Page crumbs={crumbs} list={listOf({ selected: 'acme' })}>
				x
			</Page>,
		);
		expect(part(container, 'body').firstElementChild).toBe(before);
		rerender(
			<Page crumbs={crumbs} list={listOf({ selected: 'bolt' })}>
				x
			</Page>,
		);
		expect(part(container, 'body').firstElementChild).not.toBe(before);
	});

	it('shows both on a wide screen, without a Back button', () => {
		phone(false);
		const onBack = vi.fn();
		const { container } = render(
			<Page crumbs={crumbs} list={listOf({ selected: 'acme', onBack })}>
				Acme page
			</Page>,
		);
		expect(container.querySelector('[data-ss-list]')).not.toBeNull();
		expect(part(container, 'body')).not.toBeNull();
		expect(part(container, 'header').querySelector('[aria-label="Back to the list"]')).toBeNull();
	});

	it('shows only the list on a phone while nothing is picked', () => {
		phone(true);
		const { container } = render(
			<Page crumbs={crumbs} list={listOf({ selected: null })}>
				Acme page
			</Page>,
		);
		expect(container.querySelector('[data-ss-list]')).not.toBeNull();
		expect(allByRole(container, 'option')).toHaveLength(2);
		expect(part(container, 'body')).toBeNull();
		expect(container.textContent).not.toContain('Acme page');
	});

	it('shows only the picked item on a phone, with a Back button in the header that calls onBack', () => {
		phone(true);
		const onBack = vi.fn();
		const { container } = render(
			<Page crumbs={crumbs} list={listOf({ selected: 'acme', onBack })}>
				Acme page
			</Page>,
		);
		expect(container.querySelector('[data-ss-list]')).toBeNull();
		expect(part(container, 'body').textContent).toContain('Acme page');
		const back = /** @type {HTMLElement} */ (part(container, 'header').querySelector('[aria-label="Back to the list"]'));
		click(back);
		expect(onBack).toHaveBeenCalledTimes(1);
	});

	it('point 295: a link to a list item that no longer exists shows "This item was removed or you no longer have access" with a way back to the list', () => {
		const onBack = vi.fn();
		const { container } = render(
			<Page crumbs={crumbs} list={listOf({ selected: 'gone', onBack })}>
				Acme page
			</Page>,
		);
		expect(container.textContent).toContain('This item was removed or you no longer have access');
		expect(container.textContent).not.toContain('Acme page');
		const backBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Back to the list');
		expect(backBtn).not.toBeUndefined();
		click(/** @type {HTMLElement} */ (backBtn));
		expect(onBack).toHaveBeenCalledTimes(1);
	});
});
