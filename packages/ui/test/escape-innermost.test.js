// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionMenu } from '../src/Menu.js';
import { Dialog, Drawer } from '../src/overlay.js';
import { Toolbar } from '../src/Toolbar.js';
import { cleanup, click, keydown, render, type } from '../src/testing.js';

afterEach(cleanup);

const items = [{ label: 'Edit', onSelect: () => undefined }];

/** The menu button inside an overlay. */
const trigger = () => /** @type {HTMLButtonElement} */ (document.querySelector('button[aria-haspopup="menu"]'));

describe('Escape closes only the innermost open thing (77)', () => {
	it('closes a menu inside a drawer and leaves the drawer open, focus back on the menu button', () => {
		const onClose = vi.fn();
		render(
			<Drawer open onClose={onClose} title="Edit">
				<ActionMenu label="More" items={items} />
			</Drawer>,
		);
		click(trigger());
		expect(trigger().getAttribute('aria-expanded')).toBe('true');
		// the first action has the focus: the key starts there
		keydown(/** @type {HTMLElement} */ (document.activeElement), 'Escape');
		expect(trigger().getAttribute('aria-expanded')).toBe('false');
		expect(onClose).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(trigger());
		// with nothing else open, the next Escape closes the drawer
		keydown(/** @type {HTMLElement} */ (document.activeElement), 'Escape');
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('does the same inside a centered dialog', () => {
		const onClose = vi.fn();
		render(
			<Dialog open size="sm" onClose={onClose} title="Sure?">
				<ActionMenu label="More" items={items} />
			</Dialog>,
		);
		click(trigger());
		keydown(/** @type {HTMLElement} */ (document.activeElement), 'Escape');
		expect(trigger().getAttribute('aria-expanded')).toBe('false');
		expect(onClose).not.toHaveBeenCalled();
	});

	it('still closes a menu on a page when the key reaches the document', () => {
		render(<ActionMenu label="More" items={items} />);
		click(trigger());
		keydown(document, 'Escape');
		expect(trigger().getAttribute('aria-expanded')).toBe('false');
	});
});

describe('Escape in a search box inside a drawer only clears or leaves the search (KP-1a left over)', () => {
	const search = () => /** @type {HTMLInputElement} */ (document.querySelector('input[type="search"]'));

	it('clears the typed text and keeps the drawer open', () => {
		const onClose = vi.fn();
		const onSearch = vi.fn();
		render(
			<Drawer open onClose={onClose} title="Pick">
				<Toolbar search={{ onSearch }} />
			</Drawer>,
		);
		type(search(), 'shoes');
		keydown(search(), 'Enter');
		expect(onSearch).toHaveBeenLastCalledWith('shoes');
		keydown(search(), 'Escape');
		expect(search().value).toBe('');
		expect(onSearch).toHaveBeenLastCalledWith('');
		expect(onClose).not.toHaveBeenCalled();
	});

	it('with nothing typed, leaves the search for the drawer; the next Escape closes the drawer', () => {
		const onClose = vi.fn();
		render(
			<Drawer open onClose={onClose} title="Pick">
				<Toolbar search={{ onSearch: vi.fn() }} />
			</Drawer>,
		);
		search().focus();
		keydown(search(), 'Escape');
		expect(onClose).not.toHaveBeenCalled();
		expect(document.activeElement).not.toBe(search());
		expect(document.activeElement?.getAttribute('role')).toBe('dialog');
		keydown(/** @type {HTMLElement} */ (document.activeElement), 'Escape');
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('does the same inside a centered dialog', () => {
		const onClose = vi.fn();
		render(
			<Dialog open size="sm" onClose={onClose} title="Pick">
				<Toolbar search={{ onSearch: vi.fn() }} />
			</Dialog>,
		);
		type(search(), 'a');
		keydown(search(), 'Escape');
		expect(onClose).not.toHaveBeenCalled();
	});
});
