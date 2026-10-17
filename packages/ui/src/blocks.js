'use client';
/**
 * The page-building blocks of the premium layout (owner 2026-10-16): the 12-column `Grid` / `Col`, the
 * {@link SettingsCard} with its setting rows (label and muted help on the left, the control on the right, rows divided
 * by hairlines, stacked on phones), the sticky {@link SaveBar} that appears only when something changed, and the inner
 * sidebar ({@link SectionNav}, {@link SectionLayout}: one section at a time, kept in the address) for pages that have
 * sections, and {@link Disclosure}, the collapsed Advanced block.
 *
 * Nothing here stretches a card to the height of its neighbor: the grids align their cells to the start ({@link NO_STRETCH}).
 * @module
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { cx } from './cx.js';
import { Button } from './Button.js';
import { Card } from './display.js';
import { FieldLayoutContext, ROW_GRID, ROW_LABEL, ROW_LIST, rowControl } from './fields.js';
import { Icon } from './icons.js';

/** @typedef {import('react').ReactNode} ReactNode */

/** The grid rule that keeps every card at its natural height (a row of cards never stretches the short ones). */
export const NO_STRETCH = 'items-start';

/**
 * The responsive flow of cards: settings cards hold two-column rows (owner 2026-10-17, like Stripe), so a card takes
 * the whole width up to very wide panes, where two cards of at least 52 rem sit side by side; every card keeps its
 * natural height. A {@link SettingsCard} (`data-flow="card"`) takes one column; anything else in the flow (a table, an
 * editor, a preview, a callout) takes the whole row. Cards are 16 px apart.
 */
export const CARD_FLOW =
	'grid min-w-0 items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,52rem),1fr))] ' +
	'*:col-span-full [&>[data-flow=card]]:col-auto';

/**
 * A flow of cards that sit side by side while there is room ({@link CARD_FLOW}).
 * @param {{ children?: ReactNode, className?: string }} props
 */
export function CardFlow({ children, className }) {
	return <div className={cx(CARD_FLOW, className)}>{children}</div>;
}

/*
 * Grid spans are written out so Tailwind finds every class. `span` applies from the smallest width, `md`, `lg` and
 * `xl` from 768, 1024 and 1280 px.
 */
const SPAN = Object.freeze({
	3: 'col-span-12 sm:col-span-6 md:col-span-3',
	4: 'col-span-12 md:col-span-4',
	5: 'col-span-12 md:col-span-5',
	6: 'col-span-12 md:col-span-6',
	7: 'col-span-12 md:col-span-7',
	8: 'col-span-12 md:col-span-8',
	9: 'col-span-12 md:col-span-9',
	12: 'col-span-12',
});
const SPAN_LG = Object.freeze({
	3: 'lg:col-span-3',
	4: 'lg:col-span-4',
	5: 'lg:col-span-5',
	6: 'lg:col-span-6',
	7: 'lg:col-span-7',
	8: 'lg:col-span-8',
	9: 'lg:col-span-9',
	12: 'lg:col-span-12',
});
const SPAN_XL = Object.freeze({
	3: 'xl:col-span-3',
	4: 'xl:col-span-4',
	5: 'xl:col-span-5',
	6: 'xl:col-span-6',
	7: 'xl:col-span-7',
	8: 'xl:col-span-8',
	9: 'xl:col-span-9',
	12: 'xl:col-span-12',
});

/** @typedef {3 | 4 | 5 | 6 | 7 | 8 | 9 | 12} Span */

/**
 * The page's 12-column grid: full width, the cards in it share the rows (`Col` spans). One column on a phone.
 * @param {{ children?: ReactNode, className?: string }} props
 */
export function Grid({ children, className }) {
	return <div className={cx('grid min-w-0 grid-cols-12 gap-4', NO_STRETCH, className)}>{children}</div>;
}

/**
 * A cell of the {@link Grid}: `span` columns from tablet width (a phone gets the full row), `lg` and `xl` change the
 * span on wider screens.
 * @param {{ span?: Span, lg?: Span, xl?: Span, children?: ReactNode, className?: string }} props
 */
export function Col({ span = 12, lg, xl, children, className }) {
	return <div className={cx('min-w-0 space-y-4', SPAN[span], lg && SPAN_LG[lg], xl && SPAN_XL[xl], className)}>{children}</div>;
}

/**
 * The fields of a card as rows divided by hairlines (use inside a {@link SettingsCard}; a `Form` inside one does it by
 * itself).
 * @param {{ children?: ReactNode, className?: string }} props
 */
export function SettingList({ children, className }) {
	return <div className={cx(ROW_LIST, className)}>{children}</div>;
}

/**
 * A titled card of settings: the title, a one-line description and optional actions on top; the fields inside are
 * setting rows (their label and help on the left, the control on the right; they stack when the card is narrow). A
 * `footer` holds the card's own buttons.
 * In a {@link CardFlow} it takes one column and sits beside the other cards; `wide` makes it take the whole row (a
 * card holding a table or an editor).
 * @param {{ title?: ReactNode, description?: ReactNode, actions?: ReactNode, footer?: ReactNode, children?: ReactNode,
 *   id?: string, className?: string, as?: 'section' | 'div' | 'article', wide?: boolean }} props
 */
export function SettingsCard({ title, description, actions, footer, children, id, className, as, wide = false }) {
	return (
		<FieldLayoutContext.Provider value="row">
			<Card
				flow={!wide}
				{...(id ? { id } : {})}
				{...(as ? { as } : {})}
				title={title}
				subtitle={description}
				actions={actions}
				{...(className ? { className } : {})}
				bodyClassName="@container">
				{children}
				{footer ? (
					<div className="-mx-5 mt-5 -mb-5 flex flex-wrap items-center justify-end gap-2 border-t border-line-soft px-5 py-3">
						{footer}
					</div>
				) : null}
			</Card>
		</FieldLayoutContext.Provider>
	);
}

/**
 * One row of a settings card for anything that is not a form control of the kit (a file picker, a swatch, a custom
 * widget): the label and help on the left, `children` on the right. `htmlFor` names the control the label belongs to.
 * `stacked` puts the control below the text at every width.
 * @param {{ label: ReactNode, description?: ReactNode, htmlFor?: string, children?: ReactNode, stacked?: boolean,
 *   className?: string }} props
 */
export function SettingRow({ label, description, htmlFor, children, stacked = false, className }) {
	const id = useId();
	const labelId = `sr${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
	return (
		<div
			data-cell=""
			{...(htmlFor ? {} : { role: 'group', 'aria-labelledby': labelId })}
			className={cx(stacked ? 'grid min-w-0 items-start gap-y-2' : ROW_GRID, className)}>
			<div className={stacked ? 'min-w-0 space-y-1' : ROW_LABEL}>
				{htmlFor ? (
					<label htmlFor={htmlFor} className="block text-label font-medium text-fg">
						{label}
					</label>
				) : (
					<div id={labelId} className="text-label font-medium text-fg">
						{label}
					</div>
				)}
				{description ? <p className="text-help text-muted">{description}</p> : null}
			</div>
			<div className={cx(stacked ? 'min-w-0 space-y-2' : rowControl(true), 'space-y-2')}>{children}</div>
		</div>
	);
}

/**
 * The bar that offers Save and Discard once something changed: it floats at the bottom of the window (inset from the
 * edges, above the page) and is not on screen otherwise. It can be placed anywhere in the settings.
 * @param {{ show: boolean, onSave: () => unknown, onDiscard: () => void, saving?: boolean, message?: ReactNode,
 *   saveLabel?: string, discardLabel?: string, className?: string }} props
 */
export function SaveBar({
	show,
	onSave,
	onDiscard,
	saving = false,
	message = 'You have unsaved changes',
	saveLabel = 'Save changes',
	discardLabel = 'Discard',
	className,
}) {
	if (!show) return null;
	return (
		<div
			role="region"
			aria-label={saveLabel}
			className={cx('pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-3', className)}>
			<div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-x-6 gap-y-2 rounded-panel border border-line-soft bg-surface py-2 pr-2 pl-4 shadow-bar animate-ss-sheet">
				<p role="status" className="flex items-center gap-2 text-sm font-medium text-fg">
					<span aria-hidden="true" className="size-2 rounded-full bg-warning" />
					{message}
				</p>
				<div className="ml-auto flex items-center gap-2">
					<Button variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
						{discardLabel}
					</Button>
					<Button size="sm" loading={saving} onClick={onSave}>
						{saveLabel}
					</Button>
				</div>
			</div>
		</div>
	);
}

/**
 * Save and Cancel under a list or form that is saved whole (a merchant list editor): Save is on while something changed,
 * Cancel appears with it, and `children` (an Add button, a note) come first. A save that takes time shows the spinner
 * on the button. For the settings of a page use {@link SaveBar}.
 * @param {{ dirty: boolean, onSave: () => unknown, onCancel: () => void, disabled?: boolean, saveLabel?: string,
 *   cancelLabel?: string, children?: ReactNode, className?: string }} props `disabled`: save is off even though
 *   something changed (an entry the server would refuse)
 */
export function SaveRow({ dirty, onSave, onCancel, disabled = false, saveLabel = 'Save', cancelLabel = 'Cancel', children, className }) {
	return (
		<div className={cx('flex flex-wrap items-center gap-2', className)}>
			{children}
			<Button size="sm" disabled={!dirty || disabled} onClick={onSave}>
				{saveLabel}
			</Button>
			{dirty ? (
				<Button size="sm" variant="ghost" onClick={onCancel}>
					{cancelLabel}
				</Button>
			) : null}
		</div>
	);
}

/**
 * One link of the inner sidebar. A link with `children` is a heading that opens its sub-items (a feature with several
 * groups of settings, a list with several parts): choosing it opens its first sub-item.
 * @typedef {object} SectionItem
 * @property {string} id
 * @property {ReactNode} label
 * @property {import('./icons.js').IconName} [icon]
 * @property {ReactNode} [badge] a count or a status shown at the right
 * @property {string} [group] the group heading the link is listed under (links of one group are listed together)
 * @property {SectionItem[]} [children] sub-items (one level)
 */

/**
 * A section of {@link SectionLayout}: a link with its content, or a link with sub-sections.
 * @typedef {Omit<SectionItem, 'children'> & { content?: ReactNode, children?: SectionSpec[] }} SectionSpec
 */

/**
 * Groups of the items, in the order the groups first appear.
 * @param {SectionItem[]} items
 */
const groupsOf = (items) => {
	/** @type {Map<string, SectionItem[]>} */
	const groups = new Map();
	for (const item of items) groups.set(item.group ?? '', [...(groups.get(item.group ?? '') ?? []), item]);
	return [...groups];
};

/**
 * The items that open a view (sub-items instead of their parent).
 * @template {{ id: string, children?: T[] }} T
 * @param {T[]} items
 * @returns {T[]}
 */
const leavesOf = (items) => items.flatMap((item) => (item.children?.length ? leavesOf(item.children) : [item]));

/** The address of a section: `#id`. @param {string} id */
const hashOf = (id) => `#${encodeURIComponent(id)}`;

/**
 * The section shown, kept in the address hash (`#security`): the first section until the page is in the browser, then
 * the hash's. Choosing a section adds a history entry, so a link opens that section and Back returns to the one before.
 * A hash that names no section leaves the choice alone; no hash at all goes back to the first. A hash that names a
 * feature with several views (`catalog`) opens its first view (`catalog.basics`), so a link needs no more than the name.
 * @param {string[]} ids
 * @param {string} [initial]
 * @returns {[string, (id: string) => void]}
 */
export function useHashSection(ids, initial) {
	const first = initial ?? ids[0] ?? '';
	const [active, setActive] = useState(first);
	useEffect(() => {
		const read = () => {
			const hash = decodeURIComponent(window.location.hash.replace(/^#/, ''));
			const named = ids.includes(hash) ? hash : ids.find((id) => hash !== '' && id.startsWith(`${hash}.`));
			if (named) setActive(named);
			else if (hash === '') setActive(first);
		};
		read();
		window.addEventListener('hashchange', read);
		window.addEventListener('popstate', read);
		return () => {
			window.removeEventListener('hashchange', read);
			window.removeEventListener('popstate', read);
		};
	}, [ids.join('|'), first]);
	const choose = useCallback((/** @type {string} */ id) => {
		setActive(id);
		try {
			if (decodeURIComponent(window.location.hash.replace(/^#/, '')) !== id)
				window.history.pushState(window.history.state, '', hashOf(id));
		} catch {
			// no history (a sandboxed frame): the choice still shows
		}
	}, []);
	return [ids.includes(active) ? active : (ids[0] ?? ''), choose];
}

/** The plain text of a label, for searching. @param {ReactNode} label */
const textOf = (label) => (typeof label === 'string' || typeof label === 'number' ? String(label) : '');

/**
 * The inner sidebar: a floating panel of grouped section links with icons and badges, sticky below the header on wide
 * screens; an item with sub-items opens them under it (the one holding the current section is open). A long list gets
 * a search box. On a phone it is one button showing the current section that opens the same list.
 * @param {{ items: SectionItem[], active: string, onSelect: (id: string) => void, label?: string, className?: string,
 *   searchFrom?: number, searchLabel?: string }} props `searchFrom`: the search box shows from that many links (10)
 */
export function SectionNav({ items, active, onSelect, label = 'Sections', className, searchFrom = 10, searchLabel = 'Search' }) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const listId = useId();
	const leaves = leavesOf(items);
	const current = leaves.find((item) => item.id === active) ?? leaves[0];
	const parent = items.find((item) => item.children?.some((child) => child.id === current?.id));
	const needle = query.trim().toLowerCase();
	const matches = (/** @type {SectionItem} */ item) => !needle || textOf(item.label).toLowerCase().includes(needle);
	const visible = needle
		? items.flatMap((item) => {
				if (!item.children?.length) return matches(item) ? [item] : [];
				const kept = item.children.filter(matches);
				return matches(item) ? [item] : kept.length > 0 ? [{ ...item, children: kept }] : [];
			})
		: items;
	/** @param {SectionItem} item @param {boolean} phone @param {boolean} child */
	const link = (item, phone, child) => {
		const target = item.children?.length ? (leavesOf([item])[0]?.id ?? item.id) : item.id;
		const on = child ? item.id === active : item.id === active && !item.children?.length;
		const holds = !child && item.children?.some((entry) => entry.id === active);
		return (
			<a
				href={hashOf(target)}
				aria-current={on ? 'true' : undefined}
				{...(item.children?.length ? { 'aria-expanded': holds || needle !== '' } : {})}
				onClick={(event) => {
					event.preventDefault();
					onSelect(target);
					if (phone && !item.children?.length) setOpen(false);
				}}
				className={cx(
					'ss-motion ss-press flex h-8 items-center gap-2 rounded-md text-label focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
					child ? 'pr-2 pl-3' : 'px-2',
					on
						? 'bg-primary-soft font-medium text-on-primary-soft'
						: holds
							? 'font-medium text-fg'
							: 'font-medium text-fg/75 hover:bg-surface-2 hover:text-fg',
				)}>
				{!child && item.icon ? (
					<span aria-hidden="true" className={on || holds ? 'text-primary' : 'text-muted'}>
						<Icon name={item.icon} size={15} />
					</span>
				) : null}
				<span className="min-w-0 flex-1 truncate">{item.label}</span>
				{item.badge ? <span className="ml-auto shrink-0 text-micro font-medium text-muted tabular-nums">{item.badge}</span> : null}
				{!child && item.children?.length ? (
					<span aria-hidden="true" className={cx('ss-motion text-subtle', (holds || needle !== '') && 'rotate-180')}>
						<Icon name="chevronDown" size={13} />
					</span>
				) : null}
			</a>
		);
	};
	const list = (/** @type {boolean} */ phone) => (
		<nav aria-label={label} className="space-y-4">
			{leaves.length >= searchFrom ? (
				<input
					type="search"
					aria-label={searchLabel}
					placeholder={searchLabel}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					className="h-8 w-full rounded-control border border-line bg-surface px-2.5 text-label text-fg shadow-card placeholder:text-subtle focus-visible:outline-2 focus-visible:outline-focus"
				/>
			) : null}
			{groupsOf(visible).map(([group, entries], index) => (
				<div key={group || index} className="space-y-0.5">
					{group ? (
						<p className="px-2 pb-1 text-micro font-semibold tracking-[0.06em] text-muted uppercase">{group}</p>
					) : null}
					<ul className="space-y-px">
						{entries.map((item) => {
							const expanded =
								item.children?.length && (needle !== '' || item.children.some((child) => child.id === active));
							return (
								<li key={item.id}>
									{link(item, phone, false)}
									{expanded ? (
										<ul className="mt-px mb-1 ml-[1.0625rem] space-y-px border-l border-line pl-1.5">
											{item.children?.map((child) => (
												<li key={child.id}>{link(child, phone, true)}</li>
											))}
										</ul>
									) : null}
								</li>
							);
						})}
					</ul>
				</div>
			))}
			{needle && visible.length === 0 ? <p className="px-2.5 py-1 text-sm text-muted">No match</p> : null}
		</nav>
	);
	return (
		<div className={cx('min-w-0', className)}>
			<div className="lg:hidden">
				<button
					type="button"
					aria-expanded={open}
					aria-controls={listId}
					onClick={() => setOpen((o) => !o)}
					className="ss-motion ss-press flex h-10 w-full items-center gap-2.5 rounded-control border border-line bg-surface px-3 text-sm font-medium text-fg shadow-card">
					{(parent?.icon ?? current?.icon) ? (
						<span aria-hidden="true" className="text-primary">
							<Icon name={/** @type {import('./icons.js').IconName} */ (parent?.icon ?? current?.icon)} size={16} />
						</span>
					) : null}
					<span className="min-w-0 flex-1 truncate text-left">
						{parent ? (
							<>
								<span className="font-medium text-muted">{parent.label} · </span>
								{current?.label}
							</>
						) : (
							current?.label
						)}
					</span>
					<span aria-hidden="true" className={cx('ss-motion text-muted', open && 'rotate-180')}>
						<Icon name="chevronDown" size={16} />
					</span>
				</button>
				{open ? (
					<div
						id={listId}
						className="ss-scroll mt-2 max-h-[60vh] animate-ss-pop rounded-card border border-line-soft bg-surface p-2 shadow-overlay">
						{list(true)}
					</div>
				) : null}
			</div>
			<div className="ss-scroll hidden max-h-[calc(100dvh-8rem)] rounded-panel border border-line-soft bg-surface p-2 shadow-panel lg:block lg:max-h-(--ss-pane-h)">
				{list(false)}
			</div>
		</div>
	);
}

/**
 * A page with an inner sidebar and ONE view at a time: the section links on the left (a floating panel, sticky under the
 * header), the chosen section on the right. A section with `children` lists them as sub-items, each its own view (so
 * a long section is several short ones, never one long column). The choice is in the address hash (`#security`), so a
 * link opens it and Back returns to the one before. A section is mounted when first opened and then kept (an edit in
 * it is not lost when another is opened); the others are not on the page at all.
 * @param {{ sections: SectionSpec[], label?: string, initial?: string, className?: string, empty?: ReactNode,
 *   searchFrom?: number, searchLabel?: string }} props
 */
export function SectionLayout({ sections, label = 'Sections', initial, className, empty, searchFrom, searchLabel }) {
	const leaves = leavesOf(sections);
	const [active, choose] = useHashSection(
		leaves.map((section) => section.id),
		initial,
	);
	const [seen, setSeen] = useState(() => new Set([active]));
	if (active && !seen.has(active)) setSeen(new Set([...seen, active]));
	const items = useMemo(() => {
		/** @param {SectionSpec} section @returns {SectionItem} */
		const strip = ({ content: _content, children, ...item }) => ({
			...item,
			...(children?.length ? { children: children.map(strip) } : {}),
		});
		return sections.map(strip);
	}, [sections]);
	if (leaves.length === 0) return <>{empty ?? null}</>;
	const panels = (
		<div className="min-w-0">
			{leaves
				.filter((section) => section.id === active || seen.has(section.id))
				.map((section) => (
					<div key={section.id} id={`section-${section.id}`} hidden={section.id !== active} className={CARD_FLOW}>
						{section.content}
					</div>
				))}
		</div>
	);
	// one view needs no sidebar
	if (leaves.length === 1) return <div className={cx('grid min-w-0', NO_STRETCH, className)}>{panels}</div>;
	return (
		<div className={cx('grid min-w-0 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-6', NO_STRETCH, className)}>
			<SectionNav
				items={items}
				active={active}
				onSelect={choose}
				label={label}
				{...(searchFrom ? { searchFrom } : {})}
				{...(searchLabel ? { searchLabel } : {})}
				className="lg:sticky lg:top-0"
			/>
			{panels}
		</div>
	);
}

/**
 * The heading of one view of a page with an inner sidebar: its title, a one-line description and optional actions. In a
 * {@link CardFlow} it takes the whole row.
 * @param {{ title: ReactNode, description?: ReactNode, actions?: ReactNode, className?: string }} props
 */
export function ViewTitle({ title, description, actions, className }) {
	return (
		<header className={cx('flex min-w-0 flex-wrap items-center justify-between gap-3 pb-1', className)}>
			<div className="min-w-0">
				<h2 className="text-page font-semibold tracking-[-0.015em] text-fg">{title}</h2>
				{description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
			</div>
			{actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
		</header>
	);
}

/**
 * A small tab strip for the parts of one view (the groups of a settings form): one part is shown at a time. The strip
 * scrolls sideways when it is longer than the card.
 * @param {{ tabs: Array<{ id: string, label: ReactNode }>, active: string, onSelect: (id: string) => void,
 *   label: string, className?: string, idPrefix?: string }} props
 */
export function PillTabs({ tabs, active, onSelect, label, className, idPrefix = 'pt' }) {
	return (
		<div
			role="tablist"
			aria-label={label}
			className={cx('ss-scroll flex w-fit max-w-full min-w-0 gap-0.5 rounded-control bg-surface-2 p-0.5 ring-1 ring-line-soft ring-inset', className)}>
			{tabs.map((tab) => {
				const on = tab.id === active;
				return (
					<button
						key={tab.id}
						type="button"
						role="tab"
						id={`${idPrefix}-tab-${tab.id}`}
						aria-selected={on}
						aria-controls={`${idPrefix}-panel-${tab.id}`}
						onClick={() => onSelect(tab.id)}
						className={cx(
							'ss-motion h-7 shrink-0 rounded-md px-3 text-label font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
							on ? 'bg-surface text-fg shadow-card ring-1 ring-line-soft' : 'text-muted hover:text-fg',
						)}>
						{tab.label}
					</button>
				);
			})}
		</div>
	);
}

/**
 * The look of {@link PillTabs} for links (a view of the same list by day, by merchant …): a segmented strip whose
 * current link is raised. `linkAs` renders router links.
 * @param {{ items: Array<{ href: string, label: ReactNode, current?: boolean }>, label: string,
 *   linkAs?: import('react').ElementType, className?: string }} props
 */
export function LinkTabs({ items, label, linkAs, className }) {
	const LinkTag = linkAs ?? 'a';
	return (
		<nav
			aria-label={label}
			className={cx('ss-scroll flex w-fit max-w-full min-w-0 gap-0.5 rounded-control bg-surface-2 p-0.5 ring-1 ring-line-soft ring-inset', className)}>
			{items.map((item) => (
				<LinkTag
					key={item.href}
					href={item.href}
					aria-current={item.current ? 'page' : undefined}
					className={cx(
						'ss-motion inline-flex h-7 shrink-0 items-center rounded-md px-3 text-label font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
						item.current ? 'bg-surface text-fg shadow-card ring-1 ring-line-soft' : 'text-muted hover:text-fg',
					)}>
					{item.label}
				</LinkTag>
			))}
		</nav>
	);
}

/** A list with more items than this is picked from a select, not a strip of tabs. */
const SWITCHER_TABS_UP_TO = 8;

/**
 * The items of a list editor one at a time (owner 2026-10-16: no long stacks of item cards): a strip with one tab per
 * item (named by `nameOf`; a select from nine items on) and an Add button; `renderItem` draws the picked item only. The picked item moves to the
 * one just added.
 * @template T
 * @param {{ items: T[], legend: string, nameOf: (item: T, index: number) => string,
 *   renderItem: (item: T, index: number) => ReactNode, onAdd?: () => void, addLabel?: string, addDisabled?: boolean,
 *   emptyText?: ReactNode, className?: string }} props
 */
export function ItemSwitcher({
	items,
	legend,
	nameOf,
	renderItem,
	onAdd,
	addLabel = 'Add',
	addDisabled = false,
	emptyText,
	className,
}) {
	const [picked, setPicked] = useState(0);
	const at = Math.max(0, Math.min(picked, items.length - 1));
	const item = items[at];
	return (
		<div className={cx('min-w-0 space-y-3', className)}>
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				{items.length > SWITCHER_TABS_UP_TO ? (
					<select
						aria-label={legend}
						value={String(at)}
						onChange={(event) => setPicked(Number(event.target.value))}
						className="h-9 min-w-0 max-w-full flex-1 rounded-control border border-line bg-surface px-3 text-sm text-fg focus-visible:outline-2 focus-visible:outline-focus">
						{items.map((entry, index) => (
							<option key={index} value={String(index)}>
								{nameOf(entry, index) || `#${index + 1}`}
							</option>
						))}
					</select>
				) : items.length > 0 ? (
					<PillTabs
						className="min-w-0 flex-1"
						label={legend}
						idPrefix={`is${at}`}
						active={String(at)}
						onSelect={(id) => setPicked(Number(id))}
						tabs={items.map((entry, index) => ({ id: String(index), label: nameOf(entry, index) || `#${index + 1}` }))}
					/>
				) : null}
				{onAdd ? (
					<Button
						size="sm"
						variant="secondary"
						disabled={addDisabled}
						onClick={() => {
							onAdd();
							setPicked(items.length);
						}}>
						{addLabel}
					</Button>
				) : null}
			</div>
			{item !== undefined ? renderItem(item, at) : emptyText ? <p className="text-sm text-muted">{emptyText}</p> : null}
		</div>
	);
}

/**
 * A collapsed block for what most people never change (Advanced): a bar with a title that opens it. Collapsed by
 * default; `forceOpen` opens it (a field inside has an error). The content is not on the page while it is closed.
 * @param {{ title: ReactNode, description?: ReactNode, badge?: ReactNode, defaultOpen?: boolean, forceOpen?: boolean,
 *   children?: ReactNode, className?: string }} props
 */
export function Disclosure({ title, description, badge, defaultOpen = false, forceOpen = false, children, className }) {
	const [open, setOpen] = useState(defaultOpen);
	const id = useId();
	const shown = open || forceOpen;
	return (
		<section className={cx('min-w-0 rounded-card border border-line-soft bg-surface shadow-card', className)}>
			<button
				type="button"
				aria-expanded={shown}
				aria-controls={shown ? id : undefined}
				onClick={() => setOpen(!shown)}
				className="ss-motion flex min-h-12 w-full items-center gap-2.5 rounded-card px-5 py-3 text-left hover:bg-surface-2/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus">
				<span aria-hidden="true" className={cx('ss-motion text-muted', shown && 'rotate-90')}>
					<Icon name="chevronRight" size={16} />
				</span>
				<span className="text-title font-semibold text-fg">{title}</span>
				{badge}
				{description ? <span className="min-w-0 flex-1 truncate text-help text-muted">{description}</span> : null}
			</button>
			{shown ? (
				<div id={id} className="min-w-0 space-y-4 border-t border-line-soft p-5">
					{children}
				</div>
			) : null}
		</section>
	);
}
