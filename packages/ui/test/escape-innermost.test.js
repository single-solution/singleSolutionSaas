// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionMenu } from '../src/Menu.js';
import { Dialog, Drawer } from '../src/overlay.js';
import { cleanup, click, keydown, render } from '../src/testing.js';

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
