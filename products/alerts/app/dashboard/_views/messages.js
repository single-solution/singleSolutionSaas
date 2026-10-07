/** Latest messages of the outbox (contacts masked) and the "Send due now" button (merchants). */
import { createElement as h } from 'react';
import { Badge, Card, EmptyState } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { SendDueNow } from '../_components/SendDueNow.js';
import { DataTable, Shell, t } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Messages({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'messages' });
	const rows = await context.data.messages();
	return h(
		Shell,
		{ context, active: 'messages' },
		h(
			Card,
			{ title: t('dashboard.nav.messages') },
			context.data.canWrite && context.data.websiteId
				? h('div', { className: 'mb-4' }, h(SendDueNow, { websiteId: context.data.websiteId }))
				: null,
			rows.length === 0
				? h(EmptyState, { title: t('dashboard.empty.messages'), compact: true })
				: h(DataTable, {
						caption: t('dashboard.nav.messages'),
						columns: [
							t('dashboard.column.type'),
							t('dashboard.column.channel'),
							t('dashboard.column.contact'),
							t('dashboard.column.status'),
							t('dashboard.column.attempts'),
							t('dashboard.column.date'),
						],
						rows: rows.map((message) => ({
							key: message.id,
							cells: [
								[...new Set(message.items.map((/** @type {{ type: string }} */ item) => item.type))].join(', '),
								message.channel,
								message.to ?? '—',
								h(Badge, null, message.status),
								String(message.attempts),
								(message.sentAt ?? message.createdAt ?? '').slice(0, 10),
							],
						})),
					}),
		),
	);
}
