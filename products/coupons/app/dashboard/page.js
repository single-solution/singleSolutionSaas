/**
 * Dashboard overview (SSO). The Portal sends the browser to app-kit's `GET /sso?launch=<jwt>`, which verifies the launch
 * (signature, issuer, audience, kind/scope, single use), stores a session and sets the HttpOnly `ss_session` cookie,
 * then redirects here. Supports merchant, demo (sandbox data), admin(scope), impersonate (audit banner), partner and
 * developer launches.
 */
import { createElement as h } from 'react';
import { redirect } from 'next/navigation.js';
import { Card, EmptyState, Stat } from '@ss/ui';
import { formatMoney } from '../../core/money.js';
import { dashboardContext } from '../_lib/dashboard.js';
import { Shell, t } from './_components/Shell.js';

export const dynamic = 'force-dynamic';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Overview({ searchParams }) {
	const { launch, website } = await searchParams;
	if (typeof launch === 'string') redirect(`/sso?launch=${encodeURIComponent(launch)}`);
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'overview' });
	const kpis = await context.data.overview();
	const locale = t('apply_box.locale');
	const format = new Intl.NumberFormat(locale);
	/** @type {Array<[string, string]>} */
	const stats = [
		[t('dashboard.kpi.coupons'), format.format(kpis.activeCoupons)],
		[t('dashboard.kpi.redemptions', { days: String(kpis.windowDays) }), format.format(kpis.redemptions)],
		[t('dashboard.kpi.orders'), format.format(kpis.orders)],
		[t('dashboard.kpi.open'), format.format(kpis.openReservations)],
		...kpis.currencies.flatMap(
			(/** @type {any} */ row) =>
				/** @type {Array<[string, string]>} */ ([
					[t('dashboard.kpi.discount', { currency: row.currency }), formatMoney(row.discount, row.currency, locale)],
					[t('dashboard.kpi.revenue', { currency: row.currency }), formatMoney(row.revenue, row.currency, locale)],
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
		h(
			Card,
			{ title: t('dashboard.top.title') },
			kpis.topCodes.length === 0
				? h(EmptyState, { title: t('dashboard.top.empty'), compact: true })
				: h(
						'ol',
						{ className: 'space-y-1 text-sm' },
						kpis.topCodes.map((/** @type {any} */ row) =>
							h(
								'li',
								{ key: `${row.couponId}:${row.code}`, className: 'flex justify-between gap-4' },
								h('span', { className: 'font-mono' }, row.code),
								h(
									'span',
									{ className: 'tabular-nums' },
									`${format.format(row.redemptions)} · ${formatMoney(row.discount, row.currency, locale)}`,
								),
							),
						),
					),
		),
	);
}
