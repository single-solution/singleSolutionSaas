/**
 * Dashboard overview (SSO). The Portal sends the browser to app-kit's `GET /sso?launch=<jwt>`, which verifies the launch
 * (signature, issuer, audience, kind/scope, single use), stores a session and sets the HttpOnly `ss_session` cookie,
 * then redirects here. Supports merchant, demo (sandbox data), admin(scope), impersonate (audit banner), partner and
 * developer launches.
 */
import { createElement as h } from 'react';
import { redirect } from 'next/navigation.js';
import { Card, Stat, Table } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, swatch, t } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Overview({ searchParams }) {
	const { launch, website } = await searchParams;
	if (typeof launch === 'string') redirect(`/sso?launch=${encodeURIComponent(launch)}`);
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'overview' });
	const kpis = await context.data.overview();
	const format = new Intl.NumberFormat(t('grades.locale'));
	const units = kpis.tiers.reduce((sum, tier) => sum + tier.units, kpis.ungradedUnits);
	const stats = [
		['dashboard.kpi.graded_items', kpis.items.graded],
		['dashboard.kpi.catalog_items', kpis.items.known],
		['dashboard.kpi.units', units],
		['dashboard.kpi.ungraded_units', kpis.ungradedUnits],
		['dashboard.kpi.inspections_draft', kpis.inspections.draft],
		['dashboard.kpi.inspections_completed', kpis.inspections.completed],
	];
	const byKey = new Map(context.data.settings.tiers.map((tier) => [tier.key, tier]));
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
			{ title: t('dashboard.overview.by_tier') },
			h(Table, {
				caption: t('dashboard.overview.by_tier'),
				rowKey: (/** @type {any} */ row) => row.key,
				rows: kpis.tiers,
				columns: [
					{
						key: 'label',
						header: t('dashboard.tiers.label'),
						rowHeader: true,
						render: (/** @type {any} */ row) => {
							const tier = byKey.get(row.key);
							return h('span', { className: 'inline-flex items-center gap-2' }, tier ? swatch(tier) : null, row.label);
						},
					},
					{ key: 'assignments', header: t('dashboard.overview.assignments'), align: 'right' },
					{ key: 'units', header: t('dashboard.overview.units'), align: 'right' },
				],
			}),
		),
	);
}
