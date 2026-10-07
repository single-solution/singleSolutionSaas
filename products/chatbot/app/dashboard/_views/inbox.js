/** Inbox (SSO): conversations by status, newest activity first. */
import { createElement as h } from 'react';
import { Card, StatusBadge } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t, withWebsite } from '../_components/Shell.js';

const STATUSES = ['open', 'pending', 'snoozed', 'resolved', 'closed'];

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Inbox({ searchParams }) {
	const { website, status } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'inbox' });
	const filter = typeof status === 'string' && STATUSES.includes(status) ? status : null;
	const items = await context.data.conversations({ status: filter });
	const link = (/** @type {string | null} */ value) => {
		const base = withWebsite(context, '/dashboard/inbox');
		return value ? `${base}${base.includes('?') ? '&' : '?'}status=${value}` : base;
	};
	return h(
		Shell,
		{ context, active: 'inbox' },
		h(
			Card,
			{ title: t('dashboard.nav.inbox') },
			h(
				'nav',
				{ 'aria-label': t('dashboard.inbox.filter'), className: 'mb-4 flex flex-wrap gap-2 text-sm' },
				[null, ...STATUSES].map((value) =>
					h(
						'a',
						{
							key: value ?? 'all',
							href: link(value),
							'aria-current': value === filter ? 'page' : undefined,
							className: 'rounded-md px-2 py-1 font-semibold text-muted hover:text-fg',
						},
						value ? t(`dashboard.status.${value}`) : t('dashboard.inbox.all'),
					),
				),
			),
			items.length === 0
				? h('p', { className: 'text-muted' }, t('dashboard.inbox.empty'))
				: h(
						'ul',
						{ className: 'divide-y divide-line' },
						items.map((c) =>
							h(
								'li',
								{ key: c.id, className: 'flex items-center justify-between gap-3 py-3' },
								h(
									'a',
									{
										href: withWebsite(context, `/dashboard/inbox/${encodeURIComponent(c.id)}`),
										className: 'min-w-0 flex-1',
									},
									h(
										'span',
										{ className: 'block truncate font-semibold text-fg' },
										c.contact?.name ?? c.customerId ?? c.id,
									),
									h('span', { className: 'block truncate text-sm text-muted' }, c.lastMessagePreview || '—'),
								),
								c.humanRequested ? h(StatusBadge, { status: 'warning', label: t('dashboard.kpi.waiting') }) : null,
								h(StatusBadge, {
									status: c.status === 'open' ? 'active' : c.status === 'closed' ? 'inactive' : 'pending',
									label: t(`dashboard.status.${c.status}`),
								}),
							),
						),
					),
		),
	);
}
