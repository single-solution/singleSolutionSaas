'use client';
/**
 * The page-building blocks of the premium layout (owner 2026-10-16): the 12-column `Grid` / `Col`, the
 * {@link SettingsCard} with its setting rows (label and muted help on the left, the control on the right, rows divided
 * by hairlines, stacked on phones), the sticky {@link SaveBar} that appears only when something changed, and the inner
 * sidebar ({@link SectionNav}, {@link SectionLayout}) for pages that have sections.
 * @module
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { cx } from './cx.js';
import { Button } from './Button.js';
import { Card } from './display.js';
import { FieldLayoutContext, ROW_LIST } from './fields.js';
import { Icon } from './icons.js';

/** @typedef {import('react').ReactNode} ReactNode */

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
	return <div className={cx('grid min-w-0 grid-cols-12 items-start gap-4 lg:gap-6', className)}>{children}</div>;
}

/**
 * A cell of the {@link Grid}: `span` columns from tablet width (a phone gets the full row), `lg` and `xl` change the
 * span on wider screens.
 * @param {{ span?: Span, lg?: Span, xl?: Span, children?: ReactNode, className?: string }} props
 */
export function Col({ span = 12, lg, xl, children, className }) {
	return (
		<div className={cx('min-w-0 space-y-4 lg:space-y-6', SPAN[span], lg && SPAN_LG[lg], xl && SPAN_XL[xl], className)}>
			{children}
		</div>
	);
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
 * @param {{ title?: ReactNode, description?: ReactNode, actions?: ReactNode, footer?: ReactNode, children?: ReactNode,
 *   id?: string, className?: string, as?: 'section' | 'div' | 'article' }} props
 */
export function SettingsCard({ title, description, actions, footer, children, id, className, as }) {
	return (
		<FieldLayoutContext.Provider value="row">
			<Card
				{...(id ? { id } : {})}
				{...(as ? { as } : {})}
				title={title}
				subtitle={description}
				actions={actions}
				{...(className ? { className } : {})}
				bodyClassName="@container">
				{children}
				{footer ? (
					<div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line-soft pt-4">{footer}</div>
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
				'grid min-w-0 items-start gap-x-8 gap-y-2',
				!stacked && '@md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]',
				className,
			)}>
			<div className={cx('min-w-0 space-y-0.5', !stacked && '@md:pt-2')}>
				{htmlFor ? (
					<label htmlFor={htmlFor} className="block text-label leading-5 font-medium text-fg">
						{label}
					</label>
				) : (
					<div id={labelId} className="text-label leading-5 font-medium text-fg">
						{label}
					</div>
				)}
				{description ? <p className="text-xs leading-relaxed text-muted">{description}</p> : null}
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
 * One link of the inner sidebar.
 * @typedef {object} SectionItem
 * @property {string} id
 * @property {ReactNode} label
 * @property {import('./icons.js').IconName} [icon]
 * @property {ReactNode} [badge] a count or a status shown at the right
 * @property {string} [group] the group heading the link is listed under (links of one group are listed together)
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
 * The section shown, kept in the address hash (`#security`): the first section until the page is in the browser, then
 * the hash's, and choosing a section updates the hash without a new history entry.
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
		};
		read();
		window.addEventListener('hashchange', read);
		return () => window.removeEventListener('hashchange', read);
	}, [ids.join('|')]);
	const choose = useCallback((/** @type {string} */ id) => {
		setActive(id);
		try {
			window.history.replaceState(null, '', `#${encodeURIComponent(id)}`);
		} catch {
			// no history (a sandboxed frame): the choice still shows
		}
	}, []);
	return [active, choose];
}

/**
 * The inner sidebar: a floating panel of grouped section links with icons and badges, sticky below the header on wide
 * screens. On a phone it is one button showing the current section that opens the list.
 * @param {{ items: SectionItem[], active: string, onSelect: (id: string) => void, label?: string, className?: string }} props
 */
export function SectionNav({ items, active, onSelect, label = 'Sections', className }) {
	const [open, setOpen] = useState(false);
	const listId = useId();
	const current = items.find((item) => item.id === active) ?? items[0];
	const list = (/** @type {boolean} */ phone) => (
		<nav aria-label={label} className="space-y-4">
			{groupsOf(items).map(([group, entries], index) => (
				<div key={group || index} className="space-y-0.5">
					{group ? <p className="px-2.5 pb-1 text-micro font-semibold tracking-wide text-muted uppercase">{group}</p> : null}
					<ul className="space-y-0.5">
						{entries.map((item) => {
							const on = item.id === active;
							return (
								<li key={item.id}>
									<a
										href={`#${item.id}`}
										aria-current={on ? 'true' : undefined}
										onClick={(event) => {
											event.preventDefault();
											onSelect(item.id);
											if (phone) setOpen(false);
										}}
										className={cx(
											'ss-motion ss-press flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-focus',
											on
												? 'bg-primary-soft font-semibold text-on-primary-soft'
												: 'font-medium text-fg/80 hover:bg-surface-2 hover:text-fg',
										)}>
										{item.icon ? (
											<span aria-hidden="true" className={on ? 'text-primary' : 'text-muted'}>
												<Icon name={item.icon} size={16} />
											</span>
										) : null}
										<span className="min-w-0 flex-1 truncate">{item.label}</span>
										{item.badge}
									</a>
								</li>
							);
						})}
					</ul>
				</div>
			))}
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
					{current?.icon ? (
						<span aria-hidden="true" className="text-primary">
							<Icon name={current.icon} size={16} />
						</span>
					) : null}
					<span className="min-w-0 flex-1 truncate text-left">{current?.label}</span>
					<span aria-hidden="true" className={cx('ss-motion text-muted', open && 'rotate-180')}>
						<Icon name="chevronDown" size={16} />
					</span>
				</button>
				{open ? (
					<div id={listId} className="mt-2 animate-ss-pop rounded-panel border border-line-soft bg-surface p-2 shadow-panel">
						{list(true)}
					</div>
				) : null}
			</div>
			<div className="hidden rounded-panel border border-line-soft bg-surface p-2.5 shadow-card lg:block">{list(false)}</div>
		</div>
	);
}

/**
 * A page with an inner sidebar: the section links on the left (a floating panel, sticky under the header), the section
 * shown on the right at the width the window leaves. Every section stays mounted (an edit in one is not lost when
 * another is opened), only the chosen one is visible; the chosen section is in the address hash.
 * @param {{ sections: Array<SectionItem & { content: ReactNode }>, label?: string, initial?: string, className?: string,
 *   navWidth?: string }} props
 */
export function SectionLayout({ sections, label = 'Sections', initial, className }) {
	const [active, choose] = useHashSection(
		sections.map((section) => section.id),
		initial,
	);
	return (
		<div className={cx('grid min-w-0 items-start gap-4 lg:grid-cols-[13.75rem_minmax(0,1fr)] lg:gap-6', className)}>
			<SectionNav
				items={sections.map(({ content: _content, ...item }) => item)}
				active={active}
				onSelect={choose}
				label={label}
				className="lg:sticky lg:top-24"
			/>
			<div className="min-w-0">
				{sections.map((section) => (
					<div
						key={section.id}
						id={`section-${section.id}`}
						hidden={section.id !== active}
						className="min-w-0 space-y-4 lg:space-y-6">
						{section.content}
					</div>
				))}
			</div>
		</div>
	);
}
