/** Orders list (latest first, status filter). */
import { createElement as h } from 'react';
import { Badge, Card, EmptyState } from '@ss/ui';
import { formatMoney } from '../../../core/money.js';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t, withWebsite } from '../_components/Shell.js';

export const dynamic = 'force-dynamic';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Orders({ searchParams }) {
	const { website, status } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'orders' });
	const list = await context.data.orders({ status: typeof status === 'string' ? status : null });
	const locale = t('checkout.locale');
	const columns = ['dashboard.orders.number', 'dashboard.orders.status', 'dashboard.orders.payment', 'dashboard.orders.total'];
	return h(
		Shell,
		{ context, active: 'orders' },
		h(
			Card,
			{ title: t('dashboard.nav.orders') },
			list.length === 0
				? h(EmptyState, { title: t('dashboard.orders.empty'), compact: true })
				: h(
						'table',
						{ className: 'w-full text-sm' },
						h(
							'thead',
							null,
							h(
								'tr',
								null,
								columns.map((key) =>
									h('th', { key, scope: 'col', className: 'px-2 py-1 text-left text-xs uppercase text-muted' }, t(key)),
								),
							),
						),
						h(
							'tbody',
							null,
							list.map((order) =>
								h(
									'tr',
									{ key: order.id, className: 'border-t border-line' },
									h(
										'td',
										{ className: 'px-2 py-1 font-mono' },
										h(
											'a',
											{ href: withWebsite(context, `/dashboard/orders/${encodeURIComponent(order.id)}`) },
											order.number,
										),
									),
									h('td', { className: 'px-2 py-1' }, h(Badge, null, order.status)),
									h('td', { className: 'px-2 py-1' }, `${order.payment.method} · ${order.payment.status}`),
									h(
										'td',
										{ className: 'px-2 py-1 tabular-nums' },
										formatMoney(order.totals.total, order.currency, locale),
									),
								),
							),
						),
					),
		),
	);
}
