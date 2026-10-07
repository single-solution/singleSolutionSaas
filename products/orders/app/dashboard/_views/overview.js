/**
 * Dashboard overview (SSO). The Portal sends the browser to app-kit's `GET /sso?launch=<jwt>`, which verifies the launch
 * (signature, issuer, audience, kind/scope, single use), stores a session and sets the HttpOnly `ss_session` cookie,
 * then redirects here. Supports merchant, demo (sandbox data), admin(scope), impersonate (audit banner), partner and
 * developer launches. Revenue counts revenue statuses only, net of refunds.
 */
import { createElement as h } from 'react';
import { redirect } from 'next/navigation.js';
import { Card, Stat } from '@ss/ui';
import { formatMoney } from '../../../core/money.js';
import { dashboardContext } from '../../_lib/dashboard.js';
import { ActionForm } from '../_components/ActionForm.js';
import { Shell, t } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Overview({ searchParams }) {
	const { launch, website } = await searchParams;
	if (typeof launch === 'string') redirect(`/sso?launch=${encodeURIComponent(launch)}`);
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'overview' });
	const stats = await context.data.stats();
	const { labels } = context.data;
	const format = new Intl.NumberFormat(labels.lang);
	const cards = [
		[t('dashboard.kpi.orders'), format.format(stats.orders)],
		[t('dashboard.kpi.open'), format.format(stats.open)],
		[t('dashboard.kpi.review'), format.format(stats.review)],
		...context.data.settings.matrix.statuses.map((s) => [labels.statusLabel(s.key), format.format(stats.byStatus[s.key] ?? 0)]),
		...Object.entries(stats.byCurrency).map(([currency, sums]) => [
			t('dashboard.kpi.revenue', { currency }),
			formatMoney(/** @type {any} */ (sums).revenue, currency, labels.lang),
		]),
	];
	return h(
		Shell,
		{ context, active: 'overview' },
		h(
			Card,
			{ title: t('dashboard.nav.overview'), subtitle: t('dashboard.revenue_note') },
			h(
				'div',
				{ className: 'grid grid-cols-2 gap-4 sm:grid-cols-4' },
				cards.map(([label, value]) => h(Stat, { key: String(label), label: String(label), value: String(value) })),
			),
		),
		context.data.canWrite && context.data.websiteId
			? h(
					Card,
					{ title: t('dashboard.due.title'), subtitle: t('dashboard.due.help') },
					h(ActionForm, {
						path: '/v1/dashboard/due:run',
						websiteId: context.data.websiteId,
						fields: [],
						submit: t('dashboard.due.run'),
					}),
				)
			: null,
	);
}
