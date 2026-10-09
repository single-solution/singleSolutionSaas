// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import {
	AppShell,
	Button,
	Dialog,
	Form,
	NavigationProgress,
	PageTransition,
	PendingHint,
	RouteProgress,
	SwapTransition,
	ToastProvider,
	useNavigationProgress,
	usePresence,
	useToast,
} from '../src/index.js';
import { act, cleanup, click, render } from '../src/testing.js';

afterEach(() => {
	cleanup();
	// @ts-expect-error test double removed
	delete Element.prototype.getAnimations;
});

/**
 * Pretend the browser runs one finite exit animation (and one endless loop, which never counts) on every element.
 * @returns {{ finish: () => Promise<void> }}
 */
const fakeAnimations = () => {
	/** @type {() => void} */
	let end = () => undefined;
	const finished = new Promise((resolve) => {
		end = () => resolve(undefined);
	});
	Element.prototype.getAnimations = /** @type {any} */ (
		() => [
			{ effect: { getComputedTiming: () => ({ iterations: 1 }) }, finished },
			{ effect: { getComputedTiming: () => ({ iterations: Infinity }) }, finished: new Promise(() => undefined) },
		]
	);
	return {
		finish: async () => {
			end();
			await act(async () => {
				await finished;
			});
		},
	};
};

/** @param {{ open: boolean }} props */
function Box({ open }) {
	const presence = usePresence(open);
	if (!presence.mounted) return null;
	return <div ref={presence.ref} data-testid="box" data-state={presence.closing ? 'closed' : 'open'} />;
}

describe('usePresence', () => {
	it('stays mounted while the exit animation runs, then unmounts', async () => {
		const { container, rerender } = render(<Box open={false} />);
		expect(container.querySelector('[data-testid="box"]')).toBeNull();
		rerender(<Box open />);
		expect(container.querySelector('[data-testid="box"]')?.getAttribute('data-state')).toBe('open');
		const animations = fakeAnimations();
		rerender(<Box open={false} />);
		expect(container.querySelector('[data-testid="box"]')?.getAttribute('data-state')).toBe('closed');
		await animations.finish();
		expect(container.querySelector('[data-testid="box"]')).toBeNull();
	});

	it('with reduced motion it unmounts at once', () => {
		fakeAnimations();
		Object.defineProperty(window, 'matchMedia', {
			value: (/** @type {string} */ query) => ({ matches: query.includes('reduced-motion') }),
			configurable: true,
		});
		const { container, rerender } = render(<Box open />);
		rerender(<Box open={false} />);
		expect(container.querySelector('[data-testid="box"]')).toBeNull();
		// @ts-expect-error test double removed
		delete window.matchMedia;
	});

	it('opening again during the exit keeps it, and an unmount drops the pending exit', async () => {
		const animations = fakeAnimations();
		const { container, rerender, unmount } = render(<Box open />);
		rerender(<Box open={false} />);
		rerender(<Box open />);
		expect(container.querySelector('[data-testid="box"]')?.getAttribute('data-state')).toBe('open');
		rerender(<Box open={false} />);
		unmount();
		await animations.finish();
		expect(container.querySelector('[data-testid="box"]')).toBeNull();
	});

	it('a dialog and a toast animate out before they go', async () => {
		const animations = fakeAnimations();
		function Harness() {
			const [open, setOpen] = useState(true);
			const toast = useToast();
			return (
				<>
					<button type="button" onClick={() => setOpen(false)}>
						close
					</button>
					<button type="button" onClick={() => toast.show({ title: 'Saved' })}>
						toast
					</button>
					<Dialog open={open} onClose={() => setOpen(false)} title="Edit">
						<p>Body</p>
					</Dialog>
				</>
			);
		}
		render(
			<ToastProvider>
				<Harness />
			</ToastProvider>,
		);
		const buttons = [...document.querySelectorAll('button')];
		click(/** @type {HTMLElement} */ (buttons.find((b) => b.textContent === 'close')));
		expect(document.querySelector('[role="dialog"]')?.parentElement?.getAttribute('data-state')).toBe('closed');
		click(/** @type {HTMLElement} */ (buttons.find((b) => b.textContent === 'toast')));
		click(/** @type {HTMLElement} */ (document.querySelector('button[aria-label="Dismiss notification"]')));
		expect(document.body.textContent).toContain('Saved');
		await animations.finish();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.body.textContent).not.toContain('Saved');
	});
});

describe('navigation feedback', () => {
	it('the progress bar shows while anything reports progress', () => {
		/** @param {{ busy: boolean }} props */
		function Reporter({ busy }) {
			useNavigationProgress(busy);
			return null;
		}
		const { container, rerender } = render(
			<NavigationProgress>
				<Reporter busy={false} />
			</NavigationProgress>,
		);
		const bar = () => container.querySelector('.ss-progress');
		expect(bar()?.hasAttribute('data-active')).toBe(false);
		rerender(
			<NavigationProgress>
				<Reporter busy />
				<RouteProgress />
			</NavigationProgress>,
		);
		expect(bar()?.hasAttribute('data-active')).toBe(true);
		rerender(
			<NavigationProgress>
				<Reporter busy={false} />
			</NavigationProgress>,
		);
		expect(bar()?.hasAttribute('data-active')).toBe(false);
		// outside a NavigationProgress nothing happens
		render(<RouteProgress />);
	});

	it('the pending hint keeps its size and shows only while pending', () => {
		const { container, rerender } = render(<PendingHint pending={false} className="ml-1" />);
		const hint = /** @type {HTMLElement} */ (container.firstElementChild);
		expect(hint.getAttribute('aria-hidden')).toBe('true');
		expect(hint.hasAttribute('data-pending')).toBe(false);
		expect(hint.className).toContain('size-3.5');
		rerender(<PendingHint pending />);
		expect(hint.hasAttribute('data-pending')).toBe(true);
	});

	it('page and swap transitions wrap their content', () => {
		const { container } = render(
			<>
				<PageTransition className="page">
					<p>Page</p>
				</PageTransition>
				<SwapTransition id="a">
					<p>Item</p>
				</SwapTransition>
			</>,
		);
		const wrapped = container.querySelectorAll('[data-ss-transition]');
		expect(wrapped).toHaveLength(2);
		expect(wrapped[0]?.className).toContain('page');
		expect(container.textContent).toBe('PageItem');
	});

	it('the menu marks the clicked item at once and slides its marker to it', () => {
		const onNavigate = vi.fn();
		/** @param {{ href: string, children?: import('react').ReactNode, onClick?: (event: any) => void }} props */
		function RouterLink({ href, children, onClick, ...rest }) {
			return (
				<a
					{...rest}
					href={href}
					onClick={(event) => {
						onClick?.(event);
						event.preventDefault();
						onNavigate(href);
					}}>
					{children}
				</a>
			);
		}
		const sections = (/** @type {string} */ current) => [
			{
				items: [
					{ href: '/a', label: 'A', current: current === '/a' },
					{ href: '/b', label: 'B', current: current === '/b' },
				],
			},
		];
		const { container, rerender } = render(
			<AppShell sections={sections('/a')} linkAs={RouterLink} themeToggle={false}>
				<p>page</p>
			</AppShell>,
		);
		const nav = /** @type {HTMLElement} */ (container.querySelector('nav'));
		const marker = /** @type {HTMLElement} */ (nav.firstElementChild);
		expect(marker.style.opacity).toBe('1');
		const b = /** @type {HTMLElement} */ (nav.querySelector('a[href="/b"]'));
		expect(b.className).not.toContain('text-on-primary-soft');
		click(b);
		expect(onNavigate).toHaveBeenCalledWith('/b');
		expect(b.className).toContain('text-on-primary-soft');
		rerender(
			<AppShell sections={sections('/b')} linkAs={RouterLink} themeToggle={false}>
				<p>page</p>
			</AppShell>,
		);
		expect(b.getAttribute('aria-current')).toBe('page');
		// a modified click (new tab) does not move the marker
		const a = /** @type {HTMLElement} */ (nav.querySelector('a[href="/a"]'));
		act(() => {
			a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
		});
		expect(a.className).not.toContain('text-on-primary-soft');
		rerender(
			<AppShell sections={sections('/none')} linkAs={RouterLink} themeToggle={false}>
				<p>page</p>
			</AppShell>,
		);
		expect(marker.style.opacity).toBe('0');
	});
});

describe('pending buttons and forms', () => {
	it('a button whose click returns a promise shows its spinner until the promise settles', async () => {
		/** @type {(value?: unknown) => void} */
		let finish = () => undefined;
		/** @type {(reason?: unknown) => void} */
		let fail = () => undefined;
		const onClick = vi
			.fn()
			.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
			.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)))
			.mockImplementationOnce(() => undefined);
		const { container, unmount } = render(<Button onClick={onClick}>Save</Button>);
		const button = /** @type {HTMLButtonElement} */ (container.querySelector('button'));
		click(button);
		expect(button.disabled).toBe(true);
		expect(button.getAttribute('aria-busy')).toBe('true');
		expect(button.querySelector('svg')).not.toBeNull();
		await act(async () => finish());
		expect(button.disabled).toBe(false);
		click(button);
		expect(button.disabled).toBe(true);
		await act(async () => fail(new Error('refused')));
		expect(button.disabled).toBe(false);
		click(button);
		expect(button.disabled).toBe(false);
		expect(onClick).toHaveBeenCalledTimes(3);
		// a promise that settles after the button is gone changes nothing
		const late = render(<Button onClick={() => new Promise((resolve) => (finish = resolve))}>Later</Button>);
		click(/** @type {HTMLElement} */ (late.container.querySelector('button')));
		late.unmount();
		await act(async () => finish());
		unmount();
	});

	it('a form busy with its submit ignores a second one and its submit button shows the spinner', async () => {
		/** @type {(value?: unknown) => void} */
		let finish = () => undefined;
		const onSubmit = vi.fn(() => new Promise((resolve) => (finish = resolve)));
		const { container } = render(
			<Form onSubmit={onSubmit} aria-label="Edit">
				<Button type="submit">Save</Button>
				<Button>Other</Button>
			</Form>,
		);
		const form = /** @type {HTMLFormElement} */ (container.querySelector('form'));
		const [save, other] = /** @type {HTMLButtonElement[]} */ ([...container.querySelectorAll('button')]);
		const submit = () =>
			act(() => {
				form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
			});
		submit();
		submit();
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(form.getAttribute('aria-busy')).toBe('true');
		expect(save?.disabled).toBe(true);
		expect(other?.disabled).toBe(false);
		await act(async () => finish());
		expect(save?.disabled).toBe(false);
		// a plain (sync) submit leaves the form idle
		const sync = vi.fn();
		const plain = render(
			<Form onSubmit={sync}>
				<Button type="submit">Go</Button>
			</Form>,
		);
		act(() => {
			plain.container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		});
		expect(sync).toHaveBeenCalledTimes(1);
		expect(plain.container.querySelector('button')?.disabled).toBe(false);
		// unmounted while its submit runs: nothing happens when it ends
		const gone = render(
			<Form onSubmit={() => new Promise((resolve) => (finish = resolve))}>
				<Button type="submit">Go</Button>
			</Form>,
		);
		act(() => {
			gone.container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		});
		gone.unmount();
		await act(async () => finish());
	});
});
