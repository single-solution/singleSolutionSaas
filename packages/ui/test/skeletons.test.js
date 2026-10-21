// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { ROW_GRID, ROW_LABEL } from '../src/fields.js';
import { Card, SettingRow, SettingsCard, Stat, StatGrid } from '../src/index.js';
import { CARD, DRAWER, DRAWER_WIDTH, LIST, PAGE, pageBody } from '../src/layout-metrics.js';
import {
	DrawerBodySkeleton,
	DrawerSkeleton,
	PageSkeleton,
	RowListSkeleton,
	SettingsCardSkeleton,
	StatGridSkeleton,
} from '../src/skeletons.js';
import { cleanup, render } from '../src/testing.js';

afterEach(cleanup);

/** @param {Element | null | undefined} el */
const cls = (el) => el?.getAttribute('class') ?? '';

describe('SettingsCardSkeleton', () => {
	it('is the box, header and body of a real settings card, and says nothing to a screen reader', () => {
		const real = render(
			<SettingsCard title="Title" description="One line">
				<SettingRow label="Label">
					<input aria-label="x" />
				</SettingRow>
			</SettingsCard>,
		).container;
		const { container } = render(<SettingsCardSkeleton rows={1} />);
		const box = /** @type {HTMLElement} */ (container.firstElementChild);
		expect(box.getAttribute('aria-hidden')).toBe('true');
		expect(cls(box)).toContain(CARD.box);
		expect(cls(real.querySelector('section'))).toContain(CARD.box);
		expect(cls(box.querySelector('div'))).toBe(CARD.header);
		expect(cls(real.querySelector('header'))).toBe(CARD.header);
		const body = /** @type {HTMLElement} */ (box.children[1]);
		expect(body.className).toContain(CARD.bodyWithHeader);
		expect(body.className).toContain('@container');
		expect(cls(real.querySelector('section > div'))).toContain(CARD.bodyWithHeader);
	});

	it('draws the rows asked for, label on the left and control on the right like the real row', () => {
		const real = render(
			<SettingsCard>
				<SettingRow label="Label">
					<input aria-label="x" />
				</SettingRow>
			</SettingsCard>,
		).container;
		const { container } = render(<SettingsCardSkeleton rows={4} />);
		const rows = [...container.querySelectorAll('[class*="grid"]')];
		expect(rows.length).toBe(4);
		for (const row of rows) expect(cls(row)).toBe(ROW_GRID);
		expect(cls(real.querySelector('[role="group"]'))).toContain(ROW_GRID);
		expect(cls(rows[0]?.firstElementChild)).toBe(ROW_LABEL);
	});

	it('leaves the title and description out for a card without a header, with the plain body padding', () => {
		const { container } = render(<SettingsCardSkeleton rows={2} title={false} className="extra" />);
		const box = /** @type {HTMLElement} */ (container.firstElementChild);
		expect(box.className).toContain('extra');
		expect(box.children.length).toBe(1);
		expect(box.children[0]?.className).toContain(CARD.body);
		expect(box.children[0]?.className).not.toContain('pt-3');
	});
});

describe('StatGridSkeleton', () => {
	it('is the grid and the tiles of real stats', () => {
		const real = render(
			<StatGrid>
				<Stat label="Orders" value="12" hint="today" />
			</StatGrid>,
		).container;
		const { container } = render(<StatGridSkeleton tiles={3} />);
		expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
		const tiles = [...container.querySelectorAll(`[class~="rounded-card"]`)];
		expect(tiles.length).toBe(3);
		for (const tile of tiles) expect(cls(tile)).toBe(CARD.tile);
		expect(cls(real.querySelector('[class~="rounded-card"]'))).toContain(CARD.tile);
		// the grid class is the one the real grid uses
		expect(cls(tiles[0]?.parentElement)).toBe(cls(real.querySelector('[class~="rounded-card"]')?.parentElement));
	});

	it('shows four tiles by default and takes a class', () => {
		const { container } = render(<StatGridSkeleton className="mt-2" />);
		expect(container.querySelectorAll('[class~="rounded-card"]').length).toBe(4);
		expect(cls(container.firstElementChild)).toContain('mt-2');
	});
});

describe('RowListSkeleton', () => {
	it('is one spoken status of rows with the height of a real row', () => {
		const { container } = render(<RowListSkeleton rows={2} label="Loading consents" />);
		const status = /** @type {HTMLElement} */ (container.firstElementChild);
		expect(status.getAttribute('role')).toBe('status');
		expect(status.getAttribute('aria-label')).toBe('Loading consents');
		expect(status.children).toHaveLength(2);
		expect(cls(status.firstElementChild)).toContain(LIST.row);
	});
});

describe('the other skeletons', () => {
	it('a plain Card is the same box', () => {
		const real = render(<Card title="T">x</Card>).container;
		expect(cls(real.firstElementChild)).toContain(CARD.box);
	});

	it('the drawer body is a spoken status over two cards', () => {
		const { container } = render(<DrawerBodySkeleton label="Loading order" className="mt-1" />);
		const status = /** @type {HTMLElement} */ (container.firstElementChild);
		expect(status.getAttribute('role')).toBe('status');
		expect(status.getAttribute('aria-label')).toBe('Loading order');
		expect(status.className).toContain('mt-1');
		expect(status.children.length).toBe(2);
	});

	it('the drawer skeleton has the panel width of its size, its header, body and footer', () => {
		const md = render(<DrawerSkeleton />).container;
		const lg = render(<DrawerSkeleton size="lg" />).container;
		expect(cls(md.firstElementChild)).toContain(DRAWER_WIDTH.md);
		expect(cls(lg.firstElementChild)).toContain(DRAWER_WIDTH.lg);
		expect(cls(md.querySelector('[data-ss-part="header"]'))).toBe(DRAWER.header);
		expect(cls(md.querySelector('[data-ss-part="body"]'))).toBe(DRAWER.body);
		expect(cls(md.querySelector('[data-ss-part="footer"]'))).toBe(DRAWER.footer);
	});

	it('the drawer skeleton can leave out the footer', () => {
		const { container } = render(<DrawerSkeleton footer={false} className="x" />);
		expect(container.querySelector('[data-ss-part="footer"]')).toBeNull();
		expect(cls(container.firstElementChild)).toContain('x');
	});

	it('the page skeleton draws the parts it is asked for, in the page areas', () => {
		const bare = render(<PageSkeleton />).container;
		expect(bare.querySelector('[data-ss-part="toolbar"]')).toBeNull();
		expect(bare.querySelector('[data-ss-part="footer"]')).toBeNull();
		expect(cls(bare.querySelector('[data-ss-part="body"]'))).toBe(pageBody({ toolbar: false, footer: false }));
		const full = render(<PageSkeleton nav toolbar footer flush label="Loading orders" className="mine" />).container;
		expect(cls(full.querySelector('[data-ss-part="toolbar"]'))).toBe(PAGE.toolbar);
		expect(cls(full.querySelector('[data-ss-part="footer"]'))).toBe(PAGE.footer);
		expect(cls(full.querySelector('[data-ss-part="body"]'))).toBe(pageBody({ toolbar: true, footer: true }));
		expect(full.querySelector('[role="status"]')?.textContent).toBe('Loading orders');
		expect(cls(full.querySelector('[data-ss-page]'))).toContain('mine');
		expect(cls(full.querySelector('[data-ss-part="body"] > div'))).toBe(PAGE.flush);
	});

	it('the page skeleton shows the breadcrumbs once they are known', () => {
		const { container } = render(<PageSkeleton crumbs={[{ label: 'Merchants', href: '/m' }, { label: 'Acme' }]} />);
		expect(container.querySelector('a[href="/m"]')?.textContent).toBe('Merchants');
		expect(container.textContent).toContain('Acme');
	});
});
