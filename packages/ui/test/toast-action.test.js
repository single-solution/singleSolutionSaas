// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from '../src/index.js';
import { act, byText, cleanup, click, render } from '../src/testing.js';

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

/** @param {{ toast: Parameters<ReturnType<typeof useToast>['show']>[0], seen?: (id: unknown) => void }} props */
const Trigger = ({ toast, seen }) => {
	const api = useToast();
	return (
		<button
			type="button"
			onClick={() => {
				const id = api.show(toast);
				seen?.(id);
			}}>
			go
		</button>
	);
};

describe('a toast with an action button', () => {
	it('shows the action, runs it on a click and goes away', () => {
		vi.useFakeTimers();
		const undo = vi.fn();
		const { container } = render(
			<ToastProvider durationMs={5000}>
				<Trigger toast={{ title: 'Changes discarded', action: { label: 'Undo', onClick: undo } }} />
			</ToastProvider>,
		);
		click(byText(container, 'go', 'button'));
		const live = /** @type {HTMLElement} */ (container.querySelector('[aria-live="polite"]'));
		expect(live.textContent).toContain('Changes discarded');
		click(byText(live, 'Undo', 'button'));
		expect(undo).toHaveBeenCalledTimes(1);
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(container.textContent).not.toContain('Changes discarded');
	});

	it('has no action button unless one is given', () => {
		const { container } = render(
			<ToastProvider>
				<Trigger toast={{ title: 'Saved' }} />
			</ToastProvider>,
		);
		click(byText(container, 'go', 'button'));
		const buttons = [...container.querySelectorAll('[aria-live] button')].map(
			(b) => b.getAttribute('aria-label') ?? b.textContent,
		);
		expect(buttons).toEqual(['Dismiss notification']);
	});

	it('stays as long as its own durationMs says, and show hands back the toast id', () => {
		vi.useFakeTimers();
		/** @type {unknown[]} */
		const ids = [];
		const { container } = render(
			<ToastProvider durationMs={1000}>
				<Trigger toast={{ title: 'Long one', durationMs: 8000 }} seen={(id) => ids.push(id)} />
			</ToastProvider>,
		);
		click(byText(container, 'go', 'button'));
		expect(typeof ids[0]).toBe('number');
		act(() => {
			vi.advanceTimersByTime(7000);
		});
		expect(container.textContent).toContain('Long one');
		act(() => {
			vi.advanceTimersByTime(1500);
		});
		expect(container.textContent).not.toContain('Long one');
	});

	it('reads its dismiss and tone words from the provider texts', () => {
		const { container } = render(
			<ToastProvider texts={{ dismiss: 'Close note' }}>
				<Trigger toast={{ title: 'Hi' }} />
			</ToastProvider>,
		);
		click(byText(container, 'go', 'button'));
		expect(container.querySelector('[aria-live] button')?.getAttribute('aria-label')).toBe('Close note');
	});
});
