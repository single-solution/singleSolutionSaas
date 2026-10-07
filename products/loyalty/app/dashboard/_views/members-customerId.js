/** Member detail: balance, tier, expiring points, history and (for merchants and staff) manual adjustments. */
import { createElement as h } from 'react';
import { Card, Callout, KeyValueList } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { AdjustForm } from '../_components/AdjustForm.js';
import { Shell, t } from '../_components/Shell.js';

/**
 * @param {{ params: Promise<{ customerId: string }>, searchParams: Promise<Record<string, string | string[] | undefined>> }} props
 */
export default async function Member({ params, searchParams }) {
	const [{ customerId }, { website }] = await Promise.all([params, searchParams]);
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'members' });
	const id = decodeURIComponent(customerId);
	const found = await context.data.member(id);
	if (!found) return h(Shell, { context, active: 'members' }, h(Callout, { tone: 'warning' }, t('dashboard.member.not_found')));
	const { member, history } = found;
	const format = new Intl.NumberFormat(t('wallet.locale'));
	const adjustments = context.data.settings.adjustments;
	return h(
		Shell,
		{ context, active: 'members' },
		h(
			Card,
			{ title: member.customerId },
			h(KeyValueList, {
				items: [
					{ label: t('wallet.balance.label'), value: format.format(member.balance) },
					{ label: 'Tier', value: member.tier?.name ?? '—' },
					{ label: 'Lifetime earned', value: format.format(member.lifetime.earned) },
					{ label: 'Lifetime redeemed', value: format.format(member.lifetime.redeemed) },
					{
						label: 'Expiring',
						value: member.expiring ? `${format.format(member.expiring.points)} · ${member.expiring.expiresOn}` : '—',
					},
					{ label: 'Referral code', value: member.referralCode ?? '—' },
				],
			}),
		),
		context.data.canWrite && context.data.settings.enabled('adjustments') && context.data.websiteId
			? h(
					Card,
					{ title: t('dashboard.member.adjust') },
					h(AdjustForm, {
						customerId: member.customerId,
						websiteId: context.data.websiteId,
						reasons: adjustments.reasons,
						requireNote: adjustments.require_note,
					}),
				)
			: null,
		h(
			Card,
			{ title: t('dashboard.member.history') },
			h(
				'ul',
				{ className: 'divide-y divide-line text-sm' },
				history.map((tx) =>
					h(
						'li',
						{ key: tx.id, className: 'flex justify-between gap-3 py-1.5' },
						h('span', null, `${t(`wallet.kind.${tx.kind}`)}${tx.reason ? ` · ${tx.reason}` : ''}`),
						h('time', { dateTime: tx.occurredAt, className: 'text-muted' }, tx.occurredAt.slice(0, 16).replace('T', ' ')),
						h(
							'span',
							{ className: 'tabular-nums font-semibold' },
							`${tx.points > 0 ? '+' : ''}${format.format(tx.points)}`,
						),
					),
				),
			),
		),
	);
}
