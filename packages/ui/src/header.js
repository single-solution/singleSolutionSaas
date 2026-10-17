'use client';
/**
 * The page's own part of the frame's header (redesign 2, owner 2026-10-17: "make more use of the header: show more
 * based on the content in the main area"). Inside an `AppShell`, a page's {@link PageHeader} lifts its title, status
 * badge, context (`meta`: key numbers, status, last saved, a view switcher) and main actions into the header, beside the
 * breadcrumbs, so the canvas starts with the content; its one-line description stays at the top of the page. Outside a
 * frame, in a detail pane (`level` 2) and on phones (below 768 px, where the header has no room) it is drawn in the
 * page as before. {@link HeaderMeta} puts context in the header without a title.
 * @module
 */
import { createContext, useContext, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { DOTS } from './display.js';

/** @typedef {import('react').ReactNode} ReactNode */

/**
 * The header's slots, given by `AppShell`: where a page's title, context and actions go, and `lift` (+1 / -1), which
 * tells the frame a page title is shown so it hides its own.
 * @typedef {{ title: HTMLElement | null, meta: HTMLElement | null, actions: HTMLElement | null,
 *   lift: (step: 1 | -1) => void }} HeaderSlots
 */

/** @type {import('react').Context<HeaderSlots | null>} */
export const HeaderSlotsContext = createContext(/** @type {HeaderSlots | null} */ (null));

/** Where the header has room for the page's part (768 px, `md`). */
const WIDE = '(min-width: 768px)';

/**
 * Whether the window is wide enough for the header to hold the page's part; true until the page is in the browser (the
 * server draws the frame's own title) and where the browser cannot tell.
 */
const useWide = () => {
	const [wide, setWide] = useState(true);
	useLayoutEffect(() => {
		const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(WIDE) : null;
		if (!media) return undefined;
		const read = () => setWide(media.matches);
		read();
		media.addEventListener?.('change', read);
		return () => media.removeEventListener?.('change', read);
	}, []);
	return wide;
};

/**
 * Whether this page part goes into the frame's header, and tells the frame while it does.
 * @param {boolean} wanted
 * @returns {HeaderSlots | null} the slots when lifted
 */
const useLift = (wanted) => {
	const slots = useContext(HeaderSlotsContext);
	const wide = useWide();
	const lifted = wanted && slots !== null && wide;
	const lift = slots?.lift;
	useLayoutEffect(() => {
		if (!lifted || !lift) return undefined;
		lift(1);
		return () => lift(-1);
	}, [lifted, lift]);
	return lifted ? slots : null;
};

/**
 * Page title row. Inside a frame the title (an `h1`), its `badge` and `meta` and the `actions` sit in the header and
 * the `subtitle` opens the page. `level` 2 makes it the heading of a detail beside a list (an `h2`, in the page). In the
 * page, the actions sit beside the title while both fit on one line at their natural width; otherwise they move, as one
 * group, onto their own row under the title (they wrap inside the group only when even that row is too narrow).
 * @param {{ title: ReactNode, subtitle?: ReactNode, actions?: ReactNode, breadcrumbs?: ReactNode, badge?: ReactNode,
 *   meta?: ReactNode, level?: 1 | 2 }} props `meta`: context from the page (key numbers, status, last saved)
 */
export function PageHeader({ title, subtitle, actions, breadcrumbs, badge, meta, level = 1 }) {
	const slots = useLift(level === 1 && !breadcrumbs);
	if (slots) {
		return (
			<>
				{slots.title
					? createPortal(
							<div className="flex min-w-0 items-center gap-2.5">
								<h1 className="min-w-0 truncate text-title font-semibold tracking-[-0.01em] text-fg">{title}</h1>
								{badge}
							</div>,
							slots.title,
						)
					: null}
				{meta && slots.meta ? createPortal(meta, slots.meta) : null}
				{actions && slots.actions
					? createPortal(<div className="flex items-center gap-2">{actions}</div>, slots.actions)
					: null}
				{subtitle ? <p className="max-w-3xl text-sm text-muted">{subtitle}</p> : null}
			</>
		);
	}
	const Heading = level === 2 ? 'h2' : 'h1';
	return (
		<div className="space-y-2">
			{breadcrumbs}
			<div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
				<div className="min-w-0 flex-auto">
					<div className="flex flex-wrap items-center gap-2.5">
						<Heading className="min-w-0 text-page font-semibold tracking-[-0.015em] break-words text-balance text-fg">
							{title}
						</Heading>
						{badge}
					</div>
					{subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
					{meta ? <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div> : null}
				</div>
				{actions ? <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div> : null}
			</div>
		</div>
	);
}

/**
 * Context from the page for the frame's header, beside the title: key numbers, a status, "Saved 2 min ago", a filter
 * or view switcher. Outside a frame (and on phones) it is a row in the page.
 * @param {{ children?: ReactNode }} props
 */
export function HeaderMeta({ children }) {
	const slots = useContext(HeaderSlotsContext);
	const wide = useWide();
	if (!children) return null;
	if (slots && wide) return slots.meta ? createPortal(children, slots.meta) : null;
	return <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>;
}

/**
 * One fact in the header's context: a muted label with its value (`3 websites`, `Balance 1,250 credits`), or a status
 * dot with its words.
 * @param {{ label?: ReactNode, children: ReactNode, tone?: import('./display.js').Tone, title?: string }} props
 */
export function HeaderFact({ label, children, tone, title }) {
	return (
		<span title={title} className="inline-flex h-7 min-w-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-surface-2 px-2.5 text-label text-muted">
			{tone ? <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${DOTS[tone]}`} /> : null}
			{label ? <span>{label}</span> : null}
			<span className="font-medium text-fg tabular-nums">{children}</span>
		</span>
	);
}
