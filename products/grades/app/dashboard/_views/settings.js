/** Settings live in the Portal (the product never stores merchant configuration): link to the subscription's configure page. */
import { createElement as h } from 'react';
import { ButtonLink, Card, KeyValueList } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Settings({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'settings' });
	const { settings } = context.data;
	const on = (/** @type {any} */ key) => t(settings.enabled(key) ? 'dashboard.settings.on' : 'dashboard.settings.off');
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
					{ label: t('dashboard.settings.tiers'), value: String(settings.tiers.length) },
					{ label: t('dashboard.settings.default_tier'), value: settings.defaultTier ?? '—' },
					{ label: t('dashboard.settings.badge_style'), value: settings.badgeStyle },
					{ label: t('dashboard.settings.catalog_attribute'), value: String(settings.tiersConfig.catalog_attribute || '—') },
					{ label: t('dashboard.settings.vocabularies'), value: String(settings.vocabularies.length) },
					{ label: t('dashboard.settings.checklists'), value: String(settings.checklists.length) },
					{ label: t('dashboard.settings.showcase'), value: on('showcase') },
					{ label: t('dashboard.settings.inspection'), value: on('inspection') },
					{ label: t('dashboard.settings.time_zone'), value: settings.timeZone },
				],
			}),
		),
	);
}
