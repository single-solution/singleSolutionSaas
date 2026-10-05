/** Deals list: kind, status, whether each is live now (schedule in the website's zone), usage; create from JSON. */
import { createElement as h } from 'react';
import { Badge, Card, EmptyState } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { CreateDeal } from '../_components/CreateDeal.js';
import { Shell, t, withWebsite } from '../_components/Shell.js';

export const dynamic = 'force-dynamic';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Deals({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'deals' });
	const deals = await context.data.deals();
	return h(
		Shell,
		{ context, active: 'deals' },
		h(
			Card,
			{ title: t('dashboard.nav.deals') },
			deals.length === 0
				? h(EmptyState, { title: t('dashboard.deals.empty'), compact: true })
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
									'Deal',
									t('dashboard.deals.kind'),
									t('dashboard.deals.status'),
									t('dashboard.deals.now'),
									t('dashboard.deal.usage'),
								].map((label) =>
									h(
										'th',
										{ key: label, scope: 'col', className: 'px-2 py-1 text-left text-xs uppercase text-muted' },
										label,
									),
								),
							),
						),
						h(
							'tbody',
							null,
							deals.map((deal) =>
								h(
									'tr',
									{ key: deal.id, className: 'border-t border-line' },
									h(
										'td',
										{ className: 'px-2 py-1' },
										h(
											'a',
											{
												className: 'font-semibold underline',
												href: withWebsite(context, `/dashboard/deals/${encodeURIComponent(deal.id)}`),
											},
											deal.name,
										),
									),
									h('td', { className: 'px-2 py-1' }, deal.kind),
									h(
										'td',
										{ className: 'px-2 py-1' },
										h(Badge, { tone: deal.status === 'active' ? 'success' : 'neutral', children: deal.status }),
									),
									h(
										'td',
										{ className: 'px-2 py-1' },
										deal.state.active
											? h(Badge, { tone: 'success', children: t('dashboard.deals.live') })
											: t('dashboard.deals.off'),
									),
									h('td', { className: 'px-2 py-1 tabular-nums' }, `${deal.usage.uses} / ${deal.usage.units}`),
								),
							),
						),
					),
		),
		context.data.canWrite && context.data.websiteId
			? h(Card, { title: t('dashboard.deals.create') }, h(CreateDeal, { websiteId: context.data.websiteId }))
			: null,
	);
}
