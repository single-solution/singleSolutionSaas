/** Settings live in the Portal (the product never stores merchant configuration): the effective values and a link. */
import { createElement as h } from 'react';
import { ButtonLink, Card, KeyValueList } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t } from '../_components/Shell.js';

export const dynamic = 'force-dynamic';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Settings({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'settings' });
	const { settings } = context.data;
	const on = (/** @type {any} */ key) => (settings.enabled(key) ? t('dashboard.on') : t('dashboard.off'));
	return h(
		Shell,
		{ context, active: 'settings' },
		h(
			Card,
			{
				title: t('dashboard.nav.settings'),
				subtitle: t('dashboard.settings.intro'),
				actions: context.portalLink
					? h(ButtonLink, { href: context.portalLink, variant: 'primary' }, t('dashboard.settings.open'))
					: null,
			},
			h(KeyValueList, {
				items: [
					{
						label: t('dashboard.settings.limits'),
						value: t('dashboard.settings.limits_value', {
							configurators: settings.schema.max_configurators,
							groups: settings.limits.groups ?? 0,
							options: settings.limits.options ?? 0,
						}),
					},
					{
						label: t('dashboard.settings.catalog'),
						value: settings.schema.catalog_link ? t('dashboard.on') : t('dashboard.off'),
					},
					{
						label: t('dashboard.settings.resolver'),
						value: `${settings.resolver.inStock} · ${settings.resolver.tieBreak} · ${settings.resolver.partial} · ${settings.resolver.fallback}`,
					},
					{
						label: t('dashboard.settings.price_deltas'),
						value: `${on('price_deltas')} · ${settings.rounding.mode}/${settings.rounding.increment}`,
					},
					{
						label: t('dashboard.settings.url_sync'),
						value: `${on('url_sync')} · ${settings.url.prefix || '—'} · ${settings.url.canonical}`,
					},
					{ label: t('dashboard.settings.widget'), value: `${on('widget')} · ${settings.widget.layout}` },
					{ label: t('dashboard.settings.api'), value: `${on('api')} · ${settings.api.evaluations_per_minute}/min` },
					{ label: t('dashboard.settings.currency'), value: settings.website.currency ?? '—' },
				],
			}),
		),
	);
}
