// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { InnerNav } from '../src/InnerNav.js';
import { useHashSection } from '../src/blocks.js';
import { NAV_PANEL } from '../src/layout-metrics.js';
import { act, allByRole, byText, cleanup, click, render, type } from '../src/testing.js';

afterEach(() => {
	cleanup();
	window.location.hash = '';
	vi.useRealTimers();
});

/** @type {import('../src/InnerNav.js').InnerNavGroup[]} */
const groups = [
	{
		label: 'Website',
		items: [
			{ id: 'overview', label: 'Overview', icon: 'home' },
			{ id: 'products', label: 'Products', count: 3, dot: 'attention', dotLabel: 'Needs setup' },
		],
	},
	{
		label: 'Settings',
		items: [
			{ id: 'business', label: 'Business' },
			{ id: 'domains', label: 'Domains', locked: true },
		],
	},
];

/** The wide-screen list (the phone dropdown shows the current item only until it is opened). @param {HTMLElement} root */
const panel = (root) => /** @type {HTMLElement} */ (root.querySelector('nav'));

/** @param {HTMLElement} root @param {string} text */
const link = (root, text) => /** @type {HTMLElement} */ (byText(panel(root) ?? root, text).closest('a,button'));

describe('InnerNav', () => {
	it('shows groups with small labels, counts, dots and locks', () => {
		const { container } = render(<InnerNav groups={groups} value="overview" />);
		const nav = /** @type {HTMLElement} */ (container.querySelector('nav[aria-label="Sections"]'));
		expect(nav.textContent).toContain('Website');
		expect(nav.textContent).toContain('Settings');
		expect(link(nav, 'Products').textContent).toContain('3');
		expect(link(nav, 'Products').textContent).toContain('Needs setup');
		expect(link(nav, 'Domains').querySelector('svg')).not.toBeNull();
		expect(nav.parentElement?.className).toContain(NAV_PANEL.split(' ')[0]);
	});

	it('marks the current item and slides one indicator to a new value', () => {
		const { container, rerender } = render(<InnerNav groups={groups} value="overview" />);
		expect(link(container, 'Overview').getAttribute('aria-current')).toBe('true');
		expect(link(container, 'Products').getAttribute('aria-current')).toBeNull();
		const marker = /** @type {HTMLElement} */ (container.querySelector('[data-ss-indicator]'));
		expect(marker).not.toBeNull();
		rerender(<InnerNav groups={groups} value="products" />);
		expect(link(container, 'Products').getAttribute('aria-current')).toBe('true');
		expect(container.querySelectorAll('[data-ss-indicator]')).toHaveLength(1);
		expect(marker.style.transform).toContain('translateY');
	});

	it('calls onSelect with the id (item handler first, then the shared one)', () => {
		const own = vi.fn();
		const shared = vi.fn();
		const { container } = render(
			<InnerNav
				items={[
					{ id: 'a', label: 'Alpha', onSelect: own },
					{ id: 'b', label: 'Beta' },
				]}
				value="a"
				onSelect={shared}
			/>,
		);
		click(link(container, 'Alpha'));
		expect(own).toHaveBeenCalledWith('a');
		expect(shared).toHaveBeenCalledWith('a', expect.objectContaining({ id: 'a' }));
		click(link(container, 'Beta'));
		expect(shared).toHaveBeenLastCalledWith('b', expect.objectContaining({ id: 'b' }));
	});

	it('draws items with an href as links (router links through linkAs) and others as buttons', () => {
		/** @param {Record<string, any>} props */
		const Router = ({ href, children, ...rest }) => (
			<a href={href} data-router="yes" {...rest}>
				{children}
			</a>
		);
		const { container } = render(
			<InnerNav
				linkAs={Router}
				items={[
					{ id: 'a', label: 'Alpha', href: '/a' },
					{ id: 'b', label: 'Beta' },
				]}
				value="a"
			/>,
		);
		const alpha = link(container, 'Alpha');
		expect(alpha.getAttribute('href')).toBe('/a');
		expect(alpha.getAttribute('data-router')).toBe('yes');
		expect(alpha.getAttribute('aria-current')).toBe('page');
		expect(link(container, 'Beta').tagName).toBe('BUTTON');
	});

	it('works with the address: each item its own URL, and the browser Back button returns', async () => {
		const ids = ['one', 'two', 'three'];
		/** jsdom navigates and fires `hashchange` a moment after the click */
		const settle = () =>
			act(async () => {
				await new Promise((r) => setTimeout(r, 30));
			});
		function Harness() {
			const [active] = useHashSection(ids);
			return <InnerNav items={ids.map((id) => ({ id, label: id.toUpperCase(), href: `#${id}` }))} value={active} />;
		}
		const { container } = render(<Harness />);
		expect(link(container, 'ONE').getAttribute('aria-current')).toBe('page');
		click(link(container, 'TWO'));
		await settle();
		expect(window.location.hash).toBe('#two');
		expect(link(container, 'TWO').getAttribute('aria-current')).toBe('page');
		click(link(container, 'THREE'));
		await settle();
		expect(link(container, 'THREE').getAttribute('aria-current')).toBe('page');
		window.history.back();
		await settle();
		expect(window.location.hash).toBe('#two');
		expect(link(container, 'TWO').getAttribute('aria-current')).toBe('page');
	});

	it('adds a search box above ten items and filters by label', () => {
		const many = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, label: `Setting ${i}` }));
		const { container } = render(<InnerNav items={many} value="s0" />);
		const search = /** @type {HTMLInputElement} */ (container.querySelector('input[type="search"]'));
		expect(search).not.toBeNull();
		type(search, 'setting 11');
		expect(container.textContent).toContain('Setting 11');
		expect(container.textContent).not.toContain('Setting 3');
		type(search, 'zzz');
		expect(container.textContent).toContain('No match');
		type(search, '');
		expect(container.textContent).toContain('Setting 3');
	});

	it('has no search box for ten items or fewer, and keeps the footer fixed', () => {
		const { container } = render(<InnerNav groups={groups} value="overview" footer={<p>Setup 2 of 5</p>} />);
		expect(container.querySelector('input[type="search"]')).toBeNull();
		expect(byText(container, 'Setup 2 of 5')).not.toBeNull();
	});

	it('is a dropdown on phones: a button with the current item that opens the same items', () => {
		const onSelect = vi.fn();
		const { container } = render(<InnerNav groups={groups} value="products" onSelect={onSelect} label="Website pages" />);
		const trigger = /** @type {HTMLButtonElement} */ (container.querySelector('button[aria-haspopup="true"]'));
		expect(trigger.textContent).toContain('Products');
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
		click(trigger);
		expect(trigger.getAttribute('aria-expanded')).toBe('true');
		const menu = /** @type {HTMLElement} */ (container.querySelector('[data-ss-inner-menu]'));
		click(link(menu, 'Business'));
		expect(onSelect).toHaveBeenCalledWith('business', expect.objectContaining({ id: 'business' }));
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
		expect(container.querySelector('[data-ss-inner-menu]')).toBeNull();
	});

	it('closes the phone menu on Escape', () => {
		const { container } = render(<InnerNav groups={groups} value="overview" />);
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-haspopup="true"]')));
		expect(container.querySelector('[data-ss-inner-menu]')).not.toBeNull();
		act(() => {
			document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		});
		expect(container.querySelector('[data-ss-inner-menu]')).toBeNull();
	});

	it('renders its skeleton with the same panel while loading', () => {
		const { container } = render(<InnerNav loading groups={groups} value="overview" />);
		expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
		expect(container.textContent).not.toContain('Overview');
		expect(allByRole(container, 'status').length).toBeGreaterThan(0);
	});

	it('lets the parent control the value in state', () => {
		function Harness() {
			const [value, setValue] = useState('a');
			return (
				<InnerNav
					items={[
						{ id: 'a', label: 'Alpha' },
						{ id: 'b', label: 'Beta' },
					]}
					value={value}
					onSelect={setValue}
				/>
			);
		}
		const { container } = render(<Harness />);
		click(link(container, 'Beta'));
		expect(link(container, 'Beta').getAttribute('aria-current')).toBe('true');
	});
});
