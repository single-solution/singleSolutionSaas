// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ListColumn } from '../src/ListColumn.js';
import { Page } from '../src/Page.js';
import { SaveBar } from '../src/index.js';
import { act, cleanup, click, render } from '../src/testing.js';

/** The clicks that reached the browser's default action (a link that really navigates). @type {MouseEvent[]} */
let navigated = [];
/** @param {MouseEvent} event */
const sawClick = (event) => {
	if (event.target instanceof HTMLAnchorElement) navigated.push(event);
	// jsdom cannot navigate: the test only needs to know the click got through
	event.preventDefault();
};

beforeEach(() => {
	navigated = [];
	document.addEventListener('click', sawClick);
});
afterEach(() => {
	document.removeEventListener('click', sawClick);
	cleanup();
	window.history.replaceState(null, '', '/');
});

/** @param {ParentNode} root @param {string} name */
const button = (root, name) =>
	/** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')].find((b) => b.textContent === name));
const question = () => /** @type {HTMLElement | null} */ (document.querySelector('[role="dialog"]'));

/**
 * A page with a link and a save bar.
 * @param {{ show?: boolean, onSave?: () => unknown, onDiscard?: () => unknown, href?: string, disabled?: boolean }} [props]
 * @param {(event: import('react').MouseEvent) => void} [onLink]
 */
const screen = (
	{ show = true, onSave = vi.fn(), onDiscard = vi.fn(), href = '/products', disabled = false } = {},
	onLink = () => {},
) => (
	<div>
		<a href={href} onClick={onLink}>
			Products
		</a>
		<a href="#top" onClick={onLink}>
			Jump
		</a>
		<SaveBar show={show} onSave={onSave} onDiscard={onDiscard} disabled={disabled} />
	</div>
);

describe('the browser warns before the tab closes while a save bar has changes (113)', () => {
	it('cancels the unload while there are changes, and not otherwise', () => {
		const { rerender } = render(screen({ show: false }));
		const quiet = new Event('beforeunload', { cancelable: true });
		window.dispatchEvent(quiet);
		expect(quiet.defaultPrevented).toBe(false);
		rerender(screen({ show: true }));
		const warned = new Event('beforeunload', { cancelable: true });
		window.dispatchEvent(warned);
		expect(warned.defaultPrevented).toBe(true);
		rerender(screen({ show: false }));
		const after = new Event('beforeunload', { cancelable: true });
		window.dispatchEvent(after);
		expect(after.defaultPrevented).toBe(false);
	});

	it('stops warning once the bar leaves the page', () => {
		const { unmount } = render(screen({ show: true }));
		unmount();
		const event = new Event('beforeunload', { cancelable: true });
		window.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
	});
});

describe('a link that leaves the page asks first (113)', () => {
	it('holds the click back and asks Save, Discard or Stay', () => {
		const onLink = vi.fn();
		const { container } = render(screen({}, onLink));
		click(/** @type {HTMLElement} */ (container.querySelector('a[href="/products"]')));
		expect(onLink).not.toHaveBeenCalled();
		expect(navigated).toHaveLength(0);
		const box = /** @type {HTMLElement} */ (question());
		expect(box.textContent).toContain('You have unsaved changes');
		expect([...box.querySelectorAll('button')].map((b) => b.textContent)).toEqual(
			expect.arrayContaining(['Save', 'Discard', 'Stay']),
		);
		// the safe answer has the focus
		expect(document.activeElement?.textContent).toBe('Stay');
	});

	it('Stay keeps the person here with the changes intact', () => {
		const [onSave, onDiscard] = [vi.fn(), vi.fn()];
		const onLink = vi.fn();
		const { container } = render(screen({ onSave, onDiscard }, onLink));
		click(/** @type {HTMLElement} */ (container.querySelector('a[href="/products"]')));
		click(button(/** @type {HTMLElement} */ (question()), 'Stay'));
		expect(question()).toBeNull();
		expect([onSave.mock.calls.length, onDiscard.mock.calls.length, onLink.mock.calls.length]).toEqual([0, 0, 0]);
		expect(container.querySelector('[role="region"]')).not.toBeNull();
	});

	it('Escape on the question also stays', () => {
		const { container } = render(screen({}));
		click(/** @type {HTMLElement} */ (container.querySelector('a[href="/products"]')));
		act(() => {
			question()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		});
		expect(question()).toBeNull();
		expect(navigated).toHaveLength(0);
	});

	it('Discard throws the changes away and then lets the link go through', () => {
		const [onSave, onDiscard] = [vi.fn(), vi.fn()];
		const onLink = vi.fn();
		const { container } = render(screen({ onSave, onDiscard }, onLink));
		click(/** @type {HTMLElement} */ (container.querySelector('a[href="/products"]')));
		click(button(/** @type {HTMLElement} */ (question()), 'Discard'));
		expect([onSave.mock.calls.length, onDiscard.mock.calls.length]).toEqual([0, 1]);
		expect(onLink).toHaveBeenCalledTimes(1);
		expect(navigated).toHaveLength(1);
		expect(question()).toBeNull();
	});

	it('Save saves first and goes on only when it went through', async () => {
		const onSave = vi.fn(async () => undefined);
		const onLink = vi.fn();
		const { container } = render(screen({ onSave }, onLink));
		click(/** @type {HTMLElement} */ (container.querySelector('a[href="/products"]')));
		await act(async () => click(button(/** @type {HTMLElement} */ (question()), 'Save')));
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(onLink).toHaveBeenCalledTimes(1);
		expect(navigated).toHaveLength(1);
		expect(question()).toBeNull();
	});

	it('stays where it is when the save fails (it returned false)', async () => {
		const onSave = vi.fn(async () => false);
		const onLink = vi.fn();
		const { container } = render(screen({ onSave }, onLink));
		click(/** @type {HTMLElement} */ (container.querySelector('a[href="/products"]')));
		await act(async () => click(button(/** @type {HTMLElement} */ (question()), 'Save')));
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(onLink).not.toHaveBeenCalled();
		expect(navigated).toHaveLength(0);
		expect(question()).toBeNull();
	});

	it('stays where it is when the save throws', async () => {
		const onSave = vi.fn(async () => {
			throw new Error('nope');
		});
		const { container } = render(screen({ onSave }));
		click(/** @type {HTMLElement} */ (container.querySelector('a[href="/products"]')));
		await act(async () => click(button(/** @type {HTMLElement} */ (question()), 'Save')));
		expect(navigated).toHaveLength(0);
		expect(question()).toBeNull();
	});

	it('keeps Save off in the question when the bar keeps it off', () => {
		const { container } = render(screen({ disabled: true }));
		click(/** @type {HTMLElement} */ (container.querySelector('a[href="/products"]')));
		expect(button(/** @type {HTMLElement} */ (question()), 'Save').disabled).toBe(true);
		expect(button(/** @type {HTMLElement} */ (question()), 'Discard').disabled).toBe(false);
	});

	it('lets every other click through: no changes, a jump inside the page, a new tab, a modified click, another site', () => {
		const onLink = vi.fn();
		const { container, rerender } = render(screen({ show: false }, onLink));
		click(/** @type {HTMLElement} */ (container.querySelector('a[href="/products"]')));
		expect(onLink).toHaveBeenCalledTimes(1);
		rerender(
			<div>
				<a href="/products" target="_blank" onClick={onLink}>
					Blank
				</a>
				<a href="https://example.org/x" onClick={onLink}>
					Away
				</a>
				<a href="#top" onClick={onLink}>
					Jump
				</a>
				<a href="/products" onClick={onLink}>
					Plain
				</a>
				<SaveBar show onSave={vi.fn()} onDiscard={vi.fn()} />
			</div>,
		);
		for (const name of ['Blank', 'Away', 'Jump']) {
			click(/** @type {HTMLElement} */ ([...container.querySelectorAll('a')].find((a) => a.textContent === name)));
		}
		expect(onLink).toHaveBeenCalledTimes(4);
		const plain = /** @type {HTMLElement} */ ([...container.querySelectorAll('a')].find((a) => a.textContent === 'Plain'));
		act(() => {
			plain.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
		});
		expect(onLink).toHaveBeenCalledTimes(5);
		expect(question()).toBeNull();
	});

	it('asks once for two bars on the page, and Discard discards both', () => {
		const [a, b] = [vi.fn(), vi.fn()];
		const { container } = render(
			<div>
				<a href="/products">Products</a>
				<SaveBar show onSave={vi.fn()} onDiscard={a} />
				<SaveBar show onSave={vi.fn()} onDiscard={b} />
			</div>,
		);
		click(/** @type {HTMLElement} */ (container.querySelector('a')));
		expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
		click(button(/** @type {HTMLElement} */ (question()), 'Discard'));
		expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 1]);
	});
});

describe('a move that is not a link asks first too (113)', () => {
	const items = [
		{ id: 'a', name: 'Ada' },
		{ id: 'b', name: 'Bo' },
	];
	/** @param {{ onSelect?: (id: string) => void, guard?: boolean, show?: boolean, selected?: string }} props */
	const list = ({ onSelect = () => {}, guard, show = true, selected = 'a' }) => (
		<div>
			<ListColumn
				label="People"
				items={items}
				idOf={(item) => item.id}
				rowOf={(item) => ({ title: item.name })}
				selected={selected}
				onSelect={onSelect}
				{...(guard === undefined ? {} : { guard })}
			/>
			<SaveBar show={show} onSave={vi.fn()} onDiscard={vi.fn()} />
		</div>
	);
	const row = (/** @type {HTMLElement} */ root, /** @type {string} */ name) =>
		/** @type {HTMLElement} */ ([...root.querySelectorAll('[role="option"]')].find((el) => el.textContent?.includes(name)));

	it('holds back a picked row until Discard', () => {
		const onSelect = vi.fn();
		const { container } = render(list({ onSelect }));
		click(row(container, 'Bo'));
		expect(onSelect).not.toHaveBeenCalled();
		expect(question()).not.toBeNull();
		click(button(/** @type {HTMLElement} */ (question()), 'Discard'));
		expect(onSelect).toHaveBeenCalledWith('b');
	});

	it('does not ask for the row that is already picked, or with nothing unsaved, or when the list says it keeps edits', () => {
		const onSelect = vi.fn();
		const { container, rerender } = render(list({ onSelect }));
		click(row(container, 'Ada'));
		expect(question()).toBeNull();
		expect(onSelect).toHaveBeenCalledTimes(1);
		rerender(list({ onSelect, show: false }));
		click(row(container, 'Bo'));
		expect(onSelect).toHaveBeenCalledTimes(2);
		rerender(list({ onSelect, guard: false }));
		click(row(container, 'Bo'));
		expect(question()).toBeNull();
		expect(onSelect).toHaveBeenCalledTimes(3);
	});

	it('asks nothing in a Page whose body does not follow the pick (its views stay mounted, no edit is lost)', () => {
		const onSelect = vi.fn();
		/** @param {string | undefined} bodyKey */
		const inPage = (bodyKey) => (
			<Page
				crumbs={[{ label: 'People' }]}
				{...(bodyKey === undefined ? {} : { bodyKey })}
				list={
					<ListColumn
						label="People"
						items={items}
						idOf={(item) => item.id}
						rowOf={(item) => ({ title: item.name })}
						selected="a"
						onSelect={onSelect}
					/>
				}>
				<SaveBar show onSave={vi.fn()} onDiscard={vi.fn()} />
			</Page>
		);
		const { container, rerender } = render(inPage(''));
		click(row(container, 'Bo'));
		expect(question()).toBeNull();
		expect(onSelect).toHaveBeenCalledTimes(1);
		// a body that follows the pick (by its own key, or by default) is rebuilt by it: the question comes
		rerender(inPage('a'));
		click(row(container, 'Bo'));
		expect(question()).not.toBeNull();
		expect(onSelect).toHaveBeenCalledTimes(1);
		click(button(/** @type {HTMLElement} */ (question()), 'Stay'));
		rerender(inPage(undefined));
		click(row(container, 'Bo'));
		expect(question()).not.toBeNull();
	});

	it('asks before the Back button of a page with a list (phones)', () => {
		const onBack = vi.fn();
		Object.defineProperty(window, 'matchMedia', {
			configurable: true,
			value: (/** @type {string} */ query) => ({
				matches: query.includes('max-width'),
				addEventListener: () => {},
				removeEventListener: () => {},
			}),
		});
		const { container } = render(
			<Page
				crumbs={[{ label: 'People' }]}
				list={
					<ListColumn
						label="People"
						items={items}
						idOf={(item) => item.id}
						rowOf={(item) => ({ title: item.name })}
						selected="a"
						onBack={onBack}
					/>
				}>
				<SaveBar show onSave={vi.fn()} onDiscard={vi.fn()} />
			</Page>,
		);
		click(/** @type {HTMLElement} */ (container.querySelector('header button[aria-label="Back to the list"]')));
		expect(onBack).not.toHaveBeenCalled();
		click(button(/** @type {HTMLElement} */ (question()), 'Discard'));
		expect(onBack).toHaveBeenCalledTimes(1);
		Reflect.deleteProperty(window, 'matchMedia');
	});
});
