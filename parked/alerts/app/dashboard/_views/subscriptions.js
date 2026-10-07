/** Latest subscriptions (contacts masked). */
import { createElement as h } from 'react';
import { Badge, Card, EmptyState } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { DataTable, Shell, t } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Subscriptions({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'subscriptions' });
	const rows = await context.data.subscriptions();
	return h(
		Shell,
		{ context, active: 'subscriptions' },
		h(
			Card,
			{ title: t('dashboard.nav.subscriptions') },
			rows.length === 0
				? h(EmptyState, { title: t('dashboard.empty.subscriptions'), compact: true })
				: h(DataTable, {
						caption: t('dashboard.nav.subscriptions'),
						columns: [
							t('dashboard.column.type'),
							t('dashboard.column.item'),
							t('dashboard.column.channel'),
							t('dashboard.column.contact'),
							t('dashboard.column.status'),
							t('dashboard.column.date'),
						],
						rows: rows.map((sub) => ({
							key: sub.id,
							cells: [
								sub.type,
								sub.item?.name ?? sub.itemId,
								sub.channel,
								sub.contactMasked ?? '—',
								h(Badge, null, sub.status),
								sub.subscribedAt.slice(0, 10),
							],
						})),
					}),
		),
	);
}
