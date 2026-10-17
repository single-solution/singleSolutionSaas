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
	CARD_FLOW,
	DOTS,
	ErrorState,
	Icon,
	Input,
	PageTransition,
	PillTabs,
	SoftBreaks,
	cx,
	describeProblem,
	problemCode,
	useHashSection,
} from '@ss/ui';
import { CONSOLE } from '../../texts/console.js';
import { apiFetch } from '../client.js';
import { Link } from '../link.js';
import { routes } from '../paths.js';
import { ScreenContext, listScroll, listWasPlaceholder, rememberList, stripOpen, useScreen } from './screen-memory.js';

/** @typedef {import('@ss/ui/problems').Problem} Problem */
/**
 * @template [T=any]
 * @typedef {import('../client.js').ApiResult<T>} ApiResult
 */

/**
 * Page-level error: a friendly message, and a way forward (sign in again, go back).
 * @param {{ problem: Problem | null | undefined, title?: string, back?: { href: string, label: string }, admin?: boolean }} props
 *   `admin`: an Admin Console page (a refusal says the role does not include the area)
 */
export function PageProblem({ problem, title, back, admin = false }) {
	const code = problemCode(problem);
	const forbidden = code === 'forbidden';
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
			title={
				title ??
				(code === 'not_found'
					? CONSOLE.notFound
					: forbidden
						? admin
							? CONSOLE.notPermitted
							: CONSOLE.noAccess
						: CONSOLE.loadFailed)
			}
			message={forbidden && admin ? CONSOLE.forbiddenHint(describeProblem(problem)) : describeProblem(problem)}
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

/**
 * The parts of a detail that sits beside a list (a merchant, a product, an admin) as a tab strip: ONE part is shown at a
 * time (the list is already the screen's sidebar, so the parts get tabs, not a second sidebar), the chosen part is kept
 * in the address hash (`#merchant-credits`), and a part is mounted when first opened and then kept. Small cards in a
 * part sit side by side; a table or an editor takes the whole row.
 * @param {{ tabs: Array<{ id: string, label: import('react').ReactNode, content: import('react').ReactNode }>,
 *   label: string, idPrefix?: string }} props
 */
export function DetailTabs({ tabs, label, idPrefix = 'dt' }) {
	const ids = tabs.map((tab) => tab.id);
	const [active, choose] = useHashSection(ids);
	const [seen, setSeen] = useState(() => new Set([active]));
	if (active && !seen.has(active)) setSeen(new Set([...seen, active]));
	return (
		<div className="min-w-0 space-y-4">
			<PillTabs
				tabs={tabs.map(({ id, label: text }) => ({ id, label: text }))}
				active={active}
				onSelect={choose}
				label={label}
				idPrefix={idPrefix}
			/>
			{tabs
				.filter((tab) => tab.id === active || seen.has(tab.id))
				.map((tab) => (
					<div
						key={tab.id}
						id={`${idPrefix}-panel-${tab.id}`}
						role="tabpanel"
						aria-labelledby={`${idPrefix}-tab-${tab.id}`}
						hidden={tab.id !== active}
						className={CARD_FLOW}>
						{tab.content}
					</div>
				))}
		</div>
	);
}

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
				<aside aria-label={label} className={cx('min-w-0 xl:sticky xl:top-0', chosen ? 'hidden lg:block' : 'block')}>
					{list}
				</aside>
				<div className={cx('min-w-0 space-y-6', chosen || !shown ? 'block' : 'hidden lg:block')}>
					{chosen ? <BackLink href={back.href} label={back.label} /> : null}
					<PageTransition className="space-y-6">{shown ? detail : empty}</PageTransition>
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
		<div
			className={cx(
				'@container space-y-3 rounded-panel border border-line-soft bg-surface p-3 shadow-panel xl:flex xl:max-h-(--ss-pane-h) xl:flex-col',
				fades && 'animate-ss-fade',
			)}>
			<div className="flex min-h-8 flex-wrap items-center justify-between gap-2 px-1">
				<h1 className="flex items-center gap-2 text-title font-semibold tracking-[-0.01em] text-fg">
					{title}
					{count === undefined ? null : (
						<span className="rounded-md bg-surface-2 px-1.5 py-px text-micro font-medium text-muted tabular-nums">
							{count}
						</span>
					)}
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
			<div
				id={body}
				className={cx('space-y-3 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col', strip && !strip.open && 'lg:max-xl:hidden')}>
				{tools}
				<ul
					ref={rows}
					onScroll={(event) => {
						if (section) listScroll(section, event.currentTarget.scrollTop);
					}}
					className="ss-scroll -mx-1 max-h-none space-y-px px-1 lg:max-h-[min(28rem,55vh)] xl:max-h-none xl:min-h-0 xl:flex-1">
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
 * One row of a list pane (`PaneRow`, not the content rows of `@ss/ui`'s `ListRow`): a link with the name, an optional second line, a status dot and a right-hand figure; the
 * selected row is marked. The name wraps to two lines — on whole words, a domain or email between its parts — before
 * it is cut (the full name on hover). In a pane narrower than 24rem the figure moves under the name, beside the second
 * line (or under it, where both do not fit), so the name and the second line get the whole width. `current="wide"`
 * marks the row opened by default, only where its detail shows with the list (1024 px and up). `leading` sits before
 * the link (a bulk-selection checkbox). Rows tint on hover and press in when clicked; the selected row's highlight
 * slides from the row picked before. The page a row opens shows the list strip closed (1024–1279 px).
 * @param {{ href: string, label: import('react').ReactNode, sublabel?: import('react').ReactNode, dot?: Dot,
 *   dotLabel?: string, meta?: import('react').ReactNode, current?: boolean | 'wide', leading?: import('react').ReactNode }} props
 */
export function PaneRow({ href, label, sublabel, dot, dotLabel, meta, current = false, leading }) {
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
					'ss-motion ss-press relative isolate flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2.5 py-2 text-sm',
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
							className={cx('absolute inset-0 -z-10 rounded-lg bg-primary-soft', marked === 'wide' && 'hidden lg:block')}
						/>
					</ViewTransition>
				) : null}
				{dot ? <span aria-hidden="true" title={dotLabel} className={cx('size-2 shrink-0 rounded-full', DOTS[dot])} /> : null}
				<span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3">
					<span
						title={typeof label === 'string' ? label : undefined}
						className={cx(
							'col-span-2 line-clamp-2 break-words @sm:col-span-1',
							marked === true ? 'font-semibold' : 'font-medium',
						)}>
						{typeof label === 'string' ? <SoftBreaks text={label} /> : label}
					</span>
					{sublabel || meta !== undefined ? (
						<span className="col-span-2 flex flex-wrap items-baseline gap-x-3 @sm:contents">
							{sublabel ? (
								<span
									title={typeof sublabel === 'string' ? sublabel : undefined}
									className="min-w-0 max-w-full truncate text-help text-muted @sm:col-start-1 @sm:row-start-2">
									{sublabel}
								</span>
							) : null}
							{meta === undefined ? null : (
								<span className="ml-auto text-right text-help font-medium whitespace-nowrap tabular-nums text-muted @sm:col-start-2 @sm:row-span-2 @sm:row-start-1 @sm:self-center">
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
			className="flex flex-wrap gap-2"
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
function BackLink({ href, label }) {
	return (
		<Link href={href} className="inline-flex items-center gap-1 text-label font-medium text-muted hover:text-fg lg:hidden">
			<Icon name="chevronRight" size={14} className="rotate-180" />
			{label}
		</Link>
	);
}

/**
 * Open a product dashboard: make the single-use launch, then open its URL in a new tab.
 * @param {string} path the launch route
 * @param {unknown} [body]
 * @returns {Promise<ApiResult>}
 */
export const openDashboard = async (path, body) => {
	const result = await apiFetch(path, { method: 'POST', ...(body === undefined ? {} : { body }) });
	if (result.ok && typeof result.data?.url === 'string') window.open(result.data.url, '_blank', 'noopener,noreferrer');
	return result;
};

/**
 * A two-step or recovery code field value → the API members.
 * @param {string} value
 */
export const factorOf = (value) => {
	const v = value.trim();
	if (!v) return {};
	return /^\d{6}$/.test(v) ? { code: v } : { recoveryCode: v };
};
