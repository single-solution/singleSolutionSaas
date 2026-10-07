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

/** @param {number} bps */
const percent = (bps) => `${(bps / 100).toFixed(1)} %`;

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Overview({ searchParams }) {
	const { launch, website } = await searchParams;
	if (typeof launch === 'string') redirect(`/sso?launch=${encodeURIComponent(launch)}`);
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'overview' });
	const { active, analytics } = await context.data.overview();
	const format = new Intl.NumberFormat(t('capture.locale'));
	const stats = [
		[t('dashboard.kpi.active'), format.format(active)],
		[t('dashboard.kpi.subscribed'), format.format(analytics.subscriptions.total)],
		[t('dashboard.kpi.sent'), format.format(analytics.messages.sent)],
		[t('dashboard.kpi.failed'), format.format(analytics.messages.failed)],
		[t('dashboard.kpi.notified'), percent(analytics.rates.notifiedBps)],
		[t('dashboard.kpi.unsubscribed'), percent(analytics.rates.unsubscribedBps)],
	];
	return h(
		Shell,
		{ context, active: 'overview' },
		h(
			Card,
			{ title: `${t('dashboard.nav.overview')} · ${t('dashboard.window', { days: context.data.windowDays })}` },
			h(
				'div',
				{ className: 'grid grid-cols-2 gap-4 sm:grid-cols-3' },
				stats.map(([label, value]) => h(Stat, { key: String(label), label, value })),
			),
		),
	);
}
