// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionMenu } from '../src/Menu.js';
import { act, cleanup, click, render } from '../src/testing.js';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const items = [
	{ label: 'Edit', onSelect: () => {} },
	{ label: 'Delete', onSelect: () => {}, danger: true },
];

/** @param {HTMLElement} button @param {Partial<DOMRect>} rect */
const place = (button, rect) => {
	vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(/** @type {DOMRect} */ ({ ...rect }));
};

describe('ActionMenu floating', () => {
	it('stays absolute by default and is fixed from the button when it floats (a button in a scrolling pane)', () => {
		const { container } = render(<ActionMenu label="Row actions" items={items} floating />);
		const button = /** @type {HTMLElement} */ (container.querySelector('button'));
		place(button, { top: 100, bottom: 130, left: 600, right: 640 });
		click(button);
		const menu = /** @type {HTMLElement} */ (container.querySelector('[role="menu"]'));
		expect(menu.className).toContain('fixed');
		expect(menu.className).not.toContain('absolute');
		expect(menu.style.top).toBe('138px');
		expect(menu.style.right).toBe(`${window.innerWidth - 640}px`);
	});

	it('opens upward when there is no room below, and from the left edge with align start', () => {
		const { container } = render(<ActionMenu label="Row actions" items={items} floating align="start" />);
		const button = /** @type {HTMLElement} */ (container.querySelector('button'));
		place(button, { top: window.innerHeight - 20, bottom: window.innerHeight + 10, left: 50, right: 90 });
		click(button);
		const menu = /** @type {HTMLElement} */ (container.querySelector('[role="menu"]'));
		expect(menu.style.bottom).toBe('28px');
		expect(menu.style.left).toBe('50px');
		expect(menu.className).toContain('origin-bottom-left');
	});

	it('closes when the pane scrolls or the window resizes', () => {
		const { container } = render(<ActionMenu label="Row actions" items={items} floating />);
		const button = /** @type {HTMLElement} */ (container.querySelector('button'));
		place(button, { top: 100, bottom: 130, left: 600, right: 640 });
		click(button);
		act(() => {
			document.dispatchEvent(new Event('scroll'));
		});
		expect(container.querySelector('[role="menu"]')).toBeNull();
		click(button);
		expect(container.querySelector('[role="menu"]')).not.toBeNull();
		act(() => {
			window.dispatchEvent(new Event('resize'));
		});
		expect(container.querySelector('[role="menu"]')).toBeNull();
	});

	it('a menu that does not float keeps its absolute place', () => {
		const { container } = render(<ActionMenu label="Row actions" items={items} />);
		click(/** @type {HTMLElement} */ (container.querySelector('button')));
		const menu = /** @type {HTMLElement} */ (container.querySelector('[role="menu"]'));
		expect(menu.className).toContain('absolute');
		expect(menu.style.top).toBe('');
	});
});
