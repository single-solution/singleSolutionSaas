// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { ActionMenu } from '../src/Menu.js';
import { allByRole, cleanup, click, keydown, render } from '../src/testing.js';

afterEach(() => {
	cleanup();
	document.head.querySelectorAll('style[data-test]').forEach((el) => el.remove());
});

/** A stylesheet that hides the rows with the class `gone`, as a container query does at some widths. */
const hideGone = () => {
	const style = document.createElement('style');
	style.setAttribute('data-test', '');
	style.textContent = '.gone { display: none; }';
	document.head.append(style);
};

describe('ActionMenu rows with a class', () => {
	it('puts the class on the row and on the hairline that would lead the menu when every row above has it', () => {
		const { container } = render(
			<ActionMenu
				label="More"
				items={[
					{ label: 'Edit', onSelect: () => {}, className: 'gone' },
					{ label: 'Delete', onSelect: () => {}, danger: true },
				]}
			/>,
		);
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-haspopup="menu"]')));
		const rows = allByRole(container, 'menuitem').map((el) => /** @type {HTMLElement} */ (el.parentElement));
		expect(rows[0]?.className).toBe('gone');
		const hairline = /** @type {HTMLElement} */ (rows[1]?.querySelector('[aria-hidden="true"]'));
		expect(hairline.className).toContain('border-t');
		expect(hairline.className).toContain('gone');
	});

	it('keeps the hairline when a row above does not carry the class', () => {
		const { container } = render(
			<ActionMenu
				label="More"
				items={[
					{ label: 'Edit', onSelect: () => {}, className: 'gone' },
					{ label: 'Open', onSelect: () => {} },
					{ label: 'Delete', onSelect: () => {}, danger: true },
				]}
			/>,
		);
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-haspopup="menu"]')));
		const rows = allByRole(container, 'menuitem').map((el) => /** @type {HTMLElement} */ (el.parentElement));
		expect(rows[2]?.querySelector('[aria-hidden="true"]')?.className).not.toContain('gone');
	});

	it('moves between the rows that show and skips a row the page hides', () => {
		hideGone();
		const { container } = render(
			<ActionMenu
				label="More"
				items={[
					{ label: 'One', onSelect: () => {} },
					{ label: 'Two', onSelect: () => {}, className: 'gone' },
					{ label: 'Three', onSelect: () => {} },
				]}
			/>,
		);
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-haspopup="menu"]')));
		const menu = /** @type {HTMLElement} */ (container.querySelector('[role="menu"]'));
		const items = allByRole(container, 'menuitem');
		expect(document.activeElement).toBe(items[0]);
		keydown(menu, 'ArrowDown');
		expect(document.activeElement).toBe(items[2]);
		keydown(menu, 'ArrowDown');
		expect(document.activeElement).toBe(items[0]);
		keydown(menu, 'End');
		expect(document.activeElement).toBe(items[2]);
	});

	it('opens on the first row that shows', () => {
		hideGone();
		const { container } = render(
			<ActionMenu
				label="More"
				items={[
					{ label: 'One', onSelect: () => {}, className: 'gone' },
					{ label: 'Two', onSelect: () => {} },
				]}
			/>,
		);
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-haspopup="menu"]')));
		expect(document.activeElement).toBe(allByRole(container, 'menuitem')[1]);
	});
});
