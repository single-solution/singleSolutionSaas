/** Settings live in the Portal (the product never stores merchant configuration): a summary and a link to configure. */
import { createElement as h } from 'react';
import { ButtonLink, Card, KeyValueList } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t } from '../_components/Shell.js';

const ELEMENTS = /** @type {const} */ ([
	'items',
	'variants',
	'attributes',
	'collections',
	'brands',
	'media',
	'import_export',
	'feeds',
	'api',
]);

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Settings({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'settings' });
	const { settings } = context.data;
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
					{ label: t('dashboard.settings.currency'), value: settings.currencyOf(null) ?? '—' },
					{
						label: t('dashboard.settings.types'),
						value: settings.items.item_types.map((/** @type {any} */ x) => x.label).join(', '),
					},
					{
						label: t('dashboard.settings.statuses'),
						value: settings.items.statuses.map((/** @type {any} */ x) => x.label).join(', '),
					},
					{ label: t('dashboard.settings.custom_fields'), value: String(settings.items.custom_fields.length) },
					{ label: t('dashboard.settings.uniqueness'), value: settings.variants.uniqueness },
					{ label: t('dashboard.settings.backorders'), value: settings.variants.backorders },
					...ELEMENTS.map((key) => ({
						label: key,
						value: t(settings.enabled(key) ? 'dashboard.settings.on' : 'dashboard.settings.off'),
					})),
				],
			}),
		),
	);
}
