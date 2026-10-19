'use client';
/**
 * The signed-in admin console frame (PLAN 0.6, premium layout 2026-10-16): the admin menu (Overview · Merchants ·
 * Products · Credits and billing · Admins · Settings · Activity, in three groups) filtered by the admin's role, the
 * account menu (My account, the theme, Sign out) at the bottom of the sidebar (in the header on phones), with the
 * Branding. While
 * Settings → Security → Require two-step for admins applies to this admin, the frame shows only the two-step setup.
 * @module
 */
import { usePathname } from 'next/navigation.js';
import { AppShell, Callout, Card, PageHeader, ToastProvider } from '@ss/ui';
import { useRouter } from 'next/navigation.js';
import { ADMIN, TWO_STEP } from '../../../texts/console.js';
import { NavLink } from '../../link.js';
import { accentStyle } from '../../views/brand.js';
import { TwoStepSetup } from '../../views/login-settings.js';
import { apiFetch } from '../../client.js';
import { adminApi, adminRoutes } from '../paths.js';
import { RoleBadge, adminCan } from './common.js';

/**
 * The admin menu, the group of each entry and the permission it needs (PLAN 0.6 Admin menu, 0.2 rights table).
 * @type {ReadonlyArray<{ href: string, label: string, group: 'operate' | 'money' | 'portal', icon: import('@ss/ui').IconName, kind: import('@ss/ui').Kind, permission: string, exact?: boolean }>}
 */
const ADMIN_NAV = Object.freeze([
	{
		href: adminRoutes.overview(),
		label: ADMIN.menu.overview,
		group: 'operate',
		kind: 'overview',
		icon: 'home',
		permission: 'overview.read',
		exact: true,
	},
	{
		href: adminRoutes.merchants(),
		label: ADMIN.menu.merchants,
		group: 'operate',
		kind: 'merchant',
		icon: 'users',
		permission: 'merchants.read',
	},
	{
		href: adminRoutes.products(),
		label: ADMIN.menu.products,
		group: 'operate',
		kind: 'product',
		icon: 'box',
		permission: 'products.manage',
	},
	{
		href: adminRoutes.finance(),
		label: ADMIN.menu.billing,
		group: 'money',
		kind: 'credit',
		icon: 'wallet',
		permission: 'billing.read',
	},
	{
		href: adminRoutes.admins(),
		label: ADMIN.menu.admins,
		group: 'portal',
		kind: 'admin',
		icon: 'shield',
		permission: 'admins.manage',
	},
	{
		href: adminRoutes.settings(),
		label: ADMIN.menu.settings,
		group: 'portal',
		kind: 'settings',
		icon: 'sliders',
		permission: 'portal_settings.write',
	},
	{
		href: adminRoutes.activity(),
		label: ADMIN.menu.activity,
		group: 'portal',
		kind: 'activity',
		icon: 'activity',
		permission: 'activity.read',
	},
]);

/**
 * The menu entries the admin may use, with the current entry marked.
 * @param {any} admin
 * @param {string} pathname
 * @returns {import('@ss/ui').NavSection[]}
 */
export const adminSections = (admin, pathname) =>
	/** @type {const} */ (['operate', 'money', 'portal'])
		.map((group) => ({
			label: ADMIN.menuGroups[group],
			items: ADMIN_NAV.filter((item) => item.group === group && adminCan(admin, item.permission)).map((item) => ({
				href: item.href,
				label: item.label,
				icon: item.icon,
				kind: item.kind,
				current: item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`),
			})),
		}))
		.filter((section) => section.items.length > 0);

/**
 * @param {{ admin: any, twoStepRequired?: boolean, branding: { name: string, accent: string }, children: import('react').ReactNode }} props
 */
export function AdminShell({ admin, twoStepRequired = false, branding, children }) {
	const pathname = usePathname() ?? '';
	const router = useRouter();
	const signOut = async () => {
		await apiFetch(adminApi.signOut(), { method: 'POST', redirectOn401: false });
		window.location.assign(adminRoutes.login());
	};
	const name = admin?.name ?? admin?.email ?? '';
	/** @type {import('@ss/ui').MenuItem[]} */
	const accountItems = [
		...(twoStepRequired ? [] : [{ label: ADMIN.menu.myAccount, onSelect: () => router.push(adminRoutes.account()) }]),
		{ label: ADMIN.signOut, onSelect: () => void signOut(), danger: true },
	];
	return (
		<ToastProvider>
			<div style={accentStyle(branding.accent)}>
				<AppShell
					brand={{ name: branding.name, tagline: ADMIN.consoleTagline }}
					linkAs={NavLink}
					sections={twoStepRequired ? [] : adminSections(admin, pathname)}
					scrollKey={pathname}
					account={{
						name,
						...(admin?.email ? { email: admin.email } : {}),
						items: accountItems,
						label: ADMIN.accountMenu,
						...(admin?.role ? { role: <RoleBadge role={admin.role} /> } : {}),
					}}>
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
