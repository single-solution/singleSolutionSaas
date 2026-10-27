'use client';
/**
 * The loading skeleton of both consoles (each console's `loading.js`): shown at once when a link is clicked, while the
 * next page is on the way, with the progress bar on top. It is the `@ss/ui` skeleton of the layout the page will have
 * (layout contract 2026-10-17): the same header, inner navigation, toolbar, body and footer areas at the same sizes, so
 * nothing jumps when the page arrives. A list is a toolbar over a table with a footer; a page with parts has its
 * inner navigation; the Overview is tiles and cards; the public account pages are a sign-in card. A page that is
 * one of the menu's own entries shows its title already.
 * @module
 */
import { usePathname } from 'next/navigation.js';
import { PageSkeleton, RouteProgress, RowListSkeleton, SettingsCardSkeleton, SkeletonBlock, StatGridSkeleton, cx } from '@ss/ui';
import { ADMIN, CONSOLE, MERCHANT } from '../../texts/console.js';
import { PUBLIC_PATHS } from '../paths.js';
import { Link } from '../link.js';

/** @typedef {'admin' | 'merchant'} Area */

/**
 * The layout of a page, as far as its skeleton needs it.
 * @typedef {object} Shape
 * @property {'table' | 'cards' | 'overview'} body what the body holds
 * @property {boolean} [nav] the page has an inner navigation
 * @property {boolean} [list] a toolbar above the body and a pagination below it (the body is a table)
 * @property {number} [columns] the table's columns
 * @property {string} [title] the title, for a page that is a menu entry of its own
 */

/**
 * The shape of the page a path opens.
 * @param {Area} area
 * @param {string} pathname
 * @returns {Shape}
 */
export const shapeOf = (area, pathname) => {
	const [first, second, third, fourth] = pathname
		.split('/')
		.filter(Boolean)
		.slice(area === 'admin' ? 1 : 0);
	if (area === 'admin') {
		if (!first) return { body: 'overview', title: ADMIN.menu.overview };
		const menu = /** @type {Record<string, string>} */ (ADMIN.menu);
		if (first === 'merchants' && !second) return { body: 'table', list: true, columns: 7, title: menu.merchants ?? '' };
		if (first === 'merchants')
			// the bare address of a merchant is its Websites table, a website is a page with parts
			return third === 'websites' && fourth
				? { body: 'cards', nav: true }
				: { body: 'table', nav: true, list: true, columns: 5 };
		if (first === 'products' && !second) return { body: 'table', list: true, columns: 5, title: menu.products ?? '' };
		if (first === 'products') return { body: 'table', nav: true, list: true, columns: 4 };
		if (first === 'admins' && !second) return { body: 'table', list: true, columns: 6, title: menu.admins ?? '' };
		if (first === 'activity') return { body: 'table', list: true, columns: 5, title: menu.activity ?? '' };
		if (first === 'finance') return { body: 'table', nav: true, list: true, columns: 6, title: menu.billing ?? '' };
		if (first === 'settings') return { body: 'cards', nav: true, title: menu.settings ?? '' };
		return { body: 'cards', nav: true };
	}
	if (first === 'overview') return { body: 'overview', title: MERCHANT.menu.overview };
	if (first === 'websites' && !second) return { body: 'table', list: true, columns: 5, title: MERCHANT.menu.websites };
	if (first === 'credits' && second === 'receipts') return { body: 'table', nav: true, list: true, columns: 5 };
	return { body: 'cards', nav: true };
};

/** The sign-in card's placeholder. */
function AuthSkeleton() {
	return (
		<div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
			<SkeletonBlock className="mx-auto h-9 w-9 rounded-control [--ss-skeleton:var(--ss-surface-3)]" />
			<div className={cx('space-y-3 rounded-card border border-line bg-surface p-5')}>
				<SkeletonBlock className="h-5 w-40" />
				<SkeletonBlock className="h-4 w-full" />
				<SkeletonBlock className="h-4 w-full" />
				<SkeletonBlock className="h-4 w-2/3" />
			</div>
		</div>
	);
}

/**
 * @param {{ area: Area }} props
 */
export function ConsoleLoading({ area }) {
	const pathname = usePathname() ?? '';
	if (area === 'merchant' && PUBLIC_PATHS.includes(pathname))
		return (
			<div aria-busy="true">
				<span role="status" className="sr-only">
					{CONSOLE.loading}
				</span>
				<RouteProgress />
				<AuthSkeleton />
			</div>
		);
	const shape = shapeOf(area, pathname);
	const table = shape.body === 'table';
	return (
		<>
			<RouteProgress />
			<PageSkeleton
				linkAs={Link}
				label={CONSOLE.loading}
				{...(shape.title ? { crumbs: [{ label: shape.title }] } : {})}
				nav={Boolean(shape.nav)}
				toolbar={Boolean(shape.list)}
				footer={Boolean(shape.list)}
				flush={table}>
				{table ? (
					<RowListSkeleton rows={shape.columns ?? 5} />
				) : shape.body === 'overview' ? (
					<>
						<StatGridSkeleton />
						<SettingsCardSkeleton rows={4} />
					</>
				) : undefined}
			</PageSkeleton>
		</>
	);
}
