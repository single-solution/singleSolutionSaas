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
					{ label: 'Default pattern', value: settings.codes.default_pattern },
					{ label: 'Auto-apply parameter', value: `?${settings.codes.auto_apply_param}=` },
					{ label: 'Actions', value: settings.actions.allowed_types.join(', ') },
					{ label: 'Limits', value: on('limits') },
					{ label: 'Stacking', value: `${on('stacking')} · max ${settings.policy.maxCoupons}` },
					{ label: 'Reservation TTL', value: `${settings.api.reservation_ttl_minutes} min` },
					{ label: 'Distribution', value: on('distribution') },
					{ label: 'Reporting', value: on('reporting') },
				],
			}),
		),
	);
}
