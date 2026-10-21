'use client';
/**
 * The page frame of the product dashboard (layout contract 2026-10-17): what every tab draws through {@link Page}.
 * `useCrumbs` gives the breadcrumbs `Product › Section › sub-page` with the addresses of the frame around (a tab on its
 * own has plain ones); `SectionsPage` is the one page with several views: they are a list of rich rows (a
 * {@link ListColumn}) beside the page, each view its own `#address` (the browser's Back button works), with the
 * counts, dots and locks the sections carry; a section with parts is one row whose page shows every part stacked, all
 * open. An opened view stays mounted (an edit in it is not lost); `pageState` turns an answer into the page's own
 * loading skeleton or error.
 * @module
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState } from 'react';
import { CARD_FLOW } from './blocks.js';
import { Button } from './Button.js';
import { cx } from './cx.js';
import { useDashboard } from './dashboard-parts.js';
import { Icon } from './icons.js';
import { INNER_NAV_TEXTS } from './InnerNav.js';
import { PAGE } from './layout-metrics.js';
import { ListColumn } from './ListColumn.js';
import { Page } from './Page.js';
import { useNarrow } from './page-parts.js';
import { describeProblem } from './problems.js';
import { TOOLBAR_TEXTS } from './Toolbar.js';

/** @typedef {import('react').ReactNode} ReactNode */
/** @typedef {import('./blocks.js').SectionSpec} BaseSpec */
/** @typedef {Omit<Parameters<typeof import('./Row.js').Row>[0], 'selected' | 'onSelect'>} RowLook */
/** @typedef {import('./page-parts.js').PageCrumb} PageCrumb */
/** @typedef {import('./page-parts.js').PageFact} PageFact */
/** @typedef {import('./page-parts.js').PageActions} PageActions */
/** @typedef {import('./page-parts.js').PageStatus} PageStatus */
/** @typedef {import('./dashboard-api.js').Answer} Answer */
/**
 * The frame around the tabs: the address of every tab (it keeps the picked website) and the address of the product's
 * home, the Overview.
 * @typedef {{ hrefOf: (tab: string) => string, home: string }} Frame
 */
/**
 * A section of {@link SectionsPage}: a row of the list with its content, or with parts of its own (one row; its page
 * draws every part stacked under its label, all open). The row: `icon` leads, `label` is the title, `status` (with
 * `statusLabel`) the dot after it, `badge` the value at the right, `meta` the muted line under the title (a string, or
 * several joined with " · "), `locked` a lock at the end (the page is still opened: it explains what the feature
 * does); `trailing` is a control at the very end (a switch: a click on it never opens the row) and `warning` a line
 * in its color in place of `meta` (what blocks the thing); `group` lists it under that chip of the list. What the open view says about itself goes in the page's header:
 * `info` (the old description, behind the (i)), `facts`, `pills` and `actions`; `flush` gives its body no padding (a
 * table uses all of it); `toolbar` and `footer` are the ones of this view (a search above its table, the pages below
 * it), shown while it is open. A section with parts takes these from itself, else from its first part.
 * @typedef {Omit<BaseSpec, 'children'> & { info?: ReactNode, facts?: PageFact[], pills?: PageStatus[],
 *   actions?: PageActions, toolbar?: ReactNode, footer?: ReactNode, flush?: boolean, locked?: boolean,
 *   meta?: string | string[], trailing?: ReactNode, warning?: NonNullable<RowLook['warning']>, children?: Section[] }} Section
 */

/** The frame of the dashboard around a tab; none when a tab is drawn on its own. */
export const FrameContext = createContext(/** @type {Frame | null} */ (null));

/** The list skeleton of a page that loads: a list is on the page, its rows are drawn by the page's own skeleton. */
const LOADING_LIST = <ListColumn label="" items={[]} idOf={String} rowOf={() => ({ title: '' })} loading />;

/** The address of a tab when no frame is around. @param {string} tab */
const plainHref = (tab) => `?view=${tab}`;

/**
 * The breadcrumbs of a tab: `crumbs(tab, ...sub)` is Product › Section › sub-page, each step a link except the last,
 * which is the page's title. The Overview is Product › Overview.
 * @returns {(tab: string, ...sub: PageCrumb[]) => PageCrumb[]}
 */
export function useCrumbs() {
	const { texts } = useDashboard();
	const frame = useContext(FrameContext);
	return useCallback(
		(tab, ...sub) => {
			const hrefOf = frame?.hrefOf ?? plainHref;
			const section = /** @type {Record<string, string>} */ (texts.tabs)[tab] ?? tab;
			return [
				{ label: texts.title, href: frame?.home ?? hrefOf('overview') },
				{ label: section, ...(sub.length > 0 ? { href: hrefOf(tab) } : {}) },
				...sub,
			];
		},
		[texts, frame],
	);
}

/**
 * The page's own loading and error from an answer: its skeleton until the answer is there, the problem (with Try again
 * when it can be fetched again) when it failed, nothing otherwise.
 * @param {Answer | null} answer
 * @param {{ failed: string, tryAgain: string }} words
 * @returns {{ loading?: true, error?: { title: string, message: string, action?: ReactNode } }}
 */
export function pageState(answer, words) {
	if (!answer) return { loading: true };
	if (answer.ok) return {};
	return {
		error: {
			title: words.failed,
			message: describeProblem(answer.problem),
			...(answer.retry
				? {
						action: (
							<Button variant="secondary" onClick={answer.retry}>
								{words.tryAgain}
							</Button>
						),
					}
				: {}),
		},
	};
}

/**
 * A tab whose page is made from an answer (the kit's overview, the features...): its page skeleton (`skeleton` is the
 * body's, `withNav` draws the list's too) until the answer is there, the problem in the page (with Try again
 * when it can be fetched again) when it failed, and else whatever `children(data)` draws, which is the tab's own
 * {@link Page} or {@link SectionsPage}.
 * @param {{ answer: Answer | null, tab: string, sub?: PageCrumb[], skeleton?: ReactNode, withNav?: boolean,
 *   children: (data: any) => ReactNode }} props `tab`: the key of the tab (its crumb); `sub`: the crumbs after it
 */
export function LoadedPage({ answer, tab, sub = [], skeleton, withNav = false, children }) {
	const crumbs = useCrumbs();
	const { texts } = useDashboard();
	const state = pageState(answer, texts);
	if (state.loading || state.error)
		return (
			<Page
				crumbs={crumbs(tab, ...sub)}
				{...(state.loading
					? { loading: true, ...(withNav ? { list: LOADING_LIST } : {}), ...(skeleton ? { skeleton } : {}) }
					: {})}
				{...(state.error ? { error: state.error } : {})}
			/>
		);
	return children(answer?.ok ? answer.data : null);
}

/** The address of a view: its own `#id`. @param {string} id */
const hashOf = (id) => `#${encodeURIComponent(id)}`;

/** The current hash, without its `#`. */
const readHash = () => decodeURIComponent(window.location.hash.replace(/^#/, ''));

/**
 * The view an address names, and the part of it to scroll to. A hash is the id of a row, or of one of its parts (the
 * row opens, the part comes into view), or goes deeper than a row that is one page now (`catalog.page-addresses` opens
 * `catalog`), or is the start of a row's id (`catalog` opens `catalog.basics`).
 * @param {Section[]} rows
 * @param {string} hash
 * @returns {{ id: string, part: string } | undefined}
 */
const viewOf = (rows, hash) => {
	if (hash === '') return undefined;
	const part = rows.find((row) => row.children?.some((child) => child.id === hash));
	if (part) return { id: part.id, part: hash };
	const direct = rows.find((row) => row.id === hash);
	if (direct) return { id: direct.id, part: '' };
	const above = rows.find((row) => hash.startsWith(`${row.id}.`));
	if (above) return { id: above.id, part: '' };
	const below = rows.find((row) => row.id.startsWith(`${hash}.`));
	return below ? { id: below.id, part: '' } : undefined;
};

/**
 * The view shown, kept in the address hash (`#security`) like `useHashSection`: the first one until the page is in the
 * browser, then the hash's; choosing adds a history entry, so a link opens a view and Back returns to the one before.
 * It also says whether the address names a view at all (`named`: on phones no hash means the list shows), leaves the
 * view for the list (`leave`: a history entry without the hash) and the part of the view the hash points at.
 * @param {Section[]} rows
 * @param {string} [initial]
 * @returns {{ active: string, named: boolean, part: string, choose: (id: string) => void, leave: () => void }}
 */
function useViewHash(rows, initial) {
	const ids = rows.map((row) => row.id);
	// the ids of the rows and of their parts: what an address can name
	const known = rows.flatMap((row) => [row.id, ...(row.children ?? []).map((part) => part.id)]).join('|');
	const first = (initial === undefined ? undefined : viewOf(rows, initial)?.id) ?? initial ?? ids[0] ?? '';
	const [active, setActive] = useState(first);
	const [named, setNamed] = useState(false);
	const [part, setPart] = useState('');
	useLayoutEffect(() => {
		const read = () => {
			const hash = readHash();
			const view = viewOf(rows, hash);
			if (view) {
				setActive(view.id);
				setNamed(true);
				setPart(view.part);
			} else if (hash === '') {
				setActive(first);
				setNamed(false);
				setPart('');
			}
		};
		read();
		window.addEventListener('hashchange', read);
		window.addEventListener('popstate', read);
		return () => {
			window.removeEventListener('hashchange', read);
			window.removeEventListener('popstate', read);
		};
		// the rows are read by their ids: a new array of the same views is the same
	}, [known, first]);
	const choose = useCallback((/** @type {string} */ id) => {
		setActive(id);
		setNamed(true);
		setPart('');
		try {
			if (readHash() !== id) window.history.pushState(window.history.state, '', hashOf(id));
		} catch {
			// no history (a sandboxed frame): the choice still shows
		}
	}, []);
	const leave = useCallback(() => {
		setNamed(false);
		setPart('');
		try {
			if (window.location.hash !== '')
				window.history.pushState(window.history.state, '', window.location.pathname + window.location.search);
		} catch {
			// no history: the list still shows
		}
	}, []);
	return { active: ids.includes(active) ? active : (ids[0] ?? ''), named, part, choose, leave };
}

/** What a section's status dot is in a row (the colors of {@link Row}); the others are neutral. @type {Record<string, import('./Row.js').RowTone>} */
const ROW_TONES = { attention: 'warning', warning: 'warning', success: 'success', danger: 'danger' };

/**
 * One section as a row of the list: its icon leads, its label is the title with the status dot after it, the badge is
 * the value (the count), `meta` the muted line (`warning` in its place); a control (`trailing`) or a lock sits at the
 * end (the page is still opened: it explains what the feature does, and clicking the lock opens it too).
 * @param {Section} spec
 * @param {{ locked: string, open: (id: string) => void }} how `locked`: the words a screen reader says for the lock
 * @returns {RowLook}
 */
const rowOf = (spec, { locked, open }) => ({
	...(spec.icon ? { lead: { icon: spec.icon } } : {}),
	title: spec.label,
	...(spec.status ? { status: { tone: ROW_TONES[spec.status] ?? 'neutral', label: spec.statusLabel ?? '' } } : {}),
	...(spec.badge !== undefined && spec.badge !== null ? { value: spec.badge } : {}),
	...(spec.meta && spec.meta.length > 0 ? { meta: spec.meta } : {}),
	...(spec.warning ? { warning: spec.warning } : {}),
	...(spec.trailing
		? { trailing: spec.trailing }
		: spec.locked
			? {
					trailing: (
						<span className="flex text-subtle" onClick={() => open(spec.id)}>
							<Icon name="lock" size={14} title={locked} />
						</span>
					),
				}
			: {}),
});

/**
 * What a row is searched by: its label, its `meta` and the labels of its parts, in lower case.
 * @param {Section} spec
 */
const wordsOf = (spec) =>
	[spec.label, ...[spec.meta ?? []].flat(), ...(spec.children ?? []).map((part) => part.label)]
		.filter((word) => typeof word === 'string')
		.join(' ')
		.toLowerCase();

/**
 * The page of the header parts of a view: its own, else the first part's.
 * @param {Section} spec
 * @returns {Pick<Section, 'info' | 'facts' | 'pills' | 'actions' | 'toolbar' | 'footer'>}
 */
const headerOf = (spec) => {
	const first = spec.children?.[0];
	return {
		info: spec.info ?? first?.info,
		facts: spec.facts ?? first?.facts,
		pills: spec.pills ?? first?.pills,
		actions: spec.actions ?? first?.actions,
		toolbar: spec.toolbar ?? first?.toolbar,
		footer: spec.footer ?? first?.footer,
	};
};

/**
 * The body of a view: its content, or its parts stacked, each under a small heading and all open.
 * @param {{ spec: Section }} props
 */
function ViewBody({ spec }) {
	if (!spec.children?.length) return <>{spec.content}</>;
	return (
		<>
			{spec.children.map((part) => (
				<section
					key={part.id}
					id={`section-${part.id}`}
					aria-labelledby={`title-${part.id}`}
					className="flex min-w-0 flex-col gap-3">
					<h2 id={`title-${part.id}`} className="text-title font-semibold tracking-[-0.01em] text-fg">
						{part.label}
					</h2>
					<div className={part.flush ? PAGE.flush : CARD_FLOW}>{part.content}</div>
				</section>
			))}
		</>
	);
}

/**
 * The page of a tab that has several views: the header (the crumbs end in the open view), the list of the views as
 * rich rows beside the page, and the open view as the body. One view needs no list. A view is mounted when it is first
 * opened and then kept, hidden, so an edit in it is not lost. A section with `children` is one row; its page draws
 * every part stacked, each under its own heading, all open.
 * @param {{ tab: string, sections: Section[], label?: string, initial?: string, searchFrom?: number,
 *   searchLabel?: string, flushChildren?: boolean, resultLabel?: string, status?: PageStatus[], facts?: PageFact[], actions?: PageActions, info?: ReactNode, toolbar?: ReactNode,
 *   footer?: ReactNode, loading?: boolean, error?: import('react').ComponentProps<typeof Page>['error'],
 *   withNav?: boolean, empty?: ReactNode, children?: ReactNode }} props `tab`: the key of the tab (its crumb);
 *   `status`, `facts` and `actions` are the page's, used where the open view names none of its own, and `info` is
 *   said after the open view's;
 *   `children` take the place of the views (a search result) while the list stays (`flushChildren`: they are
 *   a table, which uses all of the body, and `resultLabel` ends the crumbs); `searchFrom`: the number of views from
 *   which the list has a search box (10 by default); `searchLabel`: the words of that search box; `withNav`: draw the
 *   list's skeleton too while `loading`
 */
export function SectionsPage({
	tab,
	sections,
	label,
	initial,
	searchFrom = 10,
	searchLabel,
	flushChildren = false,
	resultLabel,
	status,
	facts,
	actions,
	info,
	toolbar,
	footer,
	loading = false,
	error,
	withNav = false,
	empty,
	children,
}) {
	const crumbs = useCrumbs();
	const { texts } = useDashboard();
	const narrow = useNarrow();
	const { active, named, part, choose, leave } = useViewHash(sections, initial);
	const [seen, setSeen] = useState(() => new Set([active]));
	if (active && !seen.has(active)) setSeen(new Set([...seen, active]));
	const [query, setQuery] = useState('');
	const [group, setGroup] = useState('');
	const view = sections.find((section) => section.id === active);
	const several = sections.length > 1;
	const trail =
		children && resultLabel
			? crumbs(tab, { label: resultLabel })
			: crumbs(tab, ...(several && view ? [{ label: view.label }] : []));
	const tabLabel = /** @type {Record<string, string>} */ (texts.tabs)[tab] ?? tab;

	// a link to a part of a view brings the part into sight once the view is open
	useEffect(() => {
		if (part) document.getElementById(`section-${part}`)?.scrollIntoView?.({ block: 'start' });
	}, [part, active]);

	// the list: the groups are its chips (with 2+), the search box shows from `searchFrom` views
	const needle = query.trim().toLowerCase();
	const found = sections.filter((section) => needle === '' || wordsOf(section).includes(needle));
	const names = [...new Set(sections.flatMap((section) => (section.group ? [section.group] : [])))];
	const chosen = names.includes(group) ? group : '';
	const shown = chosen === '' ? found : found.filter((section) => section.group === chosen);
	const picked = narrow && !named ? null : active;
	const list =
		several || (loading && withNav) ? (
			loading ? (
				LOADING_LIST
			) : (
				<ListColumn
					label={label ?? tabLabel}
					items={shown}
					idOf={(section) => section.id}
					rowOf={(section) => rowOf(section, { locked: texts.features.locked, open: choose })}
					// a view filtered out of the list is still the open one; the list then has no picked row to tab to
					selected={shown.some((section) => section.id === active) || narrow ? picked : null}
					onSelect={choose}
					onBack={leave}
					empty={{ title: INNER_NAV_TEXTS.none }}
					{...(sections.length >= searchFrom
						? { search: { value: query, onChange: setQuery, ...(searchLabel ? { placeholder: searchLabel } : {}) } }
						: {})}
					{...(names.length >= 2
						? {
								filters: {
									value: chosen,
									onChange: setGroup,
									options: [
										{ id: '', label: TOOLBAR_TEXTS.all, count: found.length },
										...names.map((name) => ({
											id: name,
											label: name,
											count: found.filter((section) => section.group === name).length,
										})),
									],
								},
							}
						: {})}
				/>
			)
		) : undefined;
	const flush = children ? flushChildren : Boolean(view?.flush && !view.children?.length);
	// a result in place of the views is not the open view: the page's own header parts, not the view's
	const own = children || !view ? undefined : headerOf(view);
	const pills = own?.pills ?? status;
	const numbers = own?.facts ?? facts;
	const buttons = own?.actions ?? actions;
	const tools = own?.toolbar ?? toolbar;
	const pages = own?.footer ?? footer;
	// what the view says of itself comes first, then what the whole page is for
	const about =
		own?.info && info ? (
			<>
				<div>{own.info}</div>
				<div className="mt-2">{info}</div>
			</>
		) : (
			(own?.info ?? info)
		);
	return (
		<Page
			crumbs={trail}
			{...(pills ? { status: pills } : {})}
			{...(numbers ? { facts: numbers } : {})}
			{...(buttons ? { actions: buttons } : {})}
			{...(about ? { info: about } : {})}
			{...(list ? { list } : {})}
			{...(tools ? { toolbar: tools } : {})}
			{...(pages ? { footer: pages } : {})}
			// the open view changes inside the body: the views stay mounted, so the body is not remounted by the pick
			bodyKey=""
			loading={loading}
			{...(error ? { error } : {})}
			flush={flush}>
			{sections.length === 0 ? (
				(empty ?? null)
			) : (
				<>
					{children}
					{sections
						.filter((section) => section.id === active || seen.has(section.id))
						.map((section) => (
							<div
								key={section.id}
								id={`section-${section.id}`}
								hidden={section.id !== active || Boolean(children)}
								className={cx(
									section.children?.length ? 'flex min-w-0 flex-col gap-8' : section.flush ? PAGE.flush : CARD_FLOW,
									'animate-ss-enter',
								)}>
								<ViewBody spec={section} />
							</div>
						))}
				</>
			)}
		</Page>
	);
}
