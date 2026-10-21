// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppShell, SHELL_TEXTS } from '../src/AppShell.js';
import { cleanup, click, render } from '../src/testing.js';

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

/**
 * @param {import('../src/AppShell.js').NavItem[]} items
 * @param {Partial<Parameters<typeof AppShell>[0]>} [props]
 */
const frame = (items, props = {}) =>
	render(
		<AppShell sections={[{ items }]} {...props}>
			<p>Body</p>
		</AppShell>,
	);

/** @param {HTMLElement} root @param {string} href */
const navLink = (root, href) => /** @type {HTMLElement} */ (root.querySelector(`aside nav a[href="${href}"]`));

describe('AppShell navigation badges', () => {
	it('shows a count at the right of an item, tinted by its tone (neutral by default)', () => {
		const { container } = frame([
			{ href: '/orders', label: 'Orders', badge: { count: 3, tone: 'attention' } },
			{ href: '/products', label: 'Products', badge: { count: 12 } },
		]);
		const orders = /** @type {HTMLElement} */ (navLink(container, '/orders').querySelector('[data-ss-badge]'));
		expect(orders.textContent).toBe('3');
		expect(orders.className).toContain('bg-attention-soft');
		expect(orders.className).toContain('tabular-nums');
		const products = /** @type {HTMLElement} */ (navLink(container, '/products').querySelector('[data-ss-badge]'));
		expect(products.textContent).toBe('12');
		expect(products.className).toContain('bg-surface-2');
	});

	it('writes big counts as 99+ and shows nothing for none', () => {
		const { container } = frame([
			{ href: '/a', label: 'A', badge: { count: 120, tone: 'danger' } },
			{ href: '/b', label: 'B', badge: { count: 0, tone: 'danger' } },
		]);
		expect(navLink(container, '/a').querySelector('[data-ss-badge]')?.textContent).toBe('99+');
		expect(navLink(container, '/b').querySelector('[data-ss-badge]')).toBeNull();
	});

	it('names the count for screen readers when the item says what it counts', () => {
		const { container } = frame([{ href: '/a', label: 'Orders', badge: { count: 4, label: '4 orders to ship' } }]);
		const badge = /** @type {HTMLElement} */ (navLink(container, '/a').querySelector('[data-ss-badge]'));
		expect(badge.getAttribute('title')).toBe('4 orders to ship');
		expect(badge.querySelector('.sr-only')?.textContent).toBe('4 orders to ship');
		expect(badge.querySelector('[aria-hidden="true"]')?.textContent).toBe('4');
	});

	it('shows an attention dot (any tone), named for screen readers', () => {
		const { container } = frame([
			{ href: '/a', label: 'Alerts', dot: true },
			{ href: '/b', label: 'Bills', dot: 'danger', dotLabel: 'Payment failed' },
			{ href: '/c', label: 'Plain' },
		]);
		const first = /** @type {HTMLElement} */ (navLink(container, '/a').querySelector('[data-ss-dot]'));
		expect(first.querySelector('span[aria-hidden="true"]')?.className).toContain('bg-attention-solid');
		expect(first.querySelector('.sr-only')?.textContent).toBe(SHELL_TEXTS.attention);
		const second = /** @type {HTMLElement} */ (navLink(container, '/b').querySelector('[data-ss-dot]'));
		expect(second.querySelector('span[aria-hidden="true"]')?.className).toContain('bg-danger-solid');
		expect(second.querySelector('.sr-only')?.textContent).toBe('Payment failed');
		expect(navLink(container, '/c').querySelector('[data-ss-dot]')).toBeNull();
	});

	it('folds into a small mark on the icon in the rail, with the count spoken', () => {
		const { container } = frame([
			{ href: '/a', label: 'Orders', icon: 'box', badge: { count: 3, tone: 'attention' } },
			{ href: '/b', label: 'Bills', icon: 'wallet', dot: 'danger' },
			{ href: '/c', label: 'Quiet', icon: 'home' },
		]);
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="Collapse sidebar"]')));
		const orders = navLink(container, '/a');
		expect(orders.querySelector('[data-ss-badge]')).toBeNull();
		const mark = /** @type {HTMLElement} */ (orders.querySelector('[data-ss-mark]'));
		expect(mark.getAttribute('aria-hidden')).toBe('true');
		expect(mark.className).toContain('bg-attention-solid');
		expect(orders.textContent).toBe('Orders3');
		const bills = navLink(container, '/b');
		expect(bills.querySelector('[data-ss-mark]')?.className).toContain('bg-danger-solid');
		expect(bills.querySelector('[data-ss-dot]')).toBeNull();
		expect(navLink(container, '/c').querySelector('[data-ss-mark]')).toBeNull();
	});

	it('shows no mark in the rail for a count of none', () => {
		const { container } = frame([{ href: '/a', label: 'A', icon: 'box', badge: { count: 0 } }]);
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="Collapse sidebar"]')));
		expect(navLink(container, '/a').querySelector('[data-ss-mark]')).toBeNull();
	});

	it('carries the badges into the phone sheet', () => {
		const { container } = frame([{ href: '/a', label: 'Orders', badge: { count: 7 } }]);
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="Open navigation"]')));
		const sheet = /** @type {HTMLElement} */ (container.querySelector('[role="dialog"][aria-label="Navigation"]'));
		expect(sheet.querySelector('[data-ss-badge]')?.textContent).toBe('7');
	});
});

describe('AppShell bottom of the sidebar', () => {
	it('holds the one switcher, the help slot, the account with its role chip and the theme', () => {
		const { container } = frame([{ href: '/a', label: 'A' }], {
			switcher: <span>switcher</span>,
			sidebarFooter: <span>help</span>,
			account: { name: 'Eve Owner', email: 'eve@x.test', items: [], role: <span data-testid="role">Owner</span> },
		});
		const aside = /** @type {HTMLElement} */ (container.querySelector('aside'));
		const bottom = /** @type {HTMLElement} */ (aside.querySelector('[data-ss-part="sidebar-bottom"]'));
		expect(bottom.textContent).toContain('switcher');
		expect(bottom.textContent).toContain('help');
		expect(bottom.textContent).toContain('Eve Owner');
		expect(bottom.querySelector('[data-testid="role"]')).not.toBeNull();
		expect(bottom.querySelector('button[aria-label="Collapse sidebar"]')).not.toBeNull();
		// the role is not in the header any more
		expect(container.querySelector('header')?.querySelector('[data-testid="role"]')).toBeNull();
		expect(container.textContent?.match(/switcher/g)).toHaveLength(1);
	});

	it('leaves the role out of the icon rail and the account without a role plain', () => {
		const { container, rerender } = frame([{ href: '/a', label: 'A' }], {
			account: { name: 'Eve', items: [], role: <span data-testid="role">Owner</span> },
		});
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="Collapse sidebar"]')));
		expect(container.querySelector('aside [data-testid="role"]')).toBeNull();
		rerender(
			<AppShell sections={[{ items: [{ href: '/a', label: 'A' }] }]} account={{ name: 'Eve', items: [] }}>
				<p>Body</p>
			</AppShell>,
		);
		expect(container.querySelector('aside [data-testid="role"]')).toBeNull();
	});

	it('keeps the switcher in the icon rail when collapsed', () => {
		const { container } = frame([{ href: '/a', label: 'A' }], {
			switcher: <span data-testid="switcher">Acme Store</span>,
		});
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="Collapse sidebar"]')));
		expect(container.querySelector('aside [data-testid="switcher"]')).not.toBeNull();
	});
});
