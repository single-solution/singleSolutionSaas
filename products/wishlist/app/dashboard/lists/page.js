/** Latest lists of the website (owner kind, size, signals opt-in, sharing). */
import { createElement as h } from 'react';
import { Badge, Card, EmptyState } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { DataTable, Shell, t } from '../_components/Shell.js';

export const dynamic = 'force-dynamic';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Lists({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'lists' });
	const rows = await context.data.lists();
	return h(
		Shell,
		{ context, active: 'lists' },
		h(
			Card,
			{ title: t('dashboard.nav.lists') },
			rows.length === 0
				? h(EmptyState, { title: t('dashboard.empty.lists'), compact: true })
				: h(DataTable, {
						caption: t('dashboard.nav.lists'),
						columns: [
							t('dashboard.column.name'),
							t('dashboard.column.owner'),
							t('dashboard.column.items'),
							t('dashboard.column.signals'),
							t('dashboard.kpi.shared'),
							t('dashboard.column.date'),
						],
						rows: rows.map((list) => ({
							key: list.id,
							cells: [
								list.name,
								h(Badge, null, t(`dashboard.owner.${list.owner.kind}`)),
								String(list.itemCount),
								list.notify ? t('dashboard.yes') : t('dashboard.no'),
								list.shared ? t('dashboard.yes') : t('dashboard.no'),
								list.createdAt.slice(0, 10),
							],
						})),
					}),
		),
	);
}
