/**
 * One order: status and the moves staff may make, timeline, lines with serials, fulfilment, the payments ledger,
 * risk flags and print links. Writers act through the same services as the API (audited as staff).
 */
import { createElement as h } from 'react';
import { ButtonLink, Card, EmptyState, KeyValueList } from '@ss/ui';
import { formatMoney } from '../../../../core/money.js';
import { dashboardContext } from '../../../_lib/dashboard.js';
import { ActionForm } from '../../_components/ActionForm.js';
import { Shell, t } from '../../_components/Shell.js';

export const dynamic = 'force-dynamic';

/** @param {{ params: Promise<{ id: string }>, searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function OrderDetail({ params, searchParams }) {
	const [{ id }, { website }] = await Promise.all([params, searchParams]);
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'orders' });
	const order = await context.data.order(decodeURIComponent(id));
	if (!order) return h(Shell, { context, active: 'orders' }, h(EmptyState, { title: t('dashboard.order.not_found') }));
	const { labels, settings, canWrite } = context.data;
	const websiteId = context.data.websiteId ?? '';
	const money = (/** @type {number} */ amount) => formatMoney(amount, order.currency, labels.lang);
	const base = `/v1/dashboard/orders/${encodeURIComponent(order.id)}`;
	const methods = settings.methods.map((m) => ({ value: m.key, label: labels.methodLabel(m.key) }));
	const can = (/** @type {any} */ key) => canWrite && settings.enabled(key);
	return h(
		Shell,
		{ context, active: 'orders' },
		h(
			Card,
			{
				title: t('dashboard.order.title', { number: order.number }),
				subtitle: labels.statusLabel(order.status),
				actions: settings.enabled('invoices')
					? h(
							'div',
							{ className: 'flex gap-2' },
							h(ButtonLink, { href: `${base}/invoice`, target: '_blank' }, t('dashboard.order.invoice')),
							h(
								ButtonLink,
								{ href: `${base}/invoice?kind=internal`, target: '_blank' },
								t('dashboard.order.internal_invoice'),
							),
						)
					: null,
			},
			h(KeyValueList, {
				items: [
					{
						label: t('dashboard.order.placed'),
						value: new Date(order.placedAt).toISOString().slice(0, 16).replace('T', ' '),
					},
					{ label: t('dashboard.order.source'), value: order.sourceLabel ?? order.source },
					{
						label: t('dashboard.order.customer'),
						value: [order.customer?.name, order.customer?.email, order.customer?.phone].filter(Boolean).join(' · ') || '—',
					},
					{ label: t('dashboard.order.payment'), value: labels.methodLabel(order.payment?.method) },
					{ label: t('dashboard.order.total'), value: money(order.amounts.total) },
					{
						label: t('dashboard.order.paid'),
						value: `${money(order.money.paid)} / ${t('dashboard.order.refunded')} ${money(order.money.refunded)}`,
					},
					{ label: t('dashboard.order.balance'), value: money(order.money.balanceDue) },
					{ label: t('dashboard.order.risk'), value: (order.risk?.flags ?? []).join(', ') || '—' },
				],
			}),
			can('lifecycle') && order.next.length > 0
				? h(ActionForm, {
						path: `${base}/transitions`,
						websiteId,
						submit: t('dashboard.order.move'),
						fields: [
							{
								name: 'status',
								label: t('dashboard.order.to'),
								type: 'select',
								options: order.next.map((/** @type {string} */ key) => ({ value: key, label: labels.statusLabel(key) })),
							},
							{ name: 'reason', label: t('dashboard.order.reason') },
							{ name: 'note', label: t('dashboard.order.note') },
						],
					})
				: null,
			can('risk') && order.risk?.review === 'pending'
				? h(ActionForm, {
						path: `${base}/review`,
						websiteId,
						submit: t('dashboard.order.review'),
						fields: [
							{
								name: 'decision',
								label: t('dashboard.order.decision'),
								type: 'select',
								options: [
									{ value: 'clear', label: t('dashboard.order.clear') },
									{ value: 'hold', label: t('dashboard.order.hold') },
								],
							},
						],
					})
				: null,
		),
		h(
			Card,
			{ title: t('dashboard.order.lines') },
			h(
				'ul',
				{ className: 'space-y-1 text-sm' },
				order.lines.map((/** @type {any} */ line) =>
					h(
						'li',
						{ key: line.id },
						`${line.id} · ${line.quantity} × ${line.title}${line.sku ? ` (${line.sku})` : ''} — ${money(line.totalAmount)}${(line.serials ?? []).length > 0 ? ` · ${line.serials.join(', ')}` : ''}`,
					),
				),
			),
			can('serials')
				? h(ActionForm, {
						path: `${base}/serials`,
						websiteId,
						submit: t('dashboard.order.save_serials'),
						fields: [{ name: 'lines', label: t('dashboard.order.serials_help'), type: 'lines' }],
					})
				: null,
		),
		h(
			Card,
			{ title: t('dashboard.order.fulfilment') },
			h(
				'p',
				{ className: 'text-sm' },
				[order.fulfilment?.carrierName, order.fulfilment?.trackingNumber].filter(Boolean).join(' · ') || '—',
			),
			can('fulfilment')
				? h(ActionForm, {
						path: `${base}/fulfilment`,
						websiteId,
						submit: t('dashboard.order.save_fulfilment'),
						fields: [
							...(settings.carriers.length > 0
								? [
										{
											name: 'carrier',
											label: t('dashboard.order.carrier'),
											type: /** @type {const} */ ('select'),
											options: settings.carriers.map((c) => ({ value: c.key, label: c.name })),
										},
									]
								: [{ name: 'carrier', label: t('dashboard.order.carrier') }]),
							{ name: 'trackingNumber', label: t('dashboard.order.tracking') },
							{ name: 'dispatchVideoUrl', label: t('dashboard.order.video') },
						],
					})
				: null,
		),
		h(
			Card,
			{ title: t('dashboard.order.ledger') },
			h(
				'ul',
				{ className: 'space-y-1 text-sm' },
				[
					...(order.payments ?? []).map((/** @type {any} */ p) => ['+', p]),
					...(order.refunds ?? []).map((/** @type {any} */ r) => ['−', r]),
				].map(([sign, entry]) =>
					h(
						'li',
						{ key: entry.id },
						`${sign}${money(entry.amount)} · ${labels.methodLabel(entry.method)} · ${entry.reference ?? '—'} · ${new Date(entry.at).toISOString().slice(0, 10)}`,
					),
				),
			),
			can('ledger')
				? h(ActionForm, {
						path: `${base}/payments`,
						websiteId,
						submit: t('dashboard.order.record_payment'),
						fields: [
							{ name: 'amount', label: t('dashboard.order.amount_minor'), type: 'number' },
							{ name: 'method', label: t('dashboard.order.method'), type: 'select', options: methods },
							{ name: 'reference', label: t('dashboard.order.reference') },
						],
					})
				: null,
			can('ledger') && order.money.refundable > 0
				? h(ActionForm, {
						path: `${base}/refunds`,
						websiteId,
						submit: t('dashboard.order.record_refund'),
						fields: [
							{ name: 'amount', label: t('dashboard.order.amount_minor'), type: 'number' },
							{ name: 'method', label: t('dashboard.order.method'), type: 'select', options: methods },
							{ name: 'reason', label: t('dashboard.order.reason') },
							{ name: 'reference', label: t('dashboard.order.reference') },
						],
					})
				: null,
		),
		h(
			Card,
			{ title: t('dashboard.order.timeline') },
			h(
				'ol',
				{ className: 'space-y-1 text-sm' },
				(order.timeline ?? []).map((/** @type {any} */ entry, /** @type {number} */ index) =>
					h(
						'li',
						{ key: index },
						`${new Date(entry.at).toISOString().slice(0, 16).replace('T', ' ')} · ${labels.statusLabel(entry.status)} · ${entry.actor?.type ?? ''}${entry.reason ? ` · ${entry.reason}` : ''}${entry.note ? ` · ${entry.note}` : ''}`,
					),
				),
			),
		),
	);
}
