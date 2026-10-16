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
import { FieldLayoutContext, ROW_LIST } from './fields.js';
import { Icon } from './icons.js';

/** @typedef {import('react').ReactNode} ReactNode */

/** The grid rule that keeps every card at its natural height (a row of cards never stretches the short ones). */
export const NO_STRETCH = 'items-start';

/**
 * The responsive flow of cards (owner 2026-10-16: what can sit in a row must): as many columns as fit at least 24 rem
 * each (one on a phone, two on a tablet, three on a wide screen), every card at its natural height. A
 * {@link SettingsCard} (`data-flow="card"`) takes one column; anything else in the flow (a table, an editor, a preview,
 * a callout) takes the whole row.
 */
export const CARD_FLOW =
	'grid min-w-0 items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,24rem),1fr))] ' +
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
	return <div className={cx('grid min-w-0 grid-cols-12 gap-4 lg:gap-5', NO_STRETCH, className)}>{children}</div>;
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
					<div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">{footer}</div>
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
			className={cx(
				'grid min-w-0 items-start gap-x-8 gap-y-1.5',
				!stacked && '@md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]',
				className,
			)}>
			<div className={cx('min-w-0 space-y-0.5', !stacked && '@md:pt-1.5')}>
				{htmlFor ? (
					<label htmlFor={htmlFor} className="block text-label leading-5 font-medium text-fg">
						{label}
					</label>
				) : (
					<div id={labelId} className="text-label leading-5 font-medium text-fg">
						{label}
					</div>
				)}
				{description ? <p className="text-xs leading-snug text-muted">{description}</p> : null}
			</div>
			<div className="min-w-0 space-y-2">{children}</div>
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
			<div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-x-4 gap-y-2 rounded-panel border border-line-soft bg-surface px-4 py-2.5 shadow-overlay animate-ss-sheet">
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
 * A hash that names no section leaves the choice alone; no hash at all goes back to the first.
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
			if (ids.includes(hash)) setActive(hash);
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
					'ss-motion ss-press flex items-center gap-2.5 rounded-lg text-sm focus-visible:outline-2 focus-visible:outline-focus',
					child ? 'h-8 pr-2.5 pl-9' : 'h-9 px-2.5',
					on
						? 'bg-primary-soft font-semibold text-on-primary-soft'
						: holds
							? 'font-semibold text-fg'
							: 'font-medium text-fg/80 hover:bg-surface-2 hover:text-fg',
				)}>
				{!child && item.icon ? (
					<span aria-hidden="true" className={on || holds ? 'text-primary' : 'text-muted'}>
						<Icon name={item.icon} size={16} />
					</span>
				) : null}
				<span className="min-w-0 flex-1 truncate">{item.label}</span>
				{item.badge}
				{!child && item.children?.length ? (
					<span aria-hidden="true" className={cx('ss-motion text-muted', (holds || needle !== '') && 'rotate-180')}>
						<Icon name="chevronDown" size={14} />
					</span>
				) : null}
			</a>
		);
	};
	const list = (/** @type {boolean} */ phone) => (
		<nav aria-label={label} className="space-y-3">
			{leaves.length >= searchFrom ? (
				<input
					type="search"
					aria-label={searchLabel}
					placeholder={searchLabel}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					className="h-9 w-full rounded-control border border-line bg-surface px-3 text-sm text-fg placeholder:text-muted/70 focus-visible:outline-2 focus-visible:outline-focus"
				/>
			) : null}
			{groupsOf(visible).map(([group, entries], index) => (
				<div key={group || index} className="space-y-0.5">
					{group ? <p className="px-2.5 pb-1 text-micro font-semibold tracking-wide text-muted uppercase">{group}</p> : null}
					<ul className="space-y-0.5">
						{entries.map((item) => {
							const expanded =
								item.children?.length && (needle !== '' || item.children.some((child) => child.id === active));
							return (
								<li key={item.id}>
									{link(item, phone, false)}
									{expanded ? (
										<ul className="mt-0.5 space-y-0.5">
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
					className="ss-motion ss-press flex h-11 w-full items-center gap-2.5 rounded-panel border border-line-soft bg-surface px-3.5 text-sm font-semibold text-fg shadow-card">
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
						className="mt-2 max-h-[70vh] animate-ss-pop overflow-y-auto rounded-panel border border-line-soft bg-surface p-2 shadow-panel">
						{list(true)}
					</div>
				) : null}
			</div>
			<div className="hidden max-h-[calc(100vh-8rem)] overflow-y-auto rounded-panel border border-line-soft bg-surface p-2.5 shadow-card lg:block">
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
	return (
		<div className={cx('grid min-w-0 gap-4 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:gap-5', NO_STRETCH, className)}>
			<SectionNav
				items={items}
				active={active}
				onSelect={choose}
				label={label}
				{...(searchFrom ? { searchFrom } : {})}
				{...(searchLabel ? { searchLabel } : {})}
				className="lg:sticky lg:top-24"
			/>
			<div className="min-w-0">
				{leaves
					.filter((section) => section.id === active || seen.has(section.id))
					.map((section) => (
						<div key={section.id} id={`section-${section.id}`} hidden={section.id !== active} className={CARD_FLOW}>
							{section.content}
						</div>
					))}
			</div>
		</div>
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
		<div role="tablist" aria-label={label} className={cx('flex min-w-0 gap-1 overflow-x-auto pb-1', className)}>
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
							'ss-motion ss-press h-8 shrink-0 rounded-full px-3.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-focus',
							on ? 'bg-primary-soft font-semibold text-on-primary-soft' : 'text-fg/80 hover:bg-surface-2 hover:text-fg',
						)}>
						{tab.label}
					</button>
				);
			})}
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
		<section className={cx('min-w-0 rounded-card border border-dashed border-line bg-surface/60', className)}>
			<button
				type="button"
				aria-expanded={shown}
				aria-controls={shown ? id : undefined}
				onClick={() => setOpen(!shown)}
				className="ss-motion flex w-full items-center gap-2.5 rounded-card px-5 py-3 text-left focus-visible:outline-2 focus-visible:outline-focus">
				<span aria-hidden="true" className={cx('ss-motion text-muted', shown && 'rotate-90')}>
					<Icon name="chevronRight" size={16} />
				</span>
				<span className="text-sm font-semibold text-fg">{title}</span>
				{badge}
				{description ? <span className="min-w-0 flex-1 truncate text-xs text-muted">{description}</span> : null}
			</button>
			{shown ? (
				<div id={id} className="min-w-0 space-y-4 px-5 pb-5">
					{children}
				</div>
			) : null}
		</section>
	);
}
