/** Orders list with filters (status, placement dates, payment, delivery, review — A39), print links and CSV export. */
import { createElement as h } from 'react';
import { ButtonLink, Card, EmptyState } from '@ss/ui';
import { formatMoney } from '../../../core/money.js';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t, withWebsite } from '../_components/Shell.js';

const FILTERS = /** @type {const} */ (['status', 'from', 'to', 'payment', 'delivery', 'review', 'cursor']);

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Orders({ searchParams }) {
	const params = await searchParams;
	const context = await dashboardContext(typeof params.website === 'string' ? params.website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'orders' });
	/** @type {Record<string, string | undefined>} */
	const query = Object.fromEntries(
		FILTERS.map((key) => [key, typeof params[key] === 'string' ? String(params[key]) : undefined]),
	);
	const { items, nextCursor } = await context.data.orders(query);
	const { labels, settings } = context.data;
	const ids = items.map((o) => o.id).join(',');
	return h(
		Shell,
		{ context, active: 'orders' },
		h(
			Card,
			{
				title: t('dashboard.nav.orders'),
				actions:
					items.length > 0
						? h(
								'div',
								{ className: 'flex flex-wrap gap-2' },
								settings.enabled('print')
									? h(
											ButtonLink,
											{ href: `/v1/dashboard/packing-slips?ids=${encodeURIComponent(ids)}`, target: '_blank' },
											t('dashboard.orders.slips'),
										)
									: null,
								settings.enabled('print')
									? h(
											ButtonLink,
											{ href: `/v1/dashboard/pick-lists?ids=${encodeURIComponent(ids)}`, target: '_blank' },
											t('dashboard.orders.pick_list'),
										)
									: null,
								settings.enabled('bulk')
									? h(
											ButtonLink,
											{
												href: `/v1/dashboard/order-exports${query.status ? `?status=${encodeURIComponent(query.status)}` : ''}`,
											},
											t('dashboard.orders.export'),
										)
									: null,
							)
						: null,
			},
			h(
				'form',
				{ className: 'mb-4 flex flex-wrap gap-2 text-sm', method: 'get' },
				context.data.websiteId ? h('input', { type: 'hidden', name: 'website', value: context.data.websiteId }) : null,
				h(
					'select',
					{
						name: 'status',
						defaultValue: query.status ?? '',
						'aria-label': t('dashboard.orders.status'),
						className: 'rounded-md border border-line bg-surface p-1',
					},
					h('option', { value: '' }, t('dashboard.orders.all')),
					settings.matrix.statuses.map((s) => h('option', { key: s.key, value: s.key }, labels.statusLabel(s.key))),
				),
				h('input', {
					type: 'date',
					name: 'from',
					defaultValue: query.from ?? '',
					'aria-label': t('dashboard.orders.from'),
					className: 'rounded-md border border-line bg-surface p-1',
				}),
				h('input', {
					type: 'date',
					name: 'to',
					defaultValue: query.to ?? '',
					'aria-label': t('dashboard.orders.to'),
					className: 'rounded-md border border-line bg-surface p-1',
				}),
				h('input', {
					name: 'payment',
					defaultValue: query.payment ?? '',
					placeholder: t('dashboard.orders.payment'),
					'aria-label': t('dashboard.orders.payment'),
					className: 'rounded-md border border-line bg-surface p-1',
				}),
				h('button', { type: 'submit', className: 'rounded-md border border-line px-3' }, t('dashboard.orders.filter')),
			),
			items.length === 0
				? h(EmptyState, { title: t('dashboard.orders.empty'), compact: true })
				: h(
						'table',
						{ className: 'w-full text-sm' },
						h('caption', { className: 'sr-only' }, t('dashboard.nav.orders')),
						h(
							'thead',
							null,
							h(
								'tr',
								{ className: 'text-left text-muted' },
								[
									'dashboard.orders.number',
									'dashboard.orders.placed',
									'dashboard.orders.status',
									'dashboard.orders.customer',
									'dashboard.orders.total',
									'dashboard.orders.balance',
									'dashboard.orders.flags',
								].map((key) => h('th', { key, scope: 'col', className: 'py-2' }, t(key))),
							),
						),
						h(
							'tbody',
							null,
							items.map((o) =>
								h(
									'tr',
									{ key: o.id, className: 'border-t border-line align-top' },
									h(
										'td',
										{ className: 'py-2' },
										h(
											'a',
											{
												href: withWebsite(context, `/dashboard/orders/${encodeURIComponent(o.id)}`),
												className: 'font-semibold underline',
											},
											o.number,
										),
									),
									h('td', null, new Date(o.placedAt).toISOString().slice(0, 10)),
									h('td', null, labels.statusLabel(o.status)),
									h('td', null, o.customer?.name ?? o.shipping?.name ?? '—'),
									h('td', null, formatMoney(o.amounts.total, o.currency, labels.lang)),
									h('td', null, formatMoney(o.money.balanceDue, o.currency, labels.lang)),
									h('td', null, (o.risk?.flags ?? []).join(', ') || '—'),
								),
							),
						),
					),
			nextCursor
				? h(
						'p',
						{ className: 'mt-4' },
						h(
							'a',
							{
								className: 'underline',
								href: withWebsite(
									context,
									`/dashboard/orders?cursor=${encodeURIComponent(nextCursor)}${query.status ? `&status=${query.status}` : ''}`,
								),
							},
							t('dashboard.orders.more'),
						),
					)
				: null,
		),
	);
}
