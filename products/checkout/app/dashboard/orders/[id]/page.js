/** One order: lines, totals snapshot, payments, refunds, proofs, timeline; confirm / cancel / record a payment. */
import { createElement as h } from 'react';
import { Callout, Card, KeyValueList } from '@ss/ui';
import { formatMoney } from '../../../../core/money.js';
import { dashboardContext } from '../../../_lib/dashboard.js';
import { OrderActions } from '../../_components/OrderActions.js';
import { Shell, t } from '../../_components/Shell.js';

export const dynamic = 'force-dynamic';

/** @param {{ params: Promise<{ id: string }>, searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function OrderPage({ params, searchParams }) {
	const { id } = await params;
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'orders' });
	const order = await context.data.order(id);
	if (!order) return h(Shell, { context, active: 'orders' }, h(Callout, { tone: 'warning' }, t('dashboard.order.not_found')));
	const locale = t('checkout.locale');
	const money = (/** @type {number} */ n) => formatMoney(n, order.currency, locale);
	const totals = order.totals;
	return h(
		Shell,
		{ context, active: 'orders' },
		h(
			Card,
			{ title: `${t('dashboard.orders.number')} ${order.number}`, subtitle: order.status },
			h(KeyValueList, {
				items: [
					...order.lines.map((/** @type {any} */ line) => ({
						label: `${line.quantity} × ${line.title}`,
						value: money(line.totalAmount),
					})),
					{ label: t('place_order.subtotal'), value: money(totals.subtotal) },
					{ label: t('place_order.deals'), value: money(totals.itemDiscount) },
					{ label: t('place_order.coupons'), value: money(totals.couponDiscount) },
					{ label: t('place_order.shipping'), value: money(totals.shipping - totals.shippingDiscount) },
					{ label: t('place_order.surcharge'), value: money(totals.surcharge) },
					{ label: t('place_order.loyalty'), value: money(totals.loyalty) },
					{ label: t('place_order.total'), value: money(totals.total) },
					{ label: t('dashboard.orders.payment'), value: `${order.payment.method} · ${order.payment.status}` },
				],
			}),
		),
		h(
			Card,
			{ title: t('dashboard.orders.status') },
			h(
				'ol',
				{ className: 'space-y-1 text-sm' },
				order.timeline.map((/** @type {any} */ e, /** @type {number} */ i) =>
					h('li', { key: i }, `${e.at} · ${e.status}${e.reason ? ` · ${e.reason}` : ''}`),
				),
			),
			h(
				'ul',
				{ className: 'mt-2 space-y-1 text-sm' },
				order.payments.map((/** @type {any} */ p, /** @type {number} */ i) =>
					h('li', { key: `p${i}` }, `${p.at} · ${p.method} · ${money(p.amount)} · ${p.reference ?? ''}`),
				),
			),
		),
		context.data.canWrite && context.data.websiteId
			? h(OrderActions, { websiteId: context.data.websiteId, orderId: order.id, status: order.status, proofs: order.proofs })
			: null,
	);
}
