/**
 * Dashboard overview (SSO). The Portal sends the browser to app-kit's `GET /sso?launch=<jwt>`, which verifies the launch
 * (signature, issuer, audience, kind/scope, single use), stores a session and sets the HttpOnly `ss_session` cookie,
 * then redirects here. Supports merchant, demo (sandbox data), admin(scope), impersonate (audit banner), partner and
 * developer launches.
 */
import { createElement as h } from 'react';
import { redirect } from 'next/navigation.js';
import { Callout, Card, Stat } from '@ss/ui';
import { dashboardContext } from '../_lib/dashboard.js';
import { Shell, t, withWebsite } from './_components/Shell.js';

export const dynamic = 'force-dynamic';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Overview({ searchParams }) {
	const { launch, website } = await searchParams;
	if (typeof launch === 'string') redirect(`/sso?launch=${encodeURIComponent(launch)}`);
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'overview' });
	const kpis = await context.data.overview();
	const issuer = await context.data.issuer();
	const format = new Intl.NumberFormat(t('locale'));
	const stats = [
		['dashboard.kpi.customers', kpis.customers],
		['dashboard.kpi.new', kpis.newLast30Days],
		['dashboard.kpi.signins', kpis.signedInLast30Days],
		['dashboard.kpi.sessions', kpis.activeSessions],
		['dashboard.kpi.deletions', kpis.pendingDeletions],
	];
	return h(
		Shell,
		{ context, active: 'overview' },
		issuer.registered
			? null
			: h(
					Callout,
					{ tone: 'warning', title: t('dashboard.nav.identity') },
					h(
						'a',
						{ className: 'underline', href: withWebsite(context, '/dashboard/identity') },
						t('dashboard.identity.not_registered'),
					),
				),
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
	);
}
