/** One item: details, variants with stock (adjustable by writers), media. Cost is shown here — the dashboard is the merchant's. */
import { createElement as h } from 'react';
import { Card, EmptyState, KeyValueList } from '@ss/ui';
import { formatMoney } from '../../../core/money.js';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t } from '../_components/Shell.js';
import { StockForm } from '../_components/StockForm.js';

/** @param {{ params: Promise<{ id: string }>, searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function ItemDetail({ params, searchParams }) {
	const [{ id }, { website }] = await Promise.all([params, searchParams]);
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'items' });
	const item = await context.data.item(decodeURIComponent(id));
	if (!item) return h(Shell, { context, active: 'items' }, h(EmptyState, { title: t('dashboard.items.not_found') }));
	const locale = t('catalog.locale');
	const money = (/** @type {number | null | undefined} */ amount) =>
		typeof amount === 'number' ? formatMoney(amount, item.currency, locale) : '—';
	return h(
		Shell,
		{ context, active: 'items' },
		h(
			Card,
			{ title: item.title, subtitle: item.url },
			h(KeyValueList, {
				items: [
					{ label: t('dashboard.items.status'), value: item.status },
					{ label: t('dashboard.items.type'), value: item.type },
					{ label: t('dashboard.items.slug'), value: item.slug },
					{ label: t('dashboard.items.currency'), value: item.currency ?? '—' },
					{ label: t('dashboard.items.version'), value: String(item.version) },
					{ label: t('dashboard.items.publish_window'), value: `${item.publishAt ?? '—'} → ${item.unpublishAt ?? '—'}` },
				],
			}),
		),
		h(
			Card,
			{ title: t('dashboard.items.variants') },
			item.variants.length === 0
				? h(EmptyState, { title: t('dashboard.items.no_variants'), compact: true })
				: h(
						'table',
						{ className: 'w-full text-sm' },
						h('caption', { className: 'sr-only' }, t('dashboard.items.variants')),
						h(
							'thead',
							null,
							h(
								'tr',
								{ className: 'text-left text-muted' },
								[
									'dashboard.items.sku',
									'dashboard.items.options',
									'dashboard.items.price',
									'dashboard.items.cost',
									'dashboard.items.stock',
									'dashboard.items.availability',
								].map((key) => h('th', { key, scope: 'col', className: 'py-2' }, t(key))),
							),
						),
						h(
							'tbody',
							null,
							item.variants.map((/** @type {any} */ v) =>
								h(
									'tr',
									{ key: v.id, className: 'border-t border-line align-top' },
									h('td', { className: 'py-2' }, v.sku ?? '—'),
									h(
										'td',
										null,
										Object.entries(v.options)
											.map(([key, value]) => `${key}: ${value}`)
											.join(', ') || '—',
									),
									h('td', null, money(v.price)),
									h('td', null, money(v.cost)),
									h(
										'td',
										null,
										context.data.canWrite
											? h(StockForm, {
													variantId: v.id,
													quantity: v.quantity,
													websiteId: context.data.websiteId,
												})
											: String(v.quantity),
									),
									h('td', null, t(`catalog.availability.${v.availability}`)),
								),
							),
						),
					),
		),
		h(
			Card,
			{ title: t('dashboard.items.media') },
			item.media.length === 0
				? h(EmptyState, { title: t('dashboard.items.no_media'), compact: true })
				: h(
						'ul',
						{ className: 'space-y-1 text-sm' },
						item.media.map((/** @type {any} */ m) =>
							h('li', { key: m.id }, `${m.kind}: ${m.url ?? m.storageKey ?? '—'} (${m.alt})`),
						),
					),
		),
	);
}
