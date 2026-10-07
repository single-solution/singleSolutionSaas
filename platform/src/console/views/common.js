'use client';
/**
 * Building blocks shared by console views: the page error, a small actions menu, the inner sidebar list (PLAN 0.6) and
 * opening a product dashboard in a new tab.
 * @module
 */
import { useEffect, useId, useRef, useState } from 'react';
import { ButtonLink, ErrorState, Icon, IconButton, Input, cx, describeProblem, problemCode } from '@ss/ui';
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
 * @typedef {object} MenuItem
 * @property {string} label
 * @property {() => void} onSelect
 * @property {boolean} [disabled]
 * @property {string} [hint] shown under the item (why it is disabled)
 * @property {boolean} [danger]
 */

/**
 * A small actions menu (a button that opens a list of actions). Escape and a click outside close it.
 * @param {{ label: string, items: MenuItem[] }} props
 */
export function ActionMenu({ label, items }) {
	const [open, setOpen] = useState(false);
	const root = useRef(/** @type {HTMLDivElement | null} */ (null));
	const id = useId();
	useEffect(() => {
		if (!open) return undefined;
		/** @param {MouseEvent} event */
		const outside = (event) => {
			if (root.current && !root.current.contains(/** @type {Node} */ (event.target))) setOpen(false);
		};
		/** @param {KeyboardEvent} event */
		const escape = (event) => {
			if (event.key === 'Escape') setOpen(false);
		};
		document.addEventListener('mousedown', outside);
		document.addEventListener('keydown', escape);
		return () => {
			document.removeEventListener('mousedown', outside);
			document.removeEventListener('keydown', escape);
		};
	}, [open]);
	return (
		<div ref={root} className="relative">
			<IconButton
				label={label}
				variant="secondary"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				onClick={() => setOpen((o) => !o)}>
				<Icon name="menu" size={16} />
			</IconButton>
			{open ? (
				<div
					id={id}
					role="menu"
					aria-label={label}
					className="absolute right-0 z-30 mt-1 w-64 max-w-[calc(100vw-2rem)] space-y-0.5 rounded-xl border border-line bg-surface p-1 shadow-overlay">
					{items.map((item, index) => (
						<div key={item.label}>
							<button
								type="button"
								role="menuitem"
								disabled={item.disabled}
								aria-describedby={item.hint ? `${id}-${index}` : undefined}
								onClick={() => {
									setOpen(false);
									item.onSelect();
								}}
								className={cx(
									'block w-full rounded-lg px-3 py-2 text-left text-sm font-semibold hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
									item.danger ? 'text-danger' : 'text-fg',
								)}>
								{item.label}
							</button>
							{item.hint ? (
								<p id={`${id}-${index}`} className="px-3 pb-1.5 text-xs text-muted">
									{item.hint}
								</p>
							) : null}
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}

/**
 * @typedef {object} ListEntry
 * @property {string} id
 * @property {string} label
 * @property {string} href
 * @property {'success' | 'warning' | 'danger' | 'neutral'} [dot] status dot colour
 */

const DOTS = Object.freeze({ success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', neutral: 'bg-line-strong' });

/**
 * The inner sidebar of a list section (PLAN 0.6): a searchable list of the items (name + status dot) with the selected
 * one marked. Below 1024 px it is hidden; the page shows a Back link to the list page instead.
 * @param {{ label: string, search: string, entries: ListEntry[], currentId: string }} props
 */
export function InnerList({ label, search, entries, currentId }) {
	const [q, setQ] = useState('');
	const needle = q.trim().toLowerCase();
	const shown = needle ? entries.filter((entry) => entry.label.toLowerCase().includes(needle)) : entries;
	return (
		<aside className="hidden w-60 shrink-0 space-y-3 lg:block" aria-label={label}>
			<Input label={search} hideLabel placeholder={search} value={q} onChange={(e) => setQ(e.currentTarget.value)} />
			<ul className="max-h-[70vh] space-y-0.5 overflow-y-auto">
				{shown.map((entry) => (
					<li key={entry.id}>
						<Link
							href={entry.href}
							aria-current={entry.id === currentId ? 'page' : undefined}
							className={cx(
								'flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm',
								entry.id === currentId
									? 'bg-primary-soft font-semibold text-on-primary-soft'
									: 'text-fg hover:bg-surface-2',
							)}>
							{entry.dot ? (
								<span aria-hidden="true" className={cx('size-2 shrink-0 rounded-full', DOTS[entry.dot])} />
							) : null}
							<span className="truncate">{entry.label}</span>
						</Link>
					</li>
				))}
			</ul>
		</aside>
	);
}

/**
 * The Back link to the list page, shown below 1024 px where the inner sidebar is hidden (PLAN 0.6 Phones and tablets).
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
