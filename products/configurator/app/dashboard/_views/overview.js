/**
 * Dashboard overview (SSO). The Portal sends the browser to app-kit's `GET /sso?launch=<jwt>`, which verifies the launch
 * (signature, issuer, audience, kind/scope, single use), stores a session and sets the HttpOnly `ss_session` cookie,
 * then redirects here. Supports merchant, demo (sample configurators), admin(scope), impersonate (audit banner), partner
 * and developer launches.
 */
import { createElement as h } from 'react';
import { redirect } from 'next/navigation.js';
import { Badge, Card, EmptyState, Stat } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t, withWebsite } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Overview({ searchParams }) {
	const { launch, website } = await searchParams;
	if (typeof launch === 'string') redirect(`/sso?launch=${encodeURIComponent(launch)}`);
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'overview' });
	const [kpis, list] = await Promise.all([context.data.overview(), context.data.list()]);
	const format = new Intl.NumberFormat(t('widget.locale'));
	const stats = [
		['dashboard.kpi.published', kpis.configurators.published ?? 0],
		['dashboard.kpi.draft', kpis.configurators.draft ?? 0],
		['dashboard.kpi.archived', kpis.configurators.archived ?? 0],
		['dashboard.kpi.items', kpis.catalogItems],
	];
	const tone = (/** @type {string} */ status) => (status === 'published' ? 'success' : status === 'draft' ? 'info' : 'neutral');
	return h(
		Shell,
		{ context, active: 'overview' },
		h(
			Card,
			{ title: t('dashboard.nav.overview') },
			h(
				'div',
				{ className: 'grid grid-cols-2 gap-4 sm:grid-cols-4' },
				stats.map(([label, value]) =>
					h(Stat, { key: String(label), label: t(String(label)), value: format.format(Number(value)) }),
				),
			),
		),
		h(
			Card,
			{ title: t('dashboard.configurators.title') },
			list.length === 0
				? h(EmptyState, { title: t('dashboard.configurators.empty'), compact: true })
				: h(
						'table',
						{ className: 'w-full text-sm' },
						h(
							'thead',
							null,
							h(
								'tr',
								null,
								[
									'dashboard.column.name',
									'dashboard.column.key',
									'dashboard.column.status',
									'dashboard.column.groups',
									'dashboard.column.version',
								].map((label) =>
									h(
										'th',
										{ key: label, scope: 'col', className: 'px-2 py-1 text-left text-xs uppercase text-muted' },
										t(label),
									),
								),
							),
						),
						h(
							'tbody',
							null,
							list.map((row) =>
								h(
									'tr',
									{ key: row.id, className: 'border-t border-line' },
									h(
										'td',
										{ className: 'px-2 py-1' },
										h(
											'a',
											{
												href: withWebsite(context, `/dashboard/configurators/${encodeURIComponent(row.id)}`),
												className: 'font-semibold underline',
											},
											row.name,
										),
									),
									h('td', { className: 'px-2 py-1 font-mono' }, row.key ?? '—'),
									h(
										'td',
										{ className: 'px-2 py-1' },
										h(Badge, { tone: tone(row.status), children: t(`dashboard.status.${row.status}`) }),
									),
									h('td', { className: 'px-2 py-1' }, row.groups.join(t('widget.list.separator'))),
									h('td', { className: 'px-2 py-1' }, String(row.version)),
								),
							),
						),
					),
		),
	);
}
