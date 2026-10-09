'use client';
/**
 * The loading skeleton of both consoles (each console's `loading.js`): shown at once when a link is clicked, while the
 * next page is on the way, with the progress bar on top. It takes the shape of the page to come: a list-and-detail
 * screen keeps its list in place (the picked row marked) and shows a skeleton for the detail only; other pages show a
 * page skeleton; the public account pages a sign-in card.
 * @module
 */
import { usePathname } from 'next/navigation.js';
import { useEffect } from 'react';
import { RouteProgress, STAT_GRID, SkeletonBlock, cx } from '@ss/ui';
import { ADMIN, CONSOLE, MERCHANT } from '../../texts/console.js';
import { PUBLIC_PATHS } from '../paths.js';
import { ListDetail } from './common.js';
import { listWasPlaceholder, useRememberedList } from './screen-memory.js';

/** @typedef {'admin' | 'merchant'} Area */

/** The list-and-detail screens of each console: the section name, its path and its title. */
const SCREENS = /** @type {Record<Area, Array<{ section: string, base: string, title: string }>>} */ ({
	admin: [
		{ section: 'admin/merchants', base: '/admin/merchants', title: ADMIN.merchantsTitle },
		{ section: 'admin/products', base: '/admin/products', title: ADMIN.productsTitle },
		{ section: 'admin/admins', base: '/admin/admins', title: ADMIN.adminsTitle },
	],
	merchant: [{ section: 'websites', base: '/websites', title: MERCHANT.websitesTitle }],
});

/**
 * The list-and-detail screen a path opens, if any.
 * @param {Area} area
 * @param {string} pathname
 */
export const screenOf = (area, pathname) =>
	SCREENS[area].find((screen) => pathname === screen.base || pathname.startsWith(`${screen.base}/`)) ?? null;

/** Placeholder blocks that sit on the page canvas (titles, buttons) take the stronger tint. */
const ON_CANVAS = '[--ss-skeleton:var(--ss-surface-3)]';

/**
 * A card with placeholder lines.
 * @param {{ lines?: number, className?: string }} props
 */
function CardSkeleton({ lines = 3, className }) {
	return (
		<div className={cx('space-y-3 rounded-card bg-surface p-6', className)}>
			<SkeletonBlock className="h-5 w-40" />
			{Array.from({ length: lines }, (_, i) => (
				<SkeletonBlock key={i} className={cx('h-4', i === lines - 1 ? 'w-2/3' : 'w-full')} />
			))}
		</div>
	);
}

/** A list pane's placeholder: the title, the search box and rows. */
function ListSkeleton() {
	return (
		<div className="space-y-3 rounded-card bg-surface p-3 sm:p-4">
			<SkeletonBlock className="mx-1 mt-1 h-7 w-32" />
			<SkeletonBlock className="mx-1 h-10 rounded-xl" />
			<div className="space-y-2 pt-1">
				{[0, 1, 2, 3, 4, 5].map((i) => (
					<SkeletonBlock key={i} className="h-12 rounded-xl" />
				))}
			</div>
		</div>
	);
}

/** A detail's placeholder: the header with its actions and cards. */
function DetailSkeleton() {
	return (
		<>
			<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
				<SkeletonBlock className={cx('h-8 w-56 max-w-full', ON_CANVAS)} />
				<div className="flex gap-2">
					<SkeletonBlock className={cx('h-10 w-28 rounded-xl', ON_CANVAS)} />
					<SkeletonBlock className={cx('h-10 w-10 rounded-xl', ON_CANVAS)} />
				</div>
			</div>
			<div className="@container">
				<div className="grid gap-5 @md:grid-cols-2">
					<CardSkeleton lines={2} />
					<CardSkeleton lines={2} />
				</div>
			</div>
			<CardSkeleton lines={4} />
		</>
	);
}

/** A page's placeholder: the title, three tiles and a section. */
function PageSkeleton() {
	return (
		<div className="space-y-8">
			<SkeletonBlock className={cx('h-8 w-48', ON_CANVAS)} />
			<div className="@container">
				<div className={STAT_GRID}>
					{[0, 1, 2].map((i) => (
						<CardSkeleton key={i} lines={1} />
					))}
				</div>
			</div>
			<CardSkeleton lines={5} />
		</div>
	);
}

/** The sign-in card's placeholder. */
function AuthSkeleton() {
	return (
		<div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
			<SkeletonBlock className={cx('mx-auto h-10 w-10 rounded-xl', ON_CANVAS)} />
			<CardSkeleton lines={4} />
		</div>
	);
}

/**
 * @param {{ area: Area }} props
 */
export function ConsoleLoading({ area }) {
	const pathname = usePathname() ?? '';
	const screen = screenOf(area, pathname);
	const kept = useRememberedList(screen?.section ?? null);
	const section = screen?.section ?? null;
	useEffect(() => {
		if (section) listWasPlaceholder(section, kept === null);
	}, [section, kept]);
	/** @type {import('react').ReactNode} */
	let body;
	if (area === 'merchant' && PUBLIC_PATHS.includes(pathname)) body = <AuthSkeleton />;
	else if (screen) {
		const selected = pathname !== screen.base;
		body = (
			<ListDetail
				label={screen.title}
				section={screen.section}
				remember={false}
				going={pathname}
				auto={!selected}
				back={{ href: screen.base, label: screen.title }}
				list={kept ? kept.list : <ListSkeleton />}
				detail={<DetailSkeleton />}
				empty={null}
			/>
		);
	} else body = <PageSkeleton />;
	return (
		<div aria-busy="true">
			<span role="status" className="sr-only">
				{CONSOLE.loading}
			</span>
			<RouteProgress />
			{body}
		</div>
	);
}
