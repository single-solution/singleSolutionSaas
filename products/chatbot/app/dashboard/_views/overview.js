/**
 * Dashboard overview (SSO). The Portal sends the browser to app-kit's `GET /sso?launch=<jwt>`, which verifies the launch
 * (signature, issuer, audience, kind/scope, single use), stores a session and sets the HttpOnly `ss_session` cookie,
 * then redirects here. Supports merchant and admin (staff) launches.
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
	const format = new Intl.NumberFormat(t('window.locale'));
	const percent = new Intl.NumberFormat(t('window.locale'), { style: 'percent', maximumFractionDigits: 0 });
	const stats = [
		['dashboard.kpi.open', format.format(kpis.open)],
		['dashboard.kpi.waiting', format.format(kpis.waiting)],
		['dashboard.kpi.today', format.format(kpis.recent)],
		['dashboard.kpi.breaches', format.format(kpis.breaches)],
		['dashboard.kpi.tokens', format.format(kpis.tokens)],
		['dashboard.kpi.csat', kpis.csat.csat === null ? '—' : percent.format(kpis.csat.csat)],
		['dashboard.kpi.leads', format.format(kpis.leads)],
		['dashboard.kpi.knowledge', format.format(kpis.chunks)],
	];
	return h(
		Shell,
		{ context, active: 'overview' },
		h(
			Card,
			{ title: t('dashboard.nav.overview') },
			h(
				'div',
				{ className: 'grid grid-cols-2 gap-4 sm:grid-cols-4' },
				stats.map(([label, value]) => h(Stat, { key: String(label), label: t(String(label)), value: String(value) })),
			),
		),
	);
}
