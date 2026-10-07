/** Catalog items stored from item.* and inventory.changed events (the optional catalog link): variants, prices, stock. */
import { createElement as h } from 'react';
import { Callout, Card, EmptyState } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Catalog({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'catalog' });
	const items = await context.data.items();
	const enabled = context.data.settings.schema.catalog_link;
	return h(
		Shell,
		{ context, active: 'catalog' },
		enabled ? null : h(Callout, { tone: 'info' }, t('dashboard.catalog.off')),
		h(
			Card,
			{ title: t('dashboard.nav.catalog'), subtitle: t('dashboard.catalog.intro') },
			items.length === 0
				? h(EmptyState, { title: t('dashboard.catalog.empty'), compact: true })
				: h(
						'ul',
						{ className: 'space-y-3 text-sm' },
						items.map((item) =>
							h(
								'li',
								{ key: item.itemId },
								h('span', { className: 'font-semibold' }, item.title ?? item.itemId),
								' ',
								h(
									'span',
									{ className: 'font-mono text-muted' },
									`${item.itemId}${item.deleted ? ` · ${t('dashboard.catalog.deleted')}` : ''}`,
								),
								h(
									'ul',
									{ className: 'ml-4 text-muted' },
									item.variants.map((variant) =>
										h(
											'li',
											{ key: variant.variantId, className: 'font-mono' },
											t('dashboard.catalog.variant', {
												variant: variant.sku ?? variant.variantId,
												attributes: JSON.stringify(variant.attributes),
												stock: variant.stock === null ? '—' : String(variant.stock),
											}),
										),
									),
								),
							),
						),
					),
		),
	);
}
