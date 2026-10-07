/** Items list (status tabs, cursor pages): title, status, price range, stock, updated. */
import { createElement as h } from 'react';
import { Badge, ButtonLink, Card, EmptyState, TabNav } from '@ss/ui';
import { formatMoney } from '../../../core/money.js';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t, withWebsite } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Items({ searchParams }) {
	const { website, status, cursor } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'items' });
	const statuses = context.data.settings.items.statuses;
	const current = statuses.find((/** @type {any} */ s) => s.key === status)?.key ?? null;
	const page = await context.data.items({
		...(current ? { status: current } : {}),
		...(typeof cursor === 'string' ? { cursor } : {}),
	});
	const link = (/** @type {string | null} */ s) =>
		withWebsite(context, s ? `/dashboard/items?status=${encodeURIComponent(s)}` : '/dashboard/items');
	const locale = t('catalog.locale');
	const price = (/** @type {any} */ item) =>
		typeof item.priceMin === 'number'
			? item.priceMax > item.priceMin
				? `${formatMoney(item.priceMin, item.currency, locale)} – ${formatMoney(item.priceMax, item.currency, locale)}`
				: formatMoney(item.priceMin, item.currency, locale)
			: '—';
	return h(
		Shell,
		{ context, active: 'items' },
		h(
			Card,
			{ title: t('dashboard.nav.items') },
			h(TabNav, {
				label: t('dashboard.nav.items'),
				current: link(current),
				items: [
					{ label: t('dashboard.items.all'), href: link(null) },
					...statuses.map((/** @type {any} */ s) => ({ label: s.label, href: link(s.key) })),
				],
			}),
			page.items.length === 0
				? h(EmptyState, { title: t('dashboard.items.empty'), compact: true })
				: h(
						'table',
						{ className: 'mt-4 w-full text-sm' },
						h('caption', { className: 'sr-only' }, t('dashboard.nav.items')),
						h(
							'thead',
							null,
							h(
								'tr',
								{ className: 'text-left text-muted' },
								[
									'dashboard.items.title',
									'dashboard.items.status',
									'dashboard.items.price',
									'dashboard.items.stock',
									'dashboard.items.updated',
								].map((key) => h('th', { key, scope: 'col', className: 'py-2' }, t(key))),
							),
						),
						h(
							'tbody',
							null,
							page.items.map((item) =>
								h(
									'tr',
									{ key: item.id, className: 'border-t border-line' },
									h(
										'td',
										{ className: 'py-2' },
										h(
											'a',
											{
												href: withWebsite(context, `/dashboard/items/${encodeURIComponent(item.id)}`),
												className: 'font-semibold',
											},
											item.title,
										),
									),
									h(
										'td',
										null,
										h(Badge, {
											tone: item.baseStatus === 'active' ? 'success' : 'neutral',
											children: statuses.find((/** @type {any} */ s) => s.key === item.status)?.label ?? item.status,
										}),
									),
									h('td', null, price(item)),
									h(
										'td',
										null,
										item.inStock
											? String(item.available)
											: h(Badge, { tone: 'warning', children: t('catalog.availability.sold_out') }),
									),
									h('td', { className: 'text-muted' }, String(item.updatedAt ?? '').slice(0, 10)),
								),
							),
						),
					),
			page.nextCursor
				? h(
						'div',
						{ className: 'mt-4' },
						h(
							ButtonLink,
							{
								href: `${link(current)}${link(current).includes('?') ? '&' : '?'}cursor=${encodeURIComponent(page.nextCursor)}`,
								variant: 'secondary',
							},
							t('dashboard.items.next'),
						),
					)
				: null,
		),
	);
}
