/** The manual review queue: orders the risk rules flagged, with their flags. */
import { createElement as h } from 'react';
import { Card, EmptyState } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t, withWebsite } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Reviews({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'reviews' });
	const items = await context.data.reviews();
	return h(
		Shell,
		{ context, active: 'reviews' },
		h(
			Card,
			{ title: t('dashboard.nav.reviews') },
			items.length === 0
				? h(EmptyState, { title: t('dashboard.reviews.empty'), compact: true })
				: h(
						'ul',
						{ className: 'space-y-1 text-sm' },
						items.map((o) =>
							h(
								'li',
								{ key: o.id },
								h(
									'a',
									{
										className: 'underline',
										href: withWebsite(context, `/dashboard/orders/${encodeURIComponent(o.id)}`),
									},
									o.number,
								),
								` · ${(o.risk?.flags ?? []).join(', ')}`,
							),
						),
					),
		),
	);
}
