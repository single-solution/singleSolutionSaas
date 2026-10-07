/**
 * Dashboard overview (SSO). The Portal sends the browser to app-kit's `GET /sso?launch=<jwt>`, which verifies the launch
 * (signature, issuer, audience, kind/scope, single use), stores a session and sets the HttpOnly `ss_session` cookie,
 * then redirects here. Supports merchant and admin (staff) launches.
 */
import { createElement as h } from 'react';
import { redirect } from 'next/navigation.js';
import { Card, Stat } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { DueWorkButton } from '../_components/DueWorkButton.js';
import { Shell, t } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Overview({ searchParams }) {
	const { launch, website } = await searchParams;
	if (typeof launch === 'string') redirect(`/sso?launch=${encodeURIComponent(launch)}`);
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'overview' });
	const stats = await context.data.stats();
	const format = new Intl.NumberFormat(t('catalog.locale'));
	const statuses = context.data.settings.items.statuses;
	const cards = [
		['dashboard.kpi.items', `${format.format(stats.items.total)} / ${format.format(stats.items.limit)}`],
		...statuses.map((/** @type {any} */ s) => [s.label, format.format(stats.items.byStatus[s.key] ?? 0)]),
		['dashboard.kpi.out_of_stock', format.format(stats.items.outOfStock)],
		['dashboard.kpi.low_stock', format.format(stats.items.lowStock)],
		['dashboard.kpi.collections', format.format(stats.collections)],
		['dashboard.kpi.brands', format.format(stats.brands)],
		['dashboard.kpi.attributes', format.format(stats.attributes)],
		['dashboard.kpi.pending_events', format.format(stats.pendingEvents)],
	];
	return h(
		Shell,
		{ context, active: 'overview' },
		h(
			Card,
			{
				title: t('dashboard.nav.overview'),
				subtitle: stats.currency ? t('dashboard.currency', { currency: stats.currency }) : t('dashboard.no_currency'),
			},
			h(
				'div',
				{ className: 'grid grid-cols-2 gap-4 sm:grid-cols-4' },
				cards.map(([label, value]) =>
					h(Stat, {
						key: String(label),
						label: String(label).startsWith('dashboard.') ? t(String(label)) : String(label),
						value: String(value),
					}),
				),
			),
		),
		!context.data.canWrite
			? null
			: h(
					Card,
					{
						title: t('dashboard.due.title'),
						actions: h(DueWorkButton, { websiteId: context.data.websiteId }),
					},
					h('p', { className: 'text-sm text-muted' }, t('dashboard.due.help')),
				),
	);
}
