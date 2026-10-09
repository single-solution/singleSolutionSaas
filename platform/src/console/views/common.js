'use client';
/**
 * Building blocks shared by console views: the page error, the actions of a detail header (one or two buttons and a
 * More menu), the list-and-detail layout with its list pane, rows and search (PLAN 0.6), and opening a product
 * dashboard in a new tab.
 * @module
 */
import { ActionMenu, ButtonLink, ErrorState, Icon, Input, cx, describeProblem, problemCode } from '@ss/ui';
import { CONSOLE } from '../../texts/console.js';
import { Link } from '../link.js';
import { routes } from '../paths.js';

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
 * rest in a compact More menu (⋯) — a destructive action last, in danger text.
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
 * A list-and-detail screen (PLAN 0.6): the list on the left and an item's detail beside it, on one screen. `detail` is
 * the item the URL selects or, with `auto`, the first item of the list, opened by default so a wide screen is never
 * half empty; with no item at all the detail side shows `empty` (under the list on phones). Below 1024 px the two
 * stack: the list alone (an `auto` detail stays hidden there) until an item is chosen, then the detail alone with a
 * Back link (`back`) to the list.
 * @param {{ label: string, list: import('react').ReactNode, detail: import('react').ReactNode | null,
 *   empty: import('react').ReactNode, back: { href: string, label: string }, auto?: boolean }} props
 */
export function ListDetail({ label, list, detail, empty, back, auto = false }) {
	const shown = detail !== null && detail !== undefined;
	const chosen = shown && !auto;
	return (
		<div className="grid items-start gap-6 lg:grid-cols-[20rem_minmax(0,1fr)] xl:grid-cols-[22rem_minmax(0,1fr)] xl:gap-8">
			<aside aria-label={label} className={cx('min-w-0 lg:sticky lg:top-24', chosen ? 'hidden lg:block' : 'block')}>
				{list}
			</aside>
			<div className={cx('min-w-0 space-y-8', chosen || !shown ? 'block' : 'hidden lg:block')}>
				{chosen ? <BackLink href={back.href} label={back.label} /> : null}
				{shown ? detail : empty}
			</div>
		</div>
	);
}

/**
 * The list pane of a list-and-detail screen: the section's title (the page heading) with its main action, an optional
 * search / filter row, the rows, and an optional footer (load more, bulk actions).
 * @param {{ title: string, count?: import('react').ReactNode, action?: import('react').ReactNode,
 *   tools?: import('react').ReactNode, children: import('react').ReactNode, footer?: import('react').ReactNode }} props
 */
export function ListPane({ title, count, action, tools, children, footer }) {
	return (
		<div className="space-y-3 rounded-card bg-surface p-3 sm:p-4">
			<div className="flex flex-wrap items-center justify-between gap-2 px-1 pt-1">
				<h1 className="text-xl font-extrabold tracking-tight text-fg">
					{title}
					{count === undefined ? null : <span className="ml-2 text-sm font-semibold text-muted">{count}</span>}
				</h1>
				{action}
			</div>
			{tools}
			<ul className="max-h-none space-y-0.5 overflow-y-auto lg:max-h-[calc(100vh-17rem)]">{children}</ul>
			{footer}
		</div>
	);
}

/**
 * One row of a list pane: a link with the name, an optional second line, a status dot and a right-hand figure; the
 * selected row is marked. `current="wide"` marks the row opened by default, only where its detail shows beside the list
 * (1024 px and up). `leading` sits before the link (a bulk-selection checkbox).
 * @param {{ href: string, label: import('react').ReactNode, sublabel?: import('react').ReactNode, dot?: Dot,
 *   dotLabel?: string, meta?: import('react').ReactNode, current?: boolean | 'wide', leading?: import('react').ReactNode }} props
 */
export function ListRow({ href, label, sublabel, dot, dotLabel, meta, current = false, leading }) {
	return (
		<li className="flex items-center gap-1">
			{leading ? <span className="flex shrink-0 items-center pl-2">{leading}</span> : null}
			<Link
				href={href}
				aria-current={current === true ? 'page' : undefined}
				className={cx(
					'flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-sm',
					current === true
						? 'bg-primary-soft text-on-primary-soft'
						: current === 'wide'
							? 'text-fg hover:bg-surface-2 lg:bg-primary-soft lg:text-on-primary-soft lg:hover:bg-primary-soft'
							: 'text-fg hover:bg-surface-2',
				)}>
				{dot ? <span aria-hidden="true" title={dotLabel} className={cx('size-2 shrink-0 rounded-full', DOTS[dot])} /> : null}
				<span className="min-w-0 flex-1">
					<span className={cx('block truncate', current === true ? 'font-bold' : 'font-semibold')}>{label}</span>
					{sublabel ? <span className="block truncate text-xs text-muted">{sublabel}</span> : null}
				</span>
				{dot && dotLabel ? <span className="sr-only">{dotLabel}</span> : null}
				{meta === undefined ? null : (
					<span className="shrink-0 text-right text-xs font-semibold tabular-nums text-muted">{meta}</span>
				)}
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
