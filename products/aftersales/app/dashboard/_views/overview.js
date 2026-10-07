/**
 * Dashboard overview (SSO). The Portal sends the browser to app-kit's `GET /sso?launch=<jwt>`, which verifies the launch
 * (signature, issuer, audience, kind/scope, single use), stores a session and sets the HttpOnly `ss_session` cookie,
 * then redirects here. Supports merchant, demo (sandbox data), admin(scope), impersonate (audit banner), partner and
 * developer launches.
 */
import { createElement as h } from 'react';
import { redirect } from 'next/navigation.js';
import { Card, Stat } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Overview({ searchParams }) {
	const { launch, website } = await searchParams;
	if (typeof launch === 'string') redirect(`/sso?launch=${encodeURIComponent(launch)}`);
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'overview' });
	const kpis = await context.data.overview();
	const format = new Intl.NumberFormat(context.data.settings.language ?? undefined);
	const stats = [
		['dashboard.kpi.open', kpis.byKind.open ?? 0],
		['dashboard.kpi.overdue', kpis.overdue],
		['dashboard.kpi.resolved', kpis.byKind.resolved ?? 0],
		['dashboard.kpi.rejected', kpis.byKind.rejected ?? 0],
		['dashboard.kpi.closed', kpis.byKind.closed ?? 0],
	];
	const { statuses } = context.data.settings.vocabulary;
	return h(
		Shell,
		{ context, active: 'overview' },
		h(
			Card,
			{ title: t('dashboard.nav.overview') },
			h(
				'div',
				{ className: 'grid grid-cols-2 gap-4 sm:grid-cols-3' },
				stats.map(([label, value]) =>
					h(Stat, { key: String(label), label: t(String(label)), value: format.format(Number(value)) }),
				),
			),
		),
		h(
			Card,
			{ title: t('dashboard.overview.by_status') },
			h(
				'ul',
				{ className: 'space-y-1' },
				statuses.map((status) =>
					h('li', { key: status.key }, `${status.label}: ${format.format(kpis.byStatus[status.key] ?? 0)}`),
				),
			),
		),
		Object.keys(kpis.refunded).length > 0
			? h(
					Card,
					{ title: t('dashboard.overview.refunded') },
					h(
						'ul',
						null,
						Object.entries(kpis.refunded).map(([currency, amount]) =>
							h('li', { key: currency }, t('dashboard.money', { amount: format.format(amount), currency })),
						),
					),
				)
			: null,
	);
}
