/**
 * Dashboard overview (SSO). The Portal sends the browser to app-kit's `GET /sso?launch=<jwt>`, which verifies the launch
 * and sets the HttpOnly `ss_session` cookie, then redirects here. Supports merchant and admin (staff) launches.
 */
import { createElement as h } from 'react';
import { redirect } from 'next/navigation.js';
import { Card, Stat } from '@ss/ui';
import { formatMoney } from '../../../core/money.js';
import { dashboardContext } from '../../_lib/dashboard.js';
import { ExpiryRun } from '../_components/ExpiryRun.js';
import { Shell, t } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Overview({ searchParams }) {
	const { launch, website } = await searchParams;
	if (typeof launch === 'string') redirect(`/sso?launch=${encodeURIComponent(launch)}`);
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'overview' });
	const kpis = await context.data.overview();
	const locale = t('checkout.locale');
	const format = new Intl.NumberFormat(locale);
	/** @type {Array<[string, string]>} */
	const stats = [
		[t('dashboard.kpi.orders'), format.format(kpis.orders)],
		[t('dashboard.kpi.open'), format.format(kpis.open)],
		...kpis.currencies.map(
			(row) =>
				/** @type {[string, string]} */ ([
					t('dashboard.kpi.revenue', { currency: row.currency }),
					formatMoney(row.revenue, row.currency, locale),
				]),
		),
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
				stats.map(([label, value]) => h(Stat, { key: label, label, value })),
			),
		),
		context.data.canWrite && context.data.websiteId
			? h(Card, { title: t('dashboard.expiry.title') }, h(ExpiryRun, { websiteId: context.data.websiteId }))
			: null,
	);
}
