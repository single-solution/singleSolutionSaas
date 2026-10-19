'use client';
/**
 * The page frame of the product dashboard (layout contract 2026-10-17): what every tab draws through {@link Page}.
 * `useCrumbs` gives the breadcrumbs `Product › Section › sub-page` with the addresses of the frame around (a tab on its
 * own has plain ones); `SectionsPage` is the one page with an inner navigation: a section with parts, or several
 * sections, become the {@link InnerNav} of the page, each sub-page its own `#address` (the browser's Back button
 * works), with the counts, dots and locks the sections carry. An opened sub-page stays mounted (an edit in it is not
 * lost); `pageState` turns an answer into the page's own loading skeleton or error.
 * @module
 */
import { createContext, useCallback, useContext, useState } from 'react';
import { CARD_FLOW, useHashSection } from './blocks.js';
import { Button } from './Button.js';
import { cx } from './cx.js';
import { useDashboard } from './dashboard-parts.js';
import { PAGE } from './layout-metrics.js';
import { Page } from './Page.js';
import { describeProblem } from './problems.js';

/** @typedef {import('react').ReactNode} ReactNode */
/** @typedef {import('./blocks.js').SectionSpec} BaseSpec */
/** @typedef {import('./InnerNav.js').InnerNavGroup} InnerNavGroup */
/** @typedef {import('./InnerNav.js').InnerNavItem} InnerNavItem */
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
 * A section of {@link SectionsPage}: a link of the inner navigation with its content, or with parts of its own. What
 * the open sub-page says about itself goes in the page's header: `info` (the old description, behind the (i)), `facts`,
 * `pills` and `actions`; `flush` gives its body no padding (a table uses all of it).
 * @typedef {Omit<BaseSpec, 'children'> & { info?: ReactNode, facts?: PageFact[], pills?: PageStatus[],
 *   actions?: PageActions, flush?: boolean, children?: Section[] }} Section
 */

/** The frame of the dashboard around a tab; none when a tab is drawn on its own. */
export const FrameContext = createContext(/** @type {Frame | null} */ (null));

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
 * body's, `withNav` draws the inner navigation's too) until the answer is there, the problem in the page (with Try again
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
					? { loading: true, ...(withNav ? { nav: { groups: [], value: '' } } : {}), ...(skeleton ? { skeleton } : {}) }
					: {})}
				{...(state.error ? { error: state.error } : {})}
			/>
		);
	return children(answer?.ok ? answer.data : null);
}

/** The address of a sub-page: its own `#id`. @param {string} id */
const hashOf = (id) => `#${encodeURIComponent(id)}`;

/**
 * One section as an item of the inner navigation: its badge is the count, its status the dot.
 * @param {Section} spec
 * @returns {InnerNavItem}
 */
const itemOf = (spec) => ({
	id: spec.id,
	label: spec.label,
	href: hashOf(spec.id),
	...(spec.icon ? { icon: spec.icon } : {}),
	...(spec.badge !== undefined && spec.badge !== null ? { count: /** @type {string | number} */ (spec.badge) } : {}),
	...(spec.status ? { dot: spec.status } : {}),
	...(spec.statusLabel ? { dotLabel: spec.statusLabel } : {}),
});

/**
 * The groups of the inner navigation of some sections: sections of one `group` are listed together under its heading,
 * a section with parts is a group of its own, headed by its label.
 * @param {Section[]} specs
 * @returns {InnerNavGroup[]}
 */
export function navGroupsOf(specs) {
	/** @type {InnerNavGroup[]} */
	const groups = [];
	/** @type {Map<string, InnerNavGroup>} */
	const named = new Map();
	for (const spec of specs) {
		if (spec.children?.length) {
			groups.push({ ...(typeof spec.label === 'string' ? { label: spec.label } : {}), items: spec.children.map(itemOf) });
			continue;
		}
		const name = spec.group ?? '';
		let group = named.get(name);
		if (!group) {
			group = { ...(name ? { label: name } : {}), items: [] };
			named.set(name, group);
			groups.push(group);
		}
		group.items.push(itemOf(spec));
	}
	return groups;
}

/**
 * The sections that open a view (their parts instead of themselves).
 * @param {Section[]} specs
 * @returns {Section[]}
 */
const leavesOf = (specs) => specs.flatMap((spec) => (spec.children?.length ? spec.children : [spec]));

/**
 * The page of a tab that has sub-pages: the header (the crumbs end in the open sub-page), the inner navigation, and the
 * open section as the body. One section needs no navigation. A sub-page is mounted when it is first opened and then
 * kept, hidden, so an edit in it is not lost.
 * @param {{ tab: string, sections: Section[], label?: string, initial?: string, searchFrom?: number,
 *   status?: PageStatus[], facts?: PageFact[], actions?: PageActions, info?: ReactNode, toolbar?: ReactNode,
 *   footer?: ReactNode, navFooter?: ReactNode, loading?: boolean, error?: import('react').ComponentProps<typeof Page>['error'],
 *   withNav?: boolean, empty?: ReactNode, children?: ReactNode }} props `tab`: the key of the tab (its crumb);
 *   `status`, `facts`, `actions` and `info` are the page's, used where the open sub-page names none of its own;
 *   `children` take the place of the sub-pages (a search result) while the navigation stays; `withNav`: draw the
 *   navigation's skeleton too while `loading`
 */
export function SectionsPage({
	tab,
	sections,
	label,
	initial,
	searchFrom,
	status,
	facts,
	actions,
	info,
	toolbar,
	footer,
	navFooter,
	loading = false,
	error,
	withNav = false,
	empty,
	children,
}) {
	const crumbs = useCrumbs();
	const { texts } = useDashboard();
	const leaves = leavesOf(sections);
	const [active, choose] = useHashSection(
		leaves.map((section) => section.id),
		initial,
	);
	const [seen, setSeen] = useState(() => new Set([active]));
	if (active && !seen.has(active)) setSeen(new Set([...seen, active]));
	const leaf = leaves.find((section) => section.id === active);
	const parent = sections.find((section) => section.children?.some((part) => part.id === active));
	const several = leaves.length > 1;
	const trail = crumbs(tab, ...(several && leaf ? [...(parent ? [{ label: parent.label }] : []), { label: leaf.label }] : []));
	const tabLabel = /** @type {Record<string, string>} */ (texts.tabs)[tab] ?? tab;
	const nav =
		several || (loading && withNav)
			? {
					groups: navGroupsOf(sections),
					value: active,
					onSelect: choose,
					label: label ?? tabLabel,
					...(searchFrom ? { searchFrom } : {}),
					...(navFooter ? { footer: navFooter } : {}),
				}
			: undefined;
	const flush = Boolean(leaf?.flush) && !children;
	const pills = leaf?.pills ?? status;
	const numbers = leaf?.facts ?? facts;
	const buttons = leaf?.actions ?? actions;
	const about = leaf?.info ?? info;
	return (
		<Page
			crumbs={trail}
			{...(pills ? { status: pills } : {})}
			{...(numbers ? { facts: numbers } : {})}
			{...(buttons ? { actions: buttons } : {})}
			{...(about ? { info: about } : {})}
			{...(nav ? { nav } : {})}
			{...(toolbar ? { toolbar } : {})}
			{...(footer ? { footer } : {})}
			loading={loading}
			{...(error ? { error } : {})}
			flush={flush}>
			{leaves.length === 0 ? (
				(empty ?? null)
			) : (
				<>
					{children}
					{leaves
						.filter((section) => section.id === active || seen.has(section.id))
						.map((section) => (
							<div
								key={section.id}
								id={`section-${section.id}`}
								hidden={section.id !== active || Boolean(children)}
								className={cx(section.flush ? PAGE.flush : CARD_FLOW, 'animate-ss-enter')}>
								{section.content}
							</div>
						))}
				</>
			)}
		</Page>
	);
}
