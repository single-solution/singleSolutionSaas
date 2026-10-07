'use client';
/**
 * The signed-in Admin Console frame: navigation filtered by the staff member's permissions, the staff identity,
 * Account settings and sign out. Every staff action is audited; the frame says so.
 * @module
 */
import { usePathname } from 'next/navigation.js';
import { AppShell, Badge, Button, Icon, ToastProvider } from '@ss/ui';
import { Link } from '../../link.js';
import { adminFetch } from '../client.js';
import { adminApi, adminRoutes } from '../paths.js';
import { Roles, staffCan } from './common.js';

/**
 * Navigation entries and the permission each needs.
 * @type {ReadonlyArray<{ label: string, items: ReadonlyArray<{ href: string, label: string, icon: import('@ss/ui').IconName,
 *   permission: string, exact?: boolean }> }>}
 */
export const ADMIN_NAV = Object.freeze([
	{
		label: 'Customers',
		items: [
			{ href: '/admin/merchants', label: 'Merchants', icon: 'users', permission: 'platform.merchants.read' },
			{ href: '/admin/websites', label: 'Websites', icon: 'globe', permission: 'platform.merchants.read' },
			{ href: '/admin/subscriptions', label: 'Subscriptions', icon: 'sliders', permission: 'config.read' },
		],
	},
	{
		label: 'Products',
		items: [{ href: '/admin/apps', label: 'Apps', icon: 'box', permission: 'platform.apps.read' }],
	},
	{
		label: 'Money',
		items: [{ href: adminRoutes.finance(), label: 'Finance', icon: 'wallet', permission: 'platform.finance.read' }],
	},
	{
		label: 'Operations',
		items: [
			{ href: '/admin/connectors', label: 'Connectors', icon: 'plug', permission: 'platform.merchants.read' },
			{ href: '/admin/audit', label: 'Audit log', icon: 'shield', permission: 'platform.audit.read' },
		],
	},
	{
		label: 'Team',
		items: [
			{ href: adminRoutes.staff(), label: 'Staff', icon: 'key', permission: 'platform.staff.manage' },
			{ href: adminRoutes.settings(), label: 'Settings', icon: 'sliders', permission: 'platform.settings.write' },
		],
	},
]);

/**
 * Navigation sections the staff member may see, with the current entry marked.
 * @param {any} staff
 * @param {string} pathname
 * @returns {import('@ss/ui').NavSection[]}
 */
export const adminSections = (staff, pathname) =>
	ADMIN_NAV.map((section) => ({
		label: section.label,
		items: section.items
			.filter((item) => staffCan(staff, item.permission))
			.map((item) => ({
				href: item.href,
				label: item.label,
				icon: item.icon,
				current: item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`),
			})),
	})).filter((section) => section.items.length > 0);

/**
 * @param {{ staff: any, children: import('react').ReactNode }} props
 */
export function AdminShell({ staff, children }) {
	const pathname = usePathname() ?? '';
	const signOut = async () => {
		await adminFetch(adminApi.logout(), { method: 'POST', redirectOn401: false });
		window.location.assign(adminRoutes.login());
	};
	return (
		<ToastProvider>
			<AppShell
				brand={{ name: 'Single Solution', tagline: 'Admin console' }}
				linkAs={Link}
				sections={adminSections(staff, pathname)}
				topbar={
					<span className="flex min-w-0 items-center gap-2">
						<Badge tone="warning" dot>
							Staff
						</Badge>
						<span className="hidden truncate text-sm text-muted sm:inline">Every action here is audited.</span>
					</span>
				}
				actions={
					<Button variant="ghost" size="sm" onClick={signOut} icon={<Icon name="logout" size={14} />}>
						<span className="hidden sm:inline">Sign out</span>
						<span className="sr-only sm:hidden">Sign out</span>
					</Button>
				}
				sidebarFooter={
					<div className="space-y-1.5 rounded-xl border border-line bg-surface-2 p-3 text-xs">
						<p className="truncate font-semibold text-fg">{staff?.email ?? staff?.login}</p>
						<Roles roles={staff?.roles ?? []} />
						<Link href={adminRoutes.account()} className="block font-semibold text-primary hover:underline">
							Account settings
						</Link>
					</div>
				}>
				{children}
			</AppShell>
		</ToastProvider>
	);
}
