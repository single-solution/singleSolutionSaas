/**
 * Dashboard overview (SSO). The Portal sends the browser to app-kit's `GET /sso?launch=<jwt>`, which verifies the launch
 * (signature, issuer, audience, kind/scope, single use), stores a session and sets the HttpOnly `ss_session` cookie,
 * then redirects here. Supports merchant, demo (sandbox data), admin(scope), impersonate (audit banner), partner and
 * developer launches.
 */
import { createElement as h } from 'react';
import { redirect } from 'next/navigation.js';
import { Card, Stat } from '@ss/ui';
import { dashboardContext } from '../_lib/dashboard.js';
import { DashboardActions } from './_components/DashboardActions.js';
import { Shell, t } from './_components/Shell.js';

export const dynamic = 'force-dynamic';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Overview({ searchParams }) {
	const { launch, website } = await searchParams;
	if (typeof launch === 'string') redirect(`/sso?launch=${encodeURIComponent(launch)}`);
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'overview' });
	const kpis = await context.data.overview();
	const format = new Intl.NumberFormat(t('reviews.locale'));
	const stats = [
		['dashboard.kpi.pending', kpis.reviews.pending],
		['dashboard.kpi.approved', kpis.reviews.approved],
		['dashboard.kpi.rejected', kpis.reviews.rejected],
		['dashboard.kpi.open_requests', kpis.requests.open ?? 0],
		['dashboard.kpi.questions', kpis.questions.pending],
		['dashboard.kpi.unanswered', kpis.questions.unanswered],
	];
	const { canWrite, websiteId, settings } = context.data;
	const requests = settings.enabled('request_flow');
	const photos = settings.enabled('photos');
	const actions = canWrite && websiteId && (requests || photos) ? h(DashboardActions, { websiteId, requests, photos }) : null;
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
		actions ? h(Card, { title: t('dashboard.actions.title') }, actions) : null,
	);
}
