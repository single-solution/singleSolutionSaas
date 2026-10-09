'use client';
/**
 * Motion and navigation feedback (PLAN 0.6), shared by the Portal and every product dashboard:
 *
 * - `usePresence(open)` keeps an overlay mounted while its exit animation runs (`data-state="closed"`), then unmounts
 *   it; with reduced motion, or without animations (tests), it unmounts at once.
 * - `NavigationProgress` is the thin bar on top of the page while anything reports progress: a clicked link whose page
 *   is on the way, a route's loading skeleton (`RouteProgress`) or a section loading (`useNavigationProgress`).
 * - `PendingHint` is the small spinner beside a clicked link (fixed size, so nothing moves when it shows).
 * - `PageTransition` and `SwapTransition` animate page and section changes with React's `ViewTransition` (navigations
 *   and other transitions only; plain updates never animate); browsers without view transitions get a CSS enter
 *   animation instead.
 * @module
 */
import { ViewTransition, createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { cx } from './cx.js';
import { Spinner } from './Spinner.js';

/** @typedef {import('react').ReactNode} ReactNode */

/**
 * The running animations of an element and its descendants that end (loops such as spinners never count).
 * @param {Element | null} el
 * @returns {Animation[]}
 */
const exitAnimations = (el) =>
	el && typeof el.getAnimations === 'function'
		? el.getAnimations({ subtree: true }).filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
		: [];

/**
 * Keep an element mounted while it animates out. Render it while `mounted`, put `ref` on its root and set
 * `data-state={closing ? 'closed' : 'open'}` so its exit animation runs.
 * @template {Element} [E=HTMLDivElement]
 * @param {boolean} open
 * @returns {{ mounted: boolean, closing: boolean, ref: import('react').RefObject<E | null> }}
 */
export const usePresence = (open) => {
	const ref = useRef(/** @type {E | null} */ (null));
	const [state, setState] = useState(/** @type {'open' | 'closing' | 'closed'} */ (open ? 'open' : 'closed'));
	if (open && state !== 'open') setState('open');
	if (!open && state === 'open') setState('closing');
	useEffect(() => {
		if (state !== 'closing') return undefined;
		// reduced motion: nothing to wait for
		const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const running = reduced ? [] : exitAnimations(ref.current);
		if (running.length === 0) {
			setState('closed');
			return undefined;
		}
		let live = true;
		void Promise.allSettled(running.map((animation) => animation.finished)).then(() => {
			if (live) setState('closed');
		});
		return () => {
			live = false;
		};
	}, [state]);
	return { mounted: state !== 'closed', closing: state === 'closing', ref };
};

/** @type {import('react').Context<{ begin: () => () => void } | null>} */
const ProgressContext = createContext(/** @type {{ begin: () => () => void } | null} */ (null));

/**
 * The bar on top of the page, shown while anything below reports progress. `AppShell` includes it.
 * @param {{ children?: ReactNode }} props
 */
export function NavigationProgress({ children }) {
	const [count, setCount] = useState(0);
	const api = useMemo(
		() => ({
			begin: () => {
				setCount((n) => n + 1);
				let done = false;
				return () => {
					if (done) return;
					done = true;
					setCount((n) => n - 1);
				};
			},
		}),
		[],
	);
	return (
		<ProgressContext.Provider value={api}>
			{children}
			<div aria-hidden="true" className="ss-progress" data-active={count > 0 ? '' : undefined}>
				<span />
			</div>
		</ProgressContext.Provider>
	);
}

/**
 * Report progress to the bar while `active` (no-op outside `NavigationProgress`).
 * @param {boolean} active
 */
export const useNavigationProgress = (active) => {
	const api = useContext(ProgressContext);
	useEffect(() => (active && api ? api.begin() : undefined), [active, api]);
};

/** Shows the bar while mounted: put it in a route's loading skeleton. */
export function RouteProgress() {
	useNavigationProgress(true);
	return null;
}

/**
 * Fixed-size spinner slot beside a link: invisible until `pending` lasts 100 ms.
 * @param {{ pending: boolean, className?: string }} props
 */
export function PendingHint({ pending, className }) {
	return (
		<span
			aria-hidden="true"
			data-pending={pending ? '' : undefined}
			className={cx('ss-pending-hint inline-flex size-3.5 shrink-0 items-center justify-center', className)}>
			<Spinner size={12} />
		</span>
	);
}

/**
 * A page's content: it fades and slides in when a navigation brings it, and fades out quickly when one takes it away.
 * @param {{ children?: ReactNode, className?: string }} props
 */
export function PageTransition({ children, className }) {
	return (
		<ViewTransition enter="ss-vt-enter" exit="ss-vt-exit" default="none">
			<div data-ss-transition="" className={cx('min-w-0', className)}>
				{children}
			</div>
		</ViewTransition>
	);
}

/**
 * Content that swaps in place (a section, a selected item): a change of `id` inside a transition cross-fades the old
 * content into the new one.
 * @param {{ id: string, children?: ReactNode, className?: string }} props
 */
export function SwapTransition({ id, children, className }) {
	return (
		<ViewTransition key={id} enter="ss-vt-enter" exit="ss-vt-exit" default="none">
			<div data-ss-transition="" className={cx('min-w-0', className)}>
				{children}
			</div>
		</ViewTransition>
	);
}
