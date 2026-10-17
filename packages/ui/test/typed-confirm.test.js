// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PasswordConfirmDialog, TypedConfirmDialog } from '../src/index.js';
import { act, byLabel, cleanup, click, render, type } from '../src/testing.js';

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

describe('PasswordConfirmDialog', () => {
	const confirm = (/** @type {string} */ label) =>
		/** @type {HTMLButtonElement} */ ([...document.querySelectorAll('button')].find((b) => b.textContent === label));

	it('asks for the password, sends it with the code and the typed name, and says what was wrong under its field', () => {
		const onConfirm = vi.fn();
		const { rerender } = render(
			<PasswordConfirmDialog
				open
				onClose={() => undefined}
				onConfirm={onConfirm}
				title="Show the token"
				confirmLabel="Show"
			/>,
		);
		const dialog = () => /** @type {HTMLElement} */ (document.querySelector('[role="dialog"]'));
		// only the password; no code field and no typed name until they are asked for
		expect(dialog().querySelectorAll('input')).toHaveLength(1);
		expect(/** @type {HTMLInputElement} */ (byLabel(dialog(), 'Your password')).type).toBe('password');
		expect(confirm('Show').disabled).toBe(true);
		type(byLabel(dialog(), 'Your password'), 'hunter2 hunter2');
		expect(confirm('Show').disabled).toBe(false);
		click(confirm('Show'));
		expect(onConfirm).toHaveBeenLastCalledWith({ password: 'hunter2 hunter2', code: '' });
		// the Portal found the password wrong: said under the password, in the field's own error
		rerender(
			<PasswordConfirmDialog
				open
				onClose={() => undefined}
				onConfirm={onConfirm}
				title="Show the token"
				confirmLabel="Show"
				errors={{ password: 'That password is not right.' }}
			/>,
		);
		expect(dialog().textContent).toContain('That password is not right.');
		expect(dialog().querySelector('[aria-invalid="true"]')).not.toBeNull();
		// two-step on and a destructive action: the code and the typed name are asked for too
		rerender(
			<PasswordConfirmDialog
				open
				danger
				showCode
				expected="Notes"
				onClose={() => undefined}
				onConfirm={onConfirm}
				title="Make a new token"
				confirmLabel="Regenerate"
				errors={{ form: 'Too many tries.' }}
			/>,
		);
		expect(dialog().textContent).toContain('Too many tries.');
		type(byLabel(dialog(), 'Your password'), 'hunter2 hunter2');
		type(byLabel(dialog(), 'Two-step or recovery code'), ' 123456 ');
		expect(confirm('Regenerate').disabled).toBe(true); // the name is not typed yet
		type(/** @type {HTMLInputElement} */ (dialog().querySelectorAll('input')[2]), 'Notes');
		expect(confirm('Regenerate').disabled).toBe(false);
		click(confirm('Regenerate'));
		expect(onConfirm).toHaveBeenLastCalledWith({ password: 'hunter2 hunter2', code: '123456' });
	});

	it('forgets what was typed each time it opens, and cannot be closed while it works', () => {
		const onClose = vi.fn();
		const { rerender } = render(
			<PasswordConfirmDialog open onClose={onClose} onConfirm={() => undefined} title="Show the token" />,
		);
		type(byLabel(document, 'Your password'), 'typed once');
		rerender(<PasswordConfirmDialog open={false} onClose={onClose} onConfirm={() => undefined} title="Show the token" />);
		rerender(<PasswordConfirmDialog open onClose={onClose} onConfirm={() => undefined} title="Show the token" />);
		expect(/** @type {HTMLInputElement} */ (byLabel(document, 'Your password')).value).toBe('');
		rerender(<PasswordConfirmDialog open busy onClose={onClose} onConfirm={() => undefined} title="Show the token" />);
		click(confirm('Cancel'));
		expect(onClose).not.toHaveBeenCalled();
	});
});
