/** Settings live in the Portal (the product never stores merchant configuration): link to the subscription's configure page. */
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
	const on = (/** @type {any} */ key) => (settings.enabled(key) ? 'on' : 'off');
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
					{ label: 'Time zone', value: settings.timeZone },
					{ label: 'Rounding', value: settings.quote.rounding },
					{ label: 'Quotes per minute', value: String(settings.quote.rate_per_minute) },
					{ label: 'Item deals', value: on('item_deals') },
					{ label: 'Cart deals', value: on('cart_deals') },
					{ label: 'Flash sales', value: on('flash_sales') },
					{ label: 'Bundles', value: on('bundles') },
					{
						label: 'Stacking',
						value: `${on('stacking')} · ${settings.engine.strategy} · ${settings.dealRules.classes.join(', ')}`,
					},
					{ label: 'Price locks', value: settings.locks.enabled ? `${settings.locks.ttlMinutes} min` : 'off' },
					{ label: 'Badges', value: on('badges') },
					{ label: 'Deals page', value: on('deals_page') },
					{ label: 'Reporting', value: on('reporting') },
				],
			}),
		),
	);
}
