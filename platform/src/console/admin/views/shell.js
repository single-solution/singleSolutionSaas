'use client';
/**
 * The signed-in admin console frame (PLAN 0.6): the admin menu (Overview · Merchants · Products · Credits and billing ·
 * Admins · Settings · Activity) filtered by the admin's role, My account and sign out, with the Branding. While
 * Settings → Security → Require two-step for admins applies to this admin, the frame shows only the two-step setup.
 * @module
 */
import { usePathname } from 'next/navigation.js';
import { AppShell, Button, Callout, Card, Icon, PageHeader, ToastProvider } from '@ss/ui';
import { ADMIN, TWO_STEP } from '../../../texts/console.js';
import { Link } from '../../link.js';
import { accentStyle } from '../../views/brand.js';
import { TwoStepSetup } from '../../views/login-settings.js';
import { adminFetch } from '../client.js';
import { adminApi, adminRoutes } from '../paths.js';
import { RoleBadge, adminCan } from './common.js';

/**
 * The admin menu and the permission each entry needs (PLAN 0.6 Admin menu, 0.2 rights table).
 * @type {ReadonlyArray<{ href: string, label: string, icon: import('@ss/ui').IconName, permission: string, exact?: boolean }>}
 */
export const ADMIN_NAV = Object.freeze([
	{ href: adminRoutes.overview(), label: ADMIN.menu.overview, icon: 'grid', permission: 'overview.read', exact: true },
	{ href: adminRoutes.merchants(), label: ADMIN.menu.merchants, icon: 'users', permission: 'merchants.read' },
	{ href: adminRoutes.products(), label: ADMIN.menu.products, icon: 'box', permission: 'products.manage' },
	{ href: adminRoutes.finance(), label: ADMIN.menu.billing, icon: 'wallet', permission: 'billing.read' },
	{ href: adminRoutes.admins(), label: ADMIN.menu.admins, icon: 'key', permission: 'admins.manage' },
	{ href: adminRoutes.settings(), label: ADMIN.menu.settings, icon: 'sliders', permission: 'portal_settings.write' },
	{ href: adminRoutes.activity(), label: ADMIN.menu.activity, icon: 'shield', permission: 'activity.read' },
]);

/**
 * The menu entries the admin may use, with the current entry marked.
 * @param {any} admin
 * @param {string} pathname
 * @returns {import('@ss/ui').NavSection[]}
 */
export const adminSections = (admin, pathname) => [
	{
		label: '',
		items: ADMIN_NAV.filter((item) => adminCan(admin, item.permission)).map((item) => ({
			href: item.href,
			label: item.label,
			icon: item.icon,
			current: item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`),
		})),
	},
];

/**
 * @param {{ admin: any, twoStepRequired?: boolean, branding?: { name: string, accent: string }, children: import('react').ReactNode }} props
 */
export function AdminShell({ admin, twoStepRequired = false, branding, children }) {
	const pathname = usePathname() ?? '';
	const signOut = async () => {
		await adminFetch(adminApi.signOut(), { method: 'POST', redirectOn401: false });
		window.location.assign(adminRoutes.login());
	};
	return (
		<ToastProvider>
			<div style={accentStyle(branding?.accent)}>
				<AppShell
					brand={{ name: branding?.name ?? 'Single Solution', tagline: ADMIN.consoleTagline }}
					linkAs={Link}
					sections={twoStepRequired ? [] : adminSections(admin, pathname)}
					actions={
						<Button variant="ghost" size="sm" onClick={signOut} icon={<Icon name="logout" size={14} />}>
							<span className="hidden sm:inline">{ADMIN.signOut}</span>
							<span className="sr-only sm:hidden">{ADMIN.signOut}</span>
						</Button>
					}
					sidebarFooter={
						<div className="space-y-1.5 rounded-xl border border-line bg-surface-2 p-3 text-xs">
							<p className="truncate font-semibold text-fg">{admin?.name ?? admin?.email}</p>
							<RoleBadge role={admin?.role} />
							{twoStepRequired ? null : (
								<Link href={adminRoutes.account()} className="block font-semibold text-primary hover:underline">
									{ADMIN.menu.myAccount}
								</Link>
							)}
						</div>
					}>
					{twoStepRequired ? (
						<div className="mx-auto max-w-2xl space-y-6">
							<PageHeader title={TWO_STEP.requiredTitle} />
							<Callout tone="warning">{TWO_STEP.requiredHelp}</Callout>
							<Card>
								<TwoStepSetup onDone={() => window.location.assign(adminRoutes.overview())} />
							</Card>
						</div>
					) : (
						children
					)}
				</AppShell>
			</div>
		</ToastProvider>
	);
}
