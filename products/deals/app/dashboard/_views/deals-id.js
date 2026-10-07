/** One deal: what it does, its schedule state in the website's zone, usage, and pause/resume. */
import { createElement as h } from 'react';
import { Callout, Card, CodeBlock, KeyValueList } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { DealActions } from '../_components/DealActions.js';
import { Shell, t } from '../_components/Shell.js';

/** @param {{ params: Promise<{ id: string }>, searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Deal({ params, searchParams }) {
	const { id } = await params;
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'deals' });
	const deal = await context.data.deal(decodeURIComponent(id));
	if (!deal) return h(Shell, { context, active: 'deals' }, h(Callout, { tone: 'warning' }, t('dashboard.deal.not_found')));
	const windows = Array.isArray(deal.schedule?.windows) ? deal.schedule.windows : [];
	return h(
		Shell,
		{ context, active: 'deals' },
		h(
			Card,
			{
				title: deal.name,
				subtitle: `${deal.kind} · ${deal.class} · priority ${deal.priority}`,
				actions:
					context.data.canWrite && context.data.websiteId && deal.status !== 'archived'
						? h(DealActions, { dealId: deal.id, websiteId: context.data.websiteId, status: deal.status })
						: null,
			},
			h(KeyValueList, {
				items: [
					{ label: t('dashboard.deals.status'), value: deal.status },
					{
						label: t('dashboard.deals.now'),
						value: deal.state.active ? t('dashboard.deals.live') : `${t('dashboard.deals.off')} (${deal.state.phase})`,
					},
					{
						label: t('dashboard.deal.schedule'),
						value:
							windows.length === 0 && !deal.schedule?.startsAt && !deal.schedule?.endsAt
								? t('dashboard.deal.always')
								: [
										deal.schedule?.startsAt ? `from ${deal.schedule.startsAt}` : null,
										deal.schedule?.endsAt ? `until ${deal.schedule.endsAt}` : null,
										...windows.map(
											(/** @type {any} */ w) => `${(w.days ?? []).join(',') || 'daily'} ${w.start}–${w.end}`,
										),
										deal.state.timeZone,
									]
										.filter(Boolean)
										.join(' · '),
					},
					{ label: 'Active until', value: deal.state.activeUntil ?? '—' },
					{ label: 'Next start', value: deal.state.nextStart ?? '—' },
					{ label: t('dashboard.deal.usage'), value: `${deal.usage.uses} uses · ${deal.usage.units} units` },
				],
			}),
		),
		h(Card, { title: 'JSON' }, h(CodeBlock, { code: JSON.stringify(deal, null, 2), label: 'JSON' })),
	);
}
