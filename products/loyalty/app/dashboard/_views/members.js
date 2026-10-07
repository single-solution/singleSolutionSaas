/** Members search (customer id prefix) with balances and tiers. */
import { createElement as h } from 'react';
import { Badge, Button, Card, EmptyState, Input } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t, withWebsite } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Members({ searchParams }) {
	const { website, q } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'members' });
	const query = typeof q === 'string' ? q.trim() : '';
	const members = await context.data.members({ q: query });
	const format = new Intl.NumberFormat(t('wallet.locale'));
	return h(
		Shell,
		{ context, active: 'members' },
		h(
			Card,
			{ title: t('dashboard.nav.members') },
			h(
				'form',
				{ method: 'get', role: 'search', className: 'mb-4 flex gap-2' },
				context.data.websiteId ? h('input', { type: 'hidden', name: 'website', value: context.data.websiteId }) : null,
				h(Input, {
					label: t('dashboard.members.search'),
					hideLabel: true,
					name: 'q',
					defaultValue: query,
					placeholder: t('dashboard.members.search'),
				}),
				h(Button, { type: 'submit', variant: 'secondary' }, t('dashboard.members.search')),
			),
			members.length === 0
				? h(EmptyState, { title: t('dashboard.members.empty'), compact: true })
				: h(
						'table',
						{ className: 'w-full text-sm' },
						h(
							'thead',
							null,
							h(
								'tr',
								null,
								['Customer', 'Balance', 'Tier', 'Joined'].map((label) =>
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
							members.map((member) =>
								h(
									'tr',
									{ key: member.customerId, className: 'border-t border-line' },
									h(
										'td',
										{ className: 'px-2 py-1' },
										h(
											'a',
											{
												className: 'font-semibold underline',
												href: withWebsite(context, `/dashboard/members/${encodeURIComponent(member.customerId)}`),
											},
											member.customerId,
										),
									),
									h('td', { className: 'px-2 py-1 tabular-nums' }, format.format(member.balance)),
									h('td', { className: 'px-2 py-1' }, member.tier?.name ? h(Badge, null, member.tier.name) : '—'),
									h('td', { className: 'px-2 py-1' }, member.joinedAt.slice(0, 10)),
								),
							),
						),
					),
		),
	);
}
