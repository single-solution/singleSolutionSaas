// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Page } from '../src/Page.js';
import { SaveBar } from '../src/index.js';
import { act, cleanup, click, render } from '../src/testing.js';

/** @type {Array<{ callback: (entries: unknown[]) => void, options: unknown, targets: Element[], gone: boolean }>} */
let watchers = [];

beforeEach(() => {
	watchers = [];
	/** The scroll that jsdom does not have; the call is what the tests read. */
	HTMLElement.prototype.scrollTo = /** @type {any} */ (vi.fn());
	// a function (not a class) the page can `new`: it hands back the watcher's two methods
	vi.stubGlobal('IntersectionObserver', function FakeObserver(/** @type {any} */ callback, /** @type {unknown} */ options) {
		const watch = { callback, options, targets: /** @type {Element[]} */ ([]), gone: false };
		watchers.push(watch);
		return {
			observe: (/** @type {Element} */ el) => watch.targets.push(el),
			disconnect: () => {
				watch.gone = true;
			},
		};
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
	Reflect.deleteProperty(window, 'matchMedia');
	window.history.replaceState(null, '', '/');
});

const crumbs = [{ label: 'Settings' }];

/** @param {string[]} ids @param {(id: string) => import('react').ReactNode} [body] */
const parts = (ids, body = (id) => <p>Body of {id}</p>) => ids.map((id) => ({ id, label: id.toUpperCase(), body: body(id) }));

/** @param {HTMLElement} root */
const scroller = (root) => /** @type {HTMLElement} */ (root.querySelector('[data-ss-part="body"]'));

/** The jump list on wide screens. @param {HTMLElement} root */
const jumps = (root) => [...root.querySelectorAll('nav[aria-label="Sections"] [data-ss-nav-item]')];

/** The bars the page draws (the body is a region too). @param {HTMLElement} root */
const bars = (root) => [...root.querySelectorAll('[role="region"][aria-label="Save changes"]')];

/** @param {HTMLElement} root @param {string} name */
const button = (root, name) =>
	/** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')].find((b) => b.textContent === name));

describe('Page sections', () => {
	it('draws every section at once, each a named section, with no inner navigation under four', () => {
		const { container } = render(<Page crumbs={crumbs} sections={parts(['a', 'b', 'c'])} />);
		const found = [...scroller(container).querySelectorAll('section[data-ss-section]')];
		expect(found.map((el) => el.id)).toEqual(['a', 'b', 'c']);
		expect(found.map((el) => el.getAttribute('aria-label'))).toEqual(['A', 'B', 'C']);
		expect(found.map((el) => el.textContent)).toEqual(['Body of a', 'Body of b', 'Body of c']);
		expect(container.querySelector('nav[aria-label="Sections"]')).toBeNull();
		expect(jumps(container)).toHaveLength(0);
	});

	it('lists the sections as jumps from four sections up, with their icons and dots, and children are not drawn', () => {
		const list = [
			{ id: 'a', label: 'A', icon: /** @type {const} */ ('palette'), body: <p>Body of a</p> },
			{ id: 'b', label: 'B', dot: /** @type {const} */ ('attention'), dotLabel: 'Needs setup', body: <p>Body of b</p> },
			...parts(['c', 'd']),
		];
		const { container } = render(
			<Page crumbs={crumbs} sections={list}>
				<p>Children</p>
			</Page>,
		);
		expect(jumps(container).map((el) => el.textContent)).toEqual(['A', 'BNeeds setup', 'C', 'D']);
		expect(jumps(container)[0]?.getAttribute('aria-current')).toBe('true');
		expect(container.textContent).not.toContain('Children');
		// an own `nav` of the page wins
		cleanup();
		const own = render(<Page crumbs={crumbs} sections={list} nav={{ items: [{ id: 'x', label: 'Mine' }], value: 'x' }} />);
		expect(jumps(own.container).map((el) => el.textContent)).toEqual(['Mine']);
	});

	it('scrolls the body to the section on a click, smooth, and names it in the address without a history entry', () => {
		const { container } = render(<Page crumbs={crumbs} sections={parts(['a', 'b', 'c', 'd'])} />);
		const pane = scroller(container);
		const before = window.history.length;
		click(/** @type {Element} */ (jumps(container)[2]));
		expect(/** @type {any} */ (pane.scrollTo)).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
		expect(window.location.hash).toBe('#c');
		expect(window.history.length).toBe(before);
		expect(jumps(container)[2]?.getAttribute('aria-current')).toBe('true');
	});

	it('scrolls at once when the person prefers reduced motion, and by hand where scrollTo is missing', () => {
		Object.defineProperty(window, 'matchMedia', {
			configurable: true,
			value: (/** @type {string} */ query) => ({
				matches: query.includes('reduced-motion'),
				addEventListener: () => {},
				removeEventListener: () => {},
			}),
		});
		const { container } = render(<Page crumbs={crumbs} sections={parts(['a', 'b', 'c', 'd'])} />);
		click(/** @type {Element} */ (jumps(container)[1]));
		expect(/** @type {any} */ (scroller(container).scrollTo)).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
		Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
		const pane = scroller(container);
		pane.scrollTop = 40;
		click(/** @type {Element} */ (jumps(container)[3]));
		expect(pane.scrollTop).toBe(40);
	});

	it('works from the phone dropdown too', () => {
		const { container } = render(<Page crumbs={crumbs} sections={parts(['a', 'b', 'c', 'd'])} />);
		const menu = /** @type {HTMLElement} */ (container.querySelector('button[aria-haspopup="true"]'));
		expect(menu.textContent).toContain('A');
		click(menu);
		click(/** @type {HTMLElement} */ ([...container.querySelectorAll('[data-ss-inner-menu] [data-ss-nav-item]')][2]));
		expect(window.location.hash).toBe('#c');
		expect(/** @type {HTMLElement} */ (container.querySelector('button[aria-haspopup="true"]')).textContent).toContain('C');
	});

	it('scrolls to the section named in the address on load, on Back and for a name that is no section not at all', () => {
		window.history.replaceState(null, '', '/#d');
		const { container } = render(<Page crumbs={crumbs} sections={parts(['a', 'b', 'c', 'd'])} />);
		const scrollTo = /** @type {any} */ (scroller(container).scrollTo);
		expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
		expect(jumps(container)[3]?.getAttribute('aria-current')).toBe('true');
		scrollTo.mockClear();
		window.history.replaceState(null, '', '/#nowhere');
		act(() => {
			window.dispatchEvent(new HashChangeEvent('hashchange'));
		});
		expect(scrollTo).not.toHaveBeenCalled();
		window.history.replaceState(null, '', '/#b');
		act(() => {
			window.dispatchEvent(new PopStateEvent('popstate'));
		});
		expect(scrollTo).toHaveBeenCalledTimes(1);
		expect(jumps(container)[1]?.getAttribute('aria-current')).toBe('true');
	});

	it('highlights the section in the top of the body while scrolling, and the last one at the very end', () => {
		const { container } = render(<Page crumbs={crumbs} sections={parts(['a', 'b', 'c', 'd'])} />);
		const pane = scroller(container);
		const watcher = /** @type {(typeof watchers)[number]} */ (watchers[0]);
		expect(/** @type {any} */ (watcher.options).root === pane).toBe(true);
		expect(watcher.targets.map((el) => el.id)).toEqual(['a', 'b', 'c', 'd']);
		const at = (/** @type {string} */ id, /** @type {boolean} */ isIntersecting) => ({
			target: /** @type {Element} */ (watcher.targets.find((el) => el.id === id)),
			isIntersecting,
		});
		act(() => watcher.callback([at('a', true), at('b', true)]));
		expect(jumps(container)[0]?.getAttribute('aria-current')).toBe('true');
		act(() => watcher.callback([at('a', false)]));
		expect(jumps(container)[1]?.getAttribute('aria-current')).toBe('true');
		act(() => watcher.callback([at('b', false), at('c', true)]));
		expect(jumps(container)[2]?.getAttribute('aria-current')).toBe('true');
		// the end of the page: the last section is the one, although it never reaches the top
		Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 1000 });
		Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 400 });
		pane.scrollTop = 600;
		act(() => {
			pane.dispatchEvent(new Event('scroll'));
		});
		expect(jumps(container)[3]?.getAttribute('aria-current')).toBe('true');
	});

	it('lets a jump keep its highlight while its own scrolling goes by', () => {
		vi.useFakeTimers();
		const { container } = render(<Page crumbs={crumbs} sections={parts(['a', 'b', 'c', 'd'])} />);
		const watcher = /** @type {(typeof watchers)[number]} */ (watchers[0]);
		click(/** @type {Element} */ (jumps(container)[3]));
		act(() => watcher.callback([{ target: /** @type {Element} */ (watcher.targets[0]), isIntersecting: true }]));
		expect(jumps(container)[3]?.getAttribute('aria-current')).toBe('true');
		act(() => {
			vi.advanceTimersByTime(900);
		});
		act(() => watcher.callback([{ target: /** @type {Element} */ (watcher.targets[1]), isIntersecting: true }]));
		expect(jumps(container)[0]?.getAttribute('aria-current')).toBe('true');
	});

	it('stops watching when the page goes', () => {
		const { unmount } = render(<Page crumbs={crumbs} sections={parts(['a', 'b', 'c', 'd'])} />);
		unmount();
		expect(watchers.every((watcher) => watcher.gone)).toBe(true);
	});

	it('gives the loading and the error page no sections, and keeps the jump list in the skeleton', () => {
		const loading = render(<Page crumbs={crumbs} loading sections={parts(['a', 'b', 'c', 'd'])} />);
		expect(loading.container.querySelector('section[data-ss-section]')).toBeNull();
		expect(loading.container.querySelector('[aria-busy="true"]')).not.toBeNull();
		cleanup();
		const failed = render(<Page crumbs={crumbs} error="It broke" sections={parts(['a', 'b'])} />);
		expect(failed.container.querySelector('section[data-ss-section]')).toBeNull();
		expect(failed.container.textContent).toContain('It broke');
	});

	it('works without an IntersectionObserver', () => {
		vi.unstubAllGlobals();
		Reflect.deleteProperty(globalThis, 'IntersectionObserver');
		const { container } = render(<Page crumbs={crumbs} sections={parts(['a', 'b', 'c', 'd'])} />);
		click(/** @type {Element} */ (jumps(container)[1]));
		expect(jumps(container)[1]?.getAttribute('aria-current')).toBe('true');
	});
});

describe('Page sections: one save bar for the page', () => {
	/**
	 * Sections a, b and c, each with a SaveBar; `props` replace what a section's bar gets.
	 * @param {Record<string, Partial<import('react').ComponentProps<typeof SaveBar>>>} props
	 */
	const page = (props) => (
		<Page
			crumbs={crumbs}
			sections={['a', 'b', 'c'].map((id) => ({
				id,
				label: id.toUpperCase(),
				body: <SaveBar show={false} onSave={() => {}} onDiscard={() => {}} {...(props[id] ?? {})} />,
			}))}
		/>
	);

	it('draws nothing for a section without changes, and one bar while any section has changes', () => {
		const { container, rerender } = render(page({}));
		expect(bars(container)).toHaveLength(0);
		rerender(page({ b: { show: true } }));
		expect(bars(container)).toHaveLength(1);
		rerender(page({ a: { show: true }, c: { show: true } }));
		expect(bars(container)).toHaveLength(1);
		expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
		// the bar leaves when the last change is saved or discarded
		rerender(page({}));
		expect(bars(container)).toHaveLength(0);
	});

	it('saves every section with changes, in the order of the page', async () => {
		/** @type {string[]} */
		const calls = [];
		const save = (/** @type {string} */ id) => async () => {
			await Promise.resolve();
			calls.push(id);
		};
		const { container } = render(
			page({
				c: { show: true, onSave: save('c') },
				a: { show: true, onSave: save('a') },
				b: { show: false, onSave: save('b') },
			}),
		);
		await act(async () => click(button(container, 'Save changes')));
		expect(calls).toEqual(['a', 'c']);
		expect(button(container, 'Save changes').getAttribute('aria-busy')).toBeNull();
	});

	it('shows the spinner while a save runs, and stops at the first section that does not go through', async () => {
		/** @type {string[]} */
		const calls = [];
		/** @type {() => void} */
		let finish = () => {};
		const slow = () =>
			new Promise((resolve) => {
				finish = () => {
					calls.push('a');
					resolve(false);
				};
			});
		const { container } = render(page({ a: { show: true, onSave: slow }, b: { show: true, onSave: () => calls.push('b') } }));
		click(button(container, 'Save changes'));
		expect(button(container, 'Save changes').getAttribute('aria-busy')).toBe('true');
		expect(button(container, 'Discard').disabled).toBe(true);
		await act(async () => finish());
		expect(calls).toEqual(['a']);
		// the bar stays so the person can try again
		expect(bars(container)).toHaveLength(1);
		expect(button(container, 'Save changes').getAttribute('aria-busy')).toBeNull();
	});

	it('stops at a section whose save throws or rejects', async () => {
		const later = vi.fn();
		const { container } = render(
			page({
				a: { show: true, onSave: () => Promise.reject(new Error('no')) },
				b: { show: true, onSave: later },
			}),
		);
		await act(async () => click(button(container, 'Save changes')));
		expect(later).not.toHaveBeenCalled();
		cleanup();
		const sync = render(
			page({
				a: {
					show: true,
					onSave: () => {
						throw new Error('no');
					},
				},
				b: { show: true, onSave: later },
			}),
		);
		await act(async () => click(button(sync.container, 'Save changes')));
		expect(later).not.toHaveBeenCalled();
	});

	it('skips a section that has nothing left to save by the time its turn comes', async () => {
		const second = vi.fn();
		const { container, rerender } = render(
			page({
				a: {
					show: true,
					onSave: async () => {
						// the first save started the second section over (it has no changes now)
						rerender(page({ b: { show: false, onSave: second } }));
					},
				},
				b: { show: true, onSave: second },
			}),
		);
		await act(async () => click(button(container, 'Save changes')));
		expect(second).not.toHaveBeenCalled();
		expect(bars(container)).toHaveLength(0);
	});

	it('discards every section with changes', () => {
		const [a, b, c] = [vi.fn(), vi.fn(), vi.fn()];
		const { container } = render(
			page({ a: { show: true, onDiscard: a }, b: { show: true, onDiscard: b }, c: { onDiscard: c } }),
		);
		click(button(container, 'Discard'));
		expect([a.mock.calls.length, b.mock.calls.length, c.mock.calls.length]).toEqual([1, 1, 0]);
	});

	it('is busy while any section is saving, and keeps Save off while any section cannot save', () => {
		const { container, rerender } = render(page({ a: { show: true }, b: { show: true, saving: true } }));
		expect(button(container, 'Save changes').getAttribute('aria-busy')).toBe('true');
		expect(button(container, 'Discard').disabled).toBe(true);
		rerender(page({ a: { show: true }, b: { show: true, disabled: true } }));
		expect(button(container, 'Save changes').disabled).toBe(true);
		expect(button(container, 'Discard').disabled).toBe(false);
	});

	it('says what the first section with changes says', () => {
		const { container } = render(
			page({
				b: { show: true, message: '2 changes', saveLabel: 'Save list', discardLabel: 'Cancel' },
				c: { show: true, message: 'Other', saveLabel: 'Other save' },
			}),
		);
		expect(container.querySelector('[role="status"]')?.textContent).toBe('2 changes');
		expect(button(container, 'Save list')).toBeTruthy();
		expect(button(container, 'Cancel')).toBeTruthy();
	});

	it('forgets a bar that leaves the page, and keeps the order of two bars in one section', async () => {
		/** @type {string[]} */
		const calls = [];
		/** @param {boolean} first */
		const two = (first) => (
			<Page
				crumbs={crumbs}
				sections={[
					{
						id: 'a',
						label: 'A',
						body: (
							<>
								{first ? <SaveBar show onSave={() => calls.push('one')} onDiscard={() => {}} /> : null}
								<SaveBar show onSave={() => calls.push('two')} onDiscard={() => {}} />
							</>
						),
					},
				]}
			/>
		);
		const { container, rerender } = render(two(true));
		await act(async () => click(button(container, 'Save changes')));
		expect(calls).toEqual(['one', 'two']);
		calls.length = 0;
		rerender(two(false));
		await act(async () => click(button(container, 'Save changes')));
		expect(calls).toEqual(['two']);
	});

	it('leaves a SaveBar outside a page with sections as it was', () => {
		const onSave = vi.fn();
		const alone = render(<SaveBar show onSave={onSave} onDiscard={vi.fn()} />);
		expect(bars(alone.container)).toHaveLength(1);
		click(button(alone.container, 'Save changes'));
		expect(onSave).toHaveBeenCalledTimes(1);
		cleanup();
		// a Page without sections does not take over its bars
		const plain = render(
			<Page crumbs={crumbs}>
				<SaveBar show onSave={onSave} onDiscard={vi.fn()} />
				<SaveBar show onSave={onSave} onDiscard={vi.fn()} />
			</Page>,
		);
		expect(bars(plain.container)).toHaveLength(2);
	});
});
