'use client';
/**
 * Building blocks shared by console views: the page error, the actions of a detail header (one or two buttons and a
 * More menu), the list-and-detail layout with its list pane, rows and search (PLAN 0.6), and opening a product
 * dashboard in a new tab.
 *
 * Widths (PLAN 0.6 Phones and tablets): the list sits beside the detail only where both have room, from 1280 px
 * (`xl`). From 1024 px (`lg`) the list is a strip above the detail that opens and closes; below 1024 px the two stack.
 * Everything inside the detail follows the detail's own width (container queries in `@ss/ui`).
 *
 * Motion (PLAN 0.6): picking another item keeps the list in place (screen-memory.js) and marks the picked row at once —
 * its highlight slides there — while the detail fades out and the next one fades and slides in.
 * @module
 */
import { ViewTransition, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
	ActionMenu,
	Button,
	ButtonLink,
	ErrorState,
	Icon,
	Input,
	PageTransition,
	SoftBreaks,
	cx,
	describeProblem,
	problemCode,
} from '@ss/ui';
import { CONSOLE } from '../../texts/console.js';
import { Link } from '../link.js';
import { routes } from '../paths.js';
import { ScreenContext, listScroll, listWasPlaceholder, rememberList, stripOpen, useScreen } from './screen-memory.js';

/** @typedef {import('@ss/ui/problems').Problem} Problem */
/**
 * @template [T=any]
 * @typedef {import('../client.js').ApiResult<T>} ApiResult
 */
/** @typedef {(path: string, init?: { method?: string, body?: unknown }) => Promise<ApiResult>} Fetcher */

/**
 * Page-level error: a friendly message, and a way forward (sign in again, go back).
 * @param {{ problem: Problem | null | undefined, title?: string, back?: { href: string, label: string } }} props
 */
export function PageProblem({ problem, title, back }) {
	const code = problemCode(problem);
	const action =
		code === 'unauthorized' ? (
			<ButtonLink as={Link} href={routes.login()} variant="primary">
				{CONSOLE.signIn}
			</ButtonLink>
		) : (
			<ButtonLink as={Link} href={back?.href ?? routes.websites()} variant="secondary">
				{back?.label ?? CONSOLE.backToWebsites}
			</ButtonLink>
		);
	return (
		<ErrorState
			title={title ?? (code === 'not_found' ? CONSOLE.notFound : code === 'forbidden' ? CONSOLE.noAccess : CONSOLE.loadFailed)}
			message={describeProblem(problem)}
			action={action}
		/>
	);
}

/**
 * The actions of a detail header (PLAN 0.6 "fewer levels"): the one or two main actions as buttons (`children`), the
 * rest in a compact More menu (⋯) — a destructive action last, in danger text. They stay together as one group, which
 * `PageHeader` moves under the title where the row is short.
 * @param {{ label: string, children?: import('react').ReactNode, more?: import('@ss/ui').MenuItem[] }} props
 *   `label`: the More button's accessible name
 */
export function HeaderActions({ label, children, more = [] }) {
	return (
		<div className="flex flex-wrap items-center gap-2">
			{children}
			{more.length > 0 ? <ActionMenu label={label} items={more} size="md" /> : null}
		</div>
	);
}

/** Status dot colours (PLAN 0.6: colour is used for status only). */
const DOTS = Object.freeze({ success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', neutral: 'bg-line-strong' });

/** @typedef {'success' | 'warning' | 'danger' | 'neutral'} Dot */

/**
 * A list-and-detail screen (PLAN 0.6): the list and an item's detail on one screen. `detail` is the item the URL selects
 * or, with `auto`, the first item of the list, opened by default so a wide screen is never half empty; with no item at
 * all the detail side shows `empty` (under the list on phones). By width:
 * - from 1280 px the list sits on the left beside the detail;
 * - from 1024 px it is a strip above the detail that opens and closes (`ListPane` holds the Show / Hide list button):
 *   open while nothing is chosen, closed once an item is chosen (picking a row closes it; the person's choice is kept
 *   for the screen while they filter or search);
 * - below 1024 px the two stack: the list alone (an `auto` detail stays hidden there) until an item is chosen, then the
 *   detail alone with a Back link (`back`) to the list.
 * `section` names the screen: its list is kept for the loading skeleton of the next page of the same screen, which
 * renders it again with `going` (the path being opened) and `remember` off.
 * @param {{ label: string, section: string, list: import('react').ReactNode, detail: import('react').ReactNode | null,
 *   empty: import('react').ReactNode, back: { href: string, label: string }, auto?: boolean, going?: string | null,
 *   remember?: boolean }} props
 */
export function ListDetail({ label, section, list, detail, empty, back, auto = false, going = null, remember = true }) {
	const shown = detail !== null && detail !== undefined;
	const chosen = shown && !auto;
	const [open, setOpen] = useState(() => auto || stripOpen(section));
	useEffect(() => {
		if (remember) rememberList(section, list);
	}, [remember, section, list]);
	const toggle = useCallback(() => setOpen((was) => stripOpen(section, !was)), [section]);
	// a picked row's page (and its loading skeleton) opens with the strip closed; this one stays as it is meanwhile
	const picked = useCallback(() => void stripOpen(section, false), [section]);
	const screen = useMemo(
		() => ({ section, going, strip: shown ? { open, toggle, picked } : null }),
		[section, going, shown, open, toggle, picked],
	);
	return (
		<ScreenContext.Provider value={screen}>
			<div className="grid items-start gap-6 xl:grid-cols-[20rem_minmax(0,1fr)] 2xl:grid-cols-[22rem_minmax(0,1fr)] 2xl:gap-8">
				<aside aria-label={label} className={cx('min-w-0 xl:sticky xl:top-24', chosen ? 'hidden lg:block' : 'block')}>
					{list}
				</aside>
				<div className={cx('min-w-0 space-y-8', chosen || !shown ? 'block' : 'hidden lg:block')}>
					{chosen ? <BackLink href={back.href} label={back.label} /> : null}
					<PageTransition className="space-y-8">{shown ? detail : empty}</PageTransition>
				</div>
			</div>
		</ScreenContext.Provider>
	);
}

/**
 * The list pane of a list-and-detail screen: the section's title (the page heading) with its main action, an optional
 * search / filter row, the rows, and an optional footer (load more, bulk actions). Its scroll position is kept per
 * screen; it fades in when it replaces a placeholder list. Where the list is a strip above the detail (1024–1279 px,
 * PLAN 0.6) the title row holds a Show / Hide list button and the rest opens and closes. The pane is a size container:
 * its rows lay out by its width.
 * @param {{ title: string, count?: import('react').ReactNode, action?: import('react').ReactNode,
 *   tools?: import('react').ReactNode, children: import('react').ReactNode, footer?: import('react').ReactNode }} props
 */
export function ListPane({ title, count, action, tools, children, footer }) {
	const { section, going, strip } = useScreen();
	const rows = useRef(/** @type {HTMLUListElement | null} */ (null));
	const body = useId();
	useLayoutEffect(() => {
		if (rows.current && section) rows.current.scrollTop = listScroll(section);
	}, [section]);
	const fades = section !== null && going === null && listWasPlaceholder(section);
	return (
		<div className={cx('@container space-y-3 rounded-card bg-surface p-3 sm:p-4', fades && 'animate-ss-fade')}>
			<div className="flex flex-wrap items-center justify-between gap-2 px-1 pt-1">
				<h1 className="text-xl font-extrabold tracking-tight text-fg">
					{title}
					{count === undefined ? null : <span className="ml-2 text-sm font-semibold text-muted">{count}</span>}
				</h1>
				{strip || action ? (
					<div className="flex flex-wrap items-center gap-2">
						{strip ? (
							<span className="hidden lg:inline-flex xl:hidden">
								<Button
									variant="secondary"
									size="sm"
									aria-expanded={strip.open}
									aria-controls={body}
									onClick={strip.toggle}
									icon={<Icon name="chevronDown" size={14} className={cx('ss-motion', strip.open && '-scale-y-100')} />}>
									{strip.open ? CONSOLE.hideList : CONSOLE.showList}
								</Button>
							</span>
						) : null}
						{action}
					</div>
				) : null}
			</div>
			<div id={body} className={cx('space-y-3', strip && !strip.open && 'lg:max-xl:hidden')}>
				{tools}
				<ul
					ref={rows}
					onScroll={(event) => {
						if (section) listScroll(section, event.currentTarget.scrollTop);
					}}
					className="max-h-none space-y-0.5 overflow-y-auto lg:max-h-[min(28rem,55vh)] xl:max-h-[calc(100vh-17rem)]">
					{children}
				</ul>
				{footer}
			</div>
		</div>
	);
}

/** @param {string} href */
const pathOf = (href) => href.split(/[?#]/)[0] ?? href;

/**
 * One row of a list pane: a link with the name, an optional second line, a status dot and a right-hand figure; the
 * selected row is marked. The name wraps to two lines — on whole words, a domain or e-mail between its parts — before
 * it is cut (the full name on hover). In a pane narrower than 24rem the figure moves under the name, beside the second
 * line (or under it, where both do not fit), so the name and the second line get the whole width. `current="wide"`
 * marks the row opened by default, only where its detail shows with the list (1024 px and up). `leading` sits before
 * the link (a bulk-selection checkbox). Rows tint on hover and press in when clicked; the selected row's highlight
 * slides from the row picked before. The page a row opens shows the list strip closed (1024–1279 px).
 * @param {{ href: string, label: import('react').ReactNode, sublabel?: import('react').ReactNode, dot?: Dot,
 *   dotLabel?: string, meta?: import('react').ReactNode, current?: boolean | 'wide', leading?: import('react').ReactNode }} props
 */
export function ListRow({ href, label, sublabel, dot, dotLabel, meta, current = false, leading }) {
	const { going, strip } = useScreen();
	const marked = going === null ? current : pathOf(href) === going;
	return (
		<li className="flex items-center gap-1">
			{leading ? <span className="flex shrink-0 items-center pl-2">{leading}</span> : null}
			<Link
				href={href}
				hint
				aria-current={marked === true ? 'page' : undefined}
				onClick={strip ? strip.picked : undefined}
				className={cx(
					'ss-motion ss-press relative isolate flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-sm',
					marked === true
						? 'text-on-primary-soft'
						: marked === 'wide'
							? 'text-fg hover:bg-surface-2 lg:text-on-primary-soft lg:hover:bg-transparent'
							: 'text-fg hover:bg-surface-2',
				)}>
				{marked ? (
					<ViewTransition name="ss-list-selection" share="ss-vt-morph" default="none">
						<span
							aria-hidden="true"
							className={cx('absolute inset-0 -z-10 rounded-xl bg-primary-soft', marked === 'wide' && 'hidden lg:block')}
						/>
					</ViewTransition>
				) : null}
				{dot ? <span aria-hidden="true" title={dotLabel} className={cx('size-2 shrink-0 rounded-full', DOTS[dot])} /> : null}
				<span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3">
					<span
						title={typeof label === 'string' ? label : undefined}
						className={cx(
							'col-span-2 line-clamp-2 break-words @sm:col-span-1',
							marked === true ? 'font-bold' : 'font-semibold',
						)}>
						{typeof label === 'string' ? <SoftBreaks text={label} /> : label}
					</span>
					{sublabel || meta !== undefined ? (
						<span className="col-span-2 flex flex-wrap items-baseline gap-x-3 @sm:contents">
							{sublabel ? (
								<span
									title={typeof sublabel === 'string' ? sublabel : undefined}
									className="min-w-0 max-w-full truncate text-xs text-muted @sm:col-start-1 @sm:row-start-2">
									{sublabel}
								</span>
							) : null}
							{meta === undefined ? null : (
								<span className="ml-auto text-right text-xs font-semibold whitespace-nowrap tabular-nums text-muted @sm:col-start-2 @sm:row-span-2 @sm:row-start-1 @sm:self-center">
									{meta}
								</span>
							)}
						</span>
					) : null}
				</span>
				{dot && dotLabel ? <span className="sr-only">{dotLabel}</span> : null}
			</Link>
		</li>
	);
}

/**
 * The search box of a list pane (`onSearch` runs on submit).
 * @param {{ label: string, value: string, onChange: (value: string) => void, onSearch?: () => void,
 *   children?: import('react').ReactNode }} props `children`: filters beside the box
 */
export function ListSearch({ label, value, onChange, onSearch, children }) {
	return (
		<form
			role="search"
			aria-label={label}
			className="flex flex-wrap gap-2 px-1"
			onSubmit={(event) => {
				event.preventDefault();
				onSearch?.();
			}}>
			<Input
				label={label}
				hideLabel
				type="search"
				placeholder={label}
				value={value}
				fieldClassName="min-w-0 basis-full"
				onChange={(e) => onChange(e.currentTarget.value)}
			/>
			{children}
		</form>
	);
}

/**
 * The Back link to the list, shown below 1024 px where the list and the detail stack (PLAN 0.6 Phones and tablets).
 * @param {{ href: string, label: string }} props
 */
export function BackLink({ href, label }) {
	return (
		<Link href={href} className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline lg:hidden">
			<Icon name="chevronRight" size={14} className="rotate-180" />
			{label}
		</Link>
	);
}

/**
 * Open a product dashboard: make the single-use launch, then open its URL in a new tab.
 * @param {Fetcher} fetcher
 * @param {string} path the launch route
 * @param {unknown} [body]
 * @returns {Promise<ApiResult>}
 */
export const openDashboard = async (fetcher, path, body) => {
	const result = await fetcher(path, { method: 'POST', ...(body === undefined ? {} : { body }) });
	if (result.ok && typeof result.data?.url === 'string') window.open(result.data.url, '_blank', 'noopener,noreferrer');
	return result;
};
