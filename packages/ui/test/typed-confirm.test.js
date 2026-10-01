// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TypedConfirmDialog } from '../src/index.js';
import { act, byLabel, cleanup, click, render, type } from './dom.js';

afterEach(() => cleanup());

const confirmButton = () =>
	/** @type {HTMLButtonElement} */ ([...document.querySelectorAll('button')].find((b) => b.textContent === 'Suspend'));

describe('TypedConfirmDialog', () => {
	it('enables confirmation only for the exact text and a required reason', () => {
		const onConfirm = vi.fn();
		const onClose = vi.fn();
		render(
			<TypedConfirmDialog
				open
				onClose={onClose}
				onConfirm={onConfirm}
				title="Suspend shop?"
				expected="shop.example.com"
				confirmLabel="Suspend"
				reason={{ required: true, label: 'Why' }}
				error="It failed">
				<p>Everything pauses.</p>
			</TypedConfirmDialog>,
		);
		const dialog = /** @type {HTMLElement} */ (document.querySelector('[role="dialog"]'));
		expect(dialog.textContent).toContain('Everything pauses.');
		expect(dialog.textContent).toContain('It failed');
		expect(confirmButton().disabled).toBe(true);
		const input = /** @type {HTMLInputElement} */ (dialog.querySelector('input'));
		type(input, 'shop.example');
		expect(confirmButton().disabled).toBe(true);
		type(input, ' shop.example.com ');
		expect(confirmButton().disabled).toBe(true); // reason still missing
		// submitting while not ready does nothing
		act(() => {
			/** @type {HTMLFormElement} */ (dialog.querySelector('form')).requestSubmit();
		});
		expect(onConfirm).not.toHaveBeenCalled();
		type(byLabel(document, 'Why'), '  fraud  ');
		expect(confirmButton().disabled).toBe(false);
		click(confirmButton());
		expect(onConfirm).toHaveBeenCalledWith({ reason: 'fraud' });
		click(/** @type {HTMLElement} */ ([...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')));
		expect(onClose).toHaveBeenCalled();
	});

	it('works without a reason and is not dismissible while busy', () => {
		const onConfirm = vi.fn();
		const onClose = vi.fn();
		const { rerender } = render(
			<TypedConfirmDialog
				open
				onClose={onClose}
				onConfirm={onConfirm}
				title="Revoke?"
				expected="kid-1"
				danger={false}
				confirmLabel="Suspend"
			/>,
		);
		const input = /** @type {HTMLInputElement} */ (document.querySelector('[role="dialog"] input'));
		type(input, 'kid-1');
		click(confirmButton());
		expect(onConfirm).toHaveBeenCalledWith({ reason: '' });
		rerender(
			<TypedConfirmDialog
				open
				busy
				onClose={onClose}
				onConfirm={onConfirm}
				title="Revoke?"
				expected="kid-1"
				confirmLabel="Suspend"
			/>,
		);
		act(() => {
			document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		});
		expect(onClose).not.toHaveBeenCalled();
		rerender(
			<TypedConfirmDialog
				open={false}
				onClose={onClose}
				onConfirm={onConfirm}
				title="Revoke?"
				expected="kid-1"
				confirmLabel="Suspend"
			/>,
		);
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});
});
