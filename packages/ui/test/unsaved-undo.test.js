// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Page } from '../src/Page.js';
import { SaveBar, ToastProvider } from '../src/index.js';
import { act, cleanup, click, render } from '../src/testing.js';

beforeEach(() => {
	HTMLElement.prototype.scrollTo = /** @type {any} */ (vi.fn());
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
});

/** @param {ParentNode} root @param {string} name */
const button = (root, name) =>
	/** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')].find((b) => b.textContent === name));
const toasts = () => /** @type {HTMLElement} */ (document.querySelector('[aria-live="polite"]'));

describe('Discard takes effect at once and offers Undo (114)', () => {
	it('discards, then a toast "Changes discarded" brings the edits back with Undo', () => {
		const undo = vi.fn();
		const onDiscard = vi.fn(() => undo);
		const { container } = render(
			<ToastProvider>
				<SaveBar show onSave={vi.fn()} onDiscard={onDiscard} />
			</ToastProvider>,
		);
		click(button(container, 'Discard'));
		expect(onDiscard).toHaveBeenCalledTimes(1);
		expect(toasts().textContent).toContain('Changes discarded');
		expect(undo).not.toHaveBeenCalled();
		click(button(toasts(), 'Undo'));
		expect(undo).toHaveBeenCalledTimes(1);
		expect(toasts().textContent).not.toContain('Changes discarded');
	});

	it('keeps the Undo for about 8 seconds', () => {
		vi.useFakeTimers();
		const { container } = render(
			<ToastProvider>
				<SaveBar show onSave={vi.fn()} onDiscard={() => () => undefined} />
			</ToastProvider>,
		);
		click(button(container, 'Discard'));
		act(() => {
			vi.advanceTimersByTime(7000);
		});
		expect(toasts().textContent).toContain('Undo');
		act(() => {
			vi.advanceTimersByTime(1500);
		});
		expect(toasts().textContent).not.toContain('Undo');
	});

	it('offers no Undo it cannot keep: a discard that gives no way back shows no toast', () => {
		const { container } = render(
			<ToastProvider>
				<SaveBar show onSave={vi.fn()} onDiscard={() => undefined} />
			</ToastProvider>,
		);
		click(button(container, 'Discard'));
		expect(toasts().textContent).toBe('');
	});

	it('says its words from the texts it is given', () => {
		const { container } = render(
			<ToastProvider>
				<SaveBar
					show
					onSave={vi.fn()}
					onDiscard={() => () => undefined}
					texts={{ discarded: 'Edits gone', undo: 'Bring back' }}
				/>
			</ToastProvider>,
		);
		click(button(container, 'Discard'));
		expect(toasts().textContent).toContain('Edits gone');
		expect(button(toasts(), 'Bring back')).toBeTruthy();
	});

	it('on a page with sections, one Discard discards every section and one Undo brings all of them back', () => {
		const [undoA, undoB] = [vi.fn(), vi.fn()];
		const [offA, offB, offC] = [vi.fn(() => undoA), vi.fn(() => undoB), vi.fn()];
		const { container } = render(
			<ToastProvider>
				<Page
					crumbs={[{ label: 'Settings' }]}
					sections={[
						{ id: 'a', label: 'A', body: <SaveBar show onSave={vi.fn()} onDiscard={offA} /> },
						{ id: 'b', label: 'B', body: <SaveBar show onSave={vi.fn()} onDiscard={offB} /> },
						{ id: 'c', label: 'C', body: <SaveBar show={false} onSave={vi.fn()} onDiscard={offC} /> },
					]}
				/>
			</ToastProvider>,
		);
		click(button(container, 'Discard'));
		expect([offA.mock.calls.length, offB.mock.calls.length, offC.mock.calls.length]).toEqual([1, 1, 0]);
		click(button(toasts(), 'Undo'));
		expect([undoA.mock.calls.length, undoB.mock.calls.length]).toEqual([1, 1]);
	});
});
