/** Coupons list (status filter) with the create form for write roles. */
import { createElement as h } from 'react';
import { Badge, Card, EmptyState } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { NewCouponForm } from '../_components/NewCouponForm.js';
import { Shell, t, withWebsite } from '../_components/Shell.js';

export const dynamic = 'force-dynamic';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Coupons({ searchParams }) {
	const { website, status } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'coupons' });
	const coupons = await context.data.coupons({ status: typeof status === 'string' ? status : null });
	return h(
		Shell,
		{ context, active: 'coupons' },
		context.data.canWrite && context.data.websiteId
			? h(Card, { title: t('dashboard.coupons.new') }, h(NewCouponForm, { websiteId: context.data.websiteId }))
			: null,
		h(
			Card,
			{ title: t('dashboard.nav.coupons') },
			coupons.length === 0
				? h(EmptyState, { title: t('dashboard.coupons.empty'), compact: true })
				: h(
						'table',
						{ className: 'w-full text-sm' },
						h(
							'thead',
							null,
							h(
								'tr',
								null,
								['Name', 'Status', 'Action', 'Codes', 'Redeemed'].map((label) =>
									h(
										'th',
										{ key: label, scope: 'col', className: 'px-2 py-1 text-left text-xs uppercase text-muted' },
										label,
									),
								),
							),
						),
						h(
							'tbody',
							null,
							coupons.map((coupon) =>
								h(
									'tr',
									{ key: coupon.id, className: 'border-t border-line' },
									h(
										'td',
										{ className: 'px-2 py-1' },
										h(
											'a',
											{
												className: 'font-semibold underline',
												href: withWebsite(context, `/dashboard/coupons/${encodeURIComponent(coupon.id)}`),
											},
											coupon.name,
										),
									),
									h('td', { className: 'px-2 py-1' }, h(Badge, null, coupon.status)),
									h('td', { className: 'px-2 py-1' }, coupon.action?.type ?? '—'),
									h('td', { className: 'px-2 py-1 tabular-nums' }, String(coupon.codes)),
									h('td', { className: 'px-2 py-1 tabular-nums' }, String(coupon.usage.redeemed)),
								),
							),
						),
					),
		),
	);
}
