// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../src/AppShell.js';
import { SaveBar } from '../src/index.js';
import { act, cleanup, click, render } from '../src/testing.js';

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

/** @param {HTMLElement} root @param {string} name */
const button = (root, name) =>
	/** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')].find((b) => b.textContent === name));

describe('SaveBar floating at the bottom centre', () => {
	it('renders nothing while nothing changed', () => {
		const { container } = render(<SaveBar show={false} onSave={vi.fn()} onDiscard={vi.fn()} />);
		expect(container.innerHTML).toBe('');
	});

	it('floats fixed at the bottom, centred over the page area next to the sidebar, above the page', () => {
		const { container } = render(<SaveBar show onSave={vi.fn()} onDiscard={vi.fn()} />);
		const region = /** @type {HTMLElement} */ (container.querySelector('[role="region"]'));
		expect(region.getAttribute('aria-label')).toBe('Save changes');
		for (const name of [
			'fixed',
			'bottom-4',
			'z-40',
			'justify-center',
			'left-[var(--ss-pane-left,0px)]',
			'right-[var(--ss-pane-right,0px)]',
		]) {
			expect(region.className).toContain(name);
		}
		// the strip itself lets clicks through; only the bar takes them
		expect(region.className).toContain('pointer-events-none');
		expect(region.firstElementChild?.className).toContain('pointer-events-auto');
		expect(region.firstElementChild?.className).toContain('animate-ss-sheet');
	});

	it('says what changed, and reports Save and Discard', () => {
		const onSave = vi.fn();
		const onDiscard = vi.fn();
		const { container } = render(
			<SaveBar show message="3 changes" saveLabel="Save list" discardLabel="Cancel" onSave={onSave} onDiscard={onDiscard} />,
		);
		expect(container.querySelector('[role="status"]')?.textContent).toBe('3 changes');
		click(button(container, 'Save list'));
		click(button(container, 'Cancel'));
		expect([onSave.mock.calls.length, onDiscard.mock.calls.length]).toEqual([1, 1]);
	});

	it('keeps Save off for an entry the server would refuse, while Discard stays on', () => {
		const onSave = vi.fn();
		const { container } = render(<SaveBar show disabled onSave={onSave} onDiscard={vi.fn()} />);
		expect(button(container, 'Save changes').disabled).toBe(true);
		expect(button(container, 'Discard').disabled).toBe(false);
		click(button(container, 'Save changes'));
		expect(onSave).not.toHaveBeenCalled();
	});

	it('shows the spinner and locks Discard while saving, on its own for a save that takes time', async () => {
		/** @type {() => void} */
		let finish = () => {};
		const onSave = vi.fn(() => new Promise((resolve) => (finish = () => resolve(undefined))));
		const { container, rerender } = render(<SaveBar show saving onSave={onSave} onDiscard={vi.fn()} />);
		expect(button(container, 'Save changes').getAttribute('aria-busy')).toBe('true');
		expect(button(container, 'Discard').disabled).toBe(true);
		rerender(<SaveBar show onSave={onSave} onDiscard={vi.fn()} />);
		expect(button(container, 'Save changes').getAttribute('aria-busy')).toBeNull();
		click(button(container, 'Save changes'));
		expect(button(container, 'Save changes').getAttribute('aria-busy')).toBe('true');
		expect(button(container, 'Discard').disabled).toBe(true);
		await act(async () => finish());
		expect(button(container, 'Save changes').getAttribute('aria-busy')).toBeNull();
		expect(button(container, 'Discard').disabled).toBe(false);
	});

	it('is back to idle after a save that failed', async () => {
		const onSave = vi.fn(() => Promise.reject(new Error('no')));
		const { container } = render(<SaveBar show onSave={onSave} onDiscard={vi.fn()} />);
		await act(async () => click(button(container, 'Save changes')));
		expect(button(container, 'Save changes').getAttribute('aria-busy')).toBeNull();
	});

	it('goes away when the changes are saved or discarded', () => {
		const { container, rerender } = render(<SaveBar show onSave={vi.fn()} onDiscard={vi.fn()} />);
		expect(container.querySelector('[role="region"]')).not.toBeNull();
		rerender(<SaveBar show={false} onSave={vi.fn()} onDiscard={vi.fn()} />);
		expect(container.querySelector('[role="region"]')).toBeNull();
	});
});

describe('the pane the SaveBar centres on', () => {
	it('is the space right of the sidebar, and the whole width on phones', () => {
		const { container } = render(
			<AppShell sections={[{ items: [{ href: '/a', label: 'A' }] }]}>
				<p>Body</p>
			</AppShell>,
		);
		const root = /** @type {HTMLElement} */ (container.querySelector('.h-dvh'));
		expect(root.className).toContain('[--ss-pane-left:0.75rem]');
		expect(root.className).toContain('lg:[--ss-pane-left:17rem]');
		expect(root.className).toContain('[--ss-pane-right:0.75rem]');
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="Collapse sidebar"]')));
		expect(root.className).toContain('lg:[--ss-pane-left:6rem]');
	});
});
