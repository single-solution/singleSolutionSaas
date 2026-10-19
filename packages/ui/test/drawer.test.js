// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog, Drawer } from '../src/overlay.js';
import { DRAWER, DRAWER_WIDTH, METRICS } from '../src/layout-metrics.js';
import { DrawerBodySkeleton, DrawerSkeleton } from '../src/skeletons.js';
import { byText, cleanup, click, keydown, render } from '../src/testing.js';

afterEach(() => {
	cleanup();
	Reflect.deleteProperty(window, 'matchMedia');
});

/** @returns {HTMLElement} */
const dialog = () => /** @type {HTMLElement} */ (document.querySelector('[role="dialog"]'));

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

describe('Drawer sizes', () => {
	it('is about 480 px wide (md) or 760 px (lg) and the whole screen on phones', () => {
		render(
			<Drawer open onClose={() => {}} title="Edit">
				x
			</Drawer>,
		);
		expect(dialog().className).toContain(DRAWER_WIDTH.md);
		expect(DRAWER_WIDTH.md).toBe('sm:max-w-[30rem]');
		expect(dialog().className).toContain('w-full');
		expect(dialog().className).toContain('h-full');
		// phones: no gap around the panel, no rounded corners or border
		const layer = /** @type {HTMLElement} */ (dialog().parentElement);
		expect(layer.className).toContain('p-0 sm:p-3');
		expect(layer.getAttribute('data-placement')).toBe('right');
	});

	it('takes the lg width for a big record', () => {
		render(
			<Drawer open onClose={() => {}} title="Order #12" size="lg">
				x
			</Drawer>,
		);
		expect(dialog().className).toContain(DRAWER_WIDTH.lg);
		expect(DRAWER_WIDTH.lg).toBe('sm:max-w-[47.5rem]');
	});
});

describe('Drawer parts', () => {
	it('has its own header (title, status, actions, close), a scrolling body and a fixed footer', () => {
		const onClose = vi.fn();
		const onSave = vi.fn();
		render(
			<Drawer
				open
				onClose={onClose}
				title="Order #12"
				status={[
					{ status: 'active', label: 'Paid' },
					{ status: 'warning', label: 'Late', title: 'Two days late' },
				]}
				actions={{ primary: { label: 'Ship', onClick: onSave }, more: [{ label: 'Print', onSelect: () => {} }] }}
				footer={<button type="button">Save</button>}>
				<p>Body text</p>
			</Drawer>,
		);
		const header = /** @type {HTMLElement} */ (dialog().querySelector('[data-ss-part="header"]'));
		const body = /** @type {HTMLElement} */ (dialog().querySelector('[data-ss-part="body"]'));
		const footer = /** @type {HTMLElement} */ (dialog().querySelector('[data-ss-part="footer"]'));
		expect(header.className).toBe(DRAWER.header);
		expect(header.className).toContain(METRICS.drawerHeader);
		expect(header.querySelector('h2')?.textContent).toBe('Order #12');
		expect(dialog().getAttribute('aria-labelledby')).toBe(header.querySelector('h2')?.id);
		expect(header.textContent).toContain('Paid');
		expect(header.querySelector('[title="Two days late"]')?.textContent).toBe('Late');
		click(byText(header, 'Ship', 'button'));
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(header.querySelector('button[aria-label="More actions"]')).not.toBeNull();
		click(/** @type {HTMLElement} */ (header.querySelector('button[aria-label="Close"]')));
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(body.className).toContain('ss-scroll');
		expect(body.className).toContain('min-h-0 flex-1');
		expect(body.textContent).toContain('Body text');
		expect(footer.className).toBe(DRAWER.footer);
		expect(footer.className).toContain(METRICS.drawerFooter);
		expect(footer.textContent).toBe('Save');
		// the three parts are siblings: only the body scrolls
		expect([...dialog().children]).toEqual([header, body, footer]);
	});

	it('has no footer or status when it has none, and keeps the description at the top of the body', () => {
		render(
			<Drawer open onClose={() => {}} title="Edit" description="Change the name">
				<input aria-label="Name" />
			</Drawer>,
		);
		expect(dialog().querySelector('[data-ss-part="footer"]')).toBeNull();
		expect(dialog().querySelector('[data-ss-part="header"] [role="status"]')).toBeNull();
		const text = /** @type {HTMLElement} */ (byText(dialog(), 'Change the name'));
		expect(text.closest('[data-ss-part="body"]')).not.toBeNull();
		expect(dialog().getAttribute('aria-describedby')).toBe(text.id);
	});

	it('folds the secondary actions into More on phones', () => {
		phone(true);
		render(
			<Drawer
				open
				onClose={() => {}}
				title="Edit"
				actions={{ primary: { label: 'Save', onClick: () => {} }, secondary: [{ label: 'Duplicate', onClick: () => {} }] }}>
				x
			</Drawer>,
		);
		const header = /** @type {HTMLElement} */ (dialog().querySelector('[data-ss-part="header"]'));
		expect(byText(header, 'Save', 'button')).not.toBeNull();
		click(/** @type {HTMLElement} */ (header.querySelector('button[aria-label="More actions"]')));
		expect(document.querySelector('[role="menu"]')?.textContent).toContain('Duplicate');
	});

	it('can leave out the close button (dismissible false) and closes on Escape otherwise', () => {
		const onClose = vi.fn();
		const { rerender } = render(
			<Drawer open onClose={onClose} title="Edit" dismissible={false}>
				x
			</Drawer>,
		);
		expect(dialog().querySelector('button[aria-label="Close"]')).toBeNull();
		keydown(dialog(), 'Escape');
		expect(onClose).not.toHaveBeenCalled();
		rerender(
			<Drawer open onClose={onClose} title="Edit" closeLabel="Dismiss">
				x
			</Drawer>,
		);
		keydown(dialog(), 'Escape');
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(dialog().querySelector('button[aria-label="Dismiss"]')).not.toBeNull();
	});

	it('renders nothing while it is closed and slides away when it closes', () => {
		/** @param {{ initial: boolean }} props */
		function Harness({ initial }) {
			const [open, setOpen] = useState(initial);
			return (
				<>
					<button type="button" onClick={() => setOpen((o) => !o)}>
						Toggle
					</button>
					<Drawer open={open} onClose={() => setOpen(false)} title="Edit">
						x
					</Drawer>
				</>
			);
		}
		const { container } = render(<Harness initial={false} />);
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		click(byText(container, 'Toggle', 'button'));
		expect(dialog().className).toContain('animate-ss-side');
	});
});

describe('Drawer while loading', () => {
	it('keeps the real header and footer and draws a skeleton body of the same parts', () => {
		render(
			<Drawer open onClose={() => {}} title="Order #12" loading footer={<button type="button">Save</button>}>
				<p>Real body</p>
			</Drawer>,
		);
		const body = /** @type {HTMLElement} */ (dialog().querySelector('[data-ss-part="body"]'));
		expect(dialog().getAttribute('aria-busy')).toBe('true');
		expect(body.className).toBe(DRAWER.body);
		expect(body.textContent).not.toContain('Real body');
		expect(body.querySelector('[role="status"]')).not.toBeNull();
		expect(dialog().querySelector('h2')?.textContent).toBe('Order #12');
		expect(dialog().querySelector('[data-ss-part="footer"]')?.textContent).toBe('Save');
	});

	it('can show its own skeleton body', () => {
		render(
			<Drawer open onClose={() => {}} title="Edit" loading skeleton={<p data-testid="mine">custom</p>}>
				x
			</Drawer>,
		);
		expect(document.querySelector('[data-testid="mine"]')).not.toBeNull();
	});
});

describe('DrawerSkeleton', () => {
	it('is the whole panel at the real size: header, body and footer with the same classes', () => {
		const { container } = render(<DrawerSkeleton size="lg" />);
		const root = /** @type {HTMLElement} */ (container.firstElementChild);
		expect(root.getAttribute('aria-busy')).toBe('true');
		expect(root.className).toContain(DRAWER.panel);
		expect(root.className).toContain(DRAWER_WIDTH.lg);
		expect(root.querySelector('[data-ss-part="header"]')?.className).toBe(DRAWER.header);
		expect(root.querySelector('[data-ss-part="body"]')?.className).toBe(DRAWER.body);
		expect(root.querySelector('[data-ss-part="footer"]')?.className).toBe(DRAWER.footer);
	});

	it('leaves the footer out and takes the md width by default', () => {
		const { container } = render(<DrawerSkeleton footer={false} />);
		const root = /** @type {HTMLElement} */ (container.firstElementChild);
		expect(root.className).toContain(DRAWER_WIDTH.md);
		expect(root.querySelector('[data-ss-part="footer"]')).toBeNull();
	});

	it('has a body skeleton of its own for a loading drawer', () => {
		const { container } = render(<DrawerBodySkeleton />);
		expect(container.querySelector('[role="status"]')).not.toBeNull();
	});
});

describe('Dialog on the right is the same drawer', () => {
	it('uses the drawer widths and parts, and keeps its description', () => {
		render(
			<Dialog
				open
				onClose={() => {}}
				title="Add a merchant"
				description="Fill in the form"
				size="lg"
				footer={<span>foot</span>}>
				<p>fields</p>
			</Dialog>,
		);
		expect(dialog().className).toContain(DRAWER_WIDTH.lg);
		expect(dialog().querySelector('[data-ss-part="header"] h2')?.textContent).toBe('Add a merchant');
		expect(dialog().querySelector('[data-ss-part="body"]')?.textContent).toContain('Fill in the form');
		expect(dialog().querySelector('[data-ss-part="footer"]')?.textContent).toBe('foot');
	});

	it('stays a centered dialog for a short confirmation', () => {
		render(
			<Dialog open onClose={() => {}} title="Sure?" size="sm">
				x
			</Dialog>,
		);
		expect(/** @type {HTMLElement} */ (dialog().parentElement).getAttribute('data-placement')).toBe('center');
		expect(dialog().querySelector('[data-ss-part="header"]')).toBeNull();
	});
});
