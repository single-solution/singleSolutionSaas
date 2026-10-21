'use client';
/**
 * The page-building blocks of the premium layout (owner 2026-10-16): the 12-column `Grid` / `Col`, the
 * {@link SettingsCard} with its setting rows (label and muted help on the left, the control on the right, rows divided
 * by hairlines, stacked on phones), the sticky {@link SaveBar} that appears only when something changed, the section
 * choice kept in the address ({@link useHashSection}, used by the dashboard pages with an inner navigation), the
 * {@link PillTabs} form control, and {@link Disclosure}, a block that opens and closes.
 *
 * Nothing here stretches a card to the height of its neighbor: the grids align their cells to the start ({@link NO_STRETCH}).
 * @module
 */
import { Fragment, useCallback, useContext, useEffect, useId, useState } from 'react';
import { cx } from './cx.js';
import { Button } from './Button.js';
import { Card } from './display.js';
import { FieldLayoutContext, ROW_GRID, ROW_LABEL, ROW_LIST, rowControl } from './fields.js';
import { Icon } from './icons.js';
import { SAVE_BAR } from './layout-metrics.js';
import { usePresence } from './motion.js';
import { Dialog } from './overlay.js';
import { PageSavesContext } from './page-sections.js';
import { useToast } from './Toast.js';
import { UNDO_MS, UNSAVED_TEXTS, answerLeave, dropBar, setBar, useLeaveQuestion } from './unsaved.js';

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
 * The question that opens when someone leaves while a save bar has changes (see `unsaved.js`). The first save bar on the
 * page draws it; the others draw nothing.
 * @param {{ id: string, words: import('./unsaved.js').UnsavedTexts }} props
 */
function LeaveGuard({ id, words }) {
	const ask = useLeaveQuestion(id);
	if (!ask) return null;
	return (
		<Dialog
			open={ask.open}
			size="sm"
			title={words.title}
			description={words.body}
			dismissible={!ask.busy}
			onClose={() => void answerLeave('stay')}
			footer={
				<>
					<Button variant="ghost" disabled={ask.busy} onClick={() => void answerLeave('discard')}>
						{words.discard}
					</Button>
					<Button variant="secondary" data-autofocus="" disabled={ask.busy} onClick={() => void answerLeave('stay')}>
						{words.stay}
					</Button>
					<Button loading={ask.busy} disabled={!ask.canSave} onClick={() => void answerLeave('save')}>
						{words.save}
					</Button>
				</>
			}
		/>
	);
}

/**
 * The only save control: a bar that floats at the bottom centre of the page area and offers Save and Discard once
 * something changed (and is not on screen otherwise). It also does the job of a list editor's Save and Cancel
 * buttons: `disabled` keeps Save off for an entry the server would refuse, and a save that returns a promise shows
 * the spinner (and locks Discard) until it settles, without the caller tracking it. A save that failed leaves the bar
 * on screen so the person can try again. Place it anywhere in the page; it is fixed to the window.
 *
 * Inside a `Page` with `sections` it draws nothing: it tells the page what it has (`show`, the handlers, the words) and
 * the page draws ONE bar for all its sections. That bar shows while any section has changes and names them (`changes`,
 * each name a button that jumps to its section), Save runs the `onSave` of each section with changes in the page's
 * order and stops at the first that throws, rejects or returns `false` (its own error stays where the section shows
 * it), Discard runs every one's `onDiscard`, Save is off while any section's Save is `disabled`, and the bar is busy
 * while any section is `saving`.
 *
 * While a bar that draws itself has changes the page is guarded (see `unsaved.js`): the browser warns before the tab
 * closes, and a move that leaves the screen asks Save, Discard or Stay first. Discard takes effect at once; when
 * `onDiscard` returns a function that puts the edits back, a toast "Changes discarded" offers it as Undo for 8 seconds.
 * @param {{ show: boolean, onSave: () => unknown, onDiscard: () => unknown, saving?: boolean, disabled?: boolean,
 *   message?: ReactNode, saveLabel?: string, discardLabel?: string, changes?: Array<{ id: string, label: string }>,
 *   onJump?: (id: string) => void, texts?: Partial<import('./unsaved.js').UnsavedTexts>, className?: string }} props
 *   `saving`: the caller knows the save is running; `disabled`: Save is off although something changed; `changes`: the
 *   sections that have changes (named in place of `message`); `onJump`: what a click on a section's name does
 */
export function SaveBar({
	show,
	onSave,
	onDiscard,
	saving = false,
	disabled = false,
	message,
	saveLabel = 'Save changes',
	discardLabel = 'Discard',
	changes,
	onJump,
	texts,
	className,
}) {
	const page = useContext(PageSavesContext);
	const id = useId();
	const toast = useToast();
	const words = { ...UNSAVED_TEXTS, ...texts };
	const { mounted, closing, ref } = usePresence(show && !page);
	const [running, setRunning] = useState(false);
	const busy = saving || running;
	const save = () => {
		const result = onSave();
		if (result && typeof (/** @type {Promise<unknown>} */ (result).then) === 'function') {
			setRunning(true);
			const done = () => setRunning(false);
			/** @type {Promise<unknown>} */ (result).then(done, done);
		}
	};
	// Discard takes effect at once; a way back, when the caller gave one, is offered for a few seconds
	const discard = () => {
		const undo = onDiscard();
		if (typeof undo === 'function') {
			toast.show({
				title: words.discarded,
				tone: 'info',
				durationMs: UNDO_MS,
				action: { label: words.undo, onClick: /** @type {() => void} */ (undo) },
			});
		}
	};
	// a page with sections keeps the latest of what this bar has (its handlers are read when the page saves); a bar
	// that draws itself tells the leave guard
	useEffect(() => {
		if (page) page.put(id, { show, onSave, onDiscard, saving, disabled, message, saveLabel, discardLabel });
		else setBar(id, { show, onSave, onDiscard, disabled });
	});
	useEffect(
		() => () => {
			page?.drop(id);
			dropBar(id);
		},
		[page, id],
	);
	if (page) return null;
	const named = changes && changes.length > 0 ? changes : null;
	return (
		<>
			{mounted ? (
				<div
					ref={ref}
					role="region"
					aria-label={saveLabel}
					data-state={closing ? 'closed' : 'open'}
					className={cx(SAVE_BAR.strip, className)}>
					<div className={cx(SAVE_BAR.bar, closing ? 'animate-ss-sheet-out' : 'animate-ss-sheet')}>
						<p role="status" className="flex items-center gap-2 text-sm font-medium text-fg">
							<span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-attention-solid" />
							{named ? (
								<span>
									{words.changedIn}{' '}
									{named.map((one, index) => (
										<Fragment key={one.id}>
											{index > 0 ? ', ' : null}
											{onJump ? (
												<button
													type="button"
													onClick={() => onJump(one.id)}
													className="ss-motion rounded underline decoration-dotted underline-offset-4 hover:text-primary focus-visible:outline-2 focus-visible:outline-focus">
													{one.label}
												</button>
											) : (
												one.label
											)}
										</Fragment>
									))}
								</span>
							) : (
								(message ?? words.title)
							)}
						</p>
						<div className="ml-auto flex items-center gap-2">
							<Button variant="ghost" size="sm" onClick={discard} disabled={busy || closing}>
								{discardLabel}
							</Button>
							<Button size="sm" loading={busy} disabled={disabled || closing} onClick={save}>
								{saveLabel}
							</Button>
						</div>
					</div>
				</div>
			) : null}
			<LeaveGuard id={id} words={words} />
		</>
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
 * @property {import('./display.js').Tone} [status] a status dot before the badge (`attention`: needs setup, `success`:
 *   on, `danger`: failing), named by `statusLabel`
 * @property {string} [statusLabel] the words of the status dot (its tooltip and what a screen reader says)
 * @property {string} [group] the group heading the link is listed under (links of one group are listed together)
 * @property {SectionItem[]} [children] sub-items (one level)
 */

/**
 * A section of a dashboard page (see `dashboard-page.js`): a link with its content, or a link with sub-sections.
 * @typedef {Omit<SectionItem, 'children'> & { content?: ReactNode, children?: SectionSpec[] }} SectionSpec
 */

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

/** The look of a strip of tabs ({@link PillTabs}): a sage track whose current item is raised. */
const TAB_STRIP = 'ss-scroll flex w-fit max-w-full min-w-0 gap-0.5 rounded-control bg-surface-2 p-0.5';
/** @param {boolean} on */
const tabLook = (on) =>
	cx(
		'ss-motion inline-flex h-7 shrink-0 items-center rounded-md px-3 text-label font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
		on ? 'bg-surface text-fg shadow-card ring-1 ring-line-soft' : 'text-muted hover:text-fg',
	);

/**
 * A small tab strip for the parts of one view (the groups of a settings form): one part is shown at a time. The strip
 * scrolls sideways when it is longer than the card.
 * @param {{ tabs: Array<{ id: string, label: ReactNode }>, active: string, onSelect: (id: string) => void,
 *   label: string, className?: string, idPrefix?: string }} props
 */
export function PillTabs({ tabs, active, onSelect, label, className, idPrefix = 'pt' }) {
	return (
		<div role="tablist" aria-label={label} className={cx(TAB_STRIP, className)}>
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
						className={tabLook(on)}>
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
		<section className={cx('min-w-0 rounded-card border border-line-soft bg-surface', className)}>
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
