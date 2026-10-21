// @vitest-environment jsdom
/**
 * The Overview pattern (PLAN 0.6 "Overviews talk"): a product dashboard's Overview from the kit's overview answer —
 * the greeting and its one sentence, "Needs you" (red first, each with its button), the setup checklist, the numbers
 * and Recent changes in the viewer's local time — and the pieces the Portal's Overviews share.
 */
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ChangesTable,
	NeedsList,
	OverviewSkeleton,
	Page,
	ProductOverview,
	RecentChanges,
	SettingsCardSkeleton,
	SetupChecklist,
	Stat,
	StatGridSkeleton,
	Timeline,
	initialsOf,
} from '../src/index.js';
import { act, allByRole, byText, cleanup, click, render } from '../src/testing.js';

/** @typedef {import('../src/overview.js').DashboardOverview} DashboardOverview */

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

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

/**
 * A kit overview answer: everything ready unless `parts` say otherwise.
 * @param {Partial<DashboardOverview>} [parts]
 * @returns {DashboardOverview}
 */
const answer = (parts = {}) => ({
	website: { websiteId: 'web_1', merchantId: 'mer_1', domain: 'shop.example.com' },
	status: { status: 'active', graceEndsAt: null },
	featuresOn: ['notes', 'inbox'],
	todayMillicredits: 1250,
	checklist: {
		connections: [{ name: 'database', label: 'Merchant database', neededBy: ['notes'], status: 'connected' }],
		widget: { installed: true, lastSeenAt: '2026-10-05T23:15:00.000Z' },
		website: { version: 3, requires: [], missing: [] },
	},
	recentChanges: [{ who: { name: 'Alex Morgan' }, detail: 'Settings: notes', at: '2026-10-06T08:00:00.000Z' }],
	...parts,
});

/** @param {string[]} keys @param {number} [max] */
const namesOf = (keys, max = Infinity) =>
	keys.length > max ? `${keys.slice(0, max).join(', ')} and ${keys.length - max} more` : keys.join(', ');

/**
 * Render a product Overview; `open` and `recheck` are spies.
 * @param {DashboardOverview} data
 * @param {Partial<import('react').ComponentProps<typeof ProductOverview>>} [props]
 */
const show = (data, props = {}) => {
	const open = vi.fn();
	const recheck = vi.fn(async () => undefined);
	const view = render(
		<ProductOverview
			data={data}
			who={{ kind: 'merchant', name: 'Acme Store' }}
			product="Notes"
			support={{ channels: [{ type: /** @type {const} */ ('email'), label: 'Email', url: 'mailto:help@example.com' }] }}
			portal="https://portal.example.com"
			namesOf={namesOf}
			open={open}
			recheck={recheck}
			{...props}
		/>,
	);
	return { ...view, open, recheck, text: view.container.textContent ?? '' };
};

/** @param {ParentNode} root the breadcrumbs of the page's header */
const crumbsOf = (root) =>
	[...root.querySelectorAll('nav[aria-label="Breadcrumb"] li')].map((li) => li.textContent).filter(Boolean);

/** @param {HTMLElement} container the titles of the "Needs you" items, in order */
const needTitles = (container) =>
	[...container.querySelectorAll('section[aria-label="Needs you"] li p:first-child')].map((p) => p.textContent);

describe('a product dashboard Overview', () => {
	it('greets by name, says nothing needs the viewer, and shows the setup done, the numbers and the changes', () => {
		viewerIn('America/New_York');
		const { container, text } = show(answer());
		// the page is a Page: the title is the crumb, the status and the setup progress sit in the header, the greeting
		// behind the (i); no heading of its own in the body
		expect(container.querySelector('[data-ss-page]')).not.toBeNull();
		expect(container.querySelector('h1')?.textContent).toBe('Overview');
		expect(crumbsOf(container)).toEqual(['Notes', 'Overview']);
		expect(container.textContent).not.toContain('Welcome back');
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="About this page"]')));
		expect(container.textContent).toContain('Welcome back, Acme Store');
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="About this page"]')));
		const header = /** @type {HTMLElement} */ (container.querySelector('[data-ss-part="header"]'));
		expect(byText(header, 'Active').closest('span')?.className).toContain('bg-success-soft');
		expect(header.querySelector('[aria-label="Key numbers"]')?.textContent).toContain('4 of 4 done');
		expect(text).toContain('Everything on shop.example.com is ready, and nothing needs you right now.');
		expect(text).toContain('Nothing needs you right now.');
		expect(text).not.toContain('Each item says what happens if it waits.');
		// the setup checklist: a feature on, the database, the widget with its last visit, the website settings
		expect(text).toContain('4 of 4 done');
		expect(allByRole(container, 'progressbar')[0]?.getAttribute('aria-valuenow')).toBe('4');
		expect(text).toContain('Last seen Oct 5, 2026, 7:15 PM EDT');
		expect(byText(container, 'Connect Merchant database').className).toContain('line-through');
		// the numbers: today's cost and the features on, with their names
		expect(text).toContain('1.25 credits');
		expect(text).toContain('So far today (UTC)');
		expect(text).toContain('notes, inbox');
		// Recent changes: who, what and when in the viewer's time, UTC on hover
		expect(text).toContain('Alex Morgan · Settings: notes');
		expect(byText(container, 'AM', 'span').getAttribute('aria-hidden')).toBe('true');
		const times = [...container.querySelectorAll('time')].map((time) => [time.textContent, time.getAttribute('title')]);
		expect(times).toContainEqual(['Oct 6, 2026, 4:00 AM EDT', 'Oct 6, 2026, 8:00 AM UTC']);
	});

	it('lists what needs the viewer, red first, with the right buttons, and names the most urgent in its sentence', async () => {
		viewerIn('America/New_York');
		const data = answer({
			featuresOn: ['notes', 'inbox'],
			checklist: {
				connections: [
					{ name: 'database', label: 'Merchant database', neededBy: ['notes', 'off_feature'], status: 'not_connected' },
					{
						name: 'mail',
						label: 'Mail key',
						neededBy: ['inbox'],
						status: 'test_failed',
						message: 'The key was refused.',
					},
					{ name: 'sms', label: 'SMS key', neededBy: ['inbox'], status: 'test_failed' },
				],
				widget: { installed: false, lastSeenAt: null },
				website: { version: 0, requires: [], missing: [] },
			},
			recentChanges: [],
		});
		const product = { key: 'own', tone: /** @type {const} */ ('warning'), title: 'No note form yet', effect: 'Add one.' };
		const { container, text, open, recheck } = show(data, {
			needs: [product],
			steps: [{ key: 'own', label: 'Add a note form', done: false }],
		});
		expect(needTitles(container)).toEqual([
			'Mail key failed its last test',
			'SMS key failed its last test',
			'Merchant database is not connected',
			'No note form yet',
			'The widget has not been seen on shop.example.com',
			'Needs setup: set your website settings in the Portal',
		]);
		expect(text).toContain('Mail key failed its last test, and 5 more things need you.');
		expect(text).toContain('Each item says what happens if it waits.');
		// a failed test says why; only the switched-on features that need it are named
		expect(text).toContain('The key was refused. Needed by inbox: charged, but not working until it passes.');
		expect(text).toContain('Needed by notes: charged, but not working until it is connected.');
		expect(text).toContain(
			'Your business facts, look, region and Format are set once for all your products. Until then the business name shows as shop.example.com, times use UTC and the widgets use the built-in look.',
		);
		// nothing saved in the Portal yet: a link to its Website settings (a merchant's own page), and Check again
		expect(byText(container, 'Open Website settings', 'a').getAttribute('href')).toBe(
			'https://portal.example.com/websites/web_1/settings',
		);
		click(byText(container, 'Fix it', 'button'));
		click(byText(container, 'Connect', 'button'));
		click(byText(container, 'Get the script', 'button'));
		expect(open.mock.calls).toEqual([['developers', 'connection-mail'], ['developers', 'connection-database'], ['developers']]);
		click(byText(container, 'Check again', 'button'));
		expect(recheck).toHaveBeenCalledTimes(1);
		// the button is busy until the Portal's settings were fetched again
		expect(byText(container, 'Check again', 'button').getAttribute('aria-busy')).toBe('true');
		await act(async () => undefined);
		expect(byText(container, 'Check again', 'button').getAttribute('aria-busy')).toBeNull();
		// setup: a feature on is done; the connections, the product's step, the widget and the website settings are to do
		expect(text).toContain('1 of 7 done');
		expect(text).toContain('Add a note form');
		// each step says why in one plain line and has its own button; a connection opens its own view
		expect(text).toContain('Needed by notes.');
		expect(text).toContain('Visitors see nothing until the widget script is on your pages.');
		const row = /** @type {HTMLElement} */ (byText(container, 'Connect Merchant database', 'span').closest('li'));
		click(byText(row, 'Connect', 'button'));
		expect(open).toHaveBeenLastCalledWith('developers', 'connection-database');
		const widgetRow = /** @type {HTMLElement} */ (byText(container, 'Put the widget on your pages', 'span').closest('li'));
		click(byText(widgetRow, 'Get the script', 'button'));
		expect(open).toHaveBeenLastCalledWith('developers');
		expect(text).toContain('No changes yet.');
	});

	it('asks for what the product needs of the website settings: one need and one step per section, linked to it in the Portal', () => {
		const requires = ['region.currency', 'region.timeZone', 'business.name', 'business.address.city'];
		const data = answer({
			checklist: {
				connections: [],
				widget: null,
				website: { version: 2, requires, missing: ['region.currency', 'region.timeZone', 'business.address.city'] },
			},
		});
		const { container, text } = show(data, { who: { kind: 'admin', name: 'Sam Lee' } });
		expect(needTitles(container)).toEqual([
			'Needs setup: set currency, time zone in the Portal',
			'Needs setup: set address city in the Portal',
		]);
		expect(text).toContain(
			'Notes needs currency, time zone. Set them once in Website settings › Region and format, for all your products.',
		);
		// an Owner or Support admin opens the merchant's page of the website
		expect(
			[...container.querySelectorAll('a')]
				.filter((a) => a.textContent === 'Open Website settings')
				.map((a) => a.getAttribute('href')),
		).toEqual([
			'https://portal.example.com/admin/merchants/mer_1/websites/web_1/settings#region',
			'https://portal.example.com/admin/merchants/mer_1/websites/web_1/settings#business',
		]);
		// the checklist: a step per section, done when every value of it is set
		expect(text).toContain('Set currency, time zone in Website settings › Region and format');
		expect(text).toContain('Set business name, address city in Website settings › Business');
		expect(text).toContain('1 of 3 done');
		expect(text).toContain('Notes needs currency, time zone.');
		cleanup();
		// everything the product asked for is set: no need, the steps are done
		const done = show(answer({ checklist: { connections: [], widget: null, website: { version: 2, requires, missing: [] } } }));
		expect(needTitles(done.container)).toEqual([]);
		expect(done.text).toContain('3 of 3 done');
		expect(done.container.querySelector('a[href="https://portal.example.com/websites/web_1/settings#region"]')).not.toBeNull();
	});

	it('the status comes first: stopped and in grace send merchants to support, admins to the Portal', () => {
		viewerIn('America/New_York');
		const stopped = show(answer({ status: { status: 'stopped', graceEndsAt: null } }));
		expect(needTitles(stopped.container)).toEqual(['Notes is stopped because the credits ran out']);
		expect(stopped.text).toContain('Notes is stopped because the credits ran out.');
		expect(stopped.text).toContain('It starts again as soon as credits are added: contact help@example.com (Email).');
		expect(byText(stopped.container, 'Contact support', 'a').getAttribute('href')).toBe('mailto:help@example.com');
		expect(byText(stopped.container, 'Stopped').closest('span')?.className).toContain('bg-danger-soft');
		cleanup();

		// the support contact is a list of channels: the button opens the first one; with none there is no button
		const wa = { type: /** @type {const} */ ('link'), label: 'WhatsApp', url: 'https://wa.me/15550100' };
		const two = show(answer({ status: { status: 'stopped', graceEndsAt: null } }), {
			support: { channels: [wa, { type: 'phone', label: 'Phone', url: 'tel:+15550101' }] },
		});
		expect(two.text).toContain('contact https://wa.me/15550100 (WhatsApp), +15550101 (Phone).');
		expect(byText(two.container, 'Contact support', 'a').getAttribute('href')).toBe('https://wa.me/15550100');
		cleanup();
		const none = show(answer({ status: { status: 'stopped', graceEndsAt: null } }), { support: { channels: [] } });
		expect(none.text).toContain('contact support.');
		expect(none.container.querySelector('a[href^="mailto:"]')).toBeNull();
		cleanup();

		const grace = show(answer({ status: { status: 'grace', graceEndsAt: '2026-10-04T14:30:00.000Z' } }), {
			who: { kind: 'admin', name: 'Sam Lee' },
			needs: [{ key: 'own', tone: 'warning', title: 'One more', effect: '.' }],
		});
		click(/** @type {HTMLElement} */ (grace.container.querySelector('button[aria-label="About this page"]')));
		expect(grace.text).not.toContain('Welcome back, Sam Lee');
		expect(grace.container.textContent).toContain('Welcome back, Sam Lee');
		expect(grace.text).toContain('Notes is in grace until Oct 4, 2026, 10:30 AM EDT, and one more thing needs you.');
		expect(grace.text).toContain('Add credits in the Portal.');
		expect(byText(grace.container, 'Open the Portal', 'a').getAttribute('href')).toBe('https://portal.example.com');
		cleanup();

		const suspended = show(answer({ status: { status: 'suspended', graceEndsAt: null } }), {
			who: { kind: 'admin', name: 'Sam Lee' },
		});
		expect(needTitles(suspended.container)).toEqual(['This merchant is suspended']);
		expect(suspended.text).toContain('until the merchant is resumed in the Portal');
	});

	it('with no feature on, says so and opens Settings, where the features are; the setup starts there', () => {
		const data = answer({
			featuresOn: [],
			checklist: { connections: [], widget: null, website: { version: 3, requires: [], missing: [] } },
		});
		const { container, text, open } = show(data);
		expect(text).toContain('No features are on yet.');
		expect(text).toContain('Nothing is charged, and nothing shows on shop.example.com, until a feature is switched on.');
		expect(text).toContain('None yet');
		expect(text).toContain('1 of 2 done');
		click(byText(container, 'See features', 'button'));
		expect(text).toContain('Nothing shows on shop.example.com, and nothing is charged, until a feature is on.');
		expect(byText(container, 'Switch on a feature', 'span').closest('li')?.querySelectorAll('button')).toHaveLength(1);
		click(
			byText(
				/** @type {HTMLElement} */ (byText(container, 'Switch on a feature', 'span').closest('li')),
				'See features',
				'button',
			),
		);
		expect(open.mock.calls).toEqual([['settings'], ['settings']]);
	});

	it('prints UTC on the server and in the first render', () => {
		viewerIn('America/New_York');
		const html = renderToString(
			<ProductOverview
				data={answer({ status: { status: 'grace', graceEndsAt: '2026-10-04T14:30:00.000Z' } })}
				who={{ kind: 'merchant', name: 'Acme Store' }}
				product="Notes"
				support={{ channels: [{ type: /** @type {const} */ ('email'), label: 'Email', url: 'mailto:help@example.com' }] }}
				portal="https://portal.example.com"
				namesOf={namesOf}
				open={() => undefined}
				recheck={async () => undefined}
				numbers={<Stat label="Notes" value={3} />}>
				<p>Own section</p>
			</ProductOverview>,
		);
		for (const words of ['Oct 4, 2026, 2:30 PM UTC', 'Last seen ', 'Oct 5, 2026, 11:15 PM UTC', 'Own section', '>Notes<'])
			expect(html).toContain(words);
		expect(html).not.toContain('EDT');
	});
});

describe('the shared pieces', () => {
	it('a setup checklist links, calls or just names a step to do; done steps are ticked', () => {
		/** @param {{ href: string, className?: string, children?: import('react').ReactNode }} props */
		const Link = ({ href, className, children }) => (
			<a href={href} data-router="yes" className={className}>
				{children}
			</a>
		);
		const select = vi.fn();
		const { container } = render(
			<SetupChecklist
				title="Get ready"
				progress="1 of 4 done"
				labels={{ done: 'Done', todo: 'To do' }}
				linkAs={Link}
				steps={[
					{ key: 'a', label: 'Linked', done: false, href: '/products' },
					{ key: 'b', label: 'Called', done: false, onSelect: select },
					{ key: 'c', label: 'Named', done: false },
					{ key: 'd', label: 'Finished', done: true },
				]}
			/>,
		);
		expect(byText(container, 'Linked', 'a').dataset.router).toBe('yes');
		click(byText(container, 'Called', 'button'));
		expect(select).toHaveBeenCalledTimes(1);
		expect(byText(container, 'Named', 'span').className).toContain('font-medium');
		expect(byText(container, 'Finished', 'span').className).toContain('line-through');
		expect([...container.querySelectorAll('.sr-only')].map((el) => el.textContent)).toEqual([
			'To do',
			'To do',
			'To do',
			'Done',
		]);
		const bar = /** @type {HTMLElement} */ (allByRole(container, 'progressbar')[0]?.firstElementChild);
		expect(bar.style.width).toBe('25%');
		cleanup();
		const empty = render(
			<SetupChecklist title={<b>Ready</b>} progress="" labels={{ done: 'Done', todo: 'To do' }} steps={[]} />,
		);
		const full = /** @type {HTMLElement} */ (allByRole(empty.container, 'progressbar')[0]);
		expect([full.getAttribute('aria-label'), /** @type {HTMLElement} */ (full.firstElementChild).style.width]).toEqual([
			null,
			'100%',
		]);
	});

	it('a setup step with a button says why, an optional one is not counted, and a done one can be reviewed', () => {
		const select = vi.fn();
		const { container } = render(
			<SetupChecklist
				title="Setup"
				progress="1 of 2 done"
				labels={{ done: 'Done', todo: 'To do', review: 'Review', optional: 'Optional' }}
				steps={[
					{
						key: 'a',
						label: 'Set the address',
						why: 'Links need it.',
						actionLabel: 'Set it',
						done: false,
						onSelect: select,
					},
					{
						key: 'b',
						label: 'Pick a sign-in',
						why: 'Hidden once done.',
						detail: 'Now email',
						actionLabel: 'Set it',
						done: true,
						onSelect: select,
					},
					{
						key: 'c',
						label: 'Allow guests',
						why: 'If you want them.',
						actionLabel: 'Choose',
						done: false,
						optional: true,
						onSelect: select,
					},
				]}
			/>,
		);
		const text = container.textContent ?? '';
		expect(text).toContain('Links need it.');
		expect(text).not.toContain('Hidden once done.');
		expect(text).toContain('Now email');
		expect(byText(container, 'Optional', 'span')).toBeTruthy();
		// the progress counts the two required steps only
		const bar = allByRole(container, 'progressbar')[0];
		expect([bar?.getAttribute('aria-valuemax'), bar?.getAttribute('aria-valuenow')]).toEqual(['2', '1']);
		click(byText(container, 'Set it', 'button'));
		click(byText(container, 'Review', 'button'));
		click(byText(container, 'Choose', 'button'));
		expect(select).toHaveBeenCalledTimes(3);
		// the label of a step with a button is plain text, not a second link
		expect(byText(container, 'Set the address', 'span').closest('button')).toBeNull();
	});

	it('Needs you shows its calm line when nothing needs the viewer; the timeline its empty state', () => {
		const { container } = render(
			<>
				<NeedsList items={[]} none="All good." />
				<Timeline items={[]} empty="Nothing yet." />
				<RecentChanges items={[]} />
			</>,
		);
		expect(container.textContent).toContain('All good.');
		expect(container.textContent).toContain('Nothing yet.');
		expect(container.textContent).toContain('No changes yet.');
	});

	it('ChangesTable lists the changes as a table of who, what and when in the viewer’s time, or says there are none', () => {
		viewerIn('America/New_York');
		const items = [
			{ who: { name: 'Alex Morgan' }, detail: 'Turned on Notes', at: '2026-10-04T14:30:00.000Z' },
			{ who: { name: 'Sam' }, detail: 'Changed the price of Inbox', at: '2026-10-03T09:00:00.000Z' },
		];
		const { container } = render(<ChangesTable items={items} />);
		const table = container.querySelector('table');
		expect(table?.querySelector('caption')?.textContent).toBe('Recent changes');
		expect([...(table?.querySelectorAll('thead th') ?? [])].map((cell) => cell.textContent)).toEqual(['Who', 'What', 'When']);
		const rows = [...(table?.querySelectorAll('tbody tr') ?? [])].map((row) => row.textContent ?? '');
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain('Alex Morgan');
		expect(rows[0]).toContain('Turned on Notes');
		expect(rows[0]).toContain('10:30');
		cleanup();
		expect(render(<ChangesTable items={[]} />).container.textContent).toContain('No changes yet.');
		// no list of rows and no heading of its own: the page's title is the header's
		expect(container.querySelector('h1, h2, h3, ul, ol')).toBeNull();
	});

	it('initials of a name, an email address or nothing', () => {
		expect(initialsOf('Alex Morgan')).toBe('AM');
		expect(initialsOf('support@shop.example')).toBe('SS');
		expect(initialsOf('Cher')).toBe('CH');
		expect(initialsOf('  ')).toBe('·');
		expect(initialsOf(null)).toBe('·');
	});

	it('the loading skeleton is made of the stat grid and settings card skeletons, and the page announces it', () => {
		const { container } = render(<OverviewSkeleton />);
		const html = container.innerHTML;
		// the same boxes the real blocks are drawn in: one tile row and the cards of the two columns
		expect(html).toContain(render(<StatGridSkeleton tiles={3} />).container.innerHTML);
		cleanup();
		const shown = render(<OverviewSkeleton />).container.innerHTML;
		expect(shown).toContain(render(<SettingsCardSkeleton rows={4} />).container.innerHTML);
		cleanup();
		// the page's own skeleton says "Loading" once; the body adds no second announcement and no old blocks
		const inPage = render(
			<Page crumbs={[{ label: 'Notes' }, { label: 'Overview' }]} loading skeleton={<OverviewSkeleton />} />,
		);
		expect(allByRole(inPage.container, 'status')).toHaveLength(1);
		expect(inPage.container.querySelector('[data-ss-page][aria-busy="true"]')).not.toBeNull();
		expect(inPage.container.innerHTML).not.toContain('h-28');
	});
});
