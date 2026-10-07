/**
 * Dashboard overview (SSO). The Portal sends the browser to app-kit's `GET /sso?launch=<jwt>`, which verifies the launch
 * (signature, issuer, audience, kind/scope, single use), stores a session and sets the HttpOnly `ss_session` cookie,
 * then redirects here. Supports merchant and admin (staff) launches.
 */
import { createElement as h } from 'react';
import { redirect } from 'next/navigation.js';
import { Card, EmptyState, Stat } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { DataTable, Shell, t } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Overview({ searchParams }) {
	const { launch, website } = await searchParams;
	if (typeof launch === 'string') redirect(`/sso?launch=${encodeURIComponent(launch)}`);
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'overview' });
	const { stats, topItems } = await context.data.overview();
	const format = new Intl.NumberFormat(t('wishlist.locale'));
	const kpis = [
		[t('dashboard.kpi.lists'), stats.lists],
		[t('dashboard.kpi.customer_lists'), stats.customerLists],
		[t('dashboard.kpi.guest_lists'), stats.guestLists],
		[t('dashboard.kpi.items'), stats.items],
		[t('dashboard.kpi.opted_in'), stats.optedIn],
		[t('dashboard.kpi.shared'), stats.shared],
	];
	return h(
		Shell,
		{ context, active: 'overview' },
		h(
			Card,
			{ title: t('dashboard.nav.overview') },
			h(
				'div',
				{ className: 'grid grid-cols-2 gap-4 sm:grid-cols-3' },
				kpis.map(([label, value]) => h(Stat, { key: String(label), label, value: format.format(Number(value)) })),
			),
		),
		h(
			Card,
			{ title: t('dashboard.top_items') },
			topItems.length === 0
				? h(EmptyState, { title: t('dashboard.empty.items'), compact: true })
				: h(DataTable, {
						caption: t('dashboard.top_items'),
						columns: [t('dashboard.column.item'), t('dashboard.column.saves')],
						rows: topItems.map((row) => ({ key: row.itemId, cells: [row.title ?? row.itemId, format.format(row.saves)] })),
					}),
		),
	);
}
