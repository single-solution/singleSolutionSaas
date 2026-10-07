/** Latest price-drop and back-in-stock signals published for opted-in customers. */
import { createElement as h } from 'react';
import { Badge, Card, EmptyState } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { DataTable, Shell, t } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Notifications({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'notifications' });
	const rows = await context.data.notifications();
	return h(
		Shell,
		{ context, active: 'notifications' },
		h(
			Card,
			{ title: t('dashboard.nav.notifications') },
			rows.length === 0
				? h(EmptyState, { title: t('dashboard.empty.notifications'), compact: true })
				: h(DataTable, {
						caption: t('dashboard.nav.notifications'),
						columns: [
							t('dashboard.column.kind'),
							t('dashboard.column.item'),
							t('dashboard.column.customer'),
							t('dashboard.column.date'),
						],
						rows: rows.map((row) => ({
							key: row.id,
							cells: [h(Badge, null, row.kind), row.itemId, row.customer.subject, row.at.slice(0, 16).replace('T', ' ')],
						})),
					}),
		),
	);
}
